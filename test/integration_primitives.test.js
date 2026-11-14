const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const mcData = require('minecraft-data')('1.20.4');

const { gotoCoordinates, stopMovement } = require('../src/actions/primitives/movement');
const { breakBlockAt } = require('../src/actions/primitives/blocks');
const { equipItem, craftRecipe } = require('../src/actions/primitives/items');
const { openContainer, depositItem, withdrawItem, closeContainer } = require('../src/actions/primitives/container');
const { attackEntity, followEntity } = require('../src/actions/primitives/combat');

/**
 * Build a unified mock bot simulating multi-primitive integration scenarios
 * @param {object} [config={}] Configuration overrides
 * @returns {object} Integrated mock bot
 */
function createIntegratedMockBot(config = {}) {
  const worldBlocks = new Map();
  const playerSlots = new Array(46).fill(null);
  const containerSlots = new Array(27).fill(null);
  const entitiesMap = {};

  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

  (config.initialBlocks || []).forEach(b => {
    worldBlocks.set(key(b.position), {
      name: b.name,
      diggable: b.diggable !== undefined ? b.diggable : true,
      boundingBox: 'block',
      position: new Vec3(b.position.x, b.position.y, b.position.z)
    });
  });

  (config.initialItems || []).forEach((it, idx) => {
    const slotIdx = it.slot !== undefined ? it.slot : (idx + 9);
    const def = mcData.itemsByName[it.name] || { id: idx + 100, name: it.name };
    playerSlots[slotIdx] = {
      name: it.name,
      count: it.count || 1,
      type: def.id,
      slot: slotIdx
    };
  });

  (config.initialEntities || []).forEach(e => {
    entitiesMap[e.id] = e;
  });

  const mockWindow = {
    slots: containerSlots,
    inventoryStart: 27,
    containerItems: () => containerSlots.filter(Boolean),
    deposit: async (itemType, _meta, count) => {
      const pItem = playerSlots.find(s => s && s.type === itemType);
      if (!pItem) throw new Error('Missing item');
      pItem.count -= count;
      if (pItem.count <= 0) playerSlots[pItem.slot] = null;

      const freeSlot = containerSlots.findIndex(s => s === null);
      if (freeSlot === -1) throw new Error('Container full');
      containerSlots[freeSlot] = {
        name: mcData.items[itemType]?.name || 'deposited',
        count,
        type: itemType,
        slot: freeSlot
      };
    },
    withdraw: async (itemType, _meta, count) => {
      const cItem = containerSlots.find(s => s && s.type === itemType);
      if (!cItem) throw new Error('Item missing');
      cItem.count -= count;
      const itemName = cItem.name;
      if (cItem.count <= 0) containerSlots[cItem.slot] = null;

      const existing = playerSlots.find(s => s && s.name === itemName);
      if (existing) {
        existing.count += count;
      } else {
        const freeSlot = playerSlots.slice(9, 45).findIndex(s => s === null);
        if (freeSlot === -1) throw new Error('Inventory full');
        playerSlots[freeSlot + 9] = {
          name: itemName,
          count,
          type: itemType,
          slot: freeSlot + 9
        };
      }
    },
    close: () => {
      bot.currentWindow = null;
    }
  };

  const bot = {
    version: '1.20.4',
    registry: mcData,
    health: 20,
    food: 20,
    heldItem: null,
    currentWindow: null,
    entities: entitiesMap,
    entity: {
      position: new Vec3(0, 64, 0)
    },
    inventory: {
      slots: playerSlots,
      items: () => playerSlots.slice(9, 45).filter(Boolean)
    },
    blockAt: (vec) => {
      const k = key(vec);
      return worldBlocks.get(k) || { name: 'air', diggable: false, position: new Vec3(vec.x, vec.y, vec.z) };
    },
    canDigBlock: (b) => Boolean(b?.diggable),
    dig: async (b) => {
      worldBlocks.set(key(b.position), { name: 'air', diggable: false, position: b.position });
      const dropItemName = b.name === 'oak_log' ? 'oak_log' : 'cobblestone';
      const free = playerSlots.slice(9, 45).findIndex(s => s === null);
      if (free !== -1) {
        const def = mcData.itemsByName[dropItemName] || { id: 999 };
        playerSlots[free + 9] = { name: dropItemName, count: 1, type: def.id, slot: free + 9 };
      }
    },
    stopDigging: () => {},
    equip: async (item, dest) => {
      if (dest === 'hand') {
        bot.heldItem = item;
      }
    },
    craft: async (recipe, count, _table) => {
      const resultName = mcData.items[recipe.result?.id]?.name || 'planks';
      const outputCount = (recipe.result?.count || 1) * count;

      if (recipe.delta) {
        for (const d of recipe.delta) {
          if (d.count < 0) {
            const need = Math.abs(d.count) * count;
            const ing = playerSlots.find(s => s && s.type === d.id);
            if (ing) {
              ing.count -= need;
              if (ing.count <= 0) playerSlots[ing.slot] = null;
            }
          }
        }
      }

      const free = playerSlots.slice(9, 45).findIndex(s => s === null);
      if (free !== -1) {
        playerSlots[free + 9] = { name: resultName, count: outputCount, type: recipe.result.id, slot: free + 9 };
      }
    },
    openContainer: async (block) => {
      bot.currentWindow = mockWindow;
      return mockWindow;
    },
    closeWindow: (w) => {
      if (w) w.close();
      bot.currentWindow = null;
    },
    attack: (target) => {
      if (target.health !== undefined) {
        target.health = Math.max(0, target.health - 7);
      }
      if (target.health <= 0) {
        target.isValid = false;
      }
    },
    pathfinder: {
      goto: async (goal) => {
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
      },
      setGoal: () => {},
      stop: () => {}
    },
    clearControlStates: () => {}
  };

  return bot;
}

test('Integration 1: Harvest wood -> collect drops -> craft planks', async () => {
  const logPos = { x: 1, y: 64, z: 0 };
  const bot = createIntegratedMockBot({
    initialBlocks: [{ name: 'oak_log', position: logPos }]
  });

  const breakRes = await breakBlockAt(bot, logPos);
  assert.equal(breakRes.success, true);
  assert.equal(breakRes.reason, 'broken');
  assert.equal(bot.blockAt(new Vec3(1, 64, 0)).name, 'air');

  const harvestedItem = bot.inventory.items().find(i => i.name === 'oak_log');
  assert.ok(harvestedItem);

  const oakLogId = mcData.itemsByName.oak_log.id;
  const planksId = mcData.itemsByName.oak_planks.id;
  const craftRes = await craftRecipe(bot, {
    result: { id: planksId, count: 4 },
    delta: [{ id: oakLogId, count: -1 }, { id: planksId, count: 4 }]
  }, 1);

  assert.equal(craftRes.success, true);
  assert.equal(craftRes.reason, 'crafted');
  assert.equal(bot.inventory.items().find(i => i.name === 'oak_planks').count, 4);
});

test('Integration 2: Craft pickaxe -> equip pickaxe -> mine stone', async () => {
  const pickaxeId = mcData.itemsByName.wooden_pickaxe.id;
  const planksId = mcData.itemsByName.oak_planks.id;
  const stickId = mcData.itemsByName.stick.id;

  const stonePos = { x: 2, y: 64, z: 0 };
  const bot = createIntegratedMockBot({
    initialBlocks: [{ name: 'stone', position: stonePos }],
    initialItems: [
      { name: 'oak_planks', count: 3 },
      { name: 'stick', count: 2 }
    ]
  });

  const craftRes = await craftRecipe(bot, {
    result: { id: pickaxeId, count: 1 },
    delta: [
      { id: planksId, count: -3 },
      { id: stickId, count: -2 },
      { id: pickaxeId, count: 1 }
    ]
  }, 1);
  assert.equal(craftRes.success, true);

  const equipRes = await equipItem(bot, 'wooden_pickaxe', 'hand');
  assert.equal(equipRes.success, true);
  assert.equal(bot.heldItem.name, 'wooden_pickaxe');

  const mineRes = await breakBlockAt(bot, stonePos);
  assert.equal(mineRes.success, true);
  assert.equal(bot.blockAt(new Vec3(2, 64, 0)).name, 'air');
  assert.ok(bot.inventory.items().some(i => i.name === 'cobblestone'));
});

test('Integration 3: Open chest -> deposit resources -> withdraw resources -> close', async () => {
  const chestPos = { x: 1, y: 64, z: 0 };
  const bot = createIntegratedMockBot({
    initialBlocks: [{ name: 'chest', position: chestPos }],
    initialItems: [{ name: 'iron_ingot', count: 10 }]
  });

  const openRes = await openContainer(bot, { name: 'chest', position: chestPos });
  assert.equal(openRes.success, true);
  const win = openRes.data.window;

  const depRes = await depositItem(bot, win, 'iron_ingot', 6);
  assert.equal(depRes.success, true);
  assert.equal(bot.inventory.items().find(i => i.name === 'iron_ingot').count, 4);

  const withRes = await withdrawItem(bot, win, 'iron_ingot', 2);
  assert.equal(withRes.success, true);
  assert.equal(bot.inventory.items().find(i => i.name === 'iron_ingot').count, 6);

  const closeRes = await closeContainer(bot, win);
  assert.equal(closeRes.success, true);
  assert.equal(bot.currentWindow, null);
});

test('Integration 4: Goto coordinates -> follow entity -> interrupt follow -> resume navigation', async () => {
  const targetEntity = {
    id: 101,
    name: 'cow',
    health: 10,
    isValid: true,
    position: new Vec3(10, 64, 0)
  };

  const bot = createIntegratedMockBot({
    initialEntities: [targetEntity]
  });

  const nav1 = await gotoCoordinates(bot, 5, 64, 0);
  assert.equal(nav1.success, true);
  assert.deepEqual(bot.entity.position, new Vec3(5, 64, 0));

  const followPromise = followEntity(bot, targetEntity, { range: 2, timeoutMs: 500 });

  setTimeout(() => {
    gotoCoordinates(bot, 20, 64, 0);
  }, 20);

  const followRes = await followPromise;
  assert.equal(followRes.success, false);
  assert.equal(followRes.reason, 'aborted');

  assert.deepEqual(bot.entity.position, new Vec3(20, 64, 0));
});

test('Integration 5: Attack entity -> verify health reduction -> eliminate', async () => {
  const zombie = {
    id: 202,
    name: 'zombie',
    health: 12,
    isValid: true,
    height: 1.8,
    position: new Vec3(1.5, 64, 0)
  };

  const bot = createIntegratedMockBot({
    initialEntities: [zombie],
    initialItems: [{ name: 'diamond_sword', count: 1 }]
  });

  const attack1 = await attackEntity(bot, zombie);
  assert.equal(attack1.success, true);
  assert.equal(attack1.data.targetEliminated, false);
  assert.equal(zombie.health, 5);

  const attack2 = await attackEntity(bot, zombie);
  assert.equal(attack2.success, true);
  assert.equal(attack2.data.targetEliminated, true);
  assert.equal(zombie.health, 0);
});

test('Integration 6: Concurrent craft and chest deposit are serialized cleanly', async () => {
  const chestPos = { x: 1, y: 64, z: 0 };
  const bot = createIntegratedMockBot({
    initialBlocks: [{ name: 'chest', position: chestPos }],
    initialItems: [
      { name: 'iron_ingot', count: 10 },
      { name: 'oak_log', count: 2 }
    ]
  });

  const openRes = await openContainer(bot, { name: 'chest', position: chestPos });
  const win = openRes.data.window;

  const oakLogId = mcData.itemsByName.oak_log.id;
  const planksId = mcData.itemsByName.oak_planks.id;

  const task1 = depositItem(bot, win, 'iron_ingot', 4);
  const task2 = craftRecipe(bot, {
    result: { id: planksId, count: 4 },
    delta: [{ id: oakLogId, count: -1 }, { id: planksId, count: 4 }]
  }, 1);

  const [res1, res2] = await Promise.all([task1, task2]);
  assert.equal(res1.success, true);
  assert.equal(res2.success, true);
});

test('Integration 7: Sequential primitives recover immediately from preceding error', async () => {
  const bot = createIntegratedMockBot({
    initialItems: [{ name: 'bread', count: 2 }]
  });

  const failRes = await gotoCoordinates(bot, NaN, null, undefined);
  assert.equal(failRes.success, false);
  assert.equal(failRes.reason, 'invalid_target');

  const equipRes = await equipItem(bot, 'bread', 'hand');
  assert.equal(equipRes.success, true);
  assert.equal(equipRes.reason, 'equipped');
  assert.equal(bot.heldItem.name, 'bread');
});
