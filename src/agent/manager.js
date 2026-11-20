const config = require('../infrastructure/config');
const state = require('../core/state');
const invUtils = require('../perception/inventory');
const { scanNearbyEntities, checkTerrainSituation, isBadBlock } = require('../perception/environment');
const { askOllama } = require('./ollama');
const { defaultProcedureMemory, defaultActionRegistry } = require('../actions/dispatcher');
const { getMcData, getBlockNamesForTarget } = require('../minecraft/wikiData');
const { countScaffoldBlocks, findPortalFrameCandidate } = require('../actions/behaviors/world/portal');
const { resolveGoalPlan } = require('../minecraft/knowledge');
const { evaluateObjectiveCoverage, ObjectiveGenerationTracker } = require('../procedures/matcher');
const { generateProcedure } = require('../procedures/generator');
const { registerExperimentalProcedure } = require('../procedures/memory');
const { getDeterministicDecision } = require('./planner');
const { formatBlockedActions, isActionBlocked, buildRemedyDecision } = require('./recovery');
const { getWaypoint, formatWaypoints } = require('../core/progress');

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
  // Repeating a successful action (mining three logs in a row) is progress, not a loop
  const sameActionStruggling = sameAction && recent3.some(item => !item.success);
  if (allFailures || sameActionStruggling) return true;

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
  // Waypoint names ('spawn_bed', 'nether_exit'...) are valid 'goto' targets and must not be truncated
  if (getWaypoint(state, candidate)) return candidate;
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
    if (invUtils.countItem(bot, 'crafting_table') > 0) {
      // Already carrying the portable table: resume the real plan instead of crafting a second one
      const required = invUtils.getQuestRequirement(bot, state, state.currentObjective);
      const nextStep = resolveGoalPlan(bot, state.currentObjective, required, state).nextAction;
      return nextStep
        ? { action: nextStep.action, target: nextStep.target, directive: `Tu portes déjà un établi portable. ${nextStep.reason}` }
        : { action: 'explore', target: 'none', directive: "Tu portes déjà un établi portable : utilise directement 'craft' sur l'objet voulu." };
    }
    const hasLogs = bot.inventory.items().some(i => invUtils.isWoodLog(i.name));
    return hasLogs
      ? { action: 'craft', target: 'planks', directive: "Fabriquer des planches à partir des bûches pour créer un établi." }
      : { action: 'mine', target: 'log', directive: "Couper du bois pour obtenir des planches et un établi." };
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
  } else if (action === 'place' && target === 'crafting_table') {
    // The table is portable and deployed by 'craft' itself: placing it by hand is a wasted cycle
    action = 'craft';
    target = state.currentObjective;
    directive = "L'établi est portable : utilise directement 'craft', il est posé puis récupéré automatiquement.";
    ({ action, target, directive } = sanitizeCraftDecision(bot, target, directive));
  } else if (action === 'goto' && !getWaypoint(state, target)) {
    action = 'explore';
    target = 'none';
    directive = "Point de repère inconnu : explore les environs.";
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
    currentState.managerSubGoal?.action === 'unstuck' ||
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
  const requiredAmount = invUtils.getQuestRequirement(bot, state, state.currentObjective);
  const currentAmount = invUtils.countItem(bot, state.currentObjective);
  const progressSummary = `${currentAmount}/${requiredAmount}`;
  const goalPlan = resolveGoalPlan(bot, state.currentObjective, requiredAmount, state);
  const { isInventoryCluttered } = require('../actions/behaviors/items/storage');
  const cluttered = isInventoryCluttered(bot);
  const nearbyEntities = scanNearbyEntities(bot, 20);
  const entitiesText = Object.keys(nearbyEntities).length > 0 ? JSON.stringify(nearbyEntities) : 'aucune';
  const terrainStatus = checkTerrainSituation(bot);
  const portalOpp = findPortalOpportunity(bot);
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
      - Dimension actuelle : ${bot.game?.dimension || 'overworld'}
      - Opportunité portail détectée : ${portalOpp || 'aucune'}
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
      - ACTIONS REFUSÉES ICI (échecs répétés à cet endroit : ne les suggère PAS, demande d'abord un déplacement avec "explore") : ${formatBlockedActions(state)}
      - Points de repère mémorisés (action "goto") : ${formatWaypoints(bot, state)}
      - Décomposition déterministe des prérequis : ${goalPlan.summary}

      CONSIGNE :
      Définis la prochaine étape logique pour progresser ou te débloquer. Sois direct, clair et réaliste.
      L'établi est portable : "craft" le pose puis le récupère tout seul, ne suggère jamais "place" pour 'crafting_table'.
      RÈGLE ABSOLUE POUR "suggestedTarget" :
      - "suggestedTarget" doit être UNIQUEMENT l'identifiant technique Minecraft (ex: "oak_log", "stone", "chest", "none"), sans espace ni phrase.
      Réponds UNIQUEMENT en JSON :
      {
        "thought": "Diagnostic rapide de la situation",
        "directive": "Consigne impérative et courte pour le joueur",
        "suggestedAction": "mine" | "craft" | "place" | "smelt" | "explore" | "unstuck" | "wiki" | "eat" | "chest" | "equip" | "portal" | "fight" | "hunt" | "procedure" | "goto" | "bed" | "stronghold" | "endportal" | "dragon",
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
      const regReason = regRes?.error || 'Registration failed';
      console.warn(`[MANAGER 🧠] Échec d'enregistrement de procédure pour '${objective}' : ${regReason}`);
      tracker.recordFailure(objective, regReason);
    } else {
      const genReason = genRes?.error || 'Generation failed';
      console.warn(`[MANAGER 🧠] Échec de génération de procédure pour '${objective}' (${genRes?.reason || 'unknown'}) : ${genReason}`);
      tracker.recordFailure(objective, genReason);
    }
  }

  return false;
}

/**
 * Detect whether a Nether portal, sufficient obsidian, or nearby lava source is available
 * @param {object} bot Mineflayer bot instance
 * @returns {'active_portal'|'complete_frame'|'partial_frame_obsidian'|'partial_frame_lava'|'inventory_obsidian'|'lava_pool'|null} Detected portal opportunity or null
 */
function findPortalOpportunity(bot) {
  if (typeof bot.findBlock !== 'function') {
    return invUtils.countItem(bot, 'obsidian') >= 10 ? 'inventory_obsidian' : null;
  }

  const portalId = bot.registry?.blocksByName?.nether_portal?.id;
  if (portalId && bot.findBlock({ matching: portalId, maxDistance: 48 })) {
    return 'active_portal';
  }

  const lavaId = bot.registry?.blocksByName?.lava?.id;
  const isAnyLavaSource = (block) => (
    block.type === lavaId &&
    (!block.metadata || block.metadata === 0) &&
    (!block.position || !isBadBlock(block.position))
  );

  const frame = findPortalFrameCandidate(bot, 48);
  if (frame?.isComplete) {
    return 'complete_frame';
  }
  if (frame && invUtils.countItem(bot, 'obsidian') > 0) {
    return 'partial_frame_obsidian';
  }
  if (frame && lavaId && bot.findBlock({ matching: isAnyLavaSource, maxDistance: 48 })) {
    return 'partial_frame_lava';
  }

  if (invUtils.countItem(bot, 'obsidian') >= 10) {
    return 'inventory_obsidian';
  }

  if (lavaId) {
    const isReachableLavaSource = (block) => (
      isAnyLavaSource(block) &&
      (!bot.entity?.position || !block.position || Math.abs(block.position.y - bot.entity.position.y) <= 10)
    );
    if (typeof bot.findBlocks === 'function') {
      const poolBlocks = bot.findBlocks({
        matching: isReachableLavaSource,
        maxDistance: 24,
        count: 4
      });
      if (Array.isArray(poolBlocks) && poolBlocks.length >= 4) {
        return 'lava_pool';
      }
    } else if (typeof bot.findBlock === 'function') {
      const nearbyLava = bot.findBlock({ matching: isReachableLavaSource, maxDistance: 24 });
      if (nearbyLava) return 'lava_pool';
    }
  }

  return null;
}

/**
 * Assign deterministic pickaxe or prerequisite crafting steps when no pickaxe is carried during Nether progression
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if a pickaxe recovery sub-goal was assigned
 */
function tryAssignPickaxeRecovery(bot) {
  if (invUtils.hasToolType(bot, '_pickaxe') || typeof bot.inventory?.items !== 'function') return false;

  const ironCount = invUtils.countItem(bot, 'iron_ingot');
  const cobbleCount = invUtils.countBestStoneStack(bot);
  if (ironCount < 3 && cobbleCount < 3) return false;

  const items = bot.inventory.items();
  const stickCount = invUtils.countItem(bot, 'stick');
  if (stickCount < 2) {
    const plankCount = items.filter(i => invUtils.isPlanks(i.name)).reduce((s, i) => s + i.count, 0);
    if (plankCount >= 2) {
      state.managerDirective = "Fabrique des bâtons ('stick') pour reconstituer une pioche.";
      state.managerSubGoal = { action: 'craft', target: 'stick', isReliable: true };
      console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: craft)`);
      return true;
    }
    const logCount = items.filter(i => invUtils.isWoodLog(i.name)).reduce((s, i) => s + i.count, 0);
    if (logCount >= 1) {
      state.managerDirective = "Transforme tes bûches en planches ('planks') pour fabriquer une pioche.";
      state.managerSubGoal = { action: 'craft', target: 'planks', isReliable: true };
      console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: craft)`);
      return true;
    }
    return false;
  }

  const pickaxeTarget = ironCount >= 3 ? 'iron_pickaxe' : 'stone_pickaxe';
  // A carried table is as good as a placed one: 'craft' deploys it and takes it back
  if (invUtils.hasCraftingTableAccess(bot, state)) {
    state.managerDirective = `Fabrique une '${pickaxeTarget}' pour creuser vers la lave et miner dans le Nether.`;
    state.managerSubGoal = { action: 'craft', target: pickaxeTarget, isReliable: true };
    console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: craft)`);
    return true;
  }
  return false;
}

/**
 * Gather solid building blocks beside a detected lava pool before attempting portal mold casting
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if a scaffold-gathering mine sub-goal was assigned
 */
function tryAssignMoldScaffoldGathering(bot) {
  const scaffoldCount = countScaffoldBlocks(bot);
  if (scaffoldCount >= 12 || typeof bot.findBlock !== 'function') return false;

  const needed = Math.min(6, 12 - scaffoldCount);
  const candidates = invUtils.hasToolType(bot, '_pickaxe') ? ['dirt', 'stone', 'cobblestone'] : ['dirt'];
  const chosenTarget = candidates.find((candidate) => {
    const blockSet = new Set(getBlockNamesForTarget(bot, candidate));
    return Boolean(bot.findBlock({
      matching: (b) => Boolean(b?.name && blockSet.has(b.name) && (!b.position || !isBadBlock(b.position))),
      maxDistance: 24
    }));
  });
  if (!chosenTarget) return false;

  state.managerDirective = `Lac de lave détecté mais seulement ${scaffoldCount}/12 blocs solides : mine ${needed}x '${chosenTarget}' avant de construire le portail.`;
  state.managerSubGoal = { action: 'mine', target: chosenTarget, qty: needed, isReliable: true };
  console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: mine)`);
  return true;
}

/**
 * Assign a deterministic Manager directive and sub-goal while returning true
 * @param {string} action Skill action name
 * @param {string} target Target identifier
 * @param {string} directive Directive text for player context
 * @param {boolean} [isReliable=true] Whether direct deterministic execution is enabled
 * @param {number} [qty] Optional item quantity
 * @returns {boolean} Always true for concise early-return dispatch
 */
function assignManagerSubGoal(action, target, directive, isReliable = true, qty = undefined) {
  state.managerDirective = directive;
  const subGoal = { action, target, isReliable };
  if (qty !== undefined) subGoal.qty = qty;
  state.managerSubGoal = subGoal;
  console.log(`\n[MANAGER 🧠] Directive mise à jour : "${state.managerDirective}" (action suggérée: ${action})`);
  return true;
}

/**
 * Assign deterministic diamond-mining and diamond_pickaxe crafting steps when portal mold casting falls back to diamond route
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if a diamond fallback sub-goal was assigned
 */
function tryAssignDiamondFallbackGoal(bot) {
  if (!state.useDiamondPortalFallback) return false;
  if (invUtils.countItem(bot, 'obsidian') >= 10) return false;
  if (invUtils.countItem(bot, 'diamond_pickaxe') > 0 || invUtils.countItem(bot, 'netherite_pickaxe') > 0) {
    return false;
  }

  const diamondCount = invUtils.countItem(bot, 'diamond');
  if (diamondCount >= 3) {
    const items = bot.inventory?.items?.() || [];
    const stickCount = invUtils.countItem(bot, 'stick');
    if (stickCount < 2) {
      const plankCount = items.filter(i => invUtils.isPlanks(i.name)).reduce((s, i) => s + i.count, 0);
      if (plankCount >= 2) {
        return assignManagerSubGoal('craft', 'stick', "Fabrique des bâtons ('stick') pour assembler la 'diamond_pickaxe'.", true);
      }
      const logCount = items.filter(i => invUtils.isWoodLog(i.name)).reduce((s, i) => s + i.count, 0);
      if (logCount >= 1) {
        return assignManagerSubGoal('craft', 'planks', "Transforme tes bûches en planches ('planks') pour ta 'diamond_pickaxe'.", true);
      }
      return assignManagerSubGoal('mine', 'log', "Mine une bûche ('log') pour fabriquer les bâtons de ta 'diamond_pickaxe'.", true, 1);
    }
    if (invUtils.findNearbyCraftingTable(bot, state)) {
      return assignManagerSubGoal('craft', 'diamond_pickaxe', "Fabrique une 'diamond_pickaxe' pour miner 10 blocs d'obsidienne.", true);
    }
    if (invUtils.countItem(bot, 'crafting_table') > 0) {
      return assignManagerSubGoal('place', 'crafting_table', "Pose ta 'crafting_table' au sol pour fabriquer la 'diamond_pickaxe'.", true);
    }
    return assignManagerSubGoal('craft', 'crafting_table', "Fabrique une 'crafting_table' pour assembler ta 'diamond_pickaxe'.", true);
  }

  const diamondBlockNames = new Set(getBlockNamesForTarget(bot, 'diamond_ore'));
  const nearbyDiamond = typeof bot.findBlock === 'function'
    ? bot.findBlock({
        matching: (b) => Boolean(b?.name && diamondBlockNames.has(b.name) && (!b.position || !isBadBlock(b.position))),
        maxDistance: 30
      })
    : null;

  if (nearbyDiamond) {
    const needed = 3 - diamondCount;
    return assignManagerSubGoal('mine', 'diamond_ore', `Fallback Diamant actif : mine ${needed}x 'diamond_ore' pour fabriquer une 'diamond_pickaxe'.`, true, needed);
  }

  return assignManagerSubGoal('explore', 'diamond_ore', "Fallback Diamant actif : descends vers Y=-50 et explore pour trouver du 'diamond_ore'.", true);
}

/**
 * Assign deterministic bucket or water acquisition steps when water_bucket is missing during nether_portal
 * @param {object} bot Mineflayer bot instance
 * @param {boolean} lastFailedPortal Whether the previous action was a failed portal attempt
 * @returns {boolean} True if a water-bucket recovery sub-goal was assigned
 */
function tryAssignWaterBucketRecovery(bot, lastFailedPortal) {
  if (invUtils.countItem(bot, 'water_bucket') > 0 || invUtils.countItem(bot, 'obsidian') >= 10) {
    return false;
  }
  const hasEmptyOrLavaBucket = invUtils.countItem(bot, 'bucket') > 0 || invUtils.countItem(bot, 'lava_bucket') > 0;
  if (hasEmptyOrLavaBucket) {
    const waterId = bot.registry?.blocksByName?.water?.id;
    const nearbyWater = waterId && typeof bot.findBlock === 'function'
      ? bot.findBlock({
          matching: (b) => b?.type === waterId && (!b.metadata || b.metadata === 0) && (!b.position || !isBadBlock(b.position)),
          maxDistance: 10
        })
      : null;
    if (nearbyWater && !lastFailedPortal) {
      return assignManagerSubGoal('portal', 'none', "Source d'eau détectée : exécute 'portal' pour remplir ton 'water_bucket'.", true);
    }
    return assignManagerSubGoal('explore', 'water', "Seau d'eau manquant : explore pour trouver une source d'eau ('water') et remplir ton seau.", true);
  }

  const ironCount = invUtils.countItem(bot, 'iron_ingot');
  if (ironCount >= 3) {
    if (invUtils.findNearbyCraftingTable(bot, state)) {
      return assignManagerSubGoal('craft', 'bucket', "Fabrique un seau ('bucket') avec tes 3 lingots de fer.", true);
    }
    if (invUtils.countItem(bot, 'crafting_table') > 0) {
      return assignManagerSubGoal('place', 'crafting_table', "Pose ta 'crafting_table' au sol pour fabriquer un 'bucket'.", true);
    }
  }

  const rawIronCount = invUtils.countItem(bot, 'raw_iron') + invUtils.countItem(bot, 'iron_ore');
  if (ironCount + rawIronCount >= 3 && rawIronCount > 0) {
    const { findTargetFurnace } = require('../actions/behaviors/items/smelt');
    const neededIngots = 3 - ironCount;
    if (findTargetFurnace(bot, state)) {
      const rawTarget = invUtils.countItem(bot, 'raw_iron') > 0 ? 'raw_iron' : 'iron_ore';
      return assignManagerSubGoal('smelt', rawTarget, `Fais fondre ${neededIngots}x '${rawTarget}' pour fabriquer un seau.`, true, neededIngots);
    }
    if (invUtils.countItem(bot, 'furnace') > 0) {
      return assignManagerSubGoal('place', 'furnace', "Pose ton fourneau ('furnace') au sol pour fondre du fer.", true);
    }
    if (invUtils.countItem(bot, 'cobblestone') >= 8 && invUtils.findNearbyCraftingTable(bot, state)) {
      return assignManagerSubGoal('craft', 'furnace', "Fabrique un fourneau ('furnace') pour fondre tes minerais de fer.", true);
    }
  }
  return false;
}

/**
 * Assign deterministic high-priority sub-goals for Nether portal creation and initial Nether mining
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if a deterministic sub-goal was assigned
 */
function tryAssignPortalOrNetherGoal(bot) {
  if (bot.game?.dimension === 'the_nether') {
    const netherHarvestedItems = [
      'netherrack', 'quartz', 'blackstone', 'basalt', 'soul_sand',
      'soul_soil', 'crimson_stem', 'warped_stem', 'nether_wart_block', 'warped_wart_block'
    ];
    const hasNetherBlocks = netherHarvestedItems.some(item => invUtils.countItem(bot, item) > 0);
    if (!hasNetherBlocks && typeof bot.findBlock === 'function') {
      const candidateBlocks = invUtils.hasToolType(bot, '_pickaxe')
        ? ['nether_quartz_ore', 'netherrack', 'blackstone', 'basalt']
        : ['crimson_stem', 'warped_stem', 'soul_sand', 'soul_soil', 'nether_wart_block', 'warped_wart_block', 'gravel'];

      const targetBlock = candidateBlocks.find((blockName) => {
        const blockId = bot.registry?.blocksByName?.[blockName]?.id;
        return Boolean(blockId && bot.findBlock({ matching: blockId, maxDistance: 24 }));
      });

      if (targetBlock) {
        return assignManagerSubGoal('mine', targetBlock, `Dans le Nether : mine '${targetBlock}' immédiatement pour récolter des ressources du Nether.`, true);
      }
    }
    return false;
  }

  if (state.currentObjective !== 'nether_portal') return false;

  if ((state.netherPortalAttempts || 0) >= 3 && state.registeredPortalCoords) {
    return assignManagerSubGoal(
      'portal',
      'none',
      `3 tours sans lac de lave au palier nether_portal : vérification keepInventory=true et téléportation au portail (${state.registeredPortalCoords.x}, ${state.registeredPortalCoords.y}, ${state.registeredPortalCoords.z}).`,
      true
    );
  }

  if (bot.entity?.isInWater) {
    const justRanUnstuck = state.lastActionResult?.action === 'unstuck';
    if (!justRanUnstuck) {
      return assignManagerSubGoal('unstuck', 'none', "Sors de l'eau et rejoins la terre ferme immédiatement.", true);
    }
  }

  if (tryAssignPickaxeRecovery(bot)) {
    return true;
  }

  if (tryAssignDiamondFallbackGoal(bot)) {
    return true;
  }

  const hasDiamondTierPick = invUtils.countItem(bot, 'diamond_pickaxe') > 0 || invUtils.countItem(bot, 'netherite_pickaxe') > 0;
  const obsidianCount = invUtils.countItem(bot, 'obsidian');
  const obsidianId = bot.registry?.blocksByName?.obsidian?.id;
  if (hasDiamondTierPick && obsidianCount < 10 && obsidianId && typeof bot.findBlock === 'function') {
    const nearbyObsidian = bot.findBlock({
      matching: (b) => b?.type === obsidianId && (!b.position || !isBadBlock(b.position)),
      maxDistance: 30
    });
    if (nearbyObsidian) {
      const qty = Math.min(3, 10 - obsidianCount);
      return assignManagerSubGoal(
        'mine',
        'obsidian',
        `[MANAGER] Mine ${qty} obsidian block(s) directly (${obsidianCount}/10).`,
        true,
        qty
      );
    }
  }

  const hasFlintAndSteel = invUtils.countItem(bot, 'flint_and_steel') > 0;
  const hasWaterBucket = invUtils.countItem(bot, 'water_bucket') > 0;
  const hasWaterOrObsidian = hasWaterBucket || invUtils.countItem(bot, 'obsidian') >= 10;
  const portalOpportunity = findPortalOpportunity(bot);
  const lastFailedPortal = state.lastActionResult?.success === false && state.lastActionResult?.action === 'portal';

  if ((portalOpportunity === 'partial_frame_lava' || portalOpportunity === 'lava_pool') && hasFlintAndSteel && hasWaterBucket && countScaffoldBlocks(bot) < 12) {
    return tryAssignMoldScaffoldGathering(bot);
  }

  if (portalOpportunity && !lastFailedPortal) {
    if (portalOpportunity === 'active_portal' || portalOpportunity === 'partial_frame_obsidian') {
      return assignManagerSubGoal('portal', 'none', "Portail détecté à proximité : exécute immédiatement l'action 'portal' pour le compléter ou y entrer.", true);
    }
    if ((portalOpportunity === 'complete_frame' || portalOpportunity === 'inventory_obsidian') && hasFlintAndSteel) {
      return assignManagerSubGoal('portal', 'none', "Cadre de portail prêt : exécute immédiatement l'action 'portal' pour assembler, allumer et entrer dans le Nether.", true);
    }
    if ((portalOpportunity === 'partial_frame_lava' || portalOpportunity === 'lava_pool') && hasFlintAndSteel && hasWaterBucket) {
      return assignManagerSubGoal('portal', 'none', "Portail ou lac de lave détecté : exécute immédiatement l'action 'portal' pour construire, allumer et entrer dans le Nether.", true);
    }
  }

  if (!portalOpportunity) {
    const partialFrame = findPortalFrameCandidate(bot, 48);
    if (partialFrame && !partialFrame.isComplete) {
      console.log(
        `[PORTAL] Début de portail détecté (${partialFrame.presentCount}/10 obsidienne) en (${partialFrame.base.x},${partialFrame.base.y},${partialFrame.base.z}), manque ${partialFrame.missingCount} obsidienne ou de la lave proche.`
      );
    }
    if (hasFlintAndSteel && hasWaterOrObsidian) {
      const isSafeToFastExplore = (
        (bot.health ?? 20) >= 14 &&
        (bot.food ?? 20) >= 12 &&
        Object.keys(scanNearbyEntities(bot, 10)).length === 0 &&
        !(state.lastActionResult?.success === false && state.lastActionResult?.action === 'explore')
      );
      return assignManagerSubGoal('explore', 'lava', "Aucune source de lave proche : explore activement pour trouver un lac de lave ou un portail en ruine.", isSafeToFastExplore);
    }
  }

  if (tryAssignWaterBucketRecovery(bot, lastFailedPortal)) {
    return true;
  }

  if (hasFlintAndSteel && hasWaterOrObsidian && lastFailedPortal) {
    return assignManagerSubGoal('explore', 'lava', "Échec sur le site actuel : explore pour trouver un autre lac de lave.", true);
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

    if (tryAssignPortalOrNetherGoal(bot)) return;

    const memory = state.procedureMemory || defaultProcedureMemory;
    const planned = getDeterministicDecision(bot, state);

    // Generating an experimental procedure costs supervisor inferences: by default it is reserved for objectives
    // the dependency planner cannot handle (ENABLE_PROCEDURE_GENERATION=always restores unconditional generation)
    const generationSetting = process.env.ENABLE_PROCEDURE_GENERATION;
    const generationByDefault = generationSetting === 'always' || (generationSetting !== 'false' && !planned);
    const assigned = await tryAssignProceduralGoal(bot, memory, state.currentObjective, {
      enableProcedureGeneration: deps.enableProcedureGeneration ?? generationByDefault,
      ...deps
    });
    if (assigned) return;

    // The dependency planner already knows the next feasible step: no need to spend a supervisor inference on it
    if (planned) {
      state.managerDirective = planned.thought;
      state.managerSubGoal = { action: planned.action, target: planned.target, qty: planned.qty, isReliable: false, fromPlanner: true };
      return;
    }
    const prompt = buildSupervisorPrompt(bot);
    if (state.metrics) state.metrics.managerLlmCalls += 1;
    const result = await askOllama(prompt, config.OLLAMA_MODEL_MANAGER, 'manager');

    if (result) {
      const validated = sanitizeManagerOutput(bot, result);

      // Never push the player towards an action the failure memory refuses here: it would be intercepted
      // and the player would not understand why. Give the relocation as the directive instead.
      if (isActionBlocked(state, validated.suggestedAction, validated.suggestedTarget, Date.now(), bot)) {
        const remedy = buildRemedyDecision(bot, state, { action: validated.suggestedAction, target: validated.suggestedTarget });
        if (remedy) {
          validated.directive = remedy.thought;
          validated.suggestedAction = remedy.action;
          validated.suggestedTarget = remedy.target;
          validated.isReliable = false;
        }
      }

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
  sanitizeProcedureDecision,
  findPortalOpportunity,
  tryAssignPortalOrNetherGoal
};
