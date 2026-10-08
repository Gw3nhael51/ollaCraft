const { goals } = require('mineflayer-pathfinder');
const { getBestToolForBlock, countItem, hasToolType, getInventorySummary } = require('../utils/inventory');

async function collectDrops(bot, position) {
  await bot.waitForTicks(10);
  const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(position) < 6);
  if (!drop) return;

  try {
    const { GoalNear } = goals;
    const target = drop.position.floored();
    await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 1));
  } catch (error) {
    console.warn("Ramassage impossible :", error.message);
  }
  await bot.waitForTicks(5);
}

async function mineSingleTarget(bot, targetName, badBlocks) {
  const matchesTarget = (blockName) => {
    if (targetName === 'cobblestone' || targetName === 'stone') return blockName === 'stone' || blockName === 'cobblestone';
    if (targetName.includes('log')) return blockName.includes('log');
    return blockName === targetName;
  };

  const targetBlock = bot.findBlock({
    matching: (block) => {
      if (!block?.position) return matchesTarget(block?.name);
      return matchesTarget(block.name) && !badBlocks.includes(block.position.toString());
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
    await bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 3));
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    const blockToBreak = bot.blockAt(targetBlock.position);
    await bot.lookAt(targetBlock.position.offset(0.5, 0.5, 0.5));

    const bestTool = getBestToolForBlock(bot, blockToBreak);
    if (bestTool) await bot.equip(bestTool, 'hand');

    await bot.dig(blockToBreak);
    await collectDrops(bot, targetBlock.position);

    const gained = countItem(bot, dropName) - before;
    if (gained <= 0) return { success: false, empty: false, message: `Bloc '${blockToBreak.name}' cassé mais aucun '${dropName}' récupéré.` };
    return { success: true, empty: false, message: `+\${gained} '${dropName}' récupéré(s).` };
  } catch (error) {
    console.warn("Échec physique du minage :", error.message);
    bot.clearControlStates();
    badBlocks.push(targetBlock.position.toString());
    return { success: false, empty: false, message: `Bloc inaccessible (\${error.message}).` };
  }
}

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

  if (successCount === 0) return { success: false, message: `Échec du minage de '${targetName}' : \${lastMessage}` };
  return { success: true, message: `\${successCount} bloc(s) de '${targetName}' récolté(s). Inventaire : \${getInventorySummary(bot)}` };
}

module.exports = { skillMine };
