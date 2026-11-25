const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createChatQueue, installChatQueue } = require('../src/core/chat');

const OPTIONS = { minIntervalMs: 1000, maxQueue: 3, maxAgeMs: 5000, dedupeWindowMs: 4000 };

/**
 * Build a queue on a mocked clock that records what is sent
 * @param {object} t Test context
 * @returns {{ queue: object, sent: string[] }} Queue and sent lines
 */
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  return { queue: createChatQueue(line => sent.push(line), OPTIONS), sent };
}

test('the first line goes out immediately, the next ones are spaced out', t => {
  const { queue, sent } = setup(t);
  queue.enqueue('a');
  queue.enqueue('b');
  queue.enqueue('c');
  assert.deepEqual(sent, ['a']);

  t.mock.timers.tick(1000);
  assert.deepEqual(sent, ['a', 'b']);
  t.mock.timers.tick(1000);
  assert.deepEqual(sent, ['a', 'b', 'c']);
});

test('an identical line is dropped inside the dedupe window and allowed after it', t => {
  const { queue, sent } = setup(t);
  queue.enqueue('Action : mine');
  queue.enqueue('Action : mine');
  assert.deepEqual(sent, ['Action : mine']);
  assert.equal(queue.stats.dropped, 1);

  t.mock.timers.tick(4500);
  queue.enqueue('Action : mine');
  assert.deepEqual(sent, ['Action : mine', 'Action : mine']);
});

test('slash commands are never delayed nor dropped', t => {
  const { queue, sent } = setup(t);
  queue.enqueue('hello');
  queue.enqueue('/login secret');
  queue.enqueue('/login secret');
  assert.deepEqual(sent, ['hello', '/login secret', '/login secret']);
});

test('a full queue drops its oldest line', t => {
  const { queue, sent } = setup(t);
  ['l0', 'l1', 'l2', 'l3', 'l4'].forEach(line => queue.enqueue(line));
  // l0 left at once; l1..l4 compete for 3 slots, l1 is dropped
  assert.equal(queue.pending(), 3);
  for (let i = 0; i < 3; i += 1) t.mock.timers.tick(1000);
  assert.deepEqual(sent, ['l0', 'l2', 'l3', 'l4']);
});

test('a line that waited too long is dropped as outdated', t => {
  const { queue, sent } = setup(t);
  queue.enqueue('first');
  queue.enqueue('stale');
  t.mock.timers.tick(100);
  // The clock jumps well past maxAgeMs before the queue gets to run again
  t.mock.timers.tick(6000);
  assert.deepEqual(sent, ['first']);
  assert.equal(queue.pending(), 0);
});

test('installChatQueue replaces bot.chat and keeps sending through the original', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const bot = { chat: line => sent.push(line) };
  installChatQueue(bot, OPTIONS);

  bot.chat('one');
  bot.chat('two');
  assert.deepEqual(sent, ['one']);
  t.mock.timers.tick(1000);
  assert.deepEqual(sent, ['one', 'two']);
});

test('installChatQueue waits for the plugins when bot.chat is not defined yet', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const bot = new EventEmitter();
  // Like mineflayer, whose chat plugin defines bot.chat when 'inject_allowed' fires
  bot.once('inject_allowed', () => { bot.chat = line => sent.push(line); });

  installChatQueue(bot, OPTIONS);
  assert.equal(bot.chat, undefined);

  bot.emit('inject_allowed');
  bot.chat('one');
  bot.chat('two');
  assert.deepEqual(sent, ['one']);
  t.mock.timers.tick(1000);
  assert.deepEqual(sent, ['one', 'two']);
});
