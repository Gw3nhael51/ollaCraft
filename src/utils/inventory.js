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
 * Return carried inventory items including equipped armor (5..8) and off-hand (45) while excluding 2x2 crafting grid (0..4)
 * @param {object} bot Mineflayer bot instance
 * @returns {Array<object>} List of inventory and equipped items
 */
function getCarriedItems(bot) {
  if (Array.isArray(bot.inventory?.slots)) {
    return bot.inventory.slots.slice(5).filter(Boolean);
  }
  if (typeof bot.inventory?.items === 'function') {
    return bot.inventory.items();
  }
  return [];
}

/**
 * Resolve target plank name according to logs currently carried in inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} requestedTarget Requested plank target
 * @returns {string} Optimal craftable plank item name
 */
function resolvePlankTarget(bot, requestedTarget) {
  const inventoryItems = getCarriedItems(bot);
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
  if (!name || typeof name !== 'string') return 0;
  const clean = name.toLowerCase().trim();
  const allSlots = getCarriedItems(bot);

  // Sum all logs for generic wood query
  if (GENERIC_LOG_NAMES.has(clean)) {
    return allSlots.filter(item => isWoodLog(item.name)).reduce((sum, item) => sum + item.count, 0);
  }

  // Sum all planks for generic plank query
  if (GENERIC_PLANK_NAMES.has(clean)) {
    return allSlots.filter(item => isPlanks(item.name)).reduce((sum, item) => sum + item.count, 0);
  }

  return allSlots.filter(item => item.name === clean).reduce((sum, item) => sum + item.count, 0);
}

/**
 * Check whether the bot possesses at least one tool of a specific type
 * @param {object} bot Mineflayer bot instance
 * @param {string} suffix Tool type suffix (e.g. '_pickaxe', '_axe')
 * @returns {boolean} True if matching tool is owned
 */
function hasToolType(bot, suffix) {
  const allSlots = getCarriedItems(bot);
  return allSlots.some(item => item.name.endsWith(suffix));
}

/**
 * Return deduplicated list of tools present in the inventory
 * @param {object} bot Mineflayer bot instance
 * @returns {string[]} List of owned tool names
 */
function getOwnedTools(bot) {
  const allSlots = getCarriedItems(bot);
  const tools = allSlots
    .filter(item => config.TOOL_SUFFIXES.some(suffix => item.name.endsWith(suffix)))
    .map(item => item.name);
  return [...new Set(tools)];
}

const TOOL_TIERS = {
  pickaxe: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
  axe: ['wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe'],
  sword: ['wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword'],
  helmet: ['iron_helmet', 'diamond_helmet', 'netherite_helmet'],
  chestplate: ['iron_chestplate', 'diamond_chestplate', 'netherite_chestplate'],
  leggings: ['iron_leggings', 'diamond_leggings', 'netherite_leggings'],
  boots: ['iron_boots', 'diamond_boots', 'netherite_boots']
};

// Quests requiring the item (or a higher tool tier) to remain in inventory
const PERSISTENT_GEAR_QUESTS = new Set([
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'iron_sword', 'shield',
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'
]);

// Equivalent items or conditions that directly satisfy a specific quest
const QUEST_EQUIVALENTS = {
  raw_iron: ['raw_iron', 'iron_ore'],
  bucket: ['bucket', 'water_bucket', 'lava_bucket'],
  blaze_rod: (bot) => countItem(bot, 'blaze_rod') + Math.ceil((countItem(bot, 'blaze_powder') + countItem(bot, 'ender_eye')) / 2),
  blaze_powder: (bot) => countItem(bot, 'blaze_powder') + countItem(bot, 'ender_eye'),
  ender_pearl: (bot) => countItem(bot, 'ender_pearl') + countItem(bot, 'ender_eye'),
  nether_portal: (bot) => (bot.game?.dimension === 'the_nether' ? 1 : 0)
};

/**
 * Check whether a single quest requirement is directly met by current inventory or surroundings
 * @param {object} bot Mineflayer bot instance
 * @param {string} questName Objective name to check
 * @param {object} state Global bot state
 * @returns {boolean} True if directly satisfied
 */
function isQuestDirectlyMet(bot, questName, state) {
  for (const tierList of Object.values(TOOL_TIERS)) {
    const idx = tierList.indexOf(questName);
    if (idx !== -1) {
      return tierList.slice(idx).some(tool => countItem(bot, tool) > 0);
    }
  }

  if (questName === 'furnace' || questName === 'crafting_table') {
    const nearby = bot.findBlock({ matching: bot.registry.blocksByName[questName]?.id, maxDistance: 32 });
    return countItem(bot, questName) > 0 || Boolean(state?.base?.[questName]) || Boolean(nearby);
  }

  const required = config.QUEST_AMOUNT[questName] || 1;
  const rule = QUEST_EQUIVALENTS[questName];

  if (typeof rule === 'function') return rule(bot) >= required;
  if (Array.isArray(rule)) return rule.some(item => countItem(bot, item) >= required);

  return countItem(bot, questName) >= required;
}

/**
 * Determine whether a quest objective is achieved according to current inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} questName Objective name to check
 * @param {object} state Global bot state
 * @returns {boolean} True if objective is achieved
 */
function isQuestDone(bot, questName, state) {
  if (isQuestDirectlyMet(bot, questName, state)) return true;
  if (PERSISTENT_GEAR_QUESTS.has(questName)) return false;

  const questIndex = config.QUEST_CHAIN.indexOf(questName);
  if (questIndex === -1) return false;

  return config.QUEST_CHAIN.slice(questIndex + 1).some(laterQuest => isQuestDirectlyMet(bot, laterQuest, state));
}

const BASE_STATION_NAMES = ['crafting_table', 'furnace', 'chest'];

/**
 * Discover and memorize nearby placed base stations if not already recorded in state
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 */
function syncBaseStations(bot, state) {
  if (!state?.base || typeof bot.findBlock !== 'function') return;

  for (const stationName of BASE_STATION_NAMES) {
    if (state.base[stationName]) continue;
    const stationId = bot.registry?.blocksByName?.[stationName]?.id;
    const found = stationId ? bot.findBlock({ matching: stationId, maxDistance: config.CRAFTING_TABLE_RANGE }) : null;
    if (found?.position) {
      state.base[stationName] = found.position.clone ? found.position.clone() : found.position;
    }
  }
}

/**
 * Update the bot's current objective following the progression chain
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 */
function syncObjective(bot, state) {
  syncAdvancementsWithInventory(bot, state);
  syncBaseStations(bot, state);

  if (state.manualObjective) return;

  if (state.completedQuests) {
    state.completedQuests.clear();
    for (const name of config.QUEST_CHAIN) {
      if (isQuestDone(bot, name, state)) {
        state.completedQuests.add(name);
      }
    }
  }

  const nextObjective = config.QUEST_CHAIN.find(name => !state.completedQuests?.has(name)) || config.QUEST_CHAIN.at(-1);

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

  if (
    state.currentObjective !== 'wooden_pickaxe' &&
    state.managerDirective === "Récolter du bois pour fabriquer les premiers outils."
  ) {
    state.managerDirective = `Progresser vers l'objectif '${state.currentObjective}' en utilisant l'équipement déjà possédé.`;
  }
}

/**
 * Generate a compact JSON summary of inventory contents
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Textual representation of inventory
 */
function getInventorySummary(bot) {
  const inventoryItems = getCarriedItems(bot);
  if (inventoryItems.length === 0) return "Inventaire vide";

  const summary = {};
  inventoryItems.forEach(item => {
    summary[item.name] = (summary[item.name] || 0) + item.count;
  });
  return JSON.stringify(summary);
}

/**
 * Locate a placed crafting table within reach or remembered in base state
 * @param {object} bot Mineflayer bot instance
 * @param {object} [state] Global bot state
 * @param {number} [maxDistance] Maximum detection distance
 * @returns {object|null} Located crafting table block or null
 */
function findNearbyCraftingTable(bot, state, maxDistance = config.CRAFTING_TABLE_RANGE) {
  const tableId = bot.registry?.blocksByName?.crafting_table?.id;
  const nearby = tableId ? bot.findBlock({ matching: tableId, maxDistance }) : null;
  if (nearby) {
    if (state?.base && !state.base.crafting_table && nearby.position) {
      state.base.crafting_table = nearby.position.clone ? nearby.position.clone() : nearby.position;
    }
    return nearby;
  }
  if (!state?.base?.crafting_table) return null;

  const basePos = state.base.crafting_table;
  const baseTableBlock = bot.blockAt(basePos);
  if (!baseTableBlock) return null;

  // Clear remembered base coordinate if crafting table is no longer present
  if (baseTableBlock.name !== 'crafting_table') {
    state.base.crafting_table = null;
    return null;
  }

  const targetPos = baseTableBlock.position || basePos;
  const dist = bot.entity?.position?.distanceTo ? bot.entity.position.distanceTo(targetPos) : 0;
  return dist <= maxDistance ? baseTableBlock : null;
}

/**
 * Resolve craft availability label for a single item
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Item name to evaluate
 * @param {object|null} craftingTable Placed crafting table block if available
 * @param {object|null} dummyTable Virtual or placed table for recipe lookup
 * @returns {string|null} Craftable label or null if not craftable
 */
function resolveCraftEntry(bot, itemName, craftingTable, dummyTable) {
  const itemDefinition = bot.registry.itemsByName[itemName];
  if (!itemDefinition) return null;

  if (bot.recipesFor(itemDefinition.id, null, 1, null).length > 0) {
    return itemName;
  }

  if (dummyTable && bot.recipesFor(itemDefinition.id, null, 1, dummyTable).length > 0) {
    return craftingTable ? itemName : `${itemName} (nécessite de poser ton établi d'abord)`;
  }

  return null;
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
    'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel',
    'stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel',
    'iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_shovel', 'shield',
    'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
    'flint_and_steel', 'blaze_powder', 'ender_eye'
  ];
  const hasTableInInv = countItem(bot, 'crafting_table') > 0;
  const dummyTable = craftingTable || (hasTableInInv ? { type: bot.registry.blocksByName['crafting_table']?.id, name: 'crafting_table' } : null);

  const availableCrafts = targetItemsToCheck
    .map(itemName => resolveCraftEntry(bot, itemName, craftingTable, dummyTable))
    .filter(Boolean);

  // Provide generic planks craft option if any wood plank variety is available
  if (availableCrafts.some(craft => isPlanks(craft)) && !availableCrafts.includes('planks')) {
    availableCrafts.unshift('planks');
  }

  return availableCrafts;
}

const PICKAXE_ORDER = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
const AXE_ORDER = ['netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe'];
const SHOVEL_ORDER = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'golden_shovel', 'stone_shovel', 'wooden_shovel'];

const BLOCK_TOOL_GROUPS = [
  { keywords: ['stone', 'cobble', 'ore', 'deepslate', 'debris', 'obsidian', 'brick', 'furnace'], tools: PICKAXE_ORDER },
  { keywords: ['log', 'wood', 'planks', 'crafting_table', 'fence', 'chest'], tools: AXE_ORDER },
  { keywords: ['dirt', 'grass', 'sand', 'gravel', 'clay', 'mud'], tools: SHOVEL_ORDER }
];

/**
 * Select the best tool in inventory to mine a specific block
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Target block
 * @returns {object|null} Best matching tool item or null
 */
function getBestToolForBlock(bot, block) {
  const inventoryItems = bot.inventory.items();
  const blockName = block?.name || '';

  const matchingGroup = BLOCK_TOOL_GROUPS.find(group =>
    group.keywords.some(keyword => blockName.includes(keyword))
  );
  if (!matchingGroup) return null;

  for (const toolName of matchingGroup.tools) {
    const toolItem = inventoryItems.find(item => item.name === toolName);
    if (toolItem) return toolItem;
  }

  return null;
}

module.exports = {
  GENERIC_LOG_NAMES,
  GENERIC_PLANK_NAMES,
  countItem,
  hasToolType,
  getOwnedTools,
  isQuestDone,
  syncObjective,
  getInventorySummary,
  findNearbyCraftingTable,
  getAvailableCrafts,
  getBestToolForBlock,
  isWoodLog,
  isPlanks,
  getWoodType,
  getPlankForLog,
  resolvePlankTarget
};
