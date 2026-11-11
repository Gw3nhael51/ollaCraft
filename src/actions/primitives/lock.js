/**
 * Execute task with bot-level inventory serialization lock
 * @param {object} bot Mineflayer bot instance
 * @param {Function} task Async task to execute exclusively
 * @returns {Promise<any>} Task execution result
 */
async function withInventoryLock(bot, task) {
  const previousLock = bot._inventoryLock || Promise.resolve();
  let release;
  const currentLock = new Promise((resolve) => {
    release = resolve;
  });
  bot._inventoryLock = currentLock;

  try {
    await previousLock;
    return await task();
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
