const { createResult } = require('./result');
const { withInventoryLock } = require('./lock');

const VALID_CONTAINER_NAMES = new Set([
  'chest',
  'trapped_chest',
  'barrel',
  'furnace',
  'blast_furnace',
  'smoker',
  'hopper',
  'dispenser',
  'dropper',
  'brewing_stand',
  'ender_chest'
]);

/**
 * Check whether a block qualifies as an accessible item container
 * @param {object|null} block Block definition
 * @returns {boolean} True if block is a valid container
 */
function isContainerBlock(block) {
  if (!block || typeof block.name !== 'string') return false;
  if (VALID_CONTAINER_NAMES.has(block.name)) return true;
  if (block.name.endsWith('shulker_box')) return true;
  return false;
}

/**
 * Open container block at specified position with reach and type validation
 * @param {object} bot Mineflayer bot instance
 * @param {object} containerBlock Target block (chest, furnace, barrel, etc.)
 * @param {object} [options={}] Operation options
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function openContainer(bot, containerBlock, options = {}) {
  if (!containerBlock || typeof containerBlock !== 'object') {
    return createResult(false, 'invalid_target', null, 'Target container block is null or invalid');
  }

  if (!isContainerBlock(containerBlock)) {
    return createResult(false, 'not_a_container', { blockName: containerBlock.name }, 'Target block is not a container');
  }

  return withInventoryLock(bot, async () => {
    const timeoutMs = options.timeoutMs || 0;
    const abortSignal = options.abortSignal;

    if (abortSignal?.aborted) {
      return createResult(false, 'aborted', null, 'Open container aborted before start');
    }

    const botPos = bot.entity?.position;
    const blockPos = containerBlock.position;
    if (botPos && blockPos) {
      const distance = typeof botPos.distanceTo === 'function'
        ? botPos.distanceTo(blockPos)
        : Math.hypot(botPos.x - blockPos.x, botPos.y - blockPos.y, botPos.z - blockPos.z);

      if (distance > 4.5) {
        return createResult(false, 'out_of_reach', { distance, maxDistance: 4.5 }, 'Container block is out of reach');
      }
    }

    if (bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow);
      } catch {}
    }

    let timerId = null;
    let abortHandler = null;
    let isTimedOut = false;
    let isAborted = false;

    const cleanup = () => {
      if (timerId) clearTimeout(timerId);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    };

    try {
      const openPromise = (async () => {
        if (typeof bot.openContainer !== 'function') {
          throw new Error('Bot does not support openContainer action');
        }
        return await bot.openContainer(containerBlock);
      })();

      const racePromises = [openPromise];

      if (abortSignal) {
        const abortPromise = new Promise((_, reject) => {
          abortHandler = () => {
            isAborted = true;
            reject(new Error('Open container aborted by caller'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        });
        racePromises.push(abortPromise);
      }

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => {
            isTimedOut = true;
            reject(new Error('Open container timed out'));
          }, timeoutMs);
        });
        racePromises.push(timeoutPromise);
      }

      const window = await Promise.race(racePromises);

      if (window || bot.currentWindow) {
        return createResult(true, 'opened', {
          window: window || bot.currentWindow,
          containerType: containerBlock.name,
          position: containerBlock.position
        }, null);
      }

      return createResult(false, 'error', null, 'Container window was not established after opening');
    } catch (err) {
      if (bot.currentWindow) {
        return createResult(true, 'opened', {
          window: bot.currentWindow,
          containerType: containerBlock.name,
          position: containerBlock.position
        }, null);
      }

      if (isAborted || abortSignal?.aborted) {
        return createResult(false, 'aborted', null, 'Open container aborted by caller');
      }
      if (isTimedOut) {
        return createResult(false, 'timeout', null, 'Open container timed out');
      }

      return createResult(false, 'error', null, String(err?.message || err));
    } finally {
      cleanup();
    }
  });
}

/**
 * Deposit item from player inventory into open container window
 * @param {object} bot Mineflayer bot instance
 * @param {object} containerWindow Open container window instance
 * @param {string} itemName Name of item to deposit
 * @param {number} [count=1] Number of items to deposit
 * @param {object} [options={}] Operation options
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function depositItem(bot, containerWindow, itemName, count = 1, options = {}) {
  if (!containerWindow || bot.currentWindow !== containerWindow) {
    return createResult(false, 'invalid_window', null, 'Target container window is not open or invalid');
  }

  if (!Number.isInteger(count) || count <= 0) {
    return createResult(false, 'invalid_count', { count }, 'Deposit count must be a positive integer');
  }

  return withInventoryLock(bot, async () => {
    const timeoutMs = options.timeoutMs || 0;
    const abortSignal = options.abortSignal;

    if (abortSignal?.aborted) {
      return createResult(false, 'aborted', { itemName, count }, 'Deposit operation aborted before start');
    }

    const availableItem = bot.inventory?.items?.().find(i => i.name === itemName);
    const availableCount = bot.inventory?.items?.().filter(i => i.name === itemName).reduce((sum, i) => sum + (i.count || 1), 0) || 0;

    if (!availableItem || availableCount < count) {
      return createResult(false, 'missing_item', {
        itemName,
        required: count,
        available: availableCount
      }, 'Insufficient item quantity in player inventory to deposit');
    }

    const initialContainerCount = typeof containerWindow.containerItems === 'function'
      ? containerWindow.containerItems().filter(i => i.name === itemName).reduce((sum, i) => sum + (i.count || 1), 0)
      : 0;

    let timerId = null;
    let abortHandler = null;
    let isTimedOut = false;
    let isAborted = false;

    const cleanup = () => {
      if (timerId) clearTimeout(timerId);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    };

    try {
      const depositPromise = (async () => {
        if (typeof containerWindow.deposit !== 'function') {
          throw new Error('Container window does not support deposit action');
        }
        await containerWindow.deposit(availableItem.type, null, count);
      })();

      const racePromises = [depositPromise];

      if (abortSignal) {
        const abortPromise = new Promise((_, reject) => {
          abortHandler = () => {
            isAborted = true;
            reject(new Error('Deposit operation aborted by caller'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        });
        racePromises.push(abortPromise);
      }

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => {
            isTimedOut = true;
            reject(new Error('Deposit operation timed out'));
          }, timeoutMs);
        });
        racePromises.push(timeoutPromise);
      }

      await Promise.race(racePromises);

      const finalContainerCount = typeof containerWindow.containerItems === 'function'
        ? containerWindow.containerItems().filter(i => i.name === itemName).reduce((sum, i) => sum + (i.count || 1), 0)
        : initialContainerCount + count;

      const depositedCount = finalContainerCount - initialContainerCount;
      if (depositedCount === count) {
        return createResult(true, 'deposited', { itemName, depositedCount }, null);
      }

      return createResult(false, 'error', {
        itemName,
        depositedCount,
        expectedCount: count
      }, 'Deposited quantity did not match expected count');
    } catch (err) {
      const finalContainerCount = typeof containerWindow.containerItems === 'function'
        ? containerWindow.containerItems().filter(i => i.name === itemName).reduce((sum, i) => sum + (i.count || 1), 0)
        : initialContainerCount;

      const depositedCount = finalContainerCount - initialContainerCount;
      if (depositedCount === count) {
        return createResult(true, 'deposited', { itemName, depositedCount }, null);
      }

      if (isAborted || abortSignal?.aborted) {
        return createResult(false, 'aborted', { itemName, count }, 'Deposit operation aborted by caller');
      }
      if (isTimedOut) {
        return createResult(false, 'timeout', { itemName, count }, 'Deposit operation timed out');
      }

      const errMessage = String(err?.message || err || '');
      if (errMessage.toLowerCase().includes('full') || errMessage.toLowerCase().includes('space')) {
        return createResult(false, 'container_full', { itemName }, 'Container has no room to accept deposited item');
      }

      return createResult(false, 'error', { itemName }, errMessage);
    } finally {
      cleanup();
    }
  });
}

/**
 * Withdraw item from open container into player inventory
 * @param {object} bot Mineflayer bot instance
 * @param {object} containerWindow Open container window instance
 * @param {string} itemName Name of item to withdraw
 * @param {number} [count=1] Number of items to withdraw
 * @param {object} [options={}] Operation options
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function withdrawItem(bot, containerWindow, itemName, count = 1, options = {}) {
  if (!containerWindow || bot.currentWindow !== containerWindow) {
    return createResult(false, 'invalid_window', null, 'Target container window is not open or invalid');
  }

  if (!Number.isInteger(count) || count <= 0) {
    return createResult(false, 'invalid_count', { count }, 'Withdraw count must be a positive integer');
  }

  return withInventoryLock(bot, async () => {
    const timeoutMs = options.timeoutMs || 0;
    const abortSignal = options.abortSignal;

    if (abortSignal?.aborted) {
      return createResult(false, 'aborted', { itemName, count }, 'Withdraw operation aborted before start');
    }

    const containerItems = typeof containerWindow.containerItems === 'function'
      ? containerWindow.containerItems()
      : [];

    const availableItem = containerItems.find(i => i.name === itemName);
    const availableCount = containerItems.filter(i => i.name === itemName).reduce((sum, i) => sum + (i.count || 1), 0);

    if (!availableItem || availableCount < count) {
      return createResult(false, 'missing_item', {
        itemName,
        required: count,
        available: availableCount
      }, 'Insufficient item quantity in container to withdraw');
    }

    const initialPlayerCount = bot.inventory?.items?.().filter(i => i.name === itemName).reduce((sum, i) => sum + (i.count || 1), 0) || 0;

    let timerId = null;
    let abortHandler = null;
    let isTimedOut = false;
    let isAborted = false;

    const cleanup = () => {
      if (timerId) clearTimeout(timerId);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    };

    try {
      const withdrawPromise = (async () => {
        if (typeof containerWindow.withdraw !== 'function') {
          throw new Error('Container window does not support withdraw action');
        }
        await containerWindow.withdraw(availableItem.type, null, count);
      })();

      const racePromises = [withdrawPromise];

      if (abortSignal) {
        const abortPromise = new Promise((_, reject) => {
          abortHandler = () => {
            isAborted = true;
            reject(new Error('Withdraw operation aborted by caller'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        });
        racePromises.push(abortPromise);
      }

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => {
            isTimedOut = true;
            reject(new Error('Withdraw operation timed out'));
          }, timeoutMs);
        });
        racePromises.push(timeoutPromise);
      }

      await Promise.race(racePromises);

      const finalPlayerCount = bot.inventory?.items?.().filter(i => i.name === itemName).reduce((sum, i) => sum + (i.count || 1), 0) || (initialPlayerCount + count);
      const withdrawnCount = finalPlayerCount - initialPlayerCount;

      if (withdrawnCount === count) {
        return createResult(true, 'withdrawn', { itemName, withdrawnCount }, null);
      }

      return createResult(false, 'error', {
        itemName,
        withdrawnCount,
        expectedCount: count
      }, 'Withdrawn quantity did not match expected count');
    } catch (err) {
      const finalPlayerCount = bot.inventory?.items?.().filter(i => i.name === itemName).reduce((sum, i) => sum + (i.count || 1), 0) || initialPlayerCount;
      const withdrawnCount = finalPlayerCount - initialPlayerCount;

      if (withdrawnCount === count) {
        return createResult(true, 'withdrawn', { itemName, withdrawnCount }, null);
      }

      if (isAborted || abortSignal?.aborted) {
        return createResult(false, 'aborted', { itemName, count }, 'Withdraw operation aborted by caller');
      }
      if (isTimedOut) {
        return createResult(false, 'timeout', { itemName, count }, 'Withdraw operation timed out');
      }

      const errMessage = String(err?.message || err || '');
      if (errMessage.toLowerCase().includes('full') || errMessage.toLowerCase().includes('space')) {
        return createResult(false, 'inventory_full', { itemName }, 'Player inventory has no room to receive withdrawn item');
      }

      return createResult(false, 'error', { itemName }, errMessage);
    } finally {
      cleanup();
    }
  });
}

/**
 * Transfer item quantity between two specific slots within the container window
 * @param {object} bot Mineflayer bot instance
 * @param {object} containerWindow Open container window instance
 * @param {number} sourceSlot Source slot index
 * @param {number} destSlot Destination slot index
 * @param {number} [count=1] Number of items to transfer
 * @param {object} [options={}] Operation options
 * @param {number} [options.timeoutMs=0] Maximum wait duration
 * @param {AbortSignal} [options.abortSignal] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function transferItem(bot, containerWindow, sourceSlot, destSlot, count = 1, options = {}) {
  if (!containerWindow || bot.currentWindow !== containerWindow) {
    return createResult(false, 'invalid_window', null, 'Target container window is not open or invalid');
  }

  const totalSlots = containerWindow.slots ? containerWindow.slots.length : 0;
  if (!Number.isInteger(sourceSlot) || sourceSlot < 0 || sourceSlot >= totalSlots) {
    return createResult(false, 'invalid_slot', { sourceSlot }, 'Source slot index is out of bounds');
  }

  if (!Number.isInteger(destSlot) || destSlot < 0 || destSlot >= totalSlots) {
    return createResult(false, 'invalid_slot', { destSlot }, 'Destination slot index is out of bounds');
  }

  if (!Number.isInteger(count) || count <= 0) {
    return createResult(false, 'invalid_count', { count }, 'Transfer count must be a positive integer');
  }

  return withInventoryLock(bot, async () => {
    const timeoutMs = options.timeoutMs || 0;
    const abortSignal = options.abortSignal;

    if (abortSignal?.aborted) {
      return createResult(false, 'aborted', { sourceSlot, destSlot, count }, 'Transfer operation aborted before start');
    }

    const sourceItem = containerWindow.slots[sourceSlot];
    if (!sourceItem || (sourceItem.count || 1) < count) {
      return createResult(false, 'missing_item', {
        sourceSlot,
        required: count,
        available: sourceItem ? (sourceItem.count || 1) : 0
      }, 'Source slot does not contain enough items to transfer');
    }

    const initialSourceCount = sourceItem.count || 1;
    const destItem = containerWindow.slots[destSlot];
    const initialDestCount = destItem ? (destItem.count || 1) : 0;

    let timerId = null;
    let abortHandler = null;
    let isTimedOut = false;
    let isAborted = false;

    const cleanup = () => {
      if (timerId) clearTimeout(timerId);
      if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
    };

    try {
      const transferPromise = (async () => {
        if (typeof containerWindow.transferSlot === 'function') {
          await containerWindow.transferSlot(sourceSlot, destSlot, count);
        } else if (typeof bot.clickWindow === 'function') {
          await bot.clickWindow(sourceSlot, 0, 0);
          await bot.clickWindow(destSlot, 0, 0);
        } else {
          throw new Error('Bot does not support slot transfer action');
        }
      })();

      const racePromises = [transferPromise];

      if (abortSignal) {
        const abortPromise = new Promise((_, reject) => {
          abortHandler = () => {
            isAborted = true;
            reject(new Error('Transfer operation aborted by caller'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        });
        racePromises.push(abortPromise);
      }

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => {
            isTimedOut = true;
            reject(new Error('Transfer operation timed out'));
          }, timeoutMs);
        });
        racePromises.push(timeoutPromise);
      }

      await Promise.race(racePromises);

      const finalSource = containerWindow.slots[sourceSlot];
      const finalDest = containerWindow.slots[destSlot];

      const transferred = (!finalSource || finalSource.count < initialSourceCount) &&
        (finalDest && finalDest.count > initialDestCount);

      if (transferred) {
        return createResult(true, 'transferred', {
          sourceSlot,
          destSlot,
          count
        }, null);
      }

      return createResult(false, 'error', { sourceSlot, destSlot }, 'Slot quantities did not change after transfer');
    } catch (err) {
      if (isAborted || abortSignal?.aborted) {
        return createResult(false, 'aborted', { sourceSlot, destSlot, count }, 'Transfer operation aborted by caller');
      }
      if (isTimedOut) {
        return createResult(false, 'timeout', { sourceSlot, destSlot, count }, 'Transfer operation timed out');
      }

      return createResult(false, 'error', { sourceSlot, destSlot }, String(err?.message || err));
    } finally {
      cleanup();
    }
  });
}

/**
 * Close currently open container window cleanly
 * @param {object} bot Mineflayer bot instance
 * @param {object} [containerWindow=null] Open window instance
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function closeContainer(bot, containerWindow = null) {
  const windowToClose = containerWindow || bot.currentWindow;
  if (!windowToClose && !bot.currentWindow) {
    return createResult(true, 'already_closed', null, null);
  }

  try {
    if (typeof bot.closeWindow === 'function') {
      bot.closeWindow(windowToClose || bot.currentWindow);
    } else if (windowToClose && typeof windowToClose.close === 'function') {
      windowToClose.close();
    }

    if (bot.currentWindow === windowToClose) {
      bot.currentWindow = null;
    }

    return createResult(true, 'closed', null, null);
  } catch (err) {
    return createResult(false, 'error', null, String(err?.message || err));
  }
}

module.exports = {
  VALID_CONTAINER_NAMES,
  isContainerBlock,
  openContainer,
  depositItem,
  withdrawItem,
  transferItem,
  closeContainer
};
