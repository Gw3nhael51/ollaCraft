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
const { runManagerCycle } = require('../src/agent/manager');
const { handleSurvivalRequest, executeDecisionWithTimeout } = require('../src/agent/loop');
const { dispatchSkill } = require('../src/actions/dispatcher');
const { ActionRegistry } = require('../src/procedures/registry');
const { createResult } = require('../src/actions/primitives/result');
const { resolveGoalPlan } = require('../src/minecraft/knowledge');
const { markBadBlock, isBadBlock, clearBadBlocks, scanEnvironment } = require('../src/perception/environment');
const { filterRadarEnvironment } = require('../src/agent/prompt');
const { ObjectiveGenerationTracker } = require('../src/procedures/matcher');
const { getMcData } = require('../src/minecraft/wikiData');

const REAL_MC_DATA = getMcData(null);

/**
 * Construire un bot simulé minimal pour les tests d'intégration runtime
 * @returns {object} Instance de bot simulée
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

    // Simuler : Redémarrer avec une nouvelle instance de ProcedureMemory
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

  // Vérifier : Même via dispatcher avec échec de postcondition réelle, pas de promotion
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

    // Exécuter : 3 scénarios indépendants pour satisfaire la promotion Phase 4.6 via Evaluator
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
