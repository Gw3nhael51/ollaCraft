const crypto = require('node:crypto');
const { createResult } = require('../actions/primitives/result');

const FAILURE_CATEGORIES = Object.freeze({
  RESOURCE_SHORTAGE: 'resource_shortage',
  EXECUTION_ERROR: 'execution_error',
  OBJECTIVE_NOT_ACHIEVED: 'objective_not_achieved',
  CONTRADICTION: 'contradiction',
  INCONCLUSIVE: 'inconclusive'
});

const DEFAULT_PROMOTION_POLICY = Object.freeze({
  minSuccessfulExecutions: 3,
  minDistinctScenarios: 2,
  minEffectiveConfidence: 0.75,
  minEvaluationConfidence: 0.7,
  maxRecentContradictions: 0,
  maxHistoryEntries: 50
});

const DEFAULT_DEPRECATION_POLICY = Object.freeze({
  minPenalizableFailures: 3,
  minConsecutivePenalizableFailures: 3,
  minContradictionsForDeprecation: 2,
  maxEffectiveConfidence: 0.45,
  minQualifiedExecutions: 4
});

/**
 * Générer un identifiant unique d'exécution pour prévenir les doubles comptabilisations
 * @param {string} [procedureId='proc'] Identifiant de la procédure exécutée
 * @returns {string} Identifiant d'exécution unique
 */
function generateExecutionId(procedureId = 'proc') {
  const randomPart = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `exec_${procedureId}_${Date.now().toString(36)}_${randomPart}`;
}

/**
 * Calculer une empreinte de scénario pour mesurer l'indépendance entre plusieurs exécutions
 * @param {object} [executionTrace={}] Trace du Runner
 * @param {object} [evaluation={}] Résultat de l'Evaluator
 * @param {object} [context={}] Contexte additionnel de l'exécution
 * @returns {string} Clé de scénario normalisée
 */
function computeScenarioSignature(executionTrace = {}, evaluation = {}, context = {}) {
  if (typeof context.scenarioId === 'string' && context.scenarioId.trim().length > 0) {
    return context.scenarioId.trim();
  }

  if (typeof executionTrace.scenarioId === 'string' && executionTrace.scenarioId.trim().length > 0) {
    return executionTrace.scenarioId.trim();
  }

  const steps = Array.isArray(executionTrace?.steps) ? executionTrace.steps : [];
  const stepParamSummary = steps.map(s => ({
    id: s.stepId || s.id,
    action: s.action,
    params: s.parameters || {},
    outputPos: s.output?.position || s.output?.placedPosition || null
  }));

  const payload = {
    parameters: context.parameters || executionTrace.parameters || {},
    botPosition: context.botPosition || null,
    worldSeed: context.worldSeed || null,
    verifiedActuals: Array.isArray(evaluation?.verifiedFacts)
      ? evaluation.verifiedFacts.map(f => ({ type: f.type, target: f.target, actual: f.actual }))
      : [],
    steps: stepParamSummary
  };

  const serialized = JSON.stringify(payload);
  const hash = crypto.createHash('sha1').update(serialized).digest('hex').slice(0, 12);
  return `scen_${hash}`;
}

/**
 * Classifier précisément la cause d'un échec à partir de la trace et de l'évaluation
 * @param {object} evaluation Données d'évaluation issues de l'Evaluator
 * @param {object} [executionTrace={}] Trace d'exécution issue du Runner
 * @returns {string|null} Catégorie d'échec ou null en cas de réussite complète
 */
function classifyFailureCause(evaluation = {}, executionTrace = {}) {
  if (!evaluation || typeof evaluation !== 'object') {
    return FAILURE_CATEGORIES.INCONCLUSIVE;
  }

  if (
    evaluation.status === 'achieved' &&
    evaluation.objectiveAchieved === true &&
    evaluation.postconditionsPassed === true &&
    (!Array.isArray(evaluation.contradictions) || evaluation.contradictions.length === 0)
  ) {
    return null;
  }

  if (Array.isArray(evaluation.contradictions) && evaluation.contradictions.length > 0) {
    return FAILURE_CATEGORIES.CONTRADICTION;
  }

  if (evaluation.resourceShortage === true) {
    return FAILURE_CATEGORIES.RESOURCE_SHORTAGE;
  }

  if (
    evaluation.status === 'inconclusive' ||
    (Array.isArray(evaluation.unknownConditions) &&
      evaluation.unknownConditions.length > 0 &&
      (!Array.isArray(evaluation.failedConditions) ||
        evaluation.failedConditions.every(f => f.status === 'unknown')))
  ) {
    return FAILURE_CATEGORIES.INCONCLUSIVE;
  }

  const runnerFailed = evaluation.executionSuccess === false ||
    (executionTrace && executionTrace.success === false);

  if (runnerFailed) {
    return FAILURE_CATEGORIES.EXECUTION_ERROR;
  }

  return FAILURE_CATEGORIES.OBJECTIVE_NOT_ACHIEVED;
}

/**
 * Construire un enregistrement d'évaluation normalisé et horodaté pour l'historique
 * @param {object} params Paramètres d'enregistrement
 * @param {object} params.procedure Procédure concernée
 * @param {object} [params.executionTrace={}] Trace du Runner
 * @param {object} [params.evaluation={}] Résultat de l'Evaluator
 * @param {object} [params.context={}] Contexte d'exécution optionnel
 * @returns {object} Entrée d'historique structurée
 */
function buildEvaluationRecord({
  procedure,
  executionTrace = {},
  evaluation = {},
  context = {}
}) {
  const normalizedTrace = executionTrace?.trace || executionTrace?.data?.trace || executionTrace || {};
  const normalizedEval = evaluation?.data || evaluation || {};
  const procedureId = procedure?.id || normalizedEval.procedureId || normalizedTrace.procedureId || 'unknown';

  const executionId = context.executionId ||
    normalizedTrace.executionId ||
    normalizedEval.executionId ||
    generateExecutionId(procedureId);

  const steps = Array.isArray(normalizedTrace.steps)
    ? normalizedTrace.steps
    : (Array.isArray(normalizedTrace.stepTraces) ? normalizedTrace.stepTraces : []);

  const failedStep = steps.find(s => s && !s.success) || null;
  const failureCategory = classifyFailureCause(normalizedEval, normalizedTrace);
  const scenarioKey = computeScenarioSignature(normalizedTrace, normalizedEval, context);

  const isSuccess = failureCategory === null &&
    normalizedEval.status === 'achieved' &&
    normalizedEval.objectiveAchieved === true &&
    normalizedEval.postconditionsPassed === true;

  const isObservabilitySufficient = Array.isArray(normalizedEval.unknownConditions)
    ? normalizedEval.unknownConditions.length === 0
    : true;

  return {
    executionId,
    procedureId,
    procedureVersion: procedure?.version || 1,
    timestamp: context.timestamp || normalizedTrace.completedAt || new Date().toISOString(),
    scenarioKey,
    artificialRepetition: Boolean(context.artificialRepetition),
    success: isSuccess,
    status: normalizedEval.status || (isSuccess ? 'achieved' : 'not_achieved'),
    failureCategory,
    penalizableFailure: Boolean(
      !isSuccess &&
      failureCategory !== FAILURE_CATEGORIES.RESOURCE_SHORTAGE &&
      failureCategory !== FAILURE_CATEGORIES.INCONCLUSIVE
    ),
    traceSummary: {
      runnerStatus: normalizedTrace.status || (normalizedTrace.success ? 'completed' : 'failed'),
      executionSuccess: Boolean(
        normalizedEval.executionSuccess !== undefined
          ? normalizedEval.executionSuccess
          : normalizedTrace.success
      ),
      stepsExecuted: steps.length,
      durationMs: normalizedTrace.executionDurationMs || normalizedTrace.durationMs || 0,
      failedStepId: failedStep ? (failedStep.stepId || failedStep.id || null) : (normalizedTrace.failedStepId || null),
      failedStepAction: failedStep ? (failedStep.action || null) : null,
      failureReason: failedStep ? (failedStep.reason || failedStep.error || null) : (normalizedTrace.reason || null)
    },
    evaluationSummary: {
      objectiveAchieved: Boolean(normalizedEval.objectiveAchieved),
      postconditionsPassed: Boolean(normalizedEval.postconditionsPassed),
      observabilitySufficient: isObservabilitySufficient,
      resourceShortage: Boolean(normalizedEval.resourceShortage),
      deprecateRecommended: Boolean(normalizedEval.deprecateRecommended),
      confidence: typeof normalizedEval.confidence === 'number' ? normalizedEval.confidence : (isSuccess ? 1 : 0),
      verifiedFactsCount: Array.isArray(normalizedEval.verifiedFacts) ? normalizedEval.verifiedFacts.length : 0,
      failedConditionsCount: Array.isArray(normalizedEval.failedConditions) ? normalizedEval.failedConditions.length : 0,
      unknownConditionsCount: Array.isArray(normalizedEval.unknownConditions) ? normalizedEval.unknownConditions.length : 0,
      contradictionsCount: Array.isArray(normalizedEval.contradictions) ? normalizedEval.contradictions.length : 0,
      verifiedFacts: Array.isArray(normalizedEval.verifiedFacts) ? [...normalizedEval.verifiedFacts] : [],
      failedConditions: Array.isArray(normalizedEval.failedConditions) ? [...normalizedEval.failedConditions] : [],
      unknownConditions: Array.isArray(normalizedEval.unknownConditions) ? [...normalizedEval.unknownConditions] : [],
      contradictions: Array.isArray(normalizedEval.contradictions) ? [...normalizedEval.contradictions] : []
    }
  };
}

/**
 * Évaluer l'éligibilité d'une procédure expérimentale à la promotion vers le statut validé
 * @param {Array<object>} evaluationHistory Historique des évaluations de la procédure
 * @param {object} [policy={}] Politique de promotion personnalisée
 * @returns {{
 *   eligible: boolean,
 *   qualifiedSuccessCount: number,
 *   distinctScenarioCount: number,
 *   effectiveConfidence: number,
 *   reasons: string[]
 * }} Verdict détaillé d'éligibilité à la promotion
 */
function evaluatePromotionEligibility(evaluationHistory = [], policy = {}) {
  const cfg = { ...DEFAULT_PROMOTION_POLICY, ...policy };
  const history = Array.isArray(evaluationHistory) ? evaluationHistory : [];
  const reasons = [];

  // Filtrer : Retirer les répétitions artificielles explicites
  const nonArtificial = history.filter(entry => !entry.artificialRepetition);

  // Identifier : Compter les réussites qualifiées remplissant tous les critères stricts
  const qualifiedSuccesses = nonArtificial.filter(entry => {
    const evalSum = entry.evaluationSummary || {};
    return (
      entry.success === true &&
      entry.status === 'achieved' &&
      evalSum.objectiveAchieved === true &&
      evalSum.postconditionsPassed === true &&
      evalSum.observabilitySufficient === true &&
      evalSum.contradictionsCount === 0 &&
      evalSum.confidence >= cfg.minEvaluationConfidence
    );
  });

  // Regrouper : Vérifier l'indépendance des scénarios parmi les réussites qualifiées
  const distinctScenarios = new Set(
    qualifiedSuccesses.map(entry => entry.scenarioKey || entry.executionId)
  );

  // Calculer : Exclure les pénuries de ressources et les cas inconclusifs du dénominateur de sanction
  const relevantExecutions = nonArtificial.filter(entry =>
    entry.failureCategory !== FAILURE_CATEGORIES.RESOURCE_SHORTAGE &&
    entry.failureCategory !== FAILURE_CATEGORIES.INCONCLUSIVE
  );

  const effectiveConfidence = relevantExecutions.length > 0
    ? Number((qualifiedSuccesses.length / relevantExecutions.length).toFixed(3))
    : 0;

  const recentEntries = nonArtificial.slice(-cfg.minSuccessfulExecutions);
  const recentContradictions = recentEntries.reduce(
    (sum, entry) => sum + (entry.evaluationSummary?.contradictionsCount || 0),
    0
  );

  if (qualifiedSuccesses.length < cfg.minSuccessfulExecutions) {
    reasons.push(
      `Requires at least ${cfg.minSuccessfulExecutions} fully verified successes (found ${qualifiedSuccesses.length})`
    );
  }

  const requiredDistinct = policy.requireIndependentScenarios === false
    ? 1
    : Math.min(cfg.minDistinctScenarios, cfg.minSuccessfulExecutions);

  if (distinctScenarios.size < requiredDistinct) {
    reasons.push(
      `Requires at least ${requiredDistinct} independent execution scenarios (found ${distinctScenarios.size})`
    );
  }

  if (effectiveConfidence < cfg.minEffectiveConfidence) {
    reasons.push(
      `Effective confidence ${effectiveConfidence} is below threshold ${cfg.minEffectiveConfidence}`
    );
  }

  if (recentContradictions > cfg.maxRecentContradictions) {
    reasons.push(
      `Recent executions contain ${recentContradictions} trace contradiction(s)`
    );
  }

  return {
    eligible: reasons.length === 0,
    qualifiedSuccessCount: qualifiedSuccesses.length,
    distinctScenarioCount: distinctScenarios.size,
    effectiveConfidence,
    reasons
  };
}

/**
 * Analyser l'historique d'échecs pour déterminer prudemment si une procédure doit être candidate à la dépréciation
 * @param {Array<object>} evaluationHistory Historique des évaluations
 * @param {object} [policy={}] Politique de dépréciation
 * @returns {{
 *   deprecationCandidate: boolean,
 *   shouldDeprecate: boolean,
 *   penalizableFailures: number,
 *   consecutivePenalizableFailures: number,
 *   contradictionFailures: number,
 *   resourceShortageFailures: number,
 *   effectiveConfidence: number,
 *   reasons: string[]
 * }} Analyse de dépréciation
 */
function analyzeDeprecationRisk(evaluationHistory = [], policy = {}) {
  const cfg = { ...DEFAULT_DEPRECATION_POLICY, ...policy };
  const history = Array.isArray(evaluationHistory) ? evaluationHistory : [];
  const reasons = [];

  const penalizableEntries = history.filter(e => e.penalizableFailure === true);
  const contradictionEntries = history.filter(e => e.failureCategory === FAILURE_CATEGORIES.CONTRADICTION);
  const resourceShortageEntries = history.filter(e => e.failureCategory === FAILURE_CATEGORIES.RESOURCE_SHORTAGE);

  const relevantExecutions = history.filter(e =>
    e.failureCategory !== FAILURE_CATEGORIES.RESOURCE_SHORTAGE &&
    e.failureCategory !== FAILURE_CATEGORIES.INCONCLUSIVE
  );

  const relevantSuccesses = relevantExecutions.filter(e => e.success === true);
  const effectiveConfidence = relevantExecutions.length > 0
    ? Number((relevantSuccesses.length / relevantExecutions.length).toFixed(3))
    : 1;

  // Compter : Mesurer la série d'échecs pénalisables consécutifs les plus récents
  let consecutivePenalizableFailures = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (
      entry.failureCategory === FAILURE_CATEGORIES.RESOURCE_SHORTAGE ||
      entry.failureCategory === FAILURE_CATEGORIES.INCONCLUSIVE
    ) {
      continue;
    }
    if (entry.penalizableFailure === true) {
      consecutivePenalizableFailures++;
    } else if (entry.success === true) {
      break;
    }
  }

  if (contradictionEntries.length >= cfg.minContradictionsForDeprecation) {
    reasons.push(`Detected ${contradictionEntries.length} trace contradictions with real world state`);
  }

  if (consecutivePenalizableFailures >= cfg.minConsecutivePenalizableFailures) {
    reasons.push(`Observed ${consecutivePenalizableFailures} consecutive penalizable failures under valid conditions`);
  }

  if (
    relevantExecutions.length >= cfg.minQualifiedExecutions &&
    penalizableEntries.length >= cfg.minPenalizableFailures &&
    effectiveConfidence <= cfg.maxEffectiveConfidence
  ) {
    reasons.push(
      `Low effective success rate (${effectiveConfidence}) across ${relevantExecutions.length} qualified executions`
    );
  }

  const deprecationCandidate = reasons.length > 0;
  const shouldDeprecate = Boolean(
    deprecationCandidate &&
    policy.autoDeprecate !== false &&
    (consecutivePenalizableFailures >= cfg.minConsecutivePenalizableFailures ||
      contradictionEntries.length >= cfg.minContradictionsForDeprecation ||
      (relevantExecutions.length >= 5 && effectiveConfidence < 0.5))
  );

  return {
    deprecationCandidate,
    shouldDeprecate,
    penalizableFailures: penalizableEntries.length,
    consecutivePenalizableFailures,
    contradictionFailures: contradictionEntries.length,
    resourceShortageFailures: resourceShortageEntries.length,
    effectiveConfidence,
    reasons
  };
}

/**
 * Appliquer un enregistrement d'évaluation au cycle de vie d'une procédure sans double comptabilisation
 * @param {object} procedure Objet procédure à mettre à jour
 * @param {object} evaluationInput Résultat de l'Evaluator ou enregistrement structuré
 * @param {object} [options={}] Trace du Runner et options de politique de cycle de vie
 * @returns {{
 *   updatedProcedure: object,
 *   record: object,
 *   duplicateSkipped: boolean,
 *   promoted: boolean,
 *   deprecated: boolean,
 *   promotionAnalysis: object,
 *   deprecationAnalysis: object
 * }} Résultat complet de l'évolution de la procédure
 */
function applyEvaluationToLifecycle(procedure, evaluationInput, options = {}) {
  if (!procedure || typeof procedure !== 'object') {
    throw new Error('Procedure must be a valid object');
  }

  const metadata = procedure.metadata || {};
  const existingHistory = Array.isArray(metadata.evaluationHistory) ? [...metadata.evaluationHistory] : [];

  const record = evaluationInput?.executionId && evaluationInput?.evaluationSummary
    ? evaluationInput
    : buildEvaluationRecord({
        procedure,
        executionTrace: options.executionTrace || options.trace || {},
        evaluation: evaluationInput,
        context: options.context || options
      });

  // Vérifier : Éviter toute double comptabilisation si l'identifiant d'exécution existe déjà
  if (existingHistory.some(item => item.executionId === record.executionId)) {
    const currentPromotion = evaluatePromotionEligibility(existingHistory, options.promotionPolicy);
    const currentDeprecation = analyzeDeprecationRisk(existingHistory, options.deprecationPolicy);
    return {
      updatedProcedure: procedure,
      record,
      duplicateSkipped: true,
      promoted: false,
      deprecated: false,
      promotionAnalysis: currentPromotion,
      deprecationAnalysis: currentDeprecation
    };
  }

  // Détecter : Marquer une répétition artificielle si le même scénario exact est rejoué avec le même contexte
  const isDuplicateScenarioBurst = Boolean(
    options.detectArtificialRepetitions === true &&
    existingHistory.length > 0 &&
    existingHistory[existingHistory.length - 1].scenarioKey === record.scenarioKey
  );

  const finalRecord = isDuplicateScenarioBurst
    ? { ...record, artificialRepetition: true }
    : record;

  const maxHistory = options.maxHistoryEntries || DEFAULT_PROMOTION_POLICY.maxHistoryEntries;
  const updatedHistory = [...existingHistory, finalRecord].slice(-maxHistory);

  const prevBreakdown = metadata.failureBreakdown || {
    resource_shortage: 0,
    execution_error: 0,
    objective_not_achieved: 0,
    contradiction: 0,
    inconclusive: 0
  };

  const nextBreakdown = { ...prevBreakdown };
  if (finalRecord.failureCategory && Object.prototype.hasOwnProperty.call(nextBreakdown, finalRecord.failureCategory)) {
    nextBreakdown[finalRecord.failureCategory] += 1;
  }

  const executionCount = (metadata.executionCount || 0) + 1;
  const successCount = (metadata.successCount || 0) + (finalRecord.success ? 1 : 0);
  const failureCount = (metadata.failureCount || 0) + (finalRecord.success ? 0 : 1);
  const penalizableFailureCount = (metadata.penalizableFailureCount || 0) + (finalRecord.penalizableFailure ? 1 : 0);

  // Calculer : Pondérer le score de confiance en excluant les échecs liés aux ressources et cas inconclusifs
  const qualifiedTotal = successCount + penalizableFailureCount;
  const rawConfidence = qualifiedTotal > 0
    ? Number((successCount / qualifiedTotal).toFixed(3))
    : (metadata.confidenceScore !== undefined ? metadata.confidenceScore : 0.5);

  const confidenceScore = Math.max(0, Math.min(1, rawConfidence));

  const promotionAnalysis = evaluatePromotionEligibility(updatedHistory, {
    requireIndependentScenarios: options.requireIndependentScenarios !== undefined
      ? options.requireIndependentScenarios
      : false,
    ...options.promotionPolicy
  });

  const deprecationAnalysis = analyzeDeprecationRisk(updatedHistory, {
    autoDeprecate: options.autoDeprecate !== undefined ? options.autoDeprecate : true,
    ...options.deprecationPolicy
  });

  let nextStatus = procedure.status || 'experimental';
  let promoted = false;
  let deprecated = false;

  if (nextStatus === 'experimental' && promotionAnalysis.eligible) {
    nextStatus = 'validated';
    promoted = true;
  } else if (
    (nextStatus === 'validated' || nextStatus === 'experimental') &&
    deprecationAnalysis.shouldDeprecate &&
    options.allowDeprecation !== false
  ) {
    // Protéger : Ne déprécier automatiquement une procédure validée que si la politique l'autorise
    if (nextStatus === 'validated' && options.protectValidatedFromAutoDeprecation === true) {
      nextStatus = 'validated';
    } else {
      nextStatus = 'deprecated';
      deprecated = true;
    }
  }

  const now = new Date().toISOString();
  const knownLimitations = extractKnownLimitations(updatedHistory, procedure);

  const updatedProcedure = {
    ...procedure,
    status: nextStatus,
    metadata: {
      ...metadata,
      executionCount,
      successCount,
      failureCount,
      penalizableFailureCount,
      confidenceScore,
      effectiveConfidenceScore: promotionAnalysis.effectiveConfidence,
      failureBreakdown: nextBreakdown,
      deprecationCandidate: deprecationAnalysis.deprecationCandidate,
      deprecationReasons: deprecationAnalysis.reasons,
      knownLimitations,
      lastEvaluationAt: finalRecord.timestamp,
      lastExecutionId: finalRecord.executionId,
      evaluationHistory: updatedHistory,
      updatedAt: now
    }
  };

  return {
    updatedProcedure,
    record: finalRecord,
    duplicateSkipped: false,
    promoted,
    deprecated,
    promotionAnalysis,
    deprecationAnalysis
  };
}

/**
 * Extraire les limites connues d'une procédure à partir de son historique d'évaluations
 * @param {Array<object>} evaluationHistory Historique des évaluations
 * @param {object} [procedure=null] Définition de la procédure
 * @returns {Array<string>} Liste synthétique des limites identifiées
 */
function extractKnownLimitations(evaluationHistory = [], procedure = null) {
  const limitations = new Set(Array.isArray(procedure?.metadata?.knownLimitations) ? procedure.metadata.knownLimitations : []);

  for (const entry of evaluationHistory) {
    if (!entry || entry.success) continue;

    if (entry.failureCategory === FAILURE_CATEGORIES.RESOURCE_SHORTAGE) {
      const reason = entry.traceSummary?.failureReason || 'missing_resources';
      limitations.add(`Sensitive to resource shortage (${reason})`);
    } else if (entry.failureCategory === FAILURE_CATEGORIES.EXECUTION_ERROR) {
      const stepId = entry.traceSummary?.failedStepId || 'unknown_step';
      const action = entry.traceSummary?.failedStepAction || 'action';
      limitations.add(`Step '${stepId}' (${action}) prone to execution error (${entry.traceSummary?.failureReason || 'failed'})`);
    } else if (entry.failureCategory === FAILURE_CATEGORIES.CONTRADICTION) {
      limitations.add('World state contradiction observed after step completion');
    } else if (entry.failureCategory === FAILURE_CATEGORIES.OBJECTIVE_NOT_ACHIEVED) {
      limitations.add('Steps may complete without achieving the target objective');
    }
  }

  return Array.from(limitations);
}

/**
 * Créer une nouvelle version expérimentale liée à une procédure d'origine sans jamais l'écraser
 * @param {object} baseProcedure Procédure parente (souvent validée)
 * @param {object} candidateChanges Nouvelles étapes, préconditions ou paramètres proposés
 * @param {function} [uniqueIdGenerator=null] Fonction de génération d'identifiant unique
 * @param {Set<string>|Array<string>} [existingIds=[]] Ensemble des identifiants existants
 * @returns {object} Nouvelle procédure versionnée avec statut expérimental et lignée
 */
function createVersionedProcedure(baseProcedure, candidateChanges = {}, uniqueIdGenerator = null, existingIds = []) {
  if (!baseProcedure || typeof baseProcedure !== 'object' || !baseProcedure.id) {
    throw new Error('Valid baseProcedure with an id is required to create a new version');
  }

  const rootId = baseProcedure.metadata?.rootId || baseProcedure.id.replace(/_v\d+$/, '').replace(/_exp_\d+$/, '');
  const nextVersion = Math.max(
    (Number.isInteger(baseProcedure.version) ? baseProcedure.version : 1) + 1,
    Number.isInteger(candidateChanges.version) ? candidateChanges.version : 2
  );

  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds);
  taken.add(baseProcedure.id);

  let versionedId = `${rootId}_v${nextVersion}`;
  if (taken.has(versionedId)) {
    if (typeof uniqueIdGenerator === 'function') {
      versionedId = uniqueIdGenerator(versionedId, taken);
    } else {
      let suffix = 1;
      while (taken.has(`${versionedId}_${suffix}`)) {
        suffix++;
      }
      versionedId = `${versionedId}_${suffix}`;
    }
  }

  const now = new Date().toISOString();
  const parentLineage = Array.isArray(baseProcedure.metadata?.lineage)
    ? [...baseProcedure.metadata.lineage]
    : [];

  if (!parentLineage.includes(baseProcedure.id)) {
    parentLineage.push(baseProcedure.id);
  }

  const mergedTags = Array.from(new Set([
    ...(Array.isArray(baseProcedure.metadata?.tags) ? baseProcedure.metadata.tags : []),
    ...(Array.isArray(candidateChanges.metadata?.tags) ? candidateChanges.metadata.tags : []),
    rootId
  ]));

  return {
    ...baseProcedure,
    ...candidateChanges,
    id: versionedId,
    version: nextVersion,
    name: candidateChanges.name || `${baseProcedure.name} (v${nextVersion})`,
    status: 'experimental',
    steps: Array.isArray(candidateChanges.steps) && candidateChanges.steps.length > 0
      ? candidateChanges.steps
      : baseProcedure.steps,
    preconditions: Array.isArray(candidateChanges.preconditions)
      ? candidateChanges.preconditions
      : (baseProcedure.preconditions || []),
    postconditions: Array.isArray(candidateChanges.postconditions)
      ? candidateChanges.postconditions
      : (baseProcedure.postconditions || []),
    parameters: candidateChanges.parameters || baseProcedure.parameters || {},
    metadata: {
      author: candidateChanges.metadata?.author || 'ollama_generator',
      createdAt: now,
      updatedAt: now,
      executionCount: 0,
      successCount: 0,
      failureCount: 0,
      penalizableFailureCount: 0,
      confidenceScore: 0.5,
      effectiveConfidenceScore: 0.5,
      rootId,
      parentId: baseProcedure.id,
      parentVersion: baseProcedure.version || 1,
      lineage: parentLineage,
      tags: mergedTags,
      evaluationHistory: [],
      knownLimitations: []
    }
  };
}

/**
 * Comparer les performances de deux versions d'une même procédure
 * @param {object} versionA Première version (ex: v1 validée)
 * @param {object} versionB Seconde version (ex: v2 expérimentale)
 * @returns {{
 *   preferred: object,
 *   fallback: object,
 *   comparison: {
 *     idA: string,
 *     idB: string,
 *     versionA: number,
 *     versionB: number,
 *     statusA: string,
 *     statusB: string,
 *     confidenceDelta: number,
 *     avgDurationDeltaMs: number,
 *     candidateOutperforms: boolean
 *   }
 * }} Résultat comparatif et recommandation
 */
function compareProcedureVersions(versionA, versionB) {
  if (!versionA || !versionB) {
    const validOne = versionA || versionB || null;
    return {
      preferred: validOne,
      fallback: null,
      comparison: null
    };
  }

  const confA = versionA.metadata?.effectiveConfidenceScore ?? versionA.metadata?.confidenceScore ?? 0.5;
  const confB = versionB.metadata?.effectiveConfidenceScore ?? versionB.metadata?.confidenceScore ?? 0.5;

  const avgDuration = (proc) => {
    const hist = Array.isArray(proc.metadata?.evaluationHistory)
      ? proc.metadata.evaluationHistory.filter(e => e.success && e.traceSummary?.durationMs > 0)
      : [];
    if (hist.length === 0) return Infinity;
    const total = hist.reduce((s, e) => s + e.traceSummary.durationMs, 0);
    return total / hist.length;
  };

  const durA = avgDuration(versionA);
  const durB = avgDuration(versionB);

  const execB = versionB.metadata?.executionCount || 0;
  const candidateOutperforms = Boolean(
    versionB.status !== 'deprecated' &&
    execB >= 3 &&
    (confB > confA || (confB === confA && versionB.status === 'validated' && durB <= durA))
  );

  const preferred = candidateOutperforms
    ? versionB
    : (versionA.status !== 'deprecated' ? versionA : versionB);
  const fallback = preferred === versionB ? versionA : versionB;

  return {
    preferred,
    fallback,
    comparison: {
      idA: versionA.id,
      idB: versionB.id,
      versionA: versionA.version || 1,
      versionB: versionB.version || 1,
      statusA: versionA.status,
      statusB: versionB.status,
      confidenceDelta: Number((confB - confA).toFixed(3)),
      avgDurationDeltaMs: Number.isFinite(durA) && Number.isFinite(durB) ? Math.round(durB - durA) : 0,
      candidateOutperforms
    }
  };
}

/**
 * Synthétiser toutes les connaissances procédurales disponibles pour un objectif ou l'ensemble de la mémoire
 * @param {Array<object>} procedures Liste des procédures connues en mémoire
 * @param {string|null} [objective=null] Objectif optionnel à filtrer
 * @returns {{
 *   objective: string|null,
 *   validatedProcedures: Array<object>,
 *   experimentalVariants: Array<object>,
 *   deprecatedProcedures: Array<object>,
 *   recommendedProcedure: object|null,
 *   fallbackProcedure: object|null,
 *   overallSuccessRate: number,
 *   effectiveSuccessRate: number,
 *   usualPreconditions: Array<object>,
 *   knownLimitations: Array<string>,
 *   pastFailures: Array<object>,
 *   reusableSteps: Array<object>
 * }} Base de connaissances consolidée pour le Manager et le Generator
 */
function buildProceduralKnowledgeSummary(procedures = [], objective = null) {
  const list = Array.isArray(procedures) ? procedures : [];
  const cleanObj = typeof objective === 'string' && objective.trim().length > 0
    ? objective.toLowerCase().trim()
    : null;

  const matching = cleanObj
    ? list.filter(proc => {
        if (!proc) return false;
        const id = String(proc.id || '').toLowerCase();
        const rootId = String(proc.metadata?.rootId || '').toLowerCase();
        const name = String(proc.name || '').toLowerCase();
        const tags = Array.isArray(proc.metadata?.tags)
          ? proc.metadata.tags.map(t => String(t).toLowerCase())
          : [];
        return (
          tags.includes(cleanObj) ||
          id === cleanObj ||
          rootId === cleanObj ||
          id.includes(cleanObj) ||
          name.includes(cleanObj)
        );
      })
    : list.filter(Boolean);

  const sortByQuality = (arr) => [...arr].sort((a, b) => {
    const confA = a.metadata?.effectiveConfidenceScore ?? a.metadata?.confidenceScore ?? 0.5;
    const confB = b.metadata?.effectiveConfidenceScore ?? b.metadata?.confidenceScore ?? 0.5;
    if (confA !== confB) return confB - confA;
    return (b.metadata?.executionCount || 0) - (a.metadata?.executionCount || 0);
  });

  const validatedProcedures = sortByQuality(matching.filter(p => p.status === 'validated'));
  const experimentalVariants = sortByQuality(matching.filter(p => p.status === 'experimental'));
  const deprecatedProcedures = matching.filter(p => p.status === 'deprecated');

  let recommendedProcedure = validatedProcedures[0] || experimentalVariants[0] || null;
  let fallbackProcedure = validatedProcedures[1] || (validatedProcedures[0] ? experimentalVariants[0] : experimentalVariants[1]) || null;

  if (validatedProcedures.length > 0 && experimentalVariants.length > 0) {
    const cmp = compareProcedureVersions(validatedProcedures[0], experimentalVariants[0]);
    recommendedProcedure = cmp.preferred;
    fallbackProcedure = cmp.fallback;
  }

  let totalExecutions = 0;
  let totalSuccesses = 0;
  let totalPenalizableFailures = 0;
  const preconditionMap = new Map();
  const limitationsSet = new Set();
  const pastFailures = [];

  for (const proc of matching) {
    const meta = proc.metadata || {};
    totalExecutions += meta.executionCount || 0;
    totalSuccesses += meta.successCount || 0;
    totalPenalizableFailures += meta.penalizableFailureCount !== undefined
      ? meta.penalizableFailureCount
      : (meta.failureCount || 0);

    if (Array.isArray(proc.preconditions)) {
      for (const pre of proc.preconditions) {
        const key = JSON.stringify(pre);
        if (!preconditionMap.has(key)) {
          preconditionMap.set(key, pre);
        }
      }
    }

    if (Array.isArray(meta.knownLimitations)) {
      for (const lim of meta.knownLimitations) {
        limitationsSet.add(lim);
      }
    }

    const history = Array.isArray(meta.evaluationHistory) ? meta.evaluationHistory : [];
    for (const entry of history) {
      if (entry && !entry.success) {
        pastFailures.push({
          executionId: entry.executionId,
          procedureId: proc.id,
          procedureVersion: proc.version || 1,
          timestamp: entry.timestamp,
          failureCategory: entry.failureCategory,
          failedStepId: entry.traceSummary?.failedStepId || null,
          failedStepAction: entry.traceSummary?.failedStepAction || null,
          reason: entry.traceSummary?.failureReason || null,
          resourceShortage: Boolean(entry.evaluationSummary?.resourceShortage)
        });
      }
    }
  }

  const overallSuccessRate = totalExecutions > 0
    ? Number((totalSuccesses / totalExecutions).toFixed(3))
    : 0;

  const effectiveTotal = totalSuccesses + totalPenalizableFailures;
  const effectiveSuccessRate = effectiveTotal > 0
    ? Number((totalSuccesses / effectiveTotal).toFixed(3))
    : overallSuccessRate;

  const reusableSteps = validatedProcedures.map(proc => ({
    procedureId: proc.id,
    version: proc.version || 1,
    name: proc.name,
    confidenceScore: proc.metadata?.confidenceScore ?? 1,
    stepsCount: Array.isArray(proc.steps) ? proc.steps.length : 0,
    preconditions: proc.preconditions || [],
    postconditions: proc.postconditions || []
  }));

  return {
    objective: cleanObj,
    validatedProcedures,
    experimentalVariants,
    deprecatedProcedures,
    recommendedProcedure,
    fallbackProcedure,
    overallSuccessRate,
    effectiveSuccessRate,
    usualPreconditions: Array.from(preconditionMap.values()),
    knownLimitations: Array.from(limitationsSet),
    pastFailures,
    reusableSteps
  };
}

module.exports = {
  FAILURE_CATEGORIES,
  DEFAULT_PROMOTION_POLICY,
  DEFAULT_DEPRECATION_POLICY,
  generateExecutionId,
  computeScenarioSignature,
  classifyFailureCause,
  buildEvaluationRecord,
  evaluatePromotionEligibility,
  analyzeDeprecationRisk,
  applyEvaluationToLifecycle,
  extractKnownLimitations,
  createVersionedProcedure,
  compareProcedureVersions,
  buildProceduralKnowledgeSummary
};
