const { goals } = require('mineflayer-pathfinder');
const { createResult } = require('./result');
const { stopMovement } = require('./movement');

/**
 * Check whether a target entity is currently alive and active in the world
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} targetEntity Target entity to inspect
 * @returns {{ valid: boolean, reason?: string }} Validity status and reason
 */
function inspectTargetEntity(bot, targetEntity) {
  if (!targetEntity || typeof targetEntity !== 'object') {
    return { valid: false, reason: 'invalid_target' };
  }

  if (targetEntity.health !== undefined && targetEntity.health <= 0) {
    return { valid: false, reason: 'target_dead' };
  }

  if (targetEntity.isValid === false) {
    return { valid: false, reason: 'target_dead' };
  }

  if (bot.entities && targetEntity.id && !bot.entities[targetEntity.id]) {
    return { valid: false, reason: 'target_lost' };
  }

  return { valid: true };
}

/**
 * Equip best available weapon from bot inventory
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<void>}
 */
async function autoEquipBestWeapon(bot) {
  if (!bot.inventory?.items || typeof bot.equip !== 'function') return;

  const weaponPriority = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'
  ];

  const items = bot.inventory.items();
  for (const weaponName of weaponPriority) {
    const weapon = items.find(i => i.name === weaponName);
    if (weapon) {
      if (bot.heldItem?.name !== weaponName) {
        try {
          await bot.equip(weapon, 'hand');
        } catch {}
      }
      return;
    }
  }
}

/**
 * Orient bot gaze directly towards target entity
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target living entity
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function faceTarget(bot, targetEntity) {
  const check = inspectTargetEntity(bot, targetEntity);
  if (!check.valid) {
    return createResult(false, check.reason, null, 'Target entity is not valid to face');
  }

  if (!targetEntity.position) {
    return createResult(false, 'invalid_target', null, 'Target entity lacks position data');
  }

  try {
    const eyeHeight = targetEntity.height ? targetEntity.height * 0.85 : 1.2;
    const targetPos = typeof targetEntity.position.offset === 'function'
      ? targetEntity.position.offset(0, eyeHeight, 0)
      : { x: targetEntity.position.x, y: targetEntity.position.y + eyeHeight, z: targetEntity.position.z };

    if (typeof bot.lookAt === 'function') {
      await bot.lookAt(targetPos);
    }
    return createResult(true, 'faced', { entityId: targetEntity.id }, null);
  } catch (err) {
    return createResult(false, 'error', { entityId: targetEntity.id }, String(err?.message || err));
  }
}

/**
 * Attack target entity with range, health, and weapon checks
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target living entity
 * @param {object} [options={}] Attack options
 * @param {number} [options.maxDistance=3.5] Maximum striking reach
 * @param {boolean} [options.autoEquipWeapon=true] Automatically equip best weapon
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function attackEntity(bot, targetEntity, options = {}) {
  const check = inspectTargetEntity(bot, targetEntity);
  if (!check.valid) {
    return createResult(false, check.reason, null, `Target entity inspection failed: ${check.reason}`);
  }

  const maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : 3.5;
  const autoEquip = options.autoEquipWeapon !== false;
  const timeoutMs = options.timeoutMs || 0;
  const abortSignal = options.abortSignal;

  if (abortSignal?.aborted) {
    return createResult(false, 'aborted', { entityId: targetEntity.id }, 'Attack operation aborted before start');
  }

  const botPos = bot.entity?.position;
  const targetPos = targetEntity.position;
  if (botPos && targetPos) {
    const distance = typeof botPos.distanceTo === 'function'
      ? botPos.distanceTo(targetPos)
      : Math.hypot(botPos.x - targetPos.x, botPos.y - targetPos.y, botPos.z - targetPos.z);

    if (distance > maxDistance) {
      return createResult(false, 'out_of_reach', {
        entityId: targetEntity.id,
        distance,
        maxDistance
      }, 'Target entity is out of striking reach');
    }
  }

  if (autoEquip) {
    await autoEquipBestWeapon(bot);
  }

  await faceTarget(bot, targetEntity);

  const initialHealth = targetEntity.health !== undefined ? targetEntity.health : null;

  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;
  let finalized = false;

  const cleanup = () => {
    if (timerId) clearTimeout(timerId);
    if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
  };

  try {
    const attackPromise = (async () => {
      if (typeof bot.attack !== 'function') {
        throw new Error('Bot does not support attack action');
      }
      bot.attack(targetEntity);
    })();

    const racePromises = [attackPromise];

    if (abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        abortHandler = () => {
          if (!finalized) {
            isAborted = true;
            reject(new Error('Attack operation aborted by caller'));
          }
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      });
      racePromises.push(abortPromise);
    }

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          if (!finalized) {
            isTimedOut = true;
            reject(new Error('Attack operation timed out'));
          }
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    await Promise.race(racePromises);
    finalized = true;

    const postCheck = inspectTargetEntity(bot, targetEntity);
    const postHealth = targetEntity.health !== undefined ? targetEntity.health : null;

    if (!postCheck.valid && postCheck.reason === 'target_dead') {
      return createResult(true, 'attacked', {
        entityId: targetEntity.id,
        targetEliminated: true,
        remainingHealth: 0
      }, null);
    }

    const damaged = initialHealth !== null && postHealth !== null && postHealth < initialHealth;

    return createResult(true, 'attacked', {
      entityId: targetEntity.id,
      targetEliminated: Boolean(targetEntity.health <= 0 || targetEntity.isValid === false),
      damageDealt: damaged ? (initialHealth - postHealth) : null,
      remainingHealth: postHealth
    }, null);
  } catch (err) {
    finalized = true;

    if (isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', { entityId: targetEntity.id }, 'Attack operation aborted by caller');
    }
    if (isTimedOut) {
      return createResult(false, 'timeout', { entityId: targetEntity.id }, 'Attack operation timed out');
    }

    return createResult(false, 'error', { entityId: targetEntity.id }, String(err?.message || err));
  } finally {
    cleanup();
  }
}

/**
 * Legacy alias for attacking a target entity
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target living entity
 * @returns {Promise<any>}
 */
async function attackTarget(bot, targetEntity) {
  return attackEntity(bot, targetEntity);
}

/**
 * Follow target entity dynamically while maintaining specified range
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target entity to follow
 * @param {object} [options={}] Follow options
 * @param {number} [options.range=2] Desired following distance
 * @param {number} [options.timeoutMs=0] Maximum tracking duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function followEntity(bot, targetEntity, options = {}) {
  const check = inspectTargetEntity(bot, targetEntity);
  if (!check.valid) {
    return createResult(false, check.reason, null, `Cannot follow entity: ${check.reason}`);
  }

  const range = typeof options.range === 'number' ? options.range : 2;
  const timeoutMs = options.timeoutMs || 0;
  const abortSignal = options.abortSignal;

  const currentTaskId = (bot._activeNavigationTaskId = (bot._activeNavigationTaskId || 0) + 1);

  const getDistance = () => {
    const botPos = bot.entity?.position;
    const targetPos = targetEntity.position;
    if (botPos && targetPos) {
      return typeof botPos.distanceTo === 'function'
        ? botPos.distanceTo(targetPos)
        : Math.hypot(botPos.x - targetPos.x, botPos.y - targetPos.y, botPos.z - targetPos.z);
    }
    return 999;
  };

  if (abortSignal?.aborted) {
    stopMovement(bot);
    return createResult(false, 'aborted', { entityId: targetEntity.id }, 'Follow operation aborted before start');
  }

  if (getDistance() <= range + 0.5) {
    return createResult(true, 'reached', {
      entityId: targetEntity.id,
      distance: getDistance(),
      range
    }, null);
  }

  let timerId = null;
  let abortHandler = null;
  let checkInterval = null;
  let isTimedOut = false;
  let isAborted = false;
  let stopReason = null;
  let reachedRange = false;
  let finalized = false;

  const cleanup = () => {
    if (timerId) clearTimeout(timerId);
    if (checkInterval) clearInterval(checkInterval);
    if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
  };

  try {
    const goal = new goals.GoalFollow(targetEntity, range);

    if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(goal, true);
    }

    const trackingPromise = new Promise((resolve) => {
      checkInterval = setInterval(() => {
        if (bot._activeNavigationTaskId !== currentTaskId) {
          clearInterval(checkInterval);
          stopReason = 'aborted';
          resolve();
          return;
        }

        const stateCheck = inspectTargetEntity(bot, targetEntity);
        if (!stateCheck.valid) {
          clearInterval(checkInterval);
          stopReason = stateCheck.reason;
          stopMovement(bot);
          resolve();
          return;
        }

        const dist = getDistance();
        if (dist <= range + 0.5) {
          reachedRange = true;
          clearInterval(checkInterval);
          stopMovement(bot);
          resolve();
        }
      }, 20);
    });

    const racePromises = [trackingPromise];

    if (abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        abortHandler = () => {
          if (!finalized && bot._activeNavigationTaskId === currentTaskId) {
            isAborted = true;
            stopMovement(bot);
            reject(new Error('Follow operation aborted by caller'));
          }
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      });
      racePromises.push(abortPromise);
    }

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          if (!finalized && bot._activeNavigationTaskId === currentTaskId) {
            isTimedOut = true;
            stopMovement(bot);
            reject(new Error('Follow operation timed out'));
          }
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    await Promise.race(racePromises);
    finalized = true;

    if (stopReason) {
      return createResult(false, stopReason, { entityId: targetEntity.id }, `Entity state changed during follow: ${stopReason}`);
    }

    if (isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', { entityId: targetEntity.id }, 'Follow operation aborted by caller');
    }
    if (isTimedOut) {
      return createResult(false, 'timeout', { entityId: targetEntity.id }, 'Follow operation timed out');
    }

    if (reachedRange) {
      return createResult(true, 'reached', {
        entityId: targetEntity.id,
        distance: getDistance(),
        range
      }, null);
    }

    return createResult(false, 'timeout', { entityId: targetEntity.id }, 'Target range was not reached');
  } catch (err) {
    finalized = true;
    stopMovement(bot);

    if (bot._activeNavigationTaskId !== currentTaskId) {
      return createResult(false, 'aborted', { entityId: targetEntity.id }, 'Follow superseded by newer task');
    }

    if (stopReason) {
      return createResult(false, stopReason, { entityId: targetEntity.id }, `Entity state changed: ${stopReason}`);
    }

    if (isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', { entityId: targetEntity.id }, 'Follow operation aborted by caller');
    }
    if (isTimedOut) {
      return createResult(false, 'timeout', { entityId: targetEntity.id }, 'Follow operation timed out');
    }

    return createResult(false, 'error', { entityId: targetEntity.id }, String(err?.message || err));
  } finally {
    cleanup();
  }
}

module.exports = {
  inspectTargetEntity,
  autoEquipBestWeapon,
  faceTarget,
  attackEntity,
  attackTarget,
  followEntity
};
