const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Vec3 } = require('vec3');

const state = require('../src/core/state');
const { ProcedureMemory } = require('../src/procedures/memory');
const { createProcedureTemplate } = require('../src/procedures/schema');
const { saveProcedure } = require('../src/procedures/store');
const { dispatchSkill } = require('../src/actions/dispatcher');
const { ActionRegistry } = require('../src/procedures/registry');
const { createResult } = require('../src/actions/primitives/result');
const { resolveGoalPlan } = require('../src/minecraft/knowledge');
const { markBadBlock, isBadBlock, clearBadBlocks, scanEnvironment } = require('../src/perception/environment');
const { filterRadarEnvironment } = require('../src/agent/prompt');
const { ObjectiveGenerationTracker } = require('../src/procedures/matcher');
const { getMcData } = require('../src/minecraft/wikiData');
const { recoverFromActionTimeout, handleSurvivalRequest, executeDecisionWithTimeout } = require('../src/agent/loop');
const { runManagerCycle, sanitizeManagerOutput } = require('../src/agent/manager');
const { findTargetFurnace, skillSmelt } = require('../src/actions/behaviors/items/smelt');

const REAL_MC_DATA = getMcData(null);

/**
 * Build a minimal simulated bot for runtime integration tests
 * @returns {object} Simulated bot instance
 */
function createRuntimeMockBot() {
  return {
    username: 'OllamaTest',
    version: '1.20.4',
    health: 20,
    food: 20,
    entity: {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true
    },
    inventory: {
      items: () => [],
      slots: []
    },
    registry: REAL_MC_DATA,
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    findBlock: () => null,
    chat: () => {},
    clearControlStates: () => {},
    stopDigging: () => {},
    pathfinder: { setGoal: () => {} }
  };
}

test('Bloc 1.1 & 1.2: Validated procedure persists on disk and is reloaded after restart then selected by Manager', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacraft-bloc1-persist-'));
  const originalMemory = state.procedureMemory;
  const originalSurviving = state.isSurviving;
  const originalObjective = state.currentObjective;

  try {
    const firstMemory = new ProcedureMemory({ storageDir: tempDir });
    const validatedProc = createProcedureTemplate({
      id: 'craft_wooden_pickaxe_v1',
      name: 'Craft Wooden Pickaxe',
      status: 'validated',
      steps: [{ id: 's1', action: 'noop' }],
      metadata: {
        tags: ['wooden_pickaxe'],
        confidenceScore: 0.95,
        executionCount: 4,
        successCount: 4
      }
    });
    await saveProcedure(validatedProc, tempDir);

    // Restart with a fresh ProcedureMemory instance
    const restartedMemory = new ProcedureMemory({ storageDir: tempDir });
    const loadedCount = await restartedMemory.loadAll();
    assert.equal(loadedCount, 1);
    assert.equal(restartedMemory.get('craft_wooden_pickaxe_v1')?.status, 'validated');

    state.procedureMemory = restartedMemory;
    state.isSurviving = true;
    state.currentObjective = 'wooden_pickaxe';
    state.manualObjective = true;
    state.managerSubGoal = null;

    const bot = createRuntimeMockBot();
    await runManagerCycle(bot);

    assert.equal(state.managerSubGoal?.action, 'procedure');
    assert.equal(state.managerSubGoal?.target, 'craft_wooden_pickaxe_v1');
    assert.equal(state.managerSubGoal?.isReliable, true);
  } finally {
    state.procedureMemory = originalMemory;
    state.isSurviving = originalSurviving;
    state.currentObjective = originalObjective;
    state.manualObjective = false;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Bloc 1.3 & 1.4: Validated procedure bypasses Player LLM and executes directly', async () => {
  const originalMemory = state.procedureMemory;
  const originalSurviving = state.isSurviving;
  const originalSessionId = state.survivalSessionId;
  const originalObjective = state.currentObjective;
  const originalSubGoal = state.managerSubGoal;
  const originalManual = state.manualObjective;

  try {
    const memory = new ProcedureMemory();
    const proc = createProcedureTemplate({
      id: 'validated_wooden_pickaxe_proc',
      status: 'validated',
      steps: [{ id: 'step_noop', action: 'noop' }],
      metadata: { tags: ['wooden_pickaxe'], confidenceScore: 1 }
    });
    memory.register(proc);

    state.procedureMemory = memory;
    state.isSurviving = true;
    state.survivalSessionId = 42;
    state.currentObjective = 'wooden_pickaxe';
    state.manualObjective = true;
    state.managerSubGoal = {
      action: 'procedure',
      target: 'validated_wooden_pickaxe_proc',
      isReliable: true
    };
    state.managerDirective = 'Run validated procedure';

    let playerLlmCalled = false;
    let dispatchedAction = null;
    let dispatchedTarget = null;

    const bot = createRuntimeMockBot();
    await handleSurvivalRequest(bot, 42, {
      scheduleNext: false,
      askOllamaFn: async () => {
        playerLlmCalled = true;
        return { thought: 'ignore manager', action: 'explore', target: 'none' };
      },
      dispatchSkillFn: async (_bot, _state, action, target) => {
        dispatchedAction = action;
        dispatchedTarget = target;
        return { success: true, message: 'Procedure executed cleanly.' };
      }
    });

    assert.equal(playerLlmCalled, false);
    assert.equal(dispatchedAction, 'procedure');
    assert.equal(dispatchedTarget, 'validated_wooden_pickaxe_proc');
  } finally {
    state.procedureMemory = originalMemory;
    state.isSurviving = originalSurviving;
    state.survivalSessionId = originalSessionId;
    state.currentObjective = originalObjective;
    state.managerSubGoal = originalSubGoal;
    state.manualObjective = originalManual;
  }
});

test('Bloc 1.5: Experimental procedure is never promoted via boolean recordExecution or dispatcher shortcut', async () => {
  const bot = createRuntimeMockBot();
  const registry = new ActionRegistry();
  const memory = new ProcedureMemory();
  const testState = { procedureMemory: memory, currentObjective: 'wooden_pickaxe' };

  registry.register({
    id: 'simple_step',
    handler: async () => createResult(true, 'step_done')
  });

  const expProc = createProcedureTemplate({
    id: 'exp_no_bool_promo',
    status: 'experimental',
    steps: [{ id: 's1', action: 'simple_step' }],
    postconditions: [{ type: 'inventory_item', item: 'wooden_pickaxe', count: 1 }]
  });
  memory.register(expProc);

  for (let i = 0; i < 4; i++) {
    await memory.recordExecution('exp_no_bool_promo', true);
  }
  assert.equal(memory.get('exp_no_bool_promo').status, 'experimental');

  // Verify that dispatcher evaluation does not promote on failed postcondition
  await dispatchSkill(bot, testState, 'procedure', 'exp_no_bool_promo', 1, {
    actionRegistry: registry
  });
  assert.equal(memory.get('exp_no_bool_promo').status, 'experimental');
});

test('Bloc 1.6: Procedure execution envelope timeout exceeds 45s ReAct limit and forwards timeoutMs/abortSignal', async () => {
  const bot = createRuntimeMockBot();
  let capturedOptions = null;

  const result = await executeDecisionWithTimeout(
    bot,
    { action: 'procedure', target: 'long_proc', qty: 1 },
    {
      procedureTimeoutMs: 60000,
      procedureEnvelopeTimeoutMs: 75000,
      dispatchSkillFn: async (_bot, _state, _action, _target, _qty, opts) => {
        capturedOptions = opts;
        return { success: true, message: 'done' };
      }
    }
  );

  assert.equal(result.success, true);
  assert.equal(capturedOptions?.timeoutMs, 60000);
  assert.ok(capturedOptions?.abortSignal instanceof AbortSignal);
});

test('Bloc 2: Dependency resolver decomposes shield with missing wood down to mine(log)', () => {
  const bot = createRuntimeMockBot();
  bot.inventory.items = () => [{ name: 'iron_ingot', count: 1 }];
  bot.inventory.slots = [null, null, null, null, null, { name: 'iron_ingot', count: 1 }];

  const plan = resolveGoalPlan(bot, 'shield', 1, { base: {} });

  assert.equal(plan.satisfied, false);
  assert.equal(plan.nextAction?.action, 'mine');
  assert.equal(plan.nextAction?.target, 'log');
  assert.ok(plan.steps.some(s => s.action === 'craft' && s.target === 'planks'));
  assert.ok(plan.steps.some(s => s.action === 'craft' && s.target === 'shield'));
});

test('Bloc 3: Active learning generates experimental procedure, executes, evaluates, and promotes only via Evaluator', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacraft-bloc3-learn-'));
  const originalMemory = state.procedureMemory;
  const originalTracker = state.generationTracker;
  const originalSurviving = state.isSurviving;
  const originalObjective = state.currentObjective;
  const originalManual = state.manualObjective;
  const originalSubGoal = state.managerSubGoal;

  try {
    const memory = new ProcedureMemory({ storageDir: tempDir });
    const registry = new ActionRegistry();
    let inventoryItems = [];
    const bot = {
      ...createRuntimeMockBot(),
      inventory: {
        items: () => inventoryItems,
        slots: []
      }
    };

    registry.register({
      id: 'craft_shield_step',
      handler: async () => {
        inventoryItems = [{ name: 'shield', count: 1 }];
        return createResult(true, 'crafted_shield', { item: 'shield' });
      }
    });

    state.procedureMemory = memory;
    state.generationTracker = new ObjectiveGenerationTracker();
    state.isSurviving = true;
    state.currentObjective = 'shield';
    state.manualObjective = true;
    state.managerSubGoal = null;

    await runManagerCycle(bot, {
      enableProcedureGeneration: true,
      actionRegistry: registry,
      generateProcedureFn: async () => createResult(true, 'generated', {
        procedure: createProcedureTemplate({
          id: 'gen_shield_proc',
          status: 'experimental',
          steps: [{ id: 's1', action: 'craft_shield_step' }],
          postconditions: [{ type: 'inventory_item', item: 'shield', count: 1 }],
          metadata: { tags: ['shield'] }
        }),
        generationMetadata: { model: 'test' }
      })
    });

    assert.equal(state.managerSubGoal?.action, 'procedure');
    assert.equal(state.managerSubGoal?.isReliable, false);
    const createdId = state.managerSubGoal?.target;
    assert.ok(createdId);

    // Execute independent scenarios to satisfy Evaluator promotion criteria
    for (let i = 0; i < 3; i++) {
      inventoryItems = [];
      bot.entity.position = new Vec3(i * 15, 64, 0);
      await dispatchSkill(bot, state, 'procedure', createdId, 1, {
        actionRegistry: registry,
        objective: 'shield',
        context: { scenarioId: `run_${i}`, biome: `biome_${i}` }
      });
    }

    assert.equal(memory.get(createdId)?.status, 'validated');

    state.managerSubGoal = null;
    await runManagerCycle(bot);
    assert.equal(state.managerSubGoal?.action, 'procedure');
    assert.equal(state.managerSubGoal?.target, createdId);
    assert.equal(state.managerSubGoal?.isReliable, true);
  } finally {
    state.procedureMemory = originalMemory;
    state.generationTracker = originalTracker;
    state.isSurviving = originalSurviving;
    state.currentObjective = originalObjective;
    state.manualObjective = originalManual;
    state.managerSubGoal = originalSubGoal;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Bloc 4: Bad blocks expire via TTL, clear on death, synchronize with scanEnvironment, and leaves are filtered from Radar', () => {
  clearBadBlocks();
  const logPos = new Vec3(1, 64, 1);

  markBadBlock(logPos, 5000);
  assert.equal(isBadBlock(logPos, Date.now()), true);
  assert.equal(isBadBlock(logPos, Date.now() + 6000), false);

  markBadBlock(logPos, 60000);
  const bot = {
    ...createRuntimeMockBot(),
    blockAt: (pos) => {
      if (pos.x === 1 && pos.y === 64 && pos.z === 1) return { name: 'oak_log', position: pos };
      if (pos.x === 2 && pos.y === 64 && pos.z === 1) return { name: 'stone', position: pos };
      return { name: 'air', position: pos };
    }
  };

  const scanned = scanEnvironment(bot, 2);
  assert.equal(scanned.oak_log, undefined);
  assert.equal(scanned.stone, 1);

  clearBadBlocks();
  assert.equal(isBadBlock(logPos), false);

  const radar = filterRadarEnvironment(bot, { oak_log: 2, oak_leaves: 40, acacia_leaves: 15, stone: 10 });
  assert.equal(radar.oak_leaves, undefined);
  assert.equal(radar.acacia_leaves, undefined);
  assert.equal(radar.oak_log, 2);
  assert.equal(radar.stone, 10);
});

test('P0 Stabilization: recoverFromActionTimeout skips unstuck on clear terrain and sanitizeManagerOutput blocks redundant unstuck', async () => {
  const bot = createRuntimeMockBot();
  const recovery = await recoverFromActionTimeout(bot);

  assert.equal(recovery.success, false);
  assert.match(recovery.message, /terrain is clear/i);

  const sanitized = sanitizeManagerOutput(bot, {
    directive: 'Débloque-toi immédiatement',
    suggestedAction: 'unstuck',
    suggestedTarget: 'none'
  });

  assert.equal(sanitized.suggestedAction, 'explore');
});

test('P0 Stabilization: Unreachable furnace is marked temporarily inaccessible and Manager redirects to crafting a local furnace', async () => {
  clearBadBlocks();
  const unreachablePos = new Vec3(-17, 76, -104);
  const bot = {
    ...createRuntimeMockBot(),
    entity: { position: new Vec3(-78, 55, -102) },
    inventory: {
      items: () => [
        { name: 'raw_iron', count: 7, type: 1 },
        { name: 'oak_planks', count: 4, type: 2 },
        { name: 'cobblestone', count: 12, type: 3 }
      ]
    },
    findBlock: ({ matching }) => {
      const candidate = { name: 'furnace', type: REAL_MC_DATA.blocksByName.furnace.id, position: unreachablePos };
      if (typeof matching === 'function') {
        return matching(candidate) ? candidate : null;
      }
      return candidate;
    },
    pathfinder: {
      setGoal: () => {},
      goto: async () => {
        throw new Error('Navigation timeout towards furnace');
      }
    }
  };
  const testState = { base: { furnace: unreachablePos } };

  const smeltRes = await skillSmelt(bot, testState, 'raw_iron', 3);
  assert.equal(smeltRes.success, false);
  assert.match(smeltRes.message, /temporarily inaccessible/i);
  assert.equal(isBadBlock(unreachablePos), true);

  assert.equal(findTargetFurnace(bot, testState), null);

  const sanitized = sanitizeManagerOutput(bot, {
    directive: 'Fonds le fer',
    suggestedAction: 'smelt',
    suggestedTarget: 'iron_ingot'
  });
  assert.equal(sanitized.suggestedAction, 'craft');
  assert.equal(sanitized.suggestedTarget, 'furnace');

  clearBadBlocks();
  assert.notEqual(findTargetFurnace(bot, testState), null);
});
