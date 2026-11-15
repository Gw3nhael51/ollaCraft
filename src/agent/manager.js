const config = require('../infrastructure/config');
const state = require('../core/state');
const invUtils = require('../perception/inventory');
const { scanNearbyEntities } = require('../perception/environment');
const { askOllama } = require('./ollama');
const { defaultProcedureMemory } = require('../actions/dispatcher');
const { getMcData } = require('../minecraft/wikiData');

/**
 * Détecter si le bot est bloqué dans une boucle d'actions ou une série d'échecs consécutifs
 * @param {Array<object>} actionHistory Historique récent des actions exécutées par le joueur
 * @returns {boolean} Vrai si une boucle ou une répétition d'échecs est détectée
 */
function detectActionLoop(actionHistory) {
  if (actionHistory.length < 3) return false;

  const recent3 = actionHistory.slice(-3);
  const allFailures = recent3.every(item => !item.success);
  const sameAction = recent3.every(item => item.action === recent3[0].action && item.target === recent3[0].target);
  if (allFailures || sameAction) return true;

  if (actionHistory.length >= 4) {
    const r4 = actionHistory.slice(-4);
    const isPingPong = (
      r4[0].action === r4[2].action &&
      r4[0].target === r4[2].target &&
      r4[1].action === r4[3].action &&
      r4[1].target === r4[3].target
    );
    if (isPingPong) return true;

    const sameTargetCount = r4.filter(item => item.target === r4[3].target && r4[3].target !== 'none').length;
    const hasFailure = r4.some(item => !item.success);
    if (sameTargetCount >= 3 && hasFailure) return true;
  }

  return false;
}

/**
 * Résoudre le nom exact de l'item fabricable lorsque la cible ou une variante de planche est disponible
 * @param {string} target Cible de fabrication demandée
 * @param {string[]} available Liste des fabrications disponibles
 * @returns {string|null} Nom de la cible résolue ou null
 */
function resolveAvailableCraftTarget(target, available) {
  if (available.includes(target)) return target;
  if (!invUtils.isPlanks(target)) return null;
  const specificPlank = available.find(item => invUtils.isPlanks(item) && item !== 'planks');
  if (specificPlank) return specificPlank;
  return available.some(item => invUtils.isPlanks(item)) ? target : null;
}

/**
 * Vérifier si un identifiant correspond à un élément connu du registre Minecraft
 * @param {string} name Identifiant candidat en minuscules
 * @returns {boolean} Vrai si l'identifiant est un bloc, un item, une entité ou un alias générique
 */
function isKnownMinecraftIdentifier(name) {
  if (name === 'planks' || name === 'log') return true;
  const mcData = getMcData(null);
  return Boolean(
    mcData.itemsByName?.[name] ||
    mcData.blocksByName?.[name] ||
    mcData.entitiesByName?.[name]
  );
}

/**
 * Nettoyer l'identifiant de cible brut pour garantir un identifiant Minecraft unique et valide
 * @param {string} rawTarget Chaîne de cible brute issue de la réponse LLM
 * @returns {string} Identifiant de cible nettoyé
 */
function cleanTargetIdentifier(rawTarget) {
  if (typeof rawTarget !== 'string') return 'none';
  const trimmed = rawTarget.trim();
  if (!trimmed) return 'none';
  const match = /^[a-z0-9_-]+/i.exec(trimmed);
  if (!match) return 'none';
  const candidate = match[0].toLowerCase();
  if (candidate.length > 64) return 'none';

  const activeMemory = state.procedureMemory || defaultProcedureMemory;
  if (activeMemory?.get?.(candidate)) return candidate;
  if (isKnownMinecraftIdentifier(candidate)) return candidate;

  const parts = candidate.split('_').filter(Boolean);
  for (let len = Math.min(parts.length - 1, 4); len >= 1; len--) {
    const prefix = parts.slice(0, len).join('_');
    if (isKnownMinecraftIdentifier(prefix)) return prefix;
  }

  return candidate;
}

/**
 * Vérifier si une procédure correspond à un objectif donné par son identifiant, son nom ou ses tags
 * @param {object} proc Objet procédure à tester
 * @param {string} cleanObjective Objectif normalisé en minuscules
 * @returns {boolean} Vrai si la procédure couvre l'objectif
 */
function doesProcedureMatchObjective(proc, cleanObjective) {
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
}

/**
 * Trier une liste de procédures par score de confiance décroissant puis par nombre d'exécutions
 * @param {Array<object>} list Liste de procédures à trier
 * @returns {Array<object>} Liste triée
 */
function sortProceduresByConfidence(list) {
  return [...list].sort((a, b) => {
    const confA = a.metadata?.confidenceScore === undefined ? 0.5 : a.metadata.confidenceScore;
    const confB = b.metadata?.confidenceScore === undefined ? 0.5 : b.metadata.confidenceScore;
    if (confA !== confB) return confB - confA;
    return (b.metadata?.executionCount || 0) - (a.metadata?.executionCount || 0);
  });
}

/**
 * Rechercher et sélectionner la meilleure procédure correspondant à un objectif de quête ou de fabrication
 * @param {object} memory Instance de ProcedureMemory
 * @param {string} objective Identifiant de l'objectif cible
 * @param {object} [options={}] Options de filtrage
 * @param {boolean} [options.onlyValidated=false] Exiger strictement le statut validé
 * @returns {{ procedure: object, isReliable: boolean, knowledge: object|null }|null} Procédure sélectionnée et fiabilité
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
  const matching = procedures.filter(proc => doesProcedureMatchObjective(proc, cleanObjective));
  if (matching.length === 0) {
    return null;
  }

  const knowledge = typeof memory.getKnowledge === 'function' ? memory.getKnowledge(cleanObjective) : null;
  const validated = sortProceduresByConfidence(matching.filter(p => p.status === 'validated'));
  if (validated.length > 0) {
    return {
      procedure: validated[0],
      isReliable: true,
      knowledge
    };
  }

  if (options.onlyValidated) {
    return null;
  }

  const experimental = sortProceduresByConfidence(matching.filter(p => p.status === 'experimental'));
  if (experimental.length > 0) {
    return {
      procedure: experimental[0],
      isReliable: false,
      knowledge
    };
  }

  return null;
}

/**
 * Valider et assainir une suggestion de procédure issue de la sortie du superviseur
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} target Identifiant de la procédure suggérée
 * @param {string} directive Message de directive actuel
 * @param {object} [memory=null] Instance optionnelle de mémoire procédurale
 * @returns {{ action: string, target: string, directive: string, isReliable: boolean }} Décision procédurale validée
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
 * Valider et ajuster une suggestion de fabrication selon l'inventaire et l'établi à proximité
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} target Cible de fabrication suggérée
 * @param {string} directive Message de directive actuel
 * @returns {{ action: string, target: string, directive: string }} Décision de fabrication ajustée
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
 * Valider et ajuster une suggestion de cuisson selon la présence d'un fourneau et des minerais
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} target Cible de cuisson suggérée
 * @param {string} directive Message de directive actuel
 * @returns {{ action: string, target: string, directive: string }} Décision de cuisson ajustée
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
 * Valider et ajuster une suggestion de rangement selon les coffres proches ou possédés
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} target Cible suggérée
 * @param {string} directive Message de directive actuel
 * @returns {{ action: string, target: string, directive: string }} Décision de coffre ajustée
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
 * Assainir et valider les directives du Manager par rapport à l'état du jeu pour éviter les hallucinations
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} rawDecision Sortie JSON brute issue du modèle superviseur
 * @returns {object} Directive validée et sous-objectif associé
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
 * Déterminer si le modèle superviseur doit être consulté après un cycle du joueur
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} [currentState=state] État global du bot
 * @param {boolean} [objectiveChanged=false] Vrai si l'objectif a changé durant le cycle
 * @returns {boolean} Vrai si le cycle Manager doit s'exécuter
 */
function shouldRunManager(bot, currentState = state, objectiveChanged = false) {
  const { isInventoryCluttered } = require('../actions/behaviors/items/storage');
  const hasFailedAction = Boolean(currentState.lastActionResult && !currentState.lastActionResult.success);
  const hasReachedHeartbeat = (currentState.cyclesSinceLastManager || 0) + 1 >= MANAGER_HEARTBEAT_INTERVAL;

  return Boolean(
    objectiveChanged ||
    !currentState.managerSubGoal ||
    hasFailedAction ||
    detectActionLoop(currentState.actionHistory || []) ||
    isInventoryCluttered(bot) ||
    hasReachedHeartbeat
  );
}

/**
 * Construire le prompt de supervision stratégique envoyé au modèle Manager
 * @param {object} bot Instance du bot Mineflayer
 * @returns {string} Prompt formaté pour Ollama
 */
function buildSupervisorPrompt(bot) {
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
  const stageReachedSuffix = currentAmount >= requiredAmount ? ' - PALIER ATTEINT' : '';
  const clutteredNotice = cluttered
    ? 'OUI (ATTENTION : inventaire saturé de blocs en surplus, suggère de fabriquer/poser un coffre ou utiliser "chest")'
    : 'NON';
  const loopNotice = loopDetected
    ? 'OUI (ATTENTION : le joueur échoue ou répète la même action)'
    : 'NON';

  return `
      Tu es le Manager Stratège du bot Minecraft.
      Ton rôle est de superviser le joueur, éviter qu'il boucle, et lui fixer une priorité claire.

      SITUATION ACTUELLE :
      - Objectif final : '${state.currentObjective}' (Progression actuelle : ${progressSummary}${stageReachedSuffix})
      - Quantité requise pour valider ce palier : ${requiredAmount} (possédé : ${currentAmount})
      - IMPORTANT : Ne demande PAS au joueur d'arrêter tant que le palier (${requiredAmount}) n'est pas atteint !
      - Outils possédés : ${tools}
      - Inventaire : ${inventory}
      - Entités/Créatures proches : ${entitiesText}
      - Encombrement de l'inventaire : ${clutteredNotice}
      - Santé : ${Math.round(bot.health)}/20 | Faim : ${Math.round(bot.food)}/20
      - Historique des actions récentes : ${recentHistory}
      - Blocage ou boucle détectée : ${loopNotice}

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
}

/**
 * Exécuter un cycle de raisonnement du superviseur pour orienter le joueur autonome
 * @param {object} bot Instance du bot Mineflayer
 * @returns {Promise<void>} Promesse résolue à la fin du cycle de supervision
 */
async function runManagerCycle(bot) {
  if (!state.isSurviving || state.isManagerThinking) return;

  state.isManagerThinking = true;
  state.cyclesSinceLastManager = 0;
  try {
    invUtils.syncObjective(bot, state);

    const memory = state.procedureMemory || defaultProcedureMemory;
    const match = selectProcedureForObjective(memory, state.currentObjective, { onlyValidated: true });

    if (match?.procedure && match.isReliable) {
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

    const prompt = buildSupervisorPrompt(bot);
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
 * Lancer le premier cycle de raisonnement du superviseur au démarrage
 * @param {object} bot Instance du bot Mineflayer
 * @returns {Promise<void>} Promesse résolue après l'initialisation
 */
async function startManagerLoop(bot) {
  return runManagerCycle(bot);
}

module.exports = {
  runManagerCycle,
  startManagerLoop,
  shouldRunManager,
  sanitizeManagerOutput,
  detectActionLoop,
  cleanTargetIdentifier,
  selectProcedureForObjective,
  sanitizeProcedureDecision
};
