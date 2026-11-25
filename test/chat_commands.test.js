const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const mcData = require('minecraft-data')('1.20.4');

/**
 * Create an event-driven stand-in for the Mineflayer bot so the entry point can be loaded offline
 * @returns {object} Fake bot recording the chat lines it sends
 */
function createFakeBot() {
  const bot = new EventEmitter();
  const slots = new Array(46).fill(null);
  slots[9] = { name: 'stone_pickaxe', count: 1, type: mcData.itemsByName.stone_pickaxe.id };

  Object.assign(bot, {
    username: 'Ollama',
    version: '1.20.4',
    registry: mcData,
    health: 20,
    food: 20,
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(10, 64, -5), isInWater: false },
    entities: {},
    inventory: { slots, items: () => slots.filter(Boolean) },
    messages: [],
    loadPlugin() {},
    chat(message) { bot.messages.push(message); },
    findBlock: () => null,
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    recipesFor: () => [],
    pathfinder: { setGoal() {}, setMovements() {}, goto: async () => {} },
    clearControlStates() {},
    setControlState() {},
    stopDigging() {}
  });
  return bot;
}

test('Entry point chat commands: direct objective, debug loop-breaker, plan, waypoints, death and respawn', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollacraft-chat-'));
  const fakeBot = createFakeBot();
  const mineflayerPath = require.resolve('mineflayer');
  const originalModule = require.cache[mineflayerPath];
  require.cache[mineflayerPath] = {
    id: mineflayerPath,
    filename: mineflayerPath,
    loaded: true,
    exports: { createBot: () => fakeBot }
  };

  try {
    const state = require('../src/core/state');
    // Keep the autonomous loop (and therefore any model call) from starting during this test
    state.hasStarted = true;
    require('../src/index.js');

    // Never read from or write to a real progress file
    state.progressFile = path.join(tempDir, 'progress.json');
    state.waypoints = {};
    state.milestones = {};
    state.stronghold = { throws: [], estimate: null, located: false, reached: false };

    const sendChat = async (text) => {
      fakeBot.messages.length = 0;
      fakeBot.emit('chat', 'Kaizz', text);
      await new Promise(resolve => setImmediate(resolve));
      return [...fakeBot.messages];
    };

    fakeBot.emit('spawn');
    assert.equal(state.lastDimension, 'overworld');

    // Direct objective: the bot announces the chain it will build first (iron pickaxe before diamond)
    const goalReply = await sendChat('objectif diamant 2');
    assert.equal(state.manualObjective, true);
    assert.equal(state.currentObjective, 'diamond');
    assert.equal(state.manualObjectiveQty, 2);
    assert.ok(goalReply[0].includes('2x diamond'));
    const planLine = goalReply.find(line => line.startsWith('Plan :'));
    assert.ok(planLine.indexOf('craft iron_pickaxe') !== -1);
    assert.ok(planLine.indexOf('craft iron_pickaxe') < planLine.indexOf('mine diamond_ore'));

    assert.ok((await sendChat('plan'))[0].startsWith('Objectif diamond x2'));
    assert.match((await sendChat('objectif licorne_magique'))[0], /Objectif inconnu/);
    assert.equal(state.currentObjective, 'diamond');

    // Debug report only
    const info = await sendChat('debug info');
    assert.equal(info.length, 4);
    assert.ok(info.every(line => line.startsWith('[DEBUG]')));
    assert.equal(state.recovery?.forcedQueue?.length || 0, 0);

    // Debug while stopped has nothing to break
    assert.match((await sendChat('debug')).at(-1), /Mode autonome arrêté/);

    // Debug while running: the last action is refused and a different one is queued
    state.isSurviving = true;
    state.lastActionResult = { action: 'mine', target: 'iron_ore', success: false, message: 'Block unreachable' };
    state.actionHistory = [{ action: 'mine', target: 'iron_ore', success: false }];
    const debugReply = await sendChat('debug');
    state.isSurviving = false;
    assert.match(debugReply.at(-1), /Déblocage forcé -> /);
    assert.match(debugReply.at(-1), /mine iron_ore/);
    assert.ok(state.recovery.forcedQueue.length >= 1);
    assert.notEqual(`${state.recovery.forcedQueue[0].action}:${state.recovery.forcedQueue[0].target}`, 'mine:iron_ore');

    assert.match((await sendChat('waypoints'))[0], /Aucun point de repère/);

    // Walking through the portal records both sides
    fakeBot.game.dimension = 'the_nether';
    fakeBot.entity.position = new Vec3(2, 70, 3);
    fakeBot.emit('spawn');
    assert.equal(state.waypoints.nether_exit.dimension, 'the_nether');

    fakeBot.game.dimension = 'overworld';
    fakeBot.entity.position = new Vec3(40, 65, 80);
    fakeBot.emit('spawn');
    assert.deepEqual([state.waypoints.nether_portal.x, state.waypoints.nether_portal.z], [40, 80]);
    assert.equal((await sendChat('waypoints')).length, 2);

    // Dying in the Nether keeps the portal coordinates: a respawn is not a portal trip
    fakeBot.game.dimension = 'the_nether';
    fakeBot.entity.position = new Vec3(-30, 50, 12);
    fakeBot.emit('spawn');
    fakeBot.emit('death');
    assert.equal(state.waypoints.death.dimension, 'the_nether');
    fakeBot.game.dimension = 'overworld';
    fakeBot.entity.position = new Vec3(900, 70, 900);
    fakeBot.emit('spawn');
    assert.deepEqual([state.waypoints.nether_portal.x, state.waypoints.nether_portal.z], [40, 80]);

    // Respawning away from the recorded spawn bed means the bed is gone
    state.waypoints.spawn_bed = { x: 40, y: 65, z: 78, dimension: 'overworld', savedAt: Date.now() };
    state.milestones.active_spawn = 'spawn_bed';
    fakeBot.emit('death');
    fakeBot.messages.length = 0;
    fakeBot.entity.position = new Vec3(0, 70, 0);
    fakeBot.emit('spawn');
    assert.equal(state.waypoints.spawn_bed, undefined);
    assert.ok(fakeBot.messages.some(line => /lit n'existe plus/.test(line)));

    // Respawning next to it keeps it
    state.waypoints.spawn_bed = { x: 2, y: 70, z: 1, dimension: 'overworld', savedAt: Date.now() };
    state.milestones.active_spawn = 'spawn_bed';
    fakeBot.emit('death');
    fakeBot.emit('spawn');
    assert.ok(state.waypoints.spawn_bed);

    // Back to the automatic chain, and the metrics line
    await sendChat('objectif auto');
    assert.equal(state.manualObjective, false);
    assert.equal((await sendChat('tokens')).length, 2);
  } finally {
    if (originalModule) require.cache[mineflayerPath] = originalModule;
    else delete require.cache[mineflayerPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
