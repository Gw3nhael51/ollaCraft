const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');

const { dispatchSkill, skillProcedure } = require('../src/actions/dispatcher');
const { ActionRegistry } = require('../src/procedures/registry');
const { ProcedureMemory } = require('../src/procedures/memory');
const { createProcedureTemplate } = require('../src/procedures/schema');
const { createResult } = require('../src/actions/primitives/result');

/**
 * Build simulated bot instance for dispatcher testing
 * @returns {object} Simulated bot
 */
function createMockBot() {
  return {
    entity: {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true
    },
    inventory: {
      items: () => [{ name: 'iron_pickaxe', count: 1 }]
    }
  };
}

test('Dispatcher: Rejects non-existent procedure in memory', async () => {
  // Configurer : Préparer un état et un bot fictifs
  const bot = createMockBot();
  const state = { procedureMemory: new ProcedureMemory() };

  // Exécuter : Appeler une procédure non enregistrée
  const result = await dispatchSkill(bot, state, 'procedure', 'unknown_procedure');

  assert.equal(result.success, false);
  assert.match(result.message, /not found in procedure memory/i);
});

test('Dispatcher: Rejects invalid procedure identifier', async () => {
  // Configurer : Préparer un environnement de test
  const bot = createMockBot();
  const state = { procedureMemory: new ProcedureMemory() };

  // Vérifier : Tester les identifiants invalides
  const emptyRes = await dispatchSkill(bot, state, 'procedure', '');
  assert.equal(emptyRes.success, false);
  assert.match(emptyRes.message, /invalid procedure identifier/i);

  const specialRes = await dispatchSkill(bot, state, 'procedure', 'bad identifier!');
  assert.equal(specialRes.success, false);
  assert.match(specialRes.message, /invalid procedure identifier/i);
});

test('Dispatcher: Rejects deprecated and invalid status procedures', async () => {
  // Configurer : Initialiser le registre et la mémoire
  const bot = createMockBot();
  const memory = new ProcedureMemory();
  const state = { procedureMemory: memory };

  const deprecatedProc = createProcedureTemplate({
    id: 'deprecated_task',
    status: 'deprecated',
    steps: [{ id: 'step_one', action: 'noop' }]
  });
  memory.register(deprecatedProc);

  // Exécuter : Tenter d'exécuter la procédure dépréciée
  const depResult = await dispatchSkill(bot, state, 'procedure', 'deprecated_task');
  assert.equal(depResult.success, false);
  assert.match(depResult.message, /deprecated/i);

  const invalidStatusProc = createProcedureTemplate({
    id: 'invalid_status_task',
    status: 'obsolete',
    steps: [{ id: 'step_one', action: 'noop' }]
  });
  memory.register(invalidStatusProc);

  // Exécuter : Tenter d'exécuter la procédure avec statut invalide
  const invResult = await dispatchSkill(bot, state, 'procedure', 'invalid_status_task');
  assert.equal(invResult.success, false);
  assert.match(invResult.message, /invalid status/i);
});

test('Dispatcher: Enforces semantic validation and rejects unknown registry actions', async () => {
  // Configurer : Définir un registre d'actions limité
  const bot = createMockBot();
  const registry = new ActionRegistry();
  const memory = new ProcedureMemory();
  const state = { procedureMemory: memory };

  const invalidProc = createProcedureTemplate({
    id: 'unregistered_action_proc',
    status: 'validated',
    steps: [{ id: 'step_one', action: 'arbitrary_eval_code' }]
  });
  memory.register(invalidProc);

  // Exécuter : Vérifier le refus de l'action non répertoriée
  const result = await dispatchSkill(bot, state, 'procedure', 'unregistered_action_proc', 1, {
    actionRegistry: registry
  });

  assert.equal(result.success, false);
  assert.match(result.message, /validation failed/i);
  assert.match(result.message, /unknown action 'arbitrary_eval_code'/i);
});

test('Dispatcher: Validates presence and types of declared parameters', async () => {
  // Configurer : Définir une procédure avec paramètres obligatoires et typés
  const bot = createMockBot();
  const registry = new ActionRegistry();
  const memory = new ProcedureMemory();
  const state = { procedureMemory: memory };

  registry.register({
    id: 'perform_step',
    parametersSchema: { required: ['count'] },
    handler: async () => createResult(true, 'performed')
  });

  const proc = createProcedureTemplate({
    id: 'typed_param_proc',
    status: 'experimental',
    parameters: {
      count: { type: 'number', required: true }
    },
    steps: [
      {
        id: 'step_one',
        action: 'perform_step',
        parameters: { count: '$parameters.count' }
      }
    ]
  });
  memory.register(proc);

  // Vérifier : Détecter l'omission d'un paramètre obligatoire
  const missingRes = await dispatchSkill(bot, state, 'procedure', 'typed_param_proc', null, {
    actionRegistry: registry
  });
  assert.equal(missingRes.success, false);
  assert.match(missingRes.message, /missing required parameter 'count'/i);

  // Vérifier : Détecter un type erroné pour un paramètre
  const badTypeRes = await dispatchSkill(bot, state, 'procedure', 'typed_param_proc', { count: 'three' }, {
    actionRegistry: registry
  });
  assert.equal(badTypeRes.success, false);
  assert.match(badTypeRes.message, /must be of type 'number'/i);
});

test('Dispatcher: Successfully executes registered procedure and updates lifecycle stats', async () => {
  // Configurer : Définir une procédure valide et enregistrée
  const bot = createMockBot();
  const registry = new ActionRegistry();
  const memory = new ProcedureMemory();
  const state = { procedureMemory: memory };

  let stepCallCount = 0;
  registry.register({
    id: 'harvest_action',
    parametersSchema: { required: ['targetName', 'count'] },
    handler: async (_bot, params) => {
      stepCallCount += params.count;
      return createResult(true, 'harvested', { harvested: params.count });
    }
  });

  const procedure = createProcedureTemplate({
    id: 'harvest_wood_batch',
    status: 'experimental',
    parameters: {
      count: { type: 'number', default: 1 }
    },
    steps: [
      {
        id: 'harvest_step',
        action: 'harvest_action',
        parameters: {
          targetName: 'oak_log',
          count: '$parameters.count'
        }
      }
    ]
  });
  memory.register(procedure);

  // Exécuter : Déclencher la procédure via le dispatcher avec paramètre quantitatif
  const result = await dispatchSkill(bot, state, 'procedure', 'harvest_wood_batch', 3, {
    actionRegistry: registry
  });

  assert.equal(result.success, true);
  assert.match(result.message, /completed successfully/i);
  assert.equal(stepCallCount, 3);

  // Vérifier : Confirmer l'enregistrement des statistiques dans la mémoire
  const updatedProc = memory.get('harvest_wood_batch');
  assert.equal(updatedProc.metadata.executionCount, 1);
  assert.equal(updatedProc.metadata.successCount, 1);
});

test('Dispatcher: Converts runner step failure to dispatcher error format', async () => {
  // Configurer : Simuler un échec dans le gestionnaire de primitive
  const bot = createMockBot();
  const registry = new ActionRegistry();
  const memory = new ProcedureMemory();
  const state = { procedureMemory: memory };

  registry.register({
    id: 'faulty_action',
    handler: async () => createResult(false, 'block_unreachable', null, 'Target block is out of range')
  });

  const procedure = createProcedureTemplate({
    id: 'failing_procedure',
    status: 'experimental',
    steps: [
      {
        id: 'step_faulty',
        action: 'faulty_action'
      }
    ]
  });
  memory.register(procedure);

  // Exécuter : Constater la conversion de l'échec
  const result = await dispatchSkill(bot, state, 'procedure', 'failing_procedure', 1, {
    actionRegistry: registry
  });

  assert.equal(result.success, false);
  assert.match(result.message, /failed/i);
  assert.match(result.message, /block_unreachable/i);

  // Vérifier : Vérifier la mise à jour des statistiques d'échec
  const recorded = memory.get('failing_procedure');
  assert.equal(recorded.metadata.executionCount, 1);
  assert.equal(recorded.metadata.failureCount, 1);
});

test('Dispatcher: Non-regression for standard skills and unknown action fallback', async () => {
  // Configurer : Définir un état global minimal
  const bot = createMockBot();
  const state = {};

  // Vérifier : Tester la persistance du repli pour les actions inconnues
  const unknownRes = await dispatchSkill(bot, state, 'unrecognized_skill', 'dirt');
  assert.equal(unknownRes.success, false);
  assert.equal(unknownRes.message, "Unknown action 'unrecognized_skill'.");
});
