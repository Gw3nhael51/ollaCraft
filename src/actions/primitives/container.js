/**
 * Open container block at specified position
 * @param {object} bot Mineflayer bot instance
 * @param {object} containerBlock Target block (chest, furnace, etc.)
 * @returns {Promise<object|null>} Open window instance or null
 */
async function openContainer(bot, containerBlock) {
  // Ouvrir : Accéder à l'interface du conteneur
  if (!containerBlock) return null;
  try {
    return await bot.openContainer(containerBlock);
  } catch {
    return null;
  }
}

/**
 * Deposit item from player inventory into open container
 * @param {object} containerWindow Open container window instance
 * @param {number} itemType Item type identifier
 * @param {number|null} metadata Item metadata
 * @param {number} count Number of items to deposit
 * @returns {Promise<boolean>} True if deposit succeeded
 */
async function depositItem(containerWindow, itemType, metadata, count) {
  // Déposer : Transférer les objets vers le conteneur
  try {
    await containerWindow.deposit(itemType, metadata, count);
    return true;
  } catch {
    return false;
  }
}

/**
 * Close currently open container window
 * @param {object} containerWindow Open window instance
 */
function closeContainer(containerWindow) {
  // Fermer : Quitter l'interface du conteneur
  if (!containerWindow) return;
  try {
    containerWindow.close();
  } catch {
    // Ignorer : Erreur si la fenêtre est déjà fermée
  }
}

module.exports = {
  openContainer,
  depositItem,
  closeContainer
};
