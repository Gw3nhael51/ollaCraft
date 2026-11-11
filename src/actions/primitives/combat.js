/**
 * Attack target entity with currently held weapon
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target living entity
 */
function attackTarget(bot, targetEntity) {
  // Attaquer : Frapper l'entité ciblée
  if (!targetEntity) return;
  bot.attack(targetEntity);
}

/**
 * Orient bot gaze directly towards target entity
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target living entity
 * @returns {Promise<void>}
 */
async function faceTarget(bot, targetEntity) {
  // Regarder : Aligner le regard sur l'entité
  if (!targetEntity || !targetEntity.position) return;
  await bot.lookAt(targetEntity.position.offset(0, targetEntity.height ? targetEntity.height * 0.8 : 1, 0));
}

module.exports = {
  attackTarget,
  faceTarget
};
