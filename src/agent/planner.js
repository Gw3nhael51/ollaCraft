const config = require('../infrastructure/config');
const invUtils = require('../perception/inventory');
const { checkTerrainSituation, isBadBlock, isBlockSubmerged, isInFloodedZone, isBelowSurface } = require('../perception/environment');
const { resolveGoalPlan } = require('../minecraft/knowledge');
const { getBlockNamesForTarget, canHarvestBlock } = require('../minecraft/wikiData');
const { getDimension, getWaypoint, saveWaypoint, horizontalDistanceTo, isInsideProtectedSpawn } = require('../core/progress');
const { isActionBlocked, getFailureEntry, buildRemedyDecision, MAX_REMEDY_ROUNDS } = require('./recovery');
const { findHuntTarget } = require('../actions/behaviors/combat/combat');

// Returned by a stage rule to hand the decision over to the Manager rules or the LLM
const DEFER = Symbol('defer');

const CLEAR_TERRAIN = 'Terrain libre.';
const LIQUID_TARGETS = new Set(['water', 'lava']);
// Objectives that are plain crafts and can be completed in any dimension
const CRAFT_ANYWHERE_OBJECTIVES = new Set(['blaze_powder', 'ender_eye']);
const FORTRESS_BLOCKS = ['spawner', 'nether_bricks', 'nether_brick_fence'];
const UNSAFE_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit']);
// Underground, a log higher than this above the feet is on the surface behind rock: climbing out beats pathing to it
const UNDERGROUND_WOOD_MAX_RISE = 6;

/**
 * Build a decision object in the format executed by the ReAct loop
 * @param {string} action Action name
 * @param {string} target Action target
 * @param {number} qty Quantity
 * @param {string} thought Explanation logged as the bot's reasoning
 * @returns {object} Deterministic decision
 */
function makeDecision(action, target, qty, thought) {
  return {
    thought,
    action,
    target: target || 'none',
    qty: Math.max(1, Math.min(64, Math.round(qty) || 1)),
    source: 'plan'
  };
}

/**
 * Read the terrain situation without ever throwing on partial world data
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Terrain description
 */
function readTerrain(bot) {
  try {
    return checkTerrainSituation(bot);
  } catch {
    return CLEAR_TERRAIN;
  }
}

/**
 * Find the nearest living entity of a given type
 * @param {object} bot Mineflayer bot instance
 * @param {string} name Entity type name
 * @param {number} [maxDistance=28] Search radius
 * @returns {object|null} Nearest matching entity or null
 */
function findNearestEntity(bot, name, maxDistance = 28) {
  const origin = bot?.entity?.position;
  if (!origin || !bot.entities || typeof origin.distanceTo !== 'function') return null;

  let nearest = null;
  let best = maxDistance;
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity || entity.name !== name || entity.isValid === false || !entity.position) continue;
    const distance = origin.distanceTo(entity.position);
    if (distance <= best) {
      best = distance;
      nearest = entity;
    }
  }
  return nearest;
}

/**
 * Check whether a block yielding the wanted resource is loaded within reach and not blacklisted
 * @param {object} bot Mineflayer bot instance
 * @param {string} targetName Resource or block name
 * @param {number} [maxDistance=30] Search radius
 * @param {boolean} [allowSubmerged=false] Accept blocks under water or in a flooded area (liquids themselves)
 * @param {Function|null} [accept=null] Extra condition on the block position
 * @returns {boolean} True if such a block exists nearby
 */
function isBlockNearby(bot, targetName, maxDistance = 30, allowSubmerged = false, accept = null) {
  if (typeof bot.findBlock !== 'function') return false;
  const names = new Set(getBlockNamesForTarget(bot, targetName));
  return Boolean(bot.findBlock({
    matching: (block) => {
      if (!block?.name || !names.has(block.name)) return false;
      if (!block.position) return true;
      if (isBadBlock(block.position)) return false;
      if (accept && !accept(block)) return false;
      // A block the bot would have to dive for does not count: it looks for a dry one elsewhere
      return allowSubmerged || !(isBlockSubmerged(bot, block) || isInFloodedZone(block.position));
    },
    maxDistance
  }));
}

/**
 * Decide how to get wood: chop a tree in reach, otherwise go find one, climbing out of the mine first when underground.
 * From the bottom of a mine a tree "within 30 blocks" stands on the surface far above, behind solid rock.
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Wood target ('log' or a specific log)
 * @param {number} qty Number of logs wanted
 * @param {string} reason Explanation logged when a tree is in reach
 * @returns {object} Mine or explore decision
 */
function decideWoodGathering(bot, target, qty, reason) {
  const feetY = bot.entity?.position?.y ?? 0;
  const underground = getDimension(bot) === 'overworld' && isBelowSurface(bot);
  // Underground, only a log at about the bot's own level is worth walking to (a tree at the mouth of the cave)
  const withinReach = underground ? (block) => Math.abs(block.position.y - feetY) <= UNDERGROUND_WOOD_MAX_RISE : null;
  if (isBlockNearby(bot, target, 30, false, withinReach)) {
    return makeDecision('mine', target, Math.min(qty, 3), reason);
  }
  if (underground) {
    return makeDecision('explore', target, 1, `Sous terre (Y:${Math.round(feetY)}) : aucun arbre ici, je remonte à la surface pour chercher du bois.`);
  }
  return makeDecision('explore', target, 1, `Aucun '${target}' chargé à portée : exploration ciblée.`);
}

/**
 * Check whether the bot carries something safe to eat
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if edible food is available
 */
function hasEdibleFood(bot) {
  const foods = bot.registry?.foodsByName;
  if (!foods) return false;
  return invUtils.getCarriedItems(bot).some(item => foods[item.name] && !UNSAFE_FOODS.has(item.name));
}

/**
 * Check whether the bot carries furnace fuel
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if fuel is available
 */
function hasFuel(bot) {
  return invUtils.getCarriedItems(bot).some(item => (
    item.name === 'coal' || item.name === 'charcoal' || item.name.includes('log') || item.name.includes('planks')
  ));
}

/**
 * Reflexes that never need a model: get out of water or holes, eat before starving
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {object|null} Reflex decision or null
 */
function getSurvivalReflex(bot, state) {
  const dimension = getDimension(bot);
  const now = Date.now();
  if (dimension !== 'the_end') {
    const terrain = readTerrain(bot);
    // Running out of air is an emergency even when the surroundings do not look like a trap
    const lowOnAir = (bot.oxygenLevel ?? 20) <= 12 && Boolean(bot.entity?.isInWater);
    if ((terrain !== CLEAR_TERRAIN || lowOnAir) && !isActionBlocked(state, 'unstuck', 'none', now, bot)) {
      return makeDecision('unstuck', 'none', 1, `Réflexe de survie : ${lowOnAir ? "je manque d'air, je remonte à la surface" : terrain}`);
    }
  }
  if ((bot.food ?? 20) <= 8 && hasEdibleFood(bot) && !isActionBlocked(state, 'eat', 'none', now, bot)) {
    return makeDecision('eat', 'none', 1, `Réflexe de survie : faim à ${Math.round(bot.food)}/20, je mange.`);
  }
  return null;
}

/**
 * Locate a Nether fortress from loaded chunks or from memory, memorizing it as a waypoint
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {{ distance: number }|null} Distance to the fortress or null when unknown
 */
function locateFortress(bot, state) {
  const known = getWaypoint(state, 'fortress');
  if (typeof bot.findBlock === 'function') {
    const ids = FORTRESS_BLOCKS.map(name => bot.registry?.blocksByName?.[name]?.id).filter(Boolean);
    const found = ids.length > 0 ? bot.findBlock({ matching: ids, maxDistance: 96 }) : null;
    if (found?.position) {
      const farFromKnown = !known || Math.hypot(known.x - found.position.x, known.z - found.position.z) > 48;
      if (farFromKnown) saveWaypoint(state, 'fortress', found.position, 'the_nether', 'Nether fortress');
      return { distance: horizontalDistanceTo(bot, getWaypoint(state, 'fortress')) };
    }
  }
  if (known && known.dimension === 'the_nether') {
    return { distance: horizontalDistanceTo(bot, known) };
  }
  return null;
}

/**
 * Decide what to do in the Nether: hunt blazes for the rods, otherwise go back to the Overworld
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} objective Current objective
 * @returns {object|undefined} Decision, or undefined to let the dependency plan decide
 */
function getNetherDecision(bot, state, objective) {
  if (objective === 'blaze_rod') {
    if (findNearestEntity(bot, 'blaze', 28)) {
      return makeDecision('fight', 'blaze', 1, 'Blaze en vue : combat pour obtenir des blaze_rod.');
    }
    const fortress = locateFortress(bot, state);
    if (fortress && fortress.distance > 10) {
      return makeDecision('goto', 'fortress', 1, `Forteresse du Nether repérée à ${Math.round(fortress.distance)} blocs : je m'y rends.`);
    }
    return makeDecision('explore', 'fortress', 1, fortress
      ? 'Dans la forteresse : je patrouille pour faire apparaître des blazes.'
      : 'Aucune forteresse en vue : exploration du Nether.');
  }

  if (CRAFT_ANYWHERE_OBJECTIVES.has(objective)) return undefined;

  if (objective === 'ender_pearl') {
    if (findNearestEntity(bot, 'enderman', 28)) {
      return makeDecision('fight', 'enderman', 1, 'Enderman en vue : combat pour obtenir une ender_pearl.');
    }
    if (isBlockNearby(bot, 'warped_nylium', 48)) {
      return makeDecision('explore', 'enderman', 1, 'Forêt biscornue proche : les endermen y sont nombreux, je la parcours.');
    }
  }

  return makeDecision('portal', 'overworld', 1, `L'objectif '${objective}' se poursuit dans l'Overworld : retour par le portail du Nether.`);
}

/**
 * Decide the late-game and logistics steps of the Overworld that no recipe describes
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} objective Current objective
 * @returns {object|symbol|undefined} Decision, DEFER, or undefined to let the dependency plan decide
 */
function getOverworldDecision(bot, state, objective) {
  if (objective === 'ender_dragon' || objective === 'end_portal') {
    return makeDecision('endportal', 'none', 1, "Trouver la salle du portail, poser le lit, remplir le cadre d'yeux et entrer dans l'End.");
  }

  if (objective === 'stronghold') {
    return makeDecision('stronghold', 'none', 1, 'Localiser le stronghold : deux lancers d\'œil depuis deux positions, triangulation, puis trajet.');
  }

  if (objective === 'end_bed') {
    const spawnBed = getWaypoint(state, 'spawn_bed');
    const bedDistance = spawnBed && spawnBed.dimension === 'overworld' ? horizontalDistanceTo(bot, spawnBed) : Infinity;
    if (bedDistance <= 96 && invUtils.countItem(bot, 'bed') === 0) {
      // Reusing the bed left by the Nether portal is far cheaper than hunting sheep again
      return bedDistance > 12
        ? makeDecision('goto', 'spawn_bed', 1, `Mon lit est à ${Math.round(bedDistance)} blocs : je vais le chercher pour l'emporter au stronghold.`)
        : makeDecision('bed', 'pickup', 1, "Je récupère le lit posé près du portail du Nether pour l'emporter au stronghold.");
    }
    return undefined;
  }

  if (objective === 'nether_portal') {
    const portalId = bot.registry?.blocksByName?.nether_portal?.id;
    const activePortal = portalId && typeof bot.findBlock === 'function'
      ? bot.findBlock({ matching: portalId, maxDistance: 48 })
      : null;
    if (activePortal) return DEFER;

    // After a death the bot respawns away from its portal: walk back instead of building a new one
    const portalWaypoint = getWaypoint(state, 'nether_portal');
    if (portalWaypoint && portalWaypoint.dimension === 'overworld') {
      const distance = horizontalDistanceTo(bot, portalWaypoint);
      if (distance > 40) {
        return makeDecision('goto', 'nether_portal', 1, `Portail du Nether mémorisé à ${Math.round(distance)} blocs : j'y retourne.`);
      }
    }
    return DEFER;
  }

  if (objective === 'ender_pearl') {
    if (findNearestEntity(bot, 'enderman', 32)) {
      return makeDecision('fight', 'enderman', 1, 'Enderman en vue : combat pour obtenir une ender_pearl.');
    }
    return makeDecision('explore', 'enderman', 1, 'Aucun enderman en vue : exploration (ils apparaissent surtout la nuit).');
  }

  return undefined;
}

/**
 * Apply the rules tied to the current stage of the run rather than to a recipe
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {object|symbol|undefined} Decision, DEFER, or undefined when the stage has no opinion
 */
function getStageDecision(bot, state) {
  const objective = state.currentObjective;
  if (!objective) return undefined;

  const dimension = getDimension(bot);
  if (dimension === 'the_end') {
    return makeDecision('dragon', 'none', 1, "Dans l'End : détruire les cristaux puis vaincre l'Ender Dragon.");
  }
  if (dimension === 'the_nether') {
    return getNetherDecision(bot, state, objective);
  }
  return getOverworldDecision(bot, state, objective);
}

/**
 * Turn the next step of the dependency plan into something feasible right now
 * @param {object} bot Mineflayer bot instance
 * @param {{ action: string, target: string, qty: number, reason: string }} step Next plan step
 * @returns {object|symbol|null} Decision, DEFER, or null when the model should decide
 */
function adaptPlanStep(bot, step) {
  switch (step.action) {
    case 'craft':
      return makeDecision('craft', step.target, step.qty, step.reason);

    case 'place':
      return invUtils.countItem(bot, step.target) > 0 ? makeDecision('place', step.target, 1, step.reason) : null;

    case 'smelt':
      if (!hasFuel(bot)) {
        return decideWoodGathering(bot, 'log', 2, 'Aucun combustible pour le four : je coupe du bois.');
      }
      return makeDecision('smelt', step.target, step.qty, step.reason);

    case 'mine': {
      if (LIQUID_TARGETS.has(step.target)) {
        return isBlockNearby(bot, step.target, 36, true)
          ? makeDecision('mine', step.target, 1, step.reason)
          : makeDecision('explore', step.target, 1, `Aucune source de '${step.target}' à portée : exploration.`);
      }
      if (invUtils.isWoodLog(step.target)) {
        return decideWoodGathering(bot, step.target, step.qty, step.reason);
      }
      if (!canHarvestBlock(bot, step.target).canHarvest) return null;
      if (isBlockNearby(bot, step.target)) {
        return makeDecision('mine', step.target, Math.min(step.qty, 3), step.reason);
      }
      return makeDecision('explore', step.target, 1, `Aucun '${step.target}' chargé à portée : exploration ciblée.`);
    }

    case 'hunt':
      // Same filter as the hunt skill: lambs, sheared sheep and animals found unreachable do not count
      return findHuntTarget(bot, step.target)
        ? makeDecision('hunt', step.target, 1, step.reason)
        : makeDecision('explore', step.target, 1, `Aucun '${step.target}' chassable en vue : exploration pour trouver un autre troupeau.`);

    case 'fight':
      return findNearestEntity(bot, step.target)
        ? makeDecision(step.action, step.target, 1, step.reason)
        : makeDecision('explore', step.target, 1, `Aucun '${step.target}' en vue : exploration.`);

    case 'stronghold':
    case 'endportal':
    case 'dragon':
      return makeDecision(step.action, 'none', 1, step.reason);

    case 'portal':
      return DEFER;

    default:
      return null;
  }
}

/**
 * Follow the dependency plan of the current objective
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {object|symbol|null} Decision, DEFER, or null when no deterministic step exists
 */
function getPlanDecision(bot, state) {
  const objective = state.currentObjective;
  if (!objective) return null;

  const required = invUtils.getQuestRequirement(bot, state, objective);
  const plan = resolveGoalPlan(bot, objective, required, state);
  return plan.nextAction ? adaptPlanStep(bot, plan.nextAction) : null;
}

/**
 * Handle a step that keeps failing where the bot stands: relocate and retry it, without any model call.
 * Only a step that failed in several different places is handed over to the model.
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {object} decision Step the planner wants to run
 * @returns {object|null} The step itself, a relocation remedy, or null when the model must find another approach
 */
function resolveRefusedStep(bot, state, decision) {
  // The dragon fight has no alternative and must never be replaced by wandering in the End
  if (decision.action === 'dragon') return decision;
  if (!isActionBlocked(state, decision.action, decision.target, Date.now(), bot)) return decision;

  const entry = getFailureEntry(state, decision.action, decision.target);
  if ((entry?.rounds || 0) > MAX_REMEDY_ROUNDS) return null;
  return buildRemedyDecision(bot, state, decision);
}

/**
 * Return a decision that must run before anything else: survival reflexes and stage logistics
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {{ decision: object|null, deferred: boolean }} Priority decision and whether the stage handed over
 */
function getPriorityDecision(bot, state) {
  if (!config.DETERMINISTIC_PLANNER) return { decision: null, deferred: false };

  try {
    const reflex = getSurvivalReflex(bot, state);
    if (reflex) return { decision: reflex, deferred: false };

    // Just out of a flooded cave or mine: do not go back in, look for another area
    if (getDimension(bot) === 'overworld' && isInFloodedZone(bot.entity?.position) &&
      !isActionBlocked(state, 'explore', 'relocate', Date.now(), bot)) {
      return {
        decision: makeDecision('explore', 'relocate', 1, "Cette zone est inondée : je m'en éloigne pour chercher ailleurs."),
        deferred: false
      };
    }

    // Inside the protected spawn area nothing can be placed or broken: get out before trying to build anything
    if (isInsideProtectedSpawn(bot, state) && !isActionBlocked(state, 'explore', 'leave_spawn', Date.now(), bot)) {
      return {
        decision: makeDecision('explore', 'leave_spawn', 1, "Zone de spawn protégée (le serveur y refuse la pose et la casse de blocs) : je m'en éloigne avant de construire."),
        deferred: false
      };
    }

    const stage = getStageDecision(bot, state);
    if (stage === DEFER) return { decision: null, deferred: true };
    if (!stage) return { decision: null, deferred: false };

    const resolved = resolveRefusedStep(bot, state, stage);
    return { decision: resolved, deferred: !resolved };
  } catch (error) {
    console.warn('[PLANNER] Stage evaluation failed:', error.message);
    return { decision: null, deferred: true };
  }
}

/**
 * Return the next step of the dependency plan, or a relocation when that step keeps failing here
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {object|null} Plan decision or null when the model should decide
 */
function getPlannedDecision(bot, state) {
  if (!config.DETERMINISTIC_PLANNER) return null;

  try {
    const planned = getPlanDecision(bot, state);
    if (!planned || planned === DEFER) return null;
    return resolveRefusedStep(bot, state, planned);
  } catch (error) {
    console.warn('[PLANNER] Plan evaluation failed:', error.message);
    return null;
  }
}

/**
 * Decide the next action without any model call whenever the situation leaves no real choice
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {object|null} Deterministic decision or null when the model must be consulted
 */
function getDeterministicDecision(bot, state) {
  const priority = getPriorityDecision(bot, state);
  if (priority.decision) return priority.decision;
  if (priority.deferred) return null;
  return getPlannedDecision(bot, state);
}

module.exports = {
  DEFER,
  getDeterministicDecision,
  getPriorityDecision,
  getPlannedDecision,
  getSurvivalReflex,
  getStageDecision,
  getPlanDecision,
  adaptPlanStep,
  findNearestEntity,
  isBlockNearby
};
