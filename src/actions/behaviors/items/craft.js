const { goals } = require('mineflayer-pathfinder');
const config = require('../../../infrastructure/config');
const {
  countItem, countBestPlankStack, isWoodLog, isPlanks, isBed, resolvePlankTarget, resolveBedTarget,
  findNearbyCraftingTable, getQuestRequirement
} = require('../../../perception/inventory');
const { autoEquipArmorAndShield } = require('./equip');
const { freeInventorySlotIfFull } = require('./storage');
const { deployCraftingTable, collectCraftingTable } = require('./table');

const AUTO_EQUIP_SUFFIXES = ['_helmet', '_chestplate', '_leggings', '_boots', 'shield'];
const SINGLE_CRAFT_ITEMS = new Set(['crafting_table', 'furnace', 'chest']);

/**
 * Validate crafting preconditions before searching for recipes
 * @param {object} bot Mineflayer bot instance
 * @param {string} targetName Requested item name
 * @param {object|null} item Item registry entry
 * @returns {{ success: boolean, message: string }|null} Precondition error or null if valid
 */
function checkCraftPreconditions(bot, targetName, item) {
  if (!item) return { success: false, message: `Unknown Minecraft item '${targetName}'.` };

  const isTool = config.TOOL_SUFFIXES.some(suffix => targetName.endsWith(suffix));
  if (isTool && countItem(bot, targetName) > 0) {
    return { success: false, message: `You ALREADY own '${targetName}'. No need to craft another, proceed to next step.` };
  }
  if (targetName === 'crafting_table' && countItem(bot, 'crafting_table') > 0) {
    return {
      success: false,
      message: "You ALREADY carry a crafting table. It is portable: call 'craft' directly on the item you need, the table is deployed and collected automatically."
    };
  }

  if (targetName === 'crafting_table') {
    // The four planks must come from the same wood type
    if (countBestPlankStack(bot) < 4) {
      const hasLogs = bot.inventory.items().some(i => isWoodLog(i.name));
      return {
        success: false,
        message: hasLogs
          ? "Missing planks to craft 'crafting_table' (4 planks of the same wood type needed). Convert your logs into planks first ('craft' with 'planks')."
          : "Missing wood to craft 'crafting_table'. Harvest tree logs first ('mine' with 'log')."
      };
    }
  }

  return null;
}

/**
 * Explain why no recipe matches, pointing out planks of mixed wood types when that is the cause
 * @param {object} bot Mineflayer bot instance
 * @param {string} targetName Requested item name
 * @returns {string} Failure message for the decision loop
 */
function describeMissingComponents(bot, targetName) {
  const totalPlanks = countItem(bot, 'planks');
  const bestStack = countBestPlankStack(bot);
  if (totalPlanks > bestStack) {
    return `Missing required components to craft '${targetName}'. Your ${totalPlanks} planks are of mixed wood types (at most ${bestStack} of one type) and a recipe needs planks of a single type: craft more 'planks' from one kind of log.`;
  }
  return `Missing required components in inventory to craft '${targetName}'.`;
}

/**
 * Move the bot near the target crafting table and look at it
 * @param {object} bot Mineflayer bot instance
 * @param {object} tableToUse Target crafting table block
 * @returns {Promise<{ success: boolean, message?: string }>} Movement result towards the crafting table
 */
async function approachCraftingTable(bot, tableToUse) {
  let navTimer = null;
  let gotoPromise = null;
  try {
    if (bot.entity.position.distanceTo(tableToUse.position) > 3) {
      console.log(`[CRAFT] Moving to crafting table at (${tableToUse.position.x}, ${tableToUse.position.y}, ${tableToUse.position.z})...`);
      const { GoalNear } = goals;
      gotoPromise = bot.pathfinder.goto(new GoalNear(tableToUse.position.x, tableToUse.position.y, tableToUse.position.z, 2));
      const timeoutPromise = new Promise((_, reject) => {
        navTimer = setTimeout(() => reject(new Error('Approach crafting table timed out after 15s')), 15000);
      });
      await Promise.race([gotoPromise, timeoutPromise]);
    }
    await bot.lookAt(tableToUse.position.offset(0.5, 0.5, 0.5));
  } catch (e) {
    console.warn("Approaching crafting table :", e.message);
  } finally {
    if (navTimer) clearTimeout(navTimer);
    if (gotoPromise) {
      gotoPromise.catch(() => {});
      bot.pathfinder?.setGoal?.(null);
      bot.clearControlStates?.();
    }
  }

  const dist = bot.entity.position.distanceTo(tableToUse.position);
  if (dist > 4.5) {
    return { success: false, message: `Cannot reach crafting table (distance: ${Math.round(dist)} blocks).` };
  }
  return { success: true };
}

/**
 * Find available recipes for the target item, substituting wood species if needed
 * @param {object} bot Mineflayer bot instance
 * @param {object} item Initial item registry entry
 * @param {string} normalizedTarget Normalized target name
 * @param {object|null} tableToUse Crafting table block or null
 * @param {number} [requestedQty=1] Desired number of craft operations
 * @returns {{ recipes: Array<object>, normalizedTarget: string }} Sorted recipes and resolved target name
 */
function resolveCraftRecipes(bot, item, normalizedTarget, tableToUse, requestedQty = 1) {
  const sortBestRecipes = (list, target) => [...list].sort(
    (a, b) => computeCraftOperations(bot, b, target, requestedQty) - computeCraftOperations(bot, a, target, requestedQty)
  );

  const recipes = bot.recipesFor(item.id, null, 1, tableToUse);
  if (recipes.length > 0 || !isPlanks(normalizedTarget)) {
    return { recipes: sortBestRecipes(recipes, normalizedTarget), normalizedTarget };
  }

  const alternatePlank = resolvePlankTarget(bot, 'planks');
  const alternateItem = alternatePlank === normalizedTarget ? null : bot.registry.itemsByName[alternatePlank];
  if (!alternateItem) return { recipes, normalizedTarget };

  const alternateRecipes = bot.recipesFor(alternateItem.id, null, 1, tableToUse);
  if (alternateRecipes.length > 0) {
    return { recipes: sortBestRecipes(alternateRecipes, alternatePlank), normalizedTarget: alternatePlank };
  }
  return { recipes, normalizedTarget };
}

/**
 * Compute safe number of recipe executions based on item type and available ingredients
 * @param {object} bot Mineflayer bot instance
 * @param {object} recipe Selected recipe object
 * @param {string} targetName Target item name
 * @param {number} requestedQty Requested quantity
 * @returns {number} Number of recipe executions to perform
 */
function computeCraftOperations(bot, recipe, targetName, requestedQty) {
  const normalizedQty = Math.max(1, Number.parseInt(requestedQty, 10) || 1);
  const isSingleCraft = SINGLE_CRAFT_ITEMS.has(targetName) || config.TOOL_SUFFIXES.some(s => targetName.endsWith(s));
  if (isSingleCraft || normalizedQty === 1) return 1;

  if (!Array.isArray(recipe?.delta)) return normalizedQty;

  const consumedByItemId = new Map();
  for (const entry of recipe.delta) {
    if (entry.count < 0) {
      consumedByItemId.set(entry.id, (consumedByItemId.get(entry.id) || 0) + Math.abs(entry.count));
    }
  }
  if (consumedByItemId.size === 0) return normalizedQty;

  let maxPossible = normalizedQty;
  for (const [id, requiredPerCraft] of consumedByItemId.entries()) {
    const itemName = bot.registry.items?.[id]?.name;
    const availableCount = itemName ? countItem(bot, itemName) : 0;
    const possibleWithIngredient = Math.floor(availableCount / requiredPerCraft);
    maxPossible = Math.min(maxPossible, possibleWithIngredient);
  }

  return Math.max(1, maxPossible);
}

/**
 * Recursively reclaim items left in the personal 2x2 crafting grid (slots 1 to 4)
 * @param {object} bot Mineflayer bot instance
 * @param {number} [slotIndex=1] Current grid slot index
 * @returns {Promise<void>} Promise resolved after clearing the grid
 */
async function reclaimPersonalCraftingGrid(bot, slotIndex = 1) {
  if (slotIndex > 4 || typeof bot.putAway !== 'function') return;
  if (bot.inventory?.slots?.[slotIndex]) {
    await Promise.resolve(bot.putAway(slotIndex)).catch(() => false);
  }
  await reclaimPersonalCraftingGrid(bot, slotIndex + 1);
}

/**
 * Execute the Mineflayer craft call with a 10-second safety timeout and window cleanup
 * @param {object} bot Mineflayer bot instance
 * @param {object} recipe Recipe to execute
 * @param {object|null} tableToUse Crafting table block or null
 * @param {string} normalizedTarget Crafted item name
 * @param {number} [craftCount=1] Number of recipe executions
 * @returns {Promise<{ success: boolean, message?: string }>} Craft execution result
 */
async function performCraftWithTimeout(bot, recipe, tableToUse, normalizedTarget, craftCount = 1) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const activeWindow = bot.currentWindow || bot.inventory;
      if (activeWindow?.emit) {
        try {
          activeWindow.emit('updateSlot:0', null);
          if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
        } catch (err) {
          console.debug("Crafting window cleanup error:", err.message);
        }
      }
      reject(new Error("Crafting timed out after 10s"));
    }, 10000);
  });

  try {
    bot.chat(`Crafting ${normalizedTarget} (x${craftCount})...`);
    await Promise.race([bot.craft(recipe, craftCount, tableToUse), timeoutPromise]);
    if (typeof bot.waitForTicks === 'function') {
      await bot.waitForTicks(4);
    }
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
    } else if (!tableToUse) {
      await reclaimPersonalCraftingGrid(bot);
    }
  }
}

/**
 * Collect a crafted item dropped nearby if it did not land directly in the inventory
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
 * Tell whether crafting an item now needs a crafting table.
 * Having a 2x2 recipe is not enough: a bed also has a 2x2 re-dye recipe (another bed + a dye), useless
 * without a bed, while the real recipe (3 wool + 3 planks) is 3x2. The personal grid is used only when
 * one of its recipes can be made with the inventory right now.
 * @param {object} bot Mineflayer bot instance
 * @param {object} item Item registry entry
 * @returns {boolean} True if the craft must happen at a crafting table
 */
function needsCraftingTable(bot, item) {
  const Recipe = require('prismarine-recipe')(bot.version || config.BOT_CONFIG.version || '1.20.4').Recipe;
  const recipes = Recipe.find(item.id, null);
  if (!recipes.some(recipe => recipe.requiresTable)) return false;
  if (!recipes.some(recipe => !recipe.requiresTable)) return true;
  return bot.recipesFor(item.id, null, 1, null).length === 0;
}

/**
 * Check whether a crafting table is required and make one available: reuse a table within reach,
 * otherwise deploy the carried portable table right where the bot stands
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {object} item Item registry entry
 * @param {string} targetName Requested item name
 * @returns {Promise<{ ok: boolean, tableToUse?: object|null, errorResult?: { success: boolean, message: string } }>} Station preparation result
 */
async function prepareCraftingStation(bot, state, item, targetName) {
  if (!needsCraftingTable(bot, item)) return { ok: true, tableToUse: null };

  let tableToUse = findNearbyCraftingTable(bot, state);
  if (!tableToUse) {
    if (countItem(bot, 'crafting_table') === 0) {
      return {
        ok: false,
        errorResult: {
          success: false,
          message: `'${targetName}' requires a crafting table and you carry none. Craft one first ('craft' with target 'crafting_table'): it is portable and deployed automatically.`
        }
      };
    }

    const deployment = await deployCraftingTable(bot, state);
    if (!deployment.success) {
      return {
        ok: false,
        errorResult: {
          success: false,
          message: `'${targetName}' needs your crafting table, which could not be set down here: ${deployment.message} You still carry it: move a few blocks away ('explore') and call 'craft' again. Do NOT craft another table and do NOT use 'place'.`
        }
      };
    }
    tableToUse = deployment.block;
  }

  const approach = await approachCraftingTable(bot, tableToUse);
  if (!approach.success) return { ok: false, errorResult: approach };

  return { ok: true, tableToUse };
}

/**
 * Tell whether the very next step of the current objective is another crafting-table recipe
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {boolean} True if the table should stay deployed for an immediate follow-up craft
 */
function isNextStepAnotherTableCraft(bot, state) {
  if (!state?.currentObjective) return false;
  try {
    const { resolveGoalPlan, getItemKnowledge } = require('../../../minecraft/knowledge');
    const required = getQuestRequirement(bot, state, state.currentObjective);
    const nextStep = resolveGoalPlan(bot, state.currentObjective, required, state).nextAction;
    return nextStep?.action === 'craft' && getItemKnowledge(bot, nextStep.target).requiresTable === true;
  } catch {
    return false;
  }
}

/**
 * Leave the crafting table: break it and take it back unless the next step needs it right away
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {object} tableBlock Crafting table block that was just used
 * @param {object} [options={}] Craft options
 * @param {boolean} [options.keepTable=false] Force the table to stay deployed
 * @returns {Promise<string>} Short note describing what happened to the table
 */
async function releaseCraftingTable(bot, state, tableBlock, options = {}) {
  if (!tableBlock?.position) return '';

  if (options.keepTable || isNextStepAnotherTableCraft(bot, state)) {
    if (state) state.deployedTable = tableBlock.position.clone ? tableBlock.position.clone() : tableBlock.position;
    return ' Crafting table kept deployed for the next craft.';
  }

  const collection = await collectCraftingTable(bot, state, tableBlock);
  return collection.collected
    ? ' Crafting table collected back into inventory.'
    : ' Warning: the crafting table could not be recovered, craft a new one when needed.';
}

/**
 * Recursively poll inventory slots for receipt of the crafted item
 * @param {object} bot Mineflayer bot instance
 * @param {string} normalizedTarget Crafted item name
 * @param {number} countBefore Item count before crafting
 * @param {number} [retriesLeft=3] Remaining polling attempts
 * @returns {Promise<number>} Detected item count in inventory
 */
async function pollCraftedInventoryCount(bot, normalizedTarget, countBefore, retriesLeft = 3) {
  const current = countItem(bot, normalizedTarget);
  if (current > countBefore || retriesLeft <= 0) {
    return current;
  }
  await bot.waitForTicks(5);
  return pollCraftedInventoryCount(bot, normalizedTarget, countBefore, retriesLeft - 1);
}

/**
 * Wait for inventory synchronization after crafting and pick up any dropped item if needed
 * @param {object} bot Mineflayer bot instance
 * @param {string} normalizedTarget Crafted item name
 * @param {number} countBefore Item count before crafting
 * @returns {Promise<number>} Item count after synchronization
 */
async function waitForCraftedInventorySync(bot, normalizedTarget, countBefore) {
  await bot.waitForTicks(8);
  const countAfter = await pollCraftedInventoryCount(bot, normalizedTarget, countBefore, 3);
  if (countAfter > countBefore) {
    return countAfter;
  }
  return collectDroppedCraftItem(bot, normalizedTarget);
}

/**
 * Craft an item using the personal grid or a nearby crafting table
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Target item name to craft
 * @param {number} [qty=1] Requested craft operations count
 * @param {object} [options={}] Craft options
 * @param {boolean} [options.keepTable=false] Keep the crafting table deployed after the craft
 * @returns {Promise<{ success: boolean, message: string }>} Crafting operation result
 */
async function skillCraft(bot, state, targetName, qty = 1, options = {}) {
  if (isWoodLog(targetName)) {
    return { success: false, message: "Raw logs and wood cannot be crafted: harvest them with 'mine' on trees." };
  }

  let initialTarget = targetName;
  if (isPlanks(targetName)) initialTarget = resolvePlankTarget(bot, targetName);
  else if (isBed(targetName)) initialTarget = resolveBedTarget(bot);
  const item = bot.registry.itemsByName[initialTarget];

  const preconditionError = checkCraftPreconditions(bot, targetName, item);
  if (preconditionError) return preconditionError;

  const station = await prepareCraftingStation(bot, state, item, targetName);
  if (!station.ok) return station.errorResult;

  const outcome = await craftAtStation(bot, item, initialTarget, targetName, station.tableToUse, qty);

  // Leaving the table: it is broken and carried away instead of being remembered as a base
  if (station.tableToUse) {
    const tableNote = await releaseCraftingTable(bot, state, station.tableToUse, options);
    return { success: outcome.success, message: `${outcome.message}${tableNote}` };
  }
  return outcome;
}

/**
 * Resolve the recipe, run the craft and verify the item reached the inventory
 * @param {object} bot Mineflayer bot instance
 * @param {object} item Item registry entry
 * @param {string} initialTarget Concrete item name to craft
 * @param {string} targetName Item name originally requested
 * @param {object|null} tableToUse Crafting table block or null for the personal grid
 * @param {number} qty Requested craft operations count
 * @returns {Promise<{ success: boolean, message: string }>} Crafting operation result
 */
async function craftAtStation(bot, item, initialTarget, targetName, tableToUse, qty) {
  const { recipes, normalizedTarget } = resolveCraftRecipes(bot, item, initialTarget, tableToUse, qty);
  if (recipes.length === 0) {
    return { success: false, message: describeMissingComponents(bot, targetName) };
  }

  const craftCount = computeCraftOperations(bot, recipes[0], normalizedTarget, qty);
  const countBefore = countItem(bot, normalizedTarget);
  await freeInventorySlotIfFull(bot, 1);
  const craftExec = await performCraftWithTimeout(bot, recipes[0], tableToUse, normalizedTarget, craftCount);
  if (!craftExec.success) return craftExec;

  const countAfter = await waitForCraftedInventorySync(bot, normalizedTarget, countBefore);
  if (countAfter > countBefore) {
    const craftedAmount = countAfter - countBefore;
    if (AUTO_EQUIP_SUFFIXES.some(suffix => normalizedTarget.endsWith(suffix))) {
      await autoEquipArmorAndShield(bot);
    }
    const substitutionNote = normalizedTarget === targetName ? '' : ` (adapted substitute for '${targetName}')`;
    return { success: true, message: `Successfully crafted ${craftedAmount}x '${normalizedTarget}'${substitutionNote}.` };
  }

  const isInventoryFull = typeof bot.inventory?.emptySlotCount === 'function' && bot.inventory.emptySlotCount() === 0;
  if (isInventoryFull) {
    return {
      success: false,
      message: `Crafting '${normalizedTarget}' dropped on ground because inventory is full. Store or drop excess blocks first.`
    };
  }

  return { success: false, message: `Crafting completed but '${normalizedTarget}' was not found in inventory.` };
}

module.exports = { skillCraft, computeCraftOperations };
