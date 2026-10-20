const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../config');
const { countItem, getBestToolForBlock } = require('../utils/inventory');

const NON_SOLID_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire'
]);

const SCAFFOLD_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'netherrack', 'andesite', 'diorite', 'granite'
];

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

  const blockId = bot.registry.blocksByName[liquidName]?.id;
  const sourceBlock = blockId ? bot.findBlock({
    matching: (block) => block.type === blockId && block.metadata === 0,
    maxDistance: 28
  }) : null;

  if (!sourceBlock) {
    return {
      success: false,
      message: `No '${liquidName}' source block found nearby. Use 'explore' to find ${liquidName}.`
    };
  }

  let navTimer = null;
  try {
    if (bot.entity.position.distanceTo(sourceBlock.position) > 3.5) {
      const { GoalNear } = goals;
      const gotoPromise = bot.pathfinder.goto(new GoalNear(sourceBlock.position.x, sourceBlock.position.y, sourceBlock.position.z, 2));
      const timeoutPromise = new Promise((_, reject) => {
        navTimer = setTimeout(() => reject(new Error(`Navigation timeout towards ${liquidName}`)), 15000);
      });
      await Promise.race([gotoPromise, timeoutPromise]);
    }

    await bot.equip(bucketItem, 'hand');
    await bot.lookAt(sourceBlock.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateItem();
    await bot.waitForTicks(8);

    const expectedFilled = liquidName === 'water' ? 'water_bucket' : 'lava_bucket';
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
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function igniteAndEnterPortal(bot, portalBasePos) {
  const existingPortalId = bot.registry.blocksByName.nether_portal?.id;
  let portalBlock = existingPortalId ? bot.findBlock({ matching: existingPortalId, maxDistance: 24 }) : null;

  if (!portalBlock && portalBasePos) {
    const flint = bot.inventory.items().find(i => i.name === 'flint_and_steel');
    if (!flint) {
      return { success: false, message: "Missing 'flint_and_steel' to ignite the Nether portal. Craft one first." };
    }
    portalBlock = await strikePortalFrame(bot, flint, portalBasePos, existingPortalId);
  }

  if (!portalBlock) {
    return { success: false, message: "Portal frame could not be ignited or no active 'nether_portal' found nearby." };
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

    // Wait inside portal block for dimension transition (up to 6 seconds)
    await bot.waitForTicks(120);

    if (bot.game?.dimension === 'the_nether') {
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
 * Cast a single portal frame block by scooping lava and pouring it against a reference face
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetPos Target block coordinates
 * @returns {Promise<boolean>} False if no more lava can be scooped, true otherwise
 */
async function castSingleLavaFrameBlock(bot, targetPos) {
  if (bot.blockAt(targetPos)?.name === 'obsidian') return true;

  const ref = findPlacementReference(bot, targetPos);
  if (!ref) return true;

  const scoop = await fillBucketFromSource(bot, 'lava');
  if (!scoop.success) return false;

  const lavaItem = bot.inventory.items().find(i => i.name === 'lava_bucket');
  if (!lavaItem) return false;

  const { referenceBlock, faceVector } = ref;
  const clickPos = referenceBlock.position.offset(
    0.5 + faceVector.x * 0.5,
    0.5 + faceVector.y * 0.5,
    0.5 + faceVector.z * 0.5
  );
  await bot.equip(lavaItem, 'hand');
  await bot.lookAt(clickPos, true);
  await bot.activateItem();
  await bot.waitForTicks(6);
  return true;
}

/**
 * Recursively cast portal frame blocks with lava buckets while water flows nearby
 * @param {object} bot Mineflayer bot instance
 * @param {object} basePos Origin coordinate of the portal frame
 * @param {number} index Current step index in PORTAL_BUILD_STEPS
 * @returns {Promise<void>}
 */
async function castPortalFrameStep(bot, basePos, index) {
  if (index >= PORTAL_BUILD_STEPS.length) return;

  const step = PORTAL_BUILD_STEPS[index];
  const canContinue = await castSingleLavaFrameBlock(bot, basePos.plus(step.offset));
  if (!canContinue) return;

  return castPortalFrameStep(bot, basePos, index + 1);
}

/**
 * Cast or mine obsidian at a nearby lava pool using water bucket and available tools
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function castObsidianAtLavaPool(bot) {
  const lavaId = bot.registry.blocksByName.lava?.id;
  const lavaBlock = lavaId ? bot.findBlock({
    matching: (block) => block.type === lavaId && block.metadata === 0,
    maxDistance: 28
  }) : null;

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

    const waterLookPos = lavaBlock.position.offset(0.5, 1, 0.5);
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

    await castPortalFrameStep(bot, lavaBlock.position, 0);
    await retrieveWaterSource(bot, waterLookPos);

    return {
      success: true,
      message: "Poured water onto lava pool and cast obsidian portal blocks."
    };
  } catch (err) {
    return { success: false, message: `Failed to cast obsidian at lava pool : ${err.message}` };
  } finally {
    if (navTimer) clearTimeout(navTimer);
  }
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

  const { referenceBlock, faceVector } = placementRef;
  await bot.equip(itemToPlace, 'hand');
  await bot.lookAt(referenceBlock.position.offset(0.5 + faceVector.x * 0.5, 0.5 + faceVector.y * 0.5, 0.5 + faceVector.z * 0.5), true);
  await bot.placeBlock(referenceBlock, faceVector).catch(() => {});
  await bot.waitForTicks(4);
  return true;
}

/**
 * Place obsidian frame blocks recursively without await-in-loop
 * @param {object} bot Mineflayer bot instance
 * @param {object} base Origin position vector of the portal frame
 * @param {Array<{ offset: Vec3, isCorner: boolean }>} frameSteps Array of step definitions
 * @param {number} index Current step index
 * @returns {Promise<void>}
 */
async function placePortalFrameStep(bot, base, frameSteps, index) {
  if (index >= frameSteps.length) return;

  const step = frameSteps[index];
  const offset = step.offset || step;
  const isCorner = Boolean(step.isCorner);
  const remainingCore = frameSteps.slice(index + 1).filter(s => !s.isCorner).length;

  const canContinue = await placeSingleObsidianAt(bot, base.plus(offset), isCorner, remainingCore);
  if (!canContinue) return;

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
    await placePortalFrameStep(bot, base, PORTAL_BUILD_STEPS, 0);

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
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function skillPortal(bot) {
  if (bot.game?.dimension === 'the_nether') {
    return {
      success: true,
      message: "Already inside the Nether! Use 'explore' to locate a Fortress or 'fight' on 'blaze'."
    };
  }

  // Enter immediately if an active Nether portal block is already nearby
  const portalId = bot.registry.blocksByName.nether_portal?.id;
  const activePortal = portalId ? bot.findBlock({ matching: portalId, maxDistance: 28 }) : null;
  if (activePortal) {
    return igniteAndEnterPortal(bot, null);
  }

  // Build and ignite frame if bot already carries at least 10 obsidian
  if (countItem(bot, 'obsidian') >= 10) {
    const buildResult = await buildObsidianFrame(bot);
    if (!buildResult.success) return buildResult;
    return igniteAndEnterPortal(bot, buildResult.portalInnerPos);
  }

  // Check if a ruined portal or natural obsidian is nearby and diamond pickaxe is owned
  const obsidianId = bot.registry.blocksByName.obsidian?.id;
  const nearbyObsidian = obsidianId ? bot.findBlock({ matching: obsidianId, maxDistance: 24 }) : null;
  if (nearbyObsidian && countItem(bot, 'flint_and_steel') > 0) {
    const igniteAttempt = await igniteAndEnterPortal(bot, nearbyObsidian.position.offset(0, 1, 0));
    if (igniteAttempt.success) return igniteAttempt;
  }

  // Ensure water_bucket is prepared before searching for lava pool
  if (countItem(bot, 'water_bucket') === 0) {
    if (countItem(bot, 'bucket') === 0) {
      return {
        success: false,
        message: "Missing 'bucket'. Craft a bucket with 3 iron ingots first ('craft bucket')."
      };
    }
    return fillBucketFromSource(bot, 'water');
  }

  // Cast obsidian at nearby lava pool using water bucket
  return castObsidianAtLavaPool(bot);
}

module.exports = {
  skillPortal,
  fillBucketFromSource,
  igniteAndEnterPortal,
  buildObsidianFrame,
  findPlacementReference,
  PORTAL_BUILD_STEPS
};
