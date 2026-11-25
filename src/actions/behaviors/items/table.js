const { countItem, getBestToolForBlock, findNearbyCraftingTable } = require('../../../perception/inventory');
const { placeItemNearby, approachPosition, digWithTimeout, pickUpDroppedItem } = require('../blocks/placement');
const { freeInventorySlotIfFull } = require('./storage');
const { noteRefusedPlacement } = require('../../../core/progress');

/**
 * Deploy the carried crafting table next to the bot, trying several spots before giving up
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, block: object|null, refused: boolean, message: string }>} Deployment result with the placed block
 */
async function deployCraftingTable(bot, state) {
  const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (!tableItem) {
    return { success: false, block: null, refused: false, message: "No 'crafting_table' in inventory." };
  }

  const placement = await placeItemNearby(bot, tableItem, { maxAttempts: 3 });
  if (!placement.success) {
    if (placement.refused) {
      // Typically the protected area around the world spawn: remember it so the bot leaves before building
      noteRefusedPlacement(bot, state);
      return {
        success: false,
        block: null,
        refused: true,
        message: `The server refused to place the crafting table here (protected area near spawn, or something standing in the way): ${placement.error}`
      };
    }
    return { success: false, block: null, refused: false, message: `No spot to deploy the crafting table here (${placement.error}).` };
  }

  if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(2);
  const placedBlock = bot.blockAt(placement.position);
  if (placedBlock?.name !== 'crafting_table') {
    return { success: false, block: null, refused: true, message: 'Crafting table placement was not confirmed by the server.' };
  }

  if (state) state.deployedTable = placement.position;
  console.log(`[TABLE] Portable crafting table deployed at (${placement.position.x}, ${placement.position.y}, ${placement.position.z}).`);
  return {
    success: true,
    block: placedBlock.position ? placedBlock : { ...placedBlock, position: placement.position },
    refused: false,
    message: 'Crafting table deployed.'
  };
}

/**
 * Break the crafting table the bot just used and pick it back up so it is never left behind
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {object|null} [tableBlock=null] Table block to collect (defaults to the deployed or nearest table)
 * @returns {Promise<{ success: boolean, collected: boolean, message: string }>} Collection result
 */
async function collectCraftingTable(bot, state, tableBlock = null) {
  const block = tableBlock || findNearbyCraftingTable(bot, state);
  if (!block?.position) {
    if (state) state.deployedTable = null;
    return { success: true, collected: false, message: 'No crafting table to collect.' };
  }

  const countBefore = countItem(bot, 'crafting_table');
  try {
    await freeInventorySlotIfFull(bot, 1);
    const reachable = await approachPosition(bot, block.position, 3.5, 8000);
    if (!reachable) {
      return { success: false, collected: false, message: 'Crafting table out of reach; abandoned it.' };
    }

    const liveBlock = bot.blockAt(block.position) || block;
    if (liveBlock.name !== 'crafting_table') {
      return { success: true, collected: false, message: 'Crafting table already gone.' };
    }

    const tool = getBestToolForBlock(bot, liveBlock);
    if (tool) await bot.equip(tool, 'hand').catch(() => {});
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
    await digWithTimeout(bot, liveBlock, 9000);
    await pickUpDroppedItem(bot, () => countItem(bot, 'crafting_table') > countBefore, 'crafting_table', block.position);
  } catch (error) {
    console.warn('[TABLE] Failed to collect crafting table :', error.message);
  } finally {
    // Whatever happened the table is no longer tracked: a missing one is simply re-crafted when needed
    if (state) state.deployedTable = null;
  }

  const collected = countItem(bot, 'crafting_table') > countBefore;
  if (collected) console.log('[TABLE] Portable crafting table collected back into inventory.');
  return {
    success: collected,
    collected,
    message: collected ? 'Crafting table collected back into inventory.' : 'Crafting table broken but not recovered.'
  };
}

/**
 * Collect the deployed crafting table before the bot walks away to do something else
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<boolean>} True if a table was collected
 */
async function collectDeployedTableIfAny(bot, state) {
  if (!state?.deployedTable) return false;
  try {
    const tableBlock = findNearbyCraftingTable(bot, state);
    if (!tableBlock) return false;
    const result = await collectCraftingTable(bot, state, tableBlock);
    return result.collected;
  } catch (error) {
    console.warn('[TABLE] Deferred table collection failed :', error.message);
    state.deployedTable = null;
    return false;
  }
}

module.exports = { deployCraftingTable, collectCraftingTable, collectDeployedTableIfAny };
