const DEFAULT_OPTIONS = {
  // Minimum delay between two chat lines, so the server's anti-spam never kicks the bot
  minIntervalMs: 1500,
  // Lines waiting to be sent: when full, the oldest one is dropped
  maxQueue: 5,
  // A line that waited longer than this is outdated and dropped
  maxAgeMs: 20000,
  // An identical line sent or queued within this window is dropped
  dedupeWindowMs: 10000
};

/**
 * Create a rate-limited chat queue. Lines go out immediately while the bot is quiet, then are spaced out.
 * Slash commands (/login, /register, /tp...) are never delayed or dropped: they are what keeps the bot playing.
 * @param {(text: string) => void} send Function that really sends a line to the server
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options] Rate limits
 * @returns {{ enqueue: (text: string) => boolean, pending: () => number, stats: { sent: number, dropped: number } }} Queue
 */
function createChatQueue(send, options = {}) {
  const { minIntervalMs, maxQueue, maxAgeMs, dedupeWindowMs } = { ...DEFAULT_OPTIONS, ...options };
  const stats = { sent: 0, dropped: 0 };
  const recent = new Map();
  let queue = [];
  let lastSentAt = -Infinity;
  let timer = null;

  function deliver(text) {
    send(text);
    lastSentAt = Date.now();
    stats.sent += 1;
  }

  function pump() {
    timer = null;
    const now = Date.now();
    const fresh = queue.filter(item => now - item.at <= maxAgeMs);
    stats.dropped += queue.length - fresh.length;
    queue = fresh;
    if (queue.length === 0) return;

    const wait = lastSentAt + minIntervalMs - now;
    if (wait > 0) {
      timer = setTimeout(pump, wait);
      return;
    }
    deliver(queue.shift().text);
    if (queue.length > 0) timer = setTimeout(pump, minIntervalMs);
  }

  /**
   * Send a line now if allowed, otherwise queue it
   * @param {string} text Chat line or slash command
   * @returns {boolean} False when the line was dropped
   */
  function enqueue(text) {
    const now = Date.now();
    if (text.startsWith('/')) {
      deliver(text);
      return true;
    }

    for (const [line, at] of recent) {
      if (now - at > dedupeWindowMs) recent.delete(line);
    }
    if (recent.has(text)) {
      stats.dropped += 1;
      return false;
    }
    recent.set(text, now);

    if (queue.length >= maxQueue) {
      queue.shift();
      stats.dropped += 1;
    }
    queue.push({ text, at: now });
    if (!timer) pump();
    return true;
  }

  return { enqueue, pending: () => queue.length, stats };
}

/**
 * Route every bot.chat() call of the project through a rate-limited queue.
 * Mineflayer only defines bot.chat when its plugins are injected (on 'inject_allowed', after createBot returns),
 * so when it is not there yet the queue is installed on that event, right after the plugins.
 * @param {object} bot Mineflayer bot instance
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options] Rate limits
 * @returns {ReturnType<typeof createChatQueue>} The queue
 */
function installChatQueue(bot, options = {}) {
  let originalChat = null;
  const queue = createChatQueue(text => originalChat(text), options);

  const install = () => {
    originalChat = bot.chat.bind(bot);
    bot.chat = message => { queue.enqueue(String(message)); };
  };

  if (typeof bot.chat === 'function') install();
  else bot.once('inject_allowed', install);
  return queue;
}

module.exports = { createChatQueue, installChatQueue, DEFAULT_OPTIONS };
