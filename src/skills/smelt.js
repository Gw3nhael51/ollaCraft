const { goals } = require('mineflayer-pathfinder');

// Fonction pour gérer la fonte (smelting) d'objets dans un four
async function skillSmelt(bot, state, targetName, qty) {
  if (!targetName) {
    return { success: false, message: "Précise l'objet à fondre dans 'target'." };
  }

  // Cherche un four à proximité ou utilise celui mémorisé dans la base
  let furnaceBlock = bot.findBlock({
    matching: bot.registry.blocksByName.furnace.id,
    maxDistance: 32
  });

  if (!furnaceBlock) {
    if (state.base.furnace) {
      furnaceBlock = bot.blockAt(state.base.furnace);
      if (furnaceBlock && furnaceBlock.name !== 'furnace') {
        furnaceBlock = null;
        state.base.furnace = null;
      }
    }
  }

  if (!furnaceBlock) {
    return { success: false, message: "Aucun four ('furnace') trouvé à proximité ou mémorisé. Pose-en un d'abord." };
  }

  // Vérifie si l'objet cible est présent dans l'inventaire
  const targetItem = bot.inventory.items().find(i => i.name === targetName);
  if (!targetItem) {
    return { success: false, message: `Tu n'as pas de '${targetName}' pour fondre.` };
  }

  // Cherche un combustible valide (charbon, bûches ou planches)
  const fuelItem = bot.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks') || i.name === 'coal' || i.name === 'charcoal');
  if (!fuelItem) {
    return { success: false, message: "Tu n'as pas de carburant ('coal', 'log', 'planks') pour le four." };
  }

  try {
    // Se déplace vers le four s'il est trop éloigné
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
      bot.pathfinder.setGoal(new goals.GoalGetToBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z));
      await new Promise(resolve => bot.once('goal_reached', resolve));
    }

    // Ouvre l'interface du four
    const furnace = await bot.openFurnace(furnaceBlock);
    
    // Ajoute le combustible s'il n'y en a pas
    if (furnace.fuelItem() == null) {
      await furnace.putFuel(fuelItem.type, null, 1);
    }
    
    // Insère l'objet à fondre
    await furnace.putInput(targetItem.type, null, qty || 1);
    
    // Attend la fin de la cuisson (la présence d'un objet en sortie)
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
