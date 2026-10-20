import { escapeHTML, reply, announce } from "./chat.js";
import { StreamerbotClient } from "./streamerbot.js";

const MODULE_ID = "twitch-chat-dnd";
const possessions = new Map();
const throttles = new Map();

function throttled(key, ms) {
  const last = throttles.get(key) ?? 0;
  if (Date.now() - last < ms) return true;
  throttles.set(key, Date.now());
  return false;
}

function isVisible(combatant) {
  return !combatant.hidden && !combatant.token?.hidden;
}

function combatNPCs() {
  if (!game.combat) return [];
  return game.combat.turns.filter((c) => c.actor?.type === "npc" && isVisible(c) && !c.isDefeated);
}

function healthStatus(actor) {
  const { value, max } = actor.system.attributes.hp;
  if (!max) return "Unknown";
  if (value <= 0) return "Down";
  if (value >= max) return "Unhurt";
  return value / max > 0.5 ? "Wounded" : "Bloodied";
}

function abilities(actor) {
  const list = [];
  for (const item of actor.items) {
    if (item.type === "feat") continue;
    const activities = item.system.activities?.filter((a) => a.canUse) ?? [];
    for (const activity of activities) {
      const label = activities.length > 1 ? `${item.name} (${activity.name})` : item.name;
      list.push({ activity, item, label });
    }
  }
  return list;
}

function features(actor) {
  return actor.items.filter((i) => i.type === "feat");
}

function originalName(combatant) {
  return combatant.getFlag(MODULE_ID, "originalName") ?? combatant.token?.getFlag(MODULE_ID, "originalName") ?? combatant.name;
}

function nameDocuments(combatant) {
  return [combatant.token, combatant._source.name ? combatant : null].filter(Boolean);
}

async function rename(combatant, user) {
  for (const doc of nameDocuments(combatant)) {
    const original = doc.getFlag(MODULE_ID, "originalName") ?? doc.name;
    await doc.update({ name: `${original} - ${user}`, [`flags.${MODULE_ID}.originalName`]: original });
  }
}

async function restoreName(doc) {
  const original = doc?.getFlag(MODULE_ID, "originalName");
  if (original === undefined) return;
  await doc.update({ name: original, [`flags.${MODULE_ID}.-=originalName`]: null });
}

async function free(id) {
  const data = possessions.get(id);
  if (!data) return;
  possessions.delete(id);
  for (const uuid of data.renamed) await restoreName(fromUuidSync(uuid));
}

function possessionOf(user) {
  const key = user.toLowerCase();
  for (const [id, data] of possessions) {
    if (data.user.toLowerCase() === key) return { id, data, combatant: game.combat.combatants.get(id) };
  }
  return null;
}

async function prune() {
  for (const id of [...possessions.keys()]) {
    const combatant = game.combat?.combatants.get(id);
    if (!combatant || combatant.isDefeated) await free(id);
  }
}

function setTarget(combatant) {
  for (const token of [...game.user.targets]) token.setTarget(false, { releaseOthers: false });
  combatant?.token?.object?.setTarget(true, { releaseOthers: true });
}

function cellBounds(token, x = token.x, y = token.y) {
  const size = token.parent.grid.size;
  const col = Math.round(x / size);
  const row = Math.round(y / size);
  return {
    left: col,
    right: col + Math.max(1, Math.round(token.width)) - 1,
    top: row,
    bottom: row + Math.max(1, Math.round(token.height)) - 1
  };
}

function axisSteps(aMin, aMax, bMin, bMax) {
  if (bMin > aMax) return bMin - aMax;
  if (aMin > bMax) return aMin - bMax;
  return 0;
}

function gridDistance(grid, dx, dy) {
  const long = Math.max(dx, dy);
  const short = Math.min(dx, dy);
  const D = CONST.GRID_DIAGONALS;
  let cells;
  switch (grid.diagonals) {
    case D.ALTERNATING_1: cells = long + Math.floor(short / 2); break;
    case D.ALTERNATING_2: cells = long + Math.ceil(short / 2); break;
    case D.RECTILINEAR: cells = dx + dy; break;
    case D.EXACT:
    case D.APPROXIMATE: cells = long + short * (Math.SQRT2 - 1); break;
    default: cells = long;
  }
  return Math.round(cells * grid.distance);
}

function boundsDistance(grid, from, to) {
  const dx = axisSteps(from.left, from.right, to.left, to.right);
  const dy = axisSteps(from.top, from.bottom, to.top, to.bottom);
  return gridDistance(grid, dx, dy);
}

function overlaps(a, b) {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

function distanceBetween(a, b) {
  return boundsDistance(a.parent.grid, cellBounds(a), cellBounds(b));
}

function movementSpeed(actor) {
  const movement = actor.system.attributes.movement ?? {};
  return Math.max(movement.walk ?? 0, movement.fly ?? 0);
}

function tokenCenterAt(token, x, y) {
  const size = token.parent.grid.size;
  return { x: x + (token.width * size) / 2, y: y + (token.height * size) / 2 };
}

function* candidateSpots(token, speed) {
  const grid = token.parent.grid;
  const steps = Math.floor(speed / grid.distance);
  const others = token.parent.tokens.filter((t) => t.id !== token.id).map((t) => cellBounds(t));
  for (let dx = -steps; dx <= steps; dx++) {
    for (let dy = -steps; dy <= steps; dy++) {
      const cost = gridDistance(grid, Math.abs(dx), Math.abs(dy));
      if (cost > speed) continue;
      const x = token.x + dx * grid.size;
      const y = token.y + dy * grid.size;
      const bounds = cellBounds(token, x, y);
      if (others.some((o) => overlaps(bounds, o))) continue;
      yield { x, y, cost, bounds };
    }
  }
}

function isPathClear(token, x, y) {
  const origin = tokenCenterAt(token, token.x, token.y);
  return !token.object?.checkCollision(tokenCenterAt(token, x, y), { origin, type: "move", mode: "any" });
}

function findApproach(token, target, range, speed) {
  const grid = token.parent.grid;
  const targetBounds = cellBounds(target);
  let best = null;
  for (const spot of candidateSpots(token, speed)) {
    if (best && spot.cost >= best.cost) continue;
    if (boundsDistance(grid, spot.bounds, targetBounds) > range) continue;
    if (!isPathClear(token, spot.x, spot.y)) continue;
    best = spot;
  }
  return best;
}

function findClosestSpot(token, target, speed) {
  const grid = token.parent.grid;
  const targetBounds = cellBounds(target);
  let best = null;
  for (const spot of candidateSpots(token, speed)) {
    const distance = boundsDistance(grid, spot.bounds, targetBounds);
    if (best && (distance > best.distance || (distance === best.distance && spot.cost >= best.cost))) continue;
    if (!isPathClear(token, spot.x, spot.y)) continue;
    best = { ...spot, distance };
  }
  return best;
}

function chooseTarget(combat, combatant, args) {
  const typed = args.join(" ").trim();
  if (!typed) return { target: closestPlayer(combatant) };
  const target = combat.turns.find((c) => isVisible(c) && originalName(c).toLowerCase().startsWith(typed.toLowerCase()));
  return target ? { target } : { error: `there's no one in combat called "${typed}".` };
}

async function moveToken(token, x, y) {
  if (typeof token.move === "function") {
    const completed = await token.move({ x, y });
    if (completed === false) return false;
  } else {
    await token.update({ x, y });
  }
  await token.object?.movementAnimationPromise;
  return true;
}

function abilityRange(activity) {
  const { units, value, long, reach } = activity.range ?? {};
  if (units === "touch") return 5;
  const max = Math.max(value ?? 0, long ?? 0, reach ?? 0);
  if (["ft", "m", "mi", "km"].includes(units) && max) return max;
  if (activity.type === "attack" && activity.attack?.type?.value === "melee") return 5;
  return null;
}

function closestPlayer(attacker) {
  const origin = attacker.token;
  if (!origin) return null;
  let closest = null;
  let closestDistance = Infinity;
  for (const c of game.combat.turns) {
    const actor = c.actor;
    if (actor?.type !== "character" || !actor.hasPlayerOwner) continue;
    if (!isVisible(c) || c.isDefeated || actor.system.attributes.hp.value <= 0) continue;
    if (c.token?.parent !== origin.parent) continue;
    const distance = distanceBetween(origin, c.token);
    if (distance < closestDistance) {
      closest = c;
      closestDistance = distance;
    }
  }
  return closest;
}

async function useAbility(activity, target) {
  if (game.modules.get("midi-qol")?.active) {
    const usage = await activity.use({}, { configure: false });
    return { used: !!usage };
  }
  const usage = await activity.use({ subsequentActions: false }, { configure: false });
  if (!usage) return { used: false };
  if (activity.type !== "attack") return { used: true };

  const attack = (await activity.rollAttack({}, { configure: false }))?.[0];
  if (!attack) return { used: true };
  const ac = target?.actor?.system.attributes.ac.value;
  const hit = ac === undefined ? null : attack.isCritical || (!attack.isFumble && attack.total >= ac);

  let damage = null;
  if (hit) {
    const rolls = await activity.rollDamage({ isCritical: attack.isCritical }, { configure: false });
    damage = rolls?.reduce((sum, roll) => sum + roll.total, 0) ?? null;
  }
  return { used: true, attack: attack.total, critical: attack.isCritical, hit, damage };
}

function resultText(result) {
  if (result.attack === undefined) return "";
  const toHit = `${result.attack} to hit`;
  if (result.hit === null) return `: ${toHit}`;
  if (!result.hit) return `: ${toHit}, MISS`;
  const hitWord = result.critical ? "CRITICAL HIT" : "HIT";
  const damageText = result.damage !== null ? ` for ${result.damage} damage` : "";
  return `: ${toHit}, ${hitWord}${damageText}`;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function toNumber(word) {
  return NUMBER_WORDS[word] ?? (Number(word) || null);
}

function plainText(html) {
  const cleaned = (html ?? "")
    .replace(/[@&]\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")
    .replace(/&Reference\[([^\]\s]+)[^\]]*\]/g, "$1")
    .replace(/\[\[\/(?:r|roll|damage) ([^\]]+)\]\]/g, (_, inner) => inner.replace(/\s*\b(?:average|\w+=\S*)/g, "").trim())
    .replace(/\[\[\/save (\w+)(?: (?:dc=)?(\d+))?[^\]]*\]\]/g, (_, ability, dc) => `${dc ? `DC ${dc} ` : ""}${ability.toUpperCase()}`)
    .replace(/\[\[[^\]]*\]\]/g, "");
  const text = new DOMParser().parseFromString(cleaned, "text/html").body.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function normalizeName(name) {
  return name.toLowerCase().trim()
    .replace(/^(its|their|a|an|the) /, "")
    .replace(/ attacks?$/, "")
    .replace(/(?<=\w{3})e?s$/, "");
}

function namesMatch(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function addLimit(limits, name, count) {
  const existing = limits.find((l) => namesMatch(l.name, name));
  if (existing) existing.count = Math.max(existing.count, count);
  else limits.push({ name: name.trim(), count });
}

function parseOption(sentence) {
  const number = `(${Object.keys(NUMBER_WORDS).join("|")}|\\d+)`;
  const typeWords = ["melee", "ranged", "weapon", "melee weapon", "ranged weapon"];
  const option = { total: 1, limits: [], allowed: null, attackType: null };

  const main = sentence.match(/^makes (\w+) ((?:[a-z'-]+ ){0,3}?)attacks?/);
  let namedMain = false;
  if (main) {
    option.total = toNumber(main[1]) ?? 1;
    const qualifier = main[2].trim();
    if (qualifier.includes("melee")) option.attackType = "melee";
    else if (qualifier.includes("ranged")) option.attackType = "ranged";
    namedMain = !!qualifier && !typeWords.includes(qualifier);
  }

  const limits = [];
  for (const m of sentence.matchAll(new RegExp(`\\b${number} (?:attacks? )?with (?:its|their) ([a-z' -]+?)(?=,| and | or |$)`, "g"))) {
    addLimit(limits, m[2], toNumber(m[1]));
  }
  if (!limits.length) {
    for (const m of sentence.matchAll(new RegExp(`\\b${number} ([a-z'-]+(?: [a-z'-]+){0,2}?) attacks?\\b`, "g"))) {
      if (!typeWords.includes(m[2])) addLimit(limits, m[2], toNumber(m[1]));
    }
  }
  const withIts = sentence.match(/^makes \w+ (?:[a-z'-]+ ){0,3}?attacks? with (?:its|their) ([a-z' -]+?)(?=,| and | or |$)/);
  if (!limits.length && withIts) addLimit(limits, withIts[1], option.total);

  if (limits.length) {
    option.limits = limits;
    const sum = limits.reduce((total, l) => total + l.count, 0);
    if (!main || namedMain) option.total = sum;
  }

  const combination = sentence.match(/using (?:its |their )?([a-z' ,-]+?),? in any combination/);
  if (combination) {
    option.allowed = combination[1].split(/,? or |, and |, | and /).map((n) => n.trim()).filter(Boolean);
    option.limits = [];
  }
  return main || limits.length ? option : null;
}

function parseMultiattack(actor) {
  const item = actor.items.find((i) => /multiattack/i.test(i.name));
  if (!item) return null;
  const text = plainText(item.system.description?.value).toLowerCase();
  const options = text.split(/\.\s*/)
    .filter((s) => s.includes("makes "))
    .map((s) => parseOption(s.slice(s.indexOf("makes "))))
    .filter((o) => o && o.total > 1);
  return options.length ? { item, options } : null;
}

function describeOption(option) {
  let detail = "";
  if (option.limits.length) detail = option.limits.map((l) => `${l.count} ${l.name}`).join(", ");
  else if (option.allowed) detail = `any mix of ${option.allowed.join(" or ")}`;
  else if (option.attackType) detail = `${option.attackType} attacks`;
  return `${option.total} attacks${detail ? ` (${detail})` : ""}`;
}

function describeMultiattack(rules) {
  return `Multiattack: ${rules.options.map(describeOption).join(" OR ")}. Using Multiattack or one of its attacks makes all of them`;
}

function attackTypes(ability) {
  const activity = ability.activity;
  return activity.validAttackTypes?.size ? [...activity.validAttackTypes] : [activity.attack?.type?.value];
}

function optionCount(option, ability) {
  if (ability.activity.type !== "attack") return 0;
  if (option.attackType && !attackTypes(ability).includes(option.attackType)) return 0;
  if (option.allowed && !option.allowed.some((n) => namesMatch(ability.item.name, n))) return 0;
  if (option.limits.length) return option.limits.find((l) => namesMatch(ability.item.name, l.name))?.count ?? 0;
  return option.total;
}

function planMultiattack(rules, list, chosen) {
  let best = null;
  for (const option of rules.options) {
    const pick = chosen ?? list.find((a) => optionCount(option, a) > 0);
    const score = pick ? optionCount(option, pick) : 0;
    if (!score) continue;
    if (best && (score < best.score || (score === best.score && option.total <= best.option.total))) continue;
    best = { option, pick, score };
  }
  if (!best) return null;
  const { option, pick } = best;
  if (!option.limits.length) return Array(option.total).fill(pick);
  const sequence = [];
  for (const limit of option.limits) {
    const ability = namesMatch(pick.item.name, limit.name)
      ? pick
      : list.find((a) => namesMatch(a.item.name, limit.name) && optionCount(option, a) > 0);
    if (ability) for (let i = 0; i < limit.count; i++) sequence.push(ability);
  }
  sequence.sort((a, b) => (b === pick) - (a === pick));
  return sequence.length ? sequence : null;
}

function turnState(data, combat) {
  const key = `${combat.round}.${combat.turn}`;
  if (data.turn?.key !== key) data.turn = { key, moved: 0, done: false, busy: false };
  return data.turn;
}

async function performUse(msg, { combatant, name, turn, sequence, multiattack, ability, target, approach }) {
  if (approach) {
    if (!(await moveToken(combatant.token, approach.x, approach.y))) {
      return reply(`@${msg.user} ${name} couldn't move there. Pick another ability or target.`);
    }
    turn.moved += approach.cost;
  }
  setTarget(target);
  const units = combatant.token?.parent.grid.units || "ft";
  const moveText = approach ? ` moves ${approach.cost} ${units} and` : "";
  const actionLabel = multiattack ? `Multiattack (${sequence.map((a) => a.label).join(", ")})` : ability.label;
  const onTarget = target ? ` on <strong>${escapeHTML(originalName(target))}</strong>` : "";
  announce(`<strong>${escapeHTML(msg.user)}</strong> (Twitch) makes <strong>${escapeHTML(name)}</strong>${moveText} use <strong>${escapeHTML(actionLabel)}</strong>${onTarget}!`);

  const outcomes = [];
  for (const step of sequence) {
    const result = await useAbility(step.activity, target);
    if (result.used) outcomes.push({ step, result });
  }
  if (!outcomes.length) return reply(`@${msg.user} ${name} couldn't use ${ability.label} right now.`);
  turn.done = true;

  const onTargetText = target ? ` on ${originalName(target)}` : "";
  if (!multiattack) {
    return reply(`@${msg.user} ${name}${moveText} uses ${ability.label}${onTargetText}${resultText(outcomes[0].result)}!`);
  }
  const lines = outcomes.map(({ step, result }) => `${step.label}${resultText(result)}`);
  const total = outcomes.reduce((sum, { result }) => sum + (result.damage ?? 0), 0);
  const totalText = outcomes.some(({ result }) => result.attack !== undefined) ? ` | Total: ${total} damage` : "";
  reply(`@${msg.user} ${name}${moveText} uses Multiattack${onTargetText}: ${lines.join(" | ")}${totalText}`);
}

const handlers = {
  "!npcs": () => {
    if (throttled("npcs", 10000)) return;
    const npcs = combatNPCs();
    if (!npcs.length) return reply("There are no NPCs in combat right now.");
    const list = npcs.map((c, i) => {
      const owner = possessions.get(c.id);
      const status = owner ? `${healthStatus(c.actor)}, possessed by ${owner.user}` : healthStatus(c.actor);
      return `${i + 1}) ${originalName(c)} [${status}]`;
    });
    reply(`NPCs in combat: ${list.join(" | ")} | Type !possess N to take control`);
  },

  "!possess": async (msg, args) => {
    if (throttled(`possess:${msg.user}`, 5000)) return;
    const combatant = combatNPCs()[Number(args[0]) - 1];
    if (!combatant) return reply(`@${msg.user} pick a number from !npcs`);
    const current = possessionOf(msg.user);
    if (current) return reply(`@${msg.user} you already possess ${originalName(current.combatant)}. Type !release first.`);
    const owner = possessions.get(combatant.id);
    if (owner) return reply(`@${msg.user} ${originalName(combatant)} is already possessed by ${owner.user}.`);

    const name = originalName(combatant);
    possessions.set(combatant.id, {
      user: msg.user,
      turn: null,
      renamed: nameDocuments(combatant).map((doc) => doc.uuid)
    });
    await rename(combatant, msg.user);
    announce(`<strong>${escapeHTML(msg.user)}</strong> (Twitch) possesses <strong>${escapeHTML(name)}</strong>!`);
    reply(`@${msg.user} you now possess ${name}! Type !abilities to see what it can do.`);
  },

  "!abilities": (msg) => { // shows the 
    if (throttled(`abilities:${msg.user}`, 5000)) return;
    const current = possessionOf(msg.user);
    if (!current) return reply(`@${msg.user} you aren't possessing anyone. Type !npcs to see who you can possess.`);
    const name = originalName(current.combatant);
    const list = abilities(current.combatant.actor).map((a, i) => `${i + 1}) ${a.label}`);
    if (!list.length) return reply(`@${msg.user} ${name} has no abilities it can use.`);
    const rules = parseMultiattack(current.combatant.actor);
    const multi = rules ? ` | ${describeMultiattack(rules)}` : "";
    reply(`@${msg.user} ${name} can use: ${list.join(" | ")}${multi} | On its turn, type !use N to hit the closest player, !use N target name, or !move to get closer | Type !features to see its features`);
  },

  "!features": (msg, args) => {
    if (throttled(`feature:${msg.user}`, 5000)) return;
    const current = possessionOf(msg.user);
    if (!current) return reply(`@${msg.user} you aren't possessing anyone. Type !npcs to see who you can possess.`);
    const name = originalName(current.combatant);
    const list = features(current.combatant.actor);
    if (!list.length) return reply(`@${msg.user} ${name} has no features.`);
    const feature = list[Number(args[0]) - 1];
    if (!feature) {
      return reply(`@${msg.user} ${name}'s features: ${list.map((f, i) => `${i + 1}) ${f.name}`).join(" | ")} | Type !features N to read one`);
    }
    let text = plainText(feature.system.description?.value) || "No description.";
    if (text.length > 900) text = `${text.slice(0, 897)}...`;
    reply(`@${msg.user} ${feature.name}: ${text}`);
  },

  "!use": async (msg, args) => {
    const current = possessionOf(msg.user);
    if (!current) return reply(`@${msg.user} you aren't possessing anyone. Type !npcs to see who you can possess.`);
    const combat = game.combat;
    const { combatant, data } = current;
    const name = originalName(combatant);
    if (combat.combatant?.id !== combatant.id) return reply(`@${msg.user} wait for ${name}'s turn.`);
    const turn = turnState(data, combat);
    if (turn.busy) return;
    if (turn.done) return reply(`@${msg.user} ${name} already acted this turn.`);

    const list = abilities(combatant.actor);
    const ability = list[Number(args[0]) - 1];
    if (!ability) return reply(`@${msg.user} pick a number from !abilities`);

    const rules = parseMultiattack(combatant.actor);
    const isMultiattackItem = !!rules && ability.item === rules.item;
    let sequence = [ability];
    let multiattack = false;
    if (rules && (isMultiattackItem || ability.activity.type === "attack")) {
      const plan = planMultiattack(rules, list, isMultiattackItem ? null : ability);
      if (plan) {
        sequence = plan;
        multiattack = true;
      } else if (isMultiattackItem) {
        return reply(`@${msg.user} ${name}'s Multiattack doesn't match any of its attacks. Pick an attack instead.`);
      }
    }

    const { target, error } = chooseTarget(combat, combatant, args.slice(1));
    if (error) return reply(`@${msg.user} ${error}`);

    const ranges = sequence.map((a) => abilityRange(a.activity)).filter((r) => r !== null);
    const range = ranges.length ? Math.min(...ranges) : null;
    let approach = null;
    if (target && range !== null && combatant.token && target.token?.parent === combatant.token.parent) {
      const distance = distanceBetween(combatant.token, target.token);
      if (distance > range) {
        const units = combatant.token.parent.grid.units || "ft";
        const speed = Math.max(0, movementSpeed(combatant.actor) - turn.moved);
        approach = findApproach(combatant.token, target.token, range, speed);
        if (!approach) {
          return reply(`@${msg.user} ${originalName(target)} is ${distance} ${units} away. ${name} has ${speed} ${units} of movement left and ${multiattack ? "its Multiattack" : ability.label} reaches ${range} ${units}, so it can't get there this turn. Pick another ability or target.`);
        }
      }
    }

    turn.busy = true;
    try {
      await performUse(msg, { combatant, name, turn, sequence, multiattack, ability, target, approach });
    } finally {
      turn.busy = false;
    }
  },

  "!move": async (msg, args) => {
    const current = possessionOf(msg.user);
    if (!current) return reply(`@${msg.user} you aren't possessing anyone. Type !npcs to see who you can possess.`);
    const combat = game.combat;
    const { combatant, data } = current;
    const name = originalName(combatant);
    if (combat.combatant?.id !== combatant.id) return reply(`@${msg.user} wait for ${name}'s turn.`);
    const turn = turnState(data, combat);
    if (turn.busy) return;
    const token = combatant.token;
    if (!token) return reply(`@${msg.user} ${name} isn't on the map.`);

    const { target, error } = chooseTarget(combat, combatant, args);
    if (error) return reply(`@${msg.user} ${error}`);
    if (!target) return reply(`@${msg.user} there's no player for ${name} to move toward.`);
    const targetName = originalName(target);
    if (target.token?.parent !== token.parent) return reply(`@${msg.user} ${targetName} isn't on the same map as ${name}.`);

    const units = token.parent.grid.units || "ft";
    const speed = Math.max(0, movementSpeed(combatant.actor) - turn.moved);
    if (!speed) return reply(`@${msg.user} ${name} has no movement left this turn.`);
    const spot = findClosestSpot(token, target.token, speed);
    if (!spot || spot.cost === 0) return reply(`@${msg.user} ${name} can't get any closer to ${targetName}.`);

    turn.busy = true;
    try {
      if (!(await moveToken(token, spot.x, spot.y))) return reply(`@${msg.user} ${name} couldn't move there.`);
      turn.moved += spot.cost;
    } finally {
      turn.busy = false;
    }
    const left = speed - spot.cost;
    announce(`<strong>${escapeHTML(msg.user)}</strong> (Twitch) moves <strong>${escapeHTML(name)}</strong> ${spot.cost} ${units} toward <strong>${escapeHTML(targetName)}</strong>.`);
    reply(`@${msg.user} ${name} moves ${spot.cost} ${units} toward ${targetName}, now ${spot.distance} ${units} away (${left} ${units} of movement left).`);
  },

  "!forcerelease": async (msg, args) => {
    if (!msg.isBroadcaster) return;
    if (args[0]?.toLowerCase() === "all") {
      if (!possessions.size) return reply(`@${msg.user} no NPCs are possessed.`);
      for (const id of [...possessions.keys()]) await free(id);
      announce("All possessed NPCs are freed.");
      return reply("All possessed NPCs are freed.");
    }
    const combatant = combatNPCs()[Number(args[0]) - 1];
    const owner = combatant && possessions.get(combatant.id);
    if (!owner) return reply(`@${msg.user} that NPC isn't possessed. Use a number from !npcs, or !forcerelease all`);
    await free(combatant.id);
    const name = originalName(combatant);
    announce(`<strong>${escapeHTML(name)}</strong> is freed from <strong>${escapeHTML(owner.user)}</strong>'s control.`);
    reply(`${name} is freed from ${owner.user}'s control.`);
  },

  "!release": async (msg) => {
    const current = possessionOf(msg.user);
    if (!current) return;
    await free(current.id);
    const name = originalName(current.combatant);
    announce(`<strong>${escapeHTML(msg.user)}</strong> (Twitch) releases <strong>${escapeHTML(name)}</strong>.`);
    reply(`@${msg.user} you released ${name}.`);
  }
};

Hooks.on("twitchChatMessage", async (msg) => {
  if (!game.user.isGM) return;
  const [command, ...args] = msg.text.trim().split(/\s+/);
  const handler = handlers[command.toLowerCase()];
  if (!handler) return;
  await prune();
  await handler(msg, args);
});

Hooks.on("updateCombat", (combat, changed) => {
  if (!game.user.isGM || !combat.started) return;
  if (!("turn" in changed) && !("round" in changed)) return;
  const combatant = combat.combatant;
  const owner = combatant && possessions.get(combatant.id);
  if (!owner) return;
  const name = originalName(combatant);
  StreamerbotClient.doAction("Foundry Turn Alert", { user: owner.user, npc: name });
  reply(`@${owner.user} it's ${name}'s turn! Type !use N to attack, !move to get closer, or !abilities to see what it can do.`);
});

Hooks.on("updateCombatant", (combatant) => {
  if (game.user.isGM && combatant.isDefeated && possessions.has(combatant.id)) free(combatant.id);
});

Hooks.on("deleteCombatant", (combatant) => {
  if (game.user.isGM) free(combatant.id);
});

Hooks.on("deleteCombat", async () => {
  if (!game.user.isGM) return;
  for (const id of [...possessions.keys()]) await free(id);
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  for (const scene of game.scenes) {
    for (const token of scene.tokens) await restoreName(token);
  }
  for (const combat of game.combats) {
    for (const combatant of combat.combatants) await restoreName(combatant);
  }
});
