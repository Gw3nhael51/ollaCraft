const { getMcData } = require('../utils/wikiData');
const { isPlanks } = require('../utils/inventory');

/**
 * Format block properties and harvest tool requirements for Wiki output
 * @param {object} mcData Minecraft data registry
 * @param {object} block Block definition
 * @returns {string} Formatted block wiki section
 */
function formatBlockWikiSection(mcData, block) {
  let section = `Type: Block\nMineable: ${block.diggable ? 'Yes' : 'No'}\n`;

  if (block.harvestTools) {
    const toolNames = Object.keys(block.harvestTools).map(id => mcData.items[id]?.name).filter(Boolean);
    if (toolNames.length > 0) {
      section += `Required harvest tools: ${toolNames.slice(0, 5).join(', ')}${toolNames.length > 5 ? '...' : ''}\n`;
    }
  } else if (block.diggable) {
    section += `Required tools: None (hand mineable)\n`;
  }

  if (block.drops?.length > 0) {
    const dropNames = block.drops.map(id => mcData.items[id]?.name).filter(Boolean);
    section += `Drops: ${dropNames.join(', ')}\n`;
  } else {
    section += `Drops: None\n`;
  }

  return section;
}

/**
 * Format item crafting recipe information for Wiki output
 * @param {object} mcData Minecraft data registry
 * @param {object} item Item definition
 * @param {boolean} isAlsoBlock Whether target is also a block
 * @returns {string} Formatted item wiki section
 */
function formatItemWikiSection(mcData, item, isAlsoBlock) {
  let section = isAlsoBlock ? '' : `Type: Item\n`;
  const recipes = mcData.recipes[item.id];

  if (!recipes || recipes.length === 0) {
    return `${section}Crafting: Not craftable (or special recipe).\n`;
  }

  const primaryRecipe = recipes[0];
  const requiresCraftingTable = primaryRecipe.inShape && (primaryRecipe.inShape.length > 2 || primaryRecipe.inShape[0].length > 2);
  const rawIds = primaryRecipe.inShape ? primaryRecipe.inShape.flat().filter(Boolean) : (primaryRecipe.ingredients || []);

  const ingredientCounts = {};
  for (const id of rawIds) {
    const rawName = mcData.items[id]?.name;
    const name = isPlanks(rawName) && !isPlanks(item.name) ? 'planks' : rawName;
    if (name) ingredientCounts[name] = (ingredientCounts[name] || 0) + 1;
  }

  const recipeSummary = Object.entries(ingredientCounts).map(([name, count]) => `${count}x ${name}`).join(', ');
  section += `Crafting recipe:\n`;
  section += `- Recipe: ${recipeSummary}\n`;
  section += `- Output quantity: ${primaryRecipe.result.count}\n`;
  section += `- Requires crafting table: ${requiresCraftingTable ? 'Yes' : 'No'}\n`;
  return section;
}

/**
 * Query game database to extract properties, harvest requirements, and crafting recipes for a block or item
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Name of the targeted block or item
 * @returns {{ success: boolean, message: string }} Database query result summary
 */
function skillWiki(bot, target) {
  const mcData = getMcData(bot);
  const item = mcData.itemsByName[target];
  const block = mcData.blocksByName[target];

  if (!item && !block) {
    return { success: false, message: `'${target}' does not exist in the database.` };
  }

  let response = `--- WIKI: ${target} ---\n`;
  if (block) response += formatBlockWikiSection(mcData, block);
  if (item) response += formatItemWikiSection(mcData, item, Boolean(block));

  bot.chat(`Checked wiki for: ${target}`);
  return { success: true, message: response.trim() };
}

module.exports = { skillWiki };
