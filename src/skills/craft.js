const { goals } = require('mineflayer-pathfinder');
const config = require('../config');
const { countItem } = require('../utils/inventory');

async function skillCraft(bot, targetName) {
  const item = bot.registry.itemsByName[targetName];
  if (!item) return { success: false, message: `Objet '${targetName}' inconnu dans Minecraft.` };

  const isTool = config.TOOL_SUFFIXES.some(s => targetName.endsWith(s));
  if (isTool && countItem(bot, targetName) > 0) {
    return { success: false, message: `Tu possèdes DÉJÀ '${targetName}'. Inutile d'en fabriquer un autre, passe à l'étape suivante.` };
  }
  if (targetName === 'crafting_table' && countItem(bot, 'crafting_table') > 0) {
    return { success: false, message: `Tu possèdes DÉJÀ un établi dans ton inventaire. Utilise l'action "place" pour le poser au sol.` };
  }

  const tableId = bot.registry.blocksByName['crafting_table']?.id;
  const craftingTable = tableId ? bot.findBlock({ matching: tableId, maxDistance: 16 }) : null;
  const tableToUse = config.CRAFT_2X2.has(targetName) ? null : craftingTable;

  if (tableToUse) {
    try {
      const { GoalNear } = goals;
      await bot.pathfinder.goto(new GoalNear(tableToUse.position.x, tableToUse.position.y, tableToUse.position.z, 2));
      await bot.lookAt(tableToUse.position.offset(0.5, 0.5, 0.5));
    } catch (e) {
      console.warn("Rapprochement de l'établi :", e.message);
    }
  }

  const recipes = bot.recipesFor(item.id, null, 1, tableToUse);
  if (recipes.length === 0) {
    if (!config.CRAFT_2X2.has(targetName) && !craftingTable) {
      return { success: false, message: `'${targetName}' nécessite un établi posé à côté.` };
    }
    return { success: false, message: `Composants manquants dans l'inventaire pour fabriquer '${targetName}'.` };
  }

  const slotHelper = setInterval(() => {
    const activeWin = bot.currentWindow || bot.inventory;
    activeWin.emit('updateSlot:0', activeWin.slots?.[0] || null);
  }, 600);

  try {
    bot.chat(`Fabrication de ${targetName}...`);
    await bot.craft(recipes[0], 1, tableToUse);
    return { success: true, message: `Craft de '${targetName}' réussi.` };
  } catch (error) {
    console.warn("Erreur pendant le craft :", error.message);
    return { success: false, message: `Erreur lors de la fabrication : \${error.message}` };
  } finally {
    clearInterval(slotHelper);
  }
}

module.exports = { skillCraft };
