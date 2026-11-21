const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../../../infrastructure/config');
const { countItem, getBestToolForBlock } = require('../../../perception/inventory');
const { markBadBlock, isBadBlock } = require('../../../perception/environment');
const { autoEquipArmorAndShield } = require('../items/equip');
const { freeInventorySlotIfFull } = require('../items/storage');
const { getDimension, getWaypoint, saveWaypoint } = require('../../../core/progress');
const { travelTowards } = require('../movement/waypoint');
const { ensureSpawnBed } = require('./bed');

// 'portal' targets meaning "go back to the Overworld" when the bot stands in the Nether
const RETURN_TARGETS = new Set(['overworld', 'return', 'back', 'home']);

const NON_SOLID_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire'
]);

const SCAFFOLD_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone',
  'netherrack', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'oak_planks',
  'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
  'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'sandstone'
];
const SCAFFOLD_BLOCK_SET = new Set(SCAFFOLD_BLOCKS);

/**
 * Count solid building blocks carried in inventory suitable for mold casting and bridging
 * @param {object} bot Mineflayer bot instance
 * @returns {number} Total count of carried scaffold-compatible building blocks
 */
function countScaffoldBlocks(bot) {
  if (!bot?.inventory || typeof bot.inventory.items !== 'function') return 0;
  return bot.inventory.items()
    .filter(item => SCAFFOLD_BLOCK_SET.has(item.name))
    .reduce((sum, item) => sum + item.count, 0);
}

const ADJACENT_DIRECTIONS = [
  new Vec3(0, -1, 0),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
  new Vec3(0, 1, 0)
];

// 11-block embedded portal sequence: 2 recessed floor blocks, left pillar + top-left corner, roof lintel, right pillar
const PORTAL_BUILD_STEPS = [
  { offset: new Vec3(0, 0, 0), isCorner: false },
  { offset: new Vec3(1, 0, 0), isCorner: false },
  { offset: new Vec3(-1, 1, 0), isCorner: false },
  { offset: new Vec3(-1, 2, 0), isCorner: false },
  { offset: new Vec3(-1, 3, 0), isCorner: false },
  { offset: new Vec3(-1, 4, 0), isCorner: true },
  { offset: new Vec3(0, 4, 0), isCorner: false },
  { offset: new Vec3(1, 4, 0), isCorner: false },
  { offset: new Vec3(2, 1, 0), isCorner: false },
  { offset: new Vec3(2, 2, 0), isCorner: false },
  { offset: new Vec3(2, 3, 0), isCorner: false }
];

/**
 * Locate the best reachable liquid source block (preferring immediate immersion or surface blocks)
 * @param {object} bot Mineflayer bot instance
 * @param {string} liquidName Target liquid block name ('water' or 'lava')
 * @returns {object|null} Located liquid source block or null
 */
function findReachableLiquidSource(bot, liquidName) {
  const blockId = bot.registry.blocksByName[liquidName]?.id;
  if (!blockId) return null;

  const isSource = (block) => Boolean(block && block.type === blockId && (!block.metadata || block.metadata === 0));
  const feetPos = bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position;
  const eyeBlock = bot.blockAt(feetPos.offset(0, 1, 0));
  if (isSource(eyeBlock)) return eyeBlock;
  const feetBlock = bot.blockAt(feetPos);
  if (isSource(feetBlock)) return feetBlock;

  const surfaceSource = bot.findBlock({
    matching: (block) => {
      if (!isSource(block)) return false;
      const above = block.position ? bot.blockAt(block.position.offset(0, 1, 0)) : null;
      return !above || above.name === 'air' || above.name === 'cave_air';
    },
    maxDistance: 36
  });

  return surfaceSource || bot.findBlock({ matching: isSource, maxDistance: 36 });
}

/**
 * Fill an empty bucket from a nearby water or lava source block
 * @param {object} bot Mineflayer bot instance
 * @param {string} liquidName Target liquid block name ('water' or 'lava')
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function fillBucketFromSource(bot, liquidName) {
  const bucketItem = bot.inventory.items().find(i => i.name === 'bucket');
  if (!bucketItem) {
    return { success: false, message: "No empty 'bucket' in inventory." };
  }

  const sourceBlock = findReachableLiquidSource(bot, liquidName);
  if (!sourceBlock) {
    return {
      success: false,
      message: `No '${liquidName}' source block found nearby. Use 'explore' to find ${liquidName}.`
    };
  }

  let navTimer = null;
  try {
    if (countItem(bot, 'bucket') > 1) {
      await freeInventorySlotIfFull(bot);
    }
    if (bot.entity.position.distanceTo(sourceBlock.position) > 3) {
      const { GoalNear } = goals;
      const gotoPromise = bot.pathfinder.goto(new GoalNear(sourceBlock.position.x, sourceBlock.position.y, sourceBlock.position.z, 2));
      const timeoutPromise = new Promise((_, reject) => {
        navTimer = setTimeout(() => reject(new Error(`Navigation timeout towards ${liquidName}`)), 15000);
      });
      await Promise.race([gotoPromise, timeoutPromise]);
    }

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    await bot.equip(bucketItem, 'hand');
    await bot.lookAt(sourceBlock.position.offset(0.5, 0.9, 0.5), true);
    await bot.waitForTicks(2);
    await bot.activateItem();
    await bot.waitForTicks(8);

    const expectedFilled = liquidName === 'water' ? 'water_bucket' : 'lava_bucket';
    if (countItem(bot, expectedFilled) === 0) {
      await bot.lookAt(sourceBlock.position.offset(0.5, 0.5, 0.5), true);
      await bot.waitForTicks(2);
      await bot.activateItem();
      await bot.waitForTicks(8);
    }

    if (countItem(bot, expectedFilled) === 0 && bot.entity?.position?.distanceTo && bot.entity.position.distanceTo(sourceBlock.position) > 2.4 && bot.pathfinder?.goto) {
      let closeTimer = null;
      try {
        const { GoalNear } = goals;
        const closePromise = bot.pathfinder.goto(new GoalNear(sourceBlock.position.x, sourceBlock.position.y, sourceBlock.position.z, 1));
        const closeTimeout = new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error(`Close navigation timeout towards ${liquidName}`)), 5000);
        });
        await Promise.race([closePromise, closeTimeout]).catch(() => {});
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
      }
      await bot.lookAt(sourceBlock.position.offset(0.5, 0.8, 0.5), true);
      await bot.waitForTicks(2);
      await bot.activateItem();
      await bot.waitForTicks(8);
    }

    if (countItem(bot, expectedFilled) > 0) {
      return { success: true, message: `Successfully filled '${expectedFilled}' from nearby ${liquidName} source.` };
    }

    return { success: false, message: `Attempted to scoop ${liquidName} but '${expectedFilled}' was not acquired.` };
  } catch (err) {
    return { success: false, message: `Failed to scoop ${liquidName} : ${err.message}` };
  } finally {
    if (navTimer) clearTimeout(navTimer);
  }
}

/**
 * Strike flint and steel against the bottom obsidian block of a portal frame
 * @param {object} bot Mineflayer bot instance
 * @param {object} flint Flint and steel item
 * @param {object} portalBasePos Bottom-left inner coordinate of the portal frame
 * @param {number|undefined} existingPortalId Nether portal block ID
 * @returns {Promise<object|null>} Newly created portal block or null
 */
async function strikePortalFrame(bot, flint, portalBasePos, existingPortalId) {
  const bottomObsidian = bot.blockAt(portalBasePos.offset(0, -1, 0));
  if (!bottomObsidian) return null;

  await moveNearPosition(bot, portalBasePos, 3.5, 2);
  await bot.equip(flint, 'hand');
  await bot.lookAt(bottomObsidian.position.offset(0.5, 1, 0.5), true);
  try {
    await bot.placeBlock(bottomObsidian, new Vec3(0, 1, 0));
  } catch {
    await bot.activateBlock(bottomObsidian).catch(() => {});
  }
  await bot.waitForTicks(10);
  return existingPortalId ? bot.findBlock({ matching: existingPortalId, maxDistance: 12 }) : null;
}

/**
 * Ignite a portal frame and stand inside until transported to the Nether
 * @param {object} bot Mineflayer bot instance
 * @param {object} portalBasePos Bottom-left inner coordinate of the portal frame
 * @param {string} [axis='x'] Horizontal orientation axis of the portal frame ('x' or 'z')
 * @param {object|null} [state=null] Global bot state (enables the spawn bed requirement and portal waypoints)
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function igniteAndEnterPortal(bot, portalBasePos, axis = 'x', state = null) {
  const existingPortalId = bot.registry.blocksByName.nether_portal?.id;
  let portalBlock = existingPortalId ? bot.findBlock({ matching: existingPortalId, maxDistance: 24 }) : null;

  if (!portalBlock && portalBasePos) {
    const flint = bot.inventory.items().find(i => i.name === 'flint_and_steel');
    if (!flint) {
      return { success: false, message: "Missing 'flint_and_steel' to ignite the Nether portal. Craft one first." };
    }
    await clearPortalInterior(bot, portalBasePos.offset(0, -1, 0), axis);
    portalBlock = await strikePortalFrame(bot, flint, portalBasePos, existingPortalId);
  }

  if (!portalBlock) {
    return { success: false, message: "Portal frame could not be ignited or no active 'nether_portal' found nearby." };
  }

  if (state) {
    // Remember where the portal is so the bot can come back to it after a death
    saveWaypoint(state, 'nether_portal', portalBlock.position, getDimension(bot), 'Nether portal (Overworld side)');

    // The respawn point must be set next to the portal before leaving the Overworld
    const bed = await ensureSpawnBed(bot, state, 'spawn_bed', { reuseRange: 48, acceptRemote: true });
    if (!bed.success) {
      return {
        success: false,
        message: `Nether portal is ready but a spawn bed is required before entering: ${bed.message}`
      };
    }
    if (bed.placed) console.log(`[PORTAL] ${bed.message}`);
  }

  let navTimer = null;
  try {
    console.log(`[PORTAL] Entering Nether portal at (${portalBlock.position.x}, ${portalBlock.position.y}, ${portalBlock.position.z})...`);
    const { GoalBlock } = goals;
    const gotoPromise = bot.pathfinder.goto(new GoalBlock(portalBlock.position.x, portalBlock.position.y, portalBlock.position.z));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error("Navigation timeout towards portal")), 12000);
    });
    await Promise.race([gotoPromise, timeoutPromise]).catch(() => {});

    // Wait inside portal block for dimension transition (up to 8 seconds)
    await bot.waitForTicks(160);

    if (getDimension(bot) === 'the_nether') {
      if (state && bot.entity?.position) {
        saveWaypoint(state, 'nether_exit', bot.entity.position, 'the_nether', 'Nether portal (Nether side)');
      }
      return { success: true, message: "Successfully transitioned into the Nether!" };
    }

    return { success: true, message: "Nether portal ignited and entered. Waiting for server dimension transfer." };
  } catch (err) {
    return { success: false, message: `Failed to enter Nether portal : ${err.message}` };
  } finally {
    if (navTimer) clearTimeout(navTimer);
  }
}

/**
 * Wait until the server has moved the bot into the expected dimension
 * @param {object} bot Mineflayer bot instance
 * @param {string} expectedDimension Normalized dimension name
 * @param {number} [ticksLeft=160] Remaining ticks to wait
 * @returns {Promise<boolean>} True once the bot is in the expected dimension
 */
async function waitForDimension(bot, expectedDimension, ticksLeft = 160) {
  if (getDimension(bot) === expectedDimension) return true;
  if (ticksLeft <= 0) return false;
  await bot.waitForTicks(10);
  return waitForDimension(bot, expectedDimension, ticksLeft - 10);
}

/**
 * Walk back to the Nether-side portal (nearby or memorized) and return to the Overworld
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Return trip step result
 */
async function returnToOverworld(bot, state) {
  const portalId = bot.registry.blocksByName.nether_portal?.id;
  const findPortal = (range) => (portalId ? bot.findBlock({ matching: portalId, maxDistance: range }) : null);

  let portalBlock = findPortal(64);
  if (!portalBlock) {
    const exitWaypoint = getWaypoint(state, 'nether_exit');
    if (!exitWaypoint) {
      return { success: false, message: "No Nether portal nearby and none memorized. Use 'explore' to find one or build a new one." };
    }
    const leg = await travelTowards(bot, exitWaypoint, { radius: 6, legDistance: 40, timeoutMs: 30000 });
    portalBlock = findPortal(48);
    if (!portalBlock) {
      return leg.arrived || leg.progressed
        ? { success: true, message: `Heading back to the Nether portal: ${Math.round(leg.remaining)} blocks remaining.` }
        : { success: false, message: `No progress towards the Nether portal (${leg.error || 'path blocked'}).` };
    }
  }

  let navTimer = null;
  try {
    console.log(`[PORTAL] Returning to the Overworld through (${portalBlock.position.x}, ${portalBlock.position.y}, ${portalBlock.position.z})...`);
    const gotoPromise = bot.pathfinder.goto(new goals.GoalBlock(portalBlock.position.x, portalBlock.position.y, portalBlock.position.z));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error("Navigation timeout towards portal")), 20000);
    });
    await Promise.race([gotoPromise, timeoutPromise]).catch(() => {});
  } finally {
    if (navTimer) clearTimeout(navTimer);
    bot.pathfinder.setGoal?.(null);
  }

  if (await waitForDimension(bot, 'overworld')) {
    if (state && bot.entity?.position) {
      saveWaypoint(state, 'nether_portal', bot.entity.position, 'overworld', 'Nether portal (Overworld side)');
    }
    return { success: true, message: 'Back in the Overworld through the Nether portal.' };
  }
  return { success: false, message: 'Reached the Nether portal but the dimension did not change yet; retry.' };
}

/**
 * Find any solid adjacent block and its opposite face vector to support block placement at targetPos
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetPos Target block coordinates
 * @returns {{ referenceBlock: object, faceVector: Vec3 }|null} Reference block and face or null
 */
function findPlacementReference(bot, targetPos) {
  for (const dir of ADJACENT_DIRECTIONS) {
    const neighborPos = targetPos.plus(dir);
    const neighbor = bot.blockAt(neighborPos);
    if (neighbor && !NON_SOLID_BLOCKS.has(neighbor.name)) {
      const refPosition = neighbor.position || neighborPos;
      return {
        referenceBlock: { ...neighbor, position: refPosition },
        faceVector: new Vec3(-dir.x, -dir.y, -dir.z)
      };
    }
  }
  return null;
}

/**
 * Select item to place for a portal step (obsidian for frame or top corner, scaffold fallback for corner)
 * @param {object} bot Mineflayer bot instance
 * @param {boolean} isCorner Whether current step is the top-left bridge corner
 * @param {number} remainingCoreBlocks Number of core obsidian blocks still needed
 * @returns {object|null} Inventory item to equip and place
 */
function selectFrameStepItem(bot, isCorner, remainingCoreBlocks) {
  const items = bot.inventory.items();
  const obsidianItem = items.find(i => i.name === 'obsidian');

  if (!isCorner) return obsidianItem || null;

  // Prefer obsidian for the 11th corner block when enough obsidian is carried
  if (countItem(bot, 'obsidian') > remainingCoreBlocks && obsidianItem) {
    return obsidianItem;
  }

  for (const scaffoldName of SCAFFOLD_BLOCKS) {
    const found = items.find(i => i.name === scaffoldName);
    if (found) return found;
  }

  return obsidianItem || null;
}

/**
 * Scoop placed water source back into an empty bucket
 * @param {object} bot Mineflayer bot instance
 * @param {object} waterLookPos Target position where water was placed
 * @returns {Promise<void>}
 */
async function retrieveWaterSource(bot, waterLookPos) {
  const emptyBucket = bot.inventory.items().find(i => i.name === 'bucket');
  if (!emptyBucket) return;

  await bot.equip(emptyBucket, 'hand');
  await bot.lookAt(waterLookPos, true);
  await bot.activateItem();
  await bot.waitForTicks(6);
}

/**
 * Mine newly formed obsidian block if a diamond or netherite pickaxe is available
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<boolean>} True if obsidian was mined
 */
async function tryMineFormedObsidian(bot) {
  const canMineObsidian = countItem(bot, 'diamond_pickaxe') > 0 || countItem(bot, 'netherite_pickaxe') > 0;
  if (!canMineObsidian) return false;

  const obsidianId = bot.registry.blocksByName.obsidian?.id;
  const formedObsidian = obsidianId ? bot.findBlock({ matching: obsidianId, maxDistance: 6 }) : null;
  if (!formedObsidian) return false;

  const pickaxe = getBestToolForBlock(bot, formedObsidian);
  if (pickaxe) await bot.equip(pickaxe, 'hand').catch(() => {});
  await bot.dig(formedObsidian);
  await bot.waitForTicks(8);
  return true;
}

/**
 * Orient an X-axis portal template vector onto either the X or Z horizontal axis
 * @param {object} vec Coordinate or face vector defined on the X axis
 * @param {string} [axis='x'] Target horizontal axis ('x' or 'z')
 * @returns {Vec3} Oriented vector
 */
function orientOffset(vec, axis = 'x') {
  if (axis === 'z') return new Vec3(vec.z, vec.y, vec.x);
  return new Vec3(vec.x, vec.y, vec.z);
}

/**
 * Check whether a portal frame at basePos has all 10 core obsidian blocks in place
 * @param {object} bot Mineflayer bot instance
 * @param {object} basePos Origin coordinate of the portal frame
 * @param {string} [axis='x'] Horizontal orientation axis of the portal frame ('x' or 'z')
 * @returns {boolean} True if all core obsidian blocks are present
 */
function hasCompletePortalFrame(bot, basePos, axis = 'x') {
  if (!basePos) return false;
  return PORTAL_BUILD_STEPS
    .filter(step => !step.isCorner)
    .every(step => bot.blockAt(basePos.plus(orientOffset(step.offset, axis)))?.name === 'obsidian');
}

/**
 * Evaluate a single candidate portal frame origin and axis against surrounding blocks
 * @param {object} bot Mineflayer bot instance
 * @param {Vec3} base Candidate portal frame base origin
 * @param {string} axis Candidate horizontal axis ('x' or 'z')
 * @param {Array<Vec3>} coreOffsets Normalized core portal obsidian offsets
 * @returns {object|null} Scored frame summary or null if blocked or insufficient obsidian
 */
function evaluateFrameCandidate(bot, base, axis, coreOffsets) {
  for (let x = 0; x <= 1; x++) {
    for (let y = 1; y <= 3; y++) {
      const innerName = bot.blockAt(base.plus(orientOffset(new Vec3(x, y, 0), axis)))?.name;
      if (innerName === 'obsidian' || innerName === 'bedrock') return null;
    }
  }

  let presentCount = 0;
  const missingOffsets = [];
  for (const off of coreOffsets) {
    const oriented = orientOffset(off, axis);
    if (bot.blockAt(base.plus(oriented))?.name === 'obsidian') {
      presentCount += 1;
    } else {
      missingOffsets.push(oriented);
    }
  }

  if (presentCount < 2) return null;
  return {
    base,
    axis,
    presentCount,
    missingCount: missingOffsets.length,
    missingOffsets,
    isComplete: missingOffsets.length === 0
  };
}

/**
 * Detect complete unlit or partial obsidian Nether portal frames on either X or Z axis
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxDistance=48] Maximum block search radius
 * @returns {{ base: Vec3, axis: string, presentCount: number, missingCount: number, missingOffsets: Array<Vec3>, isComplete: boolean }|null} Best matching frame candidate or null
 */
function findPortalFrameCandidate(bot, maxDistance = 48) {
  const obsidianId = bot.registry?.blocksByName?.obsidian?.id;
  if (!obsidianId) return null;

  let obsidianPositions = [];
  if (typeof bot.findBlocks === 'function') {
    obsidianPositions = bot.findBlocks({ matching: obsidianId, maxDistance, count: 40 });
  } else if (typeof bot.findBlock === 'function') {
    const found = bot.findBlock({ matching: obsidianId, maxDistance });
    if (found?.position) obsidianPositions = [found.position];
  }
  if (!Array.isArray(obsidianPositions) || obsidianPositions.length === 0) return null;

  const coreOffsets = PORTAL_BUILD_STEPS.filter(step => !step.isCorner).map(step => step.offset);
  const seenKeys = new Set();
  let bestCandidate = null;
  let bestDistance = Infinity;

  for (const rawPos of obsidianPositions) {
    const obsVec = new Vec3(rawPos.x, rawPos.y, rawPos.z);
    for (const axis of ['x', 'z']) {
      for (const coreOff of coreOffsets) {
        const base = obsVec.minus(orientOffset(coreOff, axis));
        const key = `${base.x},${base.y},${base.z},${axis}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const scored = evaluateFrameCandidate(bot, base, axis, coreOffsets);
        if (!scored) continue;

        const dist = bot.entity?.position?.distanceTo ? bot.entity.position.distanceTo(base) : 0;
        if (
          !bestCandidate ||
          scored.presentCount > bestCandidate.presentCount ||
          (scored.presentCount === bestCandidate.presentCount && dist < bestDistance)
        ) {
          bestCandidate = scored;
          bestDistance = dist;
        }
      }
    }
  }

  return bestCandidate;
}

/**
 * Clear solid non-obsidian obstructions from the 2x3 doorway interior before portal ignition
 * @param {object} bot Mineflayer bot instance
 * @param {object} basePos Bottom-left frame origin
 * @param {string} [axis='x'] Horizontal orientation axis of the portal frame ('x' or 'z')
 * @returns {Promise<void>}
 */
async function clearPortalInterior(bot, basePos, axis = 'x') {
  if (!basePos) return;
  const interiorSteps = [];
  for (let y = 1; y <= 3; y++) {
    for (let x = 0; x <= 1; x++) {
      interiorSteps.push({
        offset: orientOffset(new Vec3(x, y, 0), axis),
        stand: orientOffset(new Vec3(x, 1, 2), axis)
      });
    }
  }
  await clearMoldSpaces(bot, basePos, interiorSteps, 0);
}

/**
 * Navigate near a target coordinate under a bounded timeout
 * @param {object} bot Mineflayer bot instance
 * @param {object} pos Target block coordinates
 * @param {number} [maxDist=4.2] Distance threshold before triggering pathfinder
 * @param {number} [goalRadius=2] Pathfinder GoalNear radius
 * @returns {Promise<void>}
 */
async function moveNearPosition(bot, pos, maxDist = 4.2, goalRadius = 2) {
  if (!pos || !bot.entity?.position?.distanceTo || !bot.pathfinder?.goto) return;
  if (bot.entity.position.distanceTo(pos) <= maxDist) return;

  let navTimer = null;
  try {
    const { GoalNear } = goals;
    const gotoPromise = bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, goalRadius));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error("Navigation timeout during portal assembly")), 10000);
    });
    await Promise.race([gotoPromise, timeoutPromise]).catch(() => {});
  } finally {
    if (navTimer) clearTimeout(navTimer);
    bot.pathfinder.setGoal?.(null);
    bot.clearControlStates?.();
  }
}

/**
 * Mark an unreachable or unbuildable lava pool cluster as bad so subsequent cycles skip it
 * @param {object} bot Mineflayer bot instance
 * @param {object} centerPos Center lava block coordinates
 * @param {number} [radius=8] Cluster marking radius
 */
function markLavaClusterBad(bot, centerPos, radius = 8) {
  if (!centerPos) return;
  markBadBlock(centerPos);
  if (typeof bot?.blockAt !== 'function') return;

  const lavaNames = new Set(['lava', 'flowing_lava']);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = new Vec3(centerPos.x + dx, centerPos.y + dy, centerPos.z + dz);
        const block = bot.blockAt(pos);
        if (block && lavaNames.has(block.name)) {
          markBadBlock(pos);
        }
      }
    }
  }
}

/**
 * Score and locate the best accessible lava pool source block nearby
 * @param {object} bot Mineflayer bot instance
 * @returns {object|null} Best lava source block or null
 */
function findBestLavaPool(bot) {
  const lavaId = bot.registry?.blocksByName?.lava?.id;
  if (!lavaId) return null;

  const isLavaSource = (block) => Boolean(
    block?.type === lavaId &&
    (!block.metadata || block.metadata === 0) &&
    (!block.position || !isBadBlock(block.position))
  );
  let candidates = [];

  if (typeof bot.findBlocks === 'function') {
    candidates = bot.findBlocks({ matching: isLavaSource, maxDistance: 64, count: 60 });
  } else if (typeof bot.findBlock === 'function') {
    const found = bot.findBlock({ matching: isLavaSource, maxDistance: 64 });
    if (found?.position) candidates = [found.position];
  }

  if (candidates.length === 0) return null;

  let bestPos = null;
  let bestScore = -Infinity;

  for (const pos of candidates) {
    if (isBadBlock(pos)) continue;
    const above = bot.blockAt(pos.offset(0, 1, 0));
    const isSurface = !above || above.name === 'air' || above.name === 'cave_air';
    const isSameLevel = bot.entity?.position ? Math.abs(pos.y - bot.entity.position.y) <= 12 : true;
    let poolSize = 0;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const neighbor = bot.blockAt(pos.offset(dx, 0, dz));
        if (isLavaSource(neighbor)) poolSize += 1;
      }
    }

    const dist = bot.entity?.position?.distanceTo ? bot.entity.position.distanceTo(pos) : 0;
    const score = (isSameLevel ? 40 : 0) + (isSurface ? 20 : 0) + (poolSize >= 6 ? 15 : 0) + poolSize * 2 - dist * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }
  }

  return bestPos ? bot.blockAt(bestPos) : null;
}

/**
 * Verify whether a candidate origin basePos near a lava pool is safe and clear for mold casting
 * @param {object} bot Mineflayer bot instance
 * @param {object} basePos Candidate portal mold origin
 * @returns {boolean} True if ground, stand area, and volume are valid
 */
function isValidCastOrigin(bot, basePos) {
  const isLiquid = (name) => ['lava', 'flowing_lava', 'water', 'flowing_water'].includes(name);
  const isSolid = (pos) => {
    const block = bot.blockAt(pos);
    return Boolean(block && !NON_SOLID_BLOCKS.has(block.name) && block.name !== 'bedrock');
  };
  const isStandClear = (pos) => {
    const block = bot.blockAt(pos);
    if (!block) return true;
    if (isLiquid(block.name)) return false;
    return block.name === 'air' || block.name === 'cave_air' || block.boundingBox === 'empty';
  };
  const isLiquidOrBedrock = (pos) => {
    const name = bot.blockAt(pos)?.name;
    return name === 'lava' || name === 'flowing_lava' || name === 'bedrock';
  };

  const floorOffsets = [
    new Vec3(0, 0, 0), new Vec3(1, 0, 0),
    new Vec3(0, -1, 0), new Vec3(1, -1, 0)
  ];
  if (!floorOffsets.every(off => isSolid(basePos.plus(off)))) return false;

  const standCoords = [new Vec3(0, 0, 2), new Vec3(1, 0, 2)];
  const hasValidStand = standCoords.some(s => (
    isSolid(basePos.plus(s)) &&
    isStandClear(basePos.plus(s).offset(0, 1, 0)) &&
    isStandClear(basePos.plus(s).offset(0, 2, 0))
  ));
  if (!hasValidStand) return false;

  for (let x = -1; x <= 2; x++) {
    for (let y = 1; y <= 4; y++) {
      for (let z = -1; z <= 0; z++) {
        if (isLiquidOrBedrock(basePos.offset(x, y, z))) return false;
      }
    }
  }

  return true;
}

/**
 * Find the closest valid solid ground origin near a lava pool for building the casting mold
 * @param {object} bot Mineflayer bot instance
 * @param {object} lavaPos Reference lava source coordinates
 * @returns {object|null} Portal base origin coordinate or null
 */
function findCastOriginNearLava(bot, lavaPos) {
  if (!lavaPos) return null;

  const candidates = [];
  for (let dy = -2; dy <= 3; dy++) {
    for (let dx = -14; dx <= 14; dx++) {
      for (let dz = -14; dz <= 14; dz++) {
        if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
        const candidate = new Vec3(lavaPos.x + dx, lavaPos.y + dy, lavaPos.z + dz);
        const distSq = dx * dx + dy * dy + dz * dz;
        candidates.push({ candidate, distSq });
      }
    }
  }

  candidates.sort((a, b) => a.distSq - b.distSq);
  for (const { candidate } of candidates) {
    if (isValidCastOrigin(bot, candidate)) return candidate;
  }
  return null;
}

/**
 * Clear an obstructing non-obsidian solid block at targetPos
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetPos Target coordinates to clear
 * @param {object} standPos Safe standing coordinates nearby
 * @returns {Promise<void>}
 */
async function clearBlockIfSolid(bot, targetPos, standPos) {
  const current = bot.blockAt(targetPos);
  if (!current || NON_SOLID_BLOCKS.has(current.name) || current.name === 'obsidian' || current.name === 'bedrock') {
    return;
  }

  await moveNearPosition(bot, standPos, 4.0, 1);
  const tool = getBestToolForBlock(bot, current);
  if (tool) await bot.equip(tool, 'hand').catch(() => {});
  await bot.dig(current).catch(() => {});
  await bot.waitForTicks(3);
}

/**
 * Ensure a solid scaffold block exists at targetPos for mold walls or floor support
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetPos Target block coordinates
 * @param {object} standPos Safe standing coordinates nearby
 * @returns {Promise<boolean>} True if targetPos is solid after placement
 */
async function ensureScaffoldBlock(bot, targetPos, standPos) {
  const existing = bot.blockAt(targetPos);
  if (existing && !NON_SOLID_BLOCKS.has(existing.name)) return true;

  const items = bot.inventory.items();
  let scaffoldItem = null;
  for (const name of SCAFFOLD_BLOCKS) {
    scaffoldItem = items.find(i => i.name === name);
    if (scaffoldItem) break;
  }
  if (!scaffoldItem) {
    console.warn(`[PORTAL] Scaffold placement failed at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}): no_scaffold_item`);
    return false;
  }

  const placementRef = findPlacementReference(bot, targetPos);
  if (!placementRef) {
    console.warn(`[PORTAL] Scaffold placement failed at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}): no_placement_ref`);
    return false;
  }

  await moveNearPosition(bot, standPos, 4.0, 1);
  const { referenceBlock, faceVector } = placementRef;
  await bot.equip(scaffoldItem, 'hand');
  await bot.lookAt(referenceBlock.position.offset(0.5 + faceVector.x * 0.5, 0.5 + faceVector.y * 0.5, 0.5 + faceVector.z * 0.5), true);
  try {
    await bot.placeBlock(referenceBlock, faceVector);
  } catch (err) {
    console.warn(`[PORTAL] Scaffold placement failed at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}): place_error (${err.message})`);
    return false;
  }
  await bot.waitForTicks(3);

  const after = bot.blockAt(targetPos);
  return Boolean(after && !NON_SOLID_BLOCKS.has(after.name));
}

/**
 * Recursively clear a list of coordinates so air/water can occupy them
 * @param {object} bot Mineflayer bot instance
 * @param {object} basePos Portal mold origin
 * @param {Array<{ offset: Vec3, stand: Vec3 }>} steps Coordinates to clear
 * @param {number} index Current index
 * @returns {Promise<void>}
 */
async function clearMoldSpaces(bot, basePos, steps, index) {
  if (index >= steps.length) return;
  await clearBlockIfSolid(bot, basePos.plus(steps[index].offset), basePos.plus(steps[index].stand));
  return clearMoldSpaces(bot, basePos, steps, index + 1);
}

/**
 * Recursively ensure mold scaffold blocks exist across an ordered list of positions
 * @param {object} bot Mineflayer bot instance
 * @param {object} basePos Portal mold origin
 * @param {Array<{ offset: Vec3, stand: Vec3 }>} steps Scaffold placement steps
 * @param {number} index Current index
 * @param {boolean} [optional=false] Continue even if a scaffold placement fails
 * @returns {Promise<boolean>} True if all required scaffold blocks are in place
 */
async function buildMoldScaffolds(bot, basePos, steps, index, optional = false) {
  if (index >= steps.length) return true;
  const ok = await ensureScaffoldBlock(bot, basePos.plus(steps[index].offset), basePos.plus(steps[index].stand));
  if (!ok && !optional) return false;
  return buildMoldScaffolds(bot, basePos, steps, index + 1, optional);
}

/**
 * Pour a liquid bucket against a solid block face and verify the resulting block at targetPos
 * @param {object} bot Mineflayer bot instance
 * @param {string} bucketName Bucket item name ('water_bucket' or 'lava_bucket')
 * @param {object} targetPos Expected liquid/obsidian coordinates
 * @param {object} refPos Solid reference block coordinates
 * @param {Vec3} faceVec Outward face direction vector from refPos towards targetPos
 * @param {object} standPos Standing coordinates for clean raycast line of sight
 * @param {Set<string>} expectedNames Valid resulting block names at targetPos
 * @returns {Promise<boolean>} True if expected block formed at targetPos
 */
async function pourBucketAtFace(bot, bucketName, targetPos, refPos, faceVec, standPos, expectedNames) {
  const bucketItem = bot.inventory.items().find(i => i.name === bucketName);
  if (!bucketItem) return false;

  await moveNearPosition(bot, standPos, 1.8, 1);
  bot.pathfinder?.setGoal?.(null);
  bot.clearControlStates?.();

  await bot.equip(bucketItem, 'hand');
  await bot.lookAt(refPos.offset(0.5 + faceVec.x * 0.45, 0.5 + faceVec.y * 0.45, 0.5 + faceVec.z * 0.45), true);
  await bot.waitForTicks(3);
  await bot.activateItem();
  await bot.waitForTicks(10);

  return expectedNames.has(bot.blockAt(targetPos)?.name);
}

/**
 * Recursively cast ordered portal frame blocks with lava buckets while water flows in the mold
 * @param {object} bot Mineflayer bot instance
 * @param {object} basePos Portal mold origin
 * @param {Array<{ offset: Vec3, ref: Vec3, face: Vec3, stand: Vec3 }>} steps Ordered casting steps
 * @param {number} index Current casting step index
 * @returns {Promise<boolean>} True if all steps succeeded or were already obsidian
 */
async function castMoldSteps(bot, basePos, steps, index) {
  if (index >= steps.length) return true;

  const step = steps[index];
  const targetPos = basePos.plus(step.offset);
  if (bot.blockAt(targetPos)?.name === 'obsidian') {
    return castMoldSteps(bot, basePos, steps, index + 1);
  }

  if (countItem(bot, 'lava_bucket') === 0) {
    const scoop = await fillBucketFromSource(bot, 'lava');
    if (!scoop.success) return false;
  }

  await clearBlockIfSolid(bot, targetPos, basePos.plus(step.stand));
  const obsidianSet = new Set(['obsidian', 'lava', 'flowing_lava']);
  await pourBucketAtFace(
    bot,
    'lava_bucket',
    targetPos,
    basePos.plus(step.ref),
    step.face,
    basePos.plus(step.stand),
    obsidianSet
  );
  await bot.waitForTicks(12);

  if (bot.blockAt(targetPos)?.name !== 'obsidian') {
    return false;
  }

  return castMoldSteps(bot, basePos, steps, index + 1);
}

/**
 * Build an auto-switching water-cascade mold near a lava pool, cast all 10 obsidian blocks, and enter the portal
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} state Global bot state
 * @param {object|null} lavaBlock Detected lava source block
 * @param {object|null} [presetFrame=null] Optional existing partial portal frame geometry
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function castPortalWithMold(bot, state, lavaBlock, presetFrame = null) {
  const axis = presetFrame?.axis || 'x';
  const at = (x, y, z) => orientOffset(new Vec3(x, y, z), axis);

  let base = presetFrame?.base || state?.portalCastOrigin;
  if (!presetFrame?.base && base && (!bot.entity?.position?.distanceTo || bot.entity.position.distanceTo(base) > 32)) {
    base = null;
  }
  if (!base && lavaBlock?.position) {
    base = findCastOriginNearLava(bot, lavaBlock.position);
    if (base && state) state.portalCastOrigin = base;
  }

  if (!base) {
    if (lavaBlock?.position) markLavaClusterBad(bot, lavaBlock.position, 8);
    return {
      success: false,
      message: "No safe flat ground near lava pool to cast the Nether portal; marked lava pool bad."
    };
  }

  const scaffoldCount = countScaffoldBlocks(bot);
  if (scaffoldCount < 12) {
    return {
      success: false,
      message: `Need at least 12 solid building blocks (dirt, cobblestone, or planks) to build portal mold (have ${scaffoldCount}).`
    };
  }

  const frontStandLeft = at(-1, 1, 2);
  const frontStandCenter = at(0, 1, 2);
  const frontStandRightMid = at(1, 1, 2);
  const frontStandRight = at(2, 1, 2);
  const approachPos = base.plus(frontStandCenter);

  if (bot.entity?.position?.distanceTo && bot.entity.position.distanceTo(approachPos) > 4 && bot.pathfinder?.goto) {
    let approachTimer = null;
    try {
      const { GoalNear } = goals;
      const gotoPromise = bot.pathfinder.goto(new GoalNear(approachPos.x, approachPos.y, approachPos.z, 3));
      const timeoutPromise = new Promise((_, reject) => {
        approachTimer = setTimeout(() => reject(new Error("Navigation timeout towards portal site")), 20000);
      });
      await Promise.race([gotoPromise, timeoutPromise]).catch(() => {});
    } finally {
      if (approachTimer) clearTimeout(approachTimer);
      bot.pathfinder.setGoal?.(null);
      bot.clearControlStates?.();
    }
  }

  if (bot.entity?.position?.distanceTo && bot.entity.position.distanceTo(base) > 10) {
    if (lavaBlock?.position) markLavaClusterBad(bot, lavaBlock.position, 8);
    if (state) state.portalCastOrigin = null;
    return {
      success: false,
      message: "Lava pool is unreachable through terrain; marked bad and exploring for another lava pool."
    };
  }

  const baseRimScaffolds = [
    { offset: at(-1, 0, 0), stand: frontStandLeft },
    { offset: at(2, 0, 0), stand: frontStandRight },
    { offset: at(0, -1, 0), stand: frontStandCenter },
    { offset: at(1, -1, 0), stand: frontStandRightMid },
    { offset: at(0, 0, 1), stand: frontStandCenter },
    { offset: at(1, 0, 1), stand: frontStandRightMid },
    { offset: at(-1, 0, -1), stand: frontStandLeft },
    { offset: at(0, 0, -1), stand: frontStandCenter },
    { offset: at(1, 0, -1), stand: frontStandRightMid },
    { offset: at(2, 0, -1), stand: frontStandRight }
  ];
  const rimReady = await buildMoldScaffolds(bot, base, baseRimScaffolds, 0, false);
  if (!rimReady) {
    return {
      success: false,
      message: "Could not complete portal casting mold (blocked face or insufficient scaffold blocks)."
    };
  }

  const clearSteps = [
    { offset: at(0, 0, 0), stand: frontStandCenter },
    { offset: at(1, 0, 0), stand: frontStandRightMid },
    { offset: at(0, 1, 0), stand: frontStandCenter },
    { offset: at(1, 1, 0), stand: frontStandRightMid },
    { offset: at(0, 2, 0), stand: frontStandCenter },
    { offset: at(1, 2, 0), stand: frontStandRightMid },
    { offset: at(0, 3, 0), stand: frontStandCenter },
    { offset: at(1, 3, 0), stand: frontStandRightMid },
    { offset: at(0, 4, -1), stand: frontStandCenter },
    { offset: at(1, 4, -1), stand: frontStandRightMid }
  ];
  await clearMoldSpaces(bot, base, clearSteps, 0);

  const requiredColumns = [
    { offset: at(-1, 1, -1), stand: frontStandLeft },
    { offset: at(-1, 2, -1), stand: frontStandLeft },
    { offset: at(-1, 3, -1), stand: frontStandLeft },
    { offset: at(-1, 4, -1), stand: frontStandLeft },
    { offset: at(0, 1, -1), stand: frontStandCenter },
    { offset: at(0, 2, -1), stand: frontStandCenter },
    { offset: at(0, 3, -1), stand: frontStandCenter },
    { offset: at(1, 1, -1), stand: frontStandRightMid },
    { offset: at(1, 2, -1), stand: frontStandRightMid },
    { offset: at(1, 3, -1), stand: frontStandRightMid },
    { offset: at(2, 1, -1), stand: frontStandRight },
    { offset: at(2, 2, -1), stand: frontStandRight },
    { offset: at(2, 3, -1), stand: frontStandRight },
    { offset: at(2, 4, -1), stand: frontStandRight },
    { offset: at(-1, 4, 0), stand: frontStandLeft }
  ];
  const moldReady = await buildMoldScaffolds(bot, base, requiredColumns, 0, false);
  if (!moldReady) {
    return {
      success: false,
      message: "Could not complete portal casting mold (blocked face or insufficient scaffold blocks)."
    };
  }

  const optionalBumpers = [
    { offset: at(0, 3, -2), stand: frontStandCenter },
    { offset: at(0, 4, -2), stand: frontStandCenter },
    { offset: at(1, 3, -2), stand: frontStandRightMid },
    { offset: at(1, 4, -2), stand: frontStandRightMid }
  ];
  await buildMoldScaffolds(bot, base, optionalBumpers, 0, true);

  const waterSet = new Set(['water', 'flowing_water']);
  if (countItem(bot, 'water_bucket') === 0) {
    const filledWater = await fillBucketFromSource(bot, 'water');
    if (!filledWater.success) return filledWater;
  }

  await pourBucketAtFace(
    bot,
    'water_bucket',
    base.plus(at(0, 4, -1)),
    base.plus(at(-1, 4, -1)),
    at(1, 0, 0),
    base.plus(frontStandRightMid),
    waterSet
  );
  await bot.waitForTicks(14);

  const leftSteps = [
    { offset: at(0, 0, 0), ref: at(0, -1, 0), face: at(0, 1, 0), stand: at(0, 1, 1) },
    { offset: at(-1, 1, 0), ref: at(-1, 1, -1), face: at(0, 0, 1), stand: frontStandLeft },
    { offset: at(-1, 2, 0), ref: at(-1, 2, -1), face: at(0, 0, 1), stand: frontStandLeft },
    { offset: at(-1, 3, 0), ref: at(-1, 3, -1), face: at(0, 0, 1), stand: frontStandLeft },
    { offset: at(0, 4, 0), ref: at(-1, 4, 0), face: at(1, 0, 0), stand: frontStandRightMid }
  ];
  await castMoldSteps(bot, base, leftSteps, 0);
  await bot.waitForTicks(14);

  const rightCascade = bot.blockAt(base.plus(at(1, 3, 0)))?.name;
  if (!waterSet.has(rightCascade)) {
    if (countItem(bot, 'water_bucket') === 0) {
      await fillBucketFromSource(bot, 'water');
    }
    if (countItem(bot, 'water_bucket') > 0) {
      await pourBucketAtFace(
        bot,
        'water_bucket',
        base.plus(at(1, 4, -1)),
        base.plus(at(2, 4, -1)),
        at(-1, 0, 0),
        base.plus(frontStandCenter),
        waterSet
      );
      await bot.waitForTicks(14);
    }
  }

  const rightSteps = [
    { offset: at(1, 0, 0), ref: at(1, -1, 0), face: at(0, 1, 0), stand: at(1, 1, 1) },
    { offset: at(2, 1, 0), ref: at(2, 1, -1), face: at(0, 0, 1), stand: frontStandRight },
    { offset: at(2, 2, 0), ref: at(2, 2, -1), face: at(0, 0, 1), stand: frontStandRight },
    { offset: at(2, 3, 0), ref: at(2, 3, -1), face: at(0, 0, 1), stand: frontStandRight },
    { offset: at(1, 4, 0), ref: at(0, 4, 0), face: at(1, 0, 0), stand: frontStandRight }
  ];
  await castMoldSteps(bot, base, rightSteps, 0);
  await bot.waitForTicks(30);

  const leftWaterPos = base.plus(at(0, 4, -1));
  if (bot.blockAt(leftWaterPos)?.name === 'water') {
    await moveNearPosition(bot, base.plus(frontStandCenter), 4.0, 2);
    await retrieveWaterSource(bot, leftWaterPos.offset(0.5, 0.5, 0.5));
  }
  const rightWaterPos = base.plus(at(1, 4, -1));
  if (bot.blockAt(rightWaterPos)?.name === 'water') {
    await moveNearPosition(bot, base.plus(frontStandRightMid), 4.0, 2);
    await retrieveWaterSource(bot, rightWaterPos.offset(0.5, 0.5, 0.5));
  }

  const innerClearSteps = [
    { offset: at(0, 1, 0), stand: at(0, 1, 1) },
    { offset: at(1, 1, 0), stand: at(1, 1, 1) },
    { offset: at(0, 2, 0), stand: at(0, 1, 1) },
    { offset: at(1, 2, 0), stand: at(1, 1, 1) },
    { offset: at(0, 3, 0), stand: at(0, 1, 1) },
    { offset: at(1, 3, 0), stand: at(1, 1, 1) }
  ];
  await clearMoldSpaces(bot, base, innerClearSteps, 0);

  if (!hasCompletePortalFrame(bot, base, axis)) {
    const builtCount = PORTAL_BUILD_STEPS
      .filter(s => !s.isCorner && bot.blockAt(base.plus(orientOffset(s.offset, axis)))?.name === 'obsidian')
      .length;
    return {
      success: false,
      message: `Portal mold cast partially completed (${builtCount}/10 obsidian); run 'portal' again to finish.`
    };
  }

  await moveNearPosition(bot, base.plus(at(0, 1, 1)), 2.5, 1);
  const enterRes = await igniteAndEnterPortal(bot, base.offset(0, 1, 0), axis, state);
  if (enterRes.success && state) {
    state.portalCastOrigin = null;
  }
  return enterRes;
}

/**
 * Complete and ignite an existing partial or complete Nether portal frame
 * @param {object} bot Mineflayer bot instance
 * @param {object} frame Candidate frame metadata returned by findPortalFrameCandidate
 * @param {object|null} [state=null] Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Completion or ignition outcome
 */
async function completePartialPortalFrame(bot, frame, state = null) {
  if (!frame?.base) {
    return { success: false, message: "No valid portal frame candidate available." };
  }

  if (frame.isComplete) {
    return igniteAndEnterPortal(bot, frame.base.offset(0, 1, 0), frame.axis, state);
  }

  const initialObsidian = countItem(bot, 'obsidian');
  if (initialObsidian > 0) {
    const orientedSteps = PORTAL_BUILD_STEPS.map(step => ({
      offset: orientOffset(step.offset, frame.axis),
      isCorner: step.isCorner
    }));
    await placePortalFrameStep(bot, frame.base, orientedSteps, 0);
    if (hasCompletePortalFrame(bot, frame.base, frame.axis)) {
      return igniteAndEnterPortal(bot, frame.base.offset(0, 1, 0), frame.axis, state);
    }
    if (countItem(bot, 'obsidian') < initialObsidian) {
      return { success: true, message: "Placed carried obsidian onto partial Nether portal frame." };
    }
  }

  if (countItem(bot, 'water_bucket') > 0 || countItem(bot, 'bucket') > 0) {
    const lavaBlock = findBestLavaPool(bot);
    if (lavaBlock) {
      if (countItem(bot, 'water_bucket') === 0) {
        const filledWater = await fillBucketFromSource(bot, 'water');
        if (!filledWater.success) return filledWater;
      }
      return castPortalWithMold(bot, state, lavaBlock, frame);
    }
  }

  console.log(
    `[PORTAL] Partial portal frame (${frame.presentCount}/10 obsidian, axis=${frame.axis}) at (${frame.base.x},${frame.base.y},${frame.base.z}) needs ${frame.missingCount} more obsidian or nearby lava.`
  );
  return {
    success: false,
    message: `Partial portal frame (${frame.presentCount}/10 obsidian) needs ${frame.missingCount} more obsidian or a nearby lava pool.`
  };
}

/**
 * Cast or mine obsidian at a nearby lava pool using water bucket and available tools
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} [state=null] Global bot state
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function castObsidianAtLavaPool(bot, state = null) {
  const lavaBlock = findBestLavaPool(bot);

  if (!lavaBlock) {
    return {
      success: false,
      message: "No lava pool found nearby to cast the Nether portal. Use 'explore' or dig down to find lava."
    };
  }

  const waterBucket = bot.inventory.items().find(i => i.name === 'water_bucket');
  if (!waterBucket) {
    return fillBucketFromSource(bot, 'water');
  }

  const canMineObsidian = countItem(bot, 'diamond_pickaxe') > 0 || countItem(bot, 'netherite_pickaxe') > 0;
  if (canMineObsidian) {
    let navTimer = null;
    try {
      if (bot.entity.position.distanceTo(lavaBlock.position) > 3.5) {
        const { GoalNear } = goals;
        const gotoPromise = bot.pathfinder.goto(new GoalNear(lavaBlock.position.x, lavaBlock.position.y, lavaBlock.position.z, 2));
        const timeoutPromise = new Promise((_, reject) => {
          navTimer = setTimeout(() => reject(new Error("Navigation timeout towards lava pool")), 15000);
        });
        await Promise.race([gotoPromise, timeoutPromise]);
      }

      const waterRef = findPlacementReference(bot, lavaBlock.position.offset(0, 1, 0));
      const waterLookPos = waterRef
        ? waterRef.referenceBlock.position.offset(0.5 + waterRef.faceVector.x * 0.5, 0.5 + waterRef.faceVector.y * 0.5, 0.5 + waterRef.faceVector.z * 0.5)
        : lavaBlock.position.offset(0.5, 1, 0.5);
      await bot.equip(waterBucket, 'hand');
      await bot.lookAt(waterLookPos, true);
      await bot.activateItem();
      await bot.waitForTicks(12);

      if (await tryMineFormedObsidian(bot)) {
        await retrieveWaterSource(bot, waterLookPos);
        return {
          success: true,
          message: `Cast and harvested obsidian from lava pool (${countItem(bot, 'obsidian')}/11).`
        };
      }
      await retrieveWaterSource(bot, waterLookPos);
    } catch (err) {
      return { success: false, message: `Failed to harvest obsidian at lava pool : ${err.message}` };
    } finally {
      if (navTimer) clearTimeout(navTimer);
    }
  }

  return castPortalWithMold(bot, state, lavaBlock);
}

/**
 * Clear obstructing block and place a single portal frame or corner block against any solid adjacent face
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetPos Target block coordinates
 * @param {boolean} [isCorner] Whether this position is the top-left support corner
 * @param {number} [remainingCoreBlocks] Remaining core obsidian blocks to place after this step
 * @returns {Promise<boolean>} False if required item or reference face is missing, true otherwise
 */
async function placeSingleObsidianAt(bot, targetPos, isCorner = false, remainingCoreBlocks = 0) {
  const currentBlock = bot.blockAt(targetPos);
  if (currentBlock?.name === 'obsidian') return true;
  if (isCorner && currentBlock && !NON_SOLID_BLOCKS.has(currentBlock.name)) return true;

  if (currentBlock && !NON_SOLID_BLOCKS.has(currentBlock.name)) {
    const tool = getBestToolForBlock(bot, currentBlock);
    if (tool) await bot.equip(tool, 'hand').catch(() => {});
    await bot.dig(currentBlock).catch(() => {});
  }

  const itemToPlace = selectFrameStepItem(bot, isCorner, remainingCoreBlocks);
  if (!itemToPlace) return false;

  const placementRef = findPlacementReference(bot, targetPos);
  if (!placementRef) return false;

  if (bot.entity?.position?.distanceTo && bot.entity.position.distanceTo(targetPos) > 4.2 && bot.pathfinder?.goto) {
    const { GoalNear } = goals;
    await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3)).catch(() => {});
  }

  const { referenceBlock, faceVector } = placementRef;
  await bot.equip(itemToPlace, 'hand');
  await bot.lookAt(referenceBlock.position.offset(0.5 + faceVector.x * 0.5, 0.5 + faceVector.y * 0.5, 0.5 + faceVector.z * 0.5), true);
  try {
    await bot.placeBlock(referenceBlock, faceVector);
  } catch {
    return false;
  }
  await bot.waitForTicks(4);

  const placedBlock = bot.blockAt(targetPos);
  if (isCorner) {
    return Boolean(placedBlock && !NON_SOLID_BLOCKS.has(placedBlock.name));
  }
  return placedBlock?.name === 'obsidian';
}

/**
 * Place obsidian frame blocks recursively without await-in-loop
 * @param {object} bot Mineflayer bot instance
 * @param {object} base Origin position vector of the portal frame
 * @param {Array<{ offset: Vec3, isCorner: boolean }>} frameSteps Array of step definitions
 * @param {number} index Current step index
 * @returns {Promise<boolean>} True if all frame blocks were placed
 */
async function placePortalFrameStep(bot, base, frameSteps, index) {
  if (index >= frameSteps.length) return true;

  const step = frameSteps[index];
  const offset = step.offset || step;
  const isCorner = Boolean(step.isCorner);
  const remainingCore = frameSteps.slice(index + 1).filter(s => !s.isCorner).length;

  const canContinue = await placeSingleObsidianAt(bot, base.plus(offset), isCorner, remainingCore);
  if (!canContinue) return false;

  return placePortalFrameStep(bot, base, frameSteps, index + 1);
}

/**
 * Construct an embedded 4x5 Nether portal frame (11 blocks including top-left corner)
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<{ success: boolean, portalInnerPos: object|null, message: string }>}
 */
async function buildObsidianFrame(bot) {
  const obsidianCount = countItem(bot, 'obsidian');
  if (obsidianCount < 10) {
    return {
      success: false,
      portalInnerPos: null,
      message: `Insufficient obsidian in inventory (${obsidianCount}/11).`
    };
  }

  const refBlock = bot.findBlock({
    matching: (block) => {
      if (!config.VALID_GROUND_BLOCKS.has(block.name)) return false;
      const above = bot.blockAt(block.position.offset(0, 1, 0));
      return above?.name === 'air';
    },
    maxDistance: 4
  });

  if (!refBlock) {
    return { success: false, portalInnerPos: null, message: "No flat ground nearby to build the Nether portal." };
  }

  // Embed threshold directly at refBlock ground level so natural terrain supports both pillars
  const base = refBlock.position.clone ? refBlock.position.clone() : refBlock.position;

  try {
    const placed = await placePortalFrameStep(bot, base, PORTAL_BUILD_STEPS, 0);
    if (!placed || !hasCompletePortalFrame(bot, base)) {
      return {
        success: false,
        portalInnerPos: null,
        message: "Portal frame placement incomplete (block obstructed or out of reach)."
      };
    }

    return {
      success: true,
      portalInnerPos: base.offset(0, 1, 0),
      message: "Obsidian portal frame assembled."
    };
  } catch (err) {
    return { success: false, portalInnerPos: null, message: `Portal frame assembly error : ${err.message}` };
  }
}

/**
 * Manage speedrun Nether portal creation, ignition, and dimension entry
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} [state=null] Global bot state
 * @param {string|null} [target=null] 'overworld' to travel back from the Nether
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function skillPortal(bot, state = null, target = null) {
  await autoEquipArmorAndShield(bot);
  await freeInventorySlotIfFull(bot, 1);

  const dimension = getDimension(bot);
  if (dimension === 'the_end') {
    return { success: false, message: "Nether portals do not work in the End. Use 'dragon' to fight the Ender Dragon." };
  }
  if (dimension === 'the_nether') {
    const cleanTarget = typeof target === 'string' ? target.toLowerCase().trim() : '';
    if (RETURN_TARGETS.has(cleanTarget)) {
      return returnToOverworld(bot, state);
    }
    return {
      success: true,
      message: "Already inside the Nether! Use 'explore' to locate a Fortress or 'fight' on 'blaze'. Use 'portal' with target 'overworld' to go back."
    };
  }

  // Enter immediately if an active Nether portal block is already nearby
  const portalId = bot.registry.blocksByName.nether_portal?.id;
  const activePortal = portalId ? bot.findBlock({ matching: portalId, maxDistance: 48 }) : null;
  if (activePortal) {
    return igniteAndEnterPortal(bot, null, 'x', state);
  }

  const existingFrame = findPortalFrameCandidate(bot, 48);
  if (existingFrame?.isComplete) {
    return completePartialPortalFrame(bot, existingFrame, state);
  }
  if (existingFrame && (countItem(bot, 'obsidian') > 0 || findBestLavaPool(bot))) {
    return completePartialPortalFrame(bot, existingFrame, state);
  }

  if (countItem(bot, 'obsidian') >= 10) {
    const buildResult = await buildObsidianFrame(bot);
    if (!buildResult.success) return buildResult;
    return igniteAndEnterPortal(bot, buildResult.portalInnerPos, 'x', state);
  }

  if (countItem(bot, 'water_bucket') === 0) {
    if (countItem(bot, 'bucket') === 0) {
      return {
        success: false,
        message: "Missing 'bucket'. Craft a bucket with 3 iron ingots first ('craft bucket')."
      };
    }
    return fillBucketFromSource(bot, 'water');
  }

  return castObsidianAtLavaPool(bot, state);
}

module.exports = {
  skillPortal,
  returnToOverworld,
  fillBucketFromSource,
  igniteAndEnterPortal,
  buildObsidianFrame,
  findPlacementReference,
  hasCompletePortalFrame,
  findPortalFrameCandidate,
  orientOffset,
  findBestLavaPool,
  findCastOriginNearLava,
  castPortalWithMold,
  markLavaClusterBad,
  countScaffoldBlocks,
  PORTAL_BUILD_STEPS
};
