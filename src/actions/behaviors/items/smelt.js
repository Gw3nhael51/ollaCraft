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
  return dist <= 32 ? rememberedFurnace : null;
}

/**
 * Return how many items a single unit of the given fuel can smelt
 * @param {string} fuelName Fuel item name
 * @returns {number} Smelted items per fuel unit
 */
function getFuelSmeltCapacity(fuelName) {
  if (fuelName === 'coal' || fuelName === 'charcoal') return 8;
  if (fuelName.includes('log') || fuelName.includes('planks')) return 1.5;
  return 1;
}

/**
 * Compute optimal input quantity, required fuel quantity, and dynamic timeout for smelting
 * @param {number} requestedQty Quantity requested by AI decision
 * @param {number} availableInputCount Available raw items in inventory
 * @param {{ name: string, count: number }} fuelItem Selected fuel stack in inventory
 * @returns {{ inputCount: number, fuelCount: number, timeoutMs: number }} Smelting execution plan
 */
function computeSmeltPlan(requestedQty, availableInputCount, fuelItem) {
  const normalizedQty = Math.max(1, Number.parseInt(requestedQty, 10) || 1);
  const desiredInput = Math.min(normalizedQty, availableInputCount);
  const capacityPerFuel = getFuelSmeltCapacity(fuelItem.name);
  const maxSmeltableByFuel = Math.max(1, Math.floor(fuelItem.count * capacityPerFuel));
  const inputCount = Math.min(desiredInput, maxSmeltableByFuel);
  const fuelCount = Math.min(fuelItem.count, Math.ceil(inputCount / capacityPerFuel));
  const timeoutMs = inputCount * 12000 + 5000;

  return { inputCount, fuelCount, timeoutMs };
}

/**
 * Wait until the furnace finishes smelting the expected output quantity or times out
 * @param {object} furnace Open Mineflayer furnace instance
 * @param {number} [expectedCount] Target number of smelted output items
 * @param {number} [timeoutMs] Maximum wait duration in milliseconds
 * @returns {Promise<void>}
 */
function waitForFurnaceOutput(furnace, expectedCount = 1, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const isComplete = () => {
      const outputCount = furnace.outputItem()?.count || 0;
      return outputCount >= expectedCount || (!furnace.inputItem() && outputCount > 0);
    };

    if (isComplete()) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      furnace.removeListener('update', onUpdate);
      reject(new Error("Smelting time limit exceeded"));
    }, timeoutMs);

    function onUpdate() {
      if (isComplete()) {
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
  let navTimer = null;

  try {
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
      const gotoPromise = bot.pathfinder.goto(new goals.GoalGetToBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z));
      const timeoutPromise = new Promise((_, reject) => {
        navTimer = setTimeout(() => reject(new Error("Navigation timeout towards furnace")), 15000);
      });
      await Promise.race([gotoPromise, timeoutPromise]);
    }

    furnace = await bot.openFurnace(furnaceBlock);

    const { inputCount, fuelCount, timeoutMs } = computeSmeltPlan(qty, targetItem.count, fuelItem);
    const existingFuelCount = furnace.fuelItem()?.count || 0;
    const neededFuel = Math.max(0, fuelCount - existingFuelCount);

    if (neededFuel > 0) {
      await furnace.putFuel(fuelItem.type, null, neededFuel);
    }

    await furnace.putInput(targetItem.type, null, inputCount);
    await waitForFurnaceOutput(furnace, inputCount, timeoutMs);
    
    const smeltedOutput = await furnace.takeOutput();
    const smeltedCount = smeltedOutput?.count || inputCount;

    return { success: true, message: `Successfully smelted ${smeltedCount}x '${targetName}'.` };
  } catch (error) {
    console.warn("Smelting error :", error.message);
    return { success: false, message: `Smelting failed : ${error.message}` };
  } finally {
    if (navTimer) clearTimeout(navTimer);
    if (furnace) furnace.close();
  }
}

module.exports = { skillSmelt, computeSmeltPlan, waitForFurnaceOutput };
