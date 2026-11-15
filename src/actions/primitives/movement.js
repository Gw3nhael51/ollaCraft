const { goals } = require('mineflayer-pathfinder');
const { createResult } = require('./result');

/**
 * Modifier un état de contrôle physique du bot sans propager d'exception
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} control Nom du contrôle ('jump', 'forward', etc.)
 * @param {boolean} state Valeur cible
 * @returns {boolean} Vrai si l'état a été appliqué
 */
function setControlStateSafely(bot, control, state) {
  if (typeof bot.setControlState !== 'function') return false;
  try {
    bot.setControlState(control, state);
    return true;
  } catch {
    return false;
  }
}

/**
 * Arrêter tous les mouvements en cours et la recherche de chemin active du bot
 * @param {object} bot Instance du bot Mineflayer
 */
function stopMovement(bot) {
  bot._activeNavigationTaskId = (bot._activeNavigationTaskId || 0) + 1;

  if (bot.pathfinder) {
    try {
      if (typeof bot.pathfinder.setGoal === 'function') {
        bot.pathfinder.setGoal(null);
      }
      if (typeof bot.pathfinder.stop === 'function') {
        bot.pathfinder.stop();
      }
    } catch {
      // Ignored
    }
  }

  if (typeof bot.clearControlStates === 'function') {
    bot.clearControlStates();
  }

  const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
  for (const control of controls) {
    setControlStateSafely(bot, control, false);
  }
}

/**
 * Réinitialiser tous les contrôles de déplacement (alias de compatibilité)
 * @param {object} bot Instance du bot Mineflayer
 */
function clearMovementControls(bot) {
  stopMovement(bot);
}

/**
 * Vérifier que trois coordonnées numériques sont finies et valides
 * @param {number} x Coordonnée X
 * @param {number} y Coordonnée Y
 * @param {number} z Coordonnée Z
 * @returns {boolean} Vrai si les coordonnées sont valides
 */
function areValidAxes(x, y, z) {
  return (
    typeof x === 'number' && Number.isFinite(x) &&
    typeof y === 'number' && Number.isFinite(y) &&
    typeof z === 'number' && Number.isFinite(z)
  );
}

/**
 * Naviguer vers des coordonnées cibles avec gestion complète du cycle de vie
 * @param {object} bot Instance du bot Mineflayer
 * @param {number} x Coordonnée X cible
 * @param {number} y Coordonnée Y cible
 * @param {number} z Coordonnée Z cible
 * @param {object} [options={}] Options de déplacement
 * @param {number} [options.range=1] Distance d'arrêt souhaitée
 * @param {number} [options.timeoutMs=0] Durée maximale d'exécution en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
 */
async function gotoCoordinates(bot, x, y, z, options = {}) {
  if (!areValidAxes(x, y, z)) {
    return createResult(false, 'invalid_target', null, 'Target coordinates are invalid');
  }

  const range = typeof options.range === 'number' ? options.range : 1;
  const timeoutMs = options.timeoutMs || 0;
  const abortSignal = options.abortSignal;

  const getPositionData = () => {
    const current = bot.entity?.position || { x, y, z };
    const distance = Math.hypot(current.x - x, current.y - y, current.z - z);
    return {
      position: { x: current.x, y: current.y, z: current.z },
      distance
    };
  };

  bot._activeNavigationTaskId = (bot._activeNavigationTaskId || 0) + 1;
  const currentTaskId = bot._activeNavigationTaskId;

  if (abortSignal?.aborted) {
    stopMovement(bot);
    return createResult(false, 'aborted', getPositionData(), 'Navigation aborted by caller');
  }

  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;
  let finalized = false;

  try {
    const goal = new goals.GoalNear(x, y, z, range);
    const navigationPromise = (async () => {
      if (typeof bot.pathfinder?.goto !== 'function') {
        throw new TypeError('Pathfinder plugin is not initialized on bot');
      }
      await bot.pathfinder.goto(goal);
    })();

    const racePromises = [navigationPromise];

    if (abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        abortHandler = () => {
          if (!finalized && bot._activeNavigationTaskId === currentTaskId) {
            isAborted = true;
            stopMovement(bot);
            reject(new Error('Navigation aborted by caller'));
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
            reject(new Error('Navigation timed out'));
          }
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    await Promise.race(racePromises);
    finalized = true;

    if (isTimedOut) {
      return createResult(false, 'timeout', getPositionData(), 'Navigation timed out');
    }
    if (isAborted || abortSignal?.aborted || bot._activeNavigationTaskId !== currentTaskId) {
      return createResult(false, 'aborted', getPositionData(), 'Navigation aborted by caller');
    }

    const finalData = getPositionData();
    if (finalData.distance <= range + 0.5) {
      return createResult(true, 'reached', finalData, null);
    }
    return createResult(false, 'no_path', finalData, 'Target position was not reached within range');
  } catch (err) {
    finalized = true;
    const finalData = getPositionData();

    if (isTimedOut) {
      return createResult(false, 'timeout', finalData, 'Navigation timed out');
    }
    if (isAborted || abortSignal?.aborted || bot._activeNavigationTaskId !== currentTaskId) {
      return createResult(false, 'aborted', finalData, 'Navigation aborted by caller');
    }

    const errMessage = String(err?.message || err || '');
    if (errMessage.toLowerCase().includes('path') || errMessage.includes('NoPath')) {
      return createResult(false, 'no_path', finalData, errMessage);
    }
    return createResult(false, 'error', finalData, errMessage);
  } finally {
    if (timerId) clearTimeout(timerId);
    if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
  }
}

/**
 * Exécuter un saut contrôlé avec suivi de l'apogée et de l'état physique
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} [options={}] Options de saut
 * @param {number} [options.durationMs=350] Durée maximale de maintien de la touche de saut
 * @param {boolean} [options.waitForApex=false] Attendre l'apogée du saut avant de résoudre
 * @param {number} [options.timeoutMs=1500] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
 */
async function jump(bot, options = {}) {
  const durationMs = typeof options.durationMs === 'number' ? options.durationMs : 350;
  const waitForApex = Boolean(options.waitForApex);
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 1500;
  const abortSignal = options.abortSignal;

  const initialY = bot.entity?.position?.y ?? 0;
  const getJumpData = (peakY) => ({
    initialY,
    peakY,
    heightGained: Math.max(0, peakY - initialY)
  });

  if (abortSignal?.aborted) {
    return createResult(false, 'aborted', getJumpData(initialY), 'Jump aborted before start');
  }

  return new Promise((resolve) => {
    let peakY = initialY;
    let lastY = initialY;
    let keyReleaseTimer = null;
    let timeoutTimer = null;
    let checkInterval = null;
    let abortHandler = null;
    let finalized = false;

    const finalize = (success, reason, errMessage = null) => {
      if (finalized) return;
      finalized = true;

      if (keyReleaseTimer) clearTimeout(keyReleaseTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (checkInterval) clearInterval(checkInterval);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);

      setControlStateSafely(bot, 'jump', false);
      resolve(createResult(success, reason, getJumpData(peakY), errMessage));
    };

    if (abortSignal) {
      abortHandler = () => finalize(false, 'aborted', 'Jump aborted by caller');
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        finalize(false, 'timeout', 'Jump action timed out');
      }, timeoutMs);
    }

    if (typeof bot.setControlState === 'function') {
      try {
        bot.setControlState('jump', true);
      } catch (err) {
        finalize(false, 'error', String(err?.message || err));
        return;
      }
    }

    keyReleaseTimer = setTimeout(() => {
      setControlStateSafely(bot, 'jump', false);
      if (!waitForApex) {
        finalize(true, 'jumped', null);
      }
    }, durationMs);

    const checkState = () => {
      const currentY = bot.entity?.position?.y ?? initialY;
      const velocityY = bot.entity?.velocity?.y ?? 0;

      if (currentY > peakY) {
        peakY = currentY;
      }

      if (waitForApex) {
        const gainedAltitude = peakY - initialY;
        const reachedPeak = gainedAltitude > 0.1 && (velocityY <= 0 || currentY < lastY);
        if (reachedPeak) {
          finalize(true, 'apex_reached', null);
          return;
        }
      }
      lastY = currentY;
    };

    if (typeof bot.on === 'function') {
      const onTick = () => {
        if (finalized) {
          bot.removeListener?.('physicTick', onTick);
          return;
        }
        checkState();
      };
      bot.on('physicTick', onTick);
    }

    checkInterval = setInterval(checkState, 20);
  });
}

/**
 * Orienter le regard du bot vers une position 3D dans le monde
 * @param {object} bot Instance du bot Mineflayer
 * @param {{ x: number, y: number, z: number }} targetPos Vecteur de position cible
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
 */
async function lookAtPosition(bot, targetPos) {
  if (!targetPos || !areValidAxes(targetPos.x, targetPos.y, targetPos.z)) {
    return createResult(false, 'invalid_target', null, 'Target position is invalid');
  }

  try {
    if (typeof bot.lookAt === 'function') {
      await bot.lookAt(targetPos);
    }
    return createResult(true, 'looked', { target: { ...targetPos } }, null);
  } catch (err) {
    return createResult(false, 'error', { target: { ...targetPos } }, String(err?.message || err));
  }
}

module.exports = {
  gotoCoordinates,
  jump,
  stopMovement,
  clearMovementControls,
  lookAtPosition
};
