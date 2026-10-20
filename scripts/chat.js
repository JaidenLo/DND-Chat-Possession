import { StreamerbotClient } from "./streamerbot.js";

export function escapeHTML(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function reply(text) {
  if (StreamerbotClient.say(text)) return;
  ChatMessage.create({
    speaker: { alias: "Twitch reply" },
    whisper: [game.user.id],
    content: escapeHTML(text)
  });
}

export function announce(content) {
  ChatMessage.create({ speaker: { alias: "Twitch Chat" }, content });
}
