const { goals } = require('mineflayer-pathfinder');
const { createResult } = require('./result');

/**
 * Stop all ongoing bot movements and active pathfinding
 * @param {object} bot Mineflayer bot instance
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
    } catch {}
  }

  if (typeof bot.clearControlStates === 'function') {
    bot.clearControlStates();
  }

  const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
  for (const control of controls) {
    try {
      if (typeof bot.setControlState === 'function') {
        bot.setControlState(control, false);
      }
    } catch {}
  }
}

/**
 * Clear all ongoing movement control states (legacy wrapper)
 * @param {object} bot Mineflayer bot instance
 */
function clearMovementControls(bot) {
  stopMovement(bot);
}

/**
 * Navigate bot to target coordinates with robust lifecycle management
 * @param {object} bot Mineflayer bot instance
 * @param {number} x Target X coordinate
 * @param {number} y Target Y coordinate
 * @param {number} z Target Z coordinate
 * @param {object} [options={}] Movement options
 * @param {number} [options.range=1] Stopping distance range
 * @param {number} [options.timeoutMs=0] Maximum execution duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function gotoCoordinates(bot, x, y, z, options = {}) {
  if (
    typeof x !== 'number' || !Number.isFinite(x) ||
    typeof y !== 'number' || !Number.isFinite(y) ||
    typeof z !== 'number' || !Number.isFinite(z)
  ) {
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

  const currentTaskId = (bot._activeNavigationTaskId = (bot._activeNavigationTaskId || 0) + 1);

  if (abortSignal?.aborted) {
    stopMovement(bot);
    return createResult(false, 'aborted', getPositionData(), 'Navigation aborted by caller');
  }

  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;
  let finalized = false;

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
    const goal = new goals.GoalNear(x, y, z, range);

    const navigationPromise = (async () => {
      if (!bot.pathfinder || typeof bot.pathfinder.goto !== 'function') {
        throw new Error('Pathfinder plugin is not initialized on bot');
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
    if (isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', getPositionData(), 'Navigation aborted by caller');
    }

    if (bot._activeNavigationTaskId !== currentTaskId) {
      return createResult(false, 'aborted', getPositionData(), 'Navigation superseded by another movement task');
    }

    const finalData = getPositionData();
    const reached = finalData.distance <= range + 0.5;
    if (reached) {
      return createResult(true, 'reached', finalData, null);
    }
    return createResult(false, 'no_path', finalData, 'Target position was not reached within range');
  } catch (err) {
    finalized = true;
    const finalData = getPositionData();

    if (isTimedOut) {
      return createResult(false, 'timeout', finalData, 'Navigation timed out');
    }
    if (isAborted || abortSignal?.aborted) {
      return createResult(false, 'aborted', finalData, 'Navigation aborted by caller');
    }

    if (bot._activeNavigationTaskId !== currentTaskId) {
      return createResult(false, 'aborted', finalData, 'Navigation superseded by another movement task');
    }

    const errMessage = String(err?.message || err || '');
    if (errMessage.toLowerCase().includes('path') || errMessage.includes('NoPath')) {
      return createResult(false, 'no_path', finalData, errMessage);
    }

    return createResult(false, 'error', finalData, errMessage);
  } finally {
    cleanupListeners();
  }
}

/**
 * Execute a controlled jump action with apex and physical tracking
 * @param {object} bot Mineflayer bot instance
 * @param {object} [options={}] Jump options
 * @param {number} [options.durationMs=350] Maximum jump key holding duration
 * @param {boolean} [options.waitForApex=false] Wait for apex before resolving
 * @param {number} [options.timeoutMs=1500] Maximum action wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
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

      try {
        if (typeof bot.setControlState === 'function') {
          bot.setControlState('jump', false);
        }
      } catch {}

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

    try {
      if (typeof bot.setControlState === 'function') {
        bot.setControlState('jump', true);
      }
    } catch (err) {
      finalize(false, 'error', String(err?.message || err));
      return;
    }

    keyReleaseTimer = setTimeout(() => {
      try {
        if (typeof bot.setControlState === 'function') {
          bot.setControlState('jump', false);
        }
      } catch {}
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
 * Look towards target world coordinate position
 * @param {object} bot Mineflayer bot instance
 * @param {{ x: number, y: number, z: number }} targetPos Position vector
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function lookAtPosition(bot, targetPos) {
  if (
    !targetPos ||
    typeof targetPos.x !== 'number' ||
    typeof targetPos.y !== 'number' ||
    typeof targetPos.z !== 'number'
  ) {
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
