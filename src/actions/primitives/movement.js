const { goals } = require('mineflayer-pathfinder');

/**
 * Navigate bot to exact world coordinates
 * @param {object} bot Mineflayer bot instance
 * @param {number} x Target X coordinate
 * @param {number} y Target Y coordinate
 * @param {number} z Target Z coordinate
 * @param {number} [range=1] Stopping distance range
 * @returns {Promise<boolean>} True if destination reached
 */
async function gotoCoordinates(bot, x, y, z, range = 1) {
  // Déplacer : Guider le bot vers les coordonnées cibles
  try {
    const goal = new goals.GoalNear(x, y, z, range);
    await bot.pathfinder.goto(goal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a single jump control action
 * @param {object} bot Mineflayer bot instance
 */
function jump(bot) {
  // Déclencher : Sauter physiquement
  bot.setControlState('jump', true);
  setTimeout(() => {
    bot.setControlState('jump', false);
  }, 350);
}

/**
 * Look towards target world coordinate position
 * @param {object} bot Mineflayer bot instance
 * @param {{ x: number, y: number, z: number }} targetPos Position vector
 * @returns {Promise<void>}
 */
async function lookAtPosition(bot, targetPos) {
  // Orienter : Tourner le regard vers la position
  await bot.lookAt(targetPos);
}

/**
 * Clear all ongoing movement control states
 * @param {object} bot Mineflayer bot instance
 */
function clearMovementControls(bot) {
  // Réinitialiser : Arrêter tous les contrôles de déplacement
  bot.clearControlStates();
}

module.exports = {
  gotoCoordinates,
  jump,
  lookAtPosition,
  clearMovementControls
};
