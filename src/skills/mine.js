const { goals } = require('mineflayer-pathfinder');
const GLOBAL_BAD_BLOCKS = new Set();
const { getBestToolForBlock, countItem, getInventorySummary } = require('../utils/inventory');
const { getBlockDrops, canHarvestBlock, getBlockNamesForTarget } = require('../utils/wikiData');

/**
 * Avance brièvement vers l'emplacement d'un bloc détruit pour en ramasser le butin
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} position Vecteur position du bloc miné
 */
async function collectDrops(bot, position) {
  try {
    await bot.lookAt(position.offset(0.5, 0.5, 0.5));
    bot.setControlState('forward', true);
    await bot.waitForTicks(8);
  } catch {
    // Mouvement d'aspiration tolérant les interruptions
  } finally {
    bot.setControlState('forward', false);
  }
}

/**
 * Cible, approche et extrait un unique bloc correspondant à la ressource demandée
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} targetName Nom de la ressource ciblée
 * @returns {Promise<{ success: boolean, empty: boolean, message: string }>}
 */
async function mineSingleTarget(bot, targetName) {
  const candidateBlockNames = new Set(getBlockNamesForTarget(bot, targetName));

  const targetBlock = bot.findBlock({
    matching: (block) => {
      if (!block?.position) return candidateBlockNames.has(block?.name);
      return candidateBlockNames.has(block.name) && !GLOBAL_BAD_BLOCKS.has(block.position.toString());
    },
    maxDistance: 30
  });

  if (!targetBlock) {
    return { success: false, empty: true, message: `Aucun bloc correspondant à '${targetName}' trouvé à proximité.` };
  }

  // Vérification de l'outil requis selon les règles du wiki pour la version active
  const harvestCheck = canHarvestBlock(bot, targetBlock);
  if (!harvestCheck.canHarvest) {
    return { success: false, empty: false, message: harvestCheck.message };
  }

  const bestTool = getBestToolForBlock(bot, targetBlock);
  if (bestTool) {
    try {
      await bot.equip(bestTool, 'hand');
    } catch {
      // Ignorer l'erreur d'équipement si l'outil est déjà en main
    }
  }

  const expectedDrops = getBlockDrops(bot, targetBlock.name);
  const initialCounts = new Map(expectedDrops.map(name => [name, countItem(bot, name)]));

  try {
    const { GoalNear } = goals;

    console.log(`[MINE] Je me dirige vers ${targetBlock.name}...`);
    const gotoPromise = bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2));
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout de navigation")), 30000));
    await Promise.race([gotoPromise, timeoutPromise]);

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    const blockToBreak = bot.blockAt(targetBlock.position);
    await bot.lookAt(targetBlock.position.offset(0.5, 0.5, 0.5));

    const finalTool = getBestToolForBlock(bot, blockToBreak);
    if (finalTool) {
      try {
        await bot.equip(finalTool, 'hand');
      } catch {
        // Ignorer l'erreur d'équipement
      }
    }

    console.log(`[MINE] Je creuse ${targetBlock.name}...`);
    const digPromise = bot.dig(blockToBreak);
    const digTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout creusage")), 10000));
    await Promise.race([digPromise, digTimeout]);
    console.log(`[MINE] C'est cassé, je ramasse...`);

    try {
      await bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));
    } catch {
      // Poursuivre la collecte même en cas de léger décalage de trajectoire
    }

    await collectDrops(bot, targetBlock.position);

    // Attente brève et bornée pour la réception des paquets d'inventaire
    await bot.waitForTicks(6);

    let collectedItemName = null;
    let collectedQuantity = 0;

    for (const dropName of expectedDrops) {
      const currentCount = countItem(bot, dropName);
      const initialCount = initialCounts.get(dropName) || 0;
      const difference = currentCount - initialCount;
      if (difference > 0) {
        collectedItemName = dropName;
        collectedQuantity = difference;
        break;
      }
    }

    if (collectedQuantity <= 0) {
      return {
        success: false,
        empty: false,
        message: `Bloc '${blockToBreak.name}' cassé mais aucun '${expectedDrops.join('/')}' récupéré.`
      };
    }

    return {
      success: true,
      empty: false,
      message: `+${collectedQuantity} '${collectedItemName}' récupéré(s).`
    };
  } catch (error) {
    console.warn("Échec physique du minage :", error.message);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    GLOBAL_BAD_BLOCKS.add(targetBlock.position.toString());
    return { success: false, empty: false, message: `Bloc inaccessible (${error.message}).` };
  }
}

/**
 * Exécute une session de minage répétée pour atteindre la quantité souhaitée
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state État global du bot
 * @param {string} targetName Nom du bloc ou de l'item à miner
 * @param {number} count Nombre de blocs à récolter
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function skillMine(bot, state, targetName, count) {
  const targetQuantity = Math.max(1, count || 1);
  let successfullyMined = 0;
  let lastFailureMessage = '';

  for (let step = 0; step < targetQuantity; step++) {
    if (!state.isSurviving) break;

    const result = await mineSingleTarget(bot, targetName);
    lastFailureMessage = result.message;

    if (result.empty) break;
    if (result.success) successfullyMined++;
  }

  if (successfullyMined === 0) {
    return { success: false, message: `Échec du minage de '${targetName}' : ${lastFailureMessage}` };
  }

  return {
    success: true,
    message: `${successfullyMined} bloc(s) récolté(s) pour '${targetName}'. Inventaire : ${getInventorySummary(bot)}`
  };
}

module.exports = { skillMine };
