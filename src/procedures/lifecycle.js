const crypto = require('node:crypto');

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
  const randomPart = crypto.randomUUID().slice(0, 8);
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
  const hash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 12);
  return `scen_${hash}`;
}

/**
 * Vérifier si une évaluation correspond à un cas inconclusif faute d'observabilité
 * @param {object} evaluation Données d'évaluation issues de l'Evaluator
 * @returns {boolean} Vrai si le résultat est inconclusif
 */
function isEvaluationInconclusive(evaluation) {
  if (evaluation.status === 'inconclusive') return true;
  if (!Array.isArray(evaluation.unknownConditions) || evaluation.unknownConditions.length === 0) {
    return false;
  }
  if (!Array.isArray(evaluation.failedConditions)) return true;
  return evaluation.failedConditions.every(f => f.status === 'unknown');
}

/**
 * Classifier précisément la cause d'un échec à partir de la trace et de l'évaluation
 * @param {object} [evaluation={}] Données d'évaluation issues de l'Evaluator
 * @param {object} [executionTrace={}] Trace d'exécution issue du Runner
 * @returns {string|null} Catégorie d'échec ou null en cas de réussite complète
 */
function classifyFailureCause(evaluation = {}, executionTrace = {}) {
  if (!evaluation || typeof evaluation !== 'object') {
    return FAILURE_CATEGORIES.INCONCLUSIVE;
  }

  const hasContradictions = Array.isArray(evaluation.contradictions) && evaluation.contradictions.length > 0;
  if (
    evaluation.status === 'achieved' &&
    evaluation.objectiveAchieved === true &&
    evaluation.postconditionsPassed === true &&
    !hasContradictions
  ) {
    return null;
  }

  if (hasContradictions) {
    return FAILURE_CATEGORIES.CONTRADICTION;
  }

  if (evaluation.resourceShortage === true) {
    return FAILURE_CATEGORIES.RESOURCE_SHORTAGE;
  }

  if (isEvaluationInconclusive(evaluation)) {
    return FAILURE_CATEGORIES.INCONCLUSIVE;
  }

  if (evaluation.executionSuccess === false || executionTrace?.success === false) {
    return FAILURE_CATEGORIES.EXECUTION_ERROR;
  }

  return FAILURE_CATEGORIES.OBJECTIVE_NOT_ACHIEVED;
}

/**
 * Extraire la liste normalisée des étapes exécutées depuis une trace brute
 * @param {object} normalizedTrace Trace d'exécution normalisée
 * @returns {Array<object>} Tableau des traces d'étapes
 */
function extractStepTraces(normalizedTrace) {
  if (Array.isArray(normalizedTrace.steps)) return normalizedTrace.steps;
  if (Array.isArray(normalizedTrace.stepTraces)) return normalizedTrace.stepTraces;
  return [];
}

/**
 * Construire le résumé de la trace d'exécution pour l'enregistrement du cycle de vie
 * @param {object} normalizedTrace Trace normalisée du Runner
 * @param {object} normalizedEval Évaluation normalisée de l'Evaluator
 * @param {Array<object>} steps Étapes extraites
 * @returns {object} Résumé structuré de la trace
 */
function buildTraceSummaryObject(normalizedTrace, normalizedEval, steps) {
  const failedStep = steps.find(s => s && !s.success) || null;
  const defaultStatus = normalizedTrace.success ? 'completed' : 'failed';
  const executionSuccess = normalizedEval.executionSuccess === undefined
    ? Boolean(normalizedTrace.success)
    : Boolean(normalizedEval.executionSuccess);

  let failedStepId = normalizedTrace.failedStepId || null;
  let failedStepAction = null;
  let failureReason = normalizedTrace.reason || null;

  if (failedStep) {
    failedStepId = failedStep.stepId || failedStep.id || null;
    failedStepAction = failedStep.action || null;
    failureReason = failedStep.reason || failedStep.error || null;
  }

  return {
    runnerStatus: normalizedTrace.status || defaultStatus,
    executionSuccess,
    stepsExecuted: steps.length,
    durationMs: normalizedTrace.executionDurationMs || normalizedTrace.durationMs || 0,
    failedStepId,
    failedStepAction,
    failureReason
  };
}

/**
 * Construire le résumé des faits vérifiés et conditions d'évaluation
 * @param {object} normalizedEval Évaluation normalisée de l'Evaluator
 * @param {boolean} isSuccess Indicateur de réussite globale
 * @returns {object} Résumé structuré de l'évaluation
 */
function buildEvaluationSummaryObject(normalizedEval, isSuccess) {
  const verifiedFacts = Array.isArray(normalizedEval.verifiedFacts) ? [...normalizedEval.verifiedFacts] : [];
  const failedConditions = Array.isArray(normalizedEval.failedConditions) ? [...normalizedEval.failedConditions] : [];
  const unknownConditions = Array.isArray(normalizedEval.unknownConditions) ? [...normalizedEval.unknownConditions] : [];
  const contradictions = Array.isArray(normalizedEval.contradictions) ? [...normalizedEval.contradictions] : [];
  const fallbackConfidence = isSuccess ? 1 : 0;
  const confidence = typeof normalizedEval.confidence === 'number' ? normalizedEval.confidence : fallbackConfidence;

  return {
    objectiveAchieved: Boolean(normalizedEval.objectiveAchieved),
    postconditionsPassed: Boolean(normalizedEval.postconditionsPassed),
    observabilitySufficient: unknownConditions.length === 0,
    resourceShortage: Boolean(normalizedEval.resourceShortage),
    deprecateRecommended: Boolean(normalizedEval.deprecateRecommended),
    confidence,
    verifiedFactsCount: verifiedFacts.length,
    failedConditionsCount: failedConditions.length,
    unknownConditionsCount: unknownConditions.length,
    contradictionsCount: contradictions.length,
    verifiedFacts,
    failedConditions,
    unknownConditions,
    contradictions
  };
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

  const steps = extractStepTraces(normalizedTrace);
  const failureCategory = classifyFailureCause(normalizedEval, normalizedTrace);
  const scenarioKey = computeScenarioSignature(normalizedTrace, normalizedEval, context);

  const isSuccess = failureCategory === null &&
    normalizedEval.status === 'achieved' &&
    normalizedEval.objectiveAchieved === true &&
    normalizedEval.postconditionsPassed === true;

  const defaultEvalStatus = isSuccess ? 'achieved' : 'not_achieved';

  return {
    executionId,
    procedureId,
    procedureVersion: procedure?.version || 1,
    timestamp: context.timestamp || normalizedTrace.completedAt || new Date().toISOString(),
    scenarioKey,
    artificialRepetition: Boolean(context.artificialRepetition),
    success: isSuccess,
    status: normalizedEval.status || defaultEvalStatus,
    failureCategory,
    penalizableFailure: Boolean(
      !isSuccess &&
      failureCategory !== FAILURE_CATEGORIES.RESOURCE_SHORTAGE &&
      failureCategory !== FAILURE_CATEGORIES.INCONCLUSIVE
    ),
    traceSummary: buildTraceSummaryObject(normalizedTrace, normalizedEval, steps),
    evaluationSummary: buildEvaluationSummaryObject(normalizedEval, isSuccess)
  };
}

/**
 * Évaluer l'éligibilité d'une procédure expérimentale à la promotion vers le statut validé
 * @param {Array<object>} [evaluationHistory=[]] Historique des évaluations de la procédure
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

  const nonArtificial = history.filter(entry => !entry.artificialRepetition);

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

  const distinctScenarios = new Set(
    qualifiedSuccesses.map(entry => entry.scenarioKey || entry.executionId)
  );

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
 * Compter le nombre d'échecs pénalisables consécutifs en fin d'historique
 * @param {Array<object>} history Historique des évaluations
 * @returns {number} Nombre d'échecs pénalisables consécutifs
 */
function countTrailingPenalizableFailures(history) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const isIgnored = entry.failureCategory === FAILURE_CATEGORIES.RESOURCE_SHORTAGE ||
      entry.failureCategory === FAILURE_CATEGORIES.INCONCLUSIVE;
    if (isIgnored) continue;
    if (entry.penalizableFailure === true) {
      count++;
    } else if (entry.success === true) {
      break;
    }
  }
  return count;
}

/**
 * Analyser l'historique d'échecs pour déterminer prudemment si une procédure doit être candidate à la dépréciation
 * @param {Array<object>} [evaluationHistory=[]] Historique des évaluations
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

  const consecutivePenalizableFailures = countTrailingPenalizableFailures(history);

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
  const meetsCriticalFailureThreshold = consecutivePenalizableFailures >= cfg.minConsecutivePenalizableFailures ||
    contradictionEntries.length >= cfg.minContradictionsForDeprecation ||
    (relevantExecutions.length >= 5 && effectiveConfidence < 0.5);

  const shouldDeprecate = Boolean(
    deprecationCandidate &&
    policy.autoDeprecate !== false &&
    meetsCriticalFailureThreshold
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
 * Déterminer le prochain statut de cycle de vie d'une procédure après analyse
 * @param {string} currentStatus Statut actuel de la procédure
 * @param {object} promotionAnalysis Résultat d'éligibilité à la promotion
 * @param {object} deprecationAnalysis Résultat d'analyse de dépréciation
 * @param {object} options Options de protection et de dépréciation
 * @returns {{ nextStatus: string, promoted: boolean, deprecated: boolean }} Transition de statut calculée
 */
function resolveNextLifecycleStatus(currentStatus, promotionAnalysis, deprecationAnalysis, options) {
  if (currentStatus === 'experimental' && promotionAnalysis.eligible) {
    return { nextStatus: 'validated', promoted: true, deprecated: false };
  }

  const canDeprecateStatus = currentStatus === 'validated' || currentStatus === 'experimental';
  if (canDeprecateStatus && deprecationAnalysis.shouldDeprecate && options.allowDeprecation !== false) {
    if (currentStatus === 'validated' && options.protectValidatedFromAutoDeprecation === true) {
      return { nextStatus: 'validated', promoted: false, deprecated: false };
    }
    return { nextStatus: 'deprecated', promoted: false, deprecated: true };
  }

  return { nextStatus: currentStatus, promoted: false, deprecated: false };
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
    throw new TypeError('Procedure must be a valid object');
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

  if (existingHistory.some(item => item.executionId === record.executionId)) {
    return {
      updatedProcedure: procedure,
      record,
      duplicateSkipped: true,
      promoted: false,
      deprecated: false,
      promotionAnalysis: evaluatePromotionEligibility(existingHistory, options.promotionPolicy),
      deprecationAnalysis: analyzeDeprecationRisk(existingHistory, options.deprecationPolicy)
    };
  }

  const isDuplicateScenarioBurst = Boolean(
    options.detectArtificialRepetitions === true &&
    existingHistory.length > 0 &&
    existingHistory.at(-1).scenarioKey === record.scenarioKey
  );

  const finalRecord = isDuplicateScenarioBurst ? { ...record, artificialRepetition: true } : record;
  const maxHistory = options.maxHistoryEntries || DEFAULT_PROMOTION_POLICY.maxHistoryEntries;
  const updatedHistory = [...existingHistory, finalRecord].slice(-maxHistory);

  const nextBreakdown = {
    resource_shortage: 0,
    execution_error: 0,
    objective_not_achieved: 0,
    contradiction: 0,
    inconclusive: 0,
    ...metadata.failureBreakdown
  };
  if (finalRecord.failureCategory && Object.hasOwn(nextBreakdown, finalRecord.failureCategory)) {
    nextBreakdown[finalRecord.failureCategory] += 1;
  }

  const executionCount = (metadata.executionCount || 0) + 1;
  const successCount = (metadata.successCount || 0) + (finalRecord.success ? 1 : 0);
  const failureCount = (metadata.failureCount || 0) + (finalRecord.success ? 0 : 1);
  const penalizableFailureCount = (metadata.penalizableFailureCount || 0) + (finalRecord.penalizableFailure ? 1 : 0);

  const qualifiedTotal = successCount + penalizableFailureCount;
  const fallbackConf = metadata.confidenceScore === undefined ? 0.5 : metadata.confidenceScore;
  const rawConfidence = qualifiedTotal > 0 ? Number((successCount / qualifiedTotal).toFixed(3)) : fallbackConf;
  const confidenceScore = Math.max(0, Math.min(1, rawConfidence));

  const promotionAnalysis = evaluatePromotionEligibility(updatedHistory, {
    requireIndependentScenarios: options.requireIndependentScenarios ?? false,
    ...options.promotionPolicy
  });

  const deprecationAnalysis = analyzeDeprecationRisk(updatedHistory, {
    autoDeprecate: options.autoDeprecate ?? true,
    ...options.deprecationPolicy
  });

  const currentStatus = procedure.status || 'experimental';
  const { nextStatus, promoted, deprecated } = resolveNextLifecycleStatus(
    currentStatus,
    promotionAnalysis,
    deprecationAnalysis,
    options
  );

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
      knownLimitations: extractKnownLimitations(updatedHistory, procedure),
      lastEvaluationAt: finalRecord.timestamp,
      lastExecutionId: finalRecord.executionId,
      evaluationHistory: updatedHistory,
      updatedAt: new Date().toISOString()
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
 * @param {Array<object>} [evaluationHistory=[]] Historique des évaluations
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
      const reason = entry.traceSummary?.failureReason || 'failed';
      limitations.add(`Step '${stepId}' (${action}) prone to execution error (${reason})`);
    } else if (entry.failureCategory === FAILURE_CATEGORIES.CONTRADICTION) {
      limitations.add('World state contradiction observed after step completion');
    } else if (entry.failureCategory === FAILURE_CATEGORIES.OBJECTIVE_NOT_ACHIEVED) {
      limitations.add('Steps may complete without achieving the target objective');
    }
  }

  return Array.from(limitations);
}

/**
 * Attribuer un identifiant de version libre à partir d'un candidat et d'un ensemble d'identifiants occupés
 * @param {string} baseVersionedId Identifiant versionné candidat
 * @param {Set<string>} taken Ensemble des identifiants déjà attribués
 * @param {Function|null} uniqueIdGenerator Fonction optionnelle de génération d'identifiant
 * @returns {string} Identifiant libre
 */
function resolveAvailableVersionId(baseVersionedId, taken, uniqueIdGenerator) {
  if (!taken.has(baseVersionedId)) return baseVersionedId;
  if (typeof uniqueIdGenerator === 'function') {
    return uniqueIdGenerator(baseVersionedId, taken);
  }
  let suffix = 1;
  while (taken.has(`${baseVersionedId}_${suffix}`)) {
    suffix++;
  }
  return `${baseVersionedId}_${suffix}`;
}

/**
 * Créer une nouvelle version expérimentale liée à une procédure d'origine sans jamais l'écraser
 * @param {object} baseProcedure Procédure parente (souvent validée)
 * @param {object} [candidateChanges={}] Nouvelles étapes, préconditions ou paramètres proposés
 * @param {Function|null} [uniqueIdGenerator=null] Fonction de génération d'identifiant unique
 * @param {Set<string>|Array<string>} [existingIds=[]] Ensemble des identifiants existants
 * @returns {object} Nouvelle procédure versionnée avec statut expérimental et lignée
 */
function createVersionedProcedure(baseProcedure, candidateChanges = {}, uniqueIdGenerator = null, existingIds = []) {
  if (!baseProcedure || typeof baseProcedure !== 'object' || !baseProcedure.id) {
    throw new TypeError('Valid baseProcedure with an id is required to create a new version');
  }

  const rootId = baseProcedure.metadata?.rootId || baseProcedure.id.replace(/_v\d+$/, '').replace(/_exp_\d+$/, '');
  const parentVersion = Number.isInteger(baseProcedure.version) ? baseProcedure.version : 1;
  const requestedVersion = Number.isInteger(candidateChanges.version) ? candidateChanges.version : 2;
  const nextVersion = Math.max(parentVersion + 1, requestedVersion);

  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds);
  taken.add(baseProcedure.id);

  const versionedId = resolveAvailableVersionId(`${rootId}_v${nextVersion}`, taken, uniqueIdGenerator);
  const now = new Date().toISOString();
  const parentLineage = Array.isArray(baseProcedure.metadata?.lineage) ? [...baseProcedure.metadata.lineage] : [];
  if (!parentLineage.includes(baseProcedure.id)) {
    parentLineage.push(baseProcedure.id);
  }

  const baseTags = Array.isArray(baseProcedure.metadata?.tags) ? baseProcedure.metadata.tags : [];
  const nextTags = Array.isArray(candidateChanges.metadata?.tags) ? candidateChanges.metadata.tags : [];
  const mergedTags = Array.from(new Set([...baseTags, ...nextTags, rootId]));

  const hasCustomSteps = Array.isArray(candidateChanges.steps) && candidateChanges.steps.length > 0;

  return {
    ...baseProcedure,
    ...candidateChanges,
    id: versionedId,
    version: nextVersion,
    name: candidateChanges.name || `${baseProcedure.name} (v${nextVersion})`,
    status: 'experimental',
    steps: hasCustomSteps ? candidateChanges.steps : baseProcedure.steps,
    preconditions: Array.isArray(candidateChanges.preconditions) ? candidateChanges.preconditions : (baseProcedure.preconditions || []),
    postconditions: Array.isArray(candidateChanges.postconditions) ? candidateChanges.postconditions : (baseProcedure.postconditions || []),
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
      parentVersion,
      lineage: parentLineage,
      tags: mergedTags,
      evaluationHistory: [],
      knownLimitations: []
    }
  };
}

/**
 * Calculer la durée moyenne des exécutions réussies d'une procédure
 * @param {object} proc Objet procédure
 * @returns {number} Durée moyenne en millisecondes ou Infinity si aucune mesure
 */
function computeAverageSuccessDuration(proc) {
  const hist = Array.isArray(proc.metadata?.evaluationHistory)
    ? proc.metadata.evaluationHistory.filter(e => e.success && e.traceSummary?.durationMs > 0)
    : [];
  if (hist.length === 0) return Infinity;
  const total = hist.reduce((s, e) => s + e.traceSummary.durationMs, 0);
  return total / hist.length;
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
  const durA = computeAverageSuccessDuration(versionA);
  const durB = computeAverageSuccessDuration(versionB);

  const execB = versionB.metadata?.executionCount || 0;
  const candidateOutperforms = Boolean(
    versionB.status !== 'deprecated' &&
    execB >= 3 &&
    (confB > confA || (confB === confA && versionB.status === 'validated' && durB <= durA))
  );

  let preferred = versionA.status === 'deprecated' ? versionB : versionA;
  if (candidateOutperforms) {
    preferred = versionB;
  }
  const fallback = preferred === versionB ? versionA : versionB;
  const avgDurationDeltaMs = Number.isFinite(durA) && Number.isFinite(durB) ? Math.round(durB - durA) : 0;

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
      avgDurationDeltaMs,
      candidateOutperforms
    }
  };
}

/**
 * Vérifier si une procédure correspond à l'objectif recherché pour la synthèse de connaissances
 * @param {object} proc Procédure à tester
 * @param {string} cleanObj Objectif nettoyé en minuscules
 * @returns {boolean} Vrai si la procédure correspond
 */
function matchesKnowledgeObjective(proc, cleanObj) {
  if (!proc) return false;
  const id = String(proc.id || '').toLowerCase();
  const rootId = String(proc.metadata?.rootId || '').toLowerCase();
  const name = String(proc.name || '').toLowerCase();
  const tags = Array.isArray(proc.metadata?.tags) ? proc.metadata.tags.map(t => String(t).toLowerCase()) : [];

  return (
    tags.includes(cleanObj) ||
    id === cleanObj ||
    rootId === cleanObj ||
    id.includes(cleanObj) ||
    name.includes(cleanObj)
  );
}

/**
 * Agréger les préconditions, limites et échecs passés d'une collection de procédures
 * @param {Array<object>} matching Procédures retenues
 * @returns {{
 *   totalExecutions: number,
 *   totalSuccesses: number,
 *   totalPenalizableFailures: number,
 *   usualPreconditions: Array<object>,
 *   knownLimitations: Array<string>,
 *   pastFailures: Array<object>
 * }} Données agrégées
 */
function aggregateHistoricalKnowledge(matching) {
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
    const procPenalizable = meta.penalizableFailureCount === undefined ? (meta.failureCount || 0) : meta.penalizableFailureCount;
    totalPenalizableFailures += procPenalizable;

    for (const pre of proc.preconditions || []) {
      const key = JSON.stringify(pre);
      if (!preconditionMap.has(key)) preconditionMap.set(key, pre);
    }

    for (const lim of meta.knownLimitations || []) {
      limitationsSet.add(lim);
    }

    for (const entry of meta.evaluationHistory || []) {
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

  return {
    totalExecutions,
    totalSuccesses,
    totalPenalizableFailures,
    usualPreconditions: Array.from(preconditionMap.values()),
    knownLimitations: Array.from(limitationsSet),
    pastFailures
  };
}

/**
 * Synthétiser toutes les connaissances procédurales disponibles pour un objectif ou l'ensemble de la mémoire
 * @param {Array<object>} [procedures=[]] Liste des procédures connues en mémoire
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
    ? list.filter(proc => matchesKnowledgeObjective(proc, cleanObj))
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

  const secondaryExperimental = validatedProcedures[0] ? experimentalVariants[0] : experimentalVariants[1];
  let recommendedProcedure = validatedProcedures[0] || experimentalVariants[0] || null;
  let fallbackProcedure = validatedProcedures[1] || secondaryExperimental || null;

  if (validatedProcedures.length > 0 && experimentalVariants.length > 0) {
    const cmp = compareProcedureVersions(validatedProcedures[0], experimentalVariants[0]);
    recommendedProcedure = cmp.preferred;
    fallbackProcedure = cmp.fallback;
  }

  const aggregated = aggregateHistoricalKnowledge(matching);
  const overallSuccessRate = aggregated.totalExecutions > 0
    ? Number((aggregated.totalSuccesses / aggregated.totalExecutions).toFixed(3))
    : 0;

  const effectiveTotal = aggregated.totalSuccesses + aggregated.totalPenalizableFailures;
  const effectiveSuccessRate = effectiveTotal > 0
    ? Number((aggregated.totalSuccesses / effectiveTotal).toFixed(3))
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
    usualPreconditions: aggregated.usualPreconditions,
    knownLimitations: aggregated.knownLimitations,
    pastFailures: aggregated.pastFailures,
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
