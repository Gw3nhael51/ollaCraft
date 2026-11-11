const { Vec3 } = require('vec3');

/**
 * Break block at given world position
 * @param {object} bot Mineflayer bot instance
 * @param {{ x: number, y: number, z: number }} position Block coordinates
 * @returns {Promise<boolean>} True if block successfully broken
 */
async function breakBlockAt(bot, position) {
  // Casser : Détruire le bloc aux coordonnées indiquées
  const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!block || block.name === 'air') return false;
  try {
    await bot.dig(block);
    return true;
  } catch {
    return false;
  }
}

/**
 * Place item from inventory against a reference block face
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Name of item to place
 * @param {{ x: number, y: number, z: number }} referencePosition Reference block coordinates
 * @param {{ x: number, y: number, z: number }} faceVector Normal face vector
 * @returns {Promise<boolean>} True if block placed successfully
 */
async function placeBlockOnFace(bot, itemName, referencePosition, faceVector) {
  // Poser : Poser un bloc contre une face de référence
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) return false;

  const refBlock = bot.blockAt(new Vec3(referencePosition.x, referencePosition.y, referencePosition.z));
  if (!refBlock) return false;

  try {
    await bot.equip(item, 'hand');
    await bot.placeBlock(refBlock, new Vec3(faceVector.x, faceVector.y, faceVector.z));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  breakBlockAt,
  placeBlockOnFace
};
