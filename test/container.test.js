const test = require('node:test');
const assert = require('node:assert/strict');
const mcData = require('minecraft-data')('1.20.4');

const {
  openContainer,
  depositItem,
  withdrawItem,
  transferItem,
  closeContainer
} = require('../src/actions/primitives/container');

const { consumeItem } = require('../src/actions/primitives/items');

/**
 * Build a mock bot with chest and container window simulation
 * @param {Array<{ name: string, count?: number, slot?: number }>} [playerItems=[]] Player inventory items
 * @param {Array<{ name: string, count?: number, slot?: number }>} [chestItems=[]] Chest container items
 * @param {object} [customProps={}] Overrides for bot methods and properties
 * @returns {object} Mock bot instance
 */
function createContainerMockBot(playerItems = [], chestItems = [], customProps = {}) {
  const playerSlots = new Array(46).fill(null);
  playerItems.forEach((it, idx) => {
    const slotIdx = it.slot !== undefined ? it.slot : (idx + 9);
    const def = mcData.itemsByName[it.name] || { id: idx + 100, name: it.name };
    playerSlots[slotIdx] = {
      name: it.name,
      count: it.count !== undefined ? it.count : 1,
      type: def.id,
      slot: slotIdx
    };
  });

  const windowSlots = new Array(63).fill(null);
  chestItems.forEach((it, idx) => {
    const slotIdx = it.slot !== undefined ? it.slot : idx;
    const def = mcData.itemsByName[it.name] || { id: idx + 200, name: it.name };
    windowSlots[slotIdx] = {
      name: it.name,
      count: it.count !== undefined ? it.count : 1,
      type: def.id,
      slot: slotIdx
    };
  });

  const mockWindow = {
    slots: windowSlots,
    inventoryStart: 27,
    containerItems: () => windowSlots.slice(0, 27).filter(Boolean),
    deposit: async (itemType, _meta, count) => {
      const pItem = playerSlots.find(s => s && s.type === itemType);
      if (!pItem) throw new Error('Item missing from inventory');
      pItem.count -= count;
      if (pItem.count <= 0) playerSlots[pItem.slot] = null;

      const freeSlot = windowSlots.slice(0, 27).findIndex(s => s === null);
      if (freeSlot === -1) throw new Error('Container is full');
      windowSlots[freeSlot] = {
        name: mcData.items[itemType]?.name || 'deposited_item',
        count,
        type: itemType,
        slot: freeSlot
      };
    },
    withdraw: async (itemType, _meta, count) => {
      const cItem = windowSlots.slice(0, 27).find(s => s && s.type === itemType);
      if (!cItem) throw new Error('Item missing from container');
      cItem.count -= count;
      if (cItem.count <= 0) windowSlots[cItem.slot] = null;

      const freeSlot = playerSlots.slice(9, 45).findIndex(s => s === null);
      if (freeSlot === -1) throw new Error('Player inventory is full');
      playerSlots[freeSlot + 9] = {
        name: mcData.items[itemType]?.name || 'withdrawn_item',
        count,
        type: itemType,
        slot: freeSlot + 9
      };
    },
    transferSlot: async (source, dest, count) => {
      const sItem = windowSlots[source];
      if (!sItem) throw new Error('Source empty');
      sItem.count -= count;
      if (sItem.count <= 0) windowSlots[source] = null;

      const dItem = windowSlots[dest];
      if (dItem) {
        dItem.count += count;
      } else {
        windowSlots[dest] = { ...sItem, count, slot: dest };
      }
    },
    close: () => {
      bot.currentWindow = null;
    }
  };

  const bot = {
    version: '1.20.4',
    registry: mcData,
    currentWindow: null,
    entity: {
      position: { x: 0, y: 64, z: 0, distanceTo: () => 1.5 }
    },
    inventory: {
      slots: playerSlots,
      items: () => playerSlots.slice(9, 45).filter(Boolean)
    },
    openContainer: async (_block) => {
      bot.currentWindow = mockWindow;
      return mockWindow;
    },
    closeWindow: (w) => {
      if (w && typeof w.close === 'function') w.close();
      bot.currentWindow = null;
    },
    equip: async (item, _dest) => {
      bot.heldItem = item;
    },
    consume: async () => {
      if (bot.heldItem) {
        const pItem = playerSlots.find(s => s && s.name === bot.heldItem.name);
        if (pItem) {
          pItem.count -= 1;
          if (pItem.count <= 0) playerSlots[pItem.slot] = null;
        }
        bot.food = Math.min(20, bot.food + 2);
        bot.heldItem = null;
      }
    },
    ...customProps
  };

  return { bot, mockWindow };
}

test('Container: Open valid container within reach succeeds', async () => {
  const { bot } = createContainerMockBot();
  const chestBlock = {
    name: 'chest',
    position: { x: 1, y: 64, z: 0 }
  };

  const res = await openContainer(bot, chestBlock);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'opened');
  assert.equal(res.data.containerType, 'chest');
  assert.ok(bot.currentWindow);
});

test('Container: Opening non-container block returns not_a_container', async () => {
  const { bot } = createContainerMockBot();
  const stoneBlock = {
    name: 'stone',
    position: { x: 1, y: 64, z: 0 }
  };

  const res = await openContainer(bot, stoneBlock);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'not_a_container');
});

test('Container: Opening container out of reach returns out_of_reach', async () => {
  const { bot } = createContainerMockBot([], [], {
    entity: {
      position: { x: 0, y: 64, z: 0, distanceTo: () => 7.0 }
    }
  });

  const chestBlock = {
    name: 'barrel',
    position: { x: 7, y: 64, z: 0 }
  };

  const res = await openContainer(bot, chestBlock);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'out_of_reach');
});

test('Container: Deposit item from inventory into container succeeds', async () => {
  const { bot, mockWindow } = createContainerMockBot([{ name: 'iron_ingot', count: 5 }]);
  bot.currentWindow = mockWindow;

  const res = await depositItem(bot, mockWindow, 'iron_ingot', 3);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'deposited');
  assert.equal(res.data.depositedCount, 3);
  assert.equal(bot.inventory.items().find(i => i.name === 'iron_ingot').count, 2);
});

test('Container: Deposit missing item returns missing_item', async () => {
  const { bot, mockWindow } = createContainerMockBot([{ name: 'iron_ingot', count: 2 }]);
  bot.currentWindow = mockWindow;

  const res = await depositItem(bot, mockWindow, 'gold_ingot', 1);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'missing_item');
});

test('Container: Withdraw item from container into inventory succeeds', async () => {
  const { bot, mockWindow } = createContainerMockBot([], [{ name: 'diamond', count: 4 }]);
  bot.currentWindow = mockWindow;

  const res = await withdrawItem(bot, mockWindow, 'diamond', 2);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'withdrawn');
  assert.equal(res.data.withdrawnCount, 2);
  assert.equal(bot.inventory.items().find(i => i.name === 'diamond').count, 2);
});

test('Container: Withdraw item missing from container returns missing_item', async () => {
  const { bot, mockWindow } = createContainerMockBot([], [{ name: 'diamond', count: 1 }]);
  bot.currentWindow = mockWindow;

  const res = await withdrawItem(bot, mockWindow, 'emerald', 1);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'missing_item');
});

test('Container: Transfer item between specific slots succeeds', async () => {
  const { bot, mockWindow } = createContainerMockBot([], [{ name: 'stone', count: 10, slot: 0 }]);
  bot.currentWindow = mockWindow;

  const res = await transferItem(bot, mockWindow, 0, 1, 4);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'transferred');
  assert.equal(mockWindow.slots[0].count, 6);
  assert.equal(mockWindow.slots[1].count, 4);
});

test('Container: Transfer with invalid slot returns invalid_slot', async () => {
  const { bot, mockWindow } = createContainerMockBot();
  bot.currentWindow = mockWindow;

  const res = await transferItem(bot, mockWindow, 0, 999, 1);
  assert.equal(res.success, false);
  assert.equal(res.reason, 'invalid_slot');
});

test('Container: Close container window closes window and resets currentWindow', async () => {
  const { bot, mockWindow } = createContainerMockBot();
  bot.currentWindow = mockWindow;

  const res = await closeContainer(bot, mockWindow);
  assert.equal(res.success, true);
  assert.equal(res.reason, 'closed');
  assert.equal(bot.currentWindow, null);

  const resAlready = await closeContainer(bot);
  assert.equal(resAlready.success, true);
  assert.equal(resAlready.reason, 'already_closed');
});

test('Container: Concurrent operations between container and inventory lock cleanly without deadlock', async () => {
  const { bot, mockWindow } = createContainerMockBot(
    [{ name: 'bread', count: 4 }, { name: 'iron_ingot', count: 5 }],
    []
  );
  bot.currentWindow = mockWindow;
  bot.food = 10;

  const order = [];

  const task1 = depositItem(bot, mockWindow, 'iron_ingot', 2).then(r => {
    order.push('deposit');
    return r;
  });

  const task2 = consumeItem(bot, 'bread').then(r => {
    order.push('consume');
    return r;
  });

  const [res1, res2] = await Promise.all([task1, task2]);
  assert.equal(res1.success, true);
  assert.equal(res2.success, true);
  assert.deepEqual(order, ['deposit', 'consume']);
});
