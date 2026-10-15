const { goals } = require('mineflayer-pathfinder');

// Keep essential and valuable items permanently in inventory
const ESSENTIAL_ITEMS = new Set([
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe',
  'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe',
  'iron_sword', 'diamond_sword', 'netherite_sword', 'shield',
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
  'torch', 'bucket', 'water_bucket', 'flint_and_steel',
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'apple',
  'diamond', 'raw_iron', 'iron_ingot', 'raw_gold', 'gold_ingot', 'lapis_lazuli'
]);

/**
 * Determine whether an inventory item should be deposited into storage
 * @param {object} item Mineflayer inventory item
 * @returns {boolean} True if the item is bulky and should be stored
 */
function isItemToStore(item) {
  if (ESSENTIAL_ITEMS.has(item.name)) return false;

  // Retain limited terrain blocks for bridging
  const bulkMaterials = ['dirt', 'cobblestone', 'granite', 'diorite', 'andesite', 'cobbled_deepslate', 'gravel', 'sand'];
  if (bulkMaterials.includes(item.name)) {
    return item.count > 32; // Retain at most 32 blocks for bridging
  }

  // Store surplus saplings, seeds, bones, and arrows
  if (item.name.includes('sapling') || item.name.includes('seeds') || item.name === 'bone' || item.name === 'arrow') {
    return true;
  }

  // Store bulky mob drops and secondary ores
  if (['rotten_flesh', 'spider_eye', 'gunpowder', 'string', 'raw_copper', 'copper_ingot'].includes(item.name)) {
    return true;
  }

  return false;
}

/**
 * Deposit an array of items sequentially into a chest container
 * @param {object} chest Open chest container
 * @param {Array<{ item: object, amountToDeposit: number }>} deposits List of items and quantities to deposit
 * @returns {Promise<{ depositedCount: number, depositedNames: string[] }>} Deposit operation result
 */
async function depositItems(chest, deposits) {
  let depositedCount = 0;
  const depositedNames = [];

  await deposits.reduce(async (previousPromise, { item, amountToDeposit }) => {
    await previousPromise;
    try {
      await chest.deposit(item.type, null, amountToDeposit);
      depositedCount += amountToDeposit;
      depositedNames.push(`${amountToDeposit}x ${item.name}`);
    } catch (e) {
      console.warn(`Error depositing ${item.name}:`, e.message);
    }
  }, Promise.resolve());

  return { depositedCount, depositedNames };
}

/**
 * Manage automatic inventory organization into a nearby chest
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Result of the chest sorting operation
 */
async function skillChest(bot, state) {
  const chestBlockId = bot.registry.blocksByName.chest?.id;
  let chestBlock = chestBlockId ? bot.findBlock({ matching: chestBlockId, maxDistance: 32 }) : null;

  if (!chestBlock && state.base.chest) {
    chestBlock = bot.blockAt(state.base.chest);
    if (chestBlock && chestBlock.name !== 'chest') {
      chestBlock = null;
      state.base.chest = null;
    }
  }

  if (!chestBlock) {
    return {
      success: false,
      message: "No chest found nearby. Craft and place a chest ('craft chest' then 'place chest') first."
    };
  }

  let chest = null;
  try {
    if (bot.entity.position.distanceTo(chestBlock.position) > 3) {
      const gotoPromise = bot.pathfinder.goto(new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z));
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Navigation timeout towards chest")), 15000));
      await Promise.race([gotoPromise, timeoutPromise]);
    }

    chest = await bot.openChest(chestBlock);
    const items = bot.inventory.items();
    const keptCounts = {};
    const deposits = [];

    for (const item of items) {
      if (isItemToStore(item)) {
        const maxToKeep = ['dirt', 'cobblestone', 'cobbled_deepslate'].includes(item.name) ? 32 : 0;
        const alreadyKept = keptCounts[item.name] || 0;
        const remainingToKeep = Math.max(0, maxToKeep - alreadyKept);

        const keepFromThisStack = Math.min(item.count, remainingToKeep);
        keptCounts[item.name] = alreadyKept + keepFromThisStack;

        const amountToDeposit = item.count - keepFromThisStack;
        if (amountToDeposit > 0) {
          deposits.push({ item, amountToDeposit });
        }
      }
    }

    const { depositedCount, depositedNames } = await depositItems(chest, deposits);

    if (depositedCount === 0) {
      return { success: true, message: "Inventory already clean; no bulky items to deposit." };
    }

    return {
      success: true,
      message: `Chest sorting complete; deposited ${depositedNames.slice(0, 4).join(', ')}${depositedNames.length > 4 ? '...' : ''}.`
    };
  } catch (error) {
    console.warn("Chest error:", error.message);
    return { success: false, message: `Chest storage failed: ${error.message}` };
  } finally {
    if (chest) chest.close();
  }
}

module.exports = { skillChest, isItemToStore };
