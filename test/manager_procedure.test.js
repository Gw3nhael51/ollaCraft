const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');

const state = require('../src/core/state');
const {
  selectProcedureForObjective,
  sanitizeProcedureDecision,
  sanitizeManagerOutput,
  runManagerCycle
} = require('../src/agent/manager');
const { ProcedureMemory } = require('../src/procedures/memory');
const { createProcedureTemplate } = require('../src/procedures/schema');

/**
 * Build simulated bot for manager testing
 * @returns {object} Simulated bot instance
 */
function createMockBot() {
  return {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    inventory: {
      items: () => [{ name: 'wooden_pickaxe', count: 1 }]
    },
    registry: {
      blocksByName: {
        chest: { id: 54 }
      }
    },
    findBlock: () => null,
    health: 20,
    food: 20
  };
}

test('Manager: Selects validated procedure matching objective by tag and marks as reliable', () => {
  const memory = new ProcedureMemory();
  const proc = createProcedureTemplate({
    id: 'mine_oak_trees',
    name: 'Harvest Oak Logs',
    status: 'validated',
    metadata: {
      tags: ['wooden_pickaxe', 'wood', 'log'],
      confidenceScore: 0.95,
      executionCount: 10
    },
    steps: [{ id: 'step_mine', action: 'break_block' }]
  });
  memory.register(proc);

  const match = selectProcedureForObjective(memory, 'wooden_pickaxe');

  assert.ok(match);
  assert.equal(match.procedure.id, 'mine_oak_trees');
  assert.equal(match.isReliable, true);
});

test('Manager: Prioritizes validated procedure over experimental procedure for same objective', () => {
  const memory = new ProcedureMemory();

  const expProc = createProcedureTemplate({
    id: 'mine_stone_fast',
    name: 'Mine Stone Experimental',
    status: 'experimental',
    metadata: {
      tags: ['cobblestone'],
      confidenceScore: 0.99,
      executionCount: 20
    },
    steps: [{ id: 'step_exp', action: 'break_block' }]
  });

  const valProc = createProcedureTemplate({
    id: 'mine_stone_safe',
    name: 'Mine Stone Validated',
    status: 'validated',
    metadata: {
      tags: ['cobblestone'],
      confidenceScore: 0.85,
      executionCount: 8
    },
    steps: [{ id: 'step_safe', action: 'break_block' }]
  });

  memory.register(expProc);
  memory.register(valProc);

  const match = selectProcedureForObjective(memory, 'cobblestone');

  assert.ok(match);
  assert.equal(match.procedure.id, 'mine_stone_safe');
  assert.equal(match.isReliable, true);
});

test('Manager: Experimental procedure is NEVER presented as reliable', () => {
  const memory = new ProcedureMemory();
  const expProc = createProcedureTemplate({
    id: 'explore_nether_portal',
    name: 'Build Nether Portal Experimental',
    status: 'experimental',
    metadata: {
      tags: ['nether_portal'],
      confidenceScore: 0.70
    },
    steps: [{ id: 'step_portal', action: 'place_block' }]
  });
  memory.register(expProc);

  const strictMatch = selectProcedureForObjective(memory, 'nether_portal', { onlyValidated: true });
  assert.equal(strictMatch, null);

  const match = selectProcedureForObjective(memory, 'nether_portal');
  assert.ok(match);
  assert.equal(match.procedure.id, 'explore_nether_portal');
  assert.equal(match.isReliable, false);

  const bot = createMockBot();
  const sanitized = sanitizeProcedureDecision(bot, 'explore_nether_portal', null, memory);
  assert.equal(sanitized.action, 'procedure');
  assert.equal(sanitized.isReliable, false);
  assert.match(sanitized.directive, /non garantie|expérimentale/i);
});

test('Manager: Ignores deprecated procedures and falls back to exploration', () => {
  const memory = new ProcedureMemory();
  const depProc = createProcedureTemplate({
    id: 'obsolete_craft_iron',
    status: 'deprecated',
    metadata: {
      tags: ['iron_ingot']
    },
    steps: [{ id: 'step_iron', action: 'smelt_ore' }]
  });
  memory.register(depProc);

  const match = selectProcedureForObjective(memory, 'iron_ingot');
  assert.equal(match, null);

  const bot = createMockBot();
  const sanitized = sanitizeProcedureDecision(bot, 'obsolete_craft_iron', null, memory);
  assert.equal(sanitized.action, 'explore');
  assert.equal(sanitized.isReliable, false);
});

test('Manager: Sets managerSubGoal towards dispatcher procedure when validated procedure matches', async () => {
  const bot = createMockBot();
  const memory = new ProcedureMemory();
  state.procedureMemory = memory;
  state.manualObjective = true;
  state.currentObjective = 'stone_pickaxe';
  state.isSurviving = true;
  state.isManagerThinking = false;

  const validProcedure = createProcedureTemplate({
    id: 'craft_stone_pickaxe_chain',
    status: 'validated',
    metadata: {
      tags: ['stone_pickaxe'],
      confidenceScore: 0.90,
      executionCount: 6
    },
    steps: [{ id: 'step_one', action: 'craft_recipe' }]
  });
  memory.register(validProcedure);

  await runManagerCycle(bot);

  assert.ok(state.managerSubGoal);
  assert.equal(state.managerSubGoal.action, 'procedure');
  assert.equal(state.managerSubGoal.target, 'craft_stone_pickaxe_chain');
  assert.equal(state.managerSubGoal.isReliable, true);
  assert.match(state.managerDirective, /craft_stone_pickaxe_chain/i);
});

test('Manager: Sanitizes supervisor LLM procedure outputs and flags reliability', () => {
  const bot = createMockBot();
  const memory = new ProcedureMemory();
  state.procedureMemory = memory;

  const proc = createProcedureTemplate({
    id: 'smelt_iron_ingot',
    status: 'validated',
    steps: [{ id: 'smelt_step', action: 'smelt' }]
  });
  memory.register(proc);

  const validatedRes = sanitizeManagerOutput(bot, {
    directive: 'Fondre le minerai',
    suggestedAction: 'procedure',
    suggestedTarget: 'smelt_iron_ingot'
  });

  assert.equal(validatedRes.suggestedAction, 'procedure');
  assert.equal(validatedRes.suggestedTarget, 'smelt_iron_ingot');
  assert.equal(validatedRes.isReliable, true);

  const hallucinatedRes = sanitizeManagerOutput(bot, {
    directive: 'Exécuter action fantôme',
    suggestedAction: 'procedure',
    suggestedTarget: 'ghost_procedure'
  });

  assert.equal(hallucinatedRes.suggestedAction, 'explore');
  assert.equal(hallucinatedRes.suggestedTarget, 'none');
  assert.equal(hallucinatedRes.isReliable, false);
});
