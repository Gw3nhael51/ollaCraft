const KNOWN_FOODS = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'bread', 'apple',
  'golden_apple', 'baked_potato', 'carrot', 'melon_slice', 'sweet_berries'
]);

/**
 * Check whether an item is edible food
 * @param {object} bot Mineflayer bot instance
 * @param {object} item Inventory item object
 * @returns {boolean} True if the item can be consumed
 */
function isEdible(bot, item) {
  if (!item) return false;
  return Boolean(bot.registry.foodsByName?.[item.name]) || KNOWN_FOODS.has(item.name);
}

/**
 * Consume edible food item from the bot's inventory
 * @param {object} bot Mineflayer bot instance
 * @param {string} targetName Name of the food item to consume
 * @returns {Promise<{ success: boolean, message: string }>} Result of the eating action
 */
async function skillEat(bot, targetName) {
  let foodItem = targetName && targetName !== 'food'
    ? bot.inventory.items().find(item => item.name === targetName)
    : null;

  if (!foodItem) {
    foodItem = bot.inventory.items().find(item => isEdible(bot, item));
  }

  if (!foodItem) {
    return { success: false, message: "No consumable food found in inventory." };
  }

  try {
    await bot.equip(foodItem, 'hand');
    await bot.consume();
    return { success: true, message: `Ate '${foodItem.name}'.` };
  } catch (error) {
    console.warn("Food consumption error :", error.message);
    return { success: false, message: `Failed to eat '${foodItem.name}' : ${error.message}` };
  }
}

module.exports = { skillEat };
