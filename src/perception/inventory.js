const config = require('../infrastructure/config');
const { syncAdvancementsWithInventory } = require('./advancements');
const { getDimension, getWaypoint, hasMilestone } = require('../core/progress');

const GENERIC_LOG_NAMES = new Set(['log', 'logs', 'wood', 'bois', 'buche', 'buches', 'bûche', 'bûches', 'tree', 'arbre']);
const GENERIC_PLANK_NAMES = new Set(['planks', 'plank', 'planche', 'planches']);
const GENERIC_WOOL_NAMES = new Set(['wool', 'laine']);
const GENERIC_BED_NAMES = new Set(['bed', 'beds', 'lit', 'end_bed']);
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
  if (clean.endsWith('_log') || clean.endsWith('_wood') || clean.endsWith('_hyphae')) return true;
  // Only the Nether fungi have wooden stems: 'big_dripleaf_stem', 'mushroom_stem' or 'pumpkin_stem' give no wood
  return /(^|_)(crimson|warped)_stem$/.test(clean);
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
 * Check whether an item name corresponds to wool of any color
 * @param {string} name Item or block name
 * @returns {boolean} True if wool
 */
function isWool(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.toLowerCase().trim();
  return GENERIC_WOOL_NAMES.has(clean) || clean.endsWith('_wool');
}

/**
 * Check whether an item name corresponds to a bed of any color
 * @param {string} name Item or block name
 * @returns {boolean} True if bed
 */
function isBed(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.toLowerCase().trim();
  return GENERIC_BED_NAMES.has(clean) || clean.endsWith('_bed');
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

  // A bed recipe needs three wool of the same color: report the largest single-color stock
  if (GENERIC_WOOL_NAMES.has(clean)) {
    return getBestWoolStack(bot)?.count || 0;
  }

  // Sum beds of every color for generic bed query
  if (GENERIC_BED_NAMES.has(clean)) {
    return allSlots.filter(item => isBed(item.name)).reduce((sum, item) => sum + item.count, 0);
  }

  return allSlots.filter(item => item.name === clean).reduce((sum, item) => sum + item.count, 0);
}

/**
 * Count the planks of the wood type carried in the largest quantity.
 * A recipe takes all its planks from one wood type: 2 oak + 2 birch planks cannot make a crafting table.
 * @param {object} bot Mineflayer bot instance
 * @returns {number} Size of the largest single-type plank stock
 */
function countBestPlankStack(bot) {
  const totals = new Map();
  for (const item of getCarriedItems(bot)) {
    if (item.name.endsWith('_planks')) {
      totals.set(item.name, (totals.get(item.name) || 0) + item.count);
    }
  }
  return totals.size > 0 ? Math.max(...totals.values()) : 0;
}

/**
 * Find the wool color carried in the largest quantity
 * @param {object} bot Mineflayer bot instance
 * @returns {{ name: string, color: string, count: number }|null} Best wool stock or null
 */
function getBestWoolStack(bot) {
  const totals = new Map();
  for (const item of getCarriedItems(bot)) {
    if (item.name.endsWith('_wool')) {
      totals.set(item.name, (totals.get(item.name) || 0) + item.count);
    }
  }
  let best = null;
  for (const [name, count] of totals.entries()) {
    if (!best || count > best.count) {
      best = { name, color: name.slice(0, -'_wool'.length), count };
    }
  }
  return best;
}

/**
 * Resolve the concrete bed item to craft according to the wool color carried
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Bed item name (e.g. 'white_bed')
 */
function resolveBedTarget(bot) {
  const wool = getBestWoolStack(bot);
  return wool ? `${wool.color}_bed` : 'white_bed';
}

/**
 * Find a bed item currently carried in the inventory
 * @param {object} bot Mineflayer bot instance
 * @returns {object|null} Bed item or null
 */
function findBedItem(bot) {
  return getCarriedItems(bot).find(item => item.name.endsWith('_bed')) || null;
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
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'bow'
]);

// Quests about setting a respawn point: never skipped by the portal-ready shortcut
const SPAWN_BED_QUESTS = new Set(['bed', 'end_bed']);

// Side quests whose completion says nothing about earlier quests (a looted bow must not skip the Nether)
const SIDE_QUESTS = new Set(['bed', 'end_bed', 'bow', 'arrow']);

// Quests fully described by their own rule: a known stronghold must not hide lost eyes, arrows or a missing bed
const STRICT_RESOURCE_QUESTS = new Set([
  'bed', 'nether_portal', 'blaze_rod', 'blaze_powder', 'ender_pearl', 'ender_eye', 'arrow', 'end_bed'
]);

/**
 * Count blaze rods already owned or already turned into powder and eyes
 * @param {object} bot Mineflayer bot instance
 * @returns {number} Blaze rod equivalent
 */
function countBlazeRodEquivalent(bot) {
  return countItem(bot, 'blaze_rod') + Math.ceil((countItem(bot, 'blaze_powder') + countItem(bot, 'ender_eye')) / 2);
}

/**
 * Tell whether the Nether has nothing left to give: enough blaze rods (or what they became) are owned
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} state Global bot state
 * @returns {boolean} True if no more blaze rods are needed
 */
function isNetherStageComplete(bot, state) {
  return countBlazeRodEquivalent(bot) >= getQuestRequirement(bot, state, 'blaze_rod');
}

/**
 * Compute how many Eyes of Ender are still required: remaining triangulation throws plus empty portal frames
 * @param {object|null} state Global bot state
 * @returns {number} Number of eyes the bot must own right now
 */
function getEyeRequirement(state) {
  const frameCount = config.END_PORTAL_FRAME_COUNT;
  const filled = Math.min(frameCount, state?.endPortal?.filledCount || 0);
  const throwsDone = state?.stronghold?.throws?.length || 0;
  const throwsLeft = state?.stronghold?.located ? 0 : Math.max(0, config.EYE_TRIANGULATION_THROWS - throwsDone);
  return Math.max(0, frameCount - filled) + throwsLeft;
}

/**
 * Return the quantity required to validate a quest, honoring manual objectives and dynamic eye needs
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} state Global bot state
 * @param {string} questName Objective name
 * @returns {number} Required quantity
 */
function getQuestRequirement(bot, state, questName) {
  if (state?.manualObjective && state.currentObjective === questName) {
    return Math.max(1, state.manualObjectiveQty || 1);
  }
  if (questName === 'ender_eye' || questName === 'ender_pearl' || questName === 'blaze_powder') {
    return getEyeRequirement(state);
  }
  if (questName === 'blaze_rod') {
    return Math.ceil(getEyeRequirement(state) / 2);
  }
  return config.QUEST_AMOUNT[questName] || 1;
}

// Equivalent items or conditions that directly satisfy a specific quest
const QUEST_EQUIVALENTS = {
  raw_iron: ['raw_iron', 'iron_ore'],
  bucket: ['bucket', 'water_bucket', 'lava_bucket'],
  blaze_rod: (bot) => countBlazeRodEquivalent(bot),
  blaze_powder: (bot) => countItem(bot, 'blaze_powder') + countItem(bot, 'ender_eye'),
  ender_pearl: (bot) => countItem(bot, 'ender_pearl') + countItem(bot, 'ender_eye'),
  // The Nether trip is needed exactly as long as blaze rods are missing
  nether_portal: (bot, state) => (getDimension(bot) === 'the_nether' || isNetherStageComplete(bot, state) ? 1 : 0),
  // The first spawn bed matters until the Nether stage is over; later the stronghold bed takes its place
  bed: (bot, state) => (
    countItem(bot, 'bed') > 0 || getWaypoint(state, 'spawn_bed') || getWaypoint(state, 'end_spawn_bed') ||
    getDimension(bot) !== 'overworld' || isNetherStageComplete(bot, state) ? 1 : 0
  ),
  end_bed: (bot, state) => (countItem(bot, 'bed') > 0 || getWaypoint(state, 'end_spawn_bed') ? 1 : 0),
  stronghold: (bot, state) => ((state?.stronghold?.located && state.stronghold.reached) || getWaypoint(state, 'end_portal') ? 1 : 0),
  end_portal: (bot, state) => (getDimension(bot) === 'the_end' || hasMilestone(state, 'dragon_defeated') ? 1 : 0),
  ender_dragon: (bot, state) => (hasMilestone(state, 'dragon_defeated') ? 1 : 0)
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

  if (questName === 'crafting_table') {
    return countItem(bot, questName) > 0 || Boolean(findNearbyCraftingTable(bot, state));
  }

  if (questName === 'furnace') {
    const nearby = bot.findBlock({ matching: bot.registry.blocksByName[questName]?.id, maxDistance: 32 });
    return countItem(bot, questName) > 0 || Boolean(state?.base?.[questName]) || Boolean(nearby);
  }

  if (SPAWN_BED_QUESTS.has(questName) && !config.REQUIRE_SPAWN_BED) return true;

  const required = getQuestRequirement(bot, state, questName);
  const rule = QUEST_EQUIVALENTS[questName];

  if (typeof rule === 'function') return rule(bot, state) >= required;
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

  const questIndex = config.QUEST_CHAIN.indexOf(questName);
  const portalIndex = config.QUEST_CHAIN.indexOf('nether_portal');
  const isPortalReady = isQuestDirectlyMet(bot, 'flint_and_steel', state)
    && (isQuestDirectlyMet(bot, 'water_bucket', state) || countItem(bot, 'obsidian') >= 10);
  if (isPortalReady && questIndex !== -1 && portalIndex !== -1 && questIndex < portalIndex && !SPAWN_BED_QUESTS.has(questName)) {
    return true;
  }

  if (PERSISTENT_GEAR_QUESTS.has(questName) || STRICT_RESOURCE_QUESTS.has(questName)) return false;

  if (questIndex === -1) return false;

  return config.QUEST_CHAIN
    .slice(questIndex + 1)
    .some(laterQuest => !SIDE_QUESTS.has(laterQuest) && isQuestDirectlyMet(bot, laterQuest, state));
}

// The crafting table is portable (carried, deployed, then collected): only fixed stations are memorized
const BASE_STATION_NAMES = ['furnace', 'chest'];

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

  if (state.manualObjective) {
    if (!isQuestDirectlyMet(bot, state.currentObjective, state)) return;

    // Hand control back to the automatic chain once the user-requested objective is obtained
    const finishedObjective = state.currentObjective;
    state.manualObjective = false;
    state.manualObjectiveQty = 1;
    bot.chat?.(`✅ Objectif '${finishedObjective}' atteint. Reprise de la progression automatique.`);
    if (state.lastActionResult) {
      state.lastActionResult = {
        ...state.lastActionResult,
        message: `${state.lastActionResult.message} | Objectif manuel '${finishedObjective}' atteint.`
      };
    }
  }

  if (state.completedQuests) {
    state.completedQuests.clear();
    for (const name of config.QUEST_CHAIN) {
      if (isQuestDone(bot, name, state)) {
        state.completedQuests.add(name);
      }
    }
  }

  let nextObjective = config.QUEST_CHAIN.find(name => !state.completedQuests?.has(name)) || config.QUEST_CHAIN.at(-1);

  // Nothing else can be pursued inside the End: the only way out is defeating the dragon
  if (getDimension(bot) === 'the_end' && !hasMilestone(state, 'dragon_defeated')) {
    nextObjective = 'ender_dragon';
  }

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
 * Locate the crafting table usable right now: the deployed portable table or one within arm's reach.
 * The bot never walks back to a remembered table: it carries its own and redeploys it where it stands.
 * @param {object} bot Mineflayer bot instance
 * @param {object} [state] Global bot state
 * @param {number} [maxDistance] Maximum detection distance for an already placed table
 * @returns {object|null} Located crafting table block or null
 */
function findNearbyCraftingTable(bot, state, maxDistance = config.PORTABLE_TABLE_REUSE_RANGE) {
  const deployedPos = state?.deployedTable;
  if (deployedPos) {
    const deployedBlock = typeof bot.blockAt === 'function' ? bot.blockAt(deployedPos) : null;
    const distance = bot.entity?.position?.distanceTo ? bot.entity.position.distanceTo(deployedPos) : 0;
    if (distance > config.CRAFTING_TABLE_RANGE) {
      // The bot was dragged away before collecting it (timeout, emergency): abandon it rather than walk back
      state.deployedTable = null;
    } else if (deployedBlock?.name === 'crafting_table') {
      return deployedBlock.position ? deployedBlock : { ...deployedBlock, position: deployedPos };
    } else if (deployedBlock) {
      // Forget the deployment once the block is confirmed gone (unloaded chunks return null and are kept)
      state.deployedTable = null;
    }
  }

  const tableId = bot.registry?.blocksByName?.crafting_table?.id;
  if (!tableId || typeof bot.findBlock !== 'function') return null;
  return bot.findBlock({ matching: tableId, maxDistance }) || null;
}

/**
 * Check whether a 3x3 craft can be performed without any extra step (table in reach or carried)
 * @param {object} bot Mineflayer bot instance
 * @param {object} [state] Global bot state
 * @returns {boolean} True if a crafting table is usable or can be deployed immediately
 */
function hasCraftingTableAccess(bot, state) {
  return countItem(bot, 'crafting_table') > 0 || Boolean(findNearbyCraftingTable(bot, state));
}

/**
 * Resolve craft availability label for a single item
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Item name to evaluate
 * @param {boolean} hasTableAccess Whether a crafting table is placed nearby or carried
 * @param {object} virtualTable Virtual or placed table used for 3x3 recipe lookup
 * @returns {string|null} Craftable label or null if not craftable
 */
function resolveCraftEntry(bot, itemName, hasTableAccess, virtualTable) {
  const itemDefinition = bot.registry.itemsByName[itemName];
  if (!itemDefinition) return null;

  if (bot.recipesFor(itemDefinition.id, null, 1, null).length > 0) {
    return itemName;
  }

  if (bot.recipesFor(itemDefinition.id, null, 1, virtualTable).length > 0) {
    return hasTableAccess ? itemName : `${itemName} (nécessite un établi : fabrique d'abord 'crafting_table')`;
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
    'flint_and_steel', 'blaze_powder', 'ender_eye', 'bow', 'arrow',
    'diamond_pickaxe', 'diamond_sword'
  ];
  // The table is portable: carrying one is as good as having one placed, 'craft' deploys it automatically
  const hasTableAccess = Boolean(craftingTable) || countItem(bot, 'crafting_table') > 0;
  const virtualTable = craftingTable || { type: bot.registry.blocksByName['crafting_table']?.id, name: 'crafting_table' };

  const availableCrafts = targetItemsToCheck
    .map(itemName => resolveCraftEntry(bot, itemName, hasTableAccess, virtualTable))
    .filter(Boolean);

  // Expose the bed under its generic name whatever the wool color carried
  const bedTarget = resolveBedTarget(bot);
  const bedEntry = resolveCraftEntry(bot, bedTarget, hasTableAccess, virtualTable);
  if (bedEntry) {
    availableCrafts.push(bedEntry.replace(bedTarget, 'bed'));
  }

  // Provide generic planks craft option if any wood plank variety is available
  if (availableCrafts.some(craft => isPlanks(craft)) && !availableCrafts.includes('planks')) {
    availableCrafts.unshift('planks');
  }

  return availableCrafts;
}

const MATERIAL_SUFFIX_MAP = new Map([
  ['mineable/pickaxe', '_pickaxe'],
  ['mineable/axe', '_axe'],
  ['mineable/shovel', '_shovel'],
  ['mineable/hoe', '_hoe']
]);
const TIER_PRIORITY = ['netherite_', 'diamond_', 'iron_', 'stone_', 'golden_', 'wooden_'];
const TOOL_OR_WEAPON_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_sword', '_hoe'];

/**
 * Check whether an item name represents a mining tool, weapon, or utility implement
 * @param {string} itemName Item identifier name
 * @returns {boolean} True if item is a pickaxe, axe, shovel, sword, hoe, shears, or flint_and_steel
 */
function isToolOrWeapon(itemName) {
  if (typeof itemName !== 'string' || !itemName) return false;
  if (itemName === 'shears' || itemName === 'flint_and_steel') return true;
  return TOOL_OR_WEAPON_SUFFIXES.some(suffix => itemName.endsWith(suffix));
}

/**
 * Compute priority rank for a tool tier (lower value means higher priority)
 * @param {string} itemName Tool item name
 * @returns {number} Tier rank index
 */
function getToolTierRank(itemName) {
  if (itemName === 'shears') return -1;
  const rank = TIER_PRIORITY.findIndex(prefix => typeof itemName === 'string' && itemName.startsWith(prefix));
  return rank >= 0 ? rank : TIER_PRIORITY.length;
}

/**
 * Restrict inventory items to tools allowed by blockDef.harvestTools when defined
 * @param {object} mcData Minecraft data registry
 * @param {object} blockDef Block definition object
 * @param {Array<object>} inventoryItems Carried inventory items
 * @returns {{ restricted: boolean, candidates: Array<object> }} Filtered candidates
 */
function filterAllowedHarvestTools(mcData, blockDef, inventoryItems) {
  const harvestMap = blockDef?.harvestTools;
  if (!harvestMap || Object.keys(harvestMap).length === 0) {
    return { restricted: false, candidates: inventoryItems };
  }
  const allowedNames = new Set(
    Object.keys(harvestMap)
      .map(id => mcData?.items?.[Number(id)]?.name)
      .filter(Boolean)
  );
  const candidates = inventoryItems.filter(
    item => Boolean(harvestMap[item.type]) || allowedNames.has(item.name)
  );
  return { restricted: true, candidates };
}

/**
 * Pick the candidate tool that minimizes live block dig time strictly below bare hands
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Target block supporting digTime
 * @param {Array<object>} candidates Harvest-eligible inventory items
 * @returns {object|null} Fastest tool item or null when bare hands tie
 */
function selectFastestByDigTime(bot, block, candidates) {
  const effects = bot.entity?.effects || {};
  const bareHandTime = block.digTime(null, false, false, false, [], effects);
  let fastestTime = bareHandTime;
  let bestTool = null;

  for (const item of candidates) {
    const itemTime = block.digTime(item.type, false, false, false, [], effects);
    if (typeof itemTime !== 'number' || itemTime >= bareHandTime) continue;
    const isFaster = itemTime < fastestTime;
    const isHigherTierTie = itemTime === fastestTime && bestTool && getToolTierRank(item.name) < getToolTierRank(bestTool.name);
    if (isFaster || isHigherTierTie) {
      fastestTime = itemTime;
      bestTool = item;
    }
  }

  return bestTool;
}

/**
 * Check whether an item satisfies one of the block's semicolon-delimited material tags
 * @param {string} itemName Inventory item name
 * @param {string[]} materialTags Parsed material tags from minecraft-data
 * @returns {boolean} True when item belongs to the appropriate tool family
 */
function matchesMaterialToolFamily(itemName, materialTags) {
  if (typeof itemName !== 'string') return false;
  for (const tag of materialTags) {
    const mappedSuffix = MATERIAL_SUFFIX_MAP.get(tag);
    if (mappedSuffix && itemName.endsWith(mappedSuffix)) return true;
    if ((tag === 'coweb' || tag === 'cobweb') && (itemName === 'shears' || itemName.endsWith('_sword'))) return true;
    if ((tag === 'wool' || tag === 'leaves') && itemName === 'shears') return true;
  }
  return false;
}

/**
 * Select the best valid tool in inventory to mine a specific block using minecraft-data rules
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Target block
 * @returns {object|null} Best matching tool item or null
 */
function getBestToolForBlock(bot, block) {
  if (!bot?.inventory || typeof bot.inventory.items !== 'function' || !block) {
    return null;
  }

  const mcData = bot.registry?.blocksByName
    ? bot.registry
    : require('minecraft-data')(bot.version || config.BOT_CONFIG.version);
  const blockName = block.name || '';
  const blockDef = mcData?.blocksByName?.[blockName] || block;
  const inventoryItems = bot.inventory.items();

  const { restricted, candidates } = filterAllowedHarvestTools(mcData, blockDef, inventoryItems);
  if (restricted && candidates.length === 0) {
    return null;
  }

  if (typeof block.digTime === 'function') {
    return selectFastestByDigTime(bot, block, candidates);
  }

  const materialTags = String(blockDef?.material || '').split(';').map(tag => tag.trim()).filter(Boolean);
  if (materialTags.length === 0) return null;

  const matching = candidates.filter(item => matchesMaterialToolFamily(item.name, materialTags));
  if (matching.length === 0) return null;

  matching.sort((a, b) => getToolTierRank(a.name) - getToolTierRank(b.name));
  return matching[0];
}

module.exports = {
  GENERIC_LOG_NAMES,
  GENERIC_PLANK_NAMES,
  GENERIC_WOOL_NAMES,
  GENERIC_BED_NAMES,
  countItem,
  hasToolType,
  getOwnedTools,
  isQuestDone,
  isQuestDirectlyMet,
  getQuestRequirement,
  getEyeRequirement,
  syncObjective,
  getInventorySummary,
  findNearbyCraftingTable,
  hasCraftingTableAccess,
  getAvailableCrafts,
  getCarriedItems,
  countBestPlankStack,
  getBestWoolStack,
  resolveBedTarget,
  findBedItem,
  isWool,
  isBed,
  getBestToolForBlock,
  isToolOrWeapon,
  isWoodLog,
  isPlanks,
  getWoodType,
  getPlankForLog,
  resolvePlankTarget
};
