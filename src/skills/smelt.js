const { goals } = require('mineflayer-pathfinder');

/**
 * Fait fondre un minerai ou aliment dans un four avec du combustible
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state État global du bot
 * @param {string} targetName Nom de l'objet à faire fondre
 * @param {number} qty Quantité à fondre
 * @returns {Promise<{ success: boolean, message: string }>} Résultat de la cuisson
 */
async function skillSmelt(bot, state, targetName, qty) {
  if (!targetName) {
    return { success: false, message: "Précise l'objet à fondre dans 'target'." };
  }

  let furnaceBlock = bot.findBlock({
    matching: bot.registry.blocksByName.furnace.id,
    maxDistance: 32
  });

  if (!furnaceBlock && state.base.furnace) {
    furnaceBlock = bot.blockAt(state.base.furnace);
    if (furnaceBlock && furnaceBlock.name !== 'furnace') {
      furnaceBlock = null;
      state.base.furnace = null;
    }
  }

  if (!furnaceBlock) {
    return { success: false, message: "Aucun four ('furnace') trouvé à proximité ou mémorisé. Pose-en un d'abord." };
  }

  const targetItem = bot.inventory.items().find(i => i.name === targetName);
  if (!targetItem) {
    return { success: false, message: `Tu n'as pas de '${targetName}' pour fondre.` };
  }

  const fuelItem = bot.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks') || i.name === 'coal' || i.name === 'charcoal');
  if (!fuelItem) {
    return { success: false, message: "Tu n'as pas de carburant ('coal', 'log', 'planks') pour le four." };
  }

  try {
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
      bot.pathfinder.setGoal(new goals.GoalGetToBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z));
      await new Promise(resolve => bot.once('goal_reached', resolve));
    }

    const furnace = await bot.openFurnace(furnaceBlock);

    if (furnace.fuelItem() == null) {
      await furnace.putFuel(fuelItem.type, null, 1);
    }

    await furnace.putInput(targetItem.type, null, qty || 1);

    await new Promise(resolve => {
      furnace.on('update', () => {
        if (furnace.outputItem()) {
          resolve();
        }
      });
    });

    await furnace.takeOutput();
    furnace.close();

    return { success: true, message: `'${targetName}' fondu avec succès.` };
  } catch (error) {
    console.warn("Erreur de fonte :", error.message);
    return { success: false, message: `Échec de la fonte : ${error.message}` };
  }
}

module.exports = { skillSmelt };
