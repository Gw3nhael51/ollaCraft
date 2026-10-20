const { goals } = require('mineflayer-pathfinder');
const config = require('../config');
const { countItem, isWoodLog, isPlanks, resolvePlankTarget, findNearbyCraftingTable } = require('../utils/inventory');

/**
 * Validate early crafting prerequisites before looking up recipes
 * @param {object} bot Mineflayer bot instance
 * @param {string} targetName Requested item name
 * @param {object|null} item Registry item entry
 * @returns {{ success: boolean, message: string }|null} Early failure result or null if valid
 */
function checkCraftPreconditions(bot, targetName, item) {
  if (!item) return { success: false, message: `Unknown Minecraft item '${targetName}'.` };

  const isTool = config.TOOL_SUFFIXES.some(suffix => targetName.endsWith(suffix));
  if (isTool && countItem(bot, targetName) > 0) {
    return { success: false, message: `You ALREADY own '${targetName}'. No need to craft another, proceed to next step.` };
  }
  if (targetName === 'crafting_table' && countItem(bot, 'crafting_table') > 0) {
    return { success: false, message: `You ALREADY have a crafting table in your inventory. Use 'place' to set it down.` };
  }

  if (targetName === 'crafting_table') {
    const totalPlanks = bot.inventory.items().filter(i => isPlanks(i.name)).reduce((s, i) => s + i.count, 0);
    if (totalPlanks < 4) {
      const hasLogs = bot.inventory.items().some(i => isWoodLog(i.name));
      return {
        success: false,
        message: hasLogs
          ? "Missing planks to craft 'crafting_table' (4 planks needed). Convert your logs into planks first ('craft' with 'planks')."
          : "Missing wood to craft 'crafting_table'. Harvest tree logs first ('mine' with 'log')."
      };
    }
  }

  return null;
}

/**
 * Walk close to the target crafting table and face it
 * @param {object} bot Mineflayer bot instance
 * @param {object} tableToUse Crafting table block
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
async function approachCraftingTable(bot, tableToUse) {
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

  const dist = bot.entity.position.distanceTo(tableToUse.position);
  if (dist > 4.5) {
    return { success: false, message: `Cannot reach crafting table (distance: ${Math.round(dist)} blocks).` };
  }
  return { success: true };
}

/**
 * Find available recipes for target item, substituting wood plank variety if needed
 * @param {object} bot Mineflayer bot instance
 * @param {object} item Initial registry item
 * @param {string} normalizedTarget Current target name
 * @param {object|null} tableToUse Crafting table block or null
 * @returns {{ recipes: Array<object>, normalizedTarget: string }}
 */
function resolveCraftRecipes(bot, item, normalizedTarget, tableToUse) {
  const recipes = bot.recipesFor(item.id, null, 1, tableToUse);
  if (recipes.length > 0 || !isPlanks(normalizedTarget)) {
    return { recipes, normalizedTarget };
  }

  const alternatePlank = resolvePlankTarget(bot, 'planks');
  const alternateItem = alternatePlank !== normalizedTarget ? bot.registry.itemsByName[alternatePlank] : null;
  if (!alternateItem) return { recipes, normalizedTarget };

  const alternateRecipes = bot.recipesFor(alternateItem.id, null, 1, tableToUse);
  if (alternateRecipes.length > 0) {
    return { recipes: alternateRecipes, normalizedTarget: alternatePlank };
  }
  return { recipes, normalizedTarget };
}

/**
 * Execute Mineflayer craft call with a 10-second safety timeout and window cleanup
 * @param {object} bot Mineflayer bot instance
 * @param {object} recipe Recipe to execute
 * @param {object|null} tableToUse Crafting table block or null
 * @param {string} normalizedTarget Item name being crafted
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
async function performCraftWithTimeout(bot, recipe, tableToUse, normalizedTarget) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const activeWindow = bot.currentWindow;
      if (activeWindow) {
        try {
          activeWindow.emit('updateSlot:0', null);
          bot.closeWindow(activeWindow);
        } catch (err) {
          console.debug("Crafting window cleanup error:", err.message);
        }
      }
      reject(new Error("Crafting timed out after 10s"));
    }, 10000);
  });

  try {
    bot.chat(`Crafting ${normalizedTarget}...`);
    await Promise.race([bot.craft(recipe, 1, tableToUse), timeoutPromise]);
    return { success: true };
  } catch (error) {
    console.warn("Error during craft :", error.message);
    return { success: false, message: `Crafting failed : ${error.message}` };
  } finally {
    clearTimeout(timeoutId);
    if (bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow);
      } catch (err) {
        console.debug("Crafting window cleanup error:", err.message);
      }
    }
  }
}

/**
 * Collect nearby dropped craft item if inventory did not receive it directly
 * @param {object} bot Mineflayer bot instance
 * @param {string} normalizedTarget Crafted item name
 * @returns {Promise<number>} Updated item count in inventory
 */
async function collectDroppedCraftItem(bot, normalizedTarget) {
  const droppedItem = bot.nearestEntity(e =>
    e.name === 'item' && e.getDroppedItem?.()?.name === normalizedTarget && bot.entity.position.distanceTo(e.position) < 4
  );
  if (!droppedItem) return countItem(bot, normalizedTarget);

  try {
    await bot.lookAt(droppedItem.position);
    bot.setControlState('forward', true);
    await bot.waitForTicks(15);
  } finally {
    bot.setControlState('forward', false);
  }
  await bot.waitForTicks(5);
  return countItem(bot, normalizedTarget);
}

/**
 * Resolve crafting station requirement and navigate to placed crafting table if needed
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {object} item Registry item entry
 * @param {string} targetName Requested item name
 * @returns {Promise<{ ok: boolean, tableToUse?: object|null, errorResult?: { success: boolean, message: string } }>}
 */
async function prepareCraftingStation(bot, state, item, targetName) {
  const Recipe = require('prismarine-recipe')(bot.version || config.BOT_CONFIG.version || '1.20.4').Recipe;
  const fitsInPersonalGrid = Recipe.find(item.id, null).some(r => !r.requiresTable);
  if (fitsInPersonalGrid) return { ok: true, tableToUse: null };

  const tableToUse = findNearbyCraftingTable(bot, state);
  if (!tableToUse) {
    const hasTableInPocket = countItem(bot, 'crafting_table') > 0;
    return {
      ok: false,
      errorResult: {
        success: false,
        message: hasTableInPocket
          ? `'${targetName}' requires a crafting table. You carry one in inventory, use 'place' with target 'crafting_table' to place it!`
          : `'${targetName}' requires a crafting table. No nearby table found. Craft one ("craft crafting_table") or return to base.`
      }
    };
  }

  const approach = await approachCraftingTable(bot, tableToUse);
  if (!approach.success) return { ok: false, errorResult: approach };

  return { ok: true, tableToUse };
}

/**
 * Craft an item using personal inventory grid or nearby crafting table
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Name of the item to craft
 * @returns {Promise<{ success: boolean, message: string }>} Result of the crafting operation
 */
async function skillCraft(bot, state, targetName) {
  if (isWoodLog(targetName)) {
    return { success: false, message: "Raw logs and wood cannot be crafted: harvest them with 'mine' on trees." };
  }

  const initialTarget = isPlanks(targetName) ? resolvePlankTarget(bot, targetName) : targetName;
  const item = bot.registry.itemsByName[initialTarget];

  const preconditionError = checkCraftPreconditions(bot, targetName, item);
  if (preconditionError) return preconditionError;

  const station = await prepareCraftingStation(bot, state, item, targetName);
  if (!station.ok) return station.errorResult;

  const { recipes, normalizedTarget } = resolveCraftRecipes(bot, item, initialTarget, station.tableToUse);
  if (recipes.length === 0) {
    return { success: false, message: `Missing required components in inventory to craft '${targetName}'.` };
  }

  const countBefore = countItem(bot, normalizedTarget);
  const craftExec = await performCraftWithTimeout(bot, recipes[0], station.tableToUse, normalizedTarget);
  if (!craftExec.success) return craftExec;

  await bot.waitForTicks(8);
  const countAfter = countItem(bot, normalizedTarget) > countBefore
    ? countItem(bot, normalizedTarget)
    : await collectDroppedCraftItem(bot, normalizedTarget);

  if (countAfter > countBefore) {
    const substitutionNote = normalizedTarget !== targetName ? ` (adapted substitute for '${targetName}')` : '';
    return { success: true, message: `Successfully crafted '${normalizedTarget}'${substitutionNote}.` };
  }

  return { success: false, message: `Crafting completed but '${normalizedTarget}' was not found in inventory.` };
}

module.exports = { skillCraft };
