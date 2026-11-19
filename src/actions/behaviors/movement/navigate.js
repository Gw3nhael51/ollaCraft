const crypto = require('node:crypto');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../../../infrastructure/config');
const { getBestToolForBlock, isWoodLog, hasToolType } = require('../../../perception/inventory');
const { isBadBlock } = require('../../../perception/environment');
const { markLavaClusterBad } = require('../world/portal');

/**
 * Check whether an adjacent block can be dug quickly during an unstuck maneuver
 * @param {object|null} block Candidate block
 * @returns {boolean} True if block can be broken to escape
 */
function isDiggableObstacle(block) {
  if (!block?.name) return false;
  if (config.SOFT_BLOCKS.has(block.name)) return true;
  return block.name.endsWith('_leaves') || isWoodLog(block.name);
}

/**
 * Swim upwards recursively to reach water surface
 * @param {object} bot Mineflayer bot instance
 * @param {number} startTime Swimming start timestamp
 * @param {number} maxDurationMs Maximum swimming duration in milliseconds
 * @returns {Promise<void>}
 */
async function swimUpwardsStep(bot, startTime, maxDurationMs) {
  if (Date.now() - startTime >= maxDurationMs) return;

  await bot.waitForTicks(5);
  const currentEye = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  if (!currentEye || (currentEye.name !== 'water' && currentEye.name !== 'flowing_water')) {
    return;
  }

  await swimUpwardsStep(bot, startTime, maxDurationMs);
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

  if (isDiggableObstacle(sideEyeBlock)) {
    console.log(`[UNSTUCK] Passable wall found in direction (${dir.x}, ${dir.y}, ${dir.z}) : ${sideEyeBlock.name}. Digging escape path...`);
    try {
      const eyeTool = getBestToolForBlock(bot, sideEyeBlock);
      if (eyeTool) await bot.equip(eyeTool, 'hand').catch(() => {});
      await digWithTimeout(bot, sideEyeBlock, 8000);

      if (isDiggableObstacle(sideFeetBlock)) {
        const feetTool = getBestToolForBlock(bot, sideFeetBlock);
        if (feetTool) await bot.equip(feetTool, 'hand').catch(() => {});
        await digWithTimeout(bot, sideFeetBlock, 8000);
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
      if (!block?.position || !config.VALID_GROUND_BLOCKS.has(block.name)) return false;
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

  const eyeBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const isUnderwater = eyeBlock && (eyeBlock.name === 'water' || eyeBlock.name === 'flowing_water');

  // Swim urgently towards surface if submerged
  if (isUnderwater || bot.entity.isInWater) {
    console.log("[UNSTUCK] Bot is in water! Swimming urgently to surface...");
    bot.setControlState('jump', true);

    await swimUpwardsStep(bot, Date.now(), 8000);
    bot.setControlState('jump', false);
    const reachedLand = await swimToDryLand(bot, 36);
    return {
      success: true,
      message: reachedLand
        ? "Emergency surfacing completed and reached dry land."
        : "Emergency surfacing completed; swam towards shore."
    };
  }

  // Check and break ceiling if solid block obstructs above
  const headBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0));
  if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air') {
    console.log(`[UNSTUCK] Obstacle detected above head : ${headBlock.name}. Breaking it.`);
    try {
      const tool = getBestToolForBlock(bot, headBlock);
      if (tool) await bot.equip(tool, 'hand').catch(() => {});
      await bot.dig(headBlock);
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

  return { success: false, message: "Unable to dig an exit through immediate surrounding walls." };
}

const EXPLORE_WINDOW_SIZE = 6;
const EXPLORE_BUDGET_MS = 34000;
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
 * Walk forward in short safe slices while avoiding lava hazards ahead
 * @param {object} bot Mineflayer bot instance
 * @param {number} headingRad Heading angle in radians
 * @param {number} [remainingTicks=35] Remaining movement ticks
 * @returns {Promise<void>}
 */
async function walkForwardSlices(bot, headingRad, remainingTicks) {
  if (remainingTicks <= 0 || hasLavaAhead(bot, headingRad)) return;
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

const TERRAIN_CEILING_BLOCKS = new Set([
  'stone', 'dirt', 'grass_block', 'deepslate', 'granite', 'diorite', 'andesite',
  'gravel', 'sand', 'sandstone', 'tuff', 'cobblestone', 'cobbled_deepslate', 'netherrack'
]);

/**
 * Check whether solid terrain blocks sit above the bot, indicating an enclosed cave or overhang
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True when a solid terrain ceiling block is detected within 20 blocks above
 */
function hasSolidCeilingAbove(bot) {
  if (!bot.entity?.position || typeof bot.blockAt !== 'function') return false;
  const basePos = bot.entity.position.floored();
  for (let dy = 2; dy <= 20; dy++) {
    const block = bot.blockAt(basePos.offset(0, dy, 0));
    if (block && TERRAIN_CEILING_BLOCKS.has(block.name)) {
      return true;
    }
  }
  return false;
}

/**
 * Attempt to climb upwards toward surface elevation when deep underground
 * @param {object} bot Mineflayer bot instance
 * @param {number} [timeoutMs=14000] Maximum ascent wait in milliseconds
 * @returns {Promise<boolean>} True if ascent succeeded
 */
async function trySurfaceAscent(bot, timeoutMs = 14000) {
  if (!bot.entity?.position || !goals.GoalY) return false;
  let navTimer = null;
  let gotoPromise = null;
  const startX = bot.entity.position.x;
  const startZ = bot.entity.position.z;
  try {
    const targetY = Math.min(72, Math.round(bot.entity.position.y) + 10);
    console.log(`[EXPLORE] Underground path blocked; climbing towards Y:${targetY}...`);
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

  let attemptedAscent = false;
  let climbedToSurface = false;
  const seekingLava = state?.currentObjective === 'nether_portal' || target === 'lava';
  if (seekingLava) {
    const lavaBlock = findNearbyLavaForExplore(bot, 56);
    if (lavaBlock?.position) {
      const stepOutcome = await stepTowardsLava(bot, lavaBlock);
      if (stepOutcome.reached) {
        return { success: true, message: stepOutcome.message };
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
  } else {
    const deltaRad = (crypto.randomInt(-20, 21) * Math.PI) / 180;
    currentExploreHeadingRad = ((currentExploreHeadingRad + deltaRad) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  }

  const allowDig = isEnclosed || trappedInBox;
  const distance = allowDig ? crypto.randomInt(12, 18) : crypto.randomInt(16, 24);
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

    if (isUnderground && !attemptedAscent && remainingMs() >= 13000 && await trySurfaceAscent(bot, 11000)) {
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
  headingToMineflayerYaw,
  isBoxStuck
};
