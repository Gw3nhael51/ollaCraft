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
 * Récupérer le registre minecraft-data depuis l'instance du bot
 * @param {object} bot Instance du bot Mineflayer
 * @returns {object|null} Registre de données Minecraft
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
 * Résoudre le numéro d'emplacement d'inventaire correspondant au nom de destination
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} destination Identifiant de l'emplacement de destination
 * @returns {number|null} Index de l'emplacement cible
 */
function getDestinationSlot(bot, destination) {
  if (typeof bot.getEquipmentDestSlot === 'function') {
    try {
      const slot = bot.getEquipmentDestSlot(destination);
      if (typeof slot === 'number') return slot;
    } catch {
      return null;
    }
  }

  switch (destination) {
    case 'head': return 5;
    case 'torso': return 6;
    case 'legs': return 7;
    case 'feet': return 8;
    case 'off-hand': return 45;
    case 'hand': return bot.quickBarSlot === undefined ? 36 : 36 + bot.quickBarSlot;
    default: return null;
  }
}

/**
 * Vérifier si un item est actuellement équipé dans la destination cible
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} itemName Nom de l'item attendu
 * @param {string} destination Nom de la destination
 * @returns {boolean} Vrai si l'item est équipé
 */
function isItemEquipped(bot, itemName, destination) {
  if (destination === 'hand' && bot.heldItem?.name === itemName) {
    return true;
  }

  const slot = getDestinationSlot(bot, destination);
  if (slot !== null && bot.inventory?.slots?.[slot]) {
    return bot.inventory.slots[slot].name === itemName;
  }

  if (bot.equipment?.[destination]) {
    return bot.equipment[destination].name === itemName;
  }

  return false;
}

/**
 * Compter le nombre total d'unités d'un item disponibles dans l'inventaire du bot
 * @param {object} bot Instance du bot Mineflayer
 * @param {string|number} itemKey Nom ou identifiant numérique de l'item
 * @returns {number} Quantité disponible
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
 * Vérifier si un item peut être consommé selon ses propriétés alimentaires dans minecraft-data
 * @param {object|null} registry Registre de données Minecraft
 * @param {string} itemName Nom de l'item à tester
 * @returns {boolean} Vrai si l'item est consommable
 */
function isConsumable(registry, itemName) {
  if (ALWAYS_EDIBLE_ITEMS.has(itemName)) return true;
  if (typeof itemName === 'string' && itemName.endsWith('_potion')) return true;
  if (registry?.foodsByName?.[itemName]) return true;

  const itemDef = registry?.itemsByName?.[itemName];
  return Boolean(itemDef && (itemDef.foodPoints !== undefined || itemDef.food !== undefined));
}

/**
 * Vérifier si un item peut être consommé même lorsque la barre de faim est pleine
 * @param {string} itemName Nom de l'item
 * @returns {boolean} Vrai si consommable à satiété maximale
 */
function isEdibleAtFullHunger(itemName) {
  if (ALWAYS_EDIBLE_ITEMS.has(itemName)) return true;
  return typeof itemName === 'string' && itemName.endsWith('_potion');
}

/**
 * Déterminer si une recette nécessite une grille 3x3 d'établi
 * @param {object} recipe Instance de la recette
 * @returns {boolean} Vrai si un établi est requis
 */
function recipeRequiresTable(recipe) {
  if (recipe.requiresTable !== undefined) {
    return Boolean(recipe.requiresTable);
  }

  if (Array.isArray(recipe.inShape)) {
    if (recipe.inShape.length > 2) return true;
    if (recipe.inShape.some(row => Array.isArray(row) && row.length > 2)) return true;
  }

  return Array.isArray(recipe.ingredients) && recipe.ingredients.length > 4;
}

/**
 * Exécuter une action d'inventaire asynchrone sous surveillance de timeout et d'annulation
 * @param {Function} actionFn Fonction asynchrone à exécuter
 * @param {object} guards Options de surveillance
 * @param {number} guards.timeoutMs Délai maximal en millisecondes
 * @param {AbortSignal} [guards.abortSignal] Signal d'annulation externe
 * @param {string} guards.abortMessage Message en cas d'annulation
 * @param {string} guards.timeoutMessage Message en cas de dépassement de délai
 * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>} Résultat de l'exécution
 */
async function runItemOperationWithGuards(actionFn, guards) {
  const { timeoutMs, abortSignal, abortMessage, timeoutMessage } = guards;
  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;

  try {
    const racePromises = [actionFn()];

    if (abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        abortHandler = () => {
          isAborted = true;
          reject(new Error(abortMessage));
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      });
      racePromises.push(abortPromise);
    }

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          isTimedOut = true;
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    await Promise.race(racePromises);
    return { ok: true };
  } catch (err) {
    if (isAborted || abortSignal?.aborted) {
      return { ok: false, reason: 'aborted', error: abortMessage };
    }
    if (isTimedOut) {
      return { ok: false, reason: 'timeout', error: timeoutMessage };
    }
    return { ok: false, reason: 'error', error: String(err?.message || err) };
  } finally {
    if (timerId) clearTimeout(timerId);
    if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
  }
}

/**
 * Équiper l'item spécifié dans l'emplacement d'inventaire cible
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} itemName Nom de l'item à équiper
 * @param {string} [destination='hand'] Emplacement cible ('hand', 'head', 'torso', 'legs', 'feet', 'off-hand')
 * @param {object} [options={}] Options de l'opération
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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

    const outcome = await runItemOperationWithGuards(
      async () => {
        if (typeof bot.equip !== 'function') {
          throw new TypeError('Bot does not support equip action');
        }
        await bot.equip(item, destination);
      },
      {
        timeoutMs,
        abortSignal,
        abortMessage: 'Equip operation aborted by caller',
        timeoutMessage: 'Equip operation timed out'
      }
    );

    if (isItemEquipped(bot, itemName, destination)) {
      return createResult(true, 'equipped', { itemName, destination }, null);
    }
    if (!outcome.ok) {
      return createResult(false, outcome.reason, { itemName, destination }, outcome.error);
    }
    return createResult(false, 'error', { itemName, destination }, 'Item was not found in destination slot after equip');
  });
}

/**
 * Vérifier si la consommation d'un aliment ou breuvage a modifié l'état du bot
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} itemName Nom de l'item consommé
 * @param {object} before État initial avant consommation
 * @param {boolean} [includeSaturation=false] Prendre en compte la variation de saturation
 * @returns {{ consumed: boolean, payload: object }} Résultat de vérification
 */
function checkConsumptionEffect(bot, itemName, before, includeSaturation = false) {
  const finalCount = countInventoryItem(bot, itemName);
  const finalFood = bot.food ?? before.food;
  const finalHealth = bot.health ?? before.health;
  const finalSaturation = bot.foodSaturation ?? before.saturation;

  const baseChanged = finalCount < before.count || finalFood > before.food || finalHealth > before.health;
  const consumed = includeSaturation ? (baseChanged || finalSaturation > before.saturation) : baseChanged;

  return {
    consumed,
    payload: {
      itemName,
      consumedCount: before.count - finalCount,
      food: finalFood,
      health: finalHealth
    }
  };
}

/**
 * Consommer un aliment ou une boisson depuis l'inventaire
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} itemName Nom de l'aliment ou de la boisson
 * @param {object} [options={}] Options de l'opération
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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

    const currentFood = bot.food ?? 20;
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

    const beforeState = {
      count: initialCount,
      food: currentFood,
      health: bot.health ?? 20,
      saturation: bot.foodSaturation ?? 0
    };

    const outcome = await runItemOperationWithGuards(
      async () => {
        if (typeof bot.consume !== 'function') {
          throw new TypeError('Bot does not support consume action');
        }
        await bot.consume();
      },
      {
        timeoutMs,
        abortSignal,
        abortMessage: 'Consume operation aborted by caller',
        timeoutMessage: 'Consume operation timed out'
      }
    );

    const effect = checkConsumptionEffect(bot, itemName, beforeState, outcome.ok);
    if (effect.consumed) {
      return createResult(true, 'consumed', effect.payload, null);
    }
    if (!outcome.ok) {
      return createResult(false, outcome.reason, { itemName }, outcome.error);
    }
    return createResult(false, 'error', { itemName }, 'Item state was not modified after consumption');
  });
}

/**
 * Compter la quantité possédée de l'item produit par une recette
 * @param {object} bot Instance du bot Mineflayer
 * @param {string|null} resultName Nom de l'item produit
 * @param {number|undefined} resultId Identifiant numérique de l'item produit
 * @returns {number} Quantité présente dans l'inventaire
 */
function countRecipeResultItem(bot, resultName, resultId) {
  if (resultName) return countInventoryItem(bot, resultName);
  if (resultId !== undefined) return countInventoryItem(bot, resultId);
  return 0;
}

/**
 * Valider la présence et la portée de l'établi si la recette l'exige
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} recipe Recette à vérifier
 * @param {object|null} tableBlock Bloc d'établi fourni
 * @returns {object|null} Résultat d'erreur ou null si valide
 */
function validateCraftingTableAccess(bot, recipe, tableBlock) {
  if (!recipeRequiresTable(recipe)) return null;
  if (!tableBlock || tableBlock.name !== 'crafting_table') {
    return createResult(false, 'missing_table', null, 'Crafting table required for 3x3 recipe');
  }

  const botPos = bot.entity?.position;
  const tablePos = tableBlock.position;
  if (!botPos || !tablePos) return null;

  const distance = typeof botPos.distanceTo === 'function'
    ? botPos.distanceTo(tablePos)
    : Math.hypot(botPos.x - tablePos.x, botPos.y - tablePos.y, botPos.z - tablePos.z);

  if (distance > 4.5) {
    return createResult(false, 'out_of_reach', { distance, maxDistance: 4.5 }, 'Crafting table is out of reach');
  }
  return null;
}

/**
 * Vérifier que tous les ingrédients requis par le delta de la recette sont disponibles
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} recipe Recette à vérifier
 * @param {number} count Nombre d'exécutions
 * @param {object|null} registry Registre de données Minecraft
 * @returns {object|null} Résultat d'erreur en cas d'ingrédient manquant ou null
 */
function validateRecipeIngredients(bot, recipe, count, registry) {
  if (!Array.isArray(recipe.delta)) return null;

  for (const ingredient of recipe.delta) {
    if (ingredient.count >= 0) continue;
    const required = Math.abs(ingredient.count) * count;
    const key = ingredient.id === undefined ? ingredient.name : ingredient.id;
    const available = countInventoryItem(bot, key);
    if (available < required) {
      const ingredientName = registry?.items?.[ingredient.id]?.name || ingredient.name || String(ingredient.id);
      return createResult(false, 'missing_ingredients', {
        ingredient: ingredientName,
        required,
        available
      }, `Insufficient ingredient: ${ingredientName}`);
    }
  }
  return null;
}

/**
 * Fabriquer une recette via un établi posé ou la grille personnelle 2x2 du joueur
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} recipe Instance de recette issue du registre
 * @param {number} [count=1] Nombre d'opérations de fabrication
 * @param {object|null} [tableBlock=null] Bloc d'établi posé si 3x3
 * @param {object} [options={}] Options de l'opération
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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

    const tableError = validateCraftingTableAccess(bot, recipe, tableBlock);
    if (tableError) return tableError;

    const ingredientError = validateRecipeIngredients(bot, recipe, count, registry);
    if (ingredientError) return ingredientError;

    const resultId = recipe.result?.id;
    const fallbackResultName = typeof recipe.result?.name === 'string' ? recipe.result.name : null;
    const resultName = registry?.items?.[resultId]?.name || fallbackResultName;
    const resultPerCraft = recipe.result?.count || 1;
    const expectedOutputCount = resultPerCraft * count;

    const initialResultCount = countRecipeResultItem(bot, resultName, resultId);
    const emptySlots = bot.inventory?.slots ? bot.inventory.slots.slice(9, 45).filter(s => s === null).length : 0;
    if (emptySlots === 0 && initialResultCount === 0) {
      return createResult(false, 'inventory_full', null, 'Inventory has no free slots to receive crafted output');
    }

    const outcome = await runItemOperationWithGuards(
      async () => {
        if (typeof bot.craft !== 'function') {
          throw new TypeError('Bot does not support craft action');
        }
        await bot.craft(recipe, count, tableBlock);
      },
      {
        timeoutMs,
        abortSignal,
        abortMessage: 'Craft operation aborted by caller',
        timeoutMessage: 'Craft operation timed out'
      }
    );

    const finalResultCount = countRecipeResultItem(bot, resultName, resultId);
    const gainedCount = finalResultCount - initialResultCount;

    if (gainedCount > 0) {
      return createResult(true, 'crafted', {
        item: resultName || resultId,
        count,
        gainedCount,
        expectedCount: expectedOutputCount
      }, null);
    }
    if (!outcome.ok) {
      return createResult(false, outcome.reason, null, outcome.error);
    }
    return createResult(false, 'error', null, 'No crafted items were added to inventory after crafting');
  });
}

/**
 * Jeter un item de l'inventaire au sol
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} itemName Nom de l'item à jeter
 * @param {number} [count=1] Quantité à jeter
 * @param {object} [options={}] Options de l'opération
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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

    const outcome = await runItemOperationWithGuards(
      async () => {
        if (typeof bot.toss === 'function') {
          await bot.toss(item.type, null, count);
          return;
        }
        if (typeof bot.tossStack === 'function') {
          await bot.tossStack(item);
          return;
        }
        throw new TypeError('Bot does not support toss action');
      },
      {
        timeoutMs,
        abortSignal,
        abortMessage: 'Drop operation aborted by caller',
        timeoutMessage: 'Drop operation timed out'
      }
    );

    const finalCount = countInventoryItem(bot, itemName);
    const droppedCount = initialCount - finalCount;

    if (droppedCount === count) {
      return createResult(true, 'dropped', { itemName, droppedCount }, null);
    }
    if (!outcome.ok) {
      return createResult(false, outcome.reason, { itemName, count }, outcome.error);
    }
    return createResult(false, 'error', {
      itemName,
      droppedCount,
      expectedCount: count
    }, 'Inventory reduction did not match requested drop count');
  });
}

module.exports = {
  VALID_DESTINATIONS,
  equipItem,
  consumeItem,
  craftRecipe,
  dropItem
};
