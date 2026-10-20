const MODULE_ID = "twitch-chat-dnd";

export class TwitchClient {
  static socket = null;

  static connect() {
    const channel = game.settings.get(MODULE_ID, "channel").trim().toLowerCase();
    if (!channel) return;

    const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.socket = socket;

    socket.onopen = () => {
      socket.send("CAP REQ :twitch.tv/tags");
      socket.send("PASS SCHMOOPIIE");
      socket.send(`NICK justinfan${Math.floor(Math.random() * 90000) + 10000}`);
      socket.send(`JOIN #${channel}`);
      ui.notifications.info(`Connected to Twitch chat: ${channel}`);
    };

    socket.onmessage = (event) => {
      for (const line of event.data.split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) {
          socket.send(line.replace("PING", "PONG"));
          continue;
        }
        const msg = parseLine(line);
        if (msg) Hooks.callAll("twitchChatMessage", msg);
      }
    };

    socket.onclose = () => setTimeout(() => this.connect(), 5000);
  }

  static disconnect() {
    if (!this.socket) return;
    this.socket.onclose = null;
    this.socket.close();
    this.socket = null;
  }
}

function parseLine(line) {
  const match = line.match(/^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\w+ :(.*)$/);
  if (!match) return null;
  const tags = Object.fromEntries(
    (match[1] ?? "").split(";").filter(Boolean).map((t) => t.split("="))
  );
  return {
    user: tags["display-name"] || match[2],
    text: match[3],
    color: tags.color,
    isMod: tags.mod === "1",
    isBroadcaster: (tags.badges ?? "").includes("broadcaster")
  };
}
