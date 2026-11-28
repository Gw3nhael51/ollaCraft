const config = require('../infrastructure/config');
const { isQuestDone, getQuestRequirement, getCarriedItems } = require('../perception/inventory');
const { getDimension, listWaypoints } = require('../core/progress');

const QUEST_CACHE_TTL_MS = 5000;
const RECENT_ACTIONS_LIMIT = 8;

let questCache = { at: 0, value: null };

/**
 * Round a position to plain integer coordinates
 * @param {object|null|undefined} pos Position with x, y, z
 * @returns {{ x: number, y: number, z: number }|null} Plain coordinates or null
 */
function toPlainPosition(pos) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;
  return { x: Math.round(pos.x), y: Math.round(pos.y ?? 64), z: Math.round(pos.z) };
}

/**
 * Evaluate every stage of the quest chain, flagging the finished ones and the one being pursued.
 * Evaluating a stage can scan blocks around the bot, so the result is cached for a few seconds.
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {number} [now] Current timestamp in milliseconds
 * @returns {Array<{ id: string, amount: number, done: boolean, current: boolean }>} Ordered stages
 */
function buildQuests(bot, state, now = Date.now()) {
  if (questCache.value && now - questCache.at < QUEST_CACHE_TTL_MS) return questCache.value;

  const value = config.QUEST_CHAIN.map(id => {
    let done = false;
    try {
      done = Boolean(isQuestDone(bot, id, state));
    } catch {
      done = false;
    }
    return {
      id,
      amount: config.QUEST_AMOUNT[id] || 1,
      done,
      current: id === state.currentObjective
    };
  });
  questCache = { at: now, value };
  return value;
}

/**
 * Count the items the bot carries, by item name
 * @param {object} bot Mineflayer bot instance
 * @returns {Record<string, number>} Item counts
 */
function buildInventory(bot) {
  const counts = {};
  for (const item of getCarriedItems(bot)) {
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return counts;
}

/**
 * List the 36 slots of the player inventory in display order: the 3 rows of 9 (slots 9-35), then the hotbar (36-44)
 * @param {object} bot Mineflayer bot instance
 * @returns {Array<{ name: string, count: number }|null>} 36 entries, null for an empty slot
 */
function buildInventorySlots(bot) {
  const slots = bot?.inventory?.slots || [];
  const result = [];
  for (let index = 9; index <= 44; index += 1) {
    const item = slots[index];
    result.push(item ? { name: item.name, count: item.count } : null);
  }
  return result;
}

/**
 * Report what the bot wears and holds in its off hand
 * @param {object} bot Mineflayer bot instance
 * @returns {Record<string, { name: string, count: number }|null>} Armor pieces and off-hand item (null when empty)
 */
function buildEquipment(bot) {
  const slots = bot?.inventory?.slots || [];
  const at = (index) => (slots[index] ? { name: slots[index].name, count: slots[index].count } : null);
  // Slots of the player inventory window: 5 head, 6 chest, 7 legs, 8 feet, 45 off hand
  return { head: at(5), chest: at(6), legs: at(7), feet: at(8), offhand: at(45) };
}

/**
 * Turn the manager's sub-goal (a string or an object such as { action, target }) into a short text
 * @param {string|object|null|undefined} subGoal Sub-goal held in the state
 * @returns {string|null} Text such as "procedure build_portal", or null
 */
function formatSubGoal(subGoal) {
  if (!subGoal) return null;
  if (typeof subGoal === 'string') return subGoal;
  return [subGoal.action, subGoal.target].filter(Boolean).join(' ') || null;
}

/**
 * Describe how many units of the current objective are required
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {number} Required quantity (1 when it cannot be computed)
 */
function safeRequirement(bot, state) {
  try {
    return getQuestRequirement(bot, state, state.currentObjective);
  } catch {
    return 1;
  }
}

/**
 * Build the JSON document served by the status API: a read-only picture of the bot and its progression
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {{ startedAt?: number, now?: number }} [options] Process start timestamp and clock override
 * @returns {object} Serializable status snapshot
 */
function buildSnapshot(bot, state, options = {}) {
  const now = options.now ?? Date.now();
  // Ignore stale entity data left in memory after a server disconnect
  const spawned = Boolean(bot?.entity) && state.isConnected !== false;

  return {
    username: bot?.username || config.BOT_CONFIG.username,
    connected: spawned,
    running: Boolean(state.isSurviving),
    uptime_seconds: options.startedAt != null ? Math.max(0, Math.round((now - options.startedAt) / 1000)) : null,
    health: spawned ? bot.health ?? null : null,
    food: spawned ? bot.food ?? null : null,
    dimension: spawned ? getDimension(bot) : null,
    position: spawned ? toPlainPosition(bot.entity.position) : null,
    objective: {
      id: state.currentObjective,
      amount: spawned ? safeRequirement(bot, state) : 1,
      manual: Boolean(state.manualObjective),
      directive: state.managerDirective || null,
      sub_goal: formatSubGoal(state.managerSubGoal)
    },
    quests: spawned ? buildQuests(bot, state, now) : [],
    inventory: spawned ? buildInventory(bot) : {},
    inventory_slots: spawned ? buildInventorySlots(bot) : [],
    equipment: spawned ? buildEquipment(bot) : null,
    last_action: state.lastActionResult || null,
    recent_actions: (state.actionHistory || []).slice(-RECENT_ACTIONS_LIMIT),
    decision_source: state.lastDecisionSource || 'none',
    milestones: { ...(state.milestones || {}) },
    waypoints: listWaypoints(state),
    stronghold: {
      located: Boolean(state.stronghold?.located),
      reached: Boolean(state.stronghold?.reached),
      estimate: toPlainPosition(state.stronghold?.estimate)
    },
    end_portal: {
      frame_count: state.endPortal?.frameCount || 0,
      filled_count: state.endPortal?.filledCount || 0
    },
    advancement: state.currentAdvancement || null,
    unlocked_advancements: (state.unlockedAdvancements || []).length,
    metrics: { ...(state.metrics || {}) },
    tokens: { ...(state.tokenStats || {}) },
    updated_at: new Date(now).toISOString()
  };
}

/**
 * Forget the cached quest evaluation (used by tests)
 */
function resetQuestCache() {
  questCache = { at: 0, value: null };
}

module.exports = { buildSnapshot, buildQuests, resetQuestCache };
