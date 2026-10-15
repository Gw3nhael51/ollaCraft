const { getMcData } = require('../utils/wikiData');

/**
 * Query game database to extract properties, harvest requirements, and crafting recipes for a block or item
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Name of the targeted block or item
 * @returns {{ success: boolean, message: string }} Database query result summary
 */
function skillWiki(bot, target) {
  const mcData = getMcData(bot);
  let response = `--- WIKI: ${target} ---\n`;
  let found = false;

  const item = mcData.itemsByName[target];
  const block = mcData.blocksByName[target];

  if (!item && !block) {
    return { success: false, message: `'${target}' does not exist in the database.` };
  }

  if (block) {
    found = true;
    response += `Type: Block\n`;
    response += `Mineable: ${block.diggable ? 'Yes' : 'No'}\n`;

    if (block.harvestTools) {
      const toolNames = Object.keys(block.harvestTools).map(id => mcData.items[id]?.name).filter(Boolean);
      if (toolNames.length > 0) {
        response += `Required harvest tools: ${toolNames.slice(0, 5).join(', ')}${toolNames.length > 5 ? '...' : ''}\n`;
      }
    } else if (block.diggable) {
      response += `Required tools: None (hand mineable)\n`;
    }

    if (block.drops && block.drops.length > 0) {
      const dropNames = block.drops.map(id => mcData.items[id]?.name).filter(Boolean);
      response += `Drops: ${dropNames.join(', ')}\n`;
    } else {
      response += `Drops: None\n`;
    }
  }

  if (item) {
    found = true;
    if (!block) response += `Type: Item\n`;

    const recipes = mcData.recipes[item.id];
    if (recipes && recipes.length > 0) {
      response += `Crafting recipe:\n`;
      const primaryRecipe = recipes[0];
      const requiresCraftingTable = primaryRecipe.inShape && (primaryRecipe.inShape.length > 2 || primaryRecipe.inShape[0].length > 2);

      const ingredientsList = [];
      if (primaryRecipe.inShape) {
        primaryRecipe.inShape.forEach(row => {
          row.forEach(id => {
            if (id) ingredientsList.push(mcData.items[id]?.name);
          });
        });
      } else if (primaryRecipe.ingredients) {
        primaryRecipe.ingredients.forEach(id => {
          if (id) ingredientsList.push(mcData.items[id]?.name);
        });
      }

      const ingredientCounts = {};
      ingredientsList.forEach(name => {
        ingredientCounts[name] = (ingredientCounts[name] || 0) + 1;
      });
      const recipeSummary = Object.entries(ingredientCounts).map(([name, count]) => `${count}x ${name}`).join(', ');

      response += `- Recipe: ${recipeSummary}\n`;
      response += `- Output quantity: ${primaryRecipe.result.count}\n`;
      response += `- Requires crafting table: ${requiresCraftingTable ? 'Yes' : 'No'}\n`;
    } else {
      response += `Crafting: Not craftable (or special recipe).\n`;
    }
  }

  if (!found) {
    return { success: false, message: `No useful information found for '${target}'.` };
  }

  bot.chat(`Checked wiki for: ${target}`);
  return { success: true, message: response.trim() };
}

module.exports = { skillWiki };
