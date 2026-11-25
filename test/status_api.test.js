const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const mcData = require('minecraft-data')('1.20.4');
const config = require('../src/infrastructure/config');
const { buildSnapshot, resetQuestCache } = require('../src/api/snapshot');
const { createStatusServer, isValidKey } = require('../src/api/server');

/**
 * Create a minimal bot carrying a wooden pickaxe and 4 logs
 * @returns {object} Fake Mineflayer bot
 */
function createFakeBot() {
  const bot = new EventEmitter();
  const slots = new Array(46).fill(null);
  slots[9] = { name: 'wooden_pickaxe', count: 1, type: mcData.itemsByName.wooden_pickaxe.id };
  slots[10] = { name: 'oak_log', count: 4, type: mcData.itemsByName.oak_log.id };
  Object.assign(bot, {
    username: 'Ollama',
    registry: mcData,
    health: 18,
    food: 15,
    game: { dimension: 'minecraft:overworld' },
    entity: { position: new Vec3(10.4, 64, -5.6) },
    inventory: { slots, items: () => slots.filter(Boolean) },
    findBlock: () => null,
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
  });
  return bot;
}

/**
 * Create the slice of global state read by the snapshot
 * @returns {object} Fake state
 */
function createState() {
  return {
    isSurviving: true,
    currentObjective: 'cobblestone',
    manualObjective: false,
    manualObjectiveQty: 1,
    managerDirective: 'Miner de la pierre.',
    managerSubGoal: null,
    lastActionResult: { action: 'mine', target: 'stone', success: true, message: 'ok' },
    actionHistory: [{ action: 'craft', target: 'wooden_pickaxe', success: true }],
    lastDecisionSource: 'planner',
    waypoints: { spawn_bed: { x: 1, y: 70, z: 2, dimension: 'overworld' } },
    milestones: { nether_portal_built: true },
    stronghold: { throws: [], estimate: null, located: false, reached: false },
    endPortal: { center: null, frameCount: 0, filledCount: 0 },
    currentAdvancement: 'Stone Age',
    unlockedAdvancements: ['Minecraft'],
    metrics: { deterministicDecisions: 3, llmDecisions: 1 },
    tokenStats: { totalTokens: 42 }
  };
}

test('snapshot reports position, inventory, objective and the ordered quest chain', () => {
  resetQuestCache();
  const snap = buildSnapshot(createFakeBot(), createState(), { startedAt: 0, now: 5000 });

  assert.equal(snap.username, 'Ollama');
  assert.equal(snap.connected, true);
  assert.equal(snap.dimension, 'overworld');
  assert.deepEqual(snap.position, { x: 10, y: 64, z: -6 });
  assert.equal(snap.inventory.oak_log, 4);
  assert.equal(snap.inventory_slots.length, 36);
  assert.deepEqual(snap.inventory_slots[0], { name: 'wooden_pickaxe', count: 1 });
  assert.deepEqual(snap.inventory_slots[1], { name: 'oak_log', count: 4 });
  assert.equal(snap.inventory_slots[35], null);
  assert.equal(snap.objective.id, 'cobblestone');
  assert.equal(snap.objective.sub_goal, null);
  assert.equal(snap.uptime_seconds, 5);
  assert.deepEqual(snap.quests.map(q => q.id), config.QUEST_CHAIN);
  assert.equal(snap.quests.find(q => q.id === 'wooden_pickaxe').done, true);
  assert.equal(snap.quests.filter(q => q.current).map(q => q.id).join(), 'cobblestone');
  assert.equal(snap.waypoints[0].name, 'spawn_bed');
  assert.equal(snap.milestones.nether_portal_built, true);
});

test('snapshot of a bot that has not spawned yet carries no world data', () => {
  resetQuestCache();
  const bot = createFakeBot();
  bot.entity = undefined;
  const snap = buildSnapshot(bot, createState());

  assert.equal(snap.connected, false);
  assert.equal(snap.position, null);
  assert.deepEqual(snap.quests, []);
  assert.deepEqual(snap.inventory, {});
});

test('isValidKey only accepts the exact configured key', () => {
  assert.equal(isValidKey('secret', 'secret'), true);
  assert.equal(isValidKey('secre', 'secret'), false);
  assert.equal(isValidKey(undefined, 'secret'), false);
  assert.equal(isValidKey('secret', ''), false);
});

test('status server requires the API key, keeps /health public and rejects other routes', async () => {
  resetQuestCache();
  const server = createStatusServer(createFakeBot(), createState(), { apiKey: 'secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/status`, { headers: { 'x-api-key': 'wrong' } })).status, 401);

    const ok = await fetch(`${base}/status`, { headers: { 'x-api-key': 'secret' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).username, 'Ollama');

    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/status`, { method: 'POST', headers: { 'x-api-key': 'secret' } })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('snapshot turns an object sub-goal into text', () => {
  resetQuestCache();
  const state = createState();
  state.managerSubGoal = { action: 'procedure', target: 'build_portal', isReliable: true };
  assert.equal(buildSnapshot(createFakeBot(), state).objective.sub_goal, 'procedure build_portal');
});
