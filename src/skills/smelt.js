const { goals } = require('mineflayer-pathfinder');

/**
 * Locate an accessible furnace block nearby or from base memory
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {object|null} Located furnace block or null
 */
function findTargetFurnace(bot, state) {
  const nearby = bot.findBlock({
    matching: bot.registry.blocksByName.furnace.id,
    maxDistance: 32
  });
  if (nearby || !state.base.furnace) return nearby;

  const rememberedFurnace = bot.blockAt(state.base.furnace);
  if (!rememberedFurnace) return null;

  if (rememberedFurnace.name !== 'furnace') {
    state.base.furnace = null;
    return null;
  }

  const dist = bot.entity.position.distanceTo(rememberedFurnace.position);
  return dist <= 24 ? rememberedFurnace : null;
}

/**
 * Wait until the furnace produces at least one output item or times out
 * @param {object} furnace Open Mineflayer furnace instance
 * @returns {Promise<void>}
 */
function waitForFurnaceOutput(furnace) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      furnace.removeListener('update', onUpdate);
      reject(new Error("Smelting time limit exceeded"));
    }, 25000);

    function onUpdate() {
      if (furnace.outputItem()) {
        clearTimeout(timer);
        furnace.removeListener('update', onUpdate);
        resolve();
      }
    }

    furnace.on('update', onUpdate);
  });
}

/**
 * Smelt an ore or cook food in a furnace using available fuel
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Name of the item to smelt
 * @param {number} qty Quantity to smelt
 * @returns {Promise<{ success: boolean, message: string }>} Result of smelting operation
 */
async function skillSmelt(bot, state, targetName, qty) {
  if (!targetName) {
    return { success: false, message: "Specify the item to smelt in 'target'." };
  }

  const furnaceBlock = findTargetFurnace(bot, state);
  if (!furnaceBlock) {
    const hasInPocket = bot.inventory.items().some(i => i.name === 'furnace');
    return {
      success: false,
      message: hasInPocket
        ? "No furnace placed nearby. Use 'place' with target 'furnace' to set down the furnace from your inventory."
        : "No furnace found nearby. Craft one ('craft furnace') and place it down ('place furnace') first."
    };
  }

  const targetItem = bot.inventory.items().find(i => i.name === targetName);
  if (!targetItem) {
    return { success: false, message: `You have no '${targetName}' to smelt.` };
  }

  const fuelItem = bot.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks') || i.name === 'coal' || i.name === 'charcoal');
  if (!fuelItem) {
    return { success: false, message: "You have no fuel ('coal', 'log', 'planks') for the furnace." };
  }

  let furnace = null;
  try {
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
      const gotoPromise = bot.pathfinder.goto(new goals.GoalGetToBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z));
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Navigation timeout towards furnace")), 15000));
      await Promise.race([gotoPromise, timeoutPromise]);
    }

    furnace = await bot.openFurnace(furnaceBlock);
    if (furnace.fuelItem() == null) {
      await furnace.putFuel(fuelItem.type, null, 1);
    }

    await furnace.putInput(targetItem.type, null, qty || 1);
    await waitForFurnaceOutput(furnace);
    await furnace.takeOutput();

    return { success: true, message: `Successfully smelted '${targetName}'.` };
  } catch (error) {
    console.warn("Smelting error :", error.message);
    return { success: false, message: `Smelting failed : ${error.message}` };
  } finally {
    if (furnace) furnace.close();
  }
}

module.exports = { skillSmelt };
