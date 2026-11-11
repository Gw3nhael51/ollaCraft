const { createResult } = require('./result');
const { withInventoryLock } = require('./lock');

const VALID_DESTINATIONS = ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'];

const ALWAYS_EDIBLE_ITEMS = new Set([
  'golden_apple',
  'enchanted_golden_apple',
  'chorus_fruit',
  'milk_bucket',
  'honey_bottle',
  'potion',
  'splash_potion',
  'lingering_potion'
]);

/**
 * Retrieve minecraft-data registry from bot instance
 * @param {object} bot Mineflayer bot instance
 * @returns {object|null} Minecraft data registry
 */
function getRegistry(bot) {
  if (bot.registry) return bot.registry;
  try {
    const mcData = require('minecraft-data');
    return mcData(bot.version || '1.20.4');
  } catch {
    return null;
  }
}

/**
 * Resolve target inventory slot number for destination name
 * @param {object} bot Mineflayer bot instance
 * @param {string} destination Destination slot identifier
 * @returns {number|null} Target slot index
 */
function getDestinationSlot(bot, destination) {
  if (typeof bot.getEquipmentDestSlot === 'function') {
    try {
      const slot = bot.getEquipmentDestSlot(destination);
      if (typeof slot === 'number') return slot;
    } catch {}
  }

  switch (destination) {
    case 'head': return 5;
    case 'torso': return 6;
    case 'legs': return 7;
    case 'feet': return 8;
    case 'off-hand': return 45;
    case 'hand': return bot.quickBarSlot !== undefined ? 36 + bot.quickBarSlot : 36;
    default: return null;
  }
}

/**
 * Check whether an item is currently equipped in target destination
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Expected item name
 * @param {string} destination Destination name
 * @returns {boolean} True if item is equipped
 */
function isItemEquipped(bot, itemName, destination) {
  if (destination === 'hand') {
    if (bot.heldItem && bot.heldItem.name === itemName) return true;
  }

  const slot = getDestinationSlot(bot, destination);
  if (slot !== null && bot.inventory?.slots?.[slot]) {
    return bot.inventory.slots[slot].name === itemName;
  }

  if (bot.equipment && bot.equipment[destination]) {
    return bot.equipment[destination].name === itemName;
  }

  return false;
}

/**
 * Count total units of an item available in bot inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string|number} itemKey Item name or numeric id
 * @returns {number} Available quantity
 */
function countInventoryItem(bot, itemKey) {
  if (!bot.inventory?.items) return 0;
  return bot.inventory.items().reduce((total, item) => {
    if (item && (item.name === itemKey || item.type === itemKey)) {
      return total + (item.count || 1);
    }
    return total;
  }, 0);
}

/**
 * Check if an item can be consumed based on minecraft data and food properties
 * @param {object|null} registry Minecraft data registry
 * @param {string} itemName Item name to test
 * @returns {boolean} True if item is consumable
 */
function isConsumable(registry, itemName) {
  if (ALWAYS_EDIBLE_ITEMS.has(itemName)) return true;
  if (typeof itemName === 'string' && itemName.endsWith('_potion')) return true;

  if (registry?.foodsByName && registry.foodsByName[itemName]) return true;

  const itemDef = registry?.itemsByName?.[itemName];
  if (itemDef && (itemDef.foodPoints !== undefined || itemDef.food !== undefined)) {
    return true;
  }

  return false;
}

/**
 * Check if an item can be eaten when food bar is full
 * @param {string} itemName Item name
 * @returns {boolean} True if edible at full hunger
 */
function isEdibleAtFullHunger(itemName) {
  if (ALWAYS_EDIBLE_ITEMS.has(itemName)) return true;
  if (typeof itemName === 'string' && itemName.endsWith('_potion')) return true;
  return false;
}

/**
 * Determine whether recipe requires a 3x3 crafting table block
 * @param {object} recipe Recipe instance
 * @returns {boolean} True if crafting table required
 */
function recipeRequiresTable(recipe) {
  if (recipe.requiresTable !== undefined) {
    return Boolean(recipe.requiresTable);
  }

  if (Array.isArray(recipe.inShape)) {
    if (recipe.inShape.length > 2) return true;
    if (recipe.inShape.some(row => Array.isArray(row) && row.length > 2)) return true;
  }

  if (Array.isArray(recipe.ingredients) && recipe.ingredients.length > 4) {
    return true;
  }

  return false;
}

/**
 * Equip specified item to target inventory slot
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Item name to equip
 * @param {string} [destination='hand'] Destination slot ('hand', 'head', 'torso', 'legs', 'feet', 'off-hand')
 * @param {object} [options={}] Operation options
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function equipItem(bot, itemName, destination = 'hand', options = {}) {
  if (!VALID_DESTINATIONS.includes(destination)) {
    return createResult(false, 'invalid_destination', { destination }, 'Destination slot is not recognized');
  }

  return withInventoryLock(bot, async () => {
    const timeoutMs = options.timeoutMs || 0;
    const abortSignal = options.abortSignal;

    if (abortSignal?.aborted) {
      if (isItemEquipped(bot, itemName, destination)) {
        return createResult(true, 'equipped', { itemName, destination }, null);
      }
      return createResult(false, 'aborted', { itemName, destination }, 'Equip operation aborted before start');
    }

    const item = bot.inventory?.items?.().find(i => i.name === itemName);
    if (!item) {
      if (isItemEquipped(bot, itemName, destination)) {
        return createResult(true, 'equipped', { itemName, destination }, null);
      }
      return createResult(false, 'missing_item', { itemName, destination }, 'Item not found in inventory');
    }

    let timerId = null;
    let abortHandler = null;
    let isTimedOut = false;
    let isAborted = false;

    const cleanup = () => {
      if (timerId) clearTimeout(timerId);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    };

    try {
      const equipPromise = (async () => {
        if (typeof bot.equip !== 'function') {
          throw new Error('Bot does not support equip action');
        }
        await bot.equip(item, destination);
      })();

      const racePromises = [equipPromise];

      if (abortSignal) {
        const abortPromise = new Promise((_, reject) => {
          abortHandler = () => {
            isAborted = true;
            reject(new Error('Equip operation aborted by caller'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        });
        racePromises.push(abortPromise);
      }

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => {
            isTimedOut = true;
            reject(new Error('Equip operation timed out'));
          }, timeoutMs);
        });
        racePromises.push(timeoutPromise);
      }

      await Promise.race(racePromises);

      if (isItemEquipped(bot, itemName, destination)) {
        return createResult(true, 'equipped', { itemName, destination }, null);
      }

      return createResult(false, 'error', { itemName, destination }, 'Item was not found in destination slot after equip');
    } catch (err) {
      if (isItemEquipped(bot, itemName, destination)) {
        return createResult(true, 'equipped', { itemName, destination }, null);
      }

      if (isAborted || abortSignal?.aborted) {
        return createResult(false, 'aborted', { itemName, destination }, 'Equip operation aborted by caller');
      }
      if (isTimedOut) {
        return createResult(false, 'timeout', { itemName, destination }, 'Equip operation timed out');
      }

      return createResult(false, 'error', { itemName, destination }, String(err?.message || err));
    } finally {
      cleanup();
    }
  });
}

/**
 * Consume food or drink item from inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Food or beverage item name
 * @param {object} [options={}] Operation options
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function consumeItem(bot, itemName, options = {}) {
  return withInventoryLock(bot, async () => {
    const timeoutMs = options.timeoutMs || 0;
    const abortSignal = options.abortSignal;
    const registry = getRegistry(bot);

    if (abortSignal?.aborted) {
      return createResult(false, 'aborted', { itemName }, 'Consume operation aborted before start');
    }

    const initialCount = countInventoryItem(bot, itemName);
    if (initialCount <= 0) {
      return createResult(false, 'missing_item', { itemName }, 'Item not found in inventory');
    }

    if (!isConsumable(registry, itemName)) {
      return createResult(false, 'not_consumable', { itemName }, 'Item cannot be consumed as food or drink');
    }

    const currentFood = bot.food !== undefined ? bot.food : 20;
    if (currentFood >= 20 && !isEdibleAtFullHunger(itemName)) {
      return createResult(false, 'not_hungry', { itemName, food: currentFood }, 'Bot hunger is full and item is not always edible');
    }

    const item = bot.inventory.items().find(i => i.name === itemName);
    if (typeof bot.equip === 'function') {
      try {
        await bot.equip(item, 'hand');
      } catch (err) {
        return createResult(false, 'error', { itemName }, `Failed to equip item to hand: ${err.message}`);
      }
    }

    const initialHealth = bot.health !== undefined ? bot.health : 20;
    const initialSaturation = bot.foodSaturation !== undefined ? bot.foodSaturation : 0;

    let timerId = null;
    let abortHandler = null;
    let isTimedOut = false;
    let isAborted = false;

    const cleanup = () => {
      if (timerId) clearTimeout(timerId);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    };

    try {
      const consumePromise = (async () => {
        if (typeof bot.consume !== 'function') {
          throw new Error('Bot does not support consume action');
        }
        await bot.consume();
      })();

      const racePromises = [consumePromise];

      if (abortSignal) {
        const abortPromise = new Promise((_, reject) => {
          abortHandler = () => {
            isAborted = true;
            reject(new Error('Consume operation aborted by caller'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        });
        racePromises.push(abortPromise);
      }

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => {
            isTimedOut = true;
            reject(new Error('Consume operation timed out'));
          }, timeoutMs);
        });
        racePromises.push(timeoutPromise);
      }

      await Promise.race(racePromises);

      const finalCount = countInventoryItem(bot, itemName);
      const finalFood = bot.food !== undefined ? bot.food : currentFood;
      const finalHealth = bot.health !== undefined ? bot.health : initialHealth;
      const finalSaturation = bot.foodSaturation !== undefined ? bot.foodSaturation : initialSaturation;

      const consumed = finalCount < initialCount || finalFood > currentFood || finalHealth > initialHealth || finalSaturation > initialSaturation;

      if (consumed) {
        return createResult(true, 'consumed', {
          itemName,
          consumedCount: initialCount - finalCount,
          food: finalFood,
          health: finalHealth
        }, null);
      }

      return createResult(false, 'error', { itemName }, 'Item state was not modified after consumption');
    } catch (err) {
      const finalCount = countInventoryItem(bot, itemName);
      const finalFood = bot.food !== undefined ? bot.food : currentFood;
      const finalHealth = bot.health !== undefined ? bot.health : initialHealth;

      if (finalCount < initialCount || finalFood > currentFood || finalHealth > initialHealth) {
        return createResult(true, 'consumed', {
          itemName,
          consumedCount: initialCount - finalCount,
          food: finalFood,
          health: finalHealth
        }, null);
      }

      if (isAborted || abortSignal?.aborted) {
        return createResult(false, 'aborted', { itemName }, 'Consume operation aborted by caller');
      }
      if (isTimedOut) {
        return createResult(false, 'timeout', { itemName }, 'Consume operation timed out');
      }

      return createResult(false, 'error', { itemName }, String(err?.message || err));
    } finally {
      cleanup();
    }
  });
}

/**
 * Craft recipe using crafting table block or player 2x2 grid
 * @param {object} bot Mineflayer bot instance
 * @param {object} recipe Recipe instance from registry
 * @param {number} [count=1] Number of crafting operations
 * @param {object|null} [tableBlock=null] Placed crafting table block if 3x3
 * @param {object} [options={}] Operation options
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function craftRecipe(bot, recipe, count = 1, tableBlock = null, options = {}) {
  if (!recipe || typeof recipe !== 'object') {
    return createResult(false, 'invalid_recipe', null, 'Recipe object is invalid or null');
  }

  if (!Number.isInteger(count) || count <= 0) {
    return createResult(false, 'invalid_recipe', { count }, 'Craft count must be a positive integer');
  }

  return withInventoryLock(bot, async () => {
    const timeoutMs = options.timeoutMs || 0;
    const abortSignal = options.abortSignal;
    const registry = getRegistry(bot);

    if (abortSignal?.aborted) {
      return createResult(false, 'aborted', null, 'Craft operation aborted before start');
    }

    const needsTable = recipeRequiresTable(recipe);
    if (needsTable) {
      if (!tableBlock || tableBlock.name !== 'crafting_table') {
        return createResult(false, 'missing_table', null, 'Crafting table required for 3x3 recipe');
      }

      const botPos = bot.entity?.position;
      const tablePos = tableBlock.position;
      if (botPos && tablePos) {
        const distance = typeof botPos.distanceTo === 'function'
          ? botPos.distanceTo(tablePos)
          : Math.hypot(botPos.x - tablePos.x, botPos.y - tablePos.y, botPos.z - tablePos.z);

        if (distance > 4.5) {
          return createResult(false, 'out_of_reach', { distance, maxDistance: 4.5 }, 'Crafting table is out of reach');
        }
      }
    }

    if (Array.isArray(recipe.delta)) {
      for (const ingredient of recipe.delta) {
        if (ingredient.count < 0) {
          const required = Math.abs(ingredient.count) * count;
          const available = countInventoryItem(bot, ingredient.id);
          if (available < required) {
            const ingredientName = registry?.items?.[ingredient.id]?.name || String(ingredient.id);
            return createResult(false, 'missing_ingredients', {
              ingredient: ingredientName,
              required,
              available
            }, `Insufficient ingredient: ${ingredientName}`);
          }
        }
      }
    }

    const resultId = recipe.result?.id;
    const resultName = registry?.items?.[resultId]?.name || (typeof recipe.result?.name === 'string' ? recipe.result.name : null);
    const resultPerCraft = recipe.result?.count || 1;
    const expectedOutputCount = resultPerCraft * count;

    const initialResultCount = resultName ? countInventoryItem(bot, resultName) : (resultId !== undefined ? countInventoryItem(bot, resultId) : 0);

    const emptySlots = bot.inventory?.slots ? bot.inventory.slots.slice(9, 45).filter(s => s === null).length : 0;
    if (emptySlots === 0 && initialResultCount === 0) {
      return createResult(false, 'inventory_full', null, 'Inventory has no free slots to receive crafted output');
    }

    let timerId = null;
    let abortHandler = null;
    let isTimedOut = false;
    let isAborted = false;

    const cleanup = () => {
      if (timerId) clearTimeout(timerId);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    };

    try {
      const craftPromise = (async () => {
        if (typeof bot.craft !== 'function') {
          throw new Error('Bot does not support craft action');
        }
        await bot.craft(recipe, count, tableBlock);
      })();

      const racePromises = [craftPromise];

      if (abortSignal) {
        const abortPromise = new Promise((_, reject) => {
          abortHandler = () => {
            isAborted = true;
            reject(new Error('Craft operation aborted by caller'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        });
        racePromises.push(abortPromise);
      }

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => {
            isTimedOut = true;
            reject(new Error('Craft operation timed out'));
          }, timeoutMs);
        });
        racePromises.push(timeoutPromise);
      }

      await Promise.race(racePromises);

      const finalResultCount = resultName ? countInventoryItem(bot, resultName) : (resultId !== undefined ? countInventoryItem(bot, resultId) : 0);
      const gainedCount = finalResultCount - initialResultCount;

      if (gainedCount > 0) {
        return createResult(true, 'crafted', {
          item: resultName || resultId,
          count,
          gainedCount,
          expectedCount: expectedOutputCount
        }, null);
      }

      return createResult(false, 'error', null, 'No crafted items were added to inventory after crafting');
    } catch (err) {
      const finalResultCount = resultName ? countInventoryItem(bot, resultName) : (resultId !== undefined ? countInventoryItem(bot, resultId) : 0);
      const gainedCount = finalResultCount - initialResultCount;

      if (gainedCount > 0) {
        return createResult(true, 'crafted', {
          item: resultName || resultId,
          count,
          gainedCount,
          expectedCount: expectedOutputCount
        }, null);
      }

      if (isAborted || abortSignal?.aborted) {
        return createResult(false, 'aborted', null, 'Craft operation aborted by caller');
      }
      if (isTimedOut) {
        return createResult(false, 'timeout', null, 'Craft operation timed out');
      }

      return createResult(false, 'error', null, String(err?.message || err));
    } finally {
      cleanup();
    }
  });
}

/**
 * Drop item from inventory onto the ground
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Item name to drop
 * @param {number} [count=1] Quantity to drop
 * @param {object} [options={}] Operation options
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function dropItem(bot, itemName, count = 1, options = {}) {
  if (!Number.isInteger(count) || count <= 0) {
    return createResult(false, 'invalid_count', { count }, 'Drop count must be a positive integer');
  }

  return withInventoryLock(bot, async () => {
    const timeoutMs = options.timeoutMs || 0;
    const abortSignal = options.abortSignal;

    if (abortSignal?.aborted) {
      return createResult(false, 'aborted', { itemName, count }, 'Drop operation aborted before start');
    }

    const initialCount = countInventoryItem(bot, itemName);
    if (initialCount < count) {
      return createResult(false, 'missing_item', {
        itemName,
        required: count,
        available: initialCount
      }, 'Insufficient item quantity in inventory to drop');
    }

    const item = bot.inventory.items().find(i => i.name === itemName);

    let timerId = null;
    let abortHandler = null;
    let isTimedOut = false;
    let isAborted = false;

    const cleanup = () => {
      if (timerId) clearTimeout(timerId);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    };

    try {
      const dropPromise = (async () => {
        if (typeof bot.toss === 'function') {
          await bot.toss(item.type, null, count);
        } else if (typeof bot.tossStack === 'function') {
          await bot.tossStack(item);
        } else {
          throw new Error('Bot does not support toss action');
        }
      })();

      const racePromises = [dropPromise];

      if (abortSignal) {
        const abortPromise = new Promise((_, reject) => {
          abortHandler = () => {
            isAborted = true;
            reject(new Error('Drop operation aborted by caller'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        });
        racePromises.push(abortPromise);
      }

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => {
            isTimedOut = true;
            reject(new Error('Drop operation timed out'));
          }, timeoutMs);
        });
        racePromises.push(timeoutPromise);
      }

      await Promise.race(racePromises);

      const finalCount = countInventoryItem(bot, itemName);
      const droppedCount = initialCount - finalCount;

      if (droppedCount === count) {
        return createResult(true, 'dropped', { itemName, droppedCount }, null);
      }

      return createResult(false, 'error', {
        itemName,
        droppedCount,
        expectedCount: count
      }, 'Inventory reduction did not match requested drop count');
    } catch (err) {
      const finalCount = countInventoryItem(bot, itemName);
      const droppedCount = initialCount - finalCount;

      if (droppedCount === count) {
        return createResult(true, 'dropped', { itemName, droppedCount }, null);
      }

      if (isAborted || abortSignal?.aborted) {
        return createResult(false, 'aborted', { itemName, count }, 'Drop operation aborted by caller');
      }
      if (isTimedOut) {
        return createResult(false, 'timeout', { itemName, count }, 'Drop operation timed out');
      }

      return createResult(false, 'error', { itemName }, String(err?.message || err));
    } finally {
      cleanup();
    }
  });
}

module.exports = {
  VALID_DESTINATIONS,
  withInventoryLock,
  equipItem,
  consumeItem,
  craftRecipe,
  dropItem
};
