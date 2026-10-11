const { getMcData } = require('../utils/wikiData');

/**
 * Consulte la base de données du jeu pour extraire les propriétés et recettes d'un bloc ou item
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} target Nom de l'item ou du bloc recherché
 * @returns {{ success: boolean, message: string }}
 */
function skillWiki(bot, target) {
  const mcData = getMcData(bot);
  let response = `--- WIKI: ${target} ---\n`;
  let found = false;

  const item = mcData.itemsByName[target];
  const block = mcData.blocksByName[target];

  if (!item && !block) {
    return { success: false, message: `L'élément '${target}' n'existe pas dans la base de données.` };
  }

  if (block) {
    found = true;
    response += `Type : Bloc\n`;
    response += `Minable : ${block.diggable ? 'Oui' : 'Non'}\n`;

    if (block.harvestTools) {
      const toolNames = Object.keys(block.harvestTools).map(id => mcData.items[id]?.name).filter(Boolean);
      if (toolNames.length > 0) {
        response += `Outils requis pour miner et récupérer : ${toolNames.slice(0, 5).join(', ')}${toolNames.length > 5 ? '...' : ''}\n`;
      }
    } else if (block.diggable) {
      response += `Outils requis : Aucun (minable à la main)\n`;
    }

    if (block.drops && block.drops.length > 0) {
      const dropNames = block.drops.map(id => mcData.items[id]?.name).filter(Boolean);
      response += `Donne (drops) : ${dropNames.join(', ')}\n`;
    } else {
      response += `Donne (drops) : Rien\n`;
    }
  }

  if (item) {
    found = true;
    if (!block) response += `Type : Item\n`;

    const recipes = mcData.recipes[item.id];
    if (recipes && recipes.length > 0) {
      response += `Fabrication (Craft) :\n`;
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

      response += `- Recette : ${recipeSummary}\n`;
      response += `- Quantité produite : ${primaryRecipe.result.count}\n`;
      response += `- Nécessite un établi (crafting_table) : ${requiresCraftingTable ? 'Oui' : 'Non'}\n`;
    } else {
      response += `Fabrication (Craft) : Non craftable (ou recette spéciale).\n`;
    }
  }

  if (!found) {
    return { success: false, message: `Aucune info utile trouvée pour '${target}'.` };
  }

  bot.chat(`J'ai consulté le wiki pour : ${target}`);
  return { success: true, message: response.trim() };
}

module.exports = { skillWiki };
