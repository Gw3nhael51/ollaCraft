const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');

const { ActionRegistry } = require('../src/procedures/registry');
const { executeProcedure } = require('../src/procedures/runner');
const { createResult } = require('../src/actions/primitives/result');

/**
 * Build a mock bot instance for runner evaluation
 * @returns {object} Mock bot
 */
function createRunnerMockBot() {
  const world = new Map();
  const playerInventory = [{ name: 'iron_pickaxe', count: 1 }];

  return {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => playerInventory
    },
    findBlock: ({ matching }) => {
      const candidate = { name: 'oak_log', position: new Vec3(4, 64, 0) };
      return matching(candidate) ? candidate : null;
    },
    world
  };
}

test('Runner: Executes multi-step procedure passing dynamic values between steps', async () => {
  const bot = createRunnerMockBot();
  const registry = new ActionRegistry();

  registry.register({
    id: 'find_block',
    parametersSchema: { required: ['block'] },
    handler: async (_bot, params) => {
      return createResult(true, 'found', {
        block: params.block,
        position: { x: 4, y: 64, z: 0 }
      });
    }
  });

  registry.register({
    id: 'goto_coordinates',
    parametersSchema: { required: ['x', 'y', 'z'] },
    handler: async (botInstance, params) => {
      botInstance.entity.position = new Vec3(params.x, params.y, params.z);
      return createResult(true, 'reached', {
        position: { x: params.x, y: params.y, z: params.z }
      });
    }
  });

  registry.register({
    id: 'break_block',
    parametersSchema: { required: ['position'] },
    handler: async (_bot, params) => {
      return createResult(true, 'broken', {
        position: params.position,
        blockName: 'oak_log'
      });
    }
  });

  const procedure = {
    id: 'gather_log_procedure',
    version: 1,
    name: 'Gather Log Procedure',
    status: 'experimental',
    parameters: {
      target_block: { type: 'string', default: 'oak_log' }
    },
    steps: [
      {
        id: 'locate_step',
        action: 'find_block',
        parameters: { block: '$parameters.target_block' }
      },
      {
        id: 'approach_step',
        action: 'goto_coordinates',
        parameters: {
          x: '$steps.locate_step.data.position.x',
          y: '$steps.locate_step.data.position.y',
          z: '$steps.locate_step.data.position.z'
        }
      },
      {
        id: 'harvest_step',
        action: 'break_block',
        parameters: {
          position: '$steps.locate_step.data.position'
        }
      }
    ]
  };

  const res = await executeProcedure(bot, procedure, { actionRegistry: registry });

  assert.equal(res.success, true);
  assert.equal(res.reason, 'completed');
  assert.equal(res.data.stepsExecuted, 3);
  assert.equal(res.data.stepTraces.length, 3);

  assert.deepEqual(bot.entity.position, new Vec3(4, 64, 0));
  assert.deepEqual(res.data.stepResults.harvest_step.data.position, { x: 4, y: 64, z: 0 });
});

test('Runner: Halts on failed step and avoids executing subsequent steps', async () => {
  const bot = createRunnerMockBot();
  const registry = new ActionRegistry();
  let step3Executed = false;

  registry.register({
    id: 'step_one_action',
    handler: async () => createResult(true, 'ok', { val: 42 })
  });

  registry.register({
    id: 'failing_action',
    handler: async () => createResult(false, 'out_of_reach', null, 'Target out of reach')
  });

  registry.register({
    id: 'step_three_action',
    handler: async () => {
      step3Executed = true;
      return createResult(true, 'ok');
    }
  });

  const procedure = {
    id: 'failing_pipeline',
    version: 1,
    name: 'Failing Pipeline',
    status: 'experimental',
    steps: [
      { id: 'step_1', action: 'step_one_action' },
      { id: 'step_2', action: 'failing_action' },
      { id: 'step_3', action: 'step_three_action' }
    ]
  };

  const res = await executeProcedure(bot, procedure, { actionRegistry: registry });

  assert.equal(res.success, false);
  assert.equal(res.reason, 'step_failed');
  assert.equal(res.data.failedStepId, 'step_2');
  assert.equal(res.data.stepsExecuted, 2);
  assert.equal(step3Executed, false);
});

test('Runner: Optional failing step allows execution to proceed to next steps', async () => {
  const bot = createRunnerMockBot();
  const registry = new ActionRegistry();
  let step3Executed = false;

  registry.register({
    id: 'step_one_action',
    handler: async () => createResult(true, 'ok')
  });

  registry.register({
    id: 'optional_failing_action',
    handler: async () => createResult(false, 'not_found', null)
  });

  registry.register({
    id: 'step_three_action',
    handler: async () => {
      step3Executed = true;
      return createResult(true, 'ok');
    }
  });

  const procedure = {
    id: 'optional_step_proc',
    version: 1,
    name: 'Optional Step Procedure',
    status: 'experimental',
    steps: [
      { id: 'step_1', action: 'step_one_action' },
      { id: 'step_2', action: 'optional_failing_action', optional: true },
      { id: 'step_3', action: 'step_three_action' }
    ]
  };

  const res = await executeProcedure(bot, procedure, { actionRegistry: registry });

  assert.equal(res.success, true);
  assert.equal(res.reason, 'completed');
  assert.equal(res.data.stepsExecuted, 3);
  assert.equal(step3Executed, true);
});

test('Runner: Halts with resolution_error if dynamic reference fails to traverse', async () => {
  const bot = createRunnerMockBot();
  const registry = new ActionRegistry();

  registry.register({
    id: 'step_one_action',
    handler: async () => createResult(true, 'ok', { data: null })
  });

  registry.register({
    id: 'step_two_action',
    parametersSchema: { required: ['coords'] },
    handler: async () => createResult(true, 'ok')
  });

  const procedure = {
    id: 'bad_traversal_proc',
    version: 1,
    name: 'Bad Traversal Procedure',
    status: 'experimental',
    steps: [
      { id: 'step_1', action: 'step_one_action' },
      {
        id: 'step_2',
        action: 'step_two_action',
        parameters: { coords: '$steps.step_1.data.missing_nested.x' }
      }
    ]
  };

  const res = await executeProcedure(bot, procedure, { actionRegistry: registry });

  assert.equal(res.success, false);
  assert.equal(res.reason, 'resolution_error');
  assert.equal(res.data.failedStepId, 'step_2');
});

test('Runner: AbortSignal stops procedure execution cleanly', async () => {
  const bot = createRunnerMockBot();
  const registry = new ActionRegistry();
  const controller = new AbortController();

  registry.register({
    id: 'slow_action',
    handler: async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return createResult(true, 'ok');
    }
  });

  const procedure = {
    id: 'abort_proc',
    version: 1,
    name: 'Abort Procedure',
    status: 'experimental',
    steps: [
      { id: 'step_1', action: 'slow_action' },
      { id: 'step_2', action: 'slow_action' }
    ]
  };

  setTimeout(() => {
    controller.abort();
  }, 20);

  const res = await executeProcedure(bot, procedure, {
    actionRegistry: registry,
    abortSignal: controller.signal
  });

  assert.equal(res.success, false);
  assert.equal(res.reason, 'aborted');
});

test('Runner: Step retries succeed when intermittent failure clears', async () => {
  const bot = createRunnerMockBot();
  const registry = new ActionRegistry();
  let calls = 0;

  registry.register({
    id: 'intermittent_action',
    handler: async () => {
      calls++;
      if (calls === 1) {
        return createResult(false, 'temporary_glitch');
      }
      return createResult(true, 'recovered', { attempts: calls });
    }
  });

  const procedure = {
    id: 'retry_proc',
    version: 1,
    name: 'Retry Procedure',
    status: 'experimental',
    steps: [
      { id: 'retry_step', action: 'intermittent_action', retries: 2 }
    ]
  };

  const res = await executeProcedure(bot, procedure, { actionRegistry: registry });

  assert.equal(res.success, true);
  assert.equal(res.reason, 'completed');
  assert.equal(calls, 2);
  assert.equal(res.data.stepTraces[0].attempts, 2);
});
