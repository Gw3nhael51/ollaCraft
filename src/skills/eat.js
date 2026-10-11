/**
 * Consomme un aliment présent dans l'inventaire du bot
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} targetName Nom de la nourriture à consommer
 * @returns {Promise<{ success: boolean, message: string }>} Résultat de l'action
 */
async function skillEat(bot, targetName) {
  if (!targetName) {
    return { success: false, message: "Précise la nourriture à manger dans 'target'." };
  }

  const foodItem = bot.inventory.items().find(item => item.name === targetName);
  if (!foodItem) {
    return { success: false, message: `Tu ne possèdes pas de '${targetName}' dans ton inventaire.` };
  }

  try {
    await bot.equip(foodItem, 'hand');
    await bot.consume();
    return { success: true, message: `Tu as mangé '${targetName}'.` };
  } catch (error) {
    console.warn("Erreur de consommation :", error.message);
    return { success: false, message: `Impossible de manger '${targetName}' : ${error.message}` };
  }
}

module.exports = { skillEat };
