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
 * Valider un vecteur normal de face par rapport aux six directions cardinales autorisées
 * @param {{ x: number, y: number, z: number }} faceVector Vecteur normal de face
 * @returns {boolean} Vrai si le vecteur est strictement valide
 */
function isValidFaceVector(faceVector) {
  if (!faceVector) return false;
  return VALID_FACES.some(
    f => f.x === faceVector.x && f.y === faceVector.y && f.z === faceVector.z
  );
}

/**
 * Vérifier que des coordonnées 3D sont des nombres finis valides
 * @param {{ x: number, y: number, z: number }} coords Coordonnées à tester
 * @returns {boolean} Vrai si les trois axes sont valides
 */
function isValidCoordinates(coords) {
  if (!coords) return false;
  return (
    typeof coords.x === 'number' && Number.isFinite(coords.x) &&
    typeof coords.y === 'number' && Number.isFinite(coords.y) &&
    typeof coords.z === 'number' && Number.isFinite(coords.z)
  );
}

/**
 * Calculer la distance entre la position du bot et un point cible
 * @param {object} bot Instance du bot Mineflayer
 * @param {Vec3} targetPoint Point cible dans le monde
 * @returns {number} Distance euclidienne en blocs
 */
function computeBotDistance(bot, targetPoint) {
  const botPos = bot.entity?.position || new Vec3(0, 0, 0);
  if (typeof botPos.distanceTo === 'function') {
    return botPos.distanceTo(targetPoint);
  }
  return Math.hypot(botPos.x - targetPoint.x, botPos.y - targetPoint.y, botPos.z - targetPoint.z);
}

/**
 * Orienter le regard du bot vers un point sans interrompre le flux en cas d'erreur
 * @param {object} bot Instance du bot Mineflayer
 * @param {Vec3} targetPoint Point à regarder
 * @returns {Promise<void>} Promesse résolue après l'orientation
 */
async function lookAtPointSafely(bot, targetPoint) {
  if (typeof bot.lookAt !== 'function') return false;
  try {
    await bot.lookAt(targetPoint);
    return true;
  } catch {
    return false;
  }
}

/**
 * Nettoyer le timer de délai et l'écouteur d'annulation après une opération asynchrone
 * @param {any} timerId Identifiant du timeout actif
 * @param {AbortSignal|null} abortSignal Signal d'annulation externe
 * @param {Function|null} abortHandler Gestionnaire d'événement attaché
 */
function releaseOperationListeners(timerId, abortSignal, abortHandler) {
  if (timerId) {
    clearTimeout(timerId);
  }
  if (abortSignal && abortHandler) {
    abortSignal.removeEventListener('abort', abortHandler);
  }
}

/**
 * Vérifier si la position de destination entre en collision avec la boîte englobante du bot
 * @param {{ x: number, y: number, z: number }} botPos Position physique du bot
 * @param {{ x: number, y: number, z: number }} blockPos Position du bloc cible
 * @returns {boolean} Vrai si une collision est détectée
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
 * Exécuter une opération asynchrone encadrée par un timeout et un signal d'annulation
 * @param {Function} operationFn Fonction asynchrone principale
 * @param {object} guards Options de surveillance
 * @param {number} guards.timeoutMs Délai maximal en millisecondes
 * @param {AbortSignal} [guards.abortSignal] Signal d'annulation externe
 * @param {Function} [guards.onCancel] Callback d'annulation immédiate
 * @param {string} guards.abortMessage Message d'erreur en cas d'annulation
 * @param {string} guards.timeoutMessage Message d'erreur en cas de dépassement de délai
 * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>} Résultat d'exécution supervisée
 */
async function runWithTimeoutAndAbort(operationFn, guards) {
  const { timeoutMs, abortSignal, onCancel, abortMessage, timeoutMessage } = guards;
  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;

  const triggerCancel = () => {
    if (typeof onCancel === 'function') {
      onCancel();
    }
  };

  try {
    const racePromises = [operationFn()];

    if (abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        abortHandler = () => {
          isAborted = true;
          triggerCancel();
          reject(new Error(abortMessage));
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      });
      racePromises.push(abortPromise);
    }

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          isTimedOut = true;
          triggerCancel();
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    await Promise.race(racePromises);

    if (isAborted || abortSignal?.aborted) {
      triggerCancel();
      return { ok: false, reason: 'aborted', error: abortMessage };
    }
    return { ok: true };
  } catch (err) {
    triggerCancel();
    if (isAborted || abortSignal?.aborted) {
      return { ok: false, reason: 'aborted', error: abortMessage };
    }
    if (isTimedOut) {
      return { ok: false, reason: 'timeout', error: timeoutMessage };
    }
    return { ok: false, reason: 'error', error: String(err?.message || err) };
  } finally {
    releaseOperationListeners(timerId, abortSignal, abortHandler);
  }
}

/**
 * Valider l'état du bloc cible avant de démarrer une action de minage
 * @param {object} bot Instance du bot Mineflayer
 * @param {Vec3} targetVec Coordonnées entières du bloc
 * @param {number} maxDistance Distance maximale autorisée
 * @returns {{ valid: boolean, block?: object, blockCenter?: Vec3, errorResult?: object }} Résultat de validation préalable
 */
function validateBreakPreconditions(bot, targetVec, maxDistance) {
  if (typeof bot.blockAt !== 'function') {
    return { valid: false, errorResult: createResult(false, 'invalid_target', null, 'Bot cannot inspect world blocks') };
  }

  const posPayload = { x: targetVec.x, y: targetVec.y, z: targetVec.z };
  const block = bot.blockAt(targetVec);
  if (!block) {
    return { valid: false, errorResult: createResult(false, 'invalid_target', null, 'Target block is not loaded') };
  }
  if (block.name === 'air') {
    return { valid: false, errorResult: createResult(false, 'air', { position: posPayload }, null) };
  }

  const isDiggable = Boolean(block.diggable);
  const canDig = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : isDiggable;
  if (!isDiggable || !canDig) {
    return {
      valid: false,
      errorResult: createResult(false, 'unbreakable', { position: posPayload, blockName: block.name }, null)
    };
  }

  const blockCenter = new Vec3(targetVec.x + 0.5, targetVec.y + 0.5, targetVec.z + 0.5);
  const distance = computeBotDistance(bot, blockCenter);
  if (distance > maxDistance) {
    return {
      valid: false,
      errorResult: createResult(false, 'out_of_reach', { position: posPayload, distance, maxDistance }, null)
    };
  }

  return { valid: true, block, blockCenter };
}

/**
 * Casser un bloc à une position donnée du monde avec vérification stricte post-action
 * @param {object} bot Instance du bot Mineflayer
 * @param {{ x: number, y: number, z: number }} position Coordonnées du bloc à casser
 * @param {object} [options={}] Options de minage
 * @param {number} [options.maxDistance=4.5] Distance maximale de portée
 * @param {number} [options.timeoutMs=0] Durée maximale de minage en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé du minage
 */
async function breakBlockAt(bot, position, options = {}) {
  if (!isValidCoordinates(position)) {
    return createResult(false, 'invalid_target', null, 'Target block position is invalid');
  }

  const maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : 4.5;
  const timeoutMs = options.timeoutMs || 0;
  const abortSignal = options.abortSignal;

  const targetVec = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  const posPayload = { x: targetVec.x, y: targetVec.y, z: targetVec.z };

  if (abortSignal?.aborted) {
    return createResult(false, 'aborted', { position: posPayload }, 'Digging aborted before start');
  }

  const check = validateBreakPreconditions(bot, targetVec, maxDistance);
  if (!check.valid) {
    return check.errorResult;
  }

  await lookAtPointSafely(bot, check.blockCenter);

  const cancelDigging = () => {
    if (typeof bot.stopDigging !== 'function') return false;
    try {
      bot.stopDigging();
      return true;
    } catch {
      return false;
    }
  };

  const execution = await runWithTimeoutAndAbort(
    async () => {
      if (typeof bot.dig !== 'function') {
        throw new TypeError('Bot cannot dig blocks');
      }
      await bot.dig(check.block);
    },
    {
      timeoutMs,
      abortSignal,
      onCancel: cancelDigging,
      abortMessage: 'Digging aborted by caller',
      timeoutMessage: 'Digging timed out'
    }
  );

  if (!execution.ok) {
    return createResult(false, execution.reason, { position: posPayload }, execution.error);
  }

  const afterBlock = bot.blockAt(targetVec);
  const broken = !afterBlock || afterBlock.name === 'air' || afterBlock.name !== check.block.name;
  if (broken) {
    return createResult(true, 'broken', { position: posPayload, blockName: check.block.name }, null);
  }

  return createResult(false, 'error', {
    position: posPayload,
    blockName: afterBlock.name
  }, 'Block remained intact after digging operation');
}

/**
 * Valider l'environnement physique avant la pose d'un bloc sur une face de référence
 * @param {object} bot Instance du bot Mineflayer
 * @param {Vec3} refVec Position du bloc de référence
 * @param {{ x: number, y: number, z: number }} faceVector Vecteur normal de la face
 * @param {{ x: number, y: number, z: number }} destPos Position de destination calculée
 * @param {number} maxDistance Distance maximale de portée
 * @returns {{ valid: boolean, refBlock?: object, faceCenter?: Vec3, errorResult?: object }} Résultat de validation physique
 */
function validatePlaceEnvironment(bot, refVec, faceVector, destPos, maxDistance) {
  if (typeof bot.blockAt !== 'function') {
    return { valid: false, errorResult: createResult(false, 'invalid_target', null, 'Bot cannot inspect world blocks') };
  }

  const refBlock = bot.blockAt(refVec);
  if (!refBlock || refBlock.name === 'air') {
    return { valid: false, errorResult: createResult(false, 'invalid_target', null, 'Reference block does not exist or is air') };
  }

  const faceCenter = new Vec3(
    refVec.x + 0.5 + faceVector.x * 0.5,
    refVec.y + 0.5 + faceVector.y * 0.5,
    refVec.z + 0.5 + faceVector.z * 0.5
  );
  const reachDistance = computeBotDistance(bot, faceCenter);
  if (reachDistance > maxDistance) {
    return {
      valid: false,
      errorResult: createResult(false, 'out_of_reach', { position: destPos, distance: reachDistance, maxDistance }, null)
    };
  }

  const destBlock = bot.blockAt(new Vec3(destPos.x, destPos.y, destPos.z));
  const isOccupied = destBlock &&
    destBlock.name !== 'air' &&
    destBlock.name !== 'water' &&
    destBlock.name !== 'lava' &&
    destBlock.boundingBox !== 'empty';

  if (isOccupied) {
    return {
      valid: false,
      errorResult: createResult(false, 'occupied', { position: destPos, blockName: destBlock.name }, 'Destination position is already occupied')
    };
  }

  const botPos = bot.entity?.position || new Vec3(0, 0, 0);
  if (checkBotBodyCollision(botPos, destPos)) {
    return {
      valid: false,
      errorResult: createResult(false, 'body_collision', { position: destPos }, 'Destination intersects bot physical hitbox')
    };
  }

  return { valid: true, refBlock, faceCenter };
}

/**
 * Poser un item de l'inventaire contre la face d'un bloc de référence avec vérifications physiques
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} itemName Nom de l'item à poser
 * @param {{ x: number, y: number, z: number }} referencePosition Coordonnées du bloc de référence
 * @param {{ x: number, y: number, z: number }} faceVector Vecteur normal de la face cible
 * @param {object} [options={}] Options de pose
 * @param {number} [options.maxDistance=4.5] Distance maximale de portée
 * @param {number} [options.timeoutMs=0] Durée maximale de pose en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé de la pose
 */
async function placeBlockOnFace(bot, itemName, referencePosition, faceVector, options = {}) {
  if (!isValidFaceVector(faceVector)) {
    return createResult(false, 'invalid_face', null, 'Face vector must be a unit normal along an axis');
  }
  if (!isValidCoordinates(referencePosition)) {
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

  if (abortSignal?.aborted) {
    return createResult(false, 'aborted', { position: destPos }, 'Placement aborted before start');
  }

  const envCheck = validatePlaceEnvironment(bot, refVec, faceVector, destPos, maxDistance);
  if (!envCheck.valid) {
    return envCheck.errorResult;
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

  await lookAtPointSafely(bot, envCheck.faceCenter);

  const execution = await runWithTimeoutAndAbort(
    async () => {
      if (typeof bot.placeBlock !== 'function') {
        throw new TypeError('Bot cannot place blocks');
      }
      await bot.placeBlock(envCheck.refBlock, new Vec3(faceVector.x, faceVector.y, faceVector.z));
    },
    {
      timeoutMs,
      abortSignal,
      abortMessage: 'Placement aborted by caller',
      timeoutMessage: 'Placement timed out'
    }
  );

  if (!execution.ok) {
    return createResult(false, execution.reason, { position: destPos }, execution.error);
  }

  const placedBlock = bot.blockAt(new Vec3(destPos.x, destPos.y, destPos.z));
  if (placedBlock && placedBlock.name !== 'air') {
    return createResult(true, 'placed', { position: destPos, blockName: placedBlock.name }, null);
  }

  return createResult(false, 'error', { position: destPos }, 'Block was not found at destination after placement');
}

module.exports = {
  VALID_FACES,
  isValidFaceVector,
  checkBotBodyCollision,
  breakBlockAt,
  placeBlockOnFace
};
