const { goals } = require('mineflayer-pathfinder');
const { createResult } = require('./result');
const { stopMovement } = require('./movement');

/**
 * Vérifier si une entité cible est actuellement vivante et présente dans le monde
 * @param {object} bot Instance du bot Mineflayer
 * @param {object|null} targetEntity Entité cible à inspecter
 * @returns {{ valid: boolean, reason?: string }} Statut de validité et motif éventuel
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
 * Équiper la meilleure arme disponible dans l'inventaire du bot
 * @param {object} bot Instance du bot Mineflayer
 * @returns {Promise<boolean>} Vrai si une arme est équipée
 */
async function autoEquipBestWeapon(bot) {
  if (!bot.inventory?.items || typeof bot.equip !== 'function') return false;

  const weaponPriority = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'
  ];

  const items = bot.inventory.items();
  for (const weaponName of weaponPriority) {
    const weapon = items.find(i => i.name === weaponName);
    if (weapon) {
      if (bot.heldItem?.name !== weaponName) {
        await Promise.resolve(bot.equip(weapon, 'hand')).catch(() => false);
      }
      return true;
    }
  }
  return false;
}

/**
 * Calculer la distance entre le bot et une entité cible
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} targetEntity Entité cible
 * @returns {number} Distance en blocs ou 999 si indéterminée
 */
function computeEntityDistance(bot, targetEntity) {
  const botPos = bot.entity?.position;
  const targetPos = targetEntity?.position;
  if (!botPos || !targetPos) return 999;

  if (typeof botPos.distanceTo === 'function') {
    return botPos.distanceTo(targetPos);
  }
  return Math.hypot(botPos.x - targetPos.x, botPos.y - targetPos.y, botPos.z - targetPos.z);
}

/**
 * Orienter le regard du bot directement vers l'entité cible
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} targetEntity Entité vivante cible
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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
 * Attaquer une entité cible avec vérifications de portée, de santé et d'arme
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} targetEntity Entité vivante cible
 * @param {object} [options={}] Options d'attaque
 * @param {number} [options.maxDistance=3.5] Portée maximale de frappe
 * @param {boolean} [options.autoEquipWeapon=true] Équiper automatiquement la meilleure arme
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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

  if (bot.entity?.position && targetEntity.position) {
    const distance = computeEntityDistance(bot, targetEntity);
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

  const initialHealth = targetEntity.health ?? null;
  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;
  let finalized = false;

  try {
    const attackPromise = (async () => {
      if (typeof bot.attack !== 'function') {
        throw new TypeError('Bot does not support attack action');
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
    const postHealth = targetEntity.health ?? null;

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
    if (timerId) clearTimeout(timerId);
    if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
  }
}

/**
 * Alias de compatibilité pour attaquer une entité cible
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} targetEntity Entité vivante cible
 * @returns {Promise<object>} Résultat de l'attaque
 */
async function attackTarget(bot, targetEntity) {
  return attackEntity(bot, targetEntity);
}

/**
 * Suivre dynamiquement une entité cible tout en maintenant la distance spécifiée
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} targetEntity Entité cible à suivre
 * @param {object} [options={}] Options de suivi
 * @param {number} [options.range=2] Distance de suivi souhaitée
 * @param {number} [options.timeoutMs=0] Durée maximale de poursuite en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
 */
async function followEntity(bot, targetEntity, options = {}) {
  const check = inspectTargetEntity(bot, targetEntity);
  if (!check.valid) {
    return createResult(false, check.reason, null, `Cannot follow entity: ${check.reason}`);
  }

  const range = typeof options.range === 'number' ? options.range : 2;
  const timeoutMs = options.timeoutMs || 0;
  const abortSignal = options.abortSignal;

  bot._activeNavigationTaskId = (bot._activeNavigationTaskId || 0) + 1;
  const currentTaskId = bot._activeNavigationTaskId;

  if (abortSignal?.aborted) {
    stopMovement(bot);
    return createResult(false, 'aborted', { entityId: targetEntity.id }, 'Follow operation aborted before start');
  }

  const initialDistance = computeEntityDistance(bot, targetEntity);
  if (initialDistance <= range + 0.5) {
    return createResult(true, 'reached', {
      entityId: targetEntity.id,
      distance: initialDistance,
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

  try {
    const goal = new goals.GoalFollow(targetEntity, range);
    if (typeof bot.pathfinder?.setGoal === 'function') {
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

        if (computeEntityDistance(bot, targetEntity) <= range + 0.5) {
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
    if (isTimedOut || !reachedRange) {
      return createResult(false, 'timeout', { entityId: targetEntity.id }, 'Follow operation timed out');
    }

    return createResult(true, 'reached', {
      entityId: targetEntity.id,
      distance: computeEntityDistance(bot, targetEntity),
      range
    }, null);
  } catch (err) {
    finalized = true;
    stopMovement(bot);

    if (bot._activeNavigationTaskId !== currentTaskId || isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', { entityId: targetEntity.id }, 'Follow operation aborted by caller');
    }
    if (stopReason) {
      return createResult(false, stopReason, { entityId: targetEntity.id }, `Entity state changed: ${stopReason}`);
    }
    if (isTimedOut) {
      return createResult(false, 'timeout', { entityId: targetEntity.id }, 'Follow operation timed out');
    }
    return createResult(false, 'error', { entityId: targetEntity.id }, String(err?.message || err));
  } finally {
    if (timerId) clearTimeout(timerId);
    if (checkInterval) clearInterval(checkInterval);
    if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
  }
}

module.exports = {
  inspectTargetEntity,
  faceTarget,
  attackEntity,
  attackTarget,
  followEntity
};
