const { Vec3 } = require('vec3');
const { createResult } = require('./result');

const VALID_FACES = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 }
];

/**
 * Validate unit face vector against the six allowed cardinal directions
 * @param {{ x: number, y: number, z: number }} faceVector Normal vector
 * @returns {boolean} True if strictly valid
 */
function isValidFaceVector(faceVector) {
  if (!faceVector) return false;
  return VALID_FACES.some(
    f => f.x === faceVector.x && f.y === faceVector.y && f.z === faceVector.z
  );
}

/**
 * Check whether placement destination collides with bot bounding box
 * @param {{ x: number, y: number, z: number }} botPos Bot physical position
 * @param {{ x: number, y: number, z: number }} blockPos Target block position
 * @returns {boolean} True if collision occurs
 */
function checkBotBodyCollision(botPos, blockPos) {
  const botMinX = botPos.x - 0.3;
  const botMaxX = botPos.x + 0.3;
  const botMinY = botPos.y;
  const botMaxY = botPos.y + 1.8;
  const botMinZ = botPos.z - 0.3;
  const botMaxZ = botPos.z + 0.3;

  const blockMinX = blockPos.x;
  const blockMaxX = blockPos.x + 1;
  const blockMinY = blockPos.y;
  const blockMaxY = blockPos.y + 1;
  const blockMinZ = blockPos.z;
  const blockMaxZ = blockPos.z + 1;

  return (
    botMinX < blockMaxX &&
    botMaxX > blockMinX &&
    botMinY < blockMaxY &&
    botMaxY > blockMinY &&
    botMinZ < blockMaxZ &&
    botMaxZ > blockMinZ
  );
}

/**
 * Break block at given world position with strict verification
 * @param {object} bot Mineflayer bot instance
 * @param {{ x: number, y: number, z: number }} position Block coordinates
 * @param {object} [options={}] Digging options
 * @param {number} [options.maxDistance=4.5] Maximum reach distance
 * @param {number} [options.timeoutMs=0] Maximum digging duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function breakBlockAt(bot, position, options = {}) {
  if (
    !position ||
    typeof position.x !== 'number' || !Number.isFinite(position.x) ||
    typeof position.y !== 'number' || !Number.isFinite(position.y) ||
    typeof position.z !== 'number' || !Number.isFinite(position.z)
  ) {
    return createResult(false, 'invalid_target', null, 'Target block position is invalid');
  }

  const maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : 4.5;
  const timeoutMs = options.timeoutMs || 0;
  const abortSignal = options.abortSignal;

  const targetVec = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  const blockCenter = new Vec3(targetVec.x + 0.5, targetVec.y + 0.5, targetVec.z + 0.5);

  if (abortSignal?.aborted) {
    return createResult(false, 'aborted', { position: { x: targetVec.x, y: targetVec.y, z: targetVec.z } }, 'Digging aborted before start');
  }

  if (typeof bot.blockAt !== 'function') {
    return createResult(false, 'invalid_target', null, 'Bot cannot inspect world blocks');
  }

  const block = bot.blockAt(targetVec);
  if (!block) {
    return createResult(false, 'invalid_target', null, 'Target block is not loaded');
  }
  if (block.name === 'air') {
    return createResult(false, 'air', { position: { x: targetVec.x, y: targetVec.y, z: targetVec.z } }, null);
  }

  const isDiggable = Boolean(block.diggable);
  const canDig = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : isDiggable;
  if (!isDiggable || !canDig) {
    return createResult(false, 'unbreakable', {
      position: { x: targetVec.x, y: targetVec.y, z: targetVec.z },
      blockName: block.name
    }, null);
  }

  const botPos = bot.entity?.position || new Vec3(0, 0, 0);
  const distance = typeof botPos.distanceTo === 'function'
    ? botPos.distanceTo(blockCenter)
    : Math.hypot(botPos.x - blockCenter.x, botPos.y - blockCenter.y, botPos.z - blockCenter.z);

  if (distance > maxDistance) {
    return createResult(false, 'out_of_reach', {
      position: { x: targetVec.x, y: targetVec.y, z: targetVec.z },
      distance,
      maxDistance
    }, null);
  }

  if (typeof bot.lookAt === 'function') {
    try {
      await bot.lookAt(blockCenter);
    } catch {
      // Ignore look error
    }
  }

  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;

  const cleanupListeners = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler);
      abortHandler = null;
    }
  };

  const cancelDigging = () => {
    if (typeof bot.stopDigging === 'function') {
      try {
        bot.stopDigging();
      } catch {
        // Ignore stop error
      }
    }
  };

  try {
    const digPromise = (async () => {
      if (typeof bot.dig !== 'function') {
        throw new Error('Bot cannot dig blocks');
      }
      await bot.dig(block);
    })();

    const racePromises = [digPromise];

    if (abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        abortHandler = () => {
          isAborted = true;
          cancelDigging();
          reject(new Error('Digging aborted by caller'));
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      });
      racePromises.push(abortPromise);
    }

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          isTimedOut = true;
          cancelDigging();
          reject(new Error('Digging timed out'));
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    await Promise.race(racePromises);

    if (isAborted || abortSignal?.aborted) {
      cancelDigging();
      return createResult(false, 'aborted', {
        position: { x: targetVec.x, y: targetVec.y, z: targetVec.z }
      }, 'Digging aborted by caller');
    }

    const afterBlock = bot.blockAt(targetVec);
    const broken = !afterBlock || afterBlock.name === 'air' || afterBlock.name !== block.name;

    if (broken) {
      return createResult(true, 'broken', {
        position: { x: targetVec.x, y: targetVec.y, z: targetVec.z },
        blockName: block.name
      }, null);
    }

    return createResult(false, 'error', {
      position: { x: targetVec.x, y: targetVec.y, z: targetVec.z },
      blockName: afterBlock.name
    }, 'Block remained intact after digging operation');
  } catch (err) {
    cancelDigging();

    if (isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', {
        position: { x: targetVec.x, y: targetVec.y, z: targetVec.z }
      }, 'Digging aborted by caller');
    }
    if (isTimedOut) {
      return createResult(false, 'timeout', {
        position: { x: targetVec.x, y: targetVec.y, z: targetVec.z }
      }, 'Digging timed out');
    }

    return createResult(false, 'error', {
      position: { x: targetVec.x, y: targetVec.y, z: targetVec.z }
    }, String(err?.message || err));
  } finally {
    cleanupListeners();
  }
}

/**
 * Place item from inventory against a reference block face with strict physical checks
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Name of item to place
 * @param {{ x: number, y: number, z: number }} referencePosition Reference block coordinates
 * @param {{ x: number, y: number, z: number }} faceVector Normal face vector
 * @param {object} [options={}] Placement options
 * @param {number} [options.maxDistance=4.5] Maximum reach distance
 * @param {number} [options.timeoutMs=0] Maximum placement duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function placeBlockOnFace(bot, itemName, referencePosition, faceVector, options = {}) {
  if (!isValidFaceVector(faceVector)) {
    return createResult(false, 'invalid_face', null, 'Face vector must be a unit normal along an axis');
  }

  if (
    !referencePosition ||
    typeof referencePosition.x !== 'number' || !Number.isFinite(referencePosition.x) ||
    typeof referencePosition.y !== 'number' || !Number.isFinite(referencePosition.y) ||
    typeof referencePosition.z !== 'number' || !Number.isFinite(referencePosition.z)
  ) {
    return createResult(false, 'invalid_target', null, 'Reference coordinates are invalid');
  }

  const maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : 4.5;
  const timeoutMs = options.timeoutMs || 0;
  const abortSignal = options.abortSignal;

  const refVec = new Vec3(
    Math.floor(referencePosition.x),
    Math.floor(referencePosition.y),
    Math.floor(referencePosition.z)
  );
  const destPos = {
    x: refVec.x + faceVector.x,
    y: refVec.y + faceVector.y,
    z: refVec.z + faceVector.z
  };
  const destVec = new Vec3(destPos.x, destPos.y, destPos.z);

  if (abortSignal?.aborted) {
    return createResult(false, 'aborted', { position: destPos }, 'Placement aborted before start');
  }

  if (typeof bot.blockAt !== 'function') {
    return createResult(false, 'invalid_target', null, 'Bot cannot inspect world blocks');
  }

  const refBlock = bot.blockAt(refVec);
  if (!refBlock || refBlock.name === 'air') {
    return createResult(false, 'invalid_target', null, 'Reference block does not exist or is air');
  }

  const faceCenter = new Vec3(
    refVec.x + 0.5 + faceVector.x * 0.5,
    refVec.y + 0.5 + faceVector.y * 0.5,
    refVec.z + 0.5 + faceVector.z * 0.5
  );
  const botPos = bot.entity?.position || new Vec3(0, 0, 0);
  const reachDistance = typeof botPos.distanceTo === 'function'
    ? botPos.distanceTo(faceCenter)
    : Math.hypot(botPos.x - faceCenter.x, botPos.y - faceCenter.y, botPos.z - faceCenter.z);

  if (reachDistance > maxDistance) {
    return createResult(false, 'out_of_reach', {
      position: destPos,
      distance: reachDistance,
      maxDistance
    }, null);
  }

  const destBlock = bot.blockAt(destVec);
  const isOccupied = destBlock && destBlock.name !== 'air' && destBlock.name !== 'water' && destBlock.name !== 'lava' && destBlock.boundingBox !== 'empty';
  if (isOccupied) {
    return createResult(false, 'occupied', { position: destPos, blockName: destBlock.name }, 'Destination position is already occupied');
  }

  if (checkBotBodyCollision(botPos, destPos)) {
    return createResult(false, 'body_collision', { position: destPos }, 'Destination intersects bot physical hitbox');
  }

  const item = bot.inventory?.items?.().find(i => i.name === itemName);
  if (!item) {
    return createResult(false, 'missing_item', { itemName, position: destPos }, 'Item not found in bot inventory');
  }

  if (typeof bot.equip === 'function') {
    try {
      await bot.equip(item, 'hand');
    } catch (err) {
      return createResult(false, 'error', { itemName, position: destPos }, String(err?.message || err));
    }
  }

  if (typeof bot.lookAt === 'function') {
    try {
      await bot.lookAt(faceCenter);
    } catch {
      // Ignore look error
    }
  }

  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;

  const cleanupListeners = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler);
      abortHandler = null;
    }
  };

  try {
    const placePromise = (async () => {
      if (typeof bot.placeBlock !== 'function') {
        throw new Error('Bot cannot place blocks');
      }
      await bot.placeBlock(refBlock, new Vec3(faceVector.x, faceVector.y, faceVector.z));
    })();

    const racePromises = [placePromise];

    if (abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        abortHandler = () => {
          isAborted = true;
          reject(new Error('Placement aborted by caller'));
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      });
      racePromises.push(abortPromise);
    }

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          isTimedOut = true;
          reject(new Error('Placement timed out'));
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    await Promise.race(racePromises);

    if (isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', { position: destPos }, 'Placement aborted by caller');
    }

    const placedBlock = bot.blockAt(destVec);
    const placed = placedBlock && placedBlock.name !== 'air';

    if (placed) {
      return createResult(true, 'placed', {
        position: destPos,
        blockName: placedBlock.name
      }, null);
    }

    return createResult(false, 'error', { position: destPos }, 'Block was not found at destination after placement');
  } catch (err) {
    if (isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', { position: destPos }, 'Placement aborted by caller');
    }
    if (isTimedOut) {
      return createResult(false, 'timeout', { position: destPos }, 'Placement timed out');
    }

    return createResult(false, 'error', { position: destPos }, String(err?.message || err));
  } finally {
    cleanupListeners();
  }
}

module.exports = {
  VALID_FACES,
  isValidFaceVector,
  checkBotBodyCollision,
  breakBlockAt,
  placeBlockOnFace
};
