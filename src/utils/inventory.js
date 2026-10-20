const config = require('../config');
const { syncAdvancementsWithInventory } = require('./advancements');

const GENERIC_LOG_NAMES = new Set(['log', 'logs', 'wood', 'bois', 'buche', 'buches', 'bûche', 'bûches', 'tree', 'arbre']);
const GENERIC_PLANK_NAMES = new Set(['planks', 'plank', 'planche', 'planches']);
const WOOD_TYPES = [
  'dark_oak', 'oak', 'spruce', 'birch', 'jungle', 'acacia', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped'
];

/**
 * Check whether an item or block name corresponds to a tree log or wood
 * @param {string} name Item or block name
 * @returns {boolean} True if wood log
 */
function isWoodLog(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.toLowerCase().trim();
  if (GENERIC_LOG_NAMES.has(clean)) return true;
  return clean.endsWith('_log') || clean.endsWith('_wood') || clean.endsWith('_stem') || clean.endsWith('_hyphae');
}

/**
 * Check whether an item or block name corresponds to planks
 * @param {string} name Item or block name
 * @returns {boolean} True if planks
 */
function isPlanks(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.toLowerCase().trim();
  if (GENERIC_PLANK_NAMES.has(clean)) return true;
  return clean.endsWith('_planks');
}

/**
 * Extract wood variety type from an item name
 * @param {string} name Item or block name
 * @returns {string|null} Wood type identifier or null
 */
function getWoodType(name) {
  if (!name || typeof name !== 'string') return null;
  const clean = name.toLowerCase().trim();
  for (const type of WOOD_TYPES) {
    if (clean.includes(type)) return type;
  }
  return null;
}

/**
 * Determine plank item name corresponding to a log name
 * @param {string} logName Log or wood block name
 * @returns {string} Matching plank item name
 */
function getPlankForLog(logName) {
  const type = getWoodType(logName);
  return type ? `${type}_planks` : 'oak_planks';
}

/**
 * Resolve target plank name according to logs currently carried in inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} requestedTarget Requested plank target
 * @returns {string} Optimal craftable plank item name
 */
function resolvePlankTarget(bot, requestedTarget) {
  const inventoryItems = (bot.inventory?.slots || []).filter(Boolean);
  const logsInInventory = inventoryItems.filter(i => isWoodLog(i.name));

  // Fallback to existing planks if no logs in inventory
  if (logsInInventory.length === 0) {
    const existingPlanks = inventoryItems.find(i => isPlanks(i.name));
    if (existingPlanks) return existingPlanks.name;
    const requestedType = getWoodType(requestedTarget);
    return requestedType ? `${requestedType}_planks` : 'oak_planks';
  }

  // Preserve requested wood type if matching logs are present
  const requestedWoodType = getWoodType(requestedTarget);
  if (requestedWoodType) {
    const hasMatchingLog = logsInInventory.some(l => getWoodType(l.name) === requestedWoodType);
    if (hasMatchingLog) {
      return `${requestedWoodType}_planks`;
    }
  }

  // Pick the wood type with largest quantity in inventory
  logsInInventory.sort((a, b) => b.count - a.count);
  const bestType = getWoodType(logsInInventory[0].name) || 'oak';
  return `${bestType}_planks`;
}

/**
 * Count total quantity of a given item in the inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} name Target item name
 * @returns {number} Cumulative quantity of the item
 */
function countItem(bot, name) {
  const allSlots = (bot.inventory?.slots || []).filter(Boolean);

  // Sum all logs for generic wood query
  if (name === 'log' || name === 'logs' || name === 'wood' || name === 'bois') {
    return allSlots.filter(item => isWoodLog(item.name)).reduce((sum, item) => sum + item.count, 0);
  }

  // Sum all planks for generic plank query
  if (name === 'planks' || name === 'plank' || name === 'planche' || name === 'planches') {
    return allSlots.filter(item => isPlanks(item.name)).reduce((sum, item) => sum + item.count, 0);
  }

  const exactCount = allSlots.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  if (exactCount > 0) return exactCount;

  // Substitute matching logs if specific wood type is missing
  if (isWoodLog(name)) {
    return allSlots.filter(item => isWoodLog(item.name)).reduce((sum, item) => sum + item.count, 0);
  }

  // Substitute matching planks if specific plank type is missing
  if (isPlanks(name)) {
    return allSlots.filter(item => isPlanks(item.name)).reduce((sum, item) => sum + item.count, 0);
  }

  return 0;
}

/**
 * Check whether the bot possesses at least one tool of a specific type
 * @param {object} bot Mineflayer bot instance
 * @param {string} suffix Tool type suffix (e.g. '_pickaxe', '_axe')
 * @returns {boolean} True if matching tool is owned
 */
function hasToolType(bot, suffix) {
  const allSlots = (bot.inventory?.slots || []).filter(Boolean);
  return allSlots.some(item => item.name.endsWith(suffix));
}

/**
 * Return deduplicated list of tools present in the inventory
 * @param {object} bot Mineflayer bot instance
 * @returns {string[]} List of owned tool names
 */
function getOwnedTools(bot) {
  const allSlots = (bot.inventory?.slots || []).filter(Boolean);
  const tools = allSlots
    .filter(item => config.TOOL_SUFFIXES.some(suffix => item.name.endsWith(suffix)))
    .map(item => item.name);
  return [...new Set(tools)];
}

const TOOL_TIERS = {
  pickaxe: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
  axe: ['wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe'],
  sword: ['wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword']
};

/**
 * Determine whether a quest objective is achieved according to current inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} questName Objective name to check
 * @param {object} state Global bot state
 * @returns {boolean} True if objective is achieved
 */
function isQuestDone(bot, questName, state) {
  for (const tierList of Object.values(TOOL_TIERS)) {
    const questIndex = tierList.indexOf(questName);
    if (questIndex !== -1) {
      return tierList.slice(questIndex).some(tool => countItem(bot, tool) > 0);
    }
  }

  if (questName === 'furnace' || questName === 'crafting_table') {
    const hasInInventory = countItem(bot, questName) > 0;
    const isPlacedInBase = Boolean(state?.base?.[questName]);
    const nearbyBlock = bot.findBlock({ matching: bot.registry.blocksByName[questName]?.id, maxDistance: 32 });
    const hasAdvancedGear = questName === 'furnace' && (countItem(bot, 'iron_ingot') > 0 || countItem(bot, 'iron_pickaxe') > 0);
    return hasInInventory || isPlacedInBase || Boolean(nearbyBlock) || hasAdvancedGear;
  }

  if (questName === 'raw_iron' || questName === 'iron_ore' || questName === 'iron_ingot') {
    const required = config.QUEST_AMOUNT[questName] || 3;
    const hasAdvancedGear = countItem(bot, 'iron_pickaxe') > 0 || countItem(bot, 'iron_sword') > 0 || countItem(bot, 'shield') > 0;
    const hasIngots = countItem(bot, 'iron_ingot') >= (config.QUEST_AMOUNT.iron_ingot || 3);
    const hasRaw = countItem(bot, 'raw_iron') >= required || countItem(bot, 'iron_ore') >= required;
    return hasAdvancedGear || hasIngots || hasRaw;
  }

  if (questName === 'cobblestone') {
    const required = config.QUEST_AMOUNT.cobblestone || 3;
    return countItem(bot, 'cobblestone') >= required || countItem(bot, 'stone_pickaxe') > 0 || countItem(bot, 'iron_pickaxe') > 0;
  }

  // Validate bucket quest if empty or filled bucket is owned
  if (questName === 'bucket') {
    return countItem(bot, 'bucket') > 0 || countItem(bot, 'water_bucket') > 0 || countItem(bot, 'lava_bucket') > 0;
  }

  // Validate water_bucket quest if water bucket is owned or already inside Nether
  if (questName === 'water_bucket') {
    return countItem(bot, 'water_bucket') > 0 || bot.game?.dimension === 'the_nether' || countItem(bot, 'blaze_rod') > 0;
  }

  // Validate nether_portal quest once inside the Nether or holding blaze rods
  if (questName === 'nether_portal') {
    return bot.game?.dimension === 'the_nether' || countItem(bot, 'blaze_rod') > 0 || countItem(bot, 'blaze_powder') > 0 || countItem(bot, 'ender_eye') > 0;
  }

  // Validate blaze_rod quest even after rods are crafted into powder or eyes
  if (questName === 'blaze_rod') {
    const required = config.QUEST_AMOUNT.blaze_rod || 7;
    const equivalentRods = countItem(bot, 'blaze_rod') + Math.ceil((countItem(bot, 'blaze_powder') + countItem(bot, 'ender_eye')) / 2);
    return equivalentRods >= required;
  }

  // Validate blaze_powder quest even after powder is crafted into ender eyes
  if (questName === 'blaze_powder') {
    const required = config.QUEST_AMOUNT.blaze_powder || 12;
    return (countItem(bot, 'blaze_powder') + countItem(bot, 'ender_eye')) >= required;
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
    'wooden_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_sword',
    'iron_pickaxe', 'iron_axe', 'iron_sword', 'shield',
    'flint_and_steel', 'blaze_powder', 'ender_eye'
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

  // Provide generic planks craft option if any wood plank variety is available
  const canCraftAnyPlanks = availableCrafts.some(craft => isPlanks(craft));
  if (canCraftAnyPlanks && !availableCrafts.includes('planks')) {
    availableCrafts.unshift('planks');
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
  getBestToolForBlock,
  isWoodLog,
  isPlanks,
  getWoodType,
  getPlankForLog,
  resolvePlankTarget
};
