const state = require('../state');
const config = require('../config');
const { syncObjective } = require('../utils/inventory');
const { scanEnvironment } = require('../utils/environment');
const { buildReactPrompt } = require('./prompt');
const { askOllama } = require('./ollama');
const { dispatchSkill } = require('../skills/dispatcher');

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

    const executionResult = await dispatchSkill(bot, state, decision.action, decision.target, decision.qty || 1);
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
