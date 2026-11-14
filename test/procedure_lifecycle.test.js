const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  FAILURE_CATEGORIES,
  generateExecutionId,
  classifyFailureCause,
  buildEvaluationRecord,
  evaluatePromotionEligibility,
  analyzeDeprecationRisk,
  applyEvaluationToLifecycle,
  createVersionedProcedure,
  compareProcedureVersions,
  buildProceduralKnowledgeSummary
} = require('../src/procedures/lifecycle');
const { ProcedureMemory } = require('../src/procedures/memory');
const { createProcedureTemplate } = require('../src/procedures/schema');
const { selectProcedureForObjective } = require('../src/agent/manager');

/**
 * Construire une procédure de test conforme au schéma
 * @param {string} id Identifiant de la procédure
 * @param {object} [overrides={}] Surcharges optionnelles
 * @returns {object} Procédure valide
 */
function buildSampleProc(id, overrides = {}) {
  return createProcedureTemplate({
    id,
    name: overrides.name || `Procedure ${id}`,
    version: overrides.version || 1,
    status: overrides.status || 'experimental',
    preconditions: overrides.preconditions || [
      { type: 'inventory_item', item: 'cobblestone', count: 3, operator: 'gte' },
      { type: 'inventory_item', item: 'stick', count: 2, operator: 'gte' }
    ],
    steps: overrides.steps || [
      { id: 'craft_pick', action: 'craft_recipe', parameters: { recipe: 'stone_pickaxe', count: 1 } }
    ],
    postconditions: overrides.postconditions || [
      { type: 'inventory_item', item: 'stone_pickaxe', count: 1, operator: 'gte' }
    ],
    metadata: {
      tags: ['stone_pickaxe', 'crafting'],
      ...(overrides.metadata || {})
    }
  });
}

/**
 * Construire un résultat d'Evaluator simulé
 * @param {object} [overrides={}] Surcharges du rapport d'évaluation
 * @returns {object} Rapport d'évaluation
 */
function buildEval(overrides = {}) {
  return {
    procedureId: overrides.procedureId || 'craft_stone_pickaxe',
    status: overrides.status || 'achieved',
    executionSuccess: overrides.executionSuccess !== undefined ? overrides.executionSuccess : true,
    postconditionsPassed: overrides.postconditionsPassed !== undefined ? overrides.postconditionsPassed : true,
    objectiveAchieved: overrides.objectiveAchieved !== undefined ? overrides.objectiveAchieved : true,
    verifiedFacts: overrides.verifiedFacts || [
      { source: 'postcondition', type: 'inventory_item', actual: 1, expected: 1 },
      { source: 'objective', type: 'item', target: 'stone_pickaxe', actual: 1, expected: 1 }
    ],
    failedConditions: overrides.failedConditions || [],
    unknownConditions: overrides.unknownConditions || [],
    contradictions: overrides.contradictions || [],
    resourceShortage: Boolean(overrides.resourceShortage),
    deprecateRecommended: Boolean(overrides.deprecateRecommended),
    confidence: overrides.confidence !== undefined ? overrides.confidence : 1.0
  };
}

test('4.6.1 Evaluation Recording: Stores trace, evaluator result, conditions, failure cause, and prevents double counting via executionId', async () => {
  const memory = new ProcedureMemory();
  const proc = buildSampleProc('craft_stone_pickaxe');
  memory.register(proc);

  const execId = generateExecutionId('craft_stone_pickaxe');
  const trace = {
    executionId: execId,
    procedureId: 'craft_stone_pickaxe',
    status: 'completed',
    success: true,
    executionDurationMs: 120,
    steps: [
      { stepId: 'craft_pick', action: 'craft_recipe', success: true, reason: 'crafted' }
    ]
  };
  const evaluation = buildEval({ procedureId: 'craft_stone_pickaxe' });

  const firstRecord = await memory.recordEvaluation('craft_stone_pickaxe', evaluation, {
    executionTrace: trace,
    context: { scenarioId: 'world_seed_1' }
  });

  assert.equal(firstRecord.duplicateSkipped, false);
  assert.equal(firstRecord.record.executionId, execId);
  assert.equal(firstRecord.record.traceSummary.stepsExecuted, 1);
  assert.equal(firstRecord.record.evaluationSummary.verifiedFactsCount, 2);
  assert.equal(firstRecord.updatedProcedure.metadata.executionCount, 1);
  assert.equal(firstRecord.updatedProcedure.metadata.evaluationHistory.length, 1);

  // Vérifier : Ignorer un second enregistrement portant le même executionId
  const duplicateAttempt = await memory.recordEvaluation('craft_stone_pickaxe', evaluation, {
    executionTrace: trace,
    context: { scenarioId: 'world_seed_1' }
  });

  assert.equal(duplicateAttempt.duplicateSkipped, true);
  assert.equal(duplicateAttempt.updatedProcedure.metadata.executionCount, 1);
  assert.equal(duplicateAttempt.updatedProcedure.metadata.evaluationHistory.length, 1);
});

test('4.6.2 Promotion Policy: Requires 3 verified independent successes and excludes resource shortages from penalties', () => {
  let proc = buildSampleProc('craft_stone_pickaxe');

  // Enregistrer : Première réussite (scénario A)
  let res = applyEvaluationToLifecycle(proc, buildEval(), {
    context: { scenarioId: 'scenario_a' },
    requireIndependentScenarios: true
  });
  proc = res.updatedProcedure;
  assert.equal(proc.status, 'experimental');

  // Enregistrer : Échec lié à un manque de ressources (ne doit pas pénaliser la promotion)
  res = applyEvaluationToLifecycle(
    proc,
    buildEval({
      status: 'not_achieved',
      executionSuccess: false,
      postconditionsPassed: false,
      objectiveAchieved: false,
      resourceShortage: true,
      confidence: 0
    }),
    {
      executionTrace: { status: 'preconditions_failed', success: false },
      context: { scenarioId: 'scenario_shortage' },
      requireIndependentScenarios: true
    }
  );
  proc = res.updatedProcedure;
  assert.equal(proc.status, 'experimental');
  assert.equal(proc.metadata.penalizableFailureCount, 0);
  assert.equal(proc.metadata.failureBreakdown.resource_shortage, 1);

  // Enregistrer : Deuxième et troisième réussites mais clonées sur le même scenario_a
  res = applyEvaluationToLifecycle(proc, buildEval(), {
    context: { scenarioId: 'scenario_a' },
    requireIndependentScenarios: true
  });
  proc = res.updatedProcedure;

  res = applyEvaluationToLifecycle(proc, buildEval(), {
    context: { scenarioId: 'scenario_a' },
    requireIndependentScenarios: true
  });
  proc = res.updatedProcedure;

  // Vérifier : Refuser la promotion car les 3 réussites proviennent du même scénario répété
  assert.equal(proc.status, 'experimental');
  assert.equal(res.promotionAnalysis.eligible, false);
  assert.equal(res.promotionAnalysis.distinctScenarioCount, 1);

  // Enregistrer : Réussite dans un scénario indépendant (scenario_b)
  res = applyEvaluationToLifecycle(proc, buildEval(), {
    context: { scenarioId: 'scenario_b' },
    requireIndependentScenarios: true
  });
  proc = res.updatedProcedure;

  assert.equal(res.promoted, true);
  assert.equal(proc.status, 'validated');
  assert.equal(proc.metadata.effectiveConfidenceScore, 1.0);
});

test('4.6.3 Failure Classification & Deprecation: Distinguishes failure categories and deprecates only on systematic penalizable failures', () => {
  assert.equal(
    classifyFailureCause(buildEval({ status: 'not_achieved', resourceShortage: true })),
    FAILURE_CATEGORIES.RESOURCE_SHORTAGE
  );

  assert.equal(
    classifyFailureCause(buildEval({
      status: 'not_achieved',
      contradictions: [{ stepId: 's1', code: 'CRAFT_OUTPUT_MISSING_IN_INVENTORY', message: 'Missing item' }]
    })),
    FAILURE_CATEGORIES.CONTRADICTION
  );

  assert.equal(
    classifyFailureCause(buildEval({
      status: 'inconclusive',
      objectiveAchieved: false,
      unknownConditions: [{ source: 'objective', message: 'Sensor offline' }],
      failedConditions: [{ source: 'objective', status: 'unknown', message: 'Sensor offline' }]
    })),
    FAILURE_CATEGORIES.INCONCLUSIVE
  );

  assert.equal(
    classifyFailureCause(
      buildEval({ status: 'not_achieved', executionSuccess: false, objectiveAchieved: false }),
      { success: false, status: 'failed' }
    ),
    FAILURE_CATEGORIES.EXECUTION_ERROR
  );

  assert.equal(
    classifyFailureCause(
      buildEval({ status: 'not_achieved', executionSuccess: true, objectiveAchieved: false, postconditionsPassed: false }),
      { success: true, status: 'completed' }
    ),
    FAILURE_CATEGORIES.OBJECTIVE_NOT_ACHIEVED
  );

  // Tester : Cinq échecs de ressources consécutifs ne déprécient JAMAIS la procédure
  let proc = buildSampleProc('mine_diamond', { status: 'validated' });
  for (let i = 0; i < 5; i++) {
    const out = applyEvaluationToLifecycle(
      proc,
      buildEval({
        status: 'not_achieved',
        executionSuccess: false,
        objectiveAchieved: false,
        postconditionsPassed: false,
        resourceShortage: true
      }),
      { context: { scenarioId: `shortage_${i}` } }
    );
    proc = out.updatedProcedure;
  }
  assert.equal(proc.status, 'validated');
  assert.equal(proc.metadata.deprecationCandidate, false);

  // Tester : Trois échecs techniques consécutifs dans des conditions valides déprécient la procédure
  for (let i = 0; i < 3; i++) {
    const out = applyEvaluationToLifecycle(
      proc,
      buildEval({
        status: 'not_achieved',
        executionSuccess: false,
        objectiveAchieved: false,
        postconditionsPassed: false,
        resourceShortage: false
      }),
      {
        executionTrace: {
          status: 'failed',
          success: false,
          steps: [{ stepId: 'craft_pick', action: 'craft_recipe', success: false, reason: 'craft_failed' }]
        },
        context: { scenarioId: `exec_err_${i}` }
      }
    );
    proc = out.updatedProcedure;
  }

  assert.equal(proc.metadata.deprecationCandidate, true);
  assert.equal(proc.status, 'deprecated');
});

test('4.6.4 Versioning & Improvement: Creates experimental v2 linked to validated v1 and supports performance comparison and fallback', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacraft-lifecycle-ver-'));

  try {
    const memory = new ProcedureMemory({ storageDir: tempDir });
    const v1 = buildSampleProc('craft_stone_pickaxe', {
      version: 1,
      status: 'validated',
      metadata: {
        executionCount: 4,
        successCount: 4,
        failureCount: 0,
        confidenceScore: 1.0,
        effectiveConfidenceScore: 1.0,
        tags: ['stone_pickaxe']
      }
    });
    memory.register(v1);

    const v2Res = await memory.createVersion('craft_stone_pickaxe', {
      name: 'Craft Stone Pickaxe Optimized',
      steps: [
        { id: 'locate_table', action: 'find_block', parameters: { block: 'crafting_table' } },
        { id: 'craft_pick', action: 'craft_recipe', parameters: { recipe: 'stone_pickaxe', count: 1 } }
      ]
    });

    assert.equal(v2Res.success, true);
    const v2 = v2Res.data.procedure;
    assert.equal(v2.id, 'craft_stone_pickaxe_v2');
    assert.equal(v2.version, 2);
    assert.equal(v2.status, 'experimental');
    assert.equal(v2.metadata.parentId, 'craft_stone_pickaxe');
    assert.equal(v2.metadata.rootId, 'craft_stone_pickaxe');
    assert.deepEqual(v2.metadata.lineage, ['craft_stone_pickaxe']);

    // Vérifier : La v1 validée est intacte en mémoire
    assert.equal(memory.get('craft_stone_pickaxe').status, 'validated');
    assert.equal(memory.get('craft_stone_pickaxe').version, 1);

    // Enregistrer : Un échec technique sur la v2 expérimentale
    await memory.recordEvaluation(
      v2.id,
      buildEval({
        procedureId: v2.id,
        status: 'not_achieved',
        executionSuccess: false,
        objectiveAchieved: false,
        postconditionsPassed: false
      }),
      {
        executionTrace: {
          status: 'failed',
          success: false,
          steps: [{ stepId: 'locate_table', action: 'find_block', success: false, reason: 'block_not_found' }]
        }
      }
    );

    const cmp = memory.compareVersions('craft_stone_pickaxe', v2.id);
    assert.equal(cmp.preferred.id, 'craft_stone_pickaxe');
    assert.equal(cmp.fallback.id, 'craft_stone_pickaxe_v2');
    assert.equal(cmp.comparison.candidateOutperforms, false);

    const fallback = memory.getReliableFallback(v2.id);
    assert.notEqual(fallback, null);
    assert.equal(fallback.id, 'craft_stone_pickaxe');
    assert.equal(fallback.status, 'validated');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('4.6.5 Knowledge Exploitation: Exposes validated procedures, success rates, preconditions, limitations, variants, and past failures to Manager', async () => {
  const memory = new ProcedureMemory();

  const v1 = buildSampleProc('craft_stone_pickaxe', {
    version: 1,
    status: 'validated',
    metadata: {
      executionCount: 4,
      successCount: 4,
      failureCount: 0,
      penalizableFailureCount: 0,
      confidenceScore: 1.0,
      effectiveConfidenceScore: 1.0,
      tags: ['stone_pickaxe']
    }
  });
  memory.register(v1);

  await memory.createVersion('craft_stone_pickaxe', {
    name: 'Craft Stone Pickaxe Experimental Variant'
  });

  // Enregistrer : Un échec de ressources sur la variante v2 pour alimenter les limites connues et l'historique d'échecs
  await memory.recordEvaluation(
    'craft_stone_pickaxe_v2',
    buildEval({
      procedureId: 'craft_stone_pickaxe_v2',
      status: 'not_achieved',
      executionSuccess: false,
      objectiveAchieved: false,
      postconditionsPassed: false,
      resourceShortage: true
    }),
    {
      executionTrace: {
        status: 'failed',
        success: false,
        steps: [{ stepId: 'craft_pick', action: 'craft_recipe', success: false, reason: 'missing_ingredients' }]
      }
    }
  );

  const knowledge = memory.getKnowledge('stone_pickaxe');
  assert.equal(knowledge.objective, 'stone_pickaxe');
  assert.equal(knowledge.validatedProcedures.length, 1);
  assert.equal(knowledge.experimentalVariants.length, 1);
  assert.equal(knowledge.recommendedProcedure.id, 'craft_stone_pickaxe');
  assert.equal(knowledge.overallSuccessRate, 0.8);
  assert.equal(knowledge.effectiveSuccessRate, 1.0);
  assert.equal(knowledge.usualPreconditions.length, 2);
  assert.equal(knowledge.knownLimitations.length, 1);
  assert.match(knowledge.knownLimitations[0], /resource shortage/i);
  assert.equal(knowledge.pastFailures.length, 1);
  assert.equal(knowledge.pastFailures[0].failureCategory, 'resource_shortage');
  assert.equal(knowledge.reusableSteps.length, 1);
  assert.equal(knowledge.reusableSteps[0].procedureId, 'craft_stone_pickaxe');

  const managerSelection = selectProcedureForObjective(memory, 'stone_pickaxe');
  assert.notEqual(managerSelection, null);
  assert.equal(managerSelection.procedure.id, 'craft_stone_pickaxe');
  assert.equal(managerSelection.isReliable, true);
  assert.notEqual(managerSelection.knowledge, null);
  assert.equal(managerSelection.knowledge.effectiveSuccessRate, 1.0);
});
