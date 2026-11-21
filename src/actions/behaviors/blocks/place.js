const { fillBucketFromSource } = require('../world/portal');
const { findGroundPlacement, placeOnGround } = require('./placement');

const WATER_SCOOP_TARGETS = new Set(['water', 'water_source', 'water_bucket']);

/**
 * Place an inventory block onto an unobstructed surface on the ground
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Name of the block item to place
 * @returns {Promise<{ success: boolean, message: string }>} Result of the placement action
 */
async function skillPlace(bot, state, targetName) {
  const cleanTarget = typeof targetName === 'string' ? targetName.toLowerCase().trim() : '';
  if (WATER_SCOOP_TARGETS.has(cleanTarget) || (cleanTarget === 'bucket' && state?.currentObjective === 'water_bucket')) {
    return fillBucketFromSource(bot, 'water');
  }

  const item = bot.inventory.items().find(i => i.name === targetName);
  if (!item) return { success: false, message: `You do not have '${targetName}' in your inventory.` };

  const refBlock = findGroundPlacement(bot, { maxDistance: 4 });
  if (!refBlock) return { success: false, message: "No clear ground with air above to place this block." };

  try {
    const placedPos = await placeOnGround(bot, item, refBlock);

    if (targetName === 'crafting_table') {
      // Track the table as deployed so it is broken and collected as soon as the bot leaves it
      state.deployedTable = placedPos;
      return {
        success: true,
        message: "'crafting_table' deployed. It is portable: it will be collected automatically when you move on, so craft what you need now."
      };
    }
    if (targetName === 'furnace') {
      state.base.furnace = placedPos;
    }
    if (targetName === 'chest') {
      state.base.chest = placedPos;
    }

    return { success: true, message: `'${targetName}' placed on the ground successfully.` };
  } catch (error) {
    console.warn("Placement error :", error.message);
    return { success: false, message: `Failed to place block : ${error.message}` };
  }
}

module.exports = { skillPlace };
