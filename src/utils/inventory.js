const config = require('../config');
const { syncAdvancementsWithInventory } = require('./advancements');

/**
 * Count total quantity of a given item in the inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} name Nom de l'item recherché
 * @returns {number} Quantité cumulée de l'item
 */
function countItem(bot, name) {
  const allSlots = (bot.inventory?.slots || []).filter(Boolean);
  return allSlots.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

/**
 * Check whether the bot possesses at least one tool of a specific type
 * @param {object} bot Mineflayer bot instance
 * @param {string} suffix Suffixe du type d'outil (ex: '_pickaxe', '_axe')
 * @returns {boolean} True si un outil correspondant est possédé
 */
function hasToolType(bot, suffix) {
  const allSlots = (bot.inventory?.slots || []).filter(Boolean);
  return allSlots.some(item => item.name.endsWith(suffix));
}

/**
 * Return deduplicated list of tools present in the inventory
 * @param {object} bot Mineflayer bot instance
 * @returns {string[]} Liste des noms d'outils possédés
 */
function getOwnedTools(bot) {
  const allSlots = (bot.inventory?.slots || []).filter(Boolean);
  const tools = allSlots
    .filter(item => config.TOOL_SUFFIXES.some(suffix => item.name.endsWith(suffix)))
    .map(item => item.name);
  return [...new Set(tools)];
}

/**
 * Determine whether a quest objective is achieved according to current inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} questName Nom de l'objectif à vérifier
 * @returns {boolean} True si l'objectif est complété
 */
function isQuestDone(bot, questName, state) {
  if (questName === 'cobblestone') {
    const requiredAmount = config.QUEST_AMOUNT.cobblestone || 3;
    return countItem(bot, 'cobblestone') >= requiredAmount || countItem(bot, 'stone_pickaxe') > 0 || countItem(bot, 'iron_pickaxe') > 0;
  }

  if (questName === 'furnace') {
    const hasFurnaceInInventory = countItem(bot, 'furnace') > 0;
    const hasPlacedFurnace = Boolean(state?.base?.furnace);
    const hasAdvancedIronItems = countItem(bot, 'iron_ingot') > 0 || countItem(bot, 'iron_pickaxe') > 0 || countItem(bot, 'iron_sword') > 0;
    const nearbyFurnace = bot.findBlock({ matching: bot.registry.blocksByName.furnace?.id, maxDistance: 32 });
    return hasFurnaceInInventory || hasPlacedFurnace || Boolean(nearbyFurnace) || hasAdvancedIronItems;
  }

  if (questName === 'crafting_table') {
    const hasTableInInventory = countItem(bot, 'crafting_table') > 0;
    const hasPlacedTable = Boolean(state?.base?.crafting_table);
    const nearbyTable = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table?.id, maxDistance: 32 });
    return hasTableInInventory || hasPlacedTable || Boolean(nearbyTable);
  }

  if (questName === 'raw_iron' || questName === 'iron_ore') {
    const requiredAmount = config.QUEST_AMOUNT.raw_iron || config.QUEST_AMOUNT.iron_ore || 3;
    const hasRawIron = countItem(bot, 'raw_iron') >= requiredAmount;
    const hasIronOre = countItem(bot, 'iron_ore') >= requiredAmount;
    const hasIronIngot = countItem(bot, 'iron_ingot') > 0;
    const hasIronGear = countItem(bot, 'iron_pickaxe') > 0 || countItem(bot, 'iron_sword') > 0 || countItem(bot, 'iron_chestplate') > 0 || countItem(bot, 'shield') > 0;
    return hasRawIron || hasIronOre || hasIronIngot || hasIronGear;
  }

  if (questName === 'iron_ingot') {
    const requiredAmount = config.QUEST_AMOUNT.iron_ingot || 3;
    const hasIronGear = countItem(bot, 'iron_pickaxe') > 0 || countItem(bot, 'iron_sword') > 0 || countItem(bot, 'iron_chestplate') > 0 || countItem(bot, 'shield') > 0;
    return countItem(bot, 'iron_ingot') >= requiredAmount || hasIronGear;
  }

  if (questName === 'wooden_axe') {
    return countItem(bot, 'wooden_axe') > 0 || countItem(bot, 'stone_axe') > 0 || countItem(bot, 'iron_axe') > 0;
  }

  if (questName === 'wooden_pickaxe') {
    return countItem(bot, 'wooden_pickaxe') > 0 || countItem(bot, 'stone_pickaxe') > 0 || countItem(bot, 'iron_pickaxe') > 0;
  }

  if (questName === 'stone_pickaxe') {
    return countItem(bot, 'stone_pickaxe') > 0 || countItem(bot, 'iron_pickaxe') > 0 || countItem(bot, 'diamond_pickaxe') > 0;
  }

  if (questName === 'stone_axe') {
    return countItem(bot, 'stone_axe') > 0 || countItem(bot, 'iron_axe') > 0 || countItem(bot, 'diamond_axe') > 0;
  }

  if (questName === 'iron_pickaxe') {
    return countItem(bot, 'iron_pickaxe') > 0 || countItem(bot, 'diamond_pickaxe') > 0;
  }

  return countItem(bot, questName) >= (config.QUEST_AMOUNT[questName] || 1);
}

/**
 * Update the bot's current objective following the progression chain
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 */
function syncObjective(bot, state) {
  syncAdvancementsWithInventory(bot, state);

  if (state.manualObjective) return;

  if (state.completedQuests) {
    for (const name of config.QUEST_CHAIN) {
      if (isQuestDone(bot, name, state)) {
        state.completedQuests.add(name);
      }
    }
  }

  const nextObjective = config.QUEST_CHAIN.find(name => {
    if (state.completedQuests?.has(name)) return false;
    return !isQuestDone(bot, name, state);
  }) || config.QUEST_CHAIN.at(-1);

  if (nextObjective !== state.currentObjective) {
    const previousObjective = state.currentObjective;
    if (previousObjective) {
      state.completedQuests?.add(previousObjective);
    }
    state.currentObjective = nextObjective;

    if (previousObjective && previousObjective !== nextObjective) {
      bot.chat(`🚀 NOUVEAU PALIER : ${state.currentObjective}`);
      state.lastActionResult = {
        ...state.lastActionResult,
        message: `${state.lastActionResult.message} | Palier '${previousObjective}' terminé. NOUVEL objectif : obtenir '${state.currentObjective}'.`
      };
    }
  }
}

/**
 * Generate a compact JSON summary of inventory contents
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Textual representation of inventory
 */
function getInventorySummary(bot) {
  const inventoryItems = (bot.inventory?.slots || []).filter(Boolean);
  if (inventoryItems.length === 0) return "Inventaire vide";

  const summary = {};
  inventoryItems.forEach(item => {
    summary[item.name] = (summary[item.name] || 0) + item.count;
  });
  return JSON.stringify(summary);
}

/**
 * Return list of crafts immediately craftable with current inventory
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} craftingTable Placed crafting table block nearby if available
 * @returns {string[]} List of craftable item names and requirements
 */
function getAvailableCrafts(bot, craftingTable) {
  const targetItemsToCheck = [
    'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks',
    'stick', 'crafting_table', 'chest', 'furnace', 'torch', 'bucket',
    'wooden_axe', 'wooden_pickaxe', 'wooden_sword',
    'stone_pickaxe', 'stone_axe', 'stone_sword',
    'iron_pickaxe', 'iron_axe', 'iron_sword', 'shield', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
    'diamond_pickaxe', 'diamond_axe', 'diamond_sword', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
    'flint_and_steel', 'ender_eye'
  ];
  const availableCrafts = [];
  const hasCraftingTableInInventory = countItem(bot, 'crafting_table') > 0;
  const dummyTable = craftingTable || (hasCraftingTableInInventory ? { type: bot.registry.blocksByName['crafting_table']?.id, name: 'crafting_table' } : null);

  for (const itemName of targetItemsToCheck) {
    const itemDefinition = bot.registry.itemsByName[itemName];
    if (!itemDefinition) continue;

    const recipesInInventoryGrid = bot.recipesFor(itemDefinition.id, null, 1, null);
    if (recipesInInventoryGrid.length > 0) {
      availableCrafts.push(itemName);
      continue;
    }

    if (dummyTable) {
      const recipesWithTable = bot.recipesFor(itemDefinition.id, null, 1, dummyTable);
      if (recipesWithTable.length > 0) {
        if (!craftingTable) {
          availableCrafts.push(`${itemName} (nécessite de poser ton établi d'abord)`);
        } else {
          availableCrafts.push(itemName);
        }
      }
    }
  }

  return availableCrafts;
}

const PICKAXE_ORDER = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
const AXE_ORDER = ['netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe'];
const SHOVEL_ORDER = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'golden_shovel', 'stone_shovel', 'wooden_shovel'];

/**
 * Select the best tool in inventory to mine a specific block
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Target block
 * @returns {object|null} Best matching tool item or null
 */
function getBestToolForBlock(bot, block) {
  const inventoryItems = bot.inventory.items();
  const blockName = block?.name || '';

  if (blockName.includes('stone') || blockName.includes('cobble') || blockName.includes('ore') || blockName.includes('deepslate') || blockName.includes('debris') || blockName.includes('obsidian') || blockName.includes('brick') || blockName.includes('furnace')) {
    for (const toolName of PICKAXE_ORDER) {
      const toolItem = inventoryItems.find(item => item.name === toolName);
      if (toolItem) return toolItem;
    }
  }

  if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('planks') || blockName === 'crafting_table' || blockName.includes('fence') || blockName.includes('chest')) {
    for (const toolName of AXE_ORDER) {
      const toolItem = inventoryItems.find(item => item.name === toolName);
      if (toolItem) return toolItem;
    }
  }

  if (blockName.includes('dirt') || blockName.includes('grass') || blockName.includes('sand') || blockName.includes('gravel') || blockName.includes('clay') || blockName.includes('mud')) {
    for (const toolName of SHOVEL_ORDER) {
      const toolItem = inventoryItems.find(item => item.name === toolName);
      if (toolItem) return toolItem;
    }
  }

  return null;
}

module.exports = {
  countItem,
  hasToolType,
  getOwnedTools,
  isQuestDone,
  syncObjective,
  getInventorySummary,
  getAvailableCrafts,
  getBestToolForBlock
};
