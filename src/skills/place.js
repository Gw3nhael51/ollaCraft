const { Vec3 } = require('vec3');
const config = require('../config');

async function skillPlace(bot, targetName) {
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
      return above?.name === 'air' && !collides;
    },
    maxDistance: 3
  });

  if (!refBlock) return { success: false, message: "Aucun sol dégagé avec de l'air au-dessus pour poser ce bloc." };

  try {
    await bot.equip(item, 'hand');
    await bot.lookAt(refBlock.position.offset(0.5, 1, 0.5));
    await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
    return { success: true, message: `'${targetName}' posé au sol avec succès.` };
  } catch (error) {
    console.warn("Erreur de placement :", error.message);
    return { success: false, message: `Échec du placement : \${error.message}` };
  }
}

module.exports = { skillPlace };
