const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CURRENT_DSL_VERSION,
  ALLOWED_STATUSES,
  isDynamicReference,
  parseDynamicReference,
  validateProcedureSchema,
  createProcedureTemplate
} = require('../src/procedures/schema');

test('Schema: Valid procedure passes validation with zero errors', () => {
  const procedure = {
    id: 'collect_wood_and_craft_planks',
    version: 1,
    name: 'Collect Wood and Craft Planks',
    status: 'experimental',
    description: 'Find oak tree, mine wood log, and craft oak planks',
    parameters: {
      tree_type: { type: 'string', default: 'oak_log' }
    },
    preconditions: [
      { type: 'has_inventory_space', value: 1 }
    ],
    steps: [
      {
        id: 'find_tree',
        action: 'find_block',
        parameters: { block: '$parameters.tree_type' }
      },
      {
        id: 'navigate_to_tree',
        action: 'goto_coordinates',
        parameters: {
          x: '$steps.find_tree.data.position.x',
          y: '$steps.find_tree.data.position.y',
          z: '$steps.find_tree.data.position.z',
          range: 2
        }
      },
      {
        id: 'mine_tree',
        action: 'break_block',
        parameters: {
          position: '$steps.find_tree.data.position'
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
      { type: 'inventory_item', target: 'oak_planks', value: 4, operator: 'gte' }
    ],
    metadata: {
      author: 'system',
      executionCount: 0,
      successCount: 0,
      failureCount: 0,
      confidenceScore: 0.5,
      tags: ['gathering', 'crafting', 'wood']
    }
  };

  const res = validateProcedureSchema(procedure);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
});

test('Schema: Dynamic references parsing resolves steps and parameters scopes', () => {
  assert.equal(isDynamicReference('$steps.find_tree.data.position'), true);
  assert.equal(isDynamicReference('$parameters.tree_type'), true);
  assert.equal(isDynamicReference('normal_string'), false);
  assert.equal(isDynamicReference('$invalid..ref'), false);
  assert.equal(isDynamicReference('$steps'), false);

  const parsedStep = parseDynamicReference('$steps.find_tree.data.position.x');
  assert.deepEqual(parsedStep, {
    scope: 'steps',
    targetId: 'find_tree',
    path: ['data', 'position', 'x']
  });

  const parsedParam = parseDynamicReference('$parameters.tree_type');
  assert.deepEqual(parsedParam, {
    scope: 'parameters',
    targetId: 'tree_type',
    path: []
  });
});

test('Schema: Rejects invalid identifiers and illegal characters', () => {
  const invalid = {
    id: 'Invalid ID with Spaces',
    version: 1,
    name: 'Invalid ID Procedure',
    status: 'experimental',
    steps: [{ id: 'step_one', action: 'find_block' }]
  };

  const res = validateProcedureSchema(invalid);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("Field 'id'")));
});

test('Schema: Rejects unallowed statuses', () => {
  const invalid = {
    id: 'test_procedure',
    version: 1,
    name: 'Test Procedure',
    status: 'approved_by_user',
    steps: [{ id: 'step_one', action: 'find_block' }]
  };

  const res = validateProcedureSchema(invalid);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("Field 'status'")));
});

test('Schema: Detects duplicated step identifiers', () => {
  const duplicateSteps = {
    id: 'test_duplicate_steps',
    version: 1,
    name: 'Duplicate Steps Procedure',
    status: 'experimental',
    steps: [
      { id: 'mine_log', action: 'break_block' },
      { id: 'mine_log', action: 'break_block' }
    ]
  };

  const res = validateProcedureSchema(duplicateSteps);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes('duplicated')));
});

test('Schema: Enforces max step limit of 50 steps', () => {
  const longSteps = [];
  for (let i = 0; i < 55; i++) {
    longSteps.push({ id: `step_${i}`, action: 'noop' });
  }

  const complexProc = {
    id: 'complex_proc',
    version: 1,
    name: 'Complex Procedure',
    status: 'experimental',
    steps: longSteps
  };

  const res = validateProcedureSchema(complexProc);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes('maximum complexity limit')));
});

test('Schema: Template helper generates compliant procedure skeleton', () => {
  const skeleton = createProcedureTemplate({
    id: 'sample_harvest',
    name: 'Sample Harvest',
    steps: [{ id: 'step_one', action: 'find_block' }]
  });

  const res = validateProcedureSchema(skeleton);
  assert.equal(res.valid, true);
  assert.equal(skeleton.version, CURRENT_DSL_VERSION);
  assert.equal(ALLOWED_STATUSES.includes(skeleton.status), true);
  assert.equal(skeleton.metadata.confidenceScore, 0.5);
});
