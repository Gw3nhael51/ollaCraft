const invUtils = require('../perception/inventory');
const { checkTerrainSituation } = require('../perception/environment');
const { getDimension, listWaypoints, horizontalDistanceTo } = require('../core/progress');

// A failed (action, target) pair stays in memory this long before the bot may try it again
const FAILURE_TTL_MS = 5 * 60 * 1000;
// Number of failures after which a pair is refused until it expires
const BLOCK_THRESHOLD = 2;
// Cycles without any change of inventory, position cell or objective before the loop is broken automatically
const STAGNATION_CYCLE_LIMIT = 6;
const CONSECUTIVE_FAILURE_LIMIT = 4;
// Cycles spent on one objective without its progress gauge moving
const OBJECTIVE_STALL_LIMIT = 40;
// Minimum cycles between two automatic recoveries so one has time to take effect
const RECOVERY_COOLDOWN_CYCLES = 3;
const MAX_RECOVERY_LEVEL = 4;
const IGNORED_ACTIONS = new Set(['none', 'error']);

/**
 * Return the recovery bookkeeping stored in state, creating it on first use
 * @param {object} state Global bot state
 * @returns {object} Recovery state
 */
function getRecoveryState(state) {
  if (!state.recovery) {
    state.recovery = {
      failures: new Map(),
      stagnantCycles: 0,
      consecutiveFailures: 0,
      calmCycles: 0,
      lastSignature: null,
      objectiveName: null,
      objectiveProgress: 0,
      cyclesOnObjective: 0,
      cyclesSinceRecovery: RECOVERY_COOLDOWN_CYCLES,
      level: 0,
      forcedQueue: [],
      lastReason: null
    };
  }
  return state.recovery;
}

/**
 * Build the memory key of an (action, target) pair
 * @param {string} action Action name
 * @param {string} [target] Action target
 * @returns {string} Memory key
 */
function actionKey(action, target) {
  return `${action}:${target && target !== '' ? target : 'none'}`;
}

/**
 * Summarize everything that changes when the bot makes real progress: place, inventory and objective
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {string} Progress signature
 */
function computeProgressSignature(bot, state) {
  const pos = bot?.entity?.position;
  const cell = pos ? `${Math.floor(pos.x / 8)},${Math.floor(pos.y / 6)},${Math.floor(pos.z / 8)}` : 'nowhere';
  return [getDimension(bot), state.currentObjective, cell, invUtils.getInventorySummary(bot)].join('|');
}

/**
 * Measure how far the current objective has advanced, for objectives that are not a simple item count
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {number} Monotonic progress value
 */
function measureObjectiveProgress(bot, state) {
  const objective = state.currentObjective;
  if (objective === 'stronghold') {
    return (state.stronghold?.throws?.length || 0) + (state.stronghold?.located ? 5 : 0) + (state.stronghold?.reached ? 10 : 0);
  }
  if (objective === 'end_portal') {
    return (state.endPortal?.filledCount || 0) + (state.endPortal?.center ? 20 : 0);
  }
  return invUtils.countItem(bot, objective);
}

/**
 * Update failure memory and stagnation counters after an executed action
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {object} decision Executed decision
 * @param {{ success: boolean, message: string }} result Execution result
 * @param {number} [now=Date.now()] Reference timestamp
 */
function recordOutcome(bot, state, decision, result, now = Date.now()) {
  const recovery = getRecoveryState(state);
  const key = actionKey(decision.action, decision.target);

  if (result.success) {
    recovery.failures.delete(key);
    recovery.consecutiveFailures = 0;
  } else {
    const entry = recovery.failures.get(key) || { action: decision.action, target: decision.target || 'none', count: 0 };
    entry.count += 1;
    entry.lastMessage = String(result.message || '').slice(0, 140);
    entry.expiresAt = now + FAILURE_TTL_MS;
    recovery.failures.set(key, entry);
    recovery.consecutiveFailures += 1;
  }

  const signature = computeProgressSignature(bot, state);
  if (signature === recovery.lastSignature) {
    recovery.stagnantCycles += 1;
    recovery.calmCycles = 0;
  } else {
    recovery.stagnantCycles = 0;
    recovery.calmCycles += 1;
    // Several productive cycles in a row mean the bot is healthy again: relax the escalation level
    if (recovery.calmCycles >= 5 && recovery.level > 0) {
      recovery.level -= 1;
      recovery.calmCycles = 0;
    }
  }
  recovery.lastSignature = signature;

  const progress = measureObjectiveProgress(bot, state);
  if (recovery.objectiveName !== state.currentObjective || progress > recovery.objectiveProgress) {
    recovery.cyclesOnObjective = 0;
  } else {
    recovery.cyclesOnObjective += 1;
  }
  recovery.objectiveName = state.currentObjective;
  recovery.objectiveProgress = progress;
  recovery.cyclesSinceRecovery += 1;
}

/**
 * Check whether an (action, target) pair failed too often recently and must not be retried yet
 * @param {object} state Global bot state
 * @param {string} action Action name
 * @param {string} target Action target
 * @param {number} [now=Date.now()] Reference timestamp
 * @returns {boolean} True if the pair is currently refused
 */
function isActionBlocked(state, action, target, now = Date.now()) {
  const failures = state?.recovery?.failures;
  if (!failures) return false;
  const key = actionKey(action, target);
  const entry = failures.get(key);
  if (!entry) return false;
  if (now >= entry.expiresAt) {
    failures.delete(key);
    return false;
  }
  return entry.count >= BLOCK_THRESHOLD;
}

/**
 * List the pairs currently refused, for the prompt and the debug report
 * @param {object} state Global bot state
 * @param {number} [now=Date.now()] Reference timestamp
 * @returns {Array<{ action: string, target: string, count: number, lastMessage: string }>} Blocked pairs
 */
function getBlockedActions(state, now = Date.now()) {
  const failures = state?.recovery?.failures;
  if (!failures) return [];
  return Array.from(failures.values()).filter(entry => now < entry.expiresAt && entry.count >= BLOCK_THRESHOLD);
}

/**
 * Format the refused pairs as one prompt line
 * @param {object} state Global bot state
 * @returns {string} Human-readable list or 'aucune'
 */
function formatBlockedActions(state) {
  const blocked = getBlockedActions(state);
  if (blocked.length === 0) return 'aucune';
  return blocked
    .slice(0, 6)
    .map(entry => `${entry.action}(${entry.target}) x${entry.count} : ${entry.lastMessage}`)
    .join(' | ');
}

/**
 * Refuse a pair immediately, without waiting for it to fail again
 * @param {object} state Global bot state
 * @param {string} action Action name
 * @param {string} target Action target
 * @param {string} reason Why it is refused
 * @param {number} [now=Date.now()] Reference timestamp
 */
function blockAction(state, action, target, reason, now = Date.now()) {
  if (!action || IGNORED_ACTIONS.has(action)) return;
  const recovery = getRecoveryState(state);
  const key = actionKey(action, target);
  const entry = recovery.failures.get(key) || { action, target: target || 'none', count: 0 };
  entry.count = Math.max(entry.count, BLOCK_THRESHOLD);
  entry.lastMessage = String(reason || entry.lastMessage || 'blocked').slice(0, 140);
  entry.expiresAt = now + FAILURE_TTL_MS;
  recovery.failures.set(key, entry);
}

/**
 * Count how many of the most recent actions are the same (action, target) pair
 * @param {Array<object>} history Recent action history
 * @returns {number} Length of the trailing repetition
 */
function countTrailingRepeats(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const last = history.at(-1);
  let repeats = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].action !== last.action || history[i].target !== last.target) break;
    repeats += 1;
  }
  return repeats;
}

/**
 * Decide whether the bot is caught in a failure loop that needs a different action
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {{ stuck: boolean, reason: string|null }} Verdict and explanation
 */
function detectStuck(bot, state) {
  const recovery = getRecoveryState(state);
  if (recovery.cyclesSinceRecovery < RECOVERY_COOLDOWN_CYCLES) return { stuck: false, reason: null };
  // Waiting for the dragon to perch looks like stagnation and wandering near the void is deadly
  if (getDimension(bot) === 'the_end') return { stuck: false, reason: null };

  if (recovery.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
    return { stuck: true, reason: `${recovery.consecutiveFailures} échecs consécutifs` };
  }
  if (recovery.stagnantCycles >= STAGNATION_CYCLE_LIMIT) {
    return { stuck: true, reason: `${recovery.stagnantCycles} cycles sans aucun progrès (inventaire et position inchangés)` };
  }
  const repeats = countTrailingRepeats(state.actionHistory);
  if (repeats >= 4 && recovery.stagnantCycles >= 3) {
    const last = state.actionHistory.at(-1);
    return { stuck: true, reason: `'${last.action} ${last.target}' répétée ${repeats} fois sans effet` };
  }
  if (recovery.cyclesOnObjective >= OBJECTIVE_STALL_LIMIT) {
    return { stuck: true, reason: `objectif '${state.currentObjective}' sans progression depuis ${recovery.cyclesOnObjective} cycles` };
  }
  return { stuck: false, reason: null };
}

/**
 * Read the terrain situation without ever throwing on partial world data
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Terrain description
 */
function readTerrain(bot) {
  try {
    return checkTerrainSituation(bot);
  } catch {
    return 'Terrain libre.';
  }
}

/**
 * Pick a known waypoint far enough to be worth walking back to
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {string|null} Waypoint name or null
 */
function pickRelocationWaypoint(bot, state) {
  const candidates = listWaypoints(state, getDimension(bot))
    .filter(wp => wp.name !== 'death')
    .map(wp => ({ name: wp.name, distance: horizontalDistanceTo(bot, wp) }))
    .filter(wp => wp.distance > 24 && wp.distance < 400)
    .sort((a, b) => a.distance - b.distance);
  return candidates[0]?.name || null;
}

/**
 * Choose an action different from what the bot has been repeating, escalating with each recovery
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} reason Why a recovery is needed
 * @returns {Array<object>} Ordered forced decisions (first one runs next)
 */
function buildRecoveryPlan(bot, state, reason) {
  const recovery = getRecoveryState(state);
  const recentKeys = new Set((state.actionHistory || []).slice(-3).map(item => actionKey(item.action, item.target)));
  const terrain = readTerrain(bot);
  const candidates = [];

  if (terrain !== 'Terrain libre.' || bot?.entity?.isInWater) {
    candidates.push({ action: 'unstuck', target: 'none' });
  }
  if (recovery.level >= 2) {
    const waypoint = pickRelocationWaypoint(bot, state);
    if (waypoint) candidates.push({ action: 'goto', target: waypoint });
  }
  candidates.push({ action: 'explore', target: 'relocate' }, { action: 'unstuck', target: 'none' });

  const chosen = candidates.find(c => !recentKeys.has(actionKey(c.action, c.target))) || { action: 'explore', target: 'relocate' };
  const thought = `Déblocage (niveau ${recovery.level}) : ${reason}. Je change d'action : ${chosen.action} ${chosen.target}.`;
  const plan = [{ ...chosen, qty: 1, thought, source: 'recovery' }];

  // From the second escalation on, walk further away so the same dead end is not found again
  if (recovery.level >= 1 && chosen.action !== 'goto') {
    plan.push({ action: 'explore', target: 'none', qty: 1, thought: "Déblocage : je m'éloigne de la zone problématique.", source: 'recovery' });
  }
  return plan;
}

/**
 * Break the current failure loop: cancel what is running, refuse the looping action and queue a different one
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} reason Why the recovery is triggered
 * @param {object} [options={}] Recovery options
 * @param {boolean} [options.manual=false] True when requested by the user's debug command
 * @returns {{ decision: object, blocked: string|null }} First forced decision and the refused pair
 */
function forceRecovery(bot, state, reason, options = {}) {
  const recovery = getRecoveryState(state);
  const last = state.lastActionResult;
  let blocked = null;

  // The pair being repeated is refused for a while so neither the planner nor the model can pick it again.
  // A long but productive search (exploring further each cycle) is only redirected, never refused.
  const repeats = countTrailingRepeats(state.actionHistory);
  const repeatingInPlace = repeats >= 3 && recovery.stagnantCycles >= 3;
  if (last && !IGNORED_ACTIONS.has(last.action) && (options.manual || !last.success || repeatingInPlace)) {
    blockAction(state, last.action, last.target, `boucle interrompue (${reason})`);
    blocked = actionKey(last.action, last.target);
  }

  state.activeActionId = (state.activeActionId || 0) + 1;
  bot?.pathfinder?.setGoal?.(null);
  bot?.clearControlStates?.();
  try {
    bot?.stopDigging?.();
  } catch {
    // Nothing was being dug
  }

  const plan = buildRecoveryPlan(bot, state, reason);
  recovery.forcedQueue = plan;
  recovery.level = Math.min(MAX_RECOVERY_LEVEL, recovery.level + 1);
  recovery.stagnantCycles = 0;
  recovery.consecutiveFailures = 0;
  recovery.calmCycles = 0;
  recovery.cyclesOnObjective = 0;
  recovery.cyclesSinceRecovery = 0;
  recovery.lastReason = reason;

  state.managerSubGoal = null;
  state.managerDirective = `Blocage détecté (${reason}) : abandonne l'approche précédente et essaie autre chose.`;
  if (state.metrics) state.metrics.recoveries = (state.metrics.recoveries || 0) + 1;

  console.log(`[RECOVERY 🛟] ${options.manual ? 'Manuel' : 'Auto'} : ${reason} -> ${plan.map(d => `${d.action}(${d.target})`).join(' puis ')}${blocked ? ` | bloqué: ${blocked}` : ''}`);
  return { decision: plan[0], blocked };
}

/**
 * Take the next forced decision queued by a recovery, if any
 * @param {object} state Global bot state
 * @returns {object|null} Forced decision or null
 */
function takeForcedDecision(state) {
  const queue = state?.recovery?.forcedQueue;
  if (!Array.isArray(queue) || queue.length === 0) return null;
  return queue.shift();
}

/**
 * Suggest a sampling temperature that rises while the bot stagnates so the model stops repeating itself
 * @param {object} state Global bot state
 * @returns {number} Temperature between 0.1 and 0.7
 */
function getSuggestedTemperature(state) {
  const recovery = state?.recovery;
  if (!recovery) return 0.1;
  const pressure = Math.min(4, Math.max(recovery.stagnantCycles, recovery.consecutiveFailures));
  return Math.round((0.1 + pressure * 0.15) * 100) / 100;
}

/**
 * Describe the bot's current situation for the debug command
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {string[]} Short report lines, each fitting in a chat message
 */
function describeDebugState(bot, state) {
  const recovery = getRecoveryState(state);
  const pos = bot?.entity?.position;
  const where = pos ? `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}` : '?';
  const last = state.lastActionResult || {};
  const history = (state.actionHistory || [])
    .slice(-4)
    .map(item => `${item.action}(${item.target})${item.success ? '✓' : '✗'}`)
    .join(' ') || 'vide';
  const metrics = state.metrics || {};
  const verdict = detectStuck(bot, state);

  return [
    `[DEBUG] Objectif: ${state.currentObjective}${state.manualObjective ? ' (manuel)' : ''} | ${getDimension(bot)} @ ${where} | terrain: ${readTerrain(bot)}`,
    `[DEBUG] Dernière action: ${last.action}(${last.target}) ${last.success ? 'OK' : 'ECHEC'} - ${String(last.message || '').slice(0, 110)}`,
    `[DEBUG] Historique: ${history} | stagnation: ${recovery.stagnantCycles} | échecs consécutifs: ${recovery.consecutiveFailures} | niveau: ${recovery.level}`,
    `[DEBUG] Bloquées: ${formatBlockedActions(state).slice(0, 190)}`,
    `[DEBUG] Décisions: plan ${metrics.deterministicDecisions || 0} / LLM ${metrics.llmDecisions || 0} / déblocages ${metrics.recoveries || 0} | coincé: ${verdict.stuck ? verdict.reason : 'non'}`
  ];
}

module.exports = {
  FAILURE_TTL_MS,
  BLOCK_THRESHOLD,
  STAGNATION_CYCLE_LIMIT,
  getRecoveryState,
  actionKey,
  computeProgressSignature,
  recordOutcome,
  isActionBlocked,
  getBlockedActions,
  formatBlockedActions,
  blockAction,
  detectStuck,
  buildRecoveryPlan,
  forceRecovery,
  takeForcedDecision,
  getSuggestedTemperature,
  describeDebugState
};
