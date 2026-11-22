const state = require('../core/state');
const config = require('../infrastructure/config');
const { syncObjective, findNearbyCraftingTable } = require('../perception/inventory');
const { scanEnvironment, checkTerrainSituation } = require('../perception/environment');
const { buildReactPrompt } = require('./prompt');
const { askOllama } = require('./ollama');
const { dispatchSkill } = require('../actions/dispatcher');
const { skillUnstuck } = require('../actions/behaviors/movement/navigate');
const { runManagerCycle, shouldRunManager, cleanTargetIdentifier } = require('./manager');
const { getPriorityDecision, getPlannedDecision } = require('./planner');
const {
  recordOutcome, isActionBlocked, detectStuck, forceRecovery, takeForcedDecision, getSuggestedTemperature, buildRemedyDecision
} = require('./recovery');
const { hasMilestone } = require('../core/progress');

const ACTION_TIMEOUT_MS = 45000;
const PROCEDURE_TIMEOUT_MS = 60000;
const PROCEDURE_ENVELOPE_TIMEOUT_MS = 75000;
// Long multi-phase skills need more than the default action budget
const ACTION_TIMEOUTS_MS = {
  // Leaving a flooded gallery can mean swimming a long route and breaking blocks under water
  unstuck: 60000,
  portal: 150000,
  goto: 50000,
  bed: 60000,
  stronghold: 75000,
  endportal: 130000,
  dragon: 60000
};
// Pause before the next cycle: a model call deserves a breather, a planned step does not
const LLM_CYCLE_DELAY_MS = 1500;
const PLANNED_CYCLE_DELAY_MS = 500;
// Planned cycles chain quickly: space out chat announcements so the server's anti-spam never kicks the bot
const ANNOUNCEMENT_INTERVAL_MS = 2500;
let lastAnnouncementAt = 0;

/**
 * Announce the chosen action in chat, at a rate the server's spam protection tolerates
 * @param {object} bot Mineflayer bot instance
 * @param {object} decision Decision about to be executed
 */
function announceDecision(bot, decision) {
  const now = Date.now();
  if (now - lastAnnouncementAt < ANNOUNCEMENT_INTERVAL_MS) return;
  lastAnnouncementAt = now;
  const safeTarget = decision.target && decision.target !== 'none' ? ` (${decision.target})` : '';
  bot.chat(`Action : ${decision.action}${safeTarget}`.slice(0, 60));
}

/**
 * Locate a placed crafting table nearby or at remembered base coordinates
 * @param {object} bot Mineflayer bot instance
 * @returns {object|null} Crafting table block or null
 */
function findAvailableCraftingTable(bot) {
  return findNearbyCraftingTable(bot, state);
}

/**
 * Reset physical interactions and close any active window on the bot
 * @param {object} bot Mineflayer bot instance
 */
function resetBotInteractions(bot) {
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  try {
    bot.stopDigging();
  } catch (error) {
    if (!error) return;
  }

  if (bot.currentWindow) {
    try {
      bot.closeWindow(bot.currentWindow);
    } catch (error) {
      if (!error) return;
    }
  }
}

/**
 * Safely abort digging, movement, and open windows after an action timeout
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<{ success: boolean, message: string }>} Recovery result
 */
async function recoverFromActionTimeout(bot) {
  state.activeActionId = (state.activeActionId || 0) + 1;
  resetBotInteractions(bot);

  const terrainBefore = checkTerrainSituation(bot);
  if (terrainBefore !== 'Terrain libre.') {
    try {
      console.log("[SAFETY] Executing emergency unstuck procedure...");
      await skillUnstuck(bot);
    } catch (unstuckError) {
      console.warn("[SAFETY] Emergency unstuck failure:", unstuckError.message);
    }
  }

  const terrainAfter = checkTerrainSituation(bot);
  const message = terrainAfter === 'Terrain libre.'
    ? "Action timed out; interactions reset and terrain is clear (do not call unstuck)."
    : "Action timed out after maximum safety limit. Emergency unstuck executed.";

  return {
    success: false,
    message
  };
}

/**
 * Execute the selected skill under a maximum safety timeout
 * @param {object} bot Mineflayer bot instance
 * @param {object} decision Validated AI decision
 * @param {object} [options={}] Execution options and injectable dependencies
 * @returns {Promise<{ success: boolean, message: string }>} Execution result
 */
async function executeDecisionWithTimeout(bot, decision, options = {}) {
  let actionTimer = null;
  state.activeActionId = (state.activeActionId || 0) + 1;
  const isProcedure = decision.action === 'procedure';
  let timeoutLimitMs = ACTION_TIMEOUTS_MS[decision.action] || ACTION_TIMEOUT_MS;
  if (decision.action === 'smelt') {
    timeoutLimitMs = Math.max(ACTION_TIMEOUT_MS, (decision.qty || 1) * 12000 + 20000);
  } else if (isProcedure) {
    timeoutLimitMs = options.procedureEnvelopeTimeoutMs || PROCEDURE_ENVELOPE_TIMEOUT_MS;
  }

  const controller = new AbortController();
  const dispatchFn = options.dispatchSkillFn || dispatchSkill;
  const skillOptions = isProcedure
    ? {
        timeoutMs: options.procedureTimeoutMs || PROCEDURE_TIMEOUT_MS,
        abortSignal: controller.signal,
        ...options.skillOptions
      }
    : options.skillOptions;

  const timeoutPromise = new Promise((_, reject) => {
    actionTimer = setTimeout(() => {
      controller.abort(new Error("Action execution timeout exceeded"));
      reject(new Error("Action execution timeout exceeded"));
    }, timeoutLimitMs);
  });

  try {
    return await Promise.race([
      dispatchFn(bot, state, decision.action, decision.target, decision.qty || 1, skillOptions),
      timeoutPromise
    ]);
  } catch (error) {
    console.warn(`[TIMEOUT / ERROR] Action '${decision.action}' aborted:`, error.message);
    return recoverFromActionTimeout(bot);
  } finally {
    if (actionTimer) clearTimeout(actionTimer);
  }
}

/**
 * Record an action execution result in state, bounded history and the anti-loop failure memory
 * @param {object} bot Mineflayer bot instance
 * @param {object} decision Executed decision
 * @param {{ success: boolean, message: string }} executionResult Skill execution result
 * @param {string} [source='llm'] Where the decision came from ('llm', 'plan', 'manager', 'procedure', 'recovery')
 */
function recordActionResult(bot, decision, executionResult, source = 'llm') {
  const entry = {
    action: decision.action,
    target: decision.target || 'none',
    success: executionResult.success,
    message: executionResult.message
  };
  state.lastActionResult = entry;
  state.lastDecisionSource = source;
  state.actionHistory.push({ ...entry });
  if (state.actionHistory.length > 8) {
    state.actionHistory.shift();
  }
  recordOutcome(bot, state, decision, executionResult);

  if (state.metrics) {
    if (source === 'llm') state.metrics.llmDecisions += 1;
    else state.metrics.deterministicDecisions += 1;
  }
}

/**
 * Pick the next action without consulting the model whenever the situation leaves no real choice.
 * Priority: forced recovery step, survival reflexes and stage logistics, the Manager's reliable
 * sub-goal (validated procedures), then the next feasible step of the dependency plan.
 * @param {object} bot Mineflayer bot instance
 * @returns {{ decision: object, source: string }|null} Automatic decision or null when the model must decide
 */
function selectAutomaticDecision(bot) {
  const forced = takeForcedDecision(state);
  if (forced) return { decision: forced, source: 'recovery' };

  const priority = getPriorityDecision(bot, state);
  if (priority.decision) return { decision: priority.decision, source: 'plan' };

  const reliable = getReliableProcedureDecision(state);
  if (reliable && !isActionBlocked(state, reliable.action, reliable.target, Date.now(), bot)) {
    return { decision: reliable, source: reliable.action === 'procedure' ? 'procedure' : 'manager' };
  }

  if (!priority.deferred) {
    const planned = getPlannedDecision(bot, state);
    if (planned) return { decision: planned, source: 'plan' };
  }
  return null;
}

/**
 * Ask the Player model for a decision, refusing any action that keeps failing
 * @param {object} bot Mineflayer bot instance
 * @param {Function} askOllamaFn Model query function
 * @returns {Promise<{ decision: object|null, source: string }>} Model decision, or a recovery step replacing a refused one
 */
async function requestModelDecision(bot, askOllamaFn) {
  const environment = scanEnvironment(bot, 20);
  const craftingTable = findAvailableCraftingTable(bot);
  const prompt = buildReactPrompt(bot, state, environment, craftingTable);

  // The temperature rises while the bot stagnates so the model stops answering the same thing
  const rawDecision = await askOllamaFn(prompt, undefined, undefined, { temperature: getSuggestedTemperature(state) });
  const decision = resolvePlayerDecision(rawDecision);
  if (!decision || !isActionBlocked(state, decision.action, decision.target, Date.now(), bot)) {
    return { decision, source: 'llm' };
  }

  // The model asks for something that just failed twice right here. Move a few blocks instead: the refusal is
  // tied to this spot, so the same request works afterwards, and the result message tells the model why.
  const remedy = buildRemedyDecision(bot, state, decision);
  if (remedy) {
    console.log(`[ANTI-LOOP] '${decision.action} ${decision.target}' keeps failing here: relocating before it is retried.`);
    if (state.metrics) state.metrics.refusals = (state.metrics.refusals || 0) + 1;
    return { decision: remedy, source: 'remedy' };
  }

  console.log(`[ANTI-LOOP] '${decision.action} ${decision.target}' keeps failing and no relocation is possible: forcing a recovery.`);
  forceRecovery(bot, state, `le modèle redemande '${decision.action} ${decision.target}' déjà en échec répété`);
  return { decision: takeForcedDecision(state), source: 'recovery' };
}

/**
 * Return a direct decision when a reliable validated procedure is assigned by the Manager
 * @param {object} [currentState=state] Global bot state
 * @returns {object|null} Priority procedural decision or null
 */
function getReliableProcedureDecision(currentState = state) {
  const subGoal = currentState?.managerSubGoal;
  if (!subGoal?.action || subGoal.isReliable !== true) {
    return null;
  }
  if (subGoal.action === 'portal') {
    const justFailedPortal = currentState.lastActionResult?.success === false && currentState.lastActionResult?.action === 'portal';
    if (justFailedPortal) return null;
    return {
      thought: currentState.managerDirective || "Exécution directe de l'action prioritaire 'portal'.",
      action: 'portal',
      target: 'none',
      qty: 1
    };
  }
  if (subGoal.action === 'mine' && subGoal.target) {
    const target = cleanTargetIdentifier(subGoal.target);
    const justFailedMine = (
      currentState.lastActionResult?.success === false &&
      currentState.lastActionResult?.action === 'mine' &&
      currentState.lastActionResult?.target === target
    );
    if (!target || target === 'none' || justFailedMine) return null;
    return {
      thought: currentState.managerDirective || `Exécution directe du minage prioritaire '${target}'.`,
      action: 'mine',
      target,
      qty: subGoal.qty || 1
    };
  }
  if (subGoal.action === 'craft' && subGoal.target) {
    const target = cleanTargetIdentifier(subGoal.target);
    const justFailedCraft = (
      currentState.lastActionResult?.success === false &&
      currentState.lastActionResult?.action === 'craft' &&
      currentState.lastActionResult?.target === target
    );
    if (!target || target === 'none' || justFailedCraft) return null;
    return {
      thought: currentState.managerDirective || `Exécution directe de la fabrication prioritaire '${target}'.`,
      action: 'craft',
      target,
      qty: 1
    };
  }
  if (subGoal.action === 'explore') {
    const justFailedExplore = currentState.lastActionResult?.success === false && currentState.lastActionResult?.action === 'explore';
    if (justFailedExplore) return null;
    const exploreTarget = cleanTargetIdentifier(subGoal.target || 'lava');
    return {
      thought: currentState.managerDirective || "Exploration prioritaire vers un lac de lave.",
      action: 'explore',
      target: exploreTarget === 'none' ? 'lava' : exploreTarget,
      qty: 1
    };
  }
  if (subGoal.action !== 'procedure' || !subGoal.target) {
    return null;
  }
  const target = cleanTargetIdentifier(subGoal.target);
  if (!target || target === 'none') return null;

  return {
    thought: currentState.managerDirective || `Exécution directe de la procédure validée '${target}'.`,
    action: 'procedure',
    target,
    qty: 1
  };
}

/**
 * Resolve a valid player decision or fall back to the supervisor sub-goal
 * @param {object|null} rawDecision Raw decision returned by the player model
 * @returns {object|null} Validated decision object or null
 */
function resolvePlayerDecision(rawDecision) {
  const reliableProcedure = getReliableProcedureDecision(state);
  if (reliableProcedure) return reliableProcedure;

  const candidate = [rawDecision, state.managerSubGoal].find(d => config.VALID_ACTIONS.has(d?.action));
  if (!candidate) return null;
  const target = cleanTargetIdentifier(candidate.target);
  const qty = Number.isInteger(candidate.qty) && candidate.qty > 0 ? Math.min(candidate.qty, 64) : 1;
  return {
    thought: candidate.thought || state.managerDirective || '',
    action: candidate.action,
    target,
    qty
  };
}

/**
 * Synchronize quest objective and trigger the supervisor cycle when needed
 * @param {object} bot Mineflayer bot instance
 * @param {Function} [runManagerFn=runManagerCycle] Supervisor cycle (injectable for tests)
 * @returns {Promise<void>} Promise resolved after evaluation
 */
async function evaluateManagerTrigger(bot, runManagerFn = runManagerCycle) {
  const objectiveBeforeSync = state.currentObjective;
  syncObjective(bot, state);
  const objectiveChanged = state.currentObjective !== objectiveBeforeSync;

  if (shouldRunManager(bot, state, objectiveChanged)) {
    await runManagerFn(bot);
  } else {
    state.cyclesSinceLastManager = (state.cyclesSinceLastManager || 0) + 1;
  }
}

/**
 * Check whether autonomous mode is active and matches the given session identifier
 * @param {number} sessionId Session identifier to verify
 * @returns {boolean} True if session is still active
 */
function isSessionActive(sessionId) {
  return Boolean(state.isSurviving && sessionId === state.survivalSessionId);
}

/**
 * Run a complete ReAct thinking and action cycle for autonomous survival
 * @param {object} bot Mineflayer bot instance
 * @param {number} [sessionId=state.survivalSessionId] Active survival session identifier
 * @param {object} [deps={}] Optional dependencies for testing
 * @returns {Promise<void>} Promise resolved at end of cycle
 */
async function handleSurvivalRequest(bot, sessionId = state.survivalSessionId, deps = {}) {
  if (!isSessionActive(sessionId)) return;

  const askOllamaFn = deps.askOllamaFn || askOllama;
  const runManagerFn = deps.runManagerFn || runManagerCycle;
  const scheduleNext = deps.scheduleNext !== false;

  try {
    const objectiveBeforeSync = state.currentObjective;
    syncObjective(bot, state);

    if (hasMilestone(state, 'dragon_defeated')) {
      state.isSurviving = false;
      console.log("🏆 Ender Dragon defeated: the full progression chain is complete. Autonomous mode stopped.");
      bot.chat("🏆 Ender Dragon vaincu ! Progression terminée, je m'arrête.");
      return;
    }

    if (state.currentObjective !== objectiveBeforeSync) {
      state.managerSubGoal = null;
      await runManagerFn(bot);
      if (!isSessionActive(sessionId)) return;
    }

    // Caught in a failure loop: cancel the approach and queue a different action before deciding anything
    const stuck = detectStuck(bot, state);
    if (stuck.stuck) {
      forceRecovery(bot, state, stuck.reason);
      bot.chat(`Blocage détecté : ${stuck.reason}`.slice(0, 100));
    }

    let decision = null;
    let source = 'llm';
    const automatic = selectAutomaticDecision(bot);
    if (automatic) {
      decision = automatic.decision;
      source = automatic.source;
      const cycleLabel = source === 'procedure' ? 'PROCEDURAL EXECUTION' : `DETERMINISTIC (${source})`;
      console.log(`\n=== ${cycleLabel} CYCLE (objective : ${state.currentObjective}, action : ${decision.action} ${decision.target}) ===`);
    } else {
      console.log(`\n=== REACT THINKING CYCLE (objective : ${state.currentObjective}) ===`);
      const modelChoice = await requestModelDecision(bot, askOllamaFn);
      if (!isSessionActive(sessionId)) return;
      decision = modelChoice.decision;
      source = modelChoice.source;
    }

    if (!decision) {
      console.log("Invalid decision received from Ollama and no valid fallback, pausing for 2s...");
      state.lastActionResult = { action: 'error', target: 'none', success: false, message: "Invalid JSON decision format." };
      if (scheduleNext) {
        setTimeout(() => handleSurvivalRequest(bot, sessionId, deps), 2000);
      }
      return;
    }

    if (decision.thought) {
      console.log(`[AI THOUGHT] ${decision.thought}`);
    }
    announceDecision(bot, decision);

    const rawResult = await executeDecisionWithTimeout(bot, decision, deps);
    if (!isSessionActive(sessionId)) return;
    // A remedy carries the reason the original request was refused, so the model reads it in its feedback
    const executionResult = decision.note
      ? { ...rawResult, message: `${decision.note} ${rawResult.message}` }
      : rawResult;
    console.log(`[RESULT] ${executionResult.success ? '✅' : '❌'} ${executionResult.message}`);

    recordActionResult(bot, decision, executionResult, source);

    if (isSessionActive(sessionId)) {
      await evaluateManagerTrigger(bot, runManagerFn);
    }

    if (isSessionActive(sessionId) && scheduleNext) {
      const delayMs = source === 'llm' ? LLM_CYCLE_DELAY_MS : PLANNED_CYCLE_DELAY_MS;
      setTimeout(() => handleSurvivalRequest(bot, sessionId, deps), delayMs);
    }
  } catch (error) {
    console.error("Unexpected error in survival cycle :", error);
    if (isSessionActive(sessionId) && scheduleNext) {
      setTimeout(() => handleSurvivalRequest(bot, sessionId, deps), 2500);
    }
  }
}

module.exports = {
  handleSurvivalRequest,
  resolvePlayerDecision,
  getReliableProcedureDecision,
  selectAutomaticDecision,
  executeDecisionWithTimeout,
  recoverFromActionTimeout
};
