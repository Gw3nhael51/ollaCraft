const { goals } = require('mineflayer-pathfinder');

// Keep essential and valuable items permanently in inventory
const ESSENTIAL_ITEMS = new Set([
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe',
  'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe',
  'iron_sword', 'diamond_sword', 'netherite_sword', 'shield',
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
  'torch', 'bucket', 'water_bucket', 'lava_bucket', 'flint_and_steel',
  'crafting_table', 'furnace',
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'apple',
  'diamond', 'raw_iron', 'iron_ingot', 'raw_gold', 'gold_ingot', 'lapis_lazuli',
  'flint', 'blaze_rod', 'blaze_powder', 'ender_pearl', 'ender_eye', 'obsidian',
  // The portable crafting table and everything the end-game stages consume
  'crafting_table', 'bow', 'arrow', 'string', 'feather', 'stick', 'coal', 'charcoal'
]);

/**
 * Check whether an item is part of the spawn bed logistics (the bed itself or the wool to craft it)
 * @param {string} name Item name
 * @returns {boolean} True for beds and wool of any color
 */
function isBedMaterial(name) {
  return name.endsWith('_bed') || name.endsWith('_wool');
}

// Retain limited terrain and utility blocks for bridging and flint harvesting
const BULK_MATERIALS = new Set(['dirt', 'cobblestone', 'granite', 'diorite', 'andesite', 'cobbled_deepslate', 'gravel', 'sand']);

const FLOWER_KEYWORDS = [
  'tulip', 'dandelion', 'poppy', 'daisy', 'lily_of_the_valley',
  'allium', 'orchid', 'bluet', 'cornflower', 'sunflower', 'lilac', 'peony', 'rose_bush', 'pink_petals'
];

const DISPOSABLE_EXACT = new Set([
  'rotten_flesh', 'spider_eye', 'gunpowder', 'raw_copper',
  'copper_ingot', 'bone', 'egg', 'snowball'
]);

/**
 * Determine whether an inventory item is non-essential clutter safe to store or discard
 * @param {object} item Mineflayer inventory item
 * @returns {boolean} True if the item is disposable clutter
 */
function isDisposableItem(item) {
  if (!item?.name || ESSENTIAL_ITEMS.has(item.name) || isBedMaterial(item.name)) return false;
  if (DISPOSABLE_EXACT.has(item.name)) return true;
  if (item.name.includes('sapling') || item.name.includes('seeds')) {
    return true;
  }
  return FLOWER_KEYWORDS.some(keyword => item.name.includes(keyword));
}

/**
 * Determine whether an inventory item should be deposited into storage
 * @param {object} item Mineflayer inventory item
 * @returns {boolean} True if the item is bulky and should be stored
 */
function isItemToStore(item) {
  if (ESSENTIAL_ITEMS.has(item.name) || isBedMaterial(item.name)) return false;

  if (BULK_MATERIALS.has(item.name)) {
    return item.count > 32;
  }

  return isDisposableItem(item);
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
 * Locate an accessible chest block nearby or from base memory
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {object|null} Located chest block or null
 */
function findTargetChest(bot, state) {
  const chestBlockId = bot.registry.blocksByName.chest?.id;
  const nearbyChest = chestBlockId ? bot.findBlock({ matching: chestBlockId, maxDistance: 24 }) : null;
  if (nearbyChest || !state.base.chest) return nearbyChest;

  const rememberedChest = bot.blockAt(state.base.chest);
  if (!rememberedChest) return null;

  if (rememberedChest.name !== 'chest') {
    state.base.chest = null;
    return null;
  }

  const dist = bot.entity.position.distanceTo(rememberedChest.position);
  return dist <= 24 ? rememberedChest : null;
}

/**
 * Compute the list of inventory items and quantities to deposit into storage
 * @param {Array<object>} items Current inventory items
 * @returns {Array<{ item: object, amountToDeposit: number }>} Planned deposits
 */
function buildDepositPlan(items) {
  const keptCounts = {};
  const deposits = [];

  for (const item of items) {
    const isBulk = BULK_MATERIALS.has(item.name);
    if (!isBulk && !isItemToStore(item)) continue;

    const maxToKeep = isBulk ? 32 : 0;
    const alreadyKept = keptCounts[item.name] || 0;
    const keepFromThisStack = Math.min(item.count, Math.max(0, maxToKeep - alreadyKept));
    keptCounts[item.name] = alreadyKept + keepFromThisStack;

    const amountToDeposit = item.count - keepFromThisStack;
    if (amountToDeposit > 0) {
      deposits.push({ item, amountToDeposit });
    }
  }

  return deposits;
}

/**
 * Manage automatic inventory organization into a nearby chest
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Result of the chest sorting operation
 */
async function skillChest(bot, state) {
  const chestBlock = findTargetChest(bot, state);

  if (!chestBlock) {
    const hasInPocket = bot.inventory.items().some(i => i.name === 'chest');
    const message = hasInPocket
      ? "No chest placed nearby. Use 'place' with target 'chest' to place your chest on the ground first."
      : "No chest found nearby. Craft and place a chest ('craft chest' then 'place chest') first.";
    return { success: false, message };
  }

  let chest = null;
  try {
    if (bot.entity.position.distanceTo(chestBlock.position) > 3) {
      const gotoPromise = bot.pathfinder.goto(new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z));
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Navigation timeout towards chest")), 15000));
      await Promise.race([gotoPromise, timeoutPromise]);
    }

    chest = await bot.openChest(chestBlock);
    const deposits = buildDepositPlan(bot.inventory.items());
    const { depositedCount, depositedNames } = await depositItems(chest, deposits);

    if (depositedCount === 0) {
      return { success: true, message: "Inventory already clean; no bulky items to deposit." };
    }

    const suffix = depositedNames.length > 4 ? '...' : '';
    return {
      success: true,
      message: `Chest sorting complete; deposited ${depositedNames.slice(0, 4).join(', ')}${suffix}.`
    };
  } catch (error) {
    console.warn("Chest error:", error.message);
    return { success: false, message: `Chest storage failed: ${error.message}` };
  } finally {
    if (chest) chest.close();
  }
}

/**
 * Check whether the bot inventory is cluttered with bulky items and needs chest storage
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if inventory is nearly full or carries excessive bulk blocks
 */
function isInventoryCluttered(bot) {
  const items = bot.inventory?.items() || [];
  const hasStorableItems = items.some(item => isItemToStore(item));
  if (!hasStorableItems) return false;

  if (typeof bot.inventory?.emptySlotCount === 'function') {
    return bot.inventory.emptySlotCount() <= 4;
  }

  const bulkCount = items
    .filter(item => BULK_MATERIALS.has(item.name))
    .reduce((sum, item) => sum + item.count, 0);

  return items.length >= 24 || bulkCount >= 256;
}

/**
 * Select non-essential and surplus bulk stacks eligible to be tossed when freeing inventory space
 * @param {Array<object>} items Current inventory item stacks
 * @returns {Array<object>} Ordered list of item stacks safe to toss
 */
function selectStacksToToss(items) {
  const disposable = items.filter(item => isDisposableItem(item));
  const bulkStacksByName = new Map();

  for (const item of items) {
    if (!item?.name || !BULK_MATERIALS.has(item.name)) continue;
    if (!bulkStacksByName.has(item.name)) {
      bulkStacksByName.set(item.name, []);
    }
    bulkStacksByName.get(item.name).push(item);
  }

  const surplusBulk = [];
  for (const stacks of bulkStacksByName.values()) {
    let remainingTotal = stacks.reduce((sum, stack) => sum + (stack.count || 0), 0);
    const sorted = [...stacks].sort((a, b) => (a.count || 0) - (b.count || 0));
    for (const stack of sorted) {
      const stackCount = stack.count || 0;
      if (remainingTotal - stackCount >= 32) {
        surplusBulk.push(stack);
        remainingTotal -= stackCount;
      }
    }
  }

  return [...disposable, ...surplusBulk];
}

/**
 * Recursively toss selected item stacks until the required number of inventory slots is free
 * @param {object} bot Mineflayer bot instance
 * @param {Array<object>} stacks Ordered stacks eligible to toss
 * @param {number} index Current index in the stacks array
 * @param {number} requiredFreeSlots Minimum number of free inventory slots required
 * @returns {Promise<void>}
 */
async function tossStacksUntilSpace(bot, stacks, index, requiredFreeSlots) {
  if (bot.inventory.emptySlotCount() >= requiredFreeSlots || index >= stacks.length) {
    return;
  }

  const stack = stacks[index];
  if (stack?.type !== undefined && stack.count > 0) {
    await bot.toss(stack.type, stack.metadata ?? null, stack.count).catch(() => {});
  }

  return tossStacksUntilSpace(bot, stacks, index + 1, requiredFreeSlots);
}

/**
 * Free inventory slots by tossing disposable clutter and surplus bulk blocks when inventory is full
 * @param {object} bot Mineflayer bot instance
 * @param {number} [requiredFreeSlots=1] Minimum number of free inventory slots required
 * @returns {Promise<boolean>} True if the required number of free slots is available
 */
async function freeInventorySlotIfFull(bot, requiredFreeSlots = 1) {
  if (typeof bot.inventory?.emptySlotCount !== 'function' || typeof bot.toss !== 'function') {
    return false;
  }

  if (bot.inventory.emptySlotCount() >= requiredFreeSlots) {
    return true;
  }

  const stacksToToss = selectStacksToToss(bot.inventory.items() || []);
  await tossStacksUntilSpace(bot, stacksToToss, 0, requiredFreeSlots);
  return bot.inventory.emptySlotCount() >= requiredFreeSlots;
}

module.exports = { skillChest, isItemToStore, isInventoryCluttered, isDisposableItem, freeInventorySlotIfFull };
