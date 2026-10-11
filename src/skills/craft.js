const { goals } = require('mineflayer-pathfinder');
const config = require('../config');
const { countItem } = require('../utils/inventory');

/**
 * Fabrique un objet en utilisant la grille d'inventaire ou un établi selon la recette Minecraft
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} targetName Nom de l'objet à fabriquer
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function skillCraft(bot, targetName) {
  const item = bot.registry.itemsByName[targetName];
  if (!item) return { success: false, message: `Objet '${targetName}' inconnu dans Minecraft.` };

  const isTool = config.TOOL_SUFFIXES.some(suffix => targetName.endsWith(suffix));
  if (isTool && countItem(bot, targetName) > 0) {
    return { success: false, message: `Tu possèdes DÉJÀ '${targetName}'. Inutile d'en fabriquer un autre, passe à l'étape suivante.` };
  }
  if (targetName === 'crafting_table' && countItem(bot, 'crafting_table') > 0) {
    return { success: false, message: `Tu possèdes DÉJÀ un établi dans ton inventaire. Utilise l'action "place" pour le poser au sol.` };
  }

  // Vérifier si la recette peut être réalisée dans la grille 2x2 personnelle
  const recipesInPersonalGrid = bot.recipesFor(item.id, null, 1, null);
  const canCraftInPersonalGrid = recipesInPersonalGrid.length > 0;

  const craftingTableBlockId = bot.registry.blocksByName['crafting_table']?.id;
  const nearbyCraftingTable = craftingTableBlockId ? bot.findBlock({ matching: craftingTableBlockId, maxDistance: 16 }) : null;
  const tableToUse = canCraftInPersonalGrid ? null : nearbyCraftingTable;

  if (!canCraftInPersonalGrid && !nearbyCraftingTable) {
    const recipesWithVirtualTable = bot.recipesFor(item.id, null, 1, { type: craftingTableBlockId, name: 'crafting_table' });
    if (recipesWithVirtualTable.length > 0) {
      return { success: false, message: `'${targetName}' nécessite un établi posé à côté. Pose-en un avec "place" d'abord.` };
    }
  }

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
    return { success: false, message: `Composants manquants dans l'inventaire pour fabriquer '${targetName}'.` };
  }

  const slotHelper = setInterval(() => {
    const activeWindow = bot.currentWindow || bot.inventory;
    activeWindow.emit('updateSlot:0', activeWindow.slots?.[0] || null);
  }, 600);

  try {
    bot.chat(`Fabrication de ${targetName}...`);
    await bot.craft(recipes[0], 1, tableToUse);
    return { success: true, message: `Craft de '${targetName}' réussi.` };
  } catch (error) {
    console.warn("Erreur pendant le craft :", error.message);
    return { success: false, message: `Erreur lors de la fabrication : ${error.message}` };
  } finally {
    clearInterval(slotHelper);
  }
}

module.exports = { skillCraft };
