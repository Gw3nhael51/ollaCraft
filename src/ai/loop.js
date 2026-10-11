const state = require('../state');
const config = require('../config');
const { syncObjective } = require('../utils/inventory');
const { scanEnvironment } = require('../utils/environment');
const { buildReactPrompt } = require('./prompt');
const { askOllama } = require('./ollama');
const { dispatchSkill } = require('../skills/dispatcher');

/**
 * Exécute un cycle complet de réflexion et d'action ReAct pour la survie autonome
 * @param {object} bot Instance Mineflayer du bot
 * @returns {Promise<void>}
 */
async function handleSurvivalRequest(bot) {
  if (!state.isSurviving) return;

  syncObjective(bot, state);

  const environment = scanEnvironment(bot, 20);
  const tableId = bot.registry.blocksByName['crafting_table']?.id;
  let craftingTable = tableId ? bot.findBlock({ matching: tableId, maxDistance: 48 }) : null;
  if (!craftingTable && state.base.crafting_table) {
    const baseTable = bot.blockAt(state.base.crafting_table);
    if (baseTable && baseTable.name === 'crafting_table') {
      craftingTable = baseTable;
    }
  }

  const prompt = buildReactPrompt(bot, state, environment, craftingTable);
  console.log(`\n=== CYCLE DE RÉFLEXION REACT (objectif : ${state.currentObjective}) ===`);
  const decision = await askOllama(prompt);

  if (!decision || !config.VALID_ACTIONS.has(decision.action)) {
    console.log("Décision invalide reçue d'Ollama, pause de 2s...");
    state.lastActionResult = { action: 'erreur', target: 'aucune', success: false, message: "Format de décision JSON invalide." };
    setTimeout(() => handleSurvivalRequest(bot), 2000);
    return;
  }

  if (decision.thought) {
    console.log(`[PENSÉE IA] ${decision.thought}`);
  }
  bot.chat(`Action : ${decision.action} (${decision.target || 'aucune'})`);

  const executionResult = await dispatchSkill(bot, state, decision.action, decision.target, decision.qty || 1);
  console.log(`[RÉSULTAT] ${executionResult.success ? '✅' : '❌'} ${executionResult.message}`);

  state.lastActionResult = {
    action: decision.action,
    target: decision.target || 'aucune',
    success: executionResult.success,
    message: executionResult.message
  };

  syncObjective(bot, state);

  if (state.isSurviving) {
    setTimeout(() => handleSurvivalRequest(bot), 1500);
  }
}

module.exports = { handleSurvivalRequest };
