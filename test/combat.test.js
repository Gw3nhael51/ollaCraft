const test = require('node:test');
const assert = require('node:assert/strict');
const mcData = require('minecraft-data')('1.20.4');

const {
  inspectTargetEntity,
  autoEquipBestWeapon,
  faceTarget,
  attackEntity,
  followEntity
} = require('../src/actions/primitives/combat');

/**
 * Build a mock bot for combat and entity tracking testing
 * @param {Array<{ name: string, count?: number }>} [inventoryItems=[]] Inventory items
 * @param {Record<string, object>} [entitiesMap={}] Entities map in bot world
 * @param {object} [customProps={}] Overrides for bot methods and properties
 * @returns {object} Mock bot instance
 */
function createCombatMockBot(inventoryItems = [], entitiesMap = {}, customProps = {}) {
  const slots = new Array(46).fill(null);
  inventoryItems.forEach((it, idx) => {
    const def = mcData.itemsByName[it.name] || { id: idx + 100, name: it.name };
    slots[idx + 9] = {
      name: it.name,
      count: it.count || 1,
      type: def.id,
      slot: idx + 9
    };
  });

  let lookedAt = null;
  let equippedItem = null;
  let activeGoal = null;

  const bot = {
    version: '1.20.4',
    registry: mcData,
    heldItem: null,
    entities: { ...entitiesMap },
    entity: {
      position: {
        x: 0,
        y: 64,
        z: 0,
        distanceTo: (pos) => Math.hypot(pos.x, pos.y - 64, pos.z)
      }
    },
    inventory: {
      slots,
      items: () => slots.slice(9, 45).filter(Boolean)
    },
    equip: async (item, _slot) => {
      equippedItem = item.name;
      bot.heldItem = item;
    },
    lookAt: async (pos) => {
      lookedAt = pos;
    },
    attack: (target) => {
      if (target.health !== undefined) {
        target.health = Math.max(0, target.health - 6);
      }
      if (target.health <= 0) {
        target.isValid = false;
      }
    },
    pathfinder: {
      setGoal: (goal) => {
        activeGoal = goal;
      },
      stop: () => {
        activeGoal = null;
      }
    },
    clearControlStates: () => {},
    getLookedAt: () => lookedAt,
    getEquippedItem: () => equippedItem,
    getActiveGoal: () => activeGoal,
    ...customProps
  };

  return bot;
}

test('Combat: Distinguishes dead entity from lost entity', () => {
  const bot = createCombatMockBot([], {
    10: { id: 10, name: 'zombie', health: 20, isValid: true }
  });

  const liveTarget = bot.entities[10];
  assert.equal(inspectTargetEntity(bot, liveTarget).valid, true);

  const deadTarget = { id: 11, name: 'zombie', health: 0, isValid: false };
  assert.equal(inspectTargetEntity(bot, deadTarget).reason, 'target_dead');

  const lostTarget = { id: 99, name: 'skeleton', health: 15, isValid: true };
  assert.equal(inspectTargetEntity(bot, lostTarget).reason, 'target_lost');

  assert.equal(inspectTargetEntity(bot, null).reason, 'invalid_target');
});

test('Combat: Attack alive entity auto-equips best weapon and inflicts damage', async () => {
  const target = {
    id: 1,
    name: 'spider',
    health: 16,
    isValid: true,
    height: 1.0,
    position: { x: 2, y: 64, z: 0, offset: () => ({ x: 2, y: 64.8, z: 0 }) }
  };

  const bot = createCombatMockBot(
    [{ name: 'iron_sword', count: 1 }, { name: 'wooden_axe', count: 1 }],
    { 1: target }
  );

  const res = await attackEntity(bot, target);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'attacked');
  assert.equal(bot.getEquippedItem(), 'iron_sword');
  assert.ok(target.health < 16);
  assert.equal(res.data.damageDealt, 6);
});

test('Combat: Attack dead entity returns target_dead without attack', async () => {
  const deadTarget = {
    id: 2,
    name: 'zombie',
    health: 0,
    isValid: false,
    position: { x: 1, y: 64, z: 0 }
  };

  const bot = createCombatMockBot([], { 2: deadTarget });
  const res = await attackEntity(bot, deadTarget);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'target_dead');
});

test('Combat: Attack target out of reach returns out_of_reach', async () => {
  const farTarget = {
    id: 3,
    name: 'creeper',
    health: 20,
    isValid: true,
    position: { x: 8, y: 64, z: 0, offset: () => ({ x: 8, y: 65, z: 0 }) }
  };

  const bot = createCombatMockBot([], { 3: farTarget });
  const res = await attackEntity(bot, farTarget, { maxDistance: 3.5 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'out_of_reach');
});

test('Combat: Follow entity succeeds when reaching requested range', async () => {
  const target = {
    id: 4,
    name: 'cow',
    health: 10,
    isValid: true,
    position: { x: 1.5, y: 64, z: 0 }
  };

  const bot = createCombatMockBot([], { 4: target });
  const res = await followEntity(bot, target, { range: 2, timeoutMs: 200 });

  assert.equal(res.success, true);
  assert.equal(res.reason, 'reached');
  assert.equal(res.data.entityId, 4);
});

test('Combat: Follow entity halts immediately if target dies during tracking', async () => {
  const target = {
    id: 5,
    name: 'pig',
    health: 10,
    isValid: true,
    position: { x: 6, y: 64, z: 0 }
  };

  const bot = createCombatMockBot([], { 5: target });

  setTimeout(() => {
    target.health = 0;
    target.isValid = false;
  }, 30);

  const res = await followEntity(bot, target, { range: 2, timeoutMs: 500 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'target_dead');
});

test('Combat: Follow entity halts immediately if target disappears from entities', async () => {
  const target = {
    id: 6,
    name: 'enderman',
    health: 40,
    isValid: true,
    position: { x: 10, y: 64, z: 0 }
  };

  const bot = createCombatMockBot([], { 6: target });

  setTimeout(() => {
    delete bot.entities[6];
  }, 30);

  const res = await followEntity(bot, target, { range: 2, timeoutMs: 500 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'target_lost');
});

test('Combat: Follow entity halts cleanly when AbortSignal triggers', async () => {
  const target = {
    id: 7,
    name: 'sheep',
    health: 8,
    isValid: true,
    position: { x: 15, y: 64, z: 0 }
  };

  const controller = new AbortController();
  const bot = createCombatMockBot([], { 7: target });

  setTimeout(() => {
    controller.abort();
  }, 20);

  const res = await followEntity(bot, target, { range: 2, abortSignal: controller.signal });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'aborted');
});
