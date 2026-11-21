const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../../../infrastructure/config');

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/**
 * Check whether a block is empty air that another block can replace
 * @param {object|null} block Candidate block
 * @returns {boolean} True if the position is free
 */
function isAirBlock(block) {
  return !block || AIR_NAMES.has(block.name);
}

/**
 * Check whether a block can support another block placed on top of it
 * @param {object|null} block Candidate ground block
 * @returns {boolean} True if the block is solid ground
 */
function isSolidGround(block) {
  if (!block?.name) return false;
  return config.VALID_GROUND_BLOCKS.has(block.name) || block.boundingBox === 'block';
}

/**
 * Find a nearby solid ground block with free air above that the bot is not standing in
 * @param {object} bot Mineflayer bot instance
 * @param {object} [options={}] Search options
 * @param {number} [options.maxDistance=4] Maximum search distance
 * @param {(groundBlock: object) => boolean} [options.accept] Extra predicate on the candidate ground block
 * @returns {object|null} Ground block to place onto or null
 */
function findGroundPlacement(bot, options = {}) {
  const maxDistance = options.maxDistance || 4;
  return bot.findBlock({
    matching: (block) => {
      if (!isSolidGround(block)) return false;
      if (!block?.position) return true;
      const placePos = block.position.offset(0, 1, 0);
      const botPos = bot.entity.position.floored();
      const collides = botPos.equals(placePos) || botPos.offset(0, 1, 0).equals(placePos);
      if (collides || !isAirBlock(bot.blockAt(placePos))) return false;
      return typeof options.accept === 'function' ? options.accept(block) : true;
    },
    maxDistance
  });
}

/**
 * Place an inventory item on top of a ground block
 * @param {object} bot Mineflayer bot instance
 * @param {object} item Inventory item to place
 * @param {object} groundBlock Ground block returned by findGroundPlacement
 * @returns {Promise<object>} Position where the block was placed
 */
async function placeOnGround(bot, item, groundBlock) {
  await bot.equip(item, 'hand');
  await bot.lookAt(groundBlock.position.offset(0.5, 1, 0.5));
  await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
  const placedPos = groundBlock.position.offset(0, 1, 0);
  return placedPos.clone ? placedPos.clone() : placedPos;
}

/**
 * Walk within reach of a position under a bounded timeout, never throwing
 * @param {object} bot Mineflayer bot instance
 * @param {object} pos Target position
 * @param {number} [reach=3.5] Distance considered close enough
 * @param {number} [timeoutMs=8000] Maximum navigation time
 * @returns {Promise<boolean>} True if the bot ends within reach
 */
async function approachPosition(bot, pos, reach = 3.5, timeoutMs = 8000) {
  const distanceTo = () => (bot.entity?.position?.distanceTo ? bot.entity.position.distanceTo(pos) : 0);
  if (distanceTo() <= reach || typeof bot.pathfinder?.goto !== 'function') return distanceTo() <= reach + 1;

  let navTimer = null;
  try {
    const gotoPromise = bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, Math.max(1, Math.floor(reach) - 1)));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error('Approach timeout')), timeoutMs);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } catch {
    // The caller decides from the final distance whether the approach was good enough
  } finally {
    if (navTimer) clearTimeout(navTimer);
    bot.pathfinder.setGoal?.(null);
    bot.clearControlStates?.();
  }
  return distanceTo() <= reach + 1;
}

/**
 * Dig a block under a bounded timeout
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Block to dig
 * @param {number} [timeoutMs=9000] Maximum dig duration
 * @returns {Promise<void>}
 */
async function digWithTimeout(bot, block, timeoutMs = 9000) {
  let timer = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        bot.stopDigging?.();
        reject(new Error('Dig timeout'));
      }, timeoutMs);
    });
    await Promise.race([bot.dig(block), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Walk onto a dropped item until it lands in the inventory
 * @param {object} bot Mineflayer bot instance
 * @param {() => boolean} isCollected Predicate telling whether the item reached the inventory
 * @param {string} itemName Dropped item name to look for
 * @param {object} dropPos Position where the item was dropped
 * @param {number} [attemptsLeft=4] Remaining pickup attempts
 * @returns {Promise<boolean>} True if the item was collected
 */
async function pickUpDroppedItem(bot, isCollected, itemName, dropPos, attemptsLeft = 4) {
  if (isCollected()) return true;
  if (attemptsLeft <= 0) return false;

  const dropEntity = typeof bot.nearestEntity === 'function'
    ? bot.nearestEntity(e => e.name === 'item' && e.getDroppedItem?.()?.name === itemName && e.position.distanceTo(dropPos) < 6)
    : null;
  const target = dropEntity?.position || dropPos;

  let navTimer = null;
  try {
    if (typeof bot.pathfinder?.goto === 'function') {
      const gotoPromise = bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 0));
      const timeoutPromise = new Promise((_, reject) => {
        navTimer = setTimeout(() => reject(new Error('Pickup timeout')), 2500);
      });
      await Promise.race([gotoPromise, timeoutPromise]);
    }
  } catch {
    // Retry below: the drop may still be settling or sliding
  } finally {
    if (navTimer) clearTimeout(navTimer);
    bot.pathfinder?.setGoal?.(null);
    bot.clearControlStates?.();
  }

  if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(6);
  return pickUpDroppedItem(bot, isCollected, itemName, dropPos, attemptsLeft - 1);
}

module.exports = {
  isAirBlock,
  isSolidGround,
  findGroundPlacement,
  placeOnGround,
  approachPosition,
  digWithTimeout,
  pickUpDroppedItem
};
