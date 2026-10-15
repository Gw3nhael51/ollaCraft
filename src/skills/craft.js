const { goals } = require('mineflayer-pathfinder');
const config = require('../config');
const { countItem } = require('../utils/inventory');

/**
 * Craft an item using personal inventory grid or nearby crafting table
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Name of the item to craft
 * @returns {Promise<{ success: boolean, message: string }>} Result of the crafting operation
 */
async function skillCraft(bot, state, targetName) {
  const item = bot.registry.itemsByName[targetName];
  if (!item) return { success: false, message: `Unknown Minecraft item '${targetName}'.` };

  const isTool = config.TOOL_SUFFIXES.some(suffix => targetName.endsWith(suffix));
  if (isTool && countItem(bot, targetName) > 0) {
    return { success: false, message: `You ALREADY own '${targetName}'. No need to craft another, proceed to next step.` };
  }
  if (targetName === 'crafting_table' && countItem(bot, 'crafting_table') > 0) {
    return { success: false, message: `You ALREADY have a crafting table in your inventory. Use 'place' to set it down.` };
  }

  // Check if recipe fits inside personal 2x2 crafting grid
  const recipesInPersonalGrid = bot.recipesFor(item.id, null, 1, null);
  const canCraftInPersonalGrid = recipesInPersonalGrid.length > 0;

  const craftingTableBlockId = bot.registry.blocksByName.crafting_table?.id;
  let nearbyCraftingTable = craftingTableBlockId ? bot.findBlock({ matching: craftingTableBlockId, maxDistance: 48 }) : null;

  if (!nearbyCraftingTable && state?.base?.crafting_table) {
    const baseTableBlock = bot.blockAt(state.base.crafting_table);
    if (baseTableBlock?.name === 'crafting_table') {
      nearbyCraftingTable = baseTableBlock;
    }
  }

  const tableToUse = canCraftInPersonalGrid ? null : nearbyCraftingTable;

  if (!canCraftInPersonalGrid && !tableToUse) {
    const hasTableInPocket = countItem(bot, 'crafting_table') > 0;
    if (hasTableInPocket) {
      return { success: false, message: `'${targetName}' requires a crafting table. You carry one in inventory, use 'place' with target 'crafting_table' to place it!` };
    }
    return { success: false, message: `'${targetName}' requires a crafting table. No nearby table found. Craft one ("craft crafting_table") or return to base.` };
  }

  if (tableToUse) {
    try {
      if (bot.entity.position.distanceTo(tableToUse.position) > 3) {
        console.log(`[CRAFT] Moving to crafting table at (${tableToUse.position.x}, ${tableToUse.position.y}, ${tableToUse.position.z})...`);
        const { GoalNear } = goals;
        await bot.pathfinder.goto(new GoalNear(tableToUse.position.x, tableToUse.position.y, tableToUse.position.z, 2));
      }
      await bot.lookAt(tableToUse.position.offset(0.5, 0.5, 0.5));
    } catch (e) {
      console.warn("Approaching crafting table :", e.message);
    }
  }

  const recipes = bot.recipesFor(item.id, null, 1, tableToUse);
  if (recipes.length === 0) {
    return { success: false, message: `Missing required components in inventory to craft '${targetName}'.` };
  }

  const slotHelper = setInterval(() => {
    const activeWindow = bot.currentWindow || bot.inventory;
    activeWindow.emit('updateSlot:0', activeWindow.slots?.[0] || null);
  }, 600);

  try {
    bot.chat(`Crafting ${targetName}...`);
    await bot.craft(recipes[0], 1, tableToUse);
    return { success: true, message: `Successfully crafted '${targetName}'.` };
  } catch (error) {
    console.warn("Error during craft :", error.message);
    return { success: false, message: `Crafting failed : ${error.message}` };
  } finally {
    clearInterval(slotHelper);
  }
}

module.exports = { skillCraft };
