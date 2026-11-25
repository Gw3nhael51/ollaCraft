const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../../../infrastructure/config');
const { markBadBlock, isBadBlock } = require('../../../perception/environment');

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
// Blocks a placed block simply replaces, exactly as when a player clicks through tall grass
const REPLACEABLE_NAMES = new Set([
  ...AIR_NAMES, 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine',
  'glow_lichen', 'crimson_roots', 'warped_roots', 'nether_sprouts', 'hanging_roots', 'seagrass', 'tall_seagrass'
]);
// Clicking these opens or toggles them instead of placing a block against them
const INTERACTIVE_KEYWORDS = [
  'crafting_table', 'furnace', 'chest', 'barrel', 'shulker', 'hopper', 'dispenser', 'dropper', 'smoker',
  'anvil', 'loom', 'grindstone', 'stonecutter', 'lectern', 'beacon', 'brewing_stand',
  '_bed', 'door', 'trapdoor', 'fence_gate', 'button', 'lever', '_sign', 'note_block', 'jukebox'
];
// Entity categories that do not block a placement (drops, arrows, experience orbs...)
const NON_BLOCKING_ENTITY_TYPES = new Set(['object', 'orb', 'projectile', 'other', 'global']);
// Half of the bot's width plus a safety margin: the server refuses any block overlapping a living entity
const BODY_HALF_WIDTH = 0.36;
const BODY_HEIGHT = 1.8;
const REACH_DISTANCE = 4.5;
const SEARCH_RADIUS = 3;
const NEIGHBOR_FACES = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
  new Vec3(0, 1, 0)
];

/**
 * Check whether a block is empty air that another block can replace
 * @param {object|null} block Candidate block
 * @returns {boolean} True if the position is free
 */
function isAirBlock(block) {
  return !block || AIR_NAMES.has(block.name);
}

/**
 * Check whether a block can be overwritten by a placed block (air, grass, ferns, snow layer...)
 * @param {object|null} block Candidate block
 * @returns {boolean} True if a block can be placed there
 */
function isReplaceableBlock(block) {
  return Boolean(block?.name && REPLACEABLE_NAMES.has(block.name));
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
 * Check whether a block can be clicked to place something against it
 * @param {object|null} block Candidate reference block
 * @returns {boolean} True for a solid block that does not open or toggle when clicked
 */
function isPlacementReference(block) {
  if (!isSolidGround(block)) return false;
  return !INTERACTIVE_KEYWORDS.some(keyword => block.name.includes(keyword));
}

/**
 * Check whether a block cell overlaps the bounding box of a standing entity
 * @param {{ x: number, y: number, z: number }} entityPos Feet position of the entity
 * @param {{ x: number, y: number, z: number }} cell Block cell (integer coordinates)
 * @param {number} [height=BODY_HEIGHT] Entity height
 * @returns {boolean} True if a block placed in the cell would collide with the entity
 */
function cellOverlapsBody(entityPos, cell, height = BODY_HEIGHT) {
  return (
    entityPos.x + BODY_HALF_WIDTH > cell.x && entityPos.x - BODY_HALF_WIDTH < cell.x + 1 &&
    entityPos.z + BODY_HALF_WIDTH > cell.z && entityPos.z - BODY_HALF_WIDTH < cell.z + 1 &&
    entityPos.y + height > cell.y && entityPos.y < cell.y + 1
  );
}

/**
 * Check whether the bot or any nearby creature stands in a block cell
 * @param {object} bot Mineflayer bot instance
 * @param {{ x: number, y: number, z: number }} cell Block cell (integer coordinates)
 * @returns {boolean} True if the server would refuse a block there
 */
function isCellObstructed(bot, cell) {
  if (cellOverlapsBody(bot.entity.position, cell)) return true;
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity === bot.entity || !entity.position || NON_BLOCKING_ENTITY_TYPES.has(entity.type)) continue;
    if (cellOverlapsBody(entity.position, cell, entity.height || BODY_HEIGHT)) return true;
  }
  return false;
}

/**
 * List the free cells around the bot where a block can be placed against a solid neighbor, best first.
 * Unlike a nearest-block search it never proposes a cell the bot overlaps, which the server refuses.
 * @param {object} bot Mineflayer bot instance
 * @param {object} [options={}] Search options
 * @param {boolean} [options.floorOnly=false] Only accept cells resting on solid ground
 * @returns {Array<{ position: Vec3, reference: object, face: Vec3 }>} Placement candidates
 */
function findPlacementSpots(bot, options = {}) {
  if (typeof bot.blockAt !== 'function' || !bot.entity?.position) return [];
  const feet = bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position;
  const eyeY = bot.entity.position.y + 1.62;
  const spots = [];

  for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
    for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz++) {
      for (const dy of [0, -1, 1, 2]) {
        const cell = new Vec3(feet.x + dx, feet.y + dy, feet.z + dz);
        const reachDistance = Math.hypot(cell.x + 0.5 - bot.entity.position.x, cell.y + 0.5 - eyeY, cell.z + 0.5 - bot.entity.position.z);
        if (reachDistance > REACH_DISTANCE || isCellObstructed(bot, cell)) continue;
        if (!isReplaceableBlock(bot.blockAt(cell))) continue;

        const faces = options.floorOnly ? NEIGHBOR_FACES.slice(0, 1) : NEIGHBOR_FACES;
        const supportFace = faces.find(face => isPlacementReference(bot.blockAt(cell.plus(face))));
        if (!supportFace) continue;

        const referencePos = cell.plus(supportFace);
        const referenceBlock = bot.blockAt(referencePos);
        const horizontal = Math.hypot(dx, dz);
        // Prefer a spot on the floor, at the bot's level, about two blocks away
        const score = Math.abs(dy) * 2 + Math.abs(horizontal - 2) + (supportFace.y === -1 ? 0 : 1.5);
        spots.push({
          position: cell,
          reference: referenceBlock.position ? referenceBlock : { ...referenceBlock, position: referencePos },
          face: new Vec3(-supportFace.x, -supportFace.y, -supportFace.z),
          score
        });
      }
    }
  }

  return spots.sort((a, b) => a.score - b.score);
}

/**
 * Find a nearby solid ground block with free space above that the bot is not standing in
 * @param {object} bot Mineflayer bot instance
 * @param {object} [options={}] Search options
 * @param {number} [options.maxDistance=4] Maximum search distance for the fallback block search
 * @returns {object|null} Ground block to place onto or null
 */
function findGroundPlacement(bot, options = {}) {
  const best = findPlacementSpots(bot, { floorOnly: true })[0];
  if (best) return best.reference;
  if (typeof bot.findBlock !== 'function') return null;

  // Fallback for partially loaded surroundings: nearest non-interactive solid block with a free, unobstructed top
  return bot.findBlock({
    matching: (block) => {
      if (!isPlacementReference(block)) return false;
      if (!block?.position) return true;
      const placePos = block.position.offset(0, 1, 0);
      if (isBadBlock(placePos)) return false;
      const above = bot.blockAt(placePos);
      return (isAirBlock(above) || isReplaceableBlock(above)) && !isCellObstructed(bot, placePos);
    },
    maxDistance: options.maxDistance || 4
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
 * Tell whether a placement error means the server answered "no" (protected area, something in the way)
 * @param {Error} error Placement error
 * @returns {boolean} True if the server refused rather than the bot failing to act
 */
function isServerRefusal(error) {
  return /refused|still |did not answer|No block has been placed/i.test(String(error?.message || ''));
}

/**
 * Place an item next to the bot, trying the next best spot when the server refuses one
 * @param {object} bot Mineflayer bot instance
 * @param {object} item Inventory item to place
 * @param {object} [options={}] Placement options
 * @param {boolean} [options.floorOnly=false] Only place on solid ground
 * @param {number} [options.maxAttempts=3] Number of different spots to try
 * @returns {Promise<{ success: boolean, position: Vec3|null, refused: boolean, error: string|null }>} Outcome
 */
async function placeItemNearby(bot, item, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const gridCandidates = findPlacementSpots(bot, { floorOnly: Boolean(options.floorOnly) })
    .filter(spot => !isBadBlock(spot.position));

  let lastError = null;
  let refused = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let spot = gridCandidates[attempt] || null;
    if (!spot && gridCandidates.length === 0) {
      // Fallback for partially loaded surroundings
      const ground = findGroundPlacement(bot, { maxDistance: 4 });
      if (ground?.position) {
        spot = { position: ground.position.offset(0, 1, 0), reference: ground, face: new Vec3(0, 1, 0) };
      }
    }
    if (!spot) break;

    try {
      const heldItem = bot.inventory.items().find(i => i.name === item.name) || item;
      await bot.equip(heldItem, 'hand');
      await bot.lookAt(spot.reference.position.offset(0.5 + spot.face.x * 0.5, 0.5 + spot.face.y * 0.5, 0.5 + spot.face.z * 0.5), true);
      await bot.placeBlock(spot.reference, spot.face);
      return { success: true, position: spot.position.clone ? spot.position.clone() : spot.position, refused: false, error: null };
    } catch (error) {
      markBadBlock(spot.position);
      lastError = error;
      refused = refused || isServerRefusal(error);
    }
  }
  if (!lastError) {
    return { success: false, position: null, refused: false, error: 'no free spot next to a solid block within reach' };
  }
  return { success: false, position: null, refused, error: lastError?.message || 'placement failed' };
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
  isReplaceableBlock,
  isSolidGround,
  isPlacementReference,
  isCellObstructed,
  findPlacementSpots,
  findGroundPlacement,
  placeOnGround,
  placeItemNearby,
  isServerRefusal,
  approachPosition,
  digWithTimeout,
  pickUpDroppedItem
};
