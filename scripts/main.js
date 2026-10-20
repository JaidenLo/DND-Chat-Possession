import { TwitchClient } from "./twitch.js";
import { StreamerbotClient } from "./streamerbot.js";
import "./commands.js";
import "./possession.js";

export const MODULE_ID = "twitch-chat-dnd";

function connectChat() {
  if (!game.user.isGM) return;
  TwitchClient.disconnect();
  StreamerbotClient.disconnect();
  if (game.settings.get(MODULE_ID, "source") === "streamerbot") StreamerbotClient.connect();
  else TwitchClient.connect();
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "source", {
    name: "Chat Source",
    hint: "Read chat anonymously from Twitch, or through your local Streamer.bot.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      twitch: "Twitch (anonymous, read-only)",
      streamerbot: "Streamer.bot"
    },
    default: "twitch",
    onChange: connectChat
  });

  game.settings.register(MODULE_ID, "channel", {
    name: "Twitch Channel",
    hint: "The channel name to read chat from. Only used with the Twitch source.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: connectChat
  });

  game.settings.register(MODULE_ID, "streamerbotUrl", {
    name: "Streamer.bot WebSocket URL",
    hint: "Address of the Streamer.bot WebSocket Server on this computer. Only used with the Streamer.bot source.",
    scope: "client",
    config: true,
    type: String,
    default: "ws://127.0.0.1:8080/",
    onChange: connectChat
  });

  game.settings.register(MODULE_ID, "mirrorChat", {
    name: "Mirror Twitch chat into Foundry",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once("ready", connectChat);
