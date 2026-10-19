const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../config');
const { countItem, getBestToolForBlock } = require('../utils/inventory');

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

  try {
    if (bot.entity.position.distanceTo(sourceBlock.position) > 3.5) {
      const { GoalNear } = goals;
      const gotoPromise = bot.pathfinder.goto(new GoalNear(sourceBlock.position.x, sourceBlock.position.y, sourceBlock.position.z, 2));
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Navigation timeout towards ${liquidName}`)), 15000));
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
  }
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

    const bottomObsidian = bot.blockAt(portalBasePos.offset(0, -1, 0));
    if (bottomObsidian) {
      await bot.equip(flint, 'hand');
      await bot.lookAt(bottomObsidian.position.offset(0.5, 1, 0.5), true);
      try {
        await bot.placeBlock(bottomObsidian, new Vec3(0, 1, 0));
      } catch {
        try {
          await bot.activateBlock(bottomObsidian);
        } catch {
          // Ignore error if block activation is rejected by server
        }
      }
      await bot.waitForTicks(10);
      portalBlock = existingPortalId ? bot.findBlock({ matching: existingPortalId, maxDistance: 12 }) : null;
    }
  }

  if (!portalBlock) {
    return { success: false, message: "Portal frame could not be ignited or no active 'nether_portal' found nearby." };
  }

  try {
    console.log(`[PORTAL] Entering Nether portal at (${portalBlock.position.x}, ${portalBlock.position.y}, ${portalBlock.position.z})...`);
    const { GoalBlock } = goals;
    const gotoPromise = bot.pathfinder.goto(new GoalBlock(portalBlock.position.x, portalBlock.position.y, portalBlock.position.z));
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Navigation timeout towards portal")), 12000));
    await Promise.race([gotoPromise, timeoutPromise]).catch(() => {});

    // Wait inside portal block for dimension transition (up to 6 seconds)
    await bot.waitForTicks(120);

    if (bot.game?.dimension === 'the_nether') {
      return { success: true, message: "Successfully transitioned into the Nether!" };
    }

    return { success: true, message: "Nether portal ignited and entered. Waiting for server dimension transfer." };
  } catch (err) {
    return { success: false, message: `Failed to enter Nether portal : ${err.message}` };
  }
}

/**
 * Cast obsidian by pouring water near a lava source or placing lava into a mold
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

  try {
    if (bot.entity.position.distanceTo(lavaBlock.position) > 3.5) {
      const { GoalNear } = goals;
      const gotoPromise = bot.pathfinder.goto(new GoalNear(lavaBlock.position.x, lavaBlock.position.y, lavaBlock.position.z, 2));
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Navigation timeout towards lava pool")), 15000));
      await Promise.race([gotoPromise, timeoutPromise]);
    }

    // Place water adjacent to lava to convert lava sources into obsidian
    await bot.equip(waterBucket, 'hand');
    await bot.lookAt(lavaBlock.position.offset(0.5, 1, 0.5), true);
    await bot.activateItem();
    await bot.waitForTicks(12);

    // Retrieve water back into bucket
    const emptyBucket = bot.inventory.items().find(i => i.name === 'bucket');
    if (emptyBucket) {
      await bot.equip(emptyBucket, 'hand');
      await bot.activateItem();
      await bot.waitForTicks(6);
    }

    return {
      success: true,
      message: "Poured water onto lava pool to form obsidian."
    };
  } catch (err) {
    return { success: false, message: `Failed to cast obsidian at lava pool : ${err.message}` };
  }
}

/**
 * Place obsidian frame blocks recursively without await-in-loop
 * @param {object} bot Mineflayer bot instance
 * @param {object} base Origin position vector of the portal frame
 * @param {Array<object>} frameOffsets Array of relative offset vectors
 * @param {number} index Current offset index
 * @returns {Promise<void>}
 */
async function placePortalFrameStep(bot, base, frameOffsets, index) {
  if (index >= frameOffsets.length) return;

  const offset = frameOffsets[index];
  const targetPos = base.plus(offset);
  const currentBlock = bot.blockAt(targetPos);

  if (currentBlock?.name !== 'obsidian') {
    if (currentBlock && currentBlock.name !== 'air' && currentBlock.name !== 'cave_air') {
      const tool = getBestToolForBlock(bot, currentBlock);
      if (tool) await bot.equip(tool, 'hand').catch(() => {});
      await bot.dig(currentBlock).catch(() => {});
    }

    const obsItem = bot.inventory.items().find(i => i.name === 'obsidian');
    if (!obsItem) return;

    const below = bot.blockAt(targetPos.offset(0, -1, 0));
    if (below && below.name !== 'air') {
      await bot.equip(obsItem, 'hand');
      await bot.lookAt(below.position.offset(0.5, 1, 0.5), true);
      await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(() => {});
      await bot.waitForTicks(4);
    }
  }

  return placePortalFrameStep(bot, base, frameOffsets, index + 1);
}

/**
 * Construct a 4x5 Nether portal frame from inventory obsidian if available
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<{ success: boolean, portalInnerPos: object|null, message: string }>}
 */
async function buildObsidianFrame(bot) {
  const obsidianCount = countItem(bot, 'obsidian');
  if (obsidianCount < 10) {
    return {
      success: false,
      portalInnerPos: null,
      message: `Insufficient obsidian in inventory (${obsidianCount}/10).`
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

  const base = refBlock.position.offset(0, 1, 0);
  // Standard 10-obsidian cornerless portal frame offsets relative to base
  const frameOffsets = [
    new Vec3(0, 0, 0), new Vec3(1, 0, 0),
    new Vec3(-1, 1, 0), new Vec3(-1, 2, 0), new Vec3(-1, 3, 0),
    new Vec3(2, 1, 0), new Vec3(2, 2, 0), new Vec3(2, 3, 0),
    new Vec3(0, 4, 0), new Vec3(1, 4, 0)
  ];

  try {
    await placePortalFrameStep(bot, base, frameOffsets, 0);

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
  igniteAndEnterPortal
};
