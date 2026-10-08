const mcData = require('minecraft-data')('1.20.4');

function skillWiki(bot, target) {
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
      const tools = Object.keys(block.harvestTools).map(id => mcData.items[id]?.name).filter(Boolean);
      if (tools.length > 0) {
        response += `Outils requis pour miner et récupérer : ${tools.slice(0, 5).join(', ')}${tools.length > 5 ? '...' : ''}\n`;
      }
    } else if (block.diggable) {
      response += `Outils requis : Aucun (minable à la main)\n`;
    }

    if (block.drops && block.drops.length > 0) {
      const drops = block.drops.map(id => mcData.items[id]?.name).filter(Boolean);
      response += `Donne (drops) : ${drops.join(', ')}\n`;
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
      // Take the first recipe to simplify
      const r = recipes[0];
      const needsTable = r.inShape && (r.inShape.length > 2 || r.inShape[0].length > 2);
      
      let ingredientsList = [];
      if (r.inShape) {
        r.inShape.forEach(row => {
          row.forEach(id => {
            if (id) ingredientsList.push(mcData.items[id]?.name);
          });
        });
      } else if (r.ingredients) {
        r.ingredients.forEach(id => {
          if (id) ingredientsList.push(mcData.items[id]?.name);
        });
      }
      
      // Count duplicates
      const counts = {};
      ingredientsList.forEach(name => {
        counts[name] = (counts[name] || 0) + 1;
      });
      const reqs = Object.entries(counts).map(([name, count]) => `${count}x ${name}`).join(', ');
      
      response += `- Recette : ${reqs}\n`;
      response += `- Quantité produite : ${r.result.count}\n`;
      response += `- Nécessite un établi (crafting_table) : ${needsTable ? 'Oui' : 'Non'}\n`;
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
