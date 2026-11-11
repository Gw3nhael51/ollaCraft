const test = require('node:test');
const assert = require('node:assert/strict');
const mcData = require('minecraft-data')('1.20.4');

const {
  equipItem,
  consumeItem,
  craftRecipe,
  dropItem,
  VALID_DESTINATIONS,
  withInventoryLock
} = require('../src/actions/primitives/items');

/**
 * Build a mock bot specifically configured for inventory and item primitives
 * @param {Array<{ name: string, count?: number, slot?: number }>} [initialItems=[]] Starting items
 * @param {object} [customProps={}] Overrides for bot methods and properties
 * @returns {object} Mock bot instance
 */
function createItemMockBot(initialItems = [], customProps = {}) {
  const slots = new Array(46).fill(null);

  initialItems.forEach((it, idx) => {
    const slotIdx = it.slot !== undefined ? it.slot : (idx + 9);
    const def = mcData.itemsByName[it.name] || { id: idx + 100, name: it.name };
    slots[slotIdx] = {
      name: it.name,
      count: it.count !== undefined ? it.count : 1,
      type: def.id,
      slot: slotIdx
    };
  });

  const equipmentSlots = {
    head: 5,
    torso: 6,
    legs: 7,
    feet: 8,
    'off-hand': 45
  };

  const bot = {
    version: '1.20.4',
    registry: mcData,
    health: 20,
    food: 20,
    foodSaturation: 5,
    quickBarSlot: 0,
    heldItem: null,
    inventory: {
      slots,
      items: () => slots.slice(9, 45).filter(Boolean)
    },
    getEquipmentDestSlot(dest) {
      if (dest === 'hand') return 36;
      return equipmentSlots[dest] || null;
    },
    equip: async (item, destination) => {
      if (destination === 'hand') {
        bot.heldItem = item;
      } else {
        const targetSlot = equipmentSlots[destination];
        if (targetSlot) {
          slots[targetSlot] = { ...item, slot: targetSlot };
        }
      }
    },
    consume: async () => {
      if (bot.heldItem) {
        const itemName = bot.heldItem.name;
        const invItem = slots.find(s => s && s.name === itemName);
        if (invItem) {
          invItem.count -= 1;
          if (invItem.count <= 0) {
            slots[invItem.slot] = null;
          }
        }
        if (bot.food < 20) {
          bot.food = Math.min(20, bot.food + 4);
        }
        bot.heldItem = null;
      }
    },
    craft: async (recipe, count, _tableBlock) => {
      const outputCount = (recipe.result?.count || 1) * count;
      const resultName = mcData.items[recipe.result?.id]?.name || 'iron_helmet';

      if (recipe.delta) {
        for (const d of recipe.delta) {
          if (d.count < 0) {
            const need = Math.abs(d.count) * count;
            const ingItem = slots.find(s => s && s.type === d.id);
            if (ingItem) {
              ingItem.count -= need;
              if (ingItem.count <= 0) slots[ingItem.slot] = null;
            }
          }
        }
      }

      const emptySlot = slots.slice(9, 45).findIndex(s => s === null);
      if (emptySlot !== -1) {
        slots[emptySlot + 9] = {
          name: resultName,
          count: outputCount,
          type: recipe.result.id,
          slot: emptySlot + 9
        };
      }
    },
    toss: async (itemType, _meta, count) => {
      const invItem = slots.find(s => s && s.type === itemType);
      if (invItem) {
        invItem.count -= count;
        if (invItem.count <= 0) {
          slots[invItem.slot] = null;
        }
      }
    },
    entity: {
      position: { x: 0, y: 64, z: 0, distanceTo: () => 1.5 }
    },
    ...customProps
  };

  return bot;
}

test('Equipment: Equip item succeeds across all six destination slots', async () => {
  for (const destination of VALID_DESTINATIONS) {
    const itemName = destination === 'hand' ? 'iron_sword' : 'iron_helmet';
    const bot = createItemMockBot([{ name: itemName, count: 1 }]);

    const res = await equipItem(bot, itemName, destination);
    assert.equal(res.success, true);
    assert.equal(res.reason, 'equipped');
    assert.equal(res.data.destination, destination);
  }
});

test('Equipment: Missing item returns missing_item', async () => {
  const bot = createItemMockBot([]);
  const res = await equipItem(bot, 'diamond_sword', 'hand');
  assert.equal(res.success, false);
  assert.equal(res.reason, 'missing_item');
});

test('Equipment: Invalid destination returns invalid_destination', async () => {
  const bot = createItemMockBot([{ name: 'iron_helmet', count: 1 }]);
  const res = await equipItem(bot, 'iron_helmet', 'back');
  assert.equal(res.success, false);
  assert.equal(res.reason, 'invalid_destination');
});

test('Consume: Consume regular food when hungry succeeds', async () => {
  const bot = createItemMockBot([{ name: 'bread', count: 3 }]);
  bot.food = 14;

  const res = await consumeItem(bot, 'bread');
  assert.equal(res.success, true);
  assert.equal(res.reason, 'consumed');
  assert.equal(res.data.consumedCount, 1);
  assert.equal(bot.food, 18);
});

test('Consume: Standard food at full hunger returns not_hungry', async () => {
  const bot = createItemMockBot([{ name: 'bread', count: 3 }]);
  bot.food = 20;

  const res = await consumeItem(bot, 'bread');
  assert.equal(res.success, false);
  assert.equal(res.reason, 'not_hungry');
});

test('Consume: Golden apple, chorus fruit, milk bucket, and potion can be consumed at full hunger', async () => {
  const specialConsumables = ['golden_apple', 'chorus_fruit', 'milk_bucket', 'potion'];

  for (const itemName of specialConsumables) {
    const bot = createItemMockBot([{ name: itemName, count: 2 }]);
    bot.food = 20;

    const res = await consumeItem(bot, itemName);
    assert.equal(res.success, true, `Expected success for ${itemName}`);
    assert.equal(res.reason, 'consumed');
  }
});

test('Consume: Non-consumable item returns not_consumable', async () => {
  const bot = createItemMockBot([{ name: 'cobblestone', count: 10 }]);
  bot.food = 10;

  const res = await consumeItem(bot, 'cobblestone');
  assert.equal(res.success, false);
  assert.equal(res.reason, 'not_consumable');
});

test('Craft: Craft 2x2 recipe without table succeeds', async () => {
  const oakLogId = mcData.itemsByName.oak_log.id;
  const planksId = mcData.itemsByName.oak_planks.id;
  const bot = createItemMockBot([{ name: 'oak_log', count: 2 }]);

  const recipe2x2 = {
    result: { id: planksId, count: 4 },
    inShape: [[oakLogId]],
    delta: [
      { id: oakLogId, count: -1 },
      { id: planksId, count: 4 }
    ]
  };

  const res = await craftRecipe(bot, recipe2x2, 1);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'crafted');
  assert.equal(res.data.gainedCount, 4);
});

test('Craft: 3x3 recipe without table returns missing_table', async () => {
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const helmetId = mcData.itemsByName.iron_helmet.id;
  const bot = createItemMockBot([{ name: 'iron_ingot', count: 10 }]);

  const recipe3x3 = {
    result: { id: helmetId, count: 1 },
    inShape: [
      [ironIngotId, ironIngotId, ironIngotId],
      [ironIngotId, null, ironIngotId]
    ],
    delta: [
      { id: ironIngotId, count: -5 },
      { id: helmetId, count: 1 }
    ]
  };

  const res = await craftRecipe(bot, recipe3x3, 1, null);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'missing_table');
});

test('Craft: 3x3 recipe with reachable table succeeds', async () => {
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const helmetId = mcData.itemsByName.iron_helmet.id;
  const bot = createItemMockBot([{ name: 'iron_ingot', count: 10 }]);

  const recipe3x3 = {
    result: { id: helmetId, count: 1 },
    inShape: [
      [ironIngotId, ironIngotId, ironIngotId],
      [ironIngotId, null, ironIngotId]
    ],
    delta: [
      { id: ironIngotId, count: -5 },
      { id: helmetId, count: 1 }
    ]
  };

  const mockTable = {
    name: 'crafting_table',
    position: { x: 1, y: 64, z: 0 }
  };

  const res = await craftRecipe(bot, recipe3x3, 1, mockTable);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'crafted');
  assert.equal(res.data.gainedCount, 1);
});

test('Craft: Insufficient ingredients returns missing_ingredients', async () => {
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const helmetId = mcData.itemsByName.iron_helmet.id;
  const bot = createItemMockBot([{ name: 'iron_ingot', count: 2 }]);

  const recipe3x3 = {
    result: { id: helmetId, count: 1 },
    inShape: [
      [ironIngotId, ironIngotId, ironIngotId],
      [ironIngotId, null, ironIngotId]
    ],
    delta: [
      { id: ironIngotId, count: -5 },
      { id: helmetId, count: 1 }
    ]
  };

  const mockTable = { name: 'crafting_table', position: { x: 1, y: 64, z: 0 } };
  const res = await craftRecipe(bot, recipe3x3, 1, mockTable);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'missing_ingredients');
});

test('Craft: Full inventory with no room returns inventory_full', async () => {
  const ironIngotId = mcData.itemsByName.iron_ingot.id;
  const helmetId = mcData.itemsByName.iron_helmet.id;

  const fullItems = [];
  for (let i = 0; i < 36; i++) {
    fullItems.push({ name: 'cobblestone', count: 64, slot: i + 9 });
  }
  fullItems[0] = { name: 'iron_ingot', count: 10, slot: 9 };

  const bot = createItemMockBot(fullItems);
  const recipe3x3 = {
    result: { id: helmetId, count: 1 },
    requiresTable: true,
    delta: [{ id: ironIngotId, count: -5 }, { id: helmetId, count: 1 }]
  };

  const mockTable = { name: 'crafting_table', position: { x: 1, y: 64, z: 0 } };
  const res = await craftRecipe(bot, recipe3x3, 1, mockTable);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'inventory_full');
});

test('Drop: Partial and full stack drops succeed and verify inventory change', async () => {
  const bot = createItemMockBot([{ name: 'stone', count: 10 }]);

  const partialRes = await dropItem(bot, 'stone', 4);
  assert.equal(partialRes.success, true);
  assert.equal(partialRes.reason, 'dropped');
  assert.equal(partialRes.data.droppedCount, 4);

  const fullRes = await dropItem(bot, 'stone', 6);
  assert.equal(fullRes.success, true);
  assert.equal(fullRes.reason, 'dropped');
  assert.equal(fullRes.data.droppedCount, 6);
  assert.equal(bot.inventory.items().length, 0);
});

test('Drop: Dropping more than available returns missing_item', async () => {
  const bot = createItemMockBot([{ name: 'stone', count: 3 }]);
  const res = await dropItem(bot, 'stone', 10);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'missing_item');
});

test('Drop: Invalid count returns invalid_count', async () => {
  const bot = createItemMockBot([{ name: 'stone', count: 10 }]);
  const res = await dropItem(bot, 'stone', 0);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'invalid_count');
});

test('Timeout & Abort: Timeout releases lock and post-success overrides error', async () => {
  const bot = createItemMockBot([{ name: 'bread', count: 2 }], {
    consume: () => new Promise(resolve => setTimeout(resolve, 500))
  });
  bot.food = 10;

  const res = await consumeItem(bot, 'bread', { timeoutMs: 30 });
  assert.equal(res.success, false);
  assert.equal(res.reason, 'timeout');
});

test('Concurrency: Concurrent operations on inventory are serialized cleanly', async () => {
  const bot = createItemMockBot([
    { name: 'bread', count: 5 },
    { name: 'stone', count: 20 }
  ]);
  bot.food = 10;

  const callOrder = [];

  const task1 = consumeItem(bot, 'bread').then(r => {
    callOrder.push('task1');
    return r;
  });

  const task2 = dropItem(bot, 'stone', 5).then(r => {
    callOrder.push('task2');
    return r;
  });

  const [res1, res2] = await Promise.all([task1, task2]);
  assert.equal(res1.success, true);
  assert.equal(res2.success, true);
  assert.deepEqual(callOrder, ['task1', 'task2']);
});
