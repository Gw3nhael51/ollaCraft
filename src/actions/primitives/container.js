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
 * Vérifier si un bloc correspond à un conteneur d'items accessible
 * @param {object|null} block Définition du bloc
 * @returns {boolean} Vrai si le bloc est un conteneur valide
 */
function isContainerBlock(block) {
  if (!block || typeof block.name !== 'string') return false;
  return VALID_CONTAINER_NAMES.has(block.name) || block.name.endsWith('shulker_box');
}

/**
 * Compter le nombre d'exemplaires d'un item dans une liste d'items
 * @param {Array<object>} items Liste d'items à parcourir
 * @param {string} itemName Nom de l'item recherché
 * @returns {number} Quantité totale trouvée
 */
function sumMatchingItems(items, itemName) {
  if (!Array.isArray(items)) return 0;
  return items
    .filter(i => i?.name === itemName)
    .reduce((sum, i) => sum + (i.count || 1), 0);
}

/**
 * Exécuter une opération de conteneur avec surveillance de timeout et de signal d'annulation
 * @param {Function} operationFn Fonction asynchrone à exécuter
 * @param {object} guards Options de surveillance
 * @param {number} guards.timeoutMs Délai maximal en millisecondes
 * @param {AbortSignal} [guards.abortSignal] Signal d'annulation externe
 * @param {string} guards.abortMessage Message en cas d'annulation
 * @param {string} guards.timeoutMessage Message en cas de dépassement de délai
 * @returns {Promise<{ ok: boolean, value?: any, reason?: string, error?: string }>} Résultat de l'exécution
 */
async function runContainerOperationWithGuards(operationFn, guards) {
  const { timeoutMs, abortSignal, abortMessage, timeoutMessage } = guards;
  let timerId = null;
  let abortHandler = null;
  let isTimedOut = false;
  let isAborted = false;

  try {
    const racePromises = [operationFn()];

    if (abortSignal) {
      const abortPromise = new Promise((_, reject) => {
        abortHandler = () => {
          isAborted = true;
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
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    const value = await Promise.race(racePromises);
    return { ok: true, value };
  } catch (err) {
    if (isAborted || abortSignal?.aborted) {
      return { ok: false, reason: 'aborted', error: abortMessage };
    }
    if (isTimedOut) {
      return { ok: false, reason: 'timeout', error: timeoutMessage };
    }
    return { ok: false, reason: 'error', error: String(err?.message || err || '') };
  } finally {
    if (timerId) clearTimeout(timerId);
    if (abortSignal && abortHandler) abortSignal.removeEventListener('abort', abortHandler);
  }
}

/**
 * Fermer la fenêtre courante du bot sans propager d'erreur
 * @param {object} bot Instance du bot Mineflayer
 * @returns {boolean} Vrai si la fermeture a été exécutée
 */
function closeCurrentWindowSafely(bot) {
  if (!bot.currentWindow || typeof bot.closeWindow !== 'function') return false;
  try {
    bot.closeWindow(bot.currentWindow);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ouvrir un bloc conteneur avec validation de portée et de type
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} containerBlock Bloc conteneur cible (coffre, fourneau, tonneau, etc.)
 * @param {object} [options={}] Options de l'opération
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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

    closeCurrentWindowSafely(bot);

    const outcome = await runContainerOperationWithGuards(
      async () => {
        if (typeof bot.openContainer !== 'function') {
          throw new TypeError('Bot does not support openContainer action');
        }
        return bot.openContainer(containerBlock);
      },
      {
        timeoutMs,
        abortSignal,
        abortMessage: 'Open container aborted by caller',
        timeoutMessage: 'Open container timed out'
      }
    );

    const activeWin = outcome.value || bot.currentWindow;
    if (activeWin) {
      return createResult(true, 'opened', {
        window: activeWin,
        containerType: containerBlock.name,
        position: containerBlock.position
      }, null);
    }

    if (!outcome.ok) {
      return createResult(false, outcome.reason, null, outcome.error);
    }
    return createResult(false, 'error', null, 'Container window was not established after opening');
  });
}

/**
 * Déposer un item de l'inventaire du joueur dans la fenêtre de conteneur ouverte
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} containerWindow Fenêtre de conteneur ouverte
 * @param {string} itemName Nom de l'item à déposer
 * @param {number} [count=1] Quantité d'items à déposer
 * @param {object} [options={}] Options de l'opération
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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

    const playerItems = bot.inventory?.items?.() || [];
    const availableItem = playerItems.find(i => i.name === itemName);
    const availableCount = sumMatchingItems(playerItems, itemName);

    if (!availableItem || availableCount < count) {
      return createResult(false, 'missing_item', {
        itemName,
        required: count,
        available: availableCount
      }, 'Insufficient item quantity in player inventory to deposit');
    }

    const readContainerCount = (fallback) => (
      typeof containerWindow.containerItems === 'function'
        ? sumMatchingItems(containerWindow.containerItems(), itemName)
        : fallback
    );

    const initialContainerCount = readContainerCount(0);

    const outcome = await runContainerOperationWithGuards(
      async () => {
        if (typeof containerWindow.deposit !== 'function') {
          throw new TypeError('Container window does not support deposit action');
        }
        await containerWindow.deposit(availableItem.type, null, count);
      },
      {
        timeoutMs,
        abortSignal,
        abortMessage: 'Deposit operation aborted by caller',
        timeoutMessage: 'Deposit operation timed out'
      }
    );

    const fallbackAfter = outcome.ok ? initialContainerCount + count : initialContainerCount;
    const finalContainerCount = readContainerCount(fallbackAfter);
    const depositedCount = finalContainerCount - initialContainerCount;

    if (depositedCount === count) {
      return createResult(true, 'deposited', { itemName, depositedCount }, null);
    }

    if (!outcome.ok) {
      if (outcome.reason === 'aborted' || outcome.reason === 'timeout') {
        return createResult(false, outcome.reason, { itemName, count }, outcome.error);
      }
      const lowerErr = outcome.error.toLowerCase();
      if (lowerErr.includes('full') || lowerErr.includes('space')) {
        return createResult(false, 'container_full', { itemName }, 'Container has no room to accept deposited item');
      }
      return createResult(false, 'error', { itemName }, outcome.error);
    }

    return createResult(false, 'error', {
      itemName,
      depositedCount,
      expectedCount: count
    }, 'Deposited quantity did not match expected count');
  });
}

/**
 * Retirer un item d'un conteneur ouvert vers l'inventaire du joueur
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} containerWindow Fenêtre de conteneur ouverte
 * @param {string} itemName Nom de l'item à retirer
 * @param {number} [count=1] Quantité d'items à retirer
 * @param {object} [options={}] Options de l'opération
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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
    const availableCount = sumMatchingItems(containerItems, itemName);

    if (!availableItem || availableCount < count) {
      return createResult(false, 'missing_item', {
        itemName,
        required: count,
        available: availableCount
      }, 'Insufficient item quantity in container to withdraw');
    }

    const initialPlayerCount = sumMatchingItems(bot.inventory?.items?.() || [], itemName);

    const outcome = await runContainerOperationWithGuards(
      async () => {
        if (typeof containerWindow.withdraw !== 'function') {
          throw new TypeError('Container window does not support withdraw action');
        }
        await containerWindow.withdraw(availableItem.type, null, count);
      },
      {
        timeoutMs,
        abortSignal,
        abortMessage: 'Withdraw operation aborted by caller',
        timeoutMessage: 'Withdraw operation timed out'
      }
    );

    const fallbackAfter = outcome.ok ? initialPlayerCount + count : initialPlayerCount;
    const finalPlayerCount = sumMatchingItems(bot.inventory?.items?.() || [], itemName) || fallbackAfter;
    const withdrawnCount = finalPlayerCount - initialPlayerCount;

    if (withdrawnCount === count) {
      return createResult(true, 'withdrawn', { itemName, withdrawnCount }, null);
    }

    if (!outcome.ok) {
      if (outcome.reason === 'aborted' || outcome.reason === 'timeout') {
        return createResult(false, outcome.reason, { itemName, count }, outcome.error);
      }
      const lowerErr = outcome.error.toLowerCase();
      if (lowerErr.includes('full') || lowerErr.includes('space')) {
        return createResult(false, 'inventory_full', { itemName }, 'Player inventory has no room to receive withdrawn item');
      }
      return createResult(false, 'error', { itemName }, outcome.error);
    }

    return createResult(false, 'error', {
      itemName,
      withdrawnCount,
      expectedCount: count
    }, 'Withdrawn quantity did not match expected count');
  });
}

/**
 * Transférer une quantité d'items entre deux emplacements spécifiques de la fenêtre de conteneur
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} containerWindow Fenêtre de conteneur ouverte
 * @param {number} sourceSlot Index de l'emplacement source
 * @param {number} destSlot Index de l'emplacement de destination
 * @param {number} [count=1] Quantité d'items à transférer
 * @param {object} [options={}] Options de l'opération
 * @param {number} [options.timeoutMs=0] Durée maximale d'attente en millisecondes
 * @param {AbortSignal} [options.abortSignal] Signal d'annulation externe
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
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
    const initialSourceCount = sourceItem ? (sourceItem.count || 1) : 0;
    if (!sourceItem || initialSourceCount < count) {
      return createResult(false, 'missing_item', {
        sourceSlot,
        required: count,
        available: initialSourceCount
      }, 'Source slot does not contain enough items to transfer');
    }

    const destItem = containerWindow.slots[destSlot];
    const initialDestCount = destItem ? (destItem.count || 1) : 0;

    const outcome = await runContainerOperationWithGuards(
      async () => {
        if (typeof containerWindow.transferSlot === 'function') {
          await containerWindow.transferSlot(sourceSlot, destSlot, count);
          return;
        }
        if (typeof bot.clickWindow === 'function') {
          await bot.clickWindow(sourceSlot, 0, 0);
          await bot.clickWindow(destSlot, 0, 0);
          return;
        }
        throw new TypeError('Bot does not support slot transfer action');
      },
      {
        timeoutMs,
        abortSignal,
        abortMessage: 'Transfer operation aborted by caller',
        timeoutMessage: 'Transfer operation timed out'
      }
    );

    if (!outcome.ok) {
      if (outcome.reason === 'aborted' || outcome.reason === 'timeout') {
        return createResult(false, outcome.reason, { sourceSlot, destSlot, count }, outcome.error);
      }
      return createResult(false, 'error', { sourceSlot, destSlot }, outcome.error);
    }

    const finalSource = containerWindow.slots[sourceSlot];
    const finalDest = containerWindow.slots[destSlot];
    const transferred = (!finalSource || finalSource.count < initialSourceCount) &&
      Boolean(finalDest && finalDest.count > initialDestCount);

    if (transferred) {
      return createResult(true, 'transferred', { sourceSlot, destSlot, count }, null);
    }
    return createResult(false, 'error', { sourceSlot, destSlot }, 'Slot quantities did not change after transfer');
  });
}

/**
 * Fermer proprement la fenêtre de conteneur actuellement ouverte
 * @param {object} bot Instance du bot Mineflayer
 * @param {object|null} [containerWindow=null] Instance de la fenêtre ouverte
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat normalisé
 */
async function closeContainer(bot, containerWindow = null) {
  const windowToClose = containerWindow || bot.currentWindow;
  if (!windowToClose && !bot.currentWindow) {
    return createResult(true, 'already_closed', null, null);
  }

  try {
    if (typeof bot.closeWindow === 'function') {
      bot.closeWindow(windowToClose || bot.currentWindow);
    } else if (typeof windowToClose?.close === 'function') {
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
