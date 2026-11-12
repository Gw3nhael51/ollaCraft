const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Vec3 } = require('vec3');
const { executeProcedure } = require('../src/procedures/runner');
const { createDefaultRegistry } = require('../src/procedures/registry');
const { ProcedureMemory } = require('../src/procedures/memory');
const { createProcedureTemplate } = require('../src/procedures/schema');

/**
 * Build simulated bot for end-to-end procedure integration testing
 * @param {object} [options={}] Initial bot world and inventory configuration
 * @returns {object} Simulated Mineflayer bot
 */
function createSimulationBot(options = {}) {
  const inventoryItems = [
    ...(options.items || [])
  ];

  const worldBlocks = new Map();
  const setBlock = (x, y, z, block) => {
    worldBlocks.set(`${x},${y},${z}`, {
      name: block.name || 'air',
      position: new Vec3(x, y, z),
      diggable: block.name !== 'air' && block.name !== 'bedrock',
      digTime: () => 10,
      drops: block.drops || []
    });
  };

  if (options.blocks) {
    for (const b of options.blocks) {
      setBlock(b.x, b.y, b.z, b);
    }
  }

  const bot = {
    version: '1.20.4',
    health: options.health !== undefined ? options.health : 20,
    food: options.food !== undefined ? options.food : 20,
    entity: {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      height: 1.6
    },
    inventory: {
      slots: new Array(46).fill(null),
      items: () => inventoryItems.filter(Boolean),
      findInventoryItem: (name) => inventoryItems.find(i => i && i.name === name) || null
    },
    blockAt: (pos) => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      return worldBlocks.get(key) || { name: 'air', position: new Vec3(pos.x, pos.y, pos.z) };
    },
    canDigBlock: (block) => block && block.name !== 'air' && block.name !== 'bedrock',
    dig: async (block) => {
      setBlock(block.position.x, block.position.y, block.position.z, { name: 'air' });
      const existing = inventoryItems.find(i => i && i.name === 'oak_log');
      if (existing) {
        existing.count += 1;
      } else {
        inventoryItems.push({ name: 'oak_log', count: 1, type: 131, slot: 36 });
      }
    },
    stopDigging: () => {},
    recipesFor: () => [
      {
        result: { id: 36, name: 'oak_planks', count: 4 },
        requiresTable: false,
        delta: [
          { id: 131, name: 'oak_log', count: -1 },
          { id: 36, name: 'oak_planks', count: 4 }
        ]
      }
    ],
    craft: async () => {
      const logItem = inventoryItems.find(i => i && i.name === 'oak_log');
      if (logItem) {
        logItem.count -= 1;
        if (logItem.count <= 0) {
          const idx = inventoryItems.indexOf(logItem);
          if (idx !== -1) inventoryItems.splice(idx, 1);
        }
      }

      const existingPlanks = inventoryItems.find(i => i && i.name === 'oak_planks');
      if (existingPlanks) {
        existingPlanks.count += 4;
      } else {
        inventoryItems.push({ name: 'oak_planks', count: 4, type: 36, slot: 37 });
      }
    },
    pathfinder: {
      isMoving: () => false,
      goto: async (goal) => {
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
      },
      stop: () => {},
      setGoal: () => {}
    }
  };

  return bot;
}

test('Integration E2E: Harvest wood and craft planks full procedure pipeline', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacraft-e2e-proc-'));

  try {
    const bot = createSimulationBot({
      blocks: [
        { x: 10, y: 64, z: 20, name: 'oak_log' }
      ]
    });

    const registry = createDefaultRegistry();
    const memory = new ProcedureMemory({ storageDir: tempDir });

    const procedure = createProcedureTemplate({
      id: 'harvest_wood_and_craft_planks',
      name: 'Harvest Wood and Craft Planks',
      version: 1,
      status: 'experimental',
      parameters: {
        treeX: { type: 'number', default: 10 },
        treeY: { type: 'number', default: 64 },
        treeZ: { type: 'number', default: 20 }
      },
      preconditions: [
        { type: 'bot_health', value: 10, operator: 'gte' },
        { type: 'bot_food', value: 5, operator: 'gte' }
      ],
      steps: [
        {
          id: 'approach_tree',
          action: 'goto_coordinates',
          parameters: {
            x: '$parameters.treeX',
            y: '$parameters.treeY',
            z: '$parameters.treeZ',
            range: 1
          }
        },
        {
          id: 'mine_log',
          action: 'break_block',
          parameters: {
            position: { x: 10, y: 64, z: 20 }
          }
        },
        {
          id: 'craft_planks',
          action: 'craft_recipe',
          parameters: {
            recipe: 'oak_planks',
            count: 1
          }
        }
      ],
      postconditions: [
        { type: 'inventory_item', item: 'oak_planks', count: 4, operator: 'gte' }
      ],
      metadata: {
        tags: ['wood', 'gathering', 'crafting']
      }
    });

    memory.register(procedure);

    const execResult = await executeProcedure(bot, procedure, {
      actionRegistry: registry,
      inputs: { treeX: 10, treeY: 64, treeZ: 20 }
    });

    assert.equal(execResult.success, true);
    assert.equal(execResult.reason, 'completed');
    assert.equal(execResult.data.stepsExecuted, 3);
    assert.equal(execResult.data.postconditionsResult.passed.length, 1);

    const planks = bot.inventory.items().find(i => i.name === 'oak_planks');
    assert.notEqual(planks, undefined);
    assert.equal(planks.count, 4);

    const targetBlock = bot.blockAt({ x: 10, y: 64, z: 20 });
    assert.equal(targetBlock.name, 'air');

    await memory.recordExecution(procedure.id, true);
    await memory.recordExecution(procedure.id, true);
    await memory.recordExecution(procedure.id, true);

    const updated = memory.get(procedure.id);
    assert.equal(updated.status, 'validated');
    assert.equal(updated.metadata.executionCount, 3);
    assert.equal(updated.metadata.confidenceScore, 1.0);

    const bestCandidate = memory.selectBest({ tags: ['crafting'] });
    assert.notEqual(bestCandidate, null);
    assert.equal(bestCandidate.id, 'harvest_wood_and_craft_planks');
    assert.equal(bestCandidate.status, 'validated');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
