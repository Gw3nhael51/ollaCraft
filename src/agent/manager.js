const config = require('../infrastructure/config');
const state = require('../core/state');
const invUtils = require('../perception/inventory');
const { scanNearbyEntities } = require('../perception/environment');
const { askOllama } = require('./ollama');
const { defaultProcedureMemory } = require('../actions/dispatcher');

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
 * Resolve exact craftable item name when requested target or plank variant is available
 * @param {string} target Requested craft target
 * @param {string[]} available Available craft entries
 * @returns {string|null} Resolved target name or null
 */
function resolveAvailableCraftTarget(target, available) {
  if (available.includes(target)) return target;
  if (!invUtils.isPlanks(target)) return null;
  return available.find(item => invUtils.isPlanks(item) && item !== 'planks') || (available.some(item => invUtils.isPlanks(item)) ? target : null);
}

/**
 * Sanitize target identifier string to ensure it is a valid single Minecraft identifier
 * @param {string} rawTarget Raw target string from LLM response
 * @returns {string} Sanitized clean target identifier
 */
function cleanTargetIdentifier(rawTarget) {
  if (typeof rawTarget !== 'string') return 'none';
  const trimmed = rawTarget.trim();
  if (!trimmed) return 'none';
  const match = trimmed.match(/^[a-z0-9_-]+/i);
  if (!match) return 'none';
  const candidate = match[0].toLowerCase();
  return candidate.length <= 64 ? candidate : 'none';
}

/**
 * Search and select the best procedure matching a quest or crafting objective
 * @param {object} memory ProcedureMemory instance
 * @param {string} objective Target objective identifier
 * @param {object} [options={}] Filtering options
 * @param {boolean} [options.onlyValidated=false] Whether to strictly require validated status
 * @returns {{ procedure: object, isReliable: boolean }|null} Selected procedure with reliability flag
 */
function selectProcedureForObjective(memory, objective, options = {}) {
  if (!memory || typeof memory.getAll !== 'function' || !objective) {
    return null;
  }

  const procedures = memory.getAll();
  if (!Array.isArray(procedures) || procedures.length === 0) {
    return null;
  }

  const cleanObjective = String(objective).toLowerCase().trim();

  const matching = procedures.filter(proc => {
    if (!proc || proc.status === 'deprecated') return false;

    const tags = Array.isArray(proc.metadata?.tags) ? proc.metadata.tags.map(t => String(t).toLowerCase()) : [];
    const id = String(proc.id || '').toLowerCase();
    const name = String(proc.name || '').toLowerCase();

    const matchesTag = tags.includes(cleanObjective);
    const matchesId = id === cleanObjective ||
      id === `obtain_${cleanObjective}` ||
      id === `craft_${cleanObjective}` ||
      id === `mine_${cleanObjective}` ||
      id.includes(cleanObjective);
    const matchesName = name.includes(cleanObjective);

    return matchesTag || matchesId || matchesName;
  });

  if (matching.length === 0) {
    return null;
  }

  const validated = matching.filter(p => p.status === 'validated');
  if (validated.length > 0) {
    validated.sort((a, b) => {
      const confA = a.metadata?.confidenceScore !== undefined ? a.metadata.confidenceScore : 0.5;
      const confB = b.metadata?.confidenceScore !== undefined ? b.metadata.confidenceScore : 0.5;
      if (confA !== confB) return confB - confA;
      return (b.metadata?.executionCount || 0) - (a.metadata?.executionCount || 0);
    });
    const selected = validated[0];
    const knowledge = typeof memory.getKnowledge === 'function' ? memory.getKnowledge(cleanObjective) : null;
    return {
      procedure: selected,
      isReliable: true,
      knowledge
    };
  }

  if (options.onlyValidated) {
    return null;
  }

  const experimental = matching.filter(p => p.status === 'experimental');
  if (experimental.length > 0) {
    experimental.sort((a, b) => {
      const confA = a.metadata?.confidenceScore !== undefined ? a.metadata.confidenceScore : 0.5;
      const confB = b.metadata?.confidenceScore !== undefined ? b.metadata.confidenceScore : 0.5;
      return confB - confA;
    });
    const selected = experimental[0];
    const knowledge = typeof memory.getKnowledge === 'function' ? memory.getKnowledge(cleanObjective) : null;
    return {
      procedure: selected,
      isReliable: false,
      knowledge
    };
  }

  return null;
}

/**
 * Validate and sanitize a procedure suggestion from supervisor output
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Suggested procedure identifier
 * @param {string} directive Current directive message
 * @param {object} [memory=null] Optional procedure memory instance
 * @returns {{ action: string, target: string, directive: string, isReliable: boolean }}
 */
function sanitizeProcedureDecision(bot, target, directive, memory = null) {
  const activeMemory = memory || state.procedureMemory || defaultProcedureMemory;
  const procedure = activeMemory.get(target);

  if (!procedure || procedure.status === 'deprecated') {
    return {
      action: 'explore',
      target: 'none',
      directive: `Procédure '${target}' introuvable ou dépréciée, exploration recommandée.`,
      isReliable: false
    };
  }

  if (procedure.status === 'experimental') {
    return {
      action: 'procedure',
      target: procedure.id,
      directive: directive || `Tester la procédure expérimentale '${procedure.id}' (non garantie).`,
      isReliable: false
    };
  }

  return {
    action: 'procedure',
    target: procedure.id,
    directive: directive || `Exécuter la procédure validée '${procedure.id}'.`,
    isReliable: true
  };
}

/**
 * Validate and adjust a craft suggestion according to inventory and nearby crafting table
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Suggested craft target
 * @param {string} directive Current directive message
 * @returns {{ action: string, target: string, directive: string }}
 */
function sanitizeCraftDecision(bot, target, directive) {
  const table = invUtils.findNearbyCraftingTable(bot, state);
  const available = invUtils.getAvailableCrafts(bot, table);

  const craftableTarget = resolveAvailableCraftTarget(target, available);
  if (craftableTarget) {
    return { action: 'craft', target: craftableTarget, directive };
  }

  if (target === 'crafting_table') {
    const hasLogs = bot.inventory.items().some(i => invUtils.isWoodLog(i.name));
    return hasLogs
      ? { action: 'craft', target: 'planks', directive: "Fabriquer des planches à partir des bûches pour créer un établi." }
      : { action: 'mine', target: 'log', directive: "Couper du bois pour obtenir des planches et un établi." };
  }

  if (!table && invUtils.countItem(bot, 'crafting_table') > 0) {
    return { action: 'place', target: 'crafting_table', directive: `Poser l'établi au sol pour pouvoir fabriquer ${target}.` };
  }

  const needsOnlyTable = available.some(entry => entry.startsWith(`${target} (`));
  if (needsOnlyTable && available.includes('crafting_table')) {
    return { action: 'craft', target: 'crafting_table', directive: `Fabriquer un établi ('crafting_table') pour assembler ${target}.` };
  }

  return { action: 'explore', target, directive: `Ressources manquantes pour fabriquer ${target}, explorer pour trouver des composants.` };
}

/**
 * Validate and adjust a smelt suggestion according to available furnace and ores
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Suggested smelt target
 * @param {string} directive Current directive message
 * @returns {{ action: string, target: string, directive: string }}
 */
function sanitizeSmeltDecision(bot, target, directive) {
  if (target === 'furnace') {
    const hasFurnace = invUtils.countItem(bot, 'furnace') > 0;
    return {
      action: hasFurnace ? 'place' : 'craft',
      target: 'furnace',
      directive: hasFurnace ? "Poser le fourneau au sol pour fondre les minerais." : "Fabriquer un fourneau à l'établi pour fondre les minerais."
    };
  }

  if (target === 'iron_ingot') {
    const hasOre = invUtils.countItem(bot, 'raw_iron') > 0 || invUtils.countItem(bot, 'iron_ore') > 0;
    if (!hasOre) {
      return { action: 'mine', target: 'iron_ore', directive: "Miner du minerai de fer avant de pouvoir fabriquer des lingots." };
    }
    return { action: 'smelt', target, directive };
  }

  if (invUtils.countItem(bot, target) === 0) {
    return { action: 'mine', target, directive: `Miner la ressource requise avant de pouvoir faire fondre ${target}.` };
  }

  return { action: 'smelt', target, directive };
}

/**
 * Validate and adjust a chest storage suggestion according to nearby or owned chest
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Suggested target
 * @param {string} directive Current directive message
 * @returns {{ action: string, target: string, directive: string }}
 */
function sanitizeChestDecision(bot, target, directive) {
  const chestId = bot.registry.blocksByName['chest']?.id;
  const nearbyChest = chestId ? bot.findBlock({ matching: chestId, maxDistance: 24 }) : null;
  if (nearbyChest) {
    return { action: 'chest', target, directive };
  }

  if (invUtils.countItem(bot, 'chest') > 0) {
    return { action: 'place', target: 'chest', directive: "Poser le coffre ('chest') au sol avant de pouvoir y ranger les surplus." };
  }

  return { action: 'craft', target: 'chest', directive: "Fabriquer un coffre ('chest') pour pouvoir trier et vider l'inventaire." };
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
      suggestedTarget: "none",
      isReliable: false
    };
  }

  let action = config.VALID_ACTIONS.has(rawDecision.suggestedAction) ? rawDecision.suggestedAction : 'explore';
  let target = cleanTargetIdentifier(rawDecision.suggestedTarget);
  let directive = rawDecision.directive || "Poursuivre l'objectif en cours.";
  let isReliable = false;

  if (action === 'chest') {
    ({ action, target, directive } = sanitizeChestDecision(bot, target, directive));
  } else if (action === 'craft') {
    ({ action, target, directive } = sanitizeCraftDecision(bot, target, directive));
  } else if (action === 'smelt') {
    ({ action, target, directive } = sanitizeSmeltDecision(bot, target, directive));
  } else if (action === 'procedure') {
    const procRes = sanitizeProcedureDecision(bot, target, directive);
    action = procRes.action;
    target = procRes.target;
    directive = procRes.directive;
    isReliable = procRes.isReliable;
  } else if (action === 'wiki' && target === 'none') {
    target = state.currentObjective;
  }

  return { directive, suggestedAction: action, suggestedTarget: target, isReliable };
}

const MANAGER_HEARTBEAT_INTERVAL = 3;

/**
 * Determine whether the supervisor model needs to be consulted after a player cycle
 * @param {object} bot Mineflayer bot instance
 * @param {object} currentState Global bot state
 * @param {boolean} [objectiveChanged] True if currentObjective changed during the cycle
 * @returns {boolean} True if manager cycle should run
 */
function shouldRunManager(bot, currentState = state, objectiveChanged = false) {
  if (objectiveChanged || !currentState.managerSubGoal) return true;
  if (currentState.lastActionResult && !currentState.lastActionResult.success) return true;
  if (detectActionLoop(currentState.actionHistory || [])) return true;

  const { isInventoryCluttered } = require('../actions/behaviors/items/storage');
  if (isInventoryCluttered(bot)) return true;

  return (currentState.cyclesSinceLastManager || 0) + 1 >= MANAGER_HEARTBEAT_INTERVAL;
}

/**
 * Execute supervisor reasoning cycle to steer the autonomous player
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<void>}
 */
async function runManagerCycle(bot) {
  if (!state.isSurviving || state.isManagerThinking) return;

  state.isManagerThinking = true;
  state.cyclesSinceLastManager = 0;
  try {
    invUtils.syncObjective(bot, state);

    const memory = state.procedureMemory || defaultProcedureMemory;
    const match = selectProcedureForObjective(memory, state.currentObjective, { onlyValidated: true });

    if (match && match.procedure && match.isReliable) {
      state.managerDirective = `Exécuter la procédure validée '${match.procedure.id}' pour l'objectif '${state.currentObjective}'.`;
      state.managerSubGoal = {
        action: 'procedure',
        target: match.procedure.id,
        isReliable: true,
        procedureId: match.procedure.id
      };
      console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: procedure)`);
      return;
    }

    const tools = invUtils.getOwnedTools(bot).join(', ') || 'aucun';
    const inventory = invUtils.getInventorySummary(bot);
    const loopDetected = detectActionLoop(state.actionHistory);
    const recentHistory = JSON.stringify(state.actionHistory.slice(-4));
    const requiredAmount = config.QUEST_AMOUNT[state.currentObjective] || 1;
    const currentAmount = invUtils.countItem(bot, state.currentObjective);
    const progressSummary = `${currentAmount}/${requiredAmount}`;
    const { isInventoryCluttered } = require('../actions/behaviors/items/storage');
    const cluttered = isInventoryCluttered(bot);
    const nearbyEntities = scanNearbyEntities(bot, 20);
    const entitiesText = Object.keys(nearbyEntities).length > 0 ? JSON.stringify(nearbyEntities) : 'aucune';

    const prompt = `
      Tu es le Manager Stratège du bot Minecraft.
      Ton rôle est de superviser le joueur, éviter qu'il boucle, et lui fixer une priorité claire.

      SITUATION ACTUELLE :
      - Objectif final : '${state.currentObjective}' (Progression actuelle : ${progressSummary}${currentAmount >= requiredAmount ? ' - PALIER ATTEINT' : ''})
      - Quantité requise pour valider ce palier : ${requiredAmount} (possédé : ${currentAmount})
      - IMPORTANT : Ne demande PAS au joueur d'arrêter tant que le palier (${requiredAmount}) n'est pas atteint !
      - Outils possédés : ${tools}
      - Inventaire : ${inventory}
      - Entités/Créatures proches : ${entitiesText}
      - Encombrement de l'inventaire : ${cluttered ? 'OUI (ATTENTION : inventaire saturé de blocs en surplus, suggère de fabriquer/poser un coffre ou utiliser "chest")' : 'NON'}
      - Santé : ${Math.round(bot.health)}/20 | Faim : ${Math.round(bot.food)}/20
      - Historique des actions récentes : ${recentHistory}
      - Blocage ou boucle détectée : ${loopDetected ? 'OUI (ATTENTION : le joueur échoue ou répète la même action)' : 'NON'}

      CONSIGNE :
      Définis la prochaine étape logique pour progresser ou te débloquer. Sois direct, clair et réaliste.
      RÈGLE ABSOLUE POUR "suggestedTarget" :
      - "suggestedTarget" doit être UNIQUEMENT l'identifiant technique Minecraft (ex: "oak_log", "stone", "chest", "none"), sans espace ni phrase.
      Réponds UNIQUEMENT en JSON :
      {
        "thought": "Diagnostic rapide de la situation",
        "directive": "Consigne impérative et courte pour le joueur",
        "suggestedAction": "mine" | "craft" | "place" | "smelt" | "explore" | "unstuck" | "wiki" | "eat" | "chest" | "equip" | "portal" | "fight" | "hunt" | "procedure",
        "suggestedTarget": "nom_cible_strict"
      }
    `;

    const result = await askOllama(prompt, config.OLLAMA_MODEL_MANAGER, 'manager');

    if (result) {
      const validated = sanitizeManagerOutput(bot, result);
      state.managerDirective = validated.directive;
      state.managerSubGoal = {
        action: validated.suggestedAction,
        target: validated.suggestedTarget,
        isReliable: validated.isReliable
      };
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
  return runManagerCycle(bot);
}

module.exports = {
  runManagerCycle,
  startManagerLoop,
  shouldRunManager,
  detectActionLoop,
  sanitizeManagerOutput,
  cleanTargetIdentifier,
  selectProcedureForObjective,
  sanitizeProcedureDecision
};
