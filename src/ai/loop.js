const state = require('../state');
const config = require('../config');
const { syncObjective, findNearbyCraftingTable } = require('../utils/inventory');
const { scanEnvironment } = require('../utils/environment');
const { buildReactPrompt } = require('./prompt');
const { askOllama } = require('./ollama');
const { dispatchSkill } = require('../skills/dispatcher');
const { skillUnstuck } = require('../skills/navigate');
const { runManagerCycle } = require('./manager');

const ACTION_TIMEOUT_MS = 45000;

/**
 * Locate a placed crafting table nearby or at the remembered base coordinates
 * @param {object} bot Mineflayer bot instance
 * @returns {object|null} Crafting table block or null
 */
function findAvailableCraftingTable(bot) {
  return findNearbyCraftingTable(bot, state);
}

/**
 * Safely abort ongoing digging, pathfinding, and open windows upon action timeout
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<{ success: boolean, message: string }>} Recovery result
 */
async function recoverFromActionTimeout(bot) {
  // Invalidate action identifier to abort background recursive tasks
  state.activeActionId = (state.activeActionId || 0) + 1;

  // Forcefully cancel pathfinding and reset controls
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  try {
    bot.stopDigging();
  } catch {
    // Ignore error if bot is not currently digging
  }

  // Close open container or crafting window if active
  if (bot.currentWindow) {
    try {
      bot.closeWindow(bot.currentWindow);
    } catch {
      // Ignore error if window is already closed by server
    }
  }

  // Execute emergency unstuck procedure to free bot
  try {
    console.log("[SAFETY] Executing emergency unstuck procedure...");
    await skillUnstuck(bot);
  } catch (unstuckError) {
    console.warn("[SAFETY] Emergency unstuck failure:", unstuckError.message);
  }

  return {
    success: false,
    message: "Action timed out after maximum safety limit. Emergency unstuck executed."
  };
}

/**
 * Execute the selected skill with a safety timeout guard
 * @param {object} bot Mineflayer bot instance
 * @param {object} decision Validated AI decision
 * @returns {Promise<{ success: boolean, message: string }>} Execution result
 */
async function executeDecisionWithTimeout(bot, decision) {
  let actionTimer = null;
  state.activeActionId = (state.activeActionId || 0) + 1;

  const timeoutPromise = new Promise((_, reject) => {
    actionTimer = setTimeout(() => {
      reject(new Error("Action execution timeout exceeded"));
    }, ACTION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      dispatchSkill(bot, state, decision.action, decision.target, decision.qty || 1),
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
 * Record action execution result into state memory and bounded history
 * @param {object} decision Executed AI decision
 * @param {{ success: boolean, message: string }} executionResult Skill result
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
 * Resolve valid player decision or fall back to manager sub-goal when LLM output is invalid
 * @param {object|null} rawDecision Decision returned by player LLM
 * @returns {object|null} Validated decision object or null
 */
function resolvePlayerDecision(rawDecision) {
  const candidate = [rawDecision, state.managerSubGoal].find(d => config.VALID_ACTIONS.has(d?.action));
  if (!candidate) return null;
  return { thought: state.managerDirective, target: 'none', qty: 1, ...candidate };
}

/**
 * Execute a complete ReAct thought and action cycle for autonomous survival
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<void>}
 */
async function handleSurvivalRequest(bot) {
  if (!state.isSurviving) return;

  try {
    syncObjective(bot, state);

    const environment = scanEnvironment(bot, 20);
    const craftingTable = findAvailableCraftingTable(bot);
    const prompt = buildReactPrompt(bot, state, environment, craftingTable);

    console.log(`\n=== REACT THINKING CYCLE (objective : ${state.currentObjective}) ===`);
    const rawDecision = await askOllama(prompt);
    const decision = resolvePlayerDecision(rawDecision);

    if (!decision) {
      console.log("Invalid decision received from Ollama and no valid fallback, pausing for 2s...");
      state.lastActionResult = { action: 'error', target: 'none', success: false, message: "Invalid JSON decision format." };
      setTimeout(() => handleSurvivalRequest(bot), 2000);
      return;
    }

    if (decision.thought) {
      console.log(`[AI THOUGHT] ${decision.thought}`);
    }
    bot.chat(`Action : ${decision.action} (${decision.target})`);

    const executionResult = await executeDecisionWithTimeout(bot, decision);
    console.log(`[RESULT] ${executionResult.success ? '✅' : '❌'} ${executionResult.message}`);

    recordActionResult(decision, executionResult);
    syncObjective(bot, state);

    // Evaluate supervisor strategy with exact player state after action
    if (state.isSurviving) {
      await runManagerCycle(bot);
    }

    if (state.isSurviving) {
      setTimeout(() => handleSurvivalRequest(bot), 1500);
    }
  } catch (error) {
    console.error("Unexpected error in survival cycle :", error);
    if (state.isSurviving) {
      setTimeout(() => handleSurvivalRequest(bot), 2500);
    }
  }
}

module.exports = { handleSurvivalRequest, resolvePlayerDecision };
