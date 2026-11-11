const test = require('node:test');
const assert = require('node:assert/strict');

const { ActionRegistry, createDefaultRegistry } = require('../src/procedures/registry');
const { validateProcedure, extractDynamicReferences } = require('../src/procedures/validator');

test('Registry: Registers authorized actions and exposes registry catalog', () => {
  const registry = new ActionRegistry();

  registry.register({
    id: 'test_action',
    description: 'A test action',
    handler: async () => ({ success: true }),
    parametersSchema: { required: ['foo'] }
  });

  assert.equal(registry.has('test_action'), true);
  assert.equal(registry.has('unknown_action'), false);
  assert.equal(registry.get('test_action').description, 'A test action');
  assert.equal(registry.list().length, 1);

  assert.throws(() => {
    registry.register({ id: 'broken_action' });
  });
});

test('Registry: Default registry exposes full suite of Mineflayer primitives', () => {
  const defaultRegistry = createDefaultRegistry();

  const expectedActions = [
    'goto_coordinates',
    'jump',
    'break_block',
    'place_block',
    'equip_item',
    'consume_item',
    'craft_recipe',
    'drop_item',
    'open_container',
    'deposit_item',
    'withdraw_item',
    'close_container',
    'attack_entity',
    'follow_entity',
    'find_block'
  ];

  for (const actionId of expectedActions) {
    assert.equal(defaultRegistry.has(actionId), true, `Expected action '${actionId}' in registry`);
  }
});

test('Validator: Valid procedure with dependencies passes validation', () => {
  const registry = createDefaultRegistry();

  const validProcedure = {
    id: 'woodcutting_pipeline',
    version: 1,
    name: 'Woodcutting Pipeline',
    status: 'experimental',
    parameters: {
      log_type: { type: 'string', default: 'oak_log' }
    },
    steps: [
      {
        id: 'locate_log',
        action: 'find_block',
        parameters: { block: '$parameters.log_type' }
      },
      {
        id: 'walk_to_log',
        action: 'goto_coordinates',
        parameters: {
          x: '$steps.locate_log.data.position.x',
          y: '$steps.locate_log.data.position.y',
          z: '$steps.locate_log.data.position.z'
        }
      },
      {
        id: 'mine_log',
        action: 'break_block',
        parameters: {
          position: '$steps.locate_log.data.position'
        }
      }
    ]
  };

  const res = validateProcedure(validProcedure, registry);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
});

test('Validator: Rejects unknown actions not present in registry', () => {
  const registry = createDefaultRegistry();

  const invalid = {
    id: 'unknown_action_proc',
    version: 1,
    name: 'Unknown Action Procedure',
    status: 'experimental',
    steps: [
      { id: 'teleport_step', action: 'teleport_to_moon', parameters: {} }
    ]
  };

  const res = validateProcedure(invalid, registry);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("unknown action 'teleport_to_moon'")));
});

test('Validator: Rejects missing required action parameters', () => {
  const registry = createDefaultRegistry();

  const missingParam = {
    id: 'missing_param_proc',
    version: 1,
    name: 'Missing Parameter Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'step_goto',
        action: 'goto_coordinates',
        parameters: { x: 10, y: 64 }
      }
    ]
  };

  const res = validateProcedure(missingParam, registry);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("missing required parameter 'z'")));
});

test('Validator: Rejects forward dependencies on future steps and circular self-references', () => {
  const registry = createDefaultRegistry();

  const forwardDep = {
    id: 'forward_dep_proc',
    version: 1,
    name: 'Forward Dependency Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'step_first',
        action: 'break_block',
        parameters: {
          position: '$steps.step_second.data.position'
        }
      },
      {
        id: 'step_second',
        action: 'find_block',
        parameters: { block: 'oak_log' }
      }
    ]
  };

  const resForward = validateProcedure(forwardDep, registry);
  assert.equal(resForward.valid, false);
  assert.ok(resForward.errors.some(e => e.includes("references future step 'step_second'")));

  const selfDep = {
    id: 'self_dep_proc',
    version: 1,
    name: 'Self Dependency Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'step_loop',
        action: 'break_block',
        parameters: {
          position: '$steps.step_loop.data.position'
        }
      }
    ]
  };

  const resSelf = validateProcedure(selfDep, registry);
  assert.equal(resSelf.valid, false);
  assert.ok(resSelf.errors.some(e => e.includes('circular dependency on itself')));
});

test('Validator: Rejects references to undeclared parameters', () => {
  const registry = createDefaultRegistry();

  const undeclaredParamProc = {
    id: 'undeclared_param_proc',
    version: 1,
    name: 'Undeclared Param Procedure',
    status: 'experimental',
    parameters: {
      declared_param: { type: 'string' }
    },
    steps: [
      {
        id: 'step_find',
        action: 'find_block',
        parameters: { block: '$parameters.ghost_param' }
      }
    ]
  };

  const res = validateProcedure(undeclaredParamProc, registry);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("undeclared parameter '$parameters.ghost_param'")));
});

test('Validator: Recursively extracts dynamic references from deeply nested parameter payloads', () => {
  const payload = {
    target: '$parameters.target_item',
    config: {
      destination: {
        coords: ['$steps.find_pos.data.position.x', '$steps.find_pos.data.position.y'],
        meta: {
          ref: '$steps.mine_step.data.blockName'
        }
      }
    }
  };

  const refs = extractDynamicReferences(payload);
  assert.equal(refs.length, 4);
  assert.equal(refs[0].ref, '$parameters.target_item');
  assert.equal(refs[1].ref, '$steps.find_pos.data.position.x');
  assert.equal(refs[2].ref, '$steps.find_pos.data.position.y');
  assert.equal(refs[3].ref, '$steps.mine_step.data.blockName');
});
