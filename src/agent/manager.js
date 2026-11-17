const config = require('../infrastructure/config');
const state = require('../core/state');
const invUtils = require('../perception/inventory');
const { scanNearbyEntities, checkTerrainSituation } = require('../perception/environment');
const { askOllama } = require('./ollama');
const { defaultProcedureMemory, defaultActionRegistry } = require('../actions/dispatcher');
const { getMcData } = require('../minecraft/wikiData');
const { resolveGoalPlan } = require('../minecraft/knowledge');
const { evaluateObjectiveCoverage, ObjectiveGenerationTracker } = require('../procedures/matcher');
const { generateProcedure } = require('../procedures/generator');
const { registerExperimentalProcedure } = require('../procedures/memory');

/**
 * Detect whether the bot is stuck in an action loop or consecutive failure streak
 * @param {Array<object>} actionHistory Recent player action execution history
 * @returns {boolean} True if a loop or repeated failure pattern is detected
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
 * Resolve the exact craftable item name when the target or a plank variant is available
 * @param {string} target Requested craft target
 * @param {string[]} available List of available craftable items
 * @returns {string|null} Resolved target name or null
 */
function resolveAvailableCraftTarget(target, available) {
  if (available.includes(target)) return target;
  if (!invUtils.isPlanks(target)) return null;
  const specificPlank = available.find(item => invUtils.isPlanks(item) && item !== 'planks');
  if (specificPlank) return specificPlank;
  return available.some(item => invUtils.isPlanks(item)) ? target : null;
}

/**
 * Check whether an identifier matches a known Minecraft registry entry
 * @param {string} name Candidate identifier in lowercase
 * @returns {boolean} True if the identifier is a block, item, entity, or generic alias
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
 * Sanitize raw target identifier from LLM output into a valid Minecraft identifier
 * @param {string} rawTarget Raw target string from LLM response
 * @returns {string} Sanitized target identifier
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
 * Check whether a procedure matches a given objective by id, name, or tags
 * @param {object} proc Procedure object to evaluate
 * @param {string} cleanObjective Normalized lowercase objective
 * @returns {boolean} True if the procedure covers the objective
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
 * Sort procedures by descending confidence score and execution count
 * @param {Array<object>} list List of procedures to sort
 * @returns {Array<object>} Sorted list
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
 * Search and select the best procedure matching a quest or crafting objective
 * @param {object} memory ProcedureMemory instance
 * @param {string} objective Target objective identifier
 * @param {object} [options={}] Filtering options
 * @param {boolean} [options.onlyValidated=false] Strictly require validated status
 * @returns {{ procedure: object, isReliable: boolean, knowledge: object|null }|null} Selected procedure and reliability
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
 * Validate and sanitize a procedure suggestion from supervisor output
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Suggested procedure identifier
 * @param {string} directive Current directive message
 * @param {object} [memory=null] Optional procedure memory instance
 * @returns {{ action: string, target: string, directive: string, isReliable: boolean }} Validated procedural decision
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
 * Validate and adjust a crafting suggestion based on inventory and nearby crafting table
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Suggested crafting target
 * @param {string} directive Current directive message
 * @returns {{ action: string, target: string, directive: string }} Adjusted crafting decision
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

  const goalPlan = resolveGoalPlan(bot, target, 1, state);
  if (goalPlan.nextAction && goalPlan.nextAction.action !== 'explore') {
    return {
      action: goalPlan.nextAction.action,
      target: goalPlan.nextAction.target,
      directive: goalPlan.nextAction.reason
    };
  }

  return { action: 'explore', target, directive: `Ressources manquantes pour fabriquer ${target}, explorer pour trouver des composants.` };
}

/**
 * Validate and adjust a smelting suggestion based on furnace availability and ores
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Suggested smelting target
 * @param {string} directive Current directive message
 * @returns {{ action: string, target: string, directive: string }} Adjusted smelting decision
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
  } else if (invUtils.countItem(bot, target) === 0) {
    return { action: 'mine', target, directive: `Miner la ressource requise avant de pouvoir faire fondre ${target}.` };
  }

  const { findTargetFurnace } = require('../actions/behaviors/items/smelt');
  if (!findTargetFurnace(bot, state)) {
    if (invUtils.countItem(bot, 'furnace') > 0) {
      return { action: 'place', target: 'furnace', directive: "Aucun fourneau accessible : pose ton fourneau au sol." };
    }
    if (invUtils.countItem(bot, 'cobblestone') >= 8) {
      return { action: 'craft', target: 'furnace', directive: "Aucun fourneau accessible : fabrique un nouveau fourneau à proximité." };
    }
  }

  return { action: 'smelt', target, directive };
}

/**
 * Validate and adjust a storage suggestion based on nearby or carried chests
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Suggested target
 * @param {string} directive Current directive message
 * @returns {{ action: string, target: string, directive: string }} Adjusted chest decision
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
 * Sanitize and validate Manager directives against game state to prevent hallucinations
 * @param {object} bot Mineflayer bot instance
 * @param {object} rawDecision Raw JSON output from supervisor model
 * @returns {object} Validated directive and associated sub-goal
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
  } else if (action === 'unstuck' && checkTerrainSituation(bot) === 'Terrain libre.') {
    action = 'explore';
    target = 'none';
    directive = "Terrain déjà libre : explore les environs pour trouver une ressource accessible.";
  }

  return { directive, suggestedAction: action, suggestedTarget: target, isReliable };
}

const MANAGER_HEARTBEAT_INTERVAL = 3;

/**
 * Determine whether the supervisor model should be consulted after a player cycle
 * @param {object} bot Mineflayer bot instance
 * @param {object} [currentState=state] Global bot state
 * @param {boolean} [objectiveChanged=false] True if objective changed during the cycle
 * @returns {boolean} True if the Manager cycle should run
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
 * Build the strategic supervision prompt sent to the Manager model
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Formatted prompt for Ollama
 */
function buildSupervisorPrompt(bot) {
  const tools = invUtils.getOwnedTools(bot).join(', ') || 'aucun';
  const inventory = invUtils.getInventorySummary(bot);
  const loopDetected = detectActionLoop(state.actionHistory);
  const recentHistory = JSON.stringify(state.actionHistory.slice(-4));
  const requiredAmount = config.QUEST_AMOUNT[state.currentObjective] || 1;
  const currentAmount = invUtils.countItem(bot, state.currentObjective);
  const progressSummary = `${currentAmount}/${requiredAmount}`;
  const goalPlan = resolveGoalPlan(bot, state.currentObjective, requiredAmount, state);
  const { isInventoryCluttered } = require('../actions/behaviors/items/storage');
  const cluttered = isInventoryCluttered(bot);
  const nearbyEntities = scanNearbyEntities(bot, 20);
  const entitiesText = Object.keys(nearbyEntities).length > 0 ? JSON.stringify(nearbyEntities) : 'aucune';
  const terrainStatus = checkTerrainSituation(bot);
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
      - État du terrain : ${terrainStatus}
      - Historique des actions récentes : ${recentHistory}
      - Blocage ou boucle détectée : ${loopNotice}
      - Décomposition déterministe des prérequis : ${goalPlan.summary}

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
 * Attempt to select an experimental procedure or generate a new one for an uncovered objective
 * @param {object} bot Mineflayer bot instance
 * @param {object} memory ProcedureMemory instance
 * @param {string} objective Current objective
 * @param {object} [deps={}] Injectable dependencies for generation
 * @returns {Promise<boolean>} True if a procedural sub-goal was assigned
 */
async function tryAssignProceduralGoal(bot, memory, objective, deps = {}) {
  const tracker = state.generationTracker || new ObjectiveGenerationTracker();
  if (!state.generationTracker) state.generationTracker = tracker;

  const coverage = evaluateObjectiveCoverage(memory, objective, tracker);
  const lastActionFailedOnProc = Boolean(
    state.lastActionResult?.success === false &&
    state.lastActionResult.action === 'procedure' &&
    state.lastActionResult.target === coverage.procedure?.id
  );

  if (coverage.status === 'validated_available' && coverage.procedure && !lastActionFailedOnProc) {
    state.managerDirective = `Exécuter la procédure validée '${coverage.procedure.id}' pour l'objectif '${objective}'.`;
    state.managerSubGoal = {
      action: 'procedure',
      target: coverage.procedure.id,
      isReliable: true,
      procedureId: coverage.procedure.id
    };
    console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: procedure)`);
    return true;
  }

  if (coverage.status === 'experimental_available' && coverage.procedure && !lastActionFailedOnProc) {
    state.managerDirective = `Tester la procédure expérimentale '${coverage.procedure.id}' pour l'objectif '${objective}' (évaluation requise).`;
    state.managerSubGoal = {
      action: 'procedure',
      target: coverage.procedure.id,
      isReliable: false,
      procedureId: coverage.procedure.id
    };
    console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: procedure)`);
    return true;
  }

  if (coverage.status === 'eligible_for_generation' && deps.enableProcedureGeneration === true) {
    const generateFn = deps.generateProcedureFn || generateProcedure;
    const registry = deps.actionRegistry || defaultActionRegistry;
    const knowledgePlan = resolveGoalPlan(bot, objective, config.QUEST_AMOUNT[objective] || 1, state);
    tracker.recordAttempt(objective);

    const genRes = await generateFn({
      objective,
      context: {
        inventory: bot.inventory?.items?.() || [],
        knowledgePlan
      },
      registry,
      existingProcedures: memory.getAll(),
      askOllamaFn: deps.askOllamaFn
    });

    if (genRes?.success && genRes.data?.procedure) {
      const regRes = await registerExperimentalProcedure(memory, genRes.data.procedure, {
        registry,
        storageDir: memory.storageDir,
        generationMetadata: genRes.data.generationMetadata
      });

      if (regRes?.success && regRes.data?.procedure) {
        const createdProc = regRes.data.procedure;
        state.managerDirective = `Tester la nouvelle procédure expérimentale '${createdProc.id}' pour '${objective}'.`;
        state.managerSubGoal = {
          action: 'procedure',
          target: createdProc.id,
          isReliable: false,
          procedureId: createdProc.id
        };
        console.log(`\n[MANAGER 🧠] Procédure expérimentale générée : "${createdProc.id}" (action suggérée: procedure)`);
        return true;
      }
      tracker.recordFailure(objective, regRes?.error || 'Registration failed');
    } else {
      tracker.recordFailure(objective, genRes?.error || 'Generation failed');
    }
  }

  return false;
}

/**
 * Run a supervisor reasoning cycle to guide the autonomous player
 * @param {object} bot Mineflayer bot instance
 * @param {object} [deps={}] Optional dependencies (generation, Ollama)
 * @returns {Promise<void>} Promise resolved at end of supervision cycle
 */
async function runManagerCycle(bot, deps = {}) {
  if (!state.isSurviving || state.isManagerThinking) return;

  state.isManagerThinking = true;
  state.cyclesSinceLastManager = 0;
  try {
    invUtils.syncObjective(bot, state);

    const memory = state.procedureMemory || defaultProcedureMemory;
    const assigned = await tryAssignProceduralGoal(bot, memory, state.currentObjective, {
      enableProcedureGeneration: deps.enableProcedureGeneration ?? Boolean(deps.generateProcedureFn || deps.askOllamaFn),
      ...deps
    });
    if (assigned) return;

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
 * Launch the first supervisor reasoning cycle at startup
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<void>} Promise resolved after initialization
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
