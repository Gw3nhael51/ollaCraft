const { goals } = require('mineflayer-pathfinder');
const config = require('../config');
const { countItem, isWoodLog, isPlanks, resolvePlankTarget } = require('../utils/inventory');

/**
 * Craft an item using personal inventory grid or nearby crafting table
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Name of the item to craft
 * @returns {Promise<{ success: boolean, message: string }>} Result of the crafting operation
 */
async function skillCraft(bot, state, targetName) {
  // Reject raw logs since they cannot be crafted and must be mined
  if (isWoodLog(targetName)) {
    return { success: false, message: "Raw logs and wood cannot be crafted: harvest them with 'mine' on trees." };
  }

  // Normalize plank variety according to carried logs in inventory
  let normalizedTarget = targetName;
  if (isPlanks(targetName)) {
    normalizedTarget = resolvePlankTarget(bot, targetName);
  }

  const item = bot.registry.itemsByName[normalizedTarget];
  if (!item) return { success: false, message: `Unknown Minecraft item '${targetName}'.` };

  const isTool = config.TOOL_SUFFIXES.some(suffix => targetName.endsWith(suffix));
  if (isTool && countItem(bot, targetName) > 0) {
    return { success: false, message: `You ALREADY own '${targetName}'. No need to craft another, proceed to next step.` };
  }
  if (targetName === 'crafting_table' && countItem(bot, 'crafting_table') > 0) {
    return { success: false, message: `You ALREADY have a crafting table in your inventory. Use 'place' to set it down.` };
  }

  // Verify plank availability for crafting table recipe
  if (targetName === 'crafting_table') {
    const totalPlanks = bot.inventory.items().filter(i => isPlanks(i.name)).reduce((s, i) => s + i.count, 0);
    if (totalPlanks < 4) {
      const hasLogs = bot.inventory.items().some(i => isWoodLog(i.name));
      if (hasLogs) {
        return { success: false, message: "Missing planks to craft 'crafting_table' (4 planks needed). Convert your logs into planks first ('craft' with 'planks')." };
      }
      return { success: false, message: "Missing wood to craft 'crafting_table'. Harvest tree logs first ('mine' with 'log')." };
    }
  }

  // Determine required crafting grid dimensions (2x2 personal vs 3x3 table)
  const Recipe = require('prismarine-recipe')(bot.version || config.BOT_CONFIG.version || '1.20.4').Recipe;
  const allRecipes = Recipe.find(item.id, null);
  const fitsInPersonalGrid = allRecipes.some(r => !r.requiresTable);

  const craftingTableBlockId = bot.registry.blocksByName.crafting_table?.id;
  let nearbyCraftingTable = craftingTableBlockId ? bot.findBlock({ matching: craftingTableBlockId, maxDistance: 24 }) : null;

  if (!nearbyCraftingTable && state?.base?.crafting_table) {
    const baseTableBlock = bot.blockAt(state.base.crafting_table);
    const dist = baseTableBlock ? bot.entity.position.distanceTo(baseTableBlock.position) : Infinity;
    if (baseTableBlock?.name === 'crafting_table' && dist <= 24) {
      nearbyCraftingTable = baseTableBlock;
    }
  }

  const tableToUse = fitsInPersonalGrid ? null : nearbyCraftingTable;

  if (!fitsInPersonalGrid && !tableToUse) {
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

    // Verify distance to crafting table
    if (bot.entity.position.distanceTo(tableToUse.position) > 4.5) {
      return { success: false, message: `Cannot reach crafting table (distance: ${Math.round(bot.entity.position.distanceTo(tableToUse.position))} blocks).` };
    }
  }

  let recipes = bot.recipesFor(item.id, null, 1, tableToUse);

  // Substitute alternate wood variety if initial plank recipe fails
  if (recipes.length === 0 && isPlanks(normalizedTarget)) {
    const alternatePlank = resolvePlankTarget(bot, 'planks');
    if (alternatePlank !== normalizedTarget) {
      const alternateItem = bot.registry.itemsByName[alternatePlank];
      if (alternateItem) {
        const alternateRecipes = bot.recipesFor(alternateItem.id, null, 1, tableToUse);
        if (alternateRecipes.length > 0) {
          recipes = alternateRecipes;
          normalizedTarget = alternatePlank;
        }
      }
    }
  }

  if (recipes.length === 0) {
    return { success: false, message: `Missing required components in inventory to craft '${targetName}'.` };
  }

  // Record inventory count before crafting
  const countBefore = countItem(bot, normalizedTarget);

  // Define crafting timeout guard
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const activeWindow = bot.currentWindow;
      if (activeWindow) {
        try {
          activeWindow.emit('updateSlot:0', null);
          bot.closeWindow(activeWindow);
        } catch (err) {
          // Ignore error if window is already closed by server
          console.debug("Crafting window cleanup error:", err.message);
        }
      }
      reject(new Error("Crafting timed out after 10s"));
    }, 10000);
  });

  try {
    bot.chat(`Crafting ${normalizedTarget}...`);
    // Execute craft recipe via Mineflayer
    await Promise.race([
      bot.craft(recipes[0], 1, tableToUse),
      timeoutPromise
    ]);
  } catch (error) {
    console.warn("Error during craft :", error.message);
    return { success: false, message: `Crafting failed : ${error.message}` };
  } finally {
    clearTimeout(timeoutId);
    if (bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow);
      } catch (err) {
        // Ignore error if window is already closed by server
        console.debug("Crafting window cleanup error:", err.message);
      }
    }
  }

  // Wait for server inventory synchronization
  await bot.waitForTicks(8);

  let countAfter = countItem(bot, normalizedTarget);

  // Pick up dropped craft result if necessary
  if (countAfter <= countBefore) {
    const droppedItem = bot.nearestEntity(e => {
      return e.name === 'item' && e.getDroppedItem?.()?.name === normalizedTarget && bot.entity.position.distanceTo(e.position) < 4;
    });
    if (droppedItem) {
      try {
        await bot.lookAt(droppedItem.position);
        bot.setControlState('forward', true);
        await bot.waitForTicks(15);
      } finally {
        bot.setControlState('forward', false);
      }
      await bot.waitForTicks(5);
      countAfter = countItem(bot, normalizedTarget);
    }
  }

  // Confirm item count increase in inventory
  if (countAfter > countBefore) {
    const substitutionNote = normalizedTarget !== targetName ? ` (adapted substitute for '${targetName}')` : '';
    return { success: true, message: `Successfully crafted '${normalizedTarget}'${substitutionNote}.` };
  }

  return { success: false, message: `Crafting completed but '${normalizedTarget}' was not found in inventory.` };
}

module.exports = { skillCraft };
