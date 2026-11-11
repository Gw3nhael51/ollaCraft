const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareValues,
  getInventoryItemCount,
  getDistance,
  evaluateAssertion,
  evaluatePreconditions,
  evaluatePostconditions
} = require('../src/procedures/evaluator');
const { executeProcedure } = require('../src/procedures/runner');
const { ActionRegistry } = require('../src/procedures/registry');
const { createResult } = require('../src/actions/primitives/result');

/**
 * Build mock bot instance for evaluator testing
 * @param {object} [overrides={}] Custom bot properties
 * @returns {object} Mock bot
 */
function createMockBot(overrides = {}) {
  const inventoryItems = overrides.items || [
    { name: 'oak_log', count: 4, type: 10 },
    { name: 'cobblestone', count: 16, type: 20 },
    { name: 'apple', count: 2, type: 30 }
  ];

  return {
    health: overrides.health !== undefined ? overrides.health : 20,
    food: overrides.food !== undefined ? overrides.food : 18,
    entity: {
      position: overrides.position || { x: 10, y: 64, z: 20 }
    },
    inventory: {
      items: () => inventoryItems
    },
    blockAt: overrides.blockAt || ((pos) => {
      if (pos.x === 10 && pos.y === 64 && pos.z === 20) {
        return { name: 'oak_log', position: pos };
      }
      return { name: 'air', position: pos };
    }),
    ...overrides
  };
}

test('Evaluator: Value comparisons across operators', () => {
  assert.equal(compareValues(5, 3, 'gt'), true);
  assert.equal(compareValues(3, 5, 'gt'), false);
  assert.equal(compareValues(5, 5, 'gte'), true);
  assert.equal(compareValues(5, 5, 'has'), true);
  assert.equal(compareValues(4, 5, 'lte'), true);
  assert.equal(compareValues(5, 5, 'eq'), true);
  assert.equal(compareValues(5, 6, 'not_eq'), true);
  assert.equal(compareValues('stone', 'stone', 'eq'), true);
  assert.equal(compareValues('stone', 'dirt', 'eq'), false);
});

test('Evaluator: Inventory item count and assertions', async () => {
  const bot = createMockBot();

  assert.equal(getInventoryItemCount(bot, 'oak_log'), 4);
  assert.equal(getInventoryItemCount(bot, 'cobblestone'), 16);
  assert.equal(getInventoryItemCount(bot, 'diamond'), 0);

  const passRes = await evaluateAssertion(bot, {
    type: 'inventory_item',
    item: 'oak_log',
    count: 3,
    operator: 'gte'
  });
  assert.equal(passRes.passed, true);
  assert.equal(passRes.actual, 4);

  const failRes = await evaluateAssertion(bot, {
    type: 'inventory_item',
    item: 'diamond',
    count: 1,
    operator: 'gte'
  });
  assert.equal(failRes.passed, false);
  assert.equal(failRes.actual, 0);
  assert.match(failRes.message, /diamond/);
});

test('Evaluator: Block state assertions at coordinates', async () => {
  const bot = createMockBot();

  const woodCheck = await evaluateAssertion(bot, {
    type: 'block_state',
    position: { x: 10, y: 64, z: 20 },
    block: 'oak_log',
    operator: 'eq'
  });
  assert.equal(woodCheck.passed, true);
  assert.equal(woodCheck.actual, 'oak_log');

  const airCheck = await evaluateAssertion(bot, {
    type: 'block_state',
    position: { x: 0, y: 0, z: 0 },
    block: 'air',
    operator: 'eq'
  });
  assert.equal(airCheck.passed, true);
  assert.equal(airCheck.actual, 'air');

  const failCheck = await evaluateAssertion(bot, {
    type: 'block_state',
    position: { x: 0, y: 0, z: 0 },
    block: 'diamond_block',
    operator: 'eq'
  });
  assert.equal(failCheck.passed, false);
});

test('Evaluator: Bot health, food, and position assertions', async () => {
  const bot = createMockBot({
    health: 15,
    food: 12,
    position: { x: 10, y: 64, z: 10 }
  });

  const healthCheck = await evaluateAssertion(bot, {
    type: 'bot_health',
    value: 10,
    operator: 'gte'
  });
  assert.equal(healthCheck.passed, true);

  const foodCheck = await evaluateAssertion(bot, {
    type: 'bot_food',
    value: 15,
    operator: 'gte'
  });
  assert.equal(foodCheck.passed, false);

  const dist = getDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 });
  assert.equal(dist, 5);

  const posCheck = await evaluateAssertion(bot, {
    type: 'bot_position',
    position: { x: 10, y: 64, z: 12 },
    maxDistance: 3
  });
  assert.equal(posCheck.passed, true);
});

test('Evaluator: Custom assertion predicate', async () => {
  const bot = createMockBot();

  const customPass = await evaluateAssertion(bot, {
    type: 'custom',
    fn: (b) => b.health > 10,
    description: 'Health must be strictly above 10'
  });
  assert.equal(customPass.passed, true);

  const customFail = await evaluateAssertion(bot, {
    type: 'custom',
    fn: (b) => b.health < 5,
    description: 'Health must be critical'
  });
  assert.equal(customFail.passed, false);
  assert.equal(customFail.message, 'Health must be critical');
});

test('Evaluator: Preconditions and Postconditions evaluation', async () => {
  const bot = createMockBot();

  const emptyPre = await evaluatePreconditions(bot, []);
  assert.equal(emptyPre.success, true);
  assert.equal(emptyPre.data.total, 0);

  const goodPreconditions = [
    { type: 'inventory_item', item: 'oak_log', count: 1, operator: 'gte' },
    { type: 'bot_health', value: 10, operator: 'gte' }
  ];
  const preRes = await evaluatePreconditions(bot, goodPreconditions);
  assert.equal(preRes.success, true);
  assert.equal(preRes.data.passed.length, 2);

  const badPreconditions = [
    { type: 'inventory_item', item: 'netherite_ingot', count: 1, operator: 'gte' }
  ];
  const preFail = await evaluatePreconditions(bot, badPreconditions);
  assert.equal(preFail.success, false);
  assert.equal(preFail.reason, 'preconditions_failed');
  assert.equal(preFail.data.failed.length, 1);

  const goodPostconditions = [
    { type: 'inventory_item', item: 'cobblestone', count: 10, operator: 'gte' }
  ];
  const postRes = await evaluatePostconditions(bot, goodPostconditions);
  assert.equal(postRes.success, true);
  assert.equal(postRes.reason, 'postconditions_met');
});

test('Evaluator & Runner: Preconditions failure stops procedure before executing steps', async () => {
  const bot = createMockBot();
  let stepExecuted = false;

  const registry = new ActionRegistry();
  registry.register({
    id: 'test_action',
    handler: async () => {
      stepExecuted = true;
      return createResult(true, 'success');
    }
  });

  const procedure = {
    id: 'test_preconditions',
    name: 'Test Preconditions',
    version: 1,
    status: 'experimental',
    preconditions: [
      { type: 'inventory_item', item: 'diamond_sword', count: 1, operator: 'gte' }
    ],
    steps: [
      { id: 's1', action: 'test_action' }
    ]
  };

  const result = await executeProcedure(bot, procedure, { actionRegistry: registry });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'preconditions_failed');
  assert.equal(stepExecuted, false);
});

test('Evaluator & Runner: Postconditions failure flags procedure as failed despite step success', async () => {
  const bot = createMockBot();
  let stepExecuted = false;

  const registry = new ActionRegistry();
  registry.register({
    id: 'test_action',
    handler: async () => {
      stepExecuted = true;
      return createResult(true, 'success');
    }
  });

  const procedure = {
    id: 'test_postconditions',
    name: 'Test Postconditions',
    version: 1,
    status: 'experimental',
    steps: [
      { id: 's1', action: 'test_action' }
    ],
    postconditions: [
      { type: 'inventory_item', item: 'emerald', count: 1, operator: 'gte' }
    ]
  };

  const result = await executeProcedure(bot, procedure, { actionRegistry: registry });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'postconditions_failed');
  assert.equal(stepExecuted, true);
  assert.equal(result.data.stepsExecuted, 1);
});
