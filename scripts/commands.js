import { escapeHTML, reply } from "./chat.js";

const MODULE_ID = "twitch-chat-dnd";
const COOLDOWN_MS = 15000;
const cooldowns = new Map();

function onCooldown(user) {
  const last = cooldowns.get(user) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  cooldowns.set(user, Date.now());
  return false;
}

Hooks.on("twitchChatMessage", async (msg) => {
  if (game.settings.get(MODULE_ID, "mirrorChat")) {
    ChatMessage.create({
      speaker: { alias: `${msg.user} (Twitch)` },
      content: escapeHTML(msg.text)
    });
  }

  if (msg.text.startsWith("!roll")) {
    const formula = msg.text.slice(5).trim() || "1d20";
    const valid = /^(\d{1,2})?d(4|6|8|10|12|20|100)([+-]\d{1,2})?$/i.test(formula);
    if (!valid) return;
    if (onCooldown(msg.user)) return;

    const roll = await new Roll(formula).evaluate();
    roll.toMessage({
      speaker: { alias: `${msg.user} (Twitch)` },
      flavor: "Rolled from Twitch chat"
    });
    reply(`@${msg.user} rolled ${formula}: ${roll.total} (${roll.result})`);
  }
});
