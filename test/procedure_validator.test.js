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

test('Validator: Valid procedure with dependencies passes validation and returns analysis metrics', () => {
  const registry = createDefaultRegistry();

  const validProcedure = {
    id: 'woodcutting_pipeline',
    version: 1,
    name: 'Woodcutting Pipeline',
    status: 'experimental',
    parameters: {
      log_type: { type: 'string', default: 'oak_log' }
    },
    preconditions: [
      { type: 'bot_health', value: 10, operator: 'gte' }
    ],
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
    ],
    postconditions: [
      { type: 'inventory_item', item: 'oak_log', count: 1, operator: 'gte' }
    ]
  };

  const res = validateProcedure(validProcedure, registry);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
  assert.ok(Array.isArray(res.warnings));
  assert.deepEqual(res.analysis, {
    stepCount: 3,
    validatedActions: 3,
    dependencyCount: 5
  });
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
  assert.equal(res.errors[0].code, 'UNKNOWN_ACTION');
  assert.equal(res.errors[0].stepId, 'teleport_step');
  assert.equal(res.errors[0].field, 'action');
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
  const err = res.errors.find(e => e.code === 'MISSING_REQUIRED_PARAMETER');
  assert.ok(err);
  assert.equal(err.stepId, 'step_goto');
  assert.equal(err.field, 'z');
});

test('Validator: Rejects parameter of wrong static type', () => {
  const registry = createDefaultRegistry();

  const wrongTypeProc = {
    id: 'wrong_param_type_proc',
    version: 1,
    name: 'Wrong Parameter Type Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'craft_pickaxe',
        action: 'craft_recipe',
        parameters: {
          recipe: 'wooden_pickaxe',
          count: 'three'
        }
      }
    ]
  };

  const res = validateProcedure(wrongTypeProc, registry);
  assert.equal(res.valid, false);
  const err = res.errors.find(e => e.code === 'INVALID_PARAMETER_TYPE');
  assert.ok(err);
  assert.equal(err.stepId, 'craft_pickaxe');
  assert.equal(err.field, 'count');
  assert.match(err.message, /expected number, received string/i);
});

test('Validator: Rejects unknown properties when action contract forbids them', () => {
  const registry = createDefaultRegistry();

  const unknownFieldProc = {
    id: 'unknown_field_proc',
    version: 1,
    name: 'Unknown Parameter Field Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'find_wood',
        action: 'find_block',
        parameters: {
          block: 'oak_log',
          secretTurboFlag: true
        }
      }
    ]
  };

  const res = validateProcedure(unknownFieldProc, registry);
  assert.equal(res.valid, false);
  const err = res.errors.find(e => e.code === 'UNKNOWN_PARAMETER');
  assert.ok(err);
  assert.equal(err.stepId, 'find_wood');
  assert.equal(err.field, 'secretTurboFlag');
});

test('Validator: Rejects non-existent step reference', () => {
  const registry = createDefaultRegistry();

  const ghostStepRef = {
    id: 'ghost_step_ref_proc',
    version: 1,
    name: 'Ghost Step Reference Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'mine_step',
        action: 'break_block',
        parameters: {
          position: '$steps.non_existent_step.data.position'
        }
      }
    ]
  };

  const res = validateProcedure(ghostStepRef, registry);
  assert.equal(res.valid, false);
  const err = res.errors.find(e => e.code === 'NON_EXISTENT_STEP_REFERENCE');
  assert.ok(err);
  assert.equal(err.stepId, 'mine_step');
  assert.equal(err.field, 'position');
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
  assert.ok(resForward.errors.some(e => e.code === 'FUTURE_STEP_REFERENCE'));

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
  assert.ok(resSelf.errors.some(e => e.code === 'CIRCULAR_DEPENDENCY'));
});

test('Validator: Rejects reference to non-existent property path on step output', () => {
  const registry = createDefaultRegistry();

  const badPropertyRef = {
    id: 'bad_prop_path_proc',
    version: 1,
    name: 'Bad Property Path Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'locate_log',
        action: 'find_block',
        parameters: { block: 'oak_log' }
      },
      {
        id: 'break_log',
        action: 'break_block',
        parameters: {
          position: '$steps.locate_log.data.nonExistentCoordinates'
        }
      }
    ]
  };

  const res = validateProcedure(badPropertyRef, registry);
  assert.equal(res.valid, false);
  const err = res.errors.find(e => e.code === 'INVALID_REFERENCE_PATH');
  assert.ok(err);
  assert.equal(err.stepId, 'break_log');
  assert.equal(err.field, 'position');
});

test('Validator: Rejects reference whose resolved type is incompatible with target parameter', () => {
  const registry = createDefaultRegistry();

  const incompatibleRefProc = {
    id: 'incompatible_ref_type_proc',
    version: 1,
    name: 'Incompatible Reference Type Procedure',
    status: 'experimental',
    parameters: {
      block_label: { type: 'string', default: 'oak_log' }
    },
    steps: [
      {
        id: 'locate_log',
        action: 'find_block',
        parameters: { block: '$parameters.block_label' }
      },
      {
        id: 'goto_bad_type',
        action: 'goto_coordinates',
        parameters: {
          x: '$steps.locate_log.data.block',
          y: '$steps.locate_log.data.position.y',
          z: '$steps.locate_log.data.position.z'
        }
      }
    ]
  };

  const res = validateProcedure(incompatibleRefProc, registry);
  assert.equal(res.valid, false);
  const err = res.errors.find(e => e.code === 'INCOMPATIBLE_REFERENCE_TYPE');
  assert.ok(err);
  assert.equal(err.stepId, 'goto_bad_type');
  assert.equal(err.field, 'x');
});

test('Validator: Rejects references to undeclared parameters and mistyped parameter declarations', () => {
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
  assert.ok(res.errors.some(e => e.code === 'UNDECLARED_PARAMETER'));
});

test('Validator: Detects missing logical dependency when equipping pickaxe before crafting it', () => {
  const registry = createDefaultRegistry();

  const invertedLogicProc = {
    id: 'equip_before_craft_proc',
    version: 1,
    name: 'Equip Pickaxe Before Crafting',
    status: 'experimental',
    steps: [
      {
        id: 'equip_pickaxe_first',
        action: 'equip_item',
        parameters: {
          itemName: 'wooden_pickaxe',
          destination: 'hand'
        }
      },
      {
        id: 'craft_pickaxe_later',
        action: 'craft_recipe',
        parameters: {
          recipe: 'wooden_pickaxe',
          count: 1
        }
      }
    ]
  };

  const res = validateProcedure(invertedLogicProc, registry);
  assert.equal(res.valid, false);
  const err = res.errors.find(e => e.code === 'MISSING_LOGICAL_DEPENDENCY');
  assert.ok(err);
  assert.equal(err.stepId, 'equip_pickaxe_first');
  assert.equal(err.field, 'itemName');

  const unacquiredEquipProc = {
    id: 'equip_without_source_proc',
    version: 1,
    name: 'Equip Without Acquisition Or Precondition',
    status: 'experimental',
    steps: [
      {
        id: 'equip_unowned_pickaxe',
        action: 'equip_item',
        parameters: {
          itemName: 'iron_pickaxe'
        }
      }
    ]
  };

  const resUnacquired = validateProcedure(unacquiredEquipProc, registry);
  assert.equal(resUnacquired.valid, false);
  assert.ok(resUnacquired.errors.some(e => e.code === 'MISSING_LOGICAL_DEPENDENCY'));
});

test('Validator: Rejects incoherent and contradictory preconditions', () => {
  const registry = createDefaultRegistry();

  const contradictoryPreProc = {
    id: 'contradictory_preconditions_proc',
    version: 1,
    name: 'Contradictory Preconditions Procedure',
    status: 'experimental',
    preconditions: [
      { type: 'inventory_item', item: 'oak_log', count: 5, operator: 'gte' },
      { type: 'inventory_item', item: 'oak_log', count: 2, operator: 'lte' },
      { type: 'bot_health', value: 25, operator: 'gte' }
    ],
    steps: [
      {
        id: 'craft_planks',
        action: 'craft_recipe',
        parameters: { recipe: 'oak_planks', count: 1 }
      }
    ]
  };

  const res = validateProcedure(contradictoryPreProc, registry);
  assert.equal(res.valid, false);
  const preErrors = res.errors.filter(e => e.code === 'INCOHERENT_PRECONDITION');
  assert.ok(preErrors.length >= 2);
});

test('Validator: Rejects unverifiable postconditions', () => {
  const registry = createDefaultRegistry();

  const unverifiablePostProc = {
    id: 'unverifiable_post_proc',
    version: 1,
    name: 'Unverifiable Postcondition Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'jump_once',
        action: 'jump',
        parameters: { durationMs: 200 }
      }
    ],
    postconditions: [
      { type: 'dragon_defeated_in_dream', expected: true },
      { type: 'inventory_item', count: 2 },
      { type: 'custom', description: 'Missing fn predicate' }
    ]
  };

  const res = validateProcedure(unverifiablePostProc, registry);
  assert.equal(res.valid, false);
  const postErrors = res.errors.filter(e => e.code === 'UNVERIFIABLE_POSTCONDITION');
  assert.equal(postErrors.length, 3);
});

test('Validator: Enforces static complexity limits and forbidden action constraints via options', () => {
  const registry = createDefaultRegistry();

  const proc = {
    id: 'constrained_proc',
    version: 1,
    name: 'Constrained Procedure',
    status: 'experimental',
    steps: [
      { id: 's1', action: 'jump', parameters: {} },
      { id: 's2', action: 'jump', parameters: {} },
      { id: 's3', action: 'attack_entity', parameters: { targetEntity: { id: 1 } } }
    ]
  };

  const res = validateProcedure(proc, registry, {
    maxSteps: 2,
    forbiddenActions: ['attack_entity']
  });

  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.code === 'MAX_STEPS_EXCEEDED'));
  assert.ok(res.errors.some(e => e.code === 'FORBIDDEN_ACTION' && e.stepId === 's3'));
});

test('Validator: Operates purely statically with zero Minecraft bot interaction or handler invocation', () => {
  const registry = new ActionRegistry();
  let handlerCalled = false;

  registry.register({
    id: 'strict_offline_action',
    description: 'Action that must never be executed during validation',
    parametersSchema: {
      required: ['target'],
      types: { target: 'string' },
      allowAdditionalProperties: false
    },
    outputSchema: {
      found: { type: 'boolean' }
    },
    handler: async () => {
      handlerCalled = true;
      throw new Error('Minecraft bot connection accessed during static validation!');
    }
  });

  const proc = {
    id: 'pure_static_validation_proc',
    version: 1,
    name: 'Pure Static Validation Procedure',
    status: 'experimental',
    steps: [
      {
        id: 'step_offline',
        action: 'strict_offline_action',
        parameters: { target: 'coal_ore' }
      }
    ],
    postconditions: [
      { type: 'inventory_item', item: 'coal', count: 1, operator: 'gte' }
    ]
  };

  const res = validateProcedure(proc, registry);
  assert.equal(res.valid, true);
  assert.equal(handlerCalled, false);
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
