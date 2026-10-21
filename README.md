# Twitch Chat for D&D

A [Foundry VTT](https://foundryvtt.com/) module that lets Twitch viewers take part in a live D&D 5e game from chat. Viewers can roll dice, or **possess an enemy in combat** and fight the players with it. The module handles movement, range, attack rolls, damage and Multiattack for them.

## Features

- **Dice rolls from chat.** `!roll 2d6+3` rolls in Foundry and the bot replies with the result.
- **NPC possession.** Viewers take control of enemies in the active combat and act on their turn.
  - **Movement:** an out-of-range attack moves the creature toward its target first, within its speed, without crossing walls or stopping on other tokens.
  - **Targeting:** attacks go at the closest player character, or at a target the viewer names.
  - **Attacks:** rolls are checked against the target's AC, and damage is rolled on a hit.
  - **Multiattack:** the module reads the creature's Multiattack text (e.g. "one with its bite and two with its claws"), and a single command rolls the whole sequence.
  - **Renaming:** possessed tokens are renamed `Goblin - ViewerName`. The original name comes back when control ends.
- **Turn alerts.** The viewer is @mentioned in chat, and a sound can play on stream, when their creature's turn comes up.
- **Chat replies.** Through Streamer.bot, results are posted back into Twitch chat.
- **Chat mirroring (optional).** Shows Twitch chat inside Foundry's chat log.

## Requirements

- Foundry VTT v12 or newer
- The **dnd5e** system, version 5.x (it relies on the 5.x activity system)
- Optional: [Streamer.bot](https://streamer.bot/), needed for bot replies in Twitch chat and for turn-alert sounds
- Optional: midi-qol. If it's active, abilities are handed to midi-qol to resolve.

## Installation

The module's folder **must be named `twitch-chat-dnd`**, because Foundry requires the folder name to match the module id.

1. Find your Foundry data folder. In Foundry's setup screen, go to **Configuration → User Data Path**. On Windows it's usually `%LOCALAPPDATA%\FoundryVTT\Data`.
2. Clone the repo into the modules folder under the right name:
   ```
   cd "<User Data Path>/Data/modules"
   git clone https://github.com/JaidenLo/DND-Chat-Possession.git twitch-chat-dnd
   ```
3. Restart Foundry and open your dnd5e world.
4. Go to **Game Settings → Manage Modules**, enable **Twitch Chat for D&D**, and save.

If you're developing it, you can keep the repo anywhere and symlink it in instead. Run this in PowerShell as admin, or with Windows Developer Mode on:
```powershell
New-Item -ItemType SymbolicLink -Path "$env:LOCALAPPDATA\FoundryVTT\Data\modules\twitch-chat-dnd" -Target "C:\path\to\DND-Chat-Possession"
```

## Setup

Open **Game Settings → Configure Settings → Twitch Chat for D&D**. Log in as the GM, because only the GM's client connects to Twitch.

| Setting | What it does |
|---|---|
| **Chat Source** | `Twitch` reads chat anonymously (read-only, no account needed). `Streamer.bot` reads chat through Streamer.bot, so the bot can reply. |
| **Twitch Channel** | Your channel name, e.g. `mychannel`, not the full URL. Only used with the Twitch source. |
| **Streamer.bot WebSocket URL** | Default `ws://127.0.0.1:8080/`. Saved per computer. Only used with the Streamer.bot source. |
| **Mirror Twitch chat into Foundry** | Posts every Twitch message into Foundry's chat. |

When it connects, a **Connected** notification appears.

### Streamer.bot setup (for replies and sounds)

1. **Servers/Clients → WebSocket Server:** enable **Auto Start** and start the server. Leave **Authentication** off. It only listens on your own PC.
2. **Create an action named exactly `Foundry Chat Reply`** with one sub-action: **Twitch → Chat → Send Message to Channel**, message `%message%`. Tick **Use Bot Account** to reply from your bot account. This action posts every reply.
3. **Optional: create an action named exactly `Foundry Turn Alert`** with **Core → Sounds → Play Sound**. It runs when a possessed creature's turn starts. It also receives `%user%` (the viewer) and `%npc%` (the creature's name) if you want text-to-speech or an on-screen alert.

Neither action needs a trigger, because Foundry runs them directly. If a name doesn't match exactly, Foundry's console (F12) shows an "action not found" warning.

## Commands

### Everyone

| Command | Description |
|---|---|
| `!roll [formula]` | Rolls dice. Default `1d20`. Allows d4, d6, d8, d10, d12, d20 and d100, up to 99 dice and ±99. 15-second cooldown per viewer. |
| `!npcs` | Lists the enemies in combat with a health status (Unhurt, Wounded, Bloodied or Down) and who possesses each one. |
| `!possess N` | Takes control of enemy N from `!npcs`. One creature per viewer, one viewer per creature. |

### While possessing

| Command | Description |
|---|---|
| `!abilities` | Lists the creature's attacks and spells, plus its Multiattack rules. |
| `!features [N]` | Lists the creature's features. With a number, the bot reads out what that feature does. |
| `!use N [target]` | On the creature's turn, uses ability N on the closest player, or on whoever's name starts with `target`. Moves into range first if needed. Using an attack that's part of Multiattack rolls the whole Multiattack. |
| `!move [target]` | Moves toward the closest player, or a named target, using the movement left this turn. |
| `!release` | Gives up control of the creature. |

### Broadcaster only

| Command | Description |
|---|---|
| `!forcerelease N` | Frees enemy N from whoever possesses it. |
| `!forcerelease all` | Frees every possessed enemy. |

### Turn rules

- A possessed creature gets **one action per turn**: one `!use`, which can be a full Multiattack.
- Movement is shared between `!move` and `!use`, and can't go over the creature's walk or fly speed.
- Possession ends when you use `!release` or `!forcerelease`, the creature is defeated or removed from combat, or the combat ends.

## Testing without going live

Open the browser console in Foundry (**F12**) and fake a chat message:

```js
Hooks.callAll("twitchChatMessage", { user: "TestViewer", text: "!roll 2d6+3" })
Hooks.callAll("twitchChatMessage", { user: "TestViewer", text: "!possess 1" })
Hooks.callAll("twitchChatMessage", { user: "Me", text: "!forcerelease all", isBroadcaster: true })
```

When Streamer.bot isn't connected, replies are whispered to the GM in Foundry chat instead.

## Known limitations

- **Damage is rolled but not applied.** The GM applies it from the damage card, unless midi-qol is handling it.
- **Movement goes in a straight line only.** The creature won't path around walls. Difficult terrain, elevation and opportunity attacks are ignored.
- **Attacks beyond normal range don't get disadvantage.** They're allowed up to long range and rolled normally.
- **Some Multiattack wording isn't understood.** Alternatives like "can replace one attack with Spellcasting" are ignored.
- **Possessions are lost if Foundry reloads.** Renamed tokens are restored automatically on the next load.
