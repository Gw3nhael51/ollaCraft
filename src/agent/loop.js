const state = require('../core/state');
const config = require('../infrastructure/config');
const { syncObjective, findNearbyCraftingTable } = require('../perception/inventory');
const { scanEnvironment } = require('../perception/environment');
const { buildReactPrompt } = require('./prompt');
const { askOllama } = require('./ollama');
const { dispatchSkill } = require('../actions/dispatcher');
const { skillUnstuck } = require('../actions/behaviors/movement/navigate');
const { runManagerCycle, shouldRunManager, cleanTargetIdentifier } = require('./manager');

const ACTION_TIMEOUT_MS = 45000;

/**
 * Localiser un établi placé à proximité ou aux coordonnées mémorisées de la base
 * @param {object} bot Instance du bot Mineflayer
 * @returns {object|null} Bloc établi ou null
 */
function findAvailableCraftingTable(bot) {
  return findNearbyCraftingTable(bot, state);
}

/**
 * Réinitialiser les interactions physiques et fermer la fenêtre active du bot
 * @param {object} bot Instance du bot Mineflayer
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
 * Interrompre en sécurité le minage, le déplacement et les fenêtres ouvertes après expiration du délai
 * @param {object} bot Instance du bot Mineflayer
 * @returns {Promise<{ success: boolean, message: string }>} Résultat de la récupération
 */
async function recoverFromActionTimeout(bot) {
  state.activeActionId = (state.activeActionId || 0) + 1;
  resetBotInteractions(bot);

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
 * Exécuter la compétence sélectionnée avec un délai de sécurité maximal
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} decision Décision validée de l'IA
 * @returns {Promise<{ success: boolean, message: string }>} Résultat d'exécution
 */
async function executeDecisionWithTimeout(bot, decision) {
  let actionTimer = null;
  state.activeActionId = (state.activeActionId || 0) + 1;
  const timeoutLimitMs = decision.action === 'smelt'
    ? Math.max(ACTION_TIMEOUT_MS, (decision.qty || 1) * 12000 + 20000)
    : ACTION_TIMEOUT_MS;

  const timeoutPromise = new Promise((_, reject) => {
    actionTimer = setTimeout(() => {
      reject(new Error("Action execution timeout exceeded"));
    }, timeoutLimitMs);
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
 * Enregistrer le résultat d'exécution d'une action dans l'état et l'historique borné
 * @param {object} decision Décision exécutée
 * @param {{ success: boolean, message: string }} executionResult Résultat de la compétence
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
 * Résoudre une décision valide du joueur ou utiliser le sous-objectif du superviseur en repli
 * @param {object|null} rawDecision Décision brute retournée par le modèle joueur
 * @returns {object|null} Objet décision validé ou null
 */
function resolvePlayerDecision(rawDecision) {
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
 * Synchroniser l'objectif de quête et déclencher le cycle du superviseur si nécessaire
 * @param {object} bot Instance du bot Mineflayer
 * @returns {Promise<void>} Promesse résolue après l'évaluation
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
 * Vérifier si le mode autonome est actif et correspond à l'identifiant de session donné
 * @param {number} sessionId Identifiant de session à contrôler
 * @returns {boolean} Vrai si la session est toujours active
 */
function isSessionActive(sessionId) {
  return Boolean(state.isSurviving && sessionId === state.survivalSessionId);
}

/**
 * Exécuter un cycle complet de réflexion et d'action ReAct pour la survie autonome
 * @param {object} bot Instance du bot Mineflayer
 * @param {number} [sessionId=state.survivalSessionId] Identifiant de la session de survie active
 * @returns {Promise<void>} Promesse résolue à la fin du cycle
 */
async function handleSurvivalRequest(bot, sessionId = state.survivalSessionId) {
  if (!isSessionActive(sessionId)) return;

  try {
    syncObjective(bot, state);

    const environment = scanEnvironment(bot, 20);
    const craftingTable = findAvailableCraftingTable(bot);
    const prompt = buildReactPrompt(bot, state, environment, craftingTable);

    console.log(`\n=== REACT THINKING CYCLE (objective : ${state.currentObjective}) ===`);
    const rawDecision = await askOllama(prompt);
    if (!isSessionActive(sessionId)) return;
    const decision = resolvePlayerDecision(rawDecision);

    if (!decision) {
      console.log("Invalid decision received from Ollama and no valid fallback, pausing for 2s...");
      state.lastActionResult = { action: 'error', target: 'none', success: false, message: "Invalid JSON decision format." };
      setTimeout(() => handleSurvivalRequest(bot, sessionId), 2000);
      return;
    }

    if (decision.thought) {
      console.log(`[AI THOUGHT] ${decision.thought}`);
    }
    const safeTarget = decision.target && decision.target !== 'none' ? ` (${decision.target})` : '';
    const safeActionAnnouncement = `Action : ${decision.action}${safeTarget}`.slice(0, 60);
    bot.chat(safeActionAnnouncement);

    const executionResult = await executeDecisionWithTimeout(bot, decision);
    if (!isSessionActive(sessionId)) return;
    console.log(`[RESULT] ${executionResult.success ? '✅' : '❌'} ${executionResult.message}`);

    recordActionResult(decision, executionResult);

    if (isSessionActive(sessionId)) {
      await evaluateManagerTrigger(bot);
    }

    if (isSessionActive(sessionId)) {
      setTimeout(() => handleSurvivalRequest(bot, sessionId), 1500);
    }
  } catch (error) {
    console.error("Unexpected error in survival cycle :", error);
    if (isSessionActive(sessionId)) {
      setTimeout(() => handleSurvivalRequest(bot, sessionId), 2500);
    }
  }
}

module.exports = { handleSurvivalRequest, resolvePlayerDecision };
