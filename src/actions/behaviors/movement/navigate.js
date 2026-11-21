const crypto = require('node:crypto');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../../../infrastructure/config');
const { getBestToolForBlock, isWoodLog, isPlanks, hasToolType, countItem } = require('../../../perception/inventory');
const { isBadBlock, hasTerrainAbove, isBelowSurface, estimateSurfaceY, rememberLava, getKnownLava, forgetLava } = require('../../../perception/environment');
const { markLavaClusterBad, fillBucketFromSource, emptyLavaBucketSafely } = require('../world/portal');
const { getOreDepthHint } = require('../../../minecraft/knowledge');
const { escapeWater, isInLiquid } = require('./water');

// Exploration hints naming creatures that only live on the surface (trees are recognized separately)
const SURFACE_TARGETS = new Set(['sheep', 'chicken', 'cow', 'pig', 'spider', 'enderman', 'wool', 'feather', 'string', 'sapling', 'apple']);
// Height gained per pathfinder leg while climbing out of a mine
const SURFACE_CLIMB_LEG = 12;
const SURFACE_CLIMB_LEG_MAX_MS = 16000;
// Shortest time worth starting a climbing leg with: digging a single stair step already takes a few seconds
const MIN_CLIMB_LEG_MS = 5000;

// Longest time worth spending on one block while digging a way out of a hole
const UNSTUCK_DIG_LIMIT_MS = 7000;

const DEEP_CAVE_DIGGABLE_BLOCKS = new Set([
  'deepslate', 'cobbled_deepslate', 'tuff', 'granite', 'diorite', 'andesite', 'netherrack', 'blackstone', 'basalt'
]);
const DRY_GROUND_BLOCKS = new Set([
  ...config.VALID_GROUND_BLOCKS, 'obsidian', 'cobbled_deepslate', 'tuff', 'granite', 'diorite', 'andesite', 'netherrack', 'blackstone', 'basalt'
]);

/**
 * Check whether an adjacent block can be dug quickly during an unstuck maneuver
 * @param {object|null} block Candidate block
 * @param {object|null} [bot=null] Mineflayer bot instance; when given, the real dig time with the carried tools decides
 * @returns {boolean} True if block can be broken to escape
 */
function isDiggableObstacle(block, bot = null) {
  if (!block?.name) return false;
  if (config.SOFT_BLOCKS.has(block.name) || DEEP_CAVE_DIGGABLE_BLOCKS.has(block.name)) return true;
  if (block.name.endsWith('_leaves') || isWoodLog(block.name)) return true;

  // With a pickaxe in the pocket, deepslate, andesite or ore walls are no obstacle either
  if (bot && typeof bot.digTime === 'function' && block.boundingBox === 'block' && block.diggable !== false) {
    try {
      return bot.digTime(block) <= UNSTUCK_DIG_LIMIT_MS;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Dig a block with a bounded safety timeout so bare-handed stone digging does not stall unstuck
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Block to dig
 * @param {number} [timeoutMs=8000] Maximum dig duration in milliseconds
 * @returns {Promise<void>}
 */
async function digWithTimeout(bot, block, timeoutMs = 8000) {
  let timer = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        bot.stopDigging?.();
        reject(new Error("Unstuck dig timeout"));
      }, timeoutMs);
    });
    await Promise.race([bot.dig(block), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Attempt to dig an escape tunnel through one of the cardinal walls
 * @param {object} bot Mineflayer bot instance
 * @param {Array<object>} cardinals Cardinal direction list
 * @param {number} index Tested direction index
 * @returns {Promise<boolean>} True if an escape path was successfully dug
 */
async function findAndDigEscapeRoute(bot, cardinals, index) {
  if (index >= cardinals.length) return false;

  const dir = cardinals[index];
  const sideEyeBlock = bot.blockAt(bot.entity.position.plus(dir).offset(0, 1, 0));
  const sideFeetBlock = bot.blockAt(bot.entity.position.plus(dir));

  if (isDiggableObstacle(sideEyeBlock, bot)) {
    console.log(`[UNSTUCK] Passable wall found in direction (${dir.x}, ${dir.y}, ${dir.z}) : ${sideEyeBlock.name}. Digging escape path...`);
    const digTimeoutMs = hasToolType(bot, '_pickaxe') ? 8000 : 18000;
    try {
      const eyeTool = getBestToolForBlock(bot, sideEyeBlock);
      if (eyeTool) await bot.equip(eyeTool, 'hand').catch(() => {});
      await digWithTimeout(bot, sideEyeBlock, digTimeoutMs);

      if (isDiggableObstacle(sideFeetBlock, bot)) {
        const feetTool = getBestToolForBlock(bot, sideFeetBlock);
        if (feetTool) await bot.equip(feetTool, 'hand').catch(() => {});
        await digWithTimeout(bot, sideFeetBlock, digTimeoutMs);
      }

      const targetPos = bot.entity.position.plus(dir);
      const { GoalNear } = goals;
      // Abort navigation if unstuck movement exceeds safety timeout
      const escapeGoto = bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
      const escapeTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout navigation unstuck")), 6000));
      await Promise.race([escapeGoto, escapeTimeout]);
      console.log("[UNSTUCK] Successfully escaped!");
      return true;
    } catch (err) {
      console.warn("[UNSTUCK] Escape digging failure :", err.message);
    }
  }

  return findAndDigEscapeRoute(bot, cardinals, index + 1);
}

/**
 * Find the nearest walkable dry ground block with clear air above
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxDistance=36] Maximum search radius
 * @returns {object|null} Dry ground block or null
 */
function findNearestDryLand(bot, maxDistance = 36) {
  if (typeof bot.findBlock !== 'function') return null;

  return bot.findBlock({
    matching: (block) => {
      if (!block?.position || !DRY_GROUND_BLOCKS.has(block.name) || isBadBlock(block.position)) return false;
      const above1 = bot.blockAt(block.position.offset(0, 1, 0));
      const above2 = bot.blockAt(block.position.offset(0, 2, 0));
      const clear1 = !above1 || above1.name === 'air' || above1.name === 'cave_air';
      const clear2 = !above2 || above2.name === 'air' || above2.name === 'cave_air';
      return clear1 && clear2;
    },
    maxDistance
  });
}

/**
 * Swim towards nearby dry land or paddle forward when surfacing in open water
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxDistance=36] Dry land search radius
 * @returns {Promise<boolean>} True if navigation reached or moved towards dry land
 */
async function swimToDryLand(bot, maxDistance = 36) {
  const dryLand = findNearestDryLand(bot, maxDistance);
  if (dryLand?.position && typeof bot.pathfinder?.goto === 'function') {
    let navTimer = null;
    try {
      const { GoalNear } = goals;
      const gotoPromise = bot.pathfinder.goto(new GoalNear(dryLand.position.x, dryLand.position.y + 1, dryLand.position.z, 1));
      const timeoutPromise = new Promise((_, reject) => {
        navTimer = setTimeout(() => reject(new Error("Timeout swimming to dry land")), 12000);
      });
      await Promise.race([gotoPromise, timeoutPromise]);
      return true;
    } catch {
      return false;
    } finally {
      if (navTimer) clearTimeout(navTimer);
      bot.pathfinder?.setGoal?.(null);
      bot.clearControlStates?.();
    }
  }

  bot.setControlState?.('jump', true);
  bot.setControlState?.('forward', true);
  if (typeof bot.waitForTicks === 'function') {
    await bot.waitForTicks(35);
  }
  bot.clearControlStates?.();
  return false;
}

/**
 * Attempt to extricate bot from holes, water or obstacles by breaking ceiling or swimming
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<{ success: boolean, message: string }>} Result of unstuck procedure
 */
async function skillUnstuck(bot) {
  bot.chat("Freeing myself...");
  console.log("[UNSTUCK] Launching unstuck procedure.");
  bot.clearControlStates();

  // In water the only goal is air, then dry ground. Floating up is not enough in a flooded cave: the escape
  // searches a real route (diving or digging when needed) and reports honestly when the bot is still in water
  if (isInLiquid(bot)) {
    console.log("[UNSTUCK] Bot is in water: looking for a way out...");
    if (countItem(bot, 'bucket') > 0) {
      await fillBucketFromSource(bot, 'water').catch(() => {});
    }
    if (currentExploreHeadingRad === null) {
      currentExploreHeadingRad = (crypto.randomInt(0, 360) * Math.PI) / 180;
    }
    const outcome = await escapeWater(bot, { headingRad: currentExploreHeadingRad });
    if (outcome.enclosed && outcome.success) {
      // Leave the flooded gallery behind: the next exploration starts in a fresh direction
      recentExplorePositions = [];
    }
    return { success: outcome.success, message: outcome.message };
  }

  const startY = bot.entity.position.y;

  // Check and break ceiling if solid block obstructs above
  const headBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0));
  if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air') {
    console.log(`[UNSTUCK] Obstacle detected above head : ${headBlock.name}. Breaking it.`);
    try {
      const tool = getBestToolForBlock(bot, headBlock);
      if (tool) await bot.equip(tool, 'hand').catch(() => {});
      await digWithTimeout(bot, headBlock, hasToolType(bot, '_pickaxe') ? 10000 : 18000);
      console.log("[UNSTUCK] Ceiling block broken successfully.");
    } catch (error) {
      console.warn("[UNSTUCK] Failed to break ceiling block :", error.message);
    }
  } else {
    console.log("[UNSTUCK] Clear path above head, attempting jump...");
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    await bot.waitForTicks(10);
    bot.setControlState('jump', false);
    bot.setControlState('forward', false);
  }

  const cardinals = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ];

  console.log("[UNSTUCK] Searching for an escape opening in adjacent walls...");
  const escaped = await findAndDigEscapeRoute(bot, cardinals, 0);
  if (escaped) {
    return { success: true, message: "Dug exit route through wall to escape hole." };
  }

  // Last resort: let the pathfinder climb out, digging steps or stacking blocks under the bot as it sees fit
  if (await climbOutOfHole(bot, startY)) {
    return { success: true, message: `Climbed out of the hole (now at Y:${Math.round(bot.entity.position.y)}).` };
  }

  return { success: false, message: "Unable to dig an exit through immediate surrounding walls." };
}

/**
 * Climb a few blocks with the pathfinder, which digs steps or pillars up as needed
 * @param {object} bot Mineflayer bot instance
 * @param {number} startY Altitude the bot was stuck at
 * @param {number} [timeoutMs=12000] Maximum climb duration
 * @returns {Promise<boolean>} True if the bot ended at least two blocks higher
 */
async function climbOutOfHole(bot, startY, timeoutMs = 12000) {
  if (!goals.GoalY || typeof bot.pathfinder?.goto !== 'function') return false;
  let navTimer = null;
  let gotoPromise = null;
  try {
    gotoPromise = bot.pathfinder.goto(new goals.GoalY(Math.floor(startY) + 3));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error("Climb timeout")), timeoutMs);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[UNSTUCK] Climbing out failed:', err.message);
  } finally {
    if (navTimer) clearTimeout(navTimer);
    gotoPromise?.catch(() => {});
    bot.pathfinder.setGoal?.(null);
    bot.clearControlStates?.();
  }
  return bot.entity.position.y >= startY + 2;
}

const EXPLORE_WINDOW_SIZE = 6;
const EXPLORE_BUDGET_MS = 34000;
const LAVA_DEPTH_TARGET_Y = -50;
const LAVA_DESCENT_STEP = 20;
const LAVA_MISSES_BEFORE_DESCENT = 2;
const KNOWN_LAVA_MAX_TRAVEL = 400;
let lavaSearchMisses = 0;
let currentExploreHeadingRad = null;
let recentExplorePositions = [];

/**
 * Locate a nearby reachable lava source block within exploration range
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxDistance=48] Maximum search radius
 * @returns {object|null} Lava source block or null
 */
function findNearbyLavaForExplore(bot, maxDistance = 48) {
  const lavaId = bot.registry?.blocksByName?.lava?.id;
  if (!lavaId || typeof bot.findBlock !== 'function') return null;

  const isEligibleLava = (block) => Boolean(
    block?.position &&
    block.type === lavaId &&
    (!block.metadata || block.metadata === 0) &&
    !isBadBlock(block.position)
  );

  const sameLevelSurface = bot.findBlock({
    matching: (block) => {
      if (!isEligibleLava(block)) return false;
      if (bot.entity?.position && Math.abs(block.position.y - bot.entity.position.y) > 12) return false;
      const above = bot.blockAt(block.position.offset(0, 1, 0));
      return !above || above.name === 'air' || above.name === 'cave_air';
    },
    maxDistance
  });
  if (sameLevelSurface) return sameLevelSurface;

  const surfaceLava = bot.findBlock({
    matching: (block) => {
      if (!isEligibleLava(block)) return false;
      const above = bot.blockAt(block.position.offset(0, 1, 0));
      return !above || above.name === 'air' || above.name === 'cave_air';
    },
    maxDistance
  });
  return surfaceLava || bot.findBlock({ matching: isEligibleLava, maxDistance });
}

/**
 * Attempt a single bounded GoalNearXZ move towards a relative heading and distance
 * @param {object} bot Mineflayer bot instance
 * @param {number} targetX Target X coordinate
 * @param {number} targetZ Target Z coordinate
 * @param {boolean} [disableDig=false] Temporarily disable digging and pillaring for fast surface pathfinding
 * @param {number} [timeoutMs=12000] Maximum pathfinder wait in milliseconds
 * @returns {Promise<void>}
 */
async function moveExploreStep(bot, targetX, targetZ, disableDig = false, timeoutMs = 12000) {
  let navTimer = null;
  const movements = bot.pathfinder?.movements;
  const hadMovements = Boolean(disableDig && movements);
  const prevCanDig = hadMovements ? movements.canDig : undefined;
  const prevTower = hadMovements ? movements.allow1by1towers : undefined;

  try {
    if (hadMovements) {
      movements.canDig = false;
      movements.allow1by1towers = false;
    }
    const { GoalNearXZ } = goals;
    const gotoPromise = bot.pathfinder.goto(new GoalNearXZ(targetX, targetZ, 3));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error("Exploration timeout")), timeoutMs);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } finally {
    if (navTimer) clearTimeout(navTimer);
    if (hadMovements) {
      movements.canDig = prevCanDig;
      movements.allow1by1towers = prevTower;
    }
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }
}

/**
 * Convert a polar world heading in radians into a Mineflayer entity yaw angle
 * @param {number} headingRad Target heading in radians where 0 is +X and PI/2 is +Z
 * @returns {number} Equivalent Mineflayer yaw angle in radians
 */
function headingToMineflayerYaw(headingRad) {
  return Math.atan2(-Math.cos(headingRad), -Math.sin(headingRad));
}

/**
 * Determine whether recent exploration samples remain trapped within a small horizontal bounding box
 * @param {Array<{ x: number, z: number }>} positions Recorded planar coordinates across recent cycles
 * @param {number} [minSamples=4] Minimum history length before checking confinement
 * @param {number} [spanLimit=32] Maximum X and Z span considered trapped
 * @returns {boolean} True when both X and Z spans remain strictly below spanLimit
 */
function isBoxStuck(positions, minSamples = 4, spanLimit = 32) {
  if (!Array.isArray(positions) || positions.length < minSamples) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const pos of positions) {
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.z < minZ) minZ = pos.z;
    if (pos.z > maxZ) maxZ = pos.z;
  }
  return (maxX - minX) < spanLimit && (maxZ - minZ) < spanLimit;
}

/**
 * Check whether lava lies immediately ahead along the given heading
 * @param {object} bot Mineflayer bot instance
 * @param {number} headingRad Heading angle in radians
 * @returns {boolean} True if lava or flowing_lava is detected within 2 blocks ahead
 */
function hasLavaAhead(bot, headingRad) {
  if (!bot.entity?.position || typeof bot.blockAt !== 'function') return false;
  const pos = bot.entity.position;
  for (const step of [1, 2]) {
    const checkX = Math.round(pos.x + Math.cos(headingRad) * step);
    const checkZ = Math.round(pos.z + Math.sin(headingRad) * step);
    for (const dy of [-1, 0, 1]) {
      const name = bot.blockAt(new Vec3(checkX, Math.round(pos.y) + dy, checkZ))?.name;
      if (name === 'lava' || name === 'flowing_lava') return true;
    }
  }
  return false;
}

/**
 * Check whether the ground falls away just ahead along the given heading (cliff, ravine, pit)
 * @param {object} bot Mineflayer bot instance
 * @param {number} headingRad Heading angle in radians
 * @param {number} [maxDrop=4] Deepest drop the bot may walk off without damage worth worrying about
 * @returns {boolean} True if no solid block or water lies within maxDrop blocks below the next two blocks ahead
 */
function hasDropAhead(bot, headingRad, maxDrop = 4) {
  if (!bot.entity?.position || typeof bot.blockAt !== 'function') return false;
  const pos = bot.entity.position;
  for (const step of [1, 2]) {
    const checkX = Math.floor(pos.x + Math.cos(headingRad) * step);
    const checkZ = Math.floor(pos.z + Math.sin(headingRad) * step);
    let supported = false;
    for (let depth = 1; depth <= maxDrop + 1 && !supported; depth++) {
      const block = bot.blockAt(new Vec3(checkX, Math.floor(pos.y) - depth, checkZ));
      supported = Boolean(block && (block.boundingBox === 'block' || block.name === 'water'));
    }
    if (!supported) return true;
  }
  return false;
}

/**
 * Compute the heading pointing straight away from the world spawn when the bot is still close to it
 * @param {object} bot Mineflayer bot instance
 * @param {number} withinDistance Only applies within this horizontal distance of the spawn
 * @returns {number|null} Heading in radians or null when the spawn is unknown or far away
 */
function getHeadingAwayFromSpawn(bot, withinDistance) {
  const spawn = bot.spawnPoint;
  const pos = bot.entity?.position;
  if (!spawn || !pos) return null;
  const dx = pos.x - spawn.x;
  const dz = pos.z - spawn.z;
  const distance = Math.hypot(dx, dz);
  if (distance > withinDistance) return null;
  return distance < 1 ? (crypto.randomInt(0, 360) * Math.PI) / 180 : Math.atan2(dz, dx);
}

/**
 * Walk forward in short safe slices while avoiding lava and cliffs ahead
 * @param {object} bot Mineflayer bot instance
 * @param {number} headingRad Heading angle in radians
 * @param {number} [remainingTicks=35] Remaining movement ticks
 * @returns {Promise<void>}
 */
async function walkForwardSlices(bot, headingRad, remainingTicks) {
  if (remainingTicks <= 0 || hasLavaAhead(bot, headingRad) || hasDropAhead(bot, headingRad)) return;
  const slice = Math.min(5, remainingTicks);
  if (typeof bot.waitForTicks === 'function') {
    await bot.waitForTicks(slice);
  }
  return walkForwardSlices(bot, headingRad, remainingTicks - slice);
}

/**
 * Perform a short lava-checked surface sprint burst when pathfinder times out on hills or foliage
 * @param {object} bot Mineflayer bot instance
 * @param {number} headingRad Heading angle in radians
 * @param {number} [ticks=35] Total movement ticks
 * @returns {Promise<boolean>} True if forward burst moved the bot
 */
async function walkForwardBurst(bot, headingRad, ticks = 35) {
  if (!bot.entity?.position || typeof bot.setControlState !== 'function') return false;
  const startPos = bot.entity.position.clone ? bot.entity.position.clone() : { ...bot.entity.position };
  try {
    if (typeof bot.look === 'function') {
      const yaw = headingToMineflayerYaw(headingRad);
      await bot.look(yaw, 0, true).catch(() => {});
    }
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);
    await walkForwardSlices(bot, headingRad, ticks);
  } finally {
    bot.clearControlStates?.();
  }
  const endPos = bot.entity.position;
  return Math.hypot(endPos.x - startPos.x, endPos.z - startPos.z) >= 1;
}

/**
 * Check whether solid terrain blocks sit above the bot, indicating an enclosed cave or overhang
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True when a solid terrain ceiling block is detected within 20 blocks above
 */
function hasSolidCeilingAbove(bot) {
  return hasTerrainAbove(bot, 20);
}

const PILLAR_SCAFFOLD_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'deepslate'
];
const NON_SOLID_PILLAR_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'grass', 'fern', 'torch', 'wall_torch', 'snow'
]);
const PILLAR_HAZARD_BLOCKS = new Set([
  'lava', 'flowing_lava', 'water', 'flowing_water', 'bedrock', 'obsidian'
]);

/**
 * Find the highest-priority solid scaffold item carried in inventory for vertical pillaring
 * @param {object} bot Mineflayer bot instance
 * @returns {object|null} Matching inventory item or null
 */
function findPillarScaffoldItem(bot) {
  const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
  for (const name of PILLAR_SCAFFOLD_BLOCKS) {
    const match = items.find(i => i.name === name);
    if (match) return match;
  }
  return null;
}

/**
 * Recursively dig one block overhead and jump-place a scaffold block beneath feet until deadline or surface
 * @param {object} bot Mineflayer bot instance
 * @param {number} startY Initial floored Y altitude before pillaring
 * @param {number} deadlineMs Epoch deadline timestamp in milliseconds
 * @param {number} sameYRetries Consecutive retries at the same altitude (for falling blocks)
 * @returns {Promise<boolean>} True if net positive vertical gain was achieved
 */
async function pillarUpRecursive(bot, startY, deadlineMs, sameYRetries) {
  if (Date.now() >= deadlineMs || bot.entity.position.y >= 64 || bot.entity.isInWater || sameYRetries >= 3) {
    return Math.floor(bot.entity.position.y) > startY;
  }

  const scaffoldItem = findPillarScaffoldItem(bot);
  if (!scaffoldItem) return Math.floor(bot.entity.position.y) > startY;

  const feetPos = bot.entity.position.floored
    ? bot.entity.position.floored()
    : new Vec3(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z));

  const headAbove = bot.blockAt(feetPos.offset(0, 2, 0));
  const aboveHeadAbove = bot.blockAt(feetPos.offset(0, 3, 0));
  if ((headAbove && PILLAR_HAZARD_BLOCKS.has(headAbove.name)) || (aboveHeadAbove && PILLAR_HAZARD_BLOCKS.has(aboveHeadAbove.name))) {
    return Math.floor(bot.entity.position.y) > startY;
  }

  if (headAbove && !NON_SOLID_PILLAR_BLOCKS.has(headAbove.name)) {
    const tool = getBestToolForBlock(bot, headAbove);
    const digMs = typeof headAbove.digTime === 'function'
      ? headAbove.digTime(tool?.type ?? null, false, false, false, [], {})
      : (hasToolType(bot, '_pickaxe') ? 2000 : 8000);
    if (!Number.isFinite(digMs) || Date.now() + digMs > deadlineMs + 4000) {
      return Math.floor(bot.entity.position.y) > startY;
    }
    if (tool && typeof bot.equip === 'function') {
      await bot.equip(tool, 'hand').catch(() => {});
    }
    try {
      await digWithTimeout(bot, headAbove, Math.max(8000, Math.ceil(digMs) + 4000));
    } catch {
      return Math.floor(bot.entity.position.y) > startY;
    }
    await bot.waitForTicks(2);
    const afterDig = bot.blockAt(feetPos.offset(0, 2, 0));
    if (afterDig && !NON_SOLID_PILLAR_BLOCKS.has(afterDig.name)) {
      return pillarUpRecursive(bot, startY, deadlineMs, sameYRetries + 1);
    }
  }

  const belowBlock = bot.blockAt(feetPos.offset(0, -1, 0));
  if (!belowBlock || NON_SOLID_PILLAR_BLOCKS.has(belowBlock.name)) {
    return Math.floor(bot.entity.position.y) > startY;
  }

  const dx = (feetPos.x + 0.5) - bot.entity.position.x;
  const dz = (feetPos.z + 0.5) - bot.entity.position.z;
  if (Math.hypot(dx, dz) > 0.18 && typeof bot.lookAt === 'function') {
    await bot.lookAt(new Vec3(feetPos.x + 0.5, bot.entity.position.y + 1.6, feetPos.z + 0.5), true).catch(() => {});
    bot.setControlState('forward', true);
    await bot.waitForTicks(2);
    bot.clearControlStates?.();
  }

  const belowPos = belowBlock.position || feetPos.offset(0, -1, 0);
  if (typeof bot.equip === 'function') {
    await bot.equip(scaffoldItem, 'hand').catch(() => {});
  }
  if (typeof bot.lookAt === 'function') {
    await bot.lookAt(belowPos.offset(0.5, 1, 0.5), true).catch(() => {});
  }
  bot.setControlState('jump', true);
  await bot.waitForTicks(4);
  await bot.placeBlock(belowBlock, new Vec3(0, 1, 0)).catch(() => {});
  bot.setControlState('jump', false);
  await bot.waitForTicks(5);

  const newY = Math.floor(bot.entity.position.y);
  if (newY <= feetPos.y) return newY > startY;
  return pillarUpRecursive(bot, startY, deadlineMs, 0);
}

/**
 * Climb vertically using 1x1 pillaring when underground pathfinding stalls or no pickaxe is carried
 * @param {object} bot Mineflayer bot instance
 * @param {number} [timeoutMs=24000] Maximum pillaring budget in milliseconds
 * @returns {Promise<boolean>} True if bot gained at least 1 block of altitude
 */
async function tryPillarUp(bot, timeoutMs = 24000) {
  if (
    !bot.entity?.position ||
    bot.entity.isInWater ||
    typeof bot.blockAt !== 'function' ||
    typeof bot.dig !== 'function' ||
    typeof bot.placeBlock !== 'function' ||
    typeof bot.waitForTicks !== 'function' ||
    typeof bot.setControlState !== 'function'
  ) {
    return false;
  }
  const startY = Math.floor(bot.entity.position.y);
  bot.pathfinder?.setGoal?.(null);
  bot.clearControlStates?.();
  try {
    return await pillarUpRecursive(bot, startY, Date.now() + timeoutMs, 0);
  } finally {
    bot.clearControlStates?.();
  }
}

/**
 * Attempt to climb upwards toward surface elevation when deep underground
 * @param {object} bot Mineflayer bot instance
 * @param {number} [timeoutMs=14000] Maximum ascent wait in milliseconds
 * @param {number|null} [goalY=null] Altitude to reach (defaults to ten blocks higher, at most Y:72)
 * @returns {Promise<boolean>} True if ascent succeeded
 */
async function trySurfaceAscent(bot, timeoutMs = 14000, goalY = null) {
  if (!bot.entity?.position || !goals.GoalY) return false;
  const hasPick = hasToolType(bot, '_pickaxe');
  const startY = Math.floor(bot.entity.position.y);
  const minGain = hasPick ? 3 : 1;

  if (!hasPick && await tryPillarUp(bot, Math.min(timeoutMs, 26000))) {
    console.log(`[EXPLORE] Pillar ascent reached Y:${Math.round(bot.entity.position.y)}`);
    return true;
  }

  let navTimer = null;
  let gotoPromise = null;
  const startX = bot.entity.position.x;
  const startZ = bot.entity.position.z;
  try {
    const stepUp = hasPick ? 10 : 6;
    const targetY = goalY ?? Math.min(72, Math.round(bot.entity.position.y) + stepUp);
    console.log(`[EXPLORE] Climbing towards Y:${targetY}...`);
    gotoPromise = bot.pathfinder.goto(new goals.GoalY(targetY));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error("Surface ascent timeout")), timeoutMs);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
    const endPos = bot.entity.position;
    const dx = endPos.x - startX;
    const dz = endPos.z - startZ;
    if (Math.hypot(dx, dz) >= 4) {
      currentExploreHeadingRad = Math.atan2(dz, dx);
    }
    console.log(`[EXPLORE] Ascent complete; now at Y:${Math.round(endPos.y)}`);
    return true;
  } catch (err) {
    if (Math.floor(bot.entity.position.y) >= startY + minGain) {
      console.log(`[EXPLORE] Partial ascent reached Y:${Math.round(bot.entity.position.y)}`);
      return true;
    }
    if (hasPick && timeoutMs >= 10000 && await tryPillarUp(bot, 8000)) {
      console.log(`[EXPLORE] Pillar fallback reached Y:${Math.round(bot.entity.position.y)}`);
      return true;
    }
    console.warn('[EXPLORE] Surface ascent failed:', err.message);
    return false;
  } finally {
    if (navTimer) clearTimeout(navTimer);
    gotoPromise?.catch(() => {});
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }
}

/**
 * Climb out of a mine or a cave leg by leg, through existing galleries or by digging a staircase,
 * until the sky is open or the time budget runs out
 * @param {object} bot Mineflayer bot instance
 * @param {number} budgetMs Time the whole climb may take
 * @returns {Promise<{ risen: number, surfaced: boolean }>} Height gained and whether the bot is back on the surface
 */
async function climbTowardsSurface(bot, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const startY = bot.entity.position.y;
  let legStartY = startY;

  while (isBelowSurface(bot) && deadline - Date.now() >= MIN_CLIMB_LEG_MS) {
    // Short legs keep each path search fast; the last one stops at the estimated surface instead of overshooting it
    const legGoalY = Math.min(Math.floor(legStartY) + SURFACE_CLIMB_LEG, Math.max(Math.floor(legStartY) + 2, estimateSurfaceY(bot)));
    await trySurfaceAscent(bot, Math.min(SURFACE_CLIMB_LEG_MAX_MS, deadline - Date.now()), legGoalY);
    const nowY = bot.entity.position.y;
    // A leg that gained nothing will not do better on a second try: let the caller search another way
    if (nowY < legStartY + 2) break;
    legStartY = nowY;
  }

  return { risen: bot.entity.position.y - startY, surfaced: !isBelowSurface(bot) };
}

/**
 * Tell whether an exploration target is only found on the surface (trees, animals, wood products)
 * @param {string} cleanTarget Normalized exploration target
 * @returns {boolean} True when the bot must be on the surface to find it
 */
function isSurfaceTarget(cleanTarget) {
  if (!cleanTarget) return false;
  return SURFACE_TARGETS.has(cleanTarget) || isWoodLog(cleanTarget) || isPlanks(cleanTarget) || cleanTarget === 'stick';
}

/**
 * Dig a descending staircase towards the altitude where a wanted ore is most common
 * @param {object} bot Mineflayer bot instance
 * @param {number} targetY Altitude to reach
 * @param {number} [timeoutMs=26000] Maximum descent duration for this step
 * @returns {Promise<boolean>} True if the bot ended at least two blocks lower
 */
async function descendTowardsDepth(bot, targetY, timeoutMs = 26000) {
  if (!bot.entity?.position || typeof bot.pathfinder?.goto !== 'function') return false;
  const startX = bot.entity.position.x;
  const startY = bot.entity.position.y;
  const startZ = bot.entity.position.z;
  if (currentExploreHeadingRad === null) {
    currentExploreHeadingRad = (crypto.randomInt(0, 360) * Math.PI) / 180;
  }

  // A sloped tunnel rather than a vertical shaft: safer around lava pockets and easy to climb back out
  const drop = Math.min(10, Math.max(3, Math.round(startY - targetY)));
  const stepY = Math.round(startY) - drop;
  const run = drop + 2;
  const goalX = Math.round(startX + Math.cos(currentExploreHeadingRad) * run);
  const goalZ = Math.round(startZ + Math.sin(currentExploreHeadingRad) * run);

  let navTimer = null;
  let gotoPromise = null;
  try {
    console.log(`[EXPLORE] Digging a staircase down to Y:${stepY} (ore level Y:${targetY})...`);
    gotoPromise = bot.pathfinder.goto(new goals.GoalNear(goalX, stepY, goalZ, 2));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error("Descent timeout")), timeoutMs);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[EXPLORE] Descent impeded:', err.message);
    currentExploreHeadingRad = (currentExploreHeadingRad + Math.PI * 0.5) % (Math.PI * 2);
  } finally {
    if (navTimer) clearTimeout(navTimer);
    gotoPromise?.catch(() => {});
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }
  return bot.entity.position.y <= startY - 2;
}

/**
 * Navigate incrementally towards a detected lava pool using short waypoints to prevent pathfinder timeouts
 * @param {object} bot Mineflayer bot instance
 * @param {object} lavaBlock Detected lava source block
 * @returns {Promise<{ reached: boolean, skip?: boolean, message?: string }>} Step outcome
 */
async function stepTowardsLava(bot, lavaBlock) {
  const pos = bot.entity.position;
  const lavaPos = lavaBlock.position;
  const dx = lavaPos.x - pos.x;
  const dy = lavaPos.y - pos.y;
  const dz = lavaPos.z - pos.z;
  const dist = Math.hypot(dx, dy, dz);
  const horizDist = Math.hypot(dx, dz);

  if (Math.abs(dy) > 6 && !hasToolType(bot, '_pickaxe')) {
    return { reached: false, skip: true };
  }

  let goalPos = lavaPos;
  let goalRadius = 3;
  if (dist > 10 || Math.abs(dy) > 6) {
    const stepScale = horizDist > 8 ? 8 / horizDist : 1;
    const stepX = Math.round(pos.x + dx * stepScale);
    const stepZ = Math.round(pos.z + dz * stepScale);
    let stepY = lavaPos.y;
    if (dy < -4) stepY = Math.round(pos.y) - 4;
    else if (dy > 4) stepY = Math.round(pos.y) + 4;
    goalPos = new Vec3(stepX, stepY, stepZ);
    goalRadius = 2;
  }

  let lavaNavTimer = null;
  try {
    const { GoalNear } = goals;
    console.log(`[EXPLORE] Stepping towards lava source via (${goalPos.x}, ${goalPos.y}, ${goalPos.z})...`);
    const gotoPromise = bot.pathfinder.goto(new GoalNear(goalPos.x, goalPos.y, goalPos.z, goalRadius));
    const timeoutPromise = new Promise((_, reject) => {
      lavaNavTimer = setTimeout(() => reject(new Error("Exploration timeout towards lava")), 18000);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
    const closeEnough = bot.entity.position.distanceTo(lavaPos) <= 10;
    return {
      reached: true,
      message: closeEnough ? "Located lava source nearby; ready to execute 'portal'." : "Stepped closer towards lava source."
    };
  } catch (error) {
    console.warn("Lava exploration impeded :", error.message);
    markLavaClusterBad(bot, lavaPos, 8);
    return { reached: false, skip: false };
  } finally {
    if (lavaNavTimer) clearTimeout(lavaNavTimer);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }
}

/**
 * Build a pathfinder goal satisfied once the bot reaches or goes below a target altitude
 * @param {number} targetY Maximum altitude considered as goal
 * @returns {object} Pathfinder-compatible goal object
 */
function createMaxYGoal(targetY) {
  return {
    heuristic: (node) => Math.max(0, node.y - targetY),
    isEnd: (node) => node.y <= targetY,
    hasChanged: () => false,
    isValid: () => true
  };
}

/**
 * Dig and walk downwards towards deep cave layers where lava pools are abundant
 * @param {object} bot Mineflayer bot instance
 * @param {number} timeoutMs Maximum descent duration in milliseconds
 * @returns {Promise<boolean>} True if the bot dropped at least a few blocks
 */
async function descendTowardsLavaDepth(bot, timeoutMs) {
  const startY = Math.floor(bot.entity.position.y);
  const targetY = Math.max(LAVA_DEPTH_TARGET_Y, startY - LAVA_DESCENT_STEP);
  let navTimer = null;
  let gotoPromise = null;
  console.log(`[EXPLORE] No lava found nearby; descending from Y:${startY} towards Y:${targetY} (deep lava layer)...`);
  try {
    gotoPromise = bot.pathfinder.goto(createMaxYGoal(targetY));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error('Descent timeout')), timeoutMs);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[EXPLORE] Descent impeded:', err.message);
  } finally {
    if (navTimer) clearTimeout(navTimer);
    gotoPromise?.catch(() => {});
    bot.pathfinder?.setGoal?.(null);
    bot.clearControlStates?.();
  }
  return Math.floor(bot.entity.position.y) <= startY - 3;
}

/**
 * Travel towards the nearest remembered lava source when none is currently loaded nearby
 * @param {object} bot Mineflayer bot instance
 * @param {number} timeoutMs Maximum travel duration in milliseconds
 * @returns {Promise<string|null>} Success message or null if no progress was made
 */
async function travelToKnownLava(bot, timeoutMs) {
  const dimension = bot.game?.dimension || 'overworld';
  const pos = bot.entity.position;
  const known = getKnownLava(pos, dimension)[0];
  if (!known || timeoutMs < 5000) return null;

  const dist = known.position.distanceTo(pos);
  if (dist > KNOWN_LAVA_MAX_TRAVEL) return null;

  const { x, y, z } = known.position;
  console.log(`[EXPLORE] Returning to remembered lava at (${x}, ${y}, ${z}), ${Math.round(dist)} blocks away...`);
  if (dist <= 40) {
    const outcome = await stepTowardsLava(bot, { position: known.position });
    return outcome.reached ? outcome.message : null;
  }

  const dx = x - pos.x;
  const dz = z - pos.z;
  const horiz = Math.hypot(dx, dz) || 1;
  const waypointX = Math.round(pos.x + (dx / horiz) * 24);
  const waypointZ = Math.round(pos.z + (dz / horiz) * 24);
  try {
    await moveExploreStep(bot, waypointX, waypointZ, false, Math.min(14000, timeoutMs - 2000));
  } catch (err) {
    console.warn('[EXPLORE] Travel to remembered lava impeded:', err.message);
  }
  const moved = Math.hypot(bot.entity.position.x - pos.x, bot.entity.position.z - pos.z);
  if (moved >= 6) return `Travelling back towards remembered lava at (${x}, ${y}, ${z}).`;
  forgetLava(known.position, 2);
  return null;
}

/**
 * Locate a nearby reachable water source block within exploration range
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxDistance=64] Maximum search radius
 * @returns {object|null} Water source block or null
 */
function findNearbyWaterForExplore(bot, maxDistance = 64) {
  const waterId = bot.registry?.blocksByName?.water?.id;
  if (!waterId || typeof bot.findBlock !== 'function') return null;

  const isEligibleWater = (block) => Boolean(
    block?.position &&
    block.type === waterId &&
    (!block.metadata || block.metadata === 0) &&
    !isBadBlock(block.position)
  );

  const immediateWater = bot.findBlock({ matching: isEligibleWater, maxDistance: 8 });
  if (immediateWater) return immediateWater;

  const surfaceWater = bot.findBlock({
    matching: (block) => {
      if (!isEligibleWater(block)) return false;
      const above = bot.blockAt(block.position.offset(0, 1, 0));
      return !above || above.name === 'air' || above.name === 'cave_air';
    },
    maxDistance
  });
  return surfaceWater || bot.findBlock({ matching: isEligibleWater, maxDistance });
}

/**
 * Navigate incrementally towards a detected water source and fill an empty bucket when within reach
 * @param {object} bot Mineflayer bot instance
 * @param {object} waterBlock Detected water source block
 * @returns {Promise<{ reached: boolean, message?: string }>} Step outcome
 */
async function stepTowardsWater(bot, waterBlock) {
  const pos = bot.entity.position;
  const startSnapshot = { x: pos.x, y: pos.y, z: pos.z };
  const waterPos = waterBlock.position;
  const dx = waterPos.x - pos.x;
  const dy = waterPos.y - pos.y;
  const dz = waterPos.z - pos.z;
  const dist = Math.hypot(dx, dy, dz);
  const horizDist = Math.hypot(dx, dz);

  let goalPos = waterPos;
  const goalRadius = 2;
  if (dist > 12 || Math.abs(dy) > 8) {
    const stepScale = horizDist > 10 ? 10 / horizDist : 1;
    const stepX = Math.round(pos.x + dx * stepScale);
    const stepZ = Math.round(pos.z + dz * stepScale);
    let stepY = waterPos.y;
    if (dy < -6) stepY = Math.round(pos.y) - 6;
    else if (dy > 6) stepY = Math.round(pos.y) + 6;
    goalPos = new Vec3(stepX, stepY, stepZ);
  }

  let navTimer = null;
  try {
    const { GoalNear } = goals;
    console.log(`[EXPLORE] Stepping towards water source via (${goalPos.x}, ${goalPos.y}, ${goalPos.z})...`);
    const gotoPromise = bot.pathfinder.goto(new GoalNear(goalPos.x, goalPos.y, goalPos.z, goalRadius));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error("Exploration timeout towards water")), 16000);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } catch (error) {
    console.warn("Water exploration impeded :", error.message);
  } finally {
    if (navTimer) clearTimeout(navTimer);
    bot.pathfinder?.setGoal?.(null);
    bot.clearControlStates?.();
  }

  const afterPos = bot.entity.position;
  const distAfter = Math.hypot(waterPos.x - afterPos.x, waterPos.y - afterPos.y, waterPos.z - afterPos.z);

  if (distAfter <= 32) {
    if (countItem(bot, 'bucket') === 0 && countItem(bot, 'lava_bucket') > 0) {
      await emptyLavaBucketSafely(bot);
    }
    if (countItem(bot, 'bucket') > 0 && countItem(bot, 'water_bucket') === 0) {
      const scoopRes = await fillBucketFromSource(bot, 'water');
      if (scoopRes.success) {
        return { reached: true, message: scoopRes.message };
      }
    }
  }

  if (distAfter <= 10) {
    return { reached: true, message: "Located water source nearby; ready to fill 'water_bucket'." };
  }
  const movedDist = Math.hypot(afterPos.x - startSnapshot.x, afterPos.y - startSnapshot.y, afterPos.z - startSnapshot.z);
  if (movedDist >= 3) {
    return { reached: true, message: "Stepped closer towards water source." };
  }
  return { reached: false };
}

/**
 * Explore surroundings by walking towards outward coordinates or nearby portal targets
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} [state=null] Global bot state
 * @param {string|null} [target=null] Optional exploration target hint
 * @returns {Promise<{ success: boolean, message: string }>} Result of exploration movement
 */
async function skillExplore(bot, state = null, target = null) {
  const exploreStartMs = Date.now();
  const remainingMs = () => EXPLORE_BUDGET_MS - (Date.now() - exploreStartMs);
  const startPos = bot.entity.position;
  const isUnderground = startPos.y < 62;
  const isEnclosed = isUnderground || hasSolidCeilingAbove(bot);

  console.log(
    `[EXPLORE] Pos=(${Math.round(startPos.x)},${Math.round(startPos.y)},${Math.round(startPos.z)}) enclosed=${isEnclosed} inWater=${Boolean(bot.entity.isInWater)} pickaxe=${hasToolType(bot, '_pickaxe')}`
  );

  const cleanTarget = typeof target === 'string' ? target.toLowerCase().trim() : '';

  // Relocation request: leave the spawn area in a straight line when still inside it (the server may refuse
  // any building there), otherwise turn well away from the direction that led to the dead end
  const leavingSpawn = cleanTarget === 'leave_spawn';
  if (cleanTarget === 'relocate' || leavingSpawn) {
    const awayFromSpawn = getHeadingAwayFromSpawn(bot, leavingSpawn ? 64 : 24);
    if (awayFromSpawn === null) {
      const turn = Math.PI * (0.6 + crypto.randomInt(0, 81) / 100);
      currentExploreHeadingRad = ((currentExploreHeadingRad ?? 0) + turn) % (Math.PI * 2);
    } else {
      currentExploreHeadingRad = (awayFromSpawn + Math.PI * 2) % (Math.PI * 2);
    }
    recentExplorePositions = [];
    console.log(`[EXPLORE] Relocation requested; ${awayFromSpawn === null ? 'heading turned away from the previous area' : 'walking straight away from the world spawn'}.`);
  }

  // Wanted ore not loaded nearby: dig down to the altitude where it generates instead of wandering on the surface
  const inOverworld = String(bot.game?.dimension || 'overworld').includes('overworld');
  const oreDepth = inOverworld ? getOreDepthHint(cleanTarget) : null;
  if (oreDepth !== null && startPos.y > oreDepth + 6 && hasToolType(bot, '_pickaxe')) {
    const descended = await descendTowardsDepth(bot, oreDepth, Math.min(26000, remainingMs() - 4000));
    if (descended) {
      return {
        success: true,
        message: `Dug down towards Y:${oreDepth} where '${cleanTarget}' is most common (now at Y:${Math.round(bot.entity.position.y)}).`
      };
    }
  }

  // Trees and animals only exist on the surface: from the bottom of a mine or a cave, wandering through the
  // galleries finds nothing, so climb back up (through the existing tunnels or by digging a staircase) first
  if (inOverworld && isSurfaceTarget(cleanTarget) && isBelowSurface(bot) && remainingMs() >= MIN_CLIMB_LEG_MS + 2000) {
    const ascent = await climbTowardsSurface(bot, remainingMs() - 2000);
    if (ascent.risen >= 2) {
      const nowY = Math.round(bot.entity.position.y);
      return {
        success: true,
        message: ascent.surfaced
          ? `Back on the surface (Y:${nowY}) to look for '${cleanTarget}'.`
          : `Climbed ${Math.round(ascent.risen)} blocks towards the surface to look for '${cleanTarget}' (now Y:${nowY}, keep climbing).`
      };
    }
    console.warn(`[EXPLORE] Could not climb towards the surface from Y:${Math.round(bot.entity.position.y)}; exploring the galleries instead.`);
  }

  if (bot.game?.dimension !== 'the_nether') {
    const visibleLava = findNearbyLavaForExplore(bot, 56);
    if (visibleLava?.position) {
      rememberLava(visibleLava.position, bot.game?.dimension || 'overworld');
    }
  }

  let attemptedAscent = false;
  let climbedToSurface = false;
  const needsWaterForPortal = Boolean(
    bot.game?.dimension !== 'the_nether' &&
    state?.currentObjective === 'nether_portal' &&
    countItem(bot, 'water_bucket') === 0 &&
    countItem(bot, 'obsidian') < 10 &&
    (countItem(bot, 'bucket') > 0 || countItem(bot, 'lava_bucket') > 0)
  );
  const seekingWater = bot.game?.dimension !== 'the_nether' && (
    cleanTarget === 'water' ||
    cleanTarget === 'water_bucket' ||
    needsWaterForPortal
  );
  const seekingDiamond = bot.game?.dimension !== 'the_nether' && (
    cleanTarget === 'diamond' ||
    cleanTarget === 'diamond_ore' ||
    cleanTarget === 'deepslate_diamond_ore'
  );
  const seekingSurface = bot.game?.dimension !== 'the_nether' && !seekingWater && !seekingDiamond && (
    cleanTarget.includes('log') ||
    cleanTarget === 'tree' ||
    cleanTarget === 'wood' ||
    cleanTarget === 'planks' ||
    cleanTarget === 'crafting_table' ||
    cleanTarget === 'base'
  );
  const seekingLava = bot.game?.dimension !== 'the_nether' && !seekingWater && !seekingDiamond && !seekingSurface && (
    state?.currentObjective === 'nether_portal' || (cleanTarget === 'lava' && !state?.currentObjective)
  );

  if (seekingWater) {
    if (countItem(bot, 'bucket') === 0 && countItem(bot, 'lava_bucket') > 0) {
      await emptyLavaBucketSafely(bot);
    }
    const waterBlock = findNearbyWaterForExplore(bot, 64);
    if (waterBlock?.position) {
      const waterOutcome = await stepTowardsWater(bot, waterBlock);
      if (waterOutcome.reached) {
        return { success: true, message: waterOutcome.message };
      }
    } else if (isUnderground && remainingMs() >= 15000) {
      attemptedAscent = true;
      if (await trySurfaceAscent(bot, 14000)) {
        climbedToSurface = true;
        if (bot.entity.position.y < 62) {
          return { success: true, message: "Climbed closer to surface to search for water." };
        }
      }
    }
  }

  if (seekingDiamond && hasToolType(bot, '_pickaxe') && !bot.entity?.isInWater && bot.entity.position.y > LAVA_DEPTH_TARGET_Y + 2 && remainingMs() >= 10000) {
    if (await descendTowardsLavaDepth(bot, Math.min(24000, remainingMs() - 2000))) {
      return {
        success: true,
        message: `Descended to Y:${Math.round(bot.entity.position.y)} to search deep deepslate layers for diamond_ore.`
      };
    }
  }

  if (seekingLava) {
    const lavaBlock = findNearbyLavaForExplore(bot, 56);
    if (lavaBlock?.position) {
      lavaSearchMisses = 0;
      rememberLava(lavaBlock.position, bot.game?.dimension || 'overworld');
      const stepOutcome = await stepTowardsLava(bot, lavaBlock);
      if (stepOutcome.reached) {
        return { success: true, message: stepOutcome.message };
      }
    } else {
      const memoryMessage = await travelToKnownLava(bot, remainingMs());
      if (memoryMessage) {
        return { success: true, message: memoryMessage };
      }
      lavaSearchMisses += 1;
      const canDescend = hasToolType(bot, '_pickaxe') &&
        !bot.entity?.isInWater &&
        bot.entity.position.y > LAVA_DEPTH_TARGET_Y + 2 &&
        lavaSearchMisses >= LAVA_MISSES_BEFORE_DESCENT &&
        remainingMs() >= 10000;
      if (canDescend && await descendTowardsLavaDepth(bot, Math.min(24000, remainingMs() - 2000))) {
        return {
          success: true,
          message: `Descended to Y:${Math.round(bot.entity.position.y)} to search deep caves for lava (lava is abundant below Y:-50).`
        };
      }
    }

    if (bot.entity?.isInWater) {
      const reachedLand = await swimToDryLand(bot, 48);
      if (reachedLand) {
        return { success: true, message: "Swam out of water onto dry land to continue searching for lava." };
      }
    }

    if (isUnderground && !hasToolType(bot, '_pickaxe') && remainingMs() >= 15000) {
      attemptedAscent = true;
      const climbed = await trySurfaceAscent(bot, 14000);
      if (climbed) {
        climbedToSurface = true;
        if (bot.entity.position.y < 62) {
          return { success: true, message: "Climbed closer to surface to search for lava pools." };
        }
      }
    }
  }

  if (seekingSurface && isUnderground && remainingMs() >= 10000) {
    attemptedAscent = true;
    if (await trySurfaceAscent(bot, Math.min(28000, remainingMs() - 2000))) {
      climbedToSurface = true;
      if (bot.entity.position.y < 62) {
        return { success: true, message: "Climbed closer to surface to search for surface resources." };
      }
    }
  }

  const curPos = bot.entity.position;
  recentExplorePositions.push({ x: curPos.x, z: curPos.z });
  if (recentExplorePositions.length > EXPLORE_WINDOW_SIZE) {
    recentExplorePositions.shift();
  }

  const trappedInBox = isBoxStuck(recentExplorePositions, 4, 32);
  if (currentExploreHeadingRad === null) {
    currentExploreHeadingRad = (crypto.randomInt(0, 360) * Math.PI) / 180;
  } else if (trappedInBox) {
    currentExploreHeadingRad = (currentExploreHeadingRad + Math.PI * 0.5) % (Math.PI * 2);
    recentExplorePositions = [{ x: curPos.x, z: curPos.z }];
    console.log("[EXPLORE] Box trap detected (<32x32 over 4+ cycles); rotating +90 deg & enabling dig breakout.");
  } else if (!leavingSpawn) {
    const deltaRad = (crypto.randomInt(-20, 21) * Math.PI) / 180;
    currentExploreHeadingRad = ((currentExploreHeadingRad + deltaRad) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  }

  const allowDig = isEnclosed || trappedInBox;
  let distance = allowDig ? crypto.randomInt(12, 18) : crypto.randomInt(16, 24);
  // One stride long enough to clear the protected radius instead of several short ones
  if (leavingSpawn) distance = 28;
  const targetX = Math.round(curPos.x + Math.cos(currentExploreHeadingRad) * distance);
  const targetZ = Math.round(curPos.z + Math.sin(currentExploreHeadingRad) * distance);
  const stepOrigin = { x: curPos.x, z: curPos.z };

  console.log(`[EXPLORE] Moving towards X:${targetX}, Z:${targetZ}...`);

  try {
    const stepTimeout = Math.min(12000, Math.max(4000, remainingMs()));
    await moveExploreStep(bot, targetX, targetZ, !allowDig, stepTimeout);
    return { success: true, message: "Exploratory movement completed to new zone." };
  } catch (error) {
    let lastError = error;
    const nowPos = bot.entity.position;
    if (Math.hypot(nowPos.x - stepOrigin.x, nowPos.z - stepOrigin.z) >= 8) {
      return { success: true, message: "Advanced towards new exploration zone." };
    }

    console.warn("Exploration impeded :", error.message);
    currentExploreHeadingRad = (currentExploreHeadingRad + Math.PI * 0.22) % (Math.PI * 2);

    if (remainingMs() >= 10000) {
      const fallbackX = Math.round(nowPos.x + Math.cos(currentExploreHeadingRad) * 12);
      const fallbackZ = Math.round(nowPos.z + Math.sin(currentExploreHeadingRad) * 12);
      try {
        const retryTimeout = Math.min(12000, remainingMs() - 2000);
        await moveExploreStep(bot, fallbackX, fallbackZ, false, retryTimeout);
        return { success: true, message: "Exploratory movement completed along alternate route." };
      } catch (retryErr) {
        const postRetryPos = bot.entity.position;
        if (Math.hypot(postRetryPos.x - stepOrigin.x, postRetryPos.z - stepOrigin.z) >= 8) {
          return { success: true, message: "Advanced along alternate exploration route." };
        }
        lastError = retryErr;
      }
    }

    const keepDepthForLava = (seekingLava || seekingDiamond) && hasToolType(bot, '_pickaxe');
    if (isUnderground && !attemptedAscent && !keepDepthForLava && remainingMs() >= 13000 && await trySurfaceAscent(bot, 11000)) {
      return { success: true, message: "Climbed closer to surface while exploring." };
    }

    if (remainingMs() >= 4500) {
      const burstTicks = Math.min(70, Math.max(25, Math.floor((remainingMs() - 1000) / 50)));
      if (await walkForwardBurst(bot, currentExploreHeadingRad, burstTicks)) {
        currentExploreHeadingRad = (currentExploreHeadingRad + Math.PI * 0.25) % (Math.PI * 2);
        return { success: true, message: "Exploratory surface burst completed across rough terrain." };
      }
    }

    if (climbedToSurface) {
      return { success: true, message: "Climbed to surface and moved outward to search for lava." };
    }

    currentExploreHeadingRad = (currentExploreHeadingRad + Math.PI * 0.25) % (Math.PI * 2);
    return { success: false, message: `Movement blocked (${lastError.message}).` };
  }
}

module.exports = {
  skillUnstuck,
  skillExplore,
  isDiggableObstacle,
  findNearestDryLand,
  moveExploreStep,
  hasSolidCeilingAbove,
  climbTowardsSurface,
  isSurfaceTarget,
  hasDropAhead,
  getHeadingAwayFromSpawn,
  headingToMineflayerYaw,
  isBoxStuck,
  createMaxYGoal,
  descendTowardsLavaDepth,
  travelToKnownLava,
  tryPillarUp
};
