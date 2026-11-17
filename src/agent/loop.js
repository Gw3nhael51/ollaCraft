const state = require('../core/state');
const config = require('../infrastructure/config');
const { syncObjective, findNearbyCraftingTable } = require('../perception/inventory');
const { scanEnvironment, checkTerrainSituation } = require('../perception/environment');
const { buildReactPrompt } = require('./prompt');
const { askOllama } = require('./ollama');
const { dispatchSkill } = require('../actions/dispatcher');
const { skillUnstuck } = require('../actions/behaviors/movement/navigate');
const { runManagerCycle, shouldRunManager, cleanTargetIdentifier } = require('./manager');

const ACTION_TIMEOUT_MS = 45000;
const PROCEDURE_TIMEOUT_MS = 60000;
const PROCEDURE_ENVELOPE_TIMEOUT_MS = 75000;

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
  let timeoutLimitMs = ACTION_TIMEOUT_MS;
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
 * Record an action execution result in state and bounded history
 * @param {object} decision Executed decision
 * @param {{ success: boolean, message: string }} executionResult Skill execution result
 */
function recordActionResult(decision, executionResult) {
  const entry = {
    action: decision.action,
    target: decision.target || 'none',
    success: executionResult.success,
    message: executionResult.message
  };
  state.lastActionResult = entry;
  state.actionHistory.push({ ...entry });
  if (state.actionHistory.length > 8) {
    state.actionHistory.shift();
  }
}

/**
 * Return a direct decision when a reliable validated procedure is assigned by the Manager
 * @param {object} [currentState=state] Global bot state
 * @returns {object|null} Priority procedural decision or null
 */
function getReliableProcedureDecision(currentState = state) {
  const subGoal = currentState?.managerSubGoal;
  if (subGoal?.action !== 'procedure' || subGoal.isReliable !== true || !subGoal.target) {
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
 * @returns {Promise<void>} Promise resolved after evaluation
 */
async function evaluateManagerTrigger(bot) {
  const objectiveBeforeSync = state.currentObjective;
  syncObjective(bot, state);
  const objectiveChanged = state.currentObjective !== objectiveBeforeSync;

  if (shouldRunManager(bot, state, objectiveChanged)) {
    await runManagerCycle(bot);
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
    if (state.currentObjective !== objectiveBeforeSync) {
      state.managerSubGoal = null;
      await runManagerFn(bot);
      if (!isSessionActive(sessionId)) return;
    }

    let decision = getReliableProcedureDecision(state);
    if (decision) {
      console.log(`\n=== PROCEDURAL EXECUTION CYCLE (objective : ${state.currentObjective}, procedure : ${decision.target}) ===`);
    } else {
      const environment = scanEnvironment(bot, 20);
      const craftingTable = findAvailableCraftingTable(bot);
      const prompt = buildReactPrompt(bot, state, environment, craftingTable);

      console.log(`\n=== REACT THINKING CYCLE (objective : ${state.currentObjective}) ===`);
      const rawDecision = await askOllamaFn(prompt);
      if (!isSessionActive(sessionId)) return;
      decision = resolvePlayerDecision(rawDecision);
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
    const safeTarget = decision.target && decision.target !== 'none' ? ` (${decision.target})` : '';
    const safeActionAnnouncement = `Action : ${decision.action}${safeTarget}`.slice(0, 60);
    bot.chat(safeActionAnnouncement);

    const executionResult = await executeDecisionWithTimeout(bot, decision, deps);
    if (!isSessionActive(sessionId)) return;
    console.log(`[RESULT] ${executionResult.success ? '✅' : '❌'} ${executionResult.message}`);

    recordActionResult(decision, executionResult);

    if (isSessionActive(sessionId)) {
      await evaluateManagerTrigger(bot);
    }

    if (isSessionActive(sessionId) && scheduleNext) {
      setTimeout(() => handleSurvivalRequest(bot, sessionId, deps), 1500);
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
  executeDecisionWithTimeout,
  recoverFromActionTimeout
};
