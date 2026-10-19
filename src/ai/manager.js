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

  // Detect consecutive failures or identical repeated actions
  const recent3 = actionHistory.slice(-3);
  const allFailures = recent3.every(item => !item.success);
  const sameAction = recent3.every(item => item.action === recent3[0].action && item.target === recent3[0].target);
  if (allFailures || sameAction) return true;

  if (actionHistory.length >= 4) {
    const r4 = actionHistory.slice(-4);
    // Detect alternating action ping-pong loop
    const isPingPong = (
      r4[0].action === r4[2].action &&
      r4[0].target === r4[2].target &&
      r4[1].action === r4[3].action &&
      r4[1].target === r4[3].target
    );
    if (isPingPong) return true;

    // Detect repeated attempts on the same target with failures
    const sameTargetCount = r4.filter(item => item.target === r4[3].target && r4[3].target !== 'none').length;
    const hasFailure = r4.some(item => !item.success);
    if (sameTargetCount >= 3 && hasFailure) return true;
  }

  return false;
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

    // Accept planks if any wood variety is craftable
    const isPlankRequested = invUtils.isPlanks(target);
    const hasAvailablePlanks = available.some(item => invUtils.isPlanks(item));
    const isCraftPossible = available.includes(target) || (isPlankRequested && hasAvailablePlanks);

    if (!isCraftPossible) {
      if (target === 'crafting_table') {
        const hasLogs = bot.inventory.items().some(i => invUtils.isWoodLog(i.name));
        if (hasLogs) {
          action = 'craft';
          target = 'planks';
          directive = "Fabriquer des planches à partir des bûches pour créer un établi.";
        } else {
          action = 'mine';
          target = 'log';
          directive = "Couper du bois pour obtenir des planches et un établi.";
        }
      } else {
        const hasTableInPocket = invUtils.countItem(bot, 'crafting_table') > 0;
        if (!table && hasTableInPocket) {
          action = 'place';
          target = 'crafting_table';
          directive = `Poser l'établi au sol pour pouvoir fabriquer ${target}.`;
        } else {
          action = 'explore';
          directive = `Ressources manquantes pour fabriquer ${target}, explorer pour trouver des composants.`;
        }
      }
    } else if (isPlankRequested && !available.includes(target)) {
      // Target the specific wood plank variety directly craftable
      const specificPlank = available.find(item => invUtils.isPlanks(item) && item !== 'planks');
      if (specificPlank) {
        target = specificPlank;
      }
    }
  }

  // Adjust smelt action according to targeted resource
  if (action === 'smelt') {
    if (target === 'furnace') {
      const hasFurnace = invUtils.countItem(bot, 'furnace') > 0;
      action = hasFurnace ? 'place' : 'craft';
      directive = hasFurnace ? "Poser le fourneau au sol pour fondre les minerais." : "Fabriquer un fourneau à l'établi pour fondre les minerais.";
    } else if (target === 'iron_ingot') {
      const hasOre = invUtils.countItem(bot, 'raw_iron') > 0 || invUtils.countItem(bot, 'iron_ore') > 0;
      if (!hasOre) {
        action = 'mine';
        target = 'iron_ore';
        directive = "Miner du minerai de fer avant de pouvoir fabriquer des lingots.";
      }
    } else if (invUtils.countItem(bot, target) === 0) {
      action = 'mine';
      directive = `Miner la ressource requise avant de pouvoir faire fondre ${target}.`;
    }
  }

  return { directive, suggestedAction: action, suggestedTarget: target };
}

/**
 * Execute supervisor reasoning cycle to steer the autonomous player
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
    const requiredAmount = config.QUEST_AMOUNT[state.currentObjective] || 1;
    const currentAmount = invUtils.countItem(bot, state.currentObjective);
    const progressSummary = `${currentAmount}/${requiredAmount}`;

    const prompt = `
      Tu es le Manager Stratège du bot Minecraft.
      Ton rôle est de superviser le joueur, éviter qu'il boucle, et lui fixer une priorité claire.

      SITUATION ACTUELLE :
      - Objectif final : '${state.currentObjective}' (Progression actuelle : ${progressSummary}${currentAmount >= requiredAmount ? ' - PALIER ATTEINT' : ''})
      - Quantité requise pour valider ce palier : ${requiredAmount} (possédé : ${currentAmount})
      - IMPORTANT : Ne demande PAS au joueur d'arrêter tant que le palier (${requiredAmount}) n'est pas atteint !
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

    const result = await askOllama(prompt, config.OLLAMA_MODEL_MANAGER, 'manager');

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

/**
 * Run initial supervisor reasoning cycle synchronously
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<void>}
 */
async function startManagerLoop(bot) {
  // Trigger initial supervisor reasoning pass
  return runManagerCycle(bot);
}

module.exports = {
  runManagerCycle,
  startManagerLoop,
  detectActionLoop,
  sanitizeManagerOutput
};
