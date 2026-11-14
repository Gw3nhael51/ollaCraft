const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');

const {
  gotoCoordinates,
  jump,
  stopMovement,
  clearMovementControls,
  lookAtPosition
} = require('../src/actions/primitives/movement');

const {
  breakBlockAt,
  placeBlockOnFace,
  VALID_FACES,
  isValidFaceVector,
  checkBotBodyCollision
} = require('../src/actions/primitives/blocks');

/**
 * Build a mock bot specifically configured for primitive validation
 * @param {object} [customProps={}] Overrides for bot methods and properties
 * @returns {object} Mock bot instance
 */
function createPrimitiveMockBot(customProps = {}) {
  const worldMap = new Map();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

  const position = new Vec3(0, 64, 0);
  const velocity = new Vec3(0, 0, 0);
  const controlStates = {};
  const listeners = {};

  const bot = {
    entity: {
      position,
      velocity
    },
    controlStates,
    setControlState(control, state) {
      controlStates[control] = Boolean(state);
    },
    clearControlStates() {
      Object.keys(controlStates).forEach((k) => {
        controlStates[k] = false;
      });
    },
    on(event, handler) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    removeListener(event, handler) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((h) => h !== handler);
    },
    emit(event, ...args) {
      if (!listeners[event]) return;
      [...listeners[event]].forEach((h) => h(...args));
    },
    blockAt(vec) {
      const k = key(vec);
      if (worldMap.has(k)) {
        return worldMap.get(k);
      }
      return {
        name: 'air',
        diggable: false,
        boundingBox: 'empty',
        position: new Vec3(vec.x, vec.y, vec.z)
      };
    },
    setBlock(vec, blockDef) {
      worldMap.set(key(vec), {
        name: blockDef.name || 'stone',
        diggable: blockDef.diggable !== undefined ? blockDef.diggable : true,
        boundingBox: blockDef.boundingBox || 'block',
        position: new Vec3(vec.x, vec.y, vec.z)
      });
    },
    canDigBlock(block) {
      return Boolean(block?.diggable);
    },
    dig: async (block) => {
      worldMap.set(key(block.position), {
        name: 'air',
        diggable: false,
        boundingBox: 'empty',
        position: block.position
      });
    },
    stopDigging() {},
    placeBlock: async (refBlock, faceVec) => {
      const placedPos = refBlock.position.plus(faceVec);
      worldMap.set(key(placedPos), {
        name: 'stone',
        diggable: true,
        boundingBox: 'block',
        position: placedPos
      });
    },
    equip: async () => {},
    lookAt: async () => {},
    inventory: {
      items: () => [{ name: 'stone', count: 64 }]
    },
    pathfinder: {
      goto: async () => {},
      setGoal: () => {},
      stop: () => {}
    },
    ...customProps
  };

  return bot;
}

test('Navigation: Destination reached returns reached reason and verified distance', async () => {
  const bot = createPrimitiveMockBot();
  bot.entity.position = new Vec3(10, 64, 10);

  const res = await gotoCoordinates(bot, 10, 64, 10, { range: 1 });
  assert.equal(res.success, true);
  assert.equal(res.reason, 'reached');
  assert.equal(res.error, null);
  assert.ok(res.data.distance <= 1);
  assert.deepEqual(res.data.position, { x: 10, y: 64, z: 10 });
});

test('Navigation: No path returns no_path reason', async () => {
  const bot = createPrimitiveMockBot({
    pathfinder: {
      goto: async () => {
        const err = new Error('NoPath found to target');
        err.name = 'NoPath';
        throw err;
      },
      setGoal: () => {},
      stop: () => {}
    }
  });

  const res = await gotoCoordinates(bot, 50, 64, 50);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'no_path');
  assert.ok(res.data);
  assert.ok(res.error.includes('NoPath'));
});

test('Navigation: Timeout halts pathfinder and returns timeout reason', async () => {
  let goalCleared = false;
  let stopped = false;

  const bot = createPrimitiveMockBot({
    pathfinder: {
      goto: () => new Promise(() => {}),
      setGoal: (g) => {
        if (g === null) goalCleared = true;
      },
      stop: () => {
        stopped = true;
      }
    }
  });

  const res = await gotoCoordinates(bot, 30, 64, 30, { timeoutMs: 30 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'timeout');
  assert.equal(goalCleared, true);
  assert.equal(stopped, true);
});

test('Navigation: AbortSignal stops navigation immediately', async () => {
  const controller = new AbortController();
  let goalCleared = false;

  const bot = createPrimitiveMockBot({
    pathfinder: {
      goto: () => new Promise((resolve) => setTimeout(resolve, 500)),
      setGoal: (g) => {
        if (g === null) goalCleared = true;
      },
      stop: () => {}
    }
  });

  setTimeout(() => controller.abort(), 20);

  const res = await gotoCoordinates(bot, 20, 64, 20, { abortSignal: controller.signal });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'aborted');
  assert.equal(goalCleared, true);
});

test('Navigation: Invalid coordinates return invalid_target', async () => {
  const bot = createPrimitiveMockBot();
  const res = await gotoCoordinates(bot, 'invalid', null, NaN);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'invalid_target');
  assert.equal(res.data, null);
});

test('Navigation: Concurrent calls do not let late task interrupt newer navigation', async () => {
  let firstCallStopped = false;
  let secondCallFinished = false;

  const bot = createPrimitiveMockBot({
    pathfinder: {
      goto: async (goal) => {
        if (goal.x === 10) {
          await new Promise((r) => setTimeout(r, 60));
          return;
        }
        if (goal.x === 20) {
          await new Promise((r) => setTimeout(r, 20));
          secondCallFinished = true;
        }
      },
      setGoal: () => {},
      stop: () => {
        firstCallStopped = true;
      }
    }
  });

  bot.entity.position = new Vec3(20, 64, 20);

  const promise1 = gotoCoordinates(bot, 10, 64, 10);
  const promise2 = gotoCoordinates(bot, 20, 64, 20);

  const [res1, res2] = await Promise.all([promise1, promise2]);

  assert.equal(secondCallFinished, true);
  assert.equal(res2.success, true);
  assert.equal(res2.reason, 'reached');
  assert.equal(res1.success, false);
  assert.equal(res1.reason, 'aborted');
});

test('Jump: Apex detection resolves with gained vertical altitude', async () => {
  const bot = createPrimitiveMockBot();
  bot.entity.position = new Vec3(0, 64, 0);

  const jumpPromise = jump(bot, { waitForApex: true, timeoutMs: 500 });

  setTimeout(() => {
    bot.entity.position.y = 64.6;
    bot.entity.velocity.y = 0.4;
    bot.emit('physicTick');
  }, 20);

  setTimeout(() => {
    bot.entity.position.y = 65.2;
    bot.entity.velocity.y = 0;
    bot.emit('physicTick');
  }, 40);

  const res = await jumpPromise;
  assert.equal(res.success, true);
  assert.equal(res.reason, 'apex_reached');
  assert.equal(bot.controlStates.jump, false);
  assert.ok(res.data.peakY >= 65.2);
  assert.ok(res.data.heightGained >= 1.2);
});

test('Jump: Timeout releases jump control state', async () => {
  const bot = createPrimitiveMockBot();
  const res = await jump(bot, { waitForApex: true, timeoutMs: 30 });

  assert.equal(res.success, false);
  assert.equal(res.reason, 'timeout');
  assert.equal(bot.controlStates.jump, false);
});

test('Mining: Break diggable block within reach returns broken and verifies world', async () => {
  const bot = createPrimitiveMockBot();
  const pos = { x: 1, y: 64, z: 0 };
  bot.setBlock(pos, { name: 'stone', diggable: true });

  const res = await breakBlockAt(bot, pos);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'broken');
  assert.equal(res.data.blockName, 'stone');
  assert.equal(bot.blockAt(new Vec3(pos.x, pos.y, pos.z)).name, 'air');
});

test('Mining: Block out of reach returns out_of_reach without digging', async () => {
  const bot = createPrimitiveMockBot();
  const pos = { x: 8, y: 64, z: 0 };
  bot.setBlock(pos, { name: 'stone', diggable: true });

  let digCalled = false;
  bot.dig = async () => { digCalled = true; };

  const res = await breakBlockAt(bot, pos, { maxDistance: 4.5 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'out_of_reach');
  assert.equal(digCalled, false);
});

test('Mining: Bedrock returns unbreakable', async () => {
  const bot = createPrimitiveMockBot();
  const pos = { x: 1, y: 64, z: 0 };
  bot.setBlock(pos, { name: 'bedrock', diggable: false });

  const res = await breakBlockAt(bot, pos);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'unbreakable');
  assert.equal(res.data.blockName, 'bedrock');
});

test('Mining: Empty position returns air', async () => {
  const bot = createPrimitiveMockBot();
  const res = await breakBlockAt(bot, { x: 1, y: 64, z: 0 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'air');
});

test('Mining: AbortSignal interrupts digging and calls stopDigging', async () => {
  let stopDiggingCalled = false;
  const controller = new AbortController();

  const bot = createPrimitiveMockBot({
    dig: () => new Promise((resolve) => setTimeout(resolve, 500)),
    stopDigging: () => {
      stopDiggingCalled = true;
    }
  });

  const pos = { x: 1, y: 64, z: 0 };
  bot.setBlock(pos, { name: 'obsidian', diggable: true });

  setTimeout(() => controller.abort(), 20);

  const res = await breakBlockAt(bot, pos, { abortSignal: controller.signal });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'aborted');
  assert.equal(stopDiggingCalled, true);
});

test('Mining: Failure to break block in world returns error', async () => {
  const bot = createPrimitiveMockBot({
    dig: async () => {}
  });

  const pos = { x: 1, y: 64, z: 0 };
  bot.setBlock(pos, { name: 'iron_ore', diggable: true });

  const res = await breakBlockAt(bot, pos);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'error');
  assert.ok(res.error.includes('intact'));
});

test('Placement: Valid face and free destination places block successfully', async () => {
  const bot = createPrimitiveMockBot();
  bot.entity.position = new Vec3(3, 64, 0);

  const refPos = { x: 1, y: 63, z: 0 };
  bot.setBlock(refPos, { name: 'stone', diggable: true });

  const faceVec = { x: 0, y: 1, z: 0 };
  const res = await placeBlockOnFace(bot, 'stone', refPos, faceVec);

  assert.equal(res.success, true);
  assert.equal(res.reason, 'placed');
  assert.deepEqual(res.data.position, { x: 1, y: 64, z: 0 });
});

test('Placement: Missing inventory item returns missing_item', async () => {
  const bot = createPrimitiveMockBot();
  const refPos = { x: 1, y: 63, z: 0 };
  bot.setBlock(refPos, { name: 'stone' });

  const res = await placeBlockOnFace(bot, 'diamond_block', refPos, { x: 0, y: 1, z: 0 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'missing_item');
});

test('Placement: Diagonal or invalid face vector returns invalid_face', async () => {
  const bot = createPrimitiveMockBot();
  const refPos = { x: 1, y: 63, z: 0 };
  bot.setBlock(refPos, { name: 'stone' });

  const res = await placeBlockOnFace(bot, 'stone', refPos, { x: 1, y: 1, z: 0 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'invalid_face');
});

test('Placement: Intersection with bot body returns body_collision', async () => {
  const bot = createPrimitiveMockBot();
  bot.entity.position = new Vec3(0, 64, 0);

  const refPos = { x: 0, y: 63, z: 0 };
  bot.setBlock(refPos, { name: 'stone' });

  const faceVec = { x: 0, y: 1, z: 0 };
  const res = await placeBlockOnFace(bot, 'stone', refPos, faceVec);

  assert.equal(res.success, false);
  assert.equal(res.reason, 'body_collision');
  assert.deepEqual(res.data.position, { x: 0, y: 64, z: 0 });
});

test('Placement: Occupied destination returns occupied', async () => {
  const bot = createPrimitiveMockBot();
  bot.entity.position = new Vec3(3, 64, 0);

  const refPos = { x: 1, y: 63, z: 0 };
  bot.setBlock(refPos, { name: 'stone' });
  bot.setBlock({ x: 1, y: 64, z: 0 }, { name: 'cobblestone' });

  const res = await placeBlockOnFace(bot, 'stone', refPos, { x: 0, y: 1, z: 0 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'occupied');
  assert.equal(res.data.blockName, 'cobblestone');
});
