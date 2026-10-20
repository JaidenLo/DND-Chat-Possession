const MODULE_ID = "twitch-chat-dnd";

export class StreamerbotClient {
  static socket = null;

  static connect() {
    const url = game.settings.get(MODULE_ID, "streamerbotUrl").trim();
    if (!url) return;

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({
        request: "Subscribe",
        id: MODULE_ID,
        events: { Twitch: ["ChatMessage"] }
      }));
      ui.notifications.info("Connected to Streamer.bot");
    };

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.request === "Hello" && payload.authentication) {
        ui.notifications.error("Streamer.bot WebSocket Server has authentication turned on. Turn it off so Foundry can connect.");
      }
      if (payload.status === "error") console.warn("Streamer.bot error:", payload);
      if (payload.event?.source !== "Twitch" || payload.event?.type !== "ChatMessage") return;
      const msg = parseChatMessage(payload.data);
      if (msg) Hooks.callAll("twitchChatMessage", msg);
    };

    socket.onclose = () => setTimeout(() => this.connect(), 5000);
  }

  static doAction(name, args) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      request: "DoAction",
      id: foundry.utils.randomID(),
      action: { name },
      args
    }));
  }

  static say(text) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    for (const message of splitMessage(text)) this.doAction("Foundry Chat Reply", { message });
    return true;
  }

  static disconnect() {
    if (!this.socket) return;
    this.socket.onclose = null;
    this.socket.close();
    this.socket = null;
  }
}

function splitMessage(text, max = 450) {
  const chunks = [];
  let current = "";
  for (const part of text.split(" | ")) {
    const next = current ? `${current} | ${part}` : part;
    if (next.length > max && current) {
      chunks.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.flatMap((chunk) => wrapWords(chunk, max));
}

function wrapWords(text, max) {
  if (text.length <= max) return [text];
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word.slice(0, max);
    } else {
      line = next.slice(0, max);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function parseChatMessage(data) {
  const m = data?.message ?? {};
  const text = typeof m === "string" ? m : m.message ?? data?.text;
  if (!text) return null;
  const role = m.role ?? data?.user?.role ?? 1;
  return {
    user: m.displayName || m.username || data?.user?.name || "unknown",
    text,
    color: m.color ?? data?.user?.color,
    isMod: role >= 3,
    isBroadcaster: role === 4
  };
}
