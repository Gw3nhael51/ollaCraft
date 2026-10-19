const { Vec3 } = require('vec3');
const config = require('../config');

/**
 * Place an inventory block onto an unobstructed surface on the ground
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Name of the block item to place
 * @returns {Promise<{ success: boolean, message: string }>} Result of the placement action
 */
async function skillPlace(bot, state, targetName) {
  const item = bot.inventory.items().find(i => i.name === targetName);
  if (!item) return { success: false, message: `You do not have '${targetName}' in your inventory.` };

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

  if (!refBlock) return { success: false, message: "No clear ground with air above to place this block." };

  try {
    await bot.equip(item, 'hand');
    await bot.lookAt(refBlock.position.offset(0.5, 1, 0.5));
    await bot.placeBlock(refBlock, new Vec3(0, 1, 0));

    if (targetName === 'crafting_table') {
      state.base.crafting_table = refBlock.position.offset(0, 1, 0).clone();
    }
    if (targetName === 'furnace') {
      state.base.furnace = refBlock.position.offset(0, 1, 0).clone();
    }
    if (targetName === 'chest') {
      state.base.chest = refBlock.position.offset(0, 1, 0).clone();
    }

    return { success: true, message: `'${targetName}' placed on the ground successfully.` };
  } catch (error) {
    console.warn("Placement error :", error.message);
    return { success: false, message: `Failed to place block : ${error.message}` };
  }
}

module.exports = { skillPlace };
