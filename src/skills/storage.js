const { goals } = require('mineflayer-pathfinder');

// Objets précieux ou essentiels que le bot doit TOUJOURS garder sur lui
const ESSENTIAL_ITEMS = new Set([
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe',
  'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe',
  'iron_sword', 'diamond_sword', 'netherite_sword', 'shield',
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
  'torch', 'bucket', 'water_bucket', 'flint_and_steel',
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'apple',
  'diamond', 'raw_iron', 'iron_ingot', 'raw_gold', 'gold_ingot', 'lapis_lazuli'
]);

/**
 * Détermine si un objet de l'inventaire doit être déposé dans le coffre
 * @param {object} item Objet d'inventaire Mineflayer
 * @returns {boolean} True si l'objet est encombrant et doit être stocké
 */
function isItemToStore(item) {
  if (ESSENTIAL_ITEMS.has(item.name)) return false;

  // Blocs de terrassement et surplus
  const bulkMaterials = ['dirt', 'cobblestone', 'granite', 'diorite', 'andesite', 'cobbled_deepslate', 'gravel', 'sand'];
  if (bulkMaterials.includes(item.name)) {
    return item.count > 32; // Garder au maximum 32 blocs sur soi pour les ponts
  }

  // Stocker les saplings, graines, os, flèches en surplus
  if (item.name.includes('sapling') || item.name.includes('seeds') || item.name === 'bone' || item.name === 'arrow') {
    return true;
  }

  return false;
}

/**
 * Gère le rangement automatique de l'inventaire dans un coffre
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state État global du bot
 * @returns {Promise<{ success: boolean, message: string }>} Résultat de l'opération de tri
 */
async function skillChest(bot, state) {
  const chestBlockId = bot.registry.blocksByName.chest?.id;
  let chestBlock = chestBlockId ? bot.findBlock({ matching: chestBlockId, maxDistance: 32 }) : null;

  if (!chestBlock && state.base.chest) {
    chestBlock = bot.blockAt(state.base.chest);
    if (chestBlock && chestBlock.name !== 'chest') {
      chestBlock = null;
      state.base.chest = null;
    }
  }

  if (!chestBlock) {
    return {
      success: false,
      message: "Aucun coffre ('chest') trouvé à proximité. Fabrique et pose un coffre ('craft chest' puis 'place chest') d'abord."
    };
  }

  try {
    if (bot.entity.position.distanceTo(chestBlock.position) > 3) {
      bot.pathfinder.setGoal(new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z));
      await new Promise(resolve => bot.once('goal_reached', resolve));
    }

    const chest = await bot.openChest(chestBlock);
    let depositedCount = 0;
    const depositedNames = [];

    const items = bot.inventory.items();
    await Promise.all(items.map(async item => {
      if (isItemToStore(item)) {
        const amountToKeep = ['dirt', 'cobblestone', 'cobbled_deepslate'].includes(item.name) ? 32 : 0;
        const amountToDeposit = item.count - amountToKeep;

        if (amountToDeposit > 0) {
          try {
            await chest.deposit(item.type, null, amountToDeposit);
            depositedCount += amountToDeposit;
            depositedNames.push(`${amountToDeposit}x ${item.name}`);
          } catch (e) {
            console.warn(`Erreur lors du dépôt de ${item.name} :`, e.message);
          }
        }
      }
    }));

    chest.close();

    if (depositedCount === 0) {
      return { success: true, message: "Inventaire déjà propre : aucun objet encombrant à déposer." };
    }

    return {
      success: true,
      message: `Tri effectué dans le coffre : déposé ${depositedNames.slice(0, 4).join(', ')}${depositedNames.length > 4 ? '...' : ''}.`
    };
  } catch (error) {
    console.warn("Erreur avec le coffre :", error.message);
    return { success: false, message: `Échec du rangement dans le coffre : ${error.message}` };
  }
}

module.exports = { skillChest, isItemToStore };
