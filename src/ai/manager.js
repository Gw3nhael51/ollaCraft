const config = require('../config');
const state = require('../state');
const invUtils = require('../utils/inventory');
const { askOllama } = require('./ollama');

/**
 * Detect whether the bot is stuck in an action loop or consecutive failures
 * @param {Array<object>} actionHistory Recent actions executed by the player
 * @returns {boolean} True if a loop or repeated failure is detected
 */
function detectActionLoop(actionHistory) {
  if (actionHistory.length < 3) return false;
  const recent = actionHistory.slice(-3);
  const allFailures = recent.every(item => !item.success);
  const sameAction = recent.every(item => item.action === recent[0].action && item.target === recent[0].target);
  return allFailures || sameAction;
}

/**
 * Sanitize and validate manager directives against game state to prevent hallucinations
 * @param {object} bot Mineflayer bot instance
 * @param {object} rawDecision Parsed JSON output from supervisor model
 * @returns {object} Validated directive and sub-goal
 */
function sanitizeManagerOutput(bot, rawDecision) {
  if (!rawDecision || typeof rawDecision !== 'object') {
    return {
      directive: "Poursuivre la progression vers l'objectif actuel.",
      suggestedAction: "explore",
      suggestedTarget: "none"
    };
  }

  let action = rawDecision.suggestedAction || 'explore';
  let target = rawDecision.suggestedTarget || 'none';
  let directive = rawDecision.directive || "Poursuivre l'objectif en cours.";

  if (!config.VALID_ACTIONS.has(action)) {
    action = 'explore';
  }

  if (action === 'craft') {
    const tableId = bot.registry.blocksByName['crafting_table']?.id;
    const table = tableId ? bot.findBlock({ matching: tableId, maxDistance: 16 }) : null;
    const available = invUtils.getAvailableCrafts(bot, table);
    if (!available.includes(target)) {
      action = 'explore';
      directive = `Ressources manquantes pour fabriquer ${target}, explorer pour trouver des composants.`;
    }
  }

  if (action === 'smelt' && invUtils.countItem(bot, target) === 0) {
    action = 'mine';
    directive = `Miner le minerai requis avant de pouvoir faire fondre ${target}.`;
  }

  return { directive, suggestedAction: action, suggestedTarget: target };
}

/**
 * Execute periodic supervisor reasoning cycle to steer the autonomous player
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<void>}
 */
async function runManagerCycle(bot) {
  if (!state.isSurviving || state.isManagerThinking) return;

  state.isManagerThinking = true;
  try {
    const tools = invUtils.getOwnedTools(bot).join(', ') || 'aucun';
    const inventory = invUtils.getInventorySummary(bot);
    const loopDetected = detectActionLoop(state.actionHistory);
    const recentHistory = JSON.stringify(state.actionHistory.slice(-4));

    const prompt = `
      Tu es le Manager Stratège du bot Minecraft.
      Ton rôle est de superviser le joueur, éviter qu'il boucle, et lui fixer une priorité claire.

      SITUATION ACTUELLE :
      - Objectif final : '${state.currentObjective}'
      - Outils possédés : ${tools}
      - Inventaire : ${inventory}
      - Santé : ${Math.round(bot.health)}/20 | Faim : ${Math.round(bot.food)}/20
      - Historique des actions récentes : ${recentHistory}
      - Blocage ou boucle détectée : ${loopDetected ? 'OUI (ATTENTION : le joueur échoue ou répète la même action)' : 'NON'}

      CONSIGNE :
      Définis la prochaine étape logique pour progresser ou te débloquer. Sois direct, clair et réaliste.
      Réponds UNIQUEMENT en JSON :
      {
        "thought": "Diagnostic rapide de la situation",
        "directive": "Consigne impérative et courte pour le joueur",
        "suggestedAction": "mine" | "craft" | "place" | "smelt" | "explore" | "unstuck" | "eat",
        "suggestedTarget": "nom_cible"
      }
    `;

    const result = await askOllama(prompt, config.OLLAMA_MODEL_MANAGER);

    if (result) {
      const validated = sanitizeManagerOutput(bot, result);
      state.managerDirective = validated.directive;
      state.managerSubGoal = { action: validated.suggestedAction, target: validated.suggestedTarget };
      console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: ${validated.suggestedAction})`);
    }
  } catch (error) {
    console.warn("[MANAGER] Erreur lors de l'analyse du superviseur :", error.message);
  } finally {
    state.isManagerThinking = false;
  }
}

let managerIntervalHandle = null;

/**
 * Start asynchronous supervisor loop running in the background
 * @param {object} bot Mineflayer bot instance
 * @param {number} [intervalMs] Periodic check interval in milliseconds
 * @returns {NodeJS.Timeout} Interval timer handle
 */
function startManagerLoop(bot, intervalMs = 20000) {
  if (managerIntervalHandle) return managerIntervalHandle;

  setTimeout(() => runManagerCycle(bot), 3000);

  managerIntervalHandle = setInterval(() => {
    if (state.isSurviving) {
      void runManagerCycle(bot);
    }
  }, intervalMs);

  return managerIntervalHandle;
}

module.exports = {
  runManagerCycle,
  startManagerLoop,
  detectActionLoop,
  sanitizeManagerOutput
};
