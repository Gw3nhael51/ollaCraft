const { Vec3 } = require('vec3');
const config = require('../../../infrastructure/config');
const { countItem, countBestPlankStack, findBedItem, getBestWoolStack, isBed } = require('../../../perception/inventory');
const {
  getDimension, getWaypoint, saveWaypoint, removeWaypoint, setMilestone, hasMilestone, horizontalDistanceTo
} = require('../../../core/progress');
const { isAirBlock, isSolidGround, approachPosition, digWithTimeout, pickUpDroppedItem } = require('../blocks/placement');
const { skillCraft } = require('../items/craft');

const SPAWN_SET_PATTERN = /respawn point set|spawn point set|point de réapparition/i;
const BED_SEARCH_OFFSETS = [-3, -2, -1, 0, 1, 2, 3];

/**
 * Find a flat two-block spot where a bed fits, with its head pointing away from the bot
 * @param {object} bot Mineflayer bot instance
 * @returns {{ ground: object, foot: Vec3, head: Vec3 }|null} Placement description or null
 */
function findBedPlacement(bot) {
  const origin = bot.entity.position.floored();
  let best = null;

  for (const dy of [0, -1, 1]) {
    for (const dx of BED_SEARCH_OFFSETS) {
      for (const dz of BED_SEARCH_OFFSETS) {
        // The bed extends along the direction the bot faces: only clearly axis-aligned spots are unambiguous
        if (Math.abs(dx) === Math.abs(dz)) continue;
        const reach = Math.max(Math.abs(dx), Math.abs(dz));
        if (reach < 2) continue;

        const direction = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz));
        const foot = origin.offset(dx, dy, dz);
        const head = foot.plus(direction);
        const ground = bot.blockAt(foot.offset(0, -1, 0));
        const headGround = bot.blockAt(head.offset(0, -1, 0));

        const fits = isSolidGround(ground) && isSolidGround(headGround) &&
          isAirBlock(bot.blockAt(foot)) && isAirBlock(bot.blockAt(head)) &&
          isAirBlock(bot.blockAt(foot.offset(0, 1, 0))) && isAirBlock(bot.blockAt(head.offset(0, 1, 0)));
        if (!fits) continue;

        const score = reach + Math.abs(dy) * 2 + Math.min(Math.abs(dx), Math.abs(dz));
        if (!best || score < best.score) {
          best = { ground: ground.position ? ground : { ...ground, position: foot.offset(0, -1, 0) }, foot, head, score };
        }
      }
    }
  }

  return best ? { ground: best.ground, foot: best.foot, head: best.head } : null;
}

/**
 * Locate a bed block around a position
 * @param {object} bot Mineflayer bot instance
 * @param {object} pos Search center
 * @param {number} [range=3] Search radius
 * @returns {object|null} Bed block or null
 */
function findBedBlockNear(bot, pos, range = 3) {
  if (typeof bot.findBlock !== 'function') return null;
  return bot.findBlock({
    matching: (block) => Boolean(block?.name && block.name.endsWith('_bed')),
    maxDistance: range,
    point: pos
  });
}

/**
 * Wait for the server message confirming that the respawn point changed
 * @param {object} bot Mineflayer bot instance
 * @param {number} [timeoutMs=2500] Maximum wait
 * @returns {Promise<boolean>} True if the confirmation was received
 */
function waitForSpawnConfirmation(bot, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (typeof bot.on !== 'function' || typeof bot.removeListener !== 'function') {
      resolve(false);
      return;
    }
    let timer = null;
    const onMessage = (message) => {
      if (!SPAWN_SET_PATTERN.test(String(message))) return;
      clearTimeout(timer);
      bot.removeListener('messagestr', onMessage);
      resolve(true);
    };
    timer = setTimeout(() => {
      bot.removeListener('messagestr', onMessage);
      resolve(false);
    }, timeoutMs);
    bot.on('messagestr', onMessage);
  });
}

/**
 * Use a bed to register the respawn point. Vanilla sets it on interaction, even by day or with monsters around
 * @param {object} bot Mineflayer bot instance
 * @param {object} bedBlock Bed block to use
 * @returns {Promise<boolean>} True if the server confirmed the new respawn point
 */
async function activateBedForSpawn(bot, bedBlock) {
  const confirmation = waitForSpawnConfirmation(bot);
  await bot.lookAt(bedBlock.position.offset(0.5, 0.5, 0.5), true);
  await bot.activateBlock(bedBlock);
  const confirmed = await confirmation;

  // At night the interaction also puts the bot to sleep: get back up, only the respawn point matters
  if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(10);
  if (bot.isSleeping && typeof bot.wake === 'function') {
    await bot.wake().catch(() => {});
  }
  return confirmed;
}

/**
 * Make sure a respawn point exists here: reuse a nearby spawn bed, otherwise craft/place a bed and use it
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} [waypointName='spawn_bed'] Waypoint recording the bed ('spawn_bed' or 'end_spawn_bed')
 * @param {object} [options={}] Options
 * @param {number} [options.reuseRange=48] Distance within which an existing spawn bed is good enough
 * @param {boolean} [options.acceptRemote=false] Accept a farther existing spawn bed when no bed can be placed
 * @returns {Promise<{ success: boolean, placed: boolean, message: string }>} Outcome
 */
async function ensureSpawnBed(bot, state, waypointName = 'spawn_bed', options = {}) {
  if (!config.REQUIRE_SPAWN_BED) {
    return { success: true, placed: false, message: 'Spawn bed not required by configuration.' };
  }
  if (getDimension(bot) !== 'overworld') {
    return { success: false, placed: false, message: 'Beds explode outside the Overworld: set the spawn point before leaving.' };
  }

  const existing = getWaypoint(state, waypointName);
  const reuseRange = options.reuseRange ?? 48;
  if (existing && horizontalDistanceTo(bot, existing) <= reuseRange) {
    const blockThere = bot.blockAt(new Vec3(existing.x, existing.y, existing.z));
    if (!blockThere || isBed(blockThere.name)) {
      return { success: true, placed: false, message: `Spawn point already set at the bed (${existing.x}, ${existing.y}, ${existing.z}).` };
    }
    removeWaypoint(state, waypointName);
  }

  let bedItem = findBedItem(bot);
  const wool = getBestWoolStack(bot);
  // Like the wool, the three planks must be of a single wood type
  const plankCount = countBestPlankStack(bot);
  if (!bedItem && (wool?.count || 0) >= 3 && plankCount >= 3) {
    const craftRes = await skillCraft(bot, state, 'bed', 1);
    if (!craftRes.success) {
      return { success: false, placed: false, message: `Could not craft the spawn bed : ${craftRes.message}` };
    }
    bedItem = findBedItem(bot);
  }

  if (!bedItem) {
    const remote = getWaypoint(state, waypointName);
    if (options.acceptRemote && remote) {
      return {
        success: true,
        placed: false,
        message: `No bed to place here; keeping the spawn bed ${Math.round(horizontalDistanceTo(bot, remote))} blocks away.`
      };
    }
    return {
      success: false,
      placed: false,
      message: `A bed is required to set the spawn point (wool ${wool?.count || 0}/3 of one color, planks ${plankCount}/3). Hunt sheep ('hunt' target 'sheep') then 'craft' target 'bed'.`
    };
  }

  const placement = findBedPlacement(bot);
  if (!placement) {
    return { success: false, placed: false, message: 'No flat two-block space nearby to place the bed. Move to open ground and retry.' };
  }

  try {
    await bot.equip(bedItem, 'hand');
    await bot.lookAt(placement.ground.position.offset(0.5, 1, 0.5), true);
    await bot.placeBlock(placement.ground, new Vec3(0, 1, 0));
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(4);

    const placedAtFoot = bot.blockAt(placement.foot);
    const bedBlock = isBed(placedAtFoot?.name)
      ? (placedAtFoot.position ? placedAtFoot : { ...placedAtFoot, position: placement.foot })
      : findBedBlockNear(bot, placement.foot, 3);
    if (!bedBlock) {
      return { success: false, placed: false, message: 'Bed placement was not confirmed by the server.' };
    }

    const confirmed = await activateBedForSpawn(bot, bedBlock);
    saveWaypoint(state, waypointName, bedBlock.position, 'overworld', 'spawn bed');
    setMilestone(state, 'active_spawn', waypointName);
    const where = `(${bedBlock.position.x}, ${bedBlock.position.y}, ${bedBlock.position.z})`;
    console.log(`[BED] Spawn bed placed at ${where}${confirmed ? ', respawn point confirmed' : ', no confirmation message seen'}.`);
    return {
      success: true,
      placed: true,
      message: `Bed placed and spawn point set at ${where}${confirmed ? '' : ' (no server confirmation message seen)'}.`
    };
  } catch (error) {
    return { success: false, placed: false, message: `Failed to place the spawn bed : ${error.message}` };
  }
}

/**
 * Break a previously placed spawn bed and carry it away for the next location
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} [waypointName='spawn_bed'] Waypoint of the bed to recover
 * @returns {Promise<{ success: boolean, message: string }>} Outcome
 */
async function pickUpSpawnBed(bot, state, waypointName = 'spawn_bed') {
  const waypoint = getWaypoint(state, waypointName);
  if (!waypoint) return { success: false, message: `No '${waypointName}' recorded to pick up.` };
  if (waypoint.dimension !== getDimension(bot)) {
    return { success: false, message: `The '${waypointName}' bed is in another dimension.` };
  }

  const bedPos = new Vec3(waypoint.x, waypoint.y, waypoint.z);
  const reachable = await approachPosition(bot, bedPos, 3.5, 25000);
  if (!reachable) {
    return { success: false, message: `Could not reach the bed at (${waypoint.x}, ${waypoint.y}, ${waypoint.z}) yet.` };
  }

  const bedBlock = findBedBlockNear(bot, bedPos, 3);
  if (!bedBlock) {
    removeWaypoint(state, waypointName);
    return { success: false, message: 'The recorded bed is gone; waypoint cleared.' };
  }

  const bedsBefore = countItem(bot, 'bed');
  try {
    await bot.lookAt(bedBlock.position.offset(0.5, 0.3, 0.5), true);
    await digWithTimeout(bot, bedBlock, 5000);
    await pickUpDroppedItem(bot, () => countItem(bot, 'bed') > bedsBefore, bedBlock.name, bedBlock.position);
  } catch (error) {
    return { success: false, message: `Failed to break the bed : ${error.message}` };
  }

  removeWaypoint(state, waypointName);
  if (hasMilestone(state, 'active_spawn') && state.milestones.active_spawn === waypointName) {
    setMilestone(state, 'active_spawn', null);
  }
  const collected = countItem(bot, 'bed') > bedsBefore;
  return collected
    ? { success: true, message: 'Bed picked up; it will be placed again at the next spawn location.' }
    : { success: false, message: 'Bed broken but not recovered.' };
}

/**
 * Bed skill: set the respawn point here, or pick the spawn bed back up
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} [target] 'pickup' to recover the bed, 'end' to mark the End portal spawn, otherwise place
 * @returns {Promise<{ success: boolean, message: string }>} Outcome
 */
async function skillBed(bot, state, target) {
  const cleanTarget = typeof target === 'string' ? target.toLowerCase().trim() : '';
  if (cleanTarget === 'pickup') {
    return pickUpSpawnBed(bot, state, 'spawn_bed');
  }

  const nearEndPortal = cleanTarget === 'end' || ['end_portal', 'ender_dragon'].includes(state?.currentObjective);
  const result = await ensureSpawnBed(bot, state, nearEndPortal ? 'end_spawn_bed' : 'spawn_bed', { reuseRange: 16 });
  return { success: result.success, message: result.message };
}

module.exports = {
  skillBed,
  ensureSpawnBed,
  pickUpSpawnBed,
  findBedPlacement,
  findBedBlockNear,
  activateBedForSpawn
};
