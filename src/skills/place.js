const { Vec3 } = require('vec3');
const config = require('../config');

/**
 * Pose un bloc de l'inventaire au sol sur une surface dégagée
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state État global du bot
 * @param {string} targetName Nom du bloc à placer
 * @returns {Promise<{ success: boolean, message: string }>} Résultat du placement
 */
async function skillPlace(bot, state, targetName) {
  const item = bot.inventory.items().find(i => i.name === targetName);
  if (!item) return { success: false, message: `Tu ne possèdes pas de '${targetName}' dans ton inventaire.` };

  const refBlock = bot.findBlock({
    matching: (block) => {
      if (!config.VALID_GROUND_BLOCKS.has(block.name)) return false;
      if (!block?.position) return true;
      const above = bot.blockAt(block.position.offset(0, 1, 0));
      const botPos = bot.entity.position.floored();
      const placePos = block.position.offset(0, 1, 0);
      const collides = botPos.equals(placePos) || botPos.offset(0, 1, 0).equals(placePos);
      const isAir = above?.name === 'air' || above?.name === 'cave_air' || above?.name === 'void_air';
      return isAir && !collides;
    },
    maxDistance: 3
  });

  if (!refBlock) return { success: false, message: "Aucun sol dégagé avec de l'air au-dessus pour poser ce bloc." };

  try {
    await bot.equip(item, 'hand');
    await bot.lookAt(refBlock.position.offset(0.5, 1, 0.5));
    await bot.placeBlock(refBlock, new Vec3(0, 1, 0));

    if (targetName === 'crafting_table' && !state.base.crafting_table) {
      state.base.crafting_table = refBlock.position.offset(0, 1, 0).clone();
    }
    if (targetName === 'furnace' && !state.base.furnace) {
      state.base.furnace = refBlock.position.offset(0, 1, 0).clone();
    }
    if (targetName === 'chest' && !state.base.chest) {
      state.base.chest = refBlock.position.offset(0, 1, 0).clone();
    }

    return { success: true, message: `'${targetName}' posé au sol avec succès.` };
  } catch (error) {
    console.warn("Erreur de placement :", error.message);
    return { success: false, message: `Échec du placement : ${error.message}` };
  }
}

module.exports = { skillPlace };
