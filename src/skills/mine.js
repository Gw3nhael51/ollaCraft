const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const GLOBAL_BAD_BLOCKS = new Set();
const { getBestToolForBlock, countItem, getInventorySummary } = require('../utils/inventory');
const { getBlockDrops, canHarvestBlock, getBlockNamesForTarget } = require('../utils/wikiData');
const { isBlockExposedToAir, VALUABLE_ORES } = require('../utils/environment');

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
  const isOpportunistic = targetName === 'opportuniste' || targetName === 'ore' || targetName === 'ores';
  const candidateBlockNames = isOpportunistic ? VALUABLE_ORES : new Set(getBlockNamesForTarget(bot, targetName));

  const targetBlock = bot.findBlock({
    matching: (block) => {
      if (!block?.position) return candidateBlockNames.has(block?.name);
      if (!candidateBlockNames.has(block.name) || GLOBAL_BAD_BLOCKS.has(block.position.toString())) return false;
      if (isOpportunistic) {
        return isBlockExposedToAir(bot, block) && canHarvestBlock(bot, block).canHarvest;
      }
      return true;
    },
    maxDistance: 30
  });

  if (!targetBlock) {
    const errorTarget = isOpportunistic ? 'minerai exposé' : targetName;
    return { success: false, empty: true, message: `Aucun bloc correspondant à '${errorTarget}' trouvé à proximité.` };
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

    // Vidage de filon : vérifier et extraire immédiatement les blocs adjacents du même filon
    let veinExtraCount = 0;
    if (VALUABLE_ORES.has(blockToBreak.name)) {
      veinExtraCount = await harvestConnectedVein(bot, targetBlock.position, blockToBreak.name);
    }

    const totalCollected = collectedQuantity + veinExtraCount;
    const veinMsg = veinExtraCount > 0 ? ` (+${veinExtraCount} bloc(s) du filon)` : '';

    return {
      success: true,
      empty: false,
      message: `+${totalCollected} '${collectedItemName}' récupéré(s)${veinMsg}.`
    };
  } catch (error) {
    console.warn("Échec physique du minage :", error.message);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    GLOBAL_BAD_BLOCKS.add(targetBlock.position.toString());
    return { success: false, empty: false, message: `Bloc inaccessible (${error.message}).` };
  }
}

const VEIN_DIRECTIONS = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];


/**
 * Formate une position en clé textuelle unique
 * @param {object} pos Position Vec3 ou bloc
 * @returns {string} Clé textuelle x,y,z
 */
function getPosKey(pos) {
  if (!pos) return '';
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/**
 * Tente d'extraire un bloc spécifique du filon s'il est valide et sécurisé
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} neighborPos Position du bloc à miner
 * @param {object} neighborBlock Bloc à miner
 * @returns {Promise<boolean>} True si le bloc a été extrait avec succès
 */
async function mineVeinBlock(bot, neighborPos, neighborBlock) {
  try {
    const tool = getBestToolForBlock(bot, neighborBlock);
    if (tool) await bot.equip(tool, 'hand').catch(() => {});

    console.log(`[FILON] Extraction d'un bloc supplémentaire du filon (${neighborBlock.name}) en ${neighborPos}...`);
    await bot.lookAt(neighborPos.offset(0.5, 0.5, 0.5));
    await bot.dig(neighborBlock);
    await collectDrops(bot, neighborPos);
    return true;
  } catch (err) {
    console.warn(`[FILON] Impossible de miner le bloc adjacent : ${err.message}`);
    GLOBAL_BAD_BLOCKS.add(getPosKey(neighborPos));
    return false;
  }
}

/**
 * Parcourt récursivement les branches du filon sans boucle while-await
 * @param {object} bot Instance Mineflayer du bot
 * @param {Array<object>} queue File d'attente des positions à explorer
 * @param {Set<string>} visited Positions déjà inspectées
 * @param {Set<string>} targetTypes Types de blocs acceptés pour ce filon
 * @param {number} harvested Nombre actuel de blocs récoltés
 * @param {number} maxVeinBlocks Limite maximale
 * @returns {Promise<number>} Total récolté
 */
async function processVeinQueue(bot, queue, visited, targetTypes, harvested, maxVeinBlocks) {
  if (queue.length === 0 || harvested >= maxVeinBlocks) {
    return harvested;
  }

  const current = queue.shift();
  let currentHarvested = harvested;

  for (const dir of VEIN_DIRECTIONS) {
    if (currentHarvested >= maxVeinBlocks) break;

    const neighborPos = current.plus(dir);
    const key = getPosKey(neighborPos);

    if (visited.has(key)) continue;
    visited.add(key);

    const neighborBlock = bot.blockAt(neighborPos);
    if (!neighborBlock || !targetTypes.has(neighborBlock.name)) continue;
    if (GLOBAL_BAD_BLOCKS.has(key)) continue;

    const harvestCheck = canHarvestBlock(bot, neighborBlock);
    if (!harvestCheck.canHarvest) continue;

    const touchesLava = VEIN_DIRECTIONS.some(d => {
      const checkBlock = bot.blockAt(neighborPos.plus(d));
      return checkBlock && (checkBlock.name === 'lava' || checkBlock.name === 'flowing_lava');
    });
    if (touchesLava) continue;

    const success = await mineVeinBlock(bot, neighborPos, neighborBlock);
    if (success) {
      currentHarvested++;
      queue.push(neighborPos);
    }
  }

  return processVeinQueue(bot, queue, visited, targetTypes, currentHarvested, maxVeinBlocks);
}

/**
 * Extrait les blocs adjacents connectés du même filon pour ne laisser aucun minerai derrière
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} originPos Position initiale du minerai cassé
 * @param {string} oreType Nom du bloc de minerai
 * @param {number} maxVeinBlocks Nombre maximal de blocs de filon à récolter
 * @returns {Promise<number>} Nombre de blocs de filon supplémentaires récoltés
 */
async function harvestConnectedVein(bot, originPos, oreType, maxVeinBlocks = 8) {
  const originKey = getPosKey(originPos);
  const visited = new Set([originKey]);
  const queue = [originPos];

  const targetTypes = new Set([oreType]);
  if (oreType.startsWith('deepslate_')) {
    targetTypes.add(oreType.replace('deepslate_', ''));
  } else {
    targetTypes.add(`deepslate_${oreType}`);
  }

  return processVeinQueue(bot, queue, visited, targetTypes, 0, maxVeinBlocks);
}

/**
 * Recherche et récolte un minerai opportuniste exposé à l'air de manière récursive
 * @param {object} bot Instance Mineflayer du bot
 * @param {number} currentCount Nombre de minerais récoltés
 * @param {number} maxCount Nombre maximal souhaité
 * @returns {Promise<number>} Nombre récolté
 */
async function harvestNearbyExposedOresStep(bot, currentCount, maxCount) {
  if (currentCount >= maxCount) return currentCount;

  const oreBlock = bot.findBlock({
    matching: (block) => {
      if (!VALUABLE_ORES.has(block.name)) return false;
      if (GLOBAL_BAD_BLOCKS.has(getPosKey(block.position))) return false;
      const harvestCheck = canHarvestBlock(bot, block);
      if (!harvestCheck.canHarvest) return false;
      return isBlockExposedToAir(bot, block);
    },
    maxDistance: 8
  });

  if (!oreBlock) return currentCount;

  console.log(`[MINEUR OPPORTUNISTE] Découverte de '${oreBlock.name}' exposé à l'air ! Récolte immédiate...`);
  const singleResult = await mineSingleTarget(bot, oreBlock.name);
  if (!singleResult.success) return currentCount;

  return harvestNearbyExposedOresStep(bot, currentCount + 1, maxCount);
}

/**
 * Recherche et récolte de manière opportuniste les minerais précieux exposés à l'air autour du bot
 * @param {object} bot Instance Mineflayer du bot
 * @param {number} maxCount Nombre maximal de minerais opportunistes à récolter par passe
 * @returns {Promise<number>} Nombre de minerais récoltés
 */
async function harvestNearbyExposedOres(bot, maxCount = 2) {
  return harvestNearbyExposedOresStep(bot, 0, maxCount);
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

  let opportunisticMessage = '';
  if (state.isSurviving && targetName !== 'dirt') {
    const extraOresCount = await harvestNearbyExposedOres(bot, 2);
    if (extraOresCount > 0) {
      opportunisticMessage = ` + ${extraOresCount} minerai(s) opportuniste(s) exposé(s)`;
    }
  }

  return {
    success: true,
    message: `${successfullyMined} bloc(s) récolté(s) pour '${targetName}'${opportunisticMessage}. Inventaire : ${getInventorySummary(bot)}`
  };
}

module.exports = { skillMine, harvestNearbyExposedOres };
