const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isComplexObjective,
  ObjectiveGenerationTracker,
  evaluateObjectiveCoverage
} = require('../src/procedures/matcher');
const { ProcedureMemory } = require('../src/procedures/memory');
const { createProcedureTemplate } = require('../src/procedures/schema');

test('Matcher: Accurately distinguishes complex progression objectives from trivial micro-tasks', () => {
  assert.equal(isComplexObjective('wooden_pickaxe'), true);
  assert.equal(isComplexObjective('craft_stone_pickaxe'), true);
  assert.equal(isComplexObjective('smelt_iron_ingot'), true);
  assert.equal(isComplexObjective('build_nether_portal'), true);
  assert.equal(isComplexObjective('iron_chestplate'), true);

  assert.equal(isComplexObjective('none'), false);
  assert.equal(isComplexObjective('idle'), false);
  assert.equal(isComplexObjective('look'), false);
  assert.equal(isComplexObjective('unstuck'), false);
  assert.equal(isComplexObjective('explore'), false);
  assert.equal(isComplexObjective(''), false);
  assert.equal(isComplexObjective(null), false);
});

test('Tracker: Rate-limits generation attempts and blocks cognitive loops after maximum retries', () => {
  const tracker = new ObjectiveGenerationTracker({ maxAttempts: 2, cooldownMs: 0 });

  assert.equal(tracker.canAttempt('craft_stone_pickaxe').allowed, true);

  tracker.recordAttempt('craft_stone_pickaxe');
  assert.equal(tracker.getRecord('craft_stone_pickaxe').generationAttempts, 1);
  assert.equal(tracker.getRecord('craft_stone_pickaxe').status, 'pending');

  assert.equal(tracker.canAttempt('craft_stone_pickaxe').allowed, true);

  tracker.recordAttempt('craft_stone_pickaxe');
  tracker.recordFailure('craft_stone_pickaxe', 'Validation error in DSL syntax');
  assert.equal(tracker.getRecord('craft_stone_pickaxe').generationAttempts, 2);
  assert.equal(tracker.getRecord('craft_stone_pickaxe').status, 'exhausted');

  const blocked = tracker.canAttempt('craft_stone_pickaxe');
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /maximum generation attempts/i);
});

test('Tracker: Enforces cooldown period between successive generation attempts', () => {
  const tracker = new ObjectiveGenerationTracker({ maxAttempts: 3, cooldownMs: 5000 });

  tracker.recordAttempt('craft_iron_sword');
  const cooldownCheck = tracker.canAttempt('craft_iron_sword');

  assert.equal(cooldownCheck.allowed, false);
  assert.match(cooldownCheck.reason, /in cooldown/i);
});

test('Tracker: Supports state persistence, resolution, and objective resetting', () => {
  const tracker = new ObjectiveGenerationTracker({ maxAttempts: 3, cooldownMs: 0 });

  tracker.recordAttempt('mine_diamond');
  tracker.recordSuccess('mine_diamond');
  assert.equal(tracker.getRecord('mine_diamond').status, 'resolved');
  assert.equal(tracker.canAttempt('mine_diamond').allowed, false);

  const exported = tracker.exportState();
  assert.ok(Array.isArray(exported));
  assert.equal(exported.length, 1);

  const restoredTracker = new ObjectiveGenerationTracker({ maxAttempts: 3, cooldownMs: 0 });
  restoredTracker.importState(exported);
  assert.equal(restoredTracker.getRecord('mine_diamond').status, 'resolved');

  restoredTracker.reset('mine_diamond');
  assert.equal(restoredTracker.canAttempt('mine_diamond').allowed, true);
});

test('Coverage: Identifies existing validated procedure as immediate priority', () => {
  const memory = new ProcedureMemory();
  const tracker = new ObjectiveGenerationTracker();

  const validatedProc = createProcedureTemplate({
    id: 'craft_stone_pickaxe_chain',
    status: 'validated',
    metadata: {
      tags: ['stone_pickaxe'],
      confidenceScore: 0.95
    },
    steps: [{ id: 'craft_step', action: 'craft' }]
  });
  memory.register(validatedProc);

  const coverage = evaluateObjectiveCoverage(memory, 'stone_pickaxe', tracker);

  assert.equal(coverage.status, 'validated_available');
  assert.equal(coverage.isReliable, true);
  assert.equal(coverage.canGenerate, false);
  assert.equal(coverage.procedure.id, 'craft_stone_pickaxe_chain');
});

test('Coverage: Identifies existing experimental procedure for reuse and improvement', () => {
  const memory = new ProcedureMemory();
  const tracker = new ObjectiveGenerationTracker();

  const expProc = createProcedureTemplate({
    id: 'craft_furnace_exp',
    status: 'experimental',
    metadata: {
      tags: ['furnace'],
      confidenceScore: 0.60
    },
    steps: [{ id: 'craft_step', action: 'craft' }]
  });
  memory.register(expProc);

  const coverage = evaluateObjectiveCoverage(memory, 'furnace', tracker);

  assert.equal(coverage.status, 'experimental_available');
  assert.equal(coverage.isReliable, false);
  assert.equal(coverage.canGenerate, false);
  assert.equal(coverage.procedure.id, 'craft_furnace_exp');
});

test('Coverage: Confirms eligibility for procedure generation when complex objective is uncovered', () => {
  const memory = new ProcedureMemory();
  const tracker = new ObjectiveGenerationTracker({ maxAttempts: 3, cooldownMs: 0 });

  const coverage = evaluateObjectiveCoverage(memory, 'craft_shield', tracker);

  assert.equal(coverage.status, 'eligible_for_generation');
  assert.equal(coverage.canGenerate, true);
  assert.equal(coverage.isReliable, false);
  assert.equal(coverage.procedure, null);
});

test('Coverage: Omits generation for trivial micro-objectives and exhausted retry limits', () => {
  const memory = new ProcedureMemory();
  const tracker = new ObjectiveGenerationTracker({ maxAttempts: 1, cooldownMs: 0 });

  const trivialCoverage = evaluateObjectiveCoverage(memory, 'explore', tracker);
  assert.equal(trivialCoverage.status, 'trivial_objective');
  assert.equal(trivialCoverage.canGenerate, false);

  const invalidCoverage = evaluateObjectiveCoverage(memory, '', tracker);
  assert.equal(invalidCoverage.status, 'invalid_objective');
  assert.equal(invalidCoverage.canGenerate, false);

  tracker.recordAttempt('craft_bow');
  const exhaustedCoverage = evaluateObjectiveCoverage(memory, 'craft_bow', tracker);
  assert.equal(exhaustedCoverage.status, 'attempts_exhausted');
  assert.equal(exhaustedCoverage.canGenerate, false);
});
