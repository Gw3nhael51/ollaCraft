const config = require('../config');

let cachedOreNames = null;
const targetBlocksCache = new Map();

/**
 * Return minecraft-data registry corresponding to current server version
 * @param {object} bot Mineflayer bot instance
 * @returns {object} Registre de données Minecraft
 */
function getMcData(bot) {
  if (bot?.registry) return bot.registry;
  const version = bot?.version || config.BOT_CONFIG.version || '1.20.4';
  return require('minecraft-data')(version);
}

/**
 * Return list of items dropped upon breaking a block
 * @param {object} bot Mineflayer bot instance
 * @param {string} blockName Minecraft block name
 * @returns {string[]} Noms des items récoltés
 */
function getBlockDrops(bot, blockName) {
  const mcData = getMcData(bot);
  const blockDefinition = mcData.blocksByName[blockName];
  if (!blockDefinition?.drops || blockDefinition.drops.length === 0) {
    return [blockName];
  }

  const dropItemNames = blockDefinition.drops.map(id => mcData.items[id]?.name).filter(Boolean);
  return dropItemNames.length > 0 ? dropItemNames : [blockName];
}

/**
 * Check whether the bot possesses the required tool to harvest a block
 * @param {object} bot Mineflayer bot instance
 * @param {object|string} block Block object or block name to harvest
 * @returns {{ canHarvest: boolean, requiredTools: string[], message?: string }}
 */
function canHarvestBlock(bot, block) {
  const mcData = getMcData(bot);
  const blockDefinition = typeof block === 'string'
    ? mcData.blocksByName[block]
    : (mcData.blocksByName[block?.name] || block);

  if (!blockDefinition) {
    return { canHarvest: true, requiredTools: [] };
  }

  const harvestToolsMap = blockDefinition.harvestTools;
  if (harvestToolsMap && Object.keys(harvestToolsMap).length > 0) {
    const requiredToolIds = Object.keys(harvestToolsMap).map(Number);
    const requiredTools = requiredToolIds.map(id => mcData.items[id]?.name).filter(Boolean);
    const matchingInventoryTools = bot.inventory.items().filter(item => harvestToolsMap[item.type]);

    if (matchingInventoryTools.length === 0) {
      const toolNamesPreview = requiredTools.slice(0, 3).join(', ');
      return {
        canHarvest: false,
        requiredTools,
        message: `Impossible de récolter '${blockDefinition.name}' : fabrique d'abord un outil adapté (${toolNamesPreview}).`
      };
    }

    return { canHarvest: true, requiredTools, matchingInventoryTools };
  }

  return { canHarvest: true, requiredTools: [] };
}

/**
 * Return names of world blocks yielding the targeted item
 * @param {object} bot Mineflayer bot instance
 * @param {string} targetItemName Name of desired item
 * @returns {string[]} Liste des blocs minables correspondants
 */
function getBlockNamesForTarget(bot, targetItemName) {
  const { GENERIC_LOG_NAMES, GENERIC_PLANK_NAMES, isWoodLog, isPlanks } = require('./inventory');
  const clean = typeof targetItemName === 'string' ? targetItemName.toLowerCase().trim() : '';
  let cacheKey = targetItemName;
  if (GENERIC_LOG_NAMES.has(clean)) cacheKey = '__log__';
  else if (GENERIC_PLANK_NAMES.has(clean)) cacheKey = '__planks__';

  if (targetBlocksCache.has(cacheKey)) {
    return targetBlocksCache.get(cacheKey);
  }

  const mcData = getMcData(bot);
  let result;

  if (cacheKey === '__log__') {
    result = mcData.blocksArray.filter(b => isWoodLog(b.name)).map(b => b.name);
  } else if (cacheKey === '__planks__') {
    result = mcData.blocksArray.filter(b => isPlanks(b.name)).map(b => b.name);
  } else if (targetItemName === 'lapis' || targetItemName === 'lapis_lazuli') {
    result = ['lapis_ore', 'deepslate_lapis_ore'];
  } else {
    const matchingBlocks = mcData.blocksArray.filter(b => {
      if (b.name === targetItemName) return true;
      return Boolean(b.drops?.some(id => mcData.items[id]?.name === targetItemName));
    }).map(b => b.name);
    result = matchingBlocks.length > 0 ? matchingBlocks : [targetItemName];
  }

  targetBlocksCache.set(cacheKey, result);
  return result;
}

/**
 * Check if a block name belongs to the ore family (including deepslate and nether)
 * @param {string} blockName Name of block to check
 * @returns {boolean} True if block is an ore
 */
function isOreBlock(blockName) {
  if (!blockName || typeof blockName !== 'string') return false;
  return blockName.endsWith('_ore') || blockName === 'ancient_debris';
}

/**
 * Return all ore block definitions available in current Minecraft version
 * @param {object} bot Mineflayer bot instance
 * @returns {Set<string>} Set of ore block names
 */
function getOreBlockNames(bot) {
  if (cachedOreNames) return cachedOreNames;
  const mcData = getMcData(bot);
  const oreNames = mcData.blocksArray
    .filter(b => b.name.endsWith('_ore') || b.name === 'ancient_debris')
    .map(b => b.name);
  cachedOreNames = new Set(oreNames);
  return cachedOreNames;
}

/**
 * Classify visible ores into harvestable and unharvestable based on bot tools
 * @param {object} bot Mineflayer bot instance
 * @param {Record<string, number>} exposedOres Scanned exposed ores count
 * @returns {{ harvestable: Record<string, number>, unharvestable: Record<string, { count: number, requiredTools: string[] }> }}
 */
function classifyOresByHarvestability(bot, exposedOres) {
  const harvestable = {};
  const unharvestable = {};

  for (const [oreName, count] of Object.entries(exposedOres || {})) {
    const check = canHarvestBlock(bot, oreName);
    if (check.canHarvest) {
      harvestable[oreName] = count;
    } else {
      unharvestable[oreName] = { count, requiredTools: check.requiredTools };
    }
  }

  return { harvestable, unharvestable };
}

module.exports = {
  getMcData,
  getBlockDrops,
  canHarvestBlock,
  getBlockNamesForTarget,
  isOreBlock,
  getOreBlockNames,
  classifyOresByHarvestability
};
