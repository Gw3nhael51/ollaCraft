/**
 * Equip specified item to target inventory slot
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Item name to equip
 * @param {string} [destination='hand'] Destination slot ('hand', 'head', 'torso', 'legs', 'feet', 'off-hand')
 * @returns {Promise<boolean>} True if item equipped successfully
 */
async function equipItem(bot, itemName, destination = 'hand') {
  // Équiper : Placer l'objet dans l'emplacement ciblé
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) return false;
  try {
    await bot.equip(item, destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume currently held food item
 * @param {object} bot Mineflayer bot instance
 * @param {string} foodName Food item name
 * @returns {Promise<boolean>} True if food consumed
 */
async function consumeItem(bot, foodName) {
  // Consommer : Manger la nourriture en main
  const item = bot.inventory.items().find(i => i.name === foodName);
  if (!item) return false;
  try {
    await bot.equip(item, 'hand');
    await bot.consume();
    return true;
  } catch {
    return false;
  }
}

/**
 * Craft recipe using crafting table block or player 2x2 grid
 * @param {object} bot Mineflayer bot instance
 * @param {object} recipe Recipe instance from registry
 * @param {number} count Number of crafting operations
 * @param {object|null} [tableBlock=null] Placed crafting table block if 3x3
 * @returns {Promise<boolean>} True if craft succeeded
 */
async function craftRecipe(bot, recipe, count = 1, tableBlock = null) {
  // Fabriquer : Réaliser la recette de craft demandée
  try {
    await bot.craft(recipe, count, tableBlock);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  equipItem,
  consumeItem,
  craftRecipe
};
