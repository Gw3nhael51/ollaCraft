const state = require('../state');
const config = require('../config');
const { syncObjective } = require('../utils/inventory');
const { scanEnvironment } = require('../utils/environment');
const { buildReactPrompt } = require('./prompt');
const { askOllama } = require('./ollama');
const { dispatchSkill } = require('../skills/dispatcher');
const { skillUnstuck } = require('../skills/navigate');
const { runManagerCycle } = require('./manager');

const ACTION_TIMEOUT_MS = 45000;

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
    const tableId = bot.registry.blocksByName['crafting_table']?.id;
    let craftingTable = tableId ? bot.findBlock({ matching: tableId, maxDistance: 48 }) : null;
    if (!craftingTable && state.base.crafting_table) {
      const baseTable = bot.blockAt(state.base.crafting_table);
      if (baseTable?.name === 'crafting_table') {
        craftingTable = baseTable;
      }
    }

    const prompt = buildReactPrompt(bot, state, environment, craftingTable);
    console.log(`\n=== REACT THINKING CYCLE (objective : ${state.currentObjective}) ===`);
    const decision = await askOllama(prompt);

    if (!decision || !config.VALID_ACTIONS.has(decision.action)) {
      console.log("Invalid decision received from Ollama, pausing for 2s...");
      state.lastActionResult = { action: 'error', target: 'none', success: false, message: "Invalid JSON decision format." };
      setTimeout(() => handleSurvivalRequest(bot), 2000);
      return;
    }

    if (decision.thought) {
      console.log(`[AI THOUGHT] ${decision.thought}`);
    }
    bot.chat(`Action : ${decision.action} (${decision.target || 'none'})`);

    let executionResult;
    let actionTimer = null;

    // Increment active action identifier to track current execution
    state.activeActionId = (state.activeActionId || 0) + 1;

    // Safety timeout promise to prevent infinite execution hangs
    const timeoutPromise = new Promise((_, reject) => {
      actionTimer = setTimeout(() => {
        reject(new Error("Action execution timeout exceeded"));
      }, ACTION_TIMEOUT_MS);
    });

    try {
      executionResult = await Promise.race([
        dispatchSkill(bot, state, decision.action, decision.target, decision.qty || 1),
        timeoutPromise
      ]);
    } catch (error) {
      console.warn(`[TIMEOUT / ERROR] Action '${decision.action}' aborted:`, error.message);

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

      executionResult = {
        success: false,
        message: "Action timed out after maximum safety limit. Emergency unstuck executed."
      };
    } finally {
      if (actionTimer) {
        clearTimeout(actionTimer);
      }
    }

    console.log(`[RESULT] ${executionResult.success ? '✅' : '❌'} ${executionResult.message}`);

    state.lastActionResult = {
      action: decision.action,
      target: decision.target || 'none',
      success: executionResult.success,
      message: executionResult.message
    };

    state.actionHistory.push({
      action: decision.action,
      target: decision.target || 'none',
      success: executionResult.success,
      message: executionResult.message
    });
    if (state.actionHistory.length > 8) {
      state.actionHistory.shift();
    }

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

module.exports = { handleSurvivalRequest };
