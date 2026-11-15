const { goals } = require('mineflayer-pathfinder');
const config = require('../../../infrastructure/config');
const { countItem, isWoodLog, isPlanks, resolvePlankTarget, findNearbyCraftingTable } = require('../../../perception/inventory');
const { autoEquipArmorAndShield } = require('./equip');

const AUTO_EQUIP_SUFFIXES = ['_helmet', '_chestplate', '_leggings', '_boots', 'shield'];
const SINGLE_CRAFT_ITEMS = new Set(['crafting_table', 'furnace', 'chest']);

/**
 * Valider les préconditions de fabrication avant de rechercher les recettes
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} targetName Nom de l'item demandé
 * @param {object|null} item Entrée de l'item dans le registre
 * @returns {{ success: boolean, message: string }|null} Erreur préalable ou null si valide
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
 * Approcher le bot de l'établi cible et orienter son regard vers celui-ci
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} tableToUse Bloc d'établi cible
 * @returns {Promise<{ success: boolean, message?: string }>} Résultat du déplacement vers l'établi
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
 * Rechercher les recettes disponibles pour l'item cible en substituant l'essence de bois si nécessaire
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} item Item initial du registre
 * @param {string} normalizedTarget Nom normalisé de la cible
 * @param {object|null} tableToUse Bloc d'établi ou null
 * @param {number} [requestedQty=1] Quantité d'opérations souhaitée
 * @returns {{ recipes: Array<object>, normalizedTarget: string }} Recettes triées et cible retenue
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
 * Calculer le nombre sûr d'exécutions d'une recette selon le type d'item et les ingrédients disponibles
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} recipe Objet recette sélectionné
 * @param {string} targetName Nom de l'item cible
 * @param {number} requestedQty Quantité demandée
 * @returns {number} Nombre d'exécutions de la recette à réaliser
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
 * Récupérer récursivement les items restés dans la grille personnelle 2x2 (emplacements 1 à 4)
 * @param {object} bot Instance du bot Mineflayer
 * @param {number} [slotIndex=1] Index de l'emplacement de grille en cours
 * @returns {Promise<void>} Promesse résolue après nettoyage de la grille
 */
async function reclaimPersonalCraftingGrid(bot, slotIndex = 1) {
  if (slotIndex > 4 || typeof bot.putAway !== 'function') return;
  if (bot.inventory?.slots?.[slotIndex]) {
    try {
      await bot.putAway(slotIndex);
    } catch (err) {
      void err;
    }
  }
  await reclaimPersonalCraftingGrid(bot, slotIndex + 1);
}

/**
 * Exécuter l'appel de fabrication Mineflayer avec un délai de sécurité de 10 secondes et fermeture de fenêtre
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} recipe Recette à exécuter
 * @param {object|null} tableToUse Bloc d'établi ou null
 * @param {string} normalizedTarget Nom de l'item fabriqué
 * @param {number} [craftCount=1] Nombre d'exécutions de la recette
 * @returns {Promise<{ success: boolean, message?: string }>} Résultat de l'opération de craft
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
 * Ramasser un item fabriqué tombé au sol à proximité si l'inventaire ne l'a pas reçu directement
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} normalizedTarget Nom de l'item fabriqué
 * @returns {Promise<number>} Quantité mise à jour dans l'inventaire
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
 * Vérifier le besoin d'un établi et déplacer le bot vers l'établi posé si nécessaire
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} state État global du bot
 * @param {object} item Entrée de l'item dans le registre
 * @param {string} targetName Nom de l'item demandé
 * @returns {Promise<{ ok: boolean, tableToUse?: object|null, errorResult?: { success: boolean, message: string } }>} Résultat de préparation
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
 * Attendre la synchronisation de l'inventaire après la fabrication et ramasser l'item au sol si besoin
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} normalizedTarget Nom de l'item fabriqué
 * @param {number} countBefore Quantité possédée avant la fabrication
 * @returns {Promise<number>} Quantité possédée après synchronisation
 */
async function waitForCraftedInventorySync(bot, normalizedTarget, countBefore) {
  await bot.waitForTicks(8);
  let countAfter = countItem(bot, normalizedTarget);
  for (let retry = 0; retry < 3 && countAfter <= countBefore; retry++) {
    await bot.waitForTicks(5);
    countAfter = countItem(bot, normalizedTarget);
  }
  if (countAfter <= countBefore) {
    countAfter = await collectDroppedCraftItem(bot, normalizedTarget);
  }
  return countAfter;
}

/**
 * Fabriquer un item via la grille personnelle ou un établi à proximité
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} state État global du bot
 * @param {string} targetName Nom de l'item à fabriquer
 * @param {number} [qty=1] Quantité d'opérations demandée
 * @returns {Promise<{ success: boolean, message: string }>} Résultat de l'opération de fabrication
 */
async function skillCraft(bot, state, targetName, qty = 1) {
  if (isWoodLog(targetName)) {
    return { success: false, message: "Raw logs and wood cannot be crafted: harvest them with 'mine' on trees." };
  }

  const initialTarget = isPlanks(targetName) ? resolvePlankTarget(bot, targetName) : targetName;
  const item = bot.registry.itemsByName[initialTarget];

  const preconditionError = checkCraftPreconditions(bot, targetName, item);
  if (preconditionError) return preconditionError;

  const station = await prepareCraftingStation(bot, state, item, targetName);
  if (!station.ok) return station.errorResult;

  const { recipes, normalizedTarget } = resolveCraftRecipes(bot, item, initialTarget, station.tableToUse, qty);
  if (recipes.length === 0) {
    return { success: false, message: `Missing required components in inventory to craft '${targetName}'.` };
  }

  const craftCount = computeCraftOperations(bot, recipes[0], normalizedTarget, qty);
  const countBefore = countItem(bot, normalizedTarget);
  const craftExec = await performCraftWithTimeout(bot, recipes[0], station.tableToUse, normalizedTarget, craftCount);
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

  return { success: false, message: `Crafting completed but '${normalizedTarget}' was not found in inventory.` };
}

module.exports = { skillCraft, computeCraftOperations };
