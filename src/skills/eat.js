// Fonction pour consommer de la nourriture depuis l'inventaire
async function skillEat(bot, targetName) {
  if (!targetName) {
    return { success: false, message: "Précise la nourriture à manger dans 'target'." };
  }

  // Recherche la nourriture ciblée dans l'inventaire du bot
  const item = bot.inventory.items().find(i => i.name === targetName);
  if (!item) {
    return { success: false, message: `Tu ne possèdes pas de '${targetName}' dans ton inventaire.` };
  }

  try {
    // Equipe la nourriture dans la main principale et la consomme
    await bot.equip(item, 'hand');
    await bot.consume();
    return { success: true, message: `Tu as mangé '${targetName}'.` };
  } catch (error) {
    console.warn("Erreur de consommation :", error.message);
    return { success: false, message: `Impossible de manger '${targetName}' : ${error.message}` };
  }
}

module.exports = { skillEat };
