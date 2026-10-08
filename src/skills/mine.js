const { goals } = require('mineflayer-pathfinder');
const GLOBAL_BAD_BLOCKS = new Set();
const { getBestToolForBlock, countItem, hasToolType, getInventorySummary } = require('../utils/inventory');

// Fonction pour avancer brièvement et ramasser les objets tombés au sol
async function collectDrops(bot, position) {
  // Technique agressive : on regarde le bloc cassé et on marche droit dessus pendant 0.5s
  try {
    await bot.lookAt(position.offset(0.5, 0.5, 0.5));
    bot.setControlState('forward', true);
    await bot.waitForTicks(10);
  } catch (e) {
    // Ignoré : le bot peut être interrompu ou bloqué, ce n'est qu'un mouvement de ramassage.
  } finally {
    // Toujours relâcher la touche d'avancement, même en cas de lag serveur
    bot.setControlState('forward', false);
  }
}

// Cherche, se déplace, et casse un seul bloc correspondant à la cible
async function mineSingleTarget(bot, targetName, badBlocks) {
  // Fonction interne pour vérifier la correspondance du nom du bloc
  const matchesTarget = (blockName) => {
    if (targetName === 'cobblestone' || targetName === 'stone') return blockName === 'stone' || blockName === 'cobblestone';
    if (targetName.includes('log')) return blockName.includes('log');
    return blockName === targetName;
  };

  const targetBlock = bot.findBlock({
    matching: (block) => {
      if (!block?.position) return matchesTarget(block?.name);
      return matchesTarget(block.name) && !GLOBAL_BAD_BLOCKS.has(block.position.toString());
    },
    maxDistance: 30
  });

  if (!targetBlock) return { success: false, empty: true, message: `Aucun bloc de '${targetName}' trouvé à proximité.` };

  const isStone = targetBlock.name === 'stone' || targetBlock.name === 'cobblestone';
  if (isStone && !hasToolType(bot, '_pickaxe')) {
    return { success: false, empty: false, message: "Impossible de récolter de la pierre sans pioche : fabrique d'abord une wooden_pickaxe." };
  }

  const dropName = targetBlock.name === 'stone' ? 'cobblestone' : targetBlock.name;
  const before = countItem(bot, dropName);

  try {
    const { GoalNear } = goals;
    
    // Timeout de sécurité : si le bot met plus de 15 secondes à atteindre le bloc, on annule
    console.log(`[MINE] Je me dirige vers ${targetBlock.name}...`);
    const gotoPromise = bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2));
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout de navigation")), 45000));
    await Promise.race([gotoPromise, timeoutPromise]);
    
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    const blockToBreak = bot.blockAt(targetBlock.position);
    await bot.lookAt(targetBlock.position.offset(0.5, 0.5, 0.5));

    const bestTool = getBestToolForBlock(bot, blockToBreak);
    if (bestTool) await bot.equip(bestTool, 'hand');

    console.log(`[MINE] Je creuse ${targetBlock.name}...`);
    const digPromise = bot.dig(blockToBreak);
    const digTimeout = new Promise((_, r) => setTimeout(() => r(new Error("Timeout creusage")), 10000));
    await Promise.race([digPromise, digTimeout]);
    console.log(`[MINE] C'est cassé, je ramasse...`);

    // Se rapprocher du centre du bloc détruit pour assurer le ramassage
    try {
      await bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));
    } catch (e) {
      // Ignoré : le chemin n'est peut-être plus valide après le minage
    }

    await collectDrops(bot, targetBlock.position);

    // Attente dynamique pour compenser la latence réseau (OVH) et synchro inventaire
    let gained = countItem(bot, dropName) - before;
    let attempts = 0;
    while (gained <= 0 && attempts < 10) { // Attend jusqu'à ~2 secondes supplémentaires
      await bot.waitForTicks(4); // NOSONAR : L'attente séquentielle est volontaire pour scruter l'inventaire
      gained = countItem(bot, dropName) - before;
      attempts++;
    }

    if (gained <= 0) return { success: false, empty: false, message: `Bloc '${blockToBreak.name}' cassé mais aucun '${dropName}' récupéré.` };
    return { success: true, empty: false, message: `+${gained} '${dropName}' récupéré(s).` };
  } catch (error) {
    console.warn("Échec physique du minage :", error.message);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    GLOBAL_BAD_BLOCKS.add(targetBlock.position.toString());
    return { success: false, empty: false, message: `Bloc inaccessible (${error.message}).` };
  }
}

// Fonction principale du skill mine : répète l'action de minage pour un nombre donné de fois
async function skillMine(bot, state, targetName, count) {
  let successCount = 0;
  let lastMessage = '';
  const badBlocks = [];

  async function mineNext(remaining) {
    if (remaining <= 0 || !state.isSurviving) return;

    const result = await mineSingleTarget(bot, targetName, badBlocks);
    lastMessage = result.message;
    if (result.empty) return;

    if (result.success) successCount++;
    await mineNext(remaining - 1);
  }

  await mineNext(count || 1);

  if (successCount === 0) return { success: false, message: `Échec du minage de '${targetName}' : ${lastMessage}` };
  return { success: true, message: `${successCount} bloc(s) de '${targetName}' récolté(s). Inventaire : ${getInventorySummary(bot)}` };
}

module.exports = { skillMine };
