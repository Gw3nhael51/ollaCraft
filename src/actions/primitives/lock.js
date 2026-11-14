const { AsyncLocalStorage } = require('node:async_hooks');

const lockStorage = new AsyncLocalStorage();

/**
 * Execute task with reentrant bot-level inventory serialization lock
 * @param {object} bot Mineflayer bot instance
 * @param {Function} task Async task to execute exclusively
 * @returns {Promise<any>} Task execution result
 */
async function withInventoryLock(bot, task) {
  const currentOwner = lockStorage.getStore();
  if (currentOwner === bot) {
    return await task();
  }

  const previousLock = bot._inventoryLock || Promise.resolve();
  let release;
  const currentLock = new Promise((resolve) => {
    release = resolve;
  });
  bot._inventoryLock = currentLock;

  try {
    await previousLock;
    return await lockStorage.run(bot, task);
  } finally {
    release();
    if (bot._inventoryLock === currentLock) {
      bot._inventoryLock = null;
    }
  }
}

module.exports = {
  withInventoryLock
};
