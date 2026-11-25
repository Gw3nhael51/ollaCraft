const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { getBestToolForBlock } = require('../../../perception/inventory');
const { isWaterBlock, markFloodedZone } = require('../../../perception/environment');

/**
 * Getting out of water.
 *
 * mineflayer-pathfinder always holds the jump key while in water, so it can only float up: in a flooded cave
 * whose way out is lower (or sideways under an overhang) it pins the bot against the ceiling until it drowns.
 * This module searches the water itself for a route to air (digging through a thin wall or ceiling when that
 * is quicker) and swims it with direct controls, diving when needed.
 */

const LAVA_NAMES = new Set(['lava', 'flowing_lava']);
const UNBREAKABLE_NAMES = new Set(['bedrock', 'barrier', 'end_portal_frame', 'obsidian', 'crying_obsidian', 'reinforced_deepslate']);
const SEARCH_RADIUS = 18;
const SEARCH_HEIGHT = 20;
const MAX_VISITED_CELLS = 14000;
// Swimming covers about two blocks per second: one cell of travel is the unit of the route cost
const SWIM_MS_PER_CELL = 500;
const DEFAULT_DIG_COST = 14;
const MAX_DIG_COST = 40;
// Total time one escape may take, kept below the decision loop's timeout for the 'unstuck' action
const ESCAPE_BUDGET_MS = 45000;
const STEPS = [
  new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];

/**
 * Check whether a block is lava
 * @param {object|null} block Candidate block
 * @returns {boolean} True for lava
 */
function isLavaBlock(block) {
  return Boolean(block?.name && LAVA_NAMES.has(block.name));
}

/**
 * Check whether the bot can breathe with its head in a block
 * @param {object|null} block Candidate block
 * @returns {boolean} True for air and other non-solid, non-liquid blocks
 */
function isBreathableBlock(block) {
  if (!block?.name) return false;
  if (isWaterBlock(block) || isLavaBlock(block)) return false;
  if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return true;
  return block.boundingBox === 'empty';
}

/**
 * Check whether a block stops the bot (a full solid block)
 * @param {object|null} block Candidate block
 * @returns {boolean} True for solid blocks
 */
function isSolidBlock(block) {
  return Boolean(block?.name) && !isWaterBlock(block) && !isLavaBlock(block) && !isBreathableBlock(block);
}

/**
 * Return the block cell holding the bot's feet
 * @param {object} bot Mineflayer bot instance
 * @returns {Vec3} Feet cell
 */
function getFeetCell(bot) {
  const pos = bot.entity.position;
  return new Vec3(Math.floor(pos.x), Math.floor(pos.y + 0.01), Math.floor(pos.z));
}

/**
 * Check whether the bot's head is under water (it is losing air)
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if the eye-level block is water
 */
function isHeadSubmerged(bot) {
  const pos = bot.entity.position;
  return isWaterBlock(bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y + 1.62), Math.floor(pos.z))));
}

/**
 * Check whether the bot is in a liquid at all
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if wading, floating or submerged
 */
function isInLiquid(bot) {
  return Boolean(bot.entity?.isInWater || bot.entity?.isInLava) || isHeadSubmerged(bot);
}

/**
 * Look straight up from the bot's head: is there open air above the water, or a ceiling?
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxHeight=48] How far up to look
 * @returns {{ opensToAir: boolean, depth: number }} Whether swimming straight up reaches air, and how far
 */
function scanWaterColumn(bot, maxHeight = 48) {
  const feet = getFeetCell(bot);
  for (let dy = 1; dy <= maxHeight; dy++) {
    const block = bot.blockAt(feet.offset(0, dy, 0));
    if (!block) return { opensToAir: false, depth: dy };
    if (isWaterBlock(block)) continue;
    return { opensToAir: isBreathableBlock(block), depth: dy };
  }
  return { opensToAir: false, depth: maxHeight };
}

/**
 * Estimate, in swim cells, how long it takes to break a block from under water
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Block to break
 * @returns {number} Route cost, Infinity when the block cannot or should not be broken
 */
function estimateDigCost(bot, block) {
  if (!block?.name || UNBREAKABLE_NAMES.has(block.name) || block.diggable === false) return Infinity;
  if (typeof block.hardness === 'number' && block.hardness < 0) return Infinity;
  if (typeof bot.digTime !== 'function') return DEFAULT_DIG_COST;
  try {
    const cost = bot.digTime(block) / SWIM_MS_PER_CELL;
    return Number.isFinite(cost) && cost <= MAX_DIG_COST ? Math.max(1, cost) : Infinity;
  } catch {
    return DEFAULT_DIG_COST;
  }
}

/**
 * Search the surrounding water for the quickest route to air.
 * Cells are explored by increasing cost (uniform-cost search): swimming one cell costs 1, breaking a block
 * costs its dig time. The search stops at the first cell where the bot can breathe, preferring one where it
 * can also stand on dry ground when that is barely further.
 * @param {object} bot Mineflayer bot instance
 * @param {object} [options={}] Search options
 * @param {boolean} [options.allowDig=true] Allow routes through breakable blocks
 * @param {boolean} [options.requireDry=false] Only accept a cell where the bot stands on dry ground
 * @returns {{ path: Array<{ cell: Vec3, dig: boolean }>, dry: boolean, digs: number, cost: number }|null} Route or null
 */
function findEscapeRoute(bot, options = {}) {
  const allowDig = options.allowDig !== false;
  const start = getFeetCell(bot);
  const blockCache = new Map();
  const keyOf = (cell) => `${cell.x},${cell.y},${cell.z}`;
  const blockAt = (cell) => {
    const key = keyOf(cell);
    if (!blockCache.has(key)) blockCache.set(key, bot.blockAt(cell) || null);
    return blockCache.get(key);
  };

  // A node is the cell of the bot's feet; its head occupies the cell above
  const describe = (cell) => {
    const feet = blockAt(cell);
    const head = blockAt(cell.offset(0, 1, 0));
    if (!feet || !head || isLavaBlock(feet) || isLavaBlock(head)) return null;
    let digCost = 0;
    for (const block of [feet, head]) {
      if (!isSolidBlock(block)) continue;
      if (!allowDig) return null;
      const cost = estimateDigCost(bot, block);
      if (!Number.isFinite(cost)) return null;
      digCost += cost;
    }
    const breathable = digCost === 0 && isBreathableBlock(head);
    const dry = breathable && isBreathableBlock(feet) && isSolidBlock(blockAt(cell.offset(0, -1, 0)));
    return { digCost, breathable, dry };
  };

  const startKey = keyOf(start);
  const best = new Map([[startKey, 0]]);
  const parent = new Map();
  const frontier = [{ cell: start, cost: 0, dig: false }];
  const info = new Map();
  let visited = 0;
  let floating = null;
  let goal = null;

  while (frontier.length > 0 && visited < MAX_VISITED_CELLS) {
    // The frontier stays small enough for a linear minimum search
    let minIndex = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].cost < frontier[minIndex].cost) minIndex = i;
    }
    const current = frontier.splice(minIndex, 1)[0];
    const currentKey = keyOf(current.cell);
    if (current.cost > (best.get(currentKey) ?? Infinity)) continue;
    // Air was found: keep looking a little further for real ground, but do not gamble the remaining air on it
    if (floating && current.cost > floating.cost + 10) break;
    visited += 1;

    const node = currentKey === startKey ? describe(current.cell) : info.get(currentKey);
    if (node?.dry && currentKey !== startKey) {
      goal = current;
      break;
    }
    if (node?.breathable && currentKey !== startKey && !options.requireDry && !floating) {
      floating = current;
    }

    for (const step of STEPS) {
      const next = current.cell.plus(step);
      if (Math.abs(next.x - start.x) > SEARCH_RADIUS || Math.abs(next.z - start.z) > SEARCH_RADIUS) continue;
      if (Math.abs(next.y - start.y) > SEARCH_HEIGHT) continue;

      const nextKey = keyOf(next);
      let nextInfo = info.get(nextKey);
      if (nextInfo === undefined) {
        nextInfo = describe(next);
        info.set(nextKey, nextInfo);
      }
      if (!nextInfo) continue;

      // Walking on air is not possible: a dry cell needs support unless the bot is climbing out of water
      const feetBlock = blockAt(next);
      const supported = isWaterBlock(feetBlock) || nextInfo.digCost > 0 ||
        isSolidBlock(blockAt(next.offset(0, -1, 0))) || isWaterBlock(blockAt(next.offset(0, -1, 0)));
      if (!supported) continue;

      const cost = current.cost + 1 + nextInfo.digCost;
      if (cost >= (best.get(nextKey) ?? Infinity)) continue;
      best.set(nextKey, cost);
      parent.set(nextKey, currentKey);
      frontier.push({ cell: next, cost, dig: nextInfo.digCost > 0 });
    }
  }

  const target = goal || floating;
  if (!target) return null;

  const path = [];
  let cursorKey = keyOf(target.cell);
  const cellOf = (key) => {
    const [x, y, z] = key.split(',').map(Number);
    return new Vec3(x, y, z);
  };
  while (cursorKey && cursorKey !== startKey) {
    const cell = cellOf(cursorKey);
    path.unshift({ cell, dig: (info.get(cursorKey)?.digCost || 0) > 0 });
    cursorKey = parent.get(cursorKey);
  }
  return { path, dry: Boolean(goal), digs: path.filter(step => step.dig).length, cost: target.cost };
}

/**
 * Break the blocks standing in the way of one route step (feet cell and head cell)
 * @param {object} bot Mineflayer bot instance
 * @param {Vec3} cell Feet cell to clear
 * @returns {Promise<number>} Number of blocks broken, or -1 if a block could not be broken
 */
async function clearCell(bot, cell) {
  let broken = 0;
  for (const target of [cell.offset(0, 1, 0), cell]) {
    const block = bot.blockAt(target);
    if (!isSolidBlock(block)) continue;

    let timer = null;
    try {
      const tool = getBestToolForBlock(bot, block);
      if (tool) await bot.equip(tool, 'hand').catch(() => {});
      const expected = typeof bot.digTime === 'function' ? bot.digTime(block) : 6000;
      const timeoutMs = Math.min(22000, Math.max(3000, expected * 1.4 + 1500));
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          bot.stopDigging?.();
          reject(new Error('Underwater dig timeout'));
        }, timeoutMs);
      });
      await Promise.race([bot.dig(block, true), timeoutPromise]);
      broken += 1;
    } catch (error) {
      console.warn(`[WATER] Could not break ${block.name} on the way out :`, error.message);
      return -1;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return broken;
}

/**
 * Swim (or walk) to one cell with direct controls: dive when the cell is lower, rise when it is higher
 * @param {object} bot Mineflayer bot instance
 * @param {Vec3} cell Feet cell to reach
 * @param {number} [deadline=Infinity] Timestamp after which the swim is abandoned
 * @param {number} [maxTicks=50] Tick budget for this cell
 * @returns {Promise<boolean>} True once the bot is inside the cell
 */
async function swimToCell(bot, cell, deadline = Infinity, maxTicks = 50) {
  const target = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
  for (let tick = 0; tick < maxTicks && Date.now() < deadline; tick++) {
    const pos = bot.entity.position;
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dz = target.z - pos.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal < 0.35 && Math.abs(dy) < 0.55) return true;

    if (horizontal > 0.05) await bot.look(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState('forward', horizontal > 0.2);
    bot.setControlState('sprint', false);
    // In a liquid the jump key swims up and releasing it sinks, so it is only released to dive: holding it
    // at the target's level is what lets the bot haul itself out of the water onto a ledge.
    // On land it climbs a one-block step.
    const inLiquid = Boolean(bot.entity.isInWater || bot.entity.isInLava);
    bot.setControlState('jump', inLiquid ? dy > -0.2 : dy > 0.4);
    await bot.waitForTicks(1);
  }
  return false;
}

/**
 * Follow an escape route cell by cell, breaking the blocks it goes through
 * @param {object} bot Mineflayer bot instance
 * @param {Array<{ cell: Vec3, dig: boolean }>} path Route returned by findEscapeRoute
 * @param {number} [deadline=Infinity] Timestamp after which the route is abandoned
 * @returns {Promise<{ reached: boolean, broken: number }>} Whether the end of the route was reached, and blocks broken
 */
async function followEscapeRoute(bot, path, deadline = Infinity) {
  // The entry point keeps the bot afloat by holding jump whenever it is in water: that must not fight a dive
  bot.autoFloatSuspended = true;
  let broken = 0;
  try {
    bot.pathfinder?.setGoal?.(null);
    for (const step of path) {
      if (Date.now() >= deadline) return { reached: false, broken };
      if (step.dig) {
        bot.clearControlStates?.();
        const cleared = await clearCell(bot, step.cell);
        if (cleared < 0) return { reached: false, broken };
        broken += cleared;
      }
      if (!await swimToCell(bot, step.cell, deadline)) return { reached: false, broken };
    }
    return { reached: true, broken };
  } finally {
    bot.autoFloatSuspended = false;
    bot.clearControlStates?.();
  }
}

/**
 * Find dry standing spots near the bot, nearest first
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxDistance=40] Search radius
 * @returns {Array<object>} Positions of ground blocks with two breathable blocks above
 */
function findDryGround(bot, maxDistance = 40) {
  const matching = (block) => {
    if (!block?.name || block.boundingBox === 'empty' || isWaterBlock(block) || isLavaBlock(block)) return false;
    if (!block.position) return true;
    return isBreathableBlock(bot.blockAt(block.position.offset(0, 1, 0))) &&
      isBreathableBlock(bot.blockAt(block.position.offset(0, 2, 0)));
  };

  if (typeof bot.findBlocks === 'function') {
    const found = bot.findBlocks({ matching, maxDistance, count: 6 });
    if (Array.isArray(found) && found.length > 0) return found;
  }
  const single = typeof bot.findBlock === 'function' ? bot.findBlock({ matching, maxDistance }) : null;
  return single?.position ? [single.position] : [];
}

/**
 * Walk or swim at the surface to the nearest dry ground using the regular pathfinder
 * @param {object} bot Mineflayer bot instance
 * @param {number} [deadline=Infinity] Timestamp after which no further candidate is tried
 * @param {number} [maxDistance=40] Search radius
 * @param {number} [index=0] Index of the candidate being tried
 * @param {Array<object>|null} [candidates=null] Candidates found by the first call
 * @returns {Promise<boolean>} True if the bot ends out of the water
 */
async function walkToDryGround(bot, deadline = Infinity, maxDistance = 40, index = 0, candidates = null) {
  const spots = candidates || findDryGround(bot, maxDistance);
  if (index >= Math.min(spots.length, 3) || typeof bot.pathfinder?.goto !== 'function') return false;
  const remainingMs = Math.min(12000, deadline - Date.now());
  if (remainingMs < 2000) return false;

  const spot = spots[index];
  let navTimer = null;
  try {
    const gotoPromise = bot.pathfinder.goto(new goals.GoalNear(spot.x, spot.y + 1, spot.z, 1));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error('Timeout swimming to dry land')), remainingMs);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } catch {
    // Try the next candidate: this one may sit behind a wall or across a current
  } finally {
    if (navTimer) clearTimeout(navTimer);
    bot.pathfinder.setGoal?.(null);
    bot.clearControlStates?.();
  }

  if (!isInLiquid(bot)) return true;
  return walkToDryGround(bot, deadline, maxDistance, index + 1, spots);
}

/**
 * Swim at the surface along a heading when no shore is in sight
 * @param {object} bot Mineflayer bot instance
 * @param {number} headingRad World heading in radians (0 is +X, PI/2 is +Z)
 * @param {number} [ticks=120] Swim duration
 * @returns {Promise<number>} Horizontal distance covered
 */
async function swimAlongHeading(bot, headingRad, ticks = 120) {
  const startX = bot.entity.position.x;
  const startZ = bot.entity.position.z;
  try {
    await bot.look(Math.atan2(-Math.cos(headingRad), -Math.sin(headingRad)), 0, true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    bot.setControlState('sprint', true);
    await bot.waitForTicks(ticks);
  } catch {
    // The distance covered below tells whether this did anything
  } finally {
    bot.clearControlStates?.();
  }
  return Math.hypot(bot.entity.position.x - startX, bot.entity.position.z - startZ);
}

/**
 * Get the bot out of the water: reach air first (diving or digging if needed), then dry ground.
 * A flooded cave the bot had to escape from is recorded so it goes to work somewhere else.
 * @param {object} bot Mineflayer bot instance
 * @param {object} [options={}] Escape options
 * @param {number} [options.headingRad] Heading to swim along when no shore is visible
 * @returns {Promise<{ success: boolean, message: string, enclosed: boolean, swamDistance: number }>} Outcome
 */
async function escapeWater(bot, options = {}) {
  const origin = bot.entity.position.clone ? bot.entity.position.clone() : { ...bot.entity.position };
  // Enclosed: under water with a ceiling above, floating up cannot work
  const enclosed = isHeadSubmerged(bot) && !scanWaterColumn(bot).opensToAir;
  // The whole escape fits inside one action of the decision loop
  const deadline = Date.now() + ESCAPE_BUDGET_MS;
  let dugBlocks = 0;

  /**
   * Compute a route with the dedicated swimmer and follow it
   * @param {boolean} requireDry Only accept a route ending on dry ground
   * @returns {Promise<boolean>} True if a route was found and followed to its end
   */
  const swimRoute = async (requireDry) => {
    const route = findEscapeRoute(bot, { requireDry });
    if (!route || route.path.length === 0) return false;
    console.log(`[WATER] Escape route: ${route.path.length} cell(s) to ${route.dry ? 'dry ground' : 'air'}${route.digs > 0 ? ', digging through' : ''}.`);
    const outcome = await followEscapeRoute(bot, route.path, deadline);
    dugBlocks += outcome.broken;
    return outcome.reached;
  };

  // 1. Air first. Two attempts: the route is recomputed from wherever the first one stopped
  if (isHeadSubmerged(bot)) await swimRoute(false);
  if (isHeadSubmerged(bot)) await swimRoute(false);
  if (isHeadSubmerged(bot)) {
    return {
      success: false,
      enclosed,
      swamDistance: 0,
      message: 'Still under water: no route to air found within reach (flooded area with no breakable way out).'
    };
  }

  if (enclosed) {
    markFloodedZone(origin);
    console.log(`[WATER] Flooded area recorded around (${Math.round(origin.x)}, ${Math.round(origin.y)}, ${Math.round(origin.z)}).`);
  }

  // 2. Then out of the water: the regular pathfinder works at the surface; an air pocket inside a flooded
  //    cave may still need a dive to reach ground, which only the dedicated swimmer can do
  if (isInLiquid(bot) && !await walkToDryGround(bot, deadline) && isInLiquid(bot)) {
    await swimRoute(true);
  }

  if (isInLiquid(bot)) {
    // Open water with no shore in range: keep swimming the same way, cycle after cycle, until land shows up
    const heading = Number.isFinite(options.headingRad) ? options.headingRad : 0;
    const swimTicks = Math.max(20, Math.min(120, Math.floor((deadline - Date.now()) / 50)));
    const swamDistance = await swimAlongHeading(bot, heading, swimTicks);
    if (isInLiquid(bot)) {
      return {
        success: false,
        enclosed,
        swamDistance,
        message: `Head above water but no shore within reach yet: swam ${Math.round(swamDistance)} blocks to look for land.`
      };
    }
  }

  const digNote = dugBlocks > 0 ? ` (broke ${dugBlocks} block(s) on the way)` : '';
  return {
    success: true,
    enclosed,
    swamDistance: 0,
    message: enclosed
      ? `Escaped a flooded area and reached dry land${digNote}. The area is flooded: work somewhere else.`
      : `Out of the water and on dry land${digNote}.`
  };
}

module.exports = {
  escapeWater,
  findEscapeRoute,
  followEscapeRoute,
  swimToCell,
  scanWaterColumn,
  findDryGround,
  isHeadSubmerged,
  isInLiquid,
  isBreathableBlock,
  isSolidBlock
};
