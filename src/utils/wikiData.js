const config = require('../config');

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
  const mcData = getMcData(bot);

  if (targetItemName.includes('log')) {
    return mcData.blocksArray.filter(b => b.name.includes('log')).map(b => b.name);
  }

  if (targetItemName === 'lapis' || targetItemName === 'lapis_lazuli') {
    return ['lapis_ore', 'deepslate_lapis_ore'];
  }

  const matchingBlocks = mcData.blocksArray.filter(b => {
    if (b.name === targetItemName) return true;
    if (b.drops?.some(id => mcData.items[id]?.name === targetItemName)) return true;
    return false;
  }).map(b => b.name);

  return matchingBlocks.length > 0 ? matchingBlocks : [targetItemName];
}

module.exports = {
  getMcData,
  getBlockDrops,
  canHarvestBlock,
  getBlockNamesForTarget
};
