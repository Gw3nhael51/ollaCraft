const { createResult } = require('../actions/primitives/result');
const { createDefaultRegistry } = require('./registry');
const { validateProcedure } = require('./validator');
const { resolveReference, resolveDynamicValues } = require('./schema');
const { evaluatePreconditions, evaluatePostconditions } = require('./evaluator');
const { generateProcedure } = require('./generator');
const { registerExperimentalProcedure } = require('./memory');

const DEFAULT_SUPERVISED_TIMEOUT_MS = 60000;
const DEFAULT_SUPERVISED_STEP_TIMEOUT_MS = 15000;
const DEFAULT_SUPERVISED_MAX_STEPS = 25;
const DEFAULT_MAX_DROP_COUNT = 64;

const CRITICAL_ERROR_REASONS = Object.freeze(new Set([
  'aborted',
  'timeout',
  'step_timeout',
  'resolution_error',
  'dangerous_operation',
  'resource_limit_exceeded',
  'critical_error'
]));

/**
 * Construire la trace d'exécution normalisée exploitable par l'Evaluator
 * @param {object} params Données d'exécution collectées par le Runner
 * @param {string} params.procedureId Identifiant de la procédure
 * @param {string} params.status Statut final du Runner ('completed', 'failed', 'aborted', 'timeout', 'preconditions_failed')
 * @param {Array<object>} params.steps Traces détaillées de chaque étape
 * @param {number} params.startTime Timestamp de départ en millisecondes
 * @param {number} [params.endTime=Date.now()] Timestamp de fin en millisecondes
 * @param {boolean} params.success Indicateur de complétion technique du Runner
 * @returns {{
 *   procedureId: string,
 *   status: string,
 *   steps: Array<object>,
 *   startedAt: string,
 *   completedAt: string,
 *   executionDurationMs: number,
 *   success: boolean,
 *   objectiveAchieved: null
 * }} Trace d'exécution complète
 */
function buildExecutionTrace({
  procedureId,
  status,
  steps = [],
  startTime,
  endTime = Date.now(),
  success
}) {
  const durationMs = Math.max(0, endTime - startTime);
  return {
    procedureId: procedureId || 'unknown',
    status,
    steps: [...steps],
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date(endTime).toISOString(),
    executionDurationMs: durationMs,
    success: Boolean(success),
    objectiveAchieved: null
  };
}

/**
 * Vérifier si une étape viole les gardes-fous d'opérations dangereuses en exécution supervisée
 * @param {object} step Définition de l'étape
 * @param {object} resolvedParams Paramètres résolus de l'étape
 * @param {object} options Options de supervision
 * @returns {{ safe: boolean, reason: string|null }} Verdict de sécurité
 */
function checkStepSafety(step, resolvedParams, options = {}) {
  const dangerousActions = options.dangerousActions instanceof Set
    ? options.dangerousActions
    : new Set(Array.isArray(options.dangerousActions) ? options.dangerousActions : []);

  if (dangerousActions.has(step.action)) {
    return {
      safe: false,
      reason: `Step '${step.id}' uses restricted dangerous action '${step.action}'`
    };
  }

  if (step.action === 'drop_item') {
    const maxDrop = options.maxDropCount !== undefined ? options.maxDropCount : DEFAULT_MAX_DROP_COUNT;
    const count = resolvedParams?.count !== undefined ? Number(resolvedParams.count) : 1;
    if (count > maxDrop) {
      return {
        safe: false,
        reason: `Step '${step.id}' attempts to drop ${count} items, exceeding safety limit of ${maxDrop}`
      };
    }
  }

  return { safe: true, reason: null };
}

/**
 * Exécuter une tentative unique d'étape avec son propre timeout et signal d'annulation
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} actionDef Définition de l'action issue du registre
 * @param {object} resolvedStepParams Paramètres résolus
 * @param {number} stepTimeoutMs Timeout individuel en millisecondes
 * @param {AbortSignal} parentSignal Signal d'annulation parent
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat de l'étape
 */
async function invokeStepWithTimeout(bot, actionDef, resolvedStepParams, stepTimeoutMs, parentSignal) {
  const stepController = new AbortController();
  let stepTimer = null;
  let stepTimedOut = false;

  const onParentAbort = () => {
    stepController.abort(parentSignal.reason || new Error('Aborted by parent signal'));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      return createResult(false, 'aborted', null, 'Step aborted before execution');
    }
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    const handlerPromise = Promise.resolve().then(() =>
      actionDef.handler(bot, resolvedStepParams, {
        timeoutMs: stepTimeoutMs,
        abortSignal: stepController.signal
      })
    );

    if (stepTimeoutMs > 0) {
      const timeoutPromise = new Promise((resolve) => {
        stepTimer = setTimeout(() => {
          stepTimedOut = true;
          stepController.abort(new Error(`Step timeout of ${stepTimeoutMs}ms reached`));
          resolve(createResult(
            false,
            'step_timeout',
            null,
            `Step execution exceeded timeout of ${stepTimeoutMs}ms`
          ));
        }, stepTimeoutMs);
      });

      const res = await Promise.race([handlerPromise, timeoutPromise]);
      if (stepTimedOut) {
        return createResult(
          false,
          'step_timeout',
          res?.data || null,
          `Step execution exceeded timeout of ${stepTimeoutMs}ms`
        );
      }
      return res;
    }

    return await handlerPromise;
  } catch (err) {
    if (stepTimedOut) {
      return createResult(
        false,
        'step_timeout',
        null,
        `Step execution exceeded timeout of ${stepTimeoutMs}ms`
      );
    }
    if (parentSignal?.aborted) {
      return createResult(false, 'aborted', null, 'Step execution aborted');
    }
    return createResult(false, err?.critical ? 'critical_error' : 'error', null, String(err?.message || err));
  } finally {
    if (stepTimer) clearTimeout(stepTimer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Exécuter une procédure validée étape par étape avec supervision, gardes-fous et traçabilité complète
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} procedure Objet de définition de la procédure
 * @param {object} [options={}] Options d'exécution et de supervision
 * @param {object} [options.inputs={}] Valeurs d'entrée des paramètres
 * @param {object} [options.actionRegistry=null] Registre d'actions autorisées
 * @param {number} [options.timeoutMs=0] Timeout global de la procédure en millisecondes
 * @param {number} [options.maxStepTimeoutMs=0] Plafond de timeout par étape en millisecondes
 * @param {number} [options.maxSteps=50] Nombre maximal d'étapes autorisées à s'exécuter
 * @param {string[]} [options.dangerousActions=[]] Liste d'actions interdites par sécurité
 * @param {number} [options.maxDropCount=64] Quantité maximale d'items jetables en une étape
 * @param {AbortSignal} [options.abortSignal=null] Signal d'annulation externe
 * @param {boolean} [options.skipPreconditions=false] Ignorer la vérification des préconditions
 * @param {boolean} [options.skipPostconditions=false] Ignorer la vérification des postconditions
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat et trace d'exécution
 */
async function executeProcedure(bot, procedure, options = {}) {
  const registry = options.actionRegistry || createDefaultRegistry();
  const inputs = options.inputs || {};
  const globalTimeoutMs = options.timeoutMs || 0;
  const maxStepTimeoutMs = options.maxStepTimeoutMs || 0;
  const maxSteps = options.maxSteps !== undefined ? options.maxSteps : 50;
  const externalAbortSignal = options.abortSignal;
  const startTime = Date.now();

  const validation = validateProcedure(procedure, registry, options.validationOptions || {});
  if (!validation.valid) {
    const trace = buildExecutionTrace({
      procedureId: procedure?.id || 'invalid',
      status: 'invalid_procedure',
      steps: [],
      startTime,
      success: false
    });
    return createResult(false, 'invalid_procedure', {
      errors: validation.errors,
      trace,
      ...trace
    }, 'Procedure failed semantic validation');
  }

  const resolvedParameters = {};
  for (const [paramName, paramDef] of Object.entries(procedure.parameters || {})) {
    if (inputs[paramName] !== undefined) {
      resolvedParameters[paramName] = inputs[paramName];
    } else if (paramDef && paramDef.default !== undefined) {
      resolvedParameters[paramName] = paramDef.default;
    }
  }

  const context = {
    procedureId: procedure.id,
    parameters: resolvedParameters,
    stepResults: {},
    stepTraces: [],
    startTime
  };

  const attachTrace = (status, success, payload = {}) => {
    const endTime = Date.now();
    const trace = buildExecutionTrace({
      procedureId: procedure.id,
      status,
      steps: context.stepTraces,
      startTime,
      endTime,
      success
    });
    return {
      ...payload,
      procedureId: procedure.id,
      durationMs: trace.executionDurationMs,
      executionDurationMs: trace.executionDurationMs,
      startedAt: trace.startedAt,
      completedAt: trace.completedAt,
      status: trace.status,
      steps: trace.steps,
      stepTraces: context.stepTraces,
      stepResults: context.stepResults,
      objectiveAchieved: null,
      trace
    };
  };

  if (externalAbortSignal?.aborted) {
    return createResult(
      false,
      'aborted',
      attachTrace('aborted', false, { stepsExecuted: 0 }),
      'Procedure execution was aborted before start'
    );
  }

  const masterController = new AbortController();
  let globalTimer = null;
  let globalTimedOut = false;

  const onExternalAbort = () => {
    masterController.abort(externalAbortSignal.reason || new Error('Aborted by caller'));
  };

  if (externalAbortSignal) {
    externalAbortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const executePipeline = async () => {
    if (!options.skipPreconditions && procedure.preconditions && procedure.preconditions.length > 0) {
      const preResult = await evaluatePreconditions(bot, procedure.preconditions, context);
      if (!preResult.success) {
        return createResult(
          false,
          'preconditions_failed',
          attachTrace('preconditions_failed', false, {
            stepsExecuted: 0,
            preconditionsResult: preResult.data
          }),
          preResult.error
        );
      }
    }

    let stepsExecuted = 0;

    for (const step of procedure.steps) {
      if (externalAbortSignal?.aborted) {
        return createResult(
          false,
          'aborted',
          attachTrace('aborted', false, { stepsExecuted }),
          'Procedure execution aborted by caller'
        );
      }

      if (globalTimedOut) {
        return createResult(
          false,
          'timeout',
          attachTrace('timeout', false, { stepsExecuted }),
          'Procedure global execution timed out'
        );
      }

      if (stepsExecuted >= maxSteps) {
        return createResult(
          false,
          'resource_limit_exceeded',
          attachTrace('failed', false, {
            failedStepId: step.id,
            stepsExecuted
          }),
          `Procedure exceeded maximum allowed executed steps (${maxSteps})`
        );
      }

      let resolvedStepParams;
      try {
        resolvedStepParams = resolveDynamicValues(step.parameters || {}, context);
      } catch (err) {
        return createResult(
          false,
          'resolution_error',
          attachTrace('failed', false, {
            failedStepId: step.id,
            stepsExecuted
          }),
          err.message
        );
      }

      const safetyCheck = checkStepSafety(step, resolvedStepParams, options);
      if (!safetyCheck.safe) {
        return createResult(
          false,
          'dangerous_operation',
          attachTrace('failed', false, {
            failedStepId: step.id,
            stepsExecuted
          }),
          safetyCheck.reason
        );
      }

      const actionDef = registry.get(step.action);
      let stepTimeoutMs = step.timeoutMs !== undefined ? step.timeoutMs : (actionDef.defaultTimeoutMs || 0);
      if (maxStepTimeoutMs > 0 && (stepTimeoutMs === 0 || stepTimeoutMs > maxStepTimeoutMs)) {
        stepTimeoutMs = maxStepTimeoutMs;
      }

      const retries = step.retries || 0;
      let stepResult = null;
      let attempt = 0;
      const stepStartTime = Date.now();

      while (attempt <= retries) {
        attempt++;
        stepResult = await invokeStepWithTimeout(
          bot,
          actionDef,
          resolvedStepParams,
          stepTimeoutMs,
          masterController.signal
        );

        if (
          stepResult.success ||
          externalAbortSignal?.aborted ||
          globalTimedOut ||
          CRITICAL_ERROR_REASONS.has(stepResult.reason) ||
          stepResult.critical === true
        ) {
          break;
        }
      }

      const stepEndTime = Date.now();

      if (externalAbortSignal?.aborted) {
        return createResult(
          false,
          'aborted',
          attachTrace('aborted', false, { stepsExecuted }),
          'Procedure execution aborted by caller'
        );
      }

      if (globalTimedOut) {
        return createResult(
          false,
          'timeout',
          attachTrace('timeout', false, { stepsExecuted }),
          'Procedure global execution timed out'
        );
      }

      const stepTrace = {
        stepId: step.id,
        action: step.action,
        parameters: resolvedStepParams,
        status: stepResult.success ? 'completed' : 'failed',
        success: Boolean(stepResult.success),
        reason: stepResult.reason,
        output: stepResult.data || null,
        error: stepResult.error || null,
        attempts: attempt,
        startedAt: new Date(stepStartTime).toISOString(),
        completedAt: new Date(stepEndTime).toISOString(),
        durationMs: Math.max(0, stepEndTime - stepStartTime)
      };

      context.stepTraces.push(stepTrace);
      context.stepResults[step.id] = stepResult;
      stepsExecuted++;

      if (!stepResult.success) {
        const isCritical = CRITICAL_ERROR_REASONS.has(stepResult.reason) || stepResult.critical === true;
        if (isCritical || !step.optional) {
          const failureReason = isCritical && (stepResult.reason === 'step_timeout' || stepResult.reason === 'critical_error')
            ? stepResult.reason
            : 'step_failed';
          const detail = stepResult.error && stepResult.error !== stepResult.reason
            ? `${stepResult.reason} (${stepResult.error})`
            : (stepResult.reason || stepResult.error);

          return createResult(
            false,
            failureReason,
            attachTrace('failed', false, {
              failedStepId: step.id,
              stepResult,
              stepsExecuted
            }),
            `Step '${step.id}' (${step.action}) failed: ${detail}`
          );
        }
      }
    }

    let postResult = null;
    if (!options.skipPostconditions && procedure.postconditions && procedure.postconditions.length > 0) {
      postResult = await evaluatePostconditions(bot, procedure.postconditions, context);
      if (!postResult.success) {
        return createResult(
          false,
          'postconditions_failed',
          attachTrace('postconditions_failed', false, {
            stepsExecuted,
            postconditionsResult: postResult.data
          }),
          postResult.error
        );
      }
    }

    return createResult(
      true,
      'completed',
      attachTrace('completed', true, {
        stepsExecuted,
        postconditionsResult: postResult?.data || null
      }),
      null
    );
  };

  try {
    if (globalTimeoutMs > 0) {
      const timeoutPromise = new Promise((resolve) => {
        globalTimer = setTimeout(() => {
          globalTimedOut = true;
          masterController.abort(new Error('Global procedure timeout reached'));
          resolve(createResult(
            false,
            'timeout',
            attachTrace('timeout', false, {
              stepsExecuted: context.stepTraces.length
            }),
            'Global procedure timeout reached'
          ));
        }, globalTimeoutMs);
      });

      return await Promise.race([executePipeline(), timeoutPromise]);
    }

    return await executePipeline();
  } finally {
    if (globalTimer) {
      clearTimeout(globalTimer);
    }
    if (externalAbortSignal) {
      externalAbortSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Exécuter une procédure expérimentale sous supervision stricte sans jamais promouvoir automatiquement son statut
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} procedure Procédure expérimentale à exécuter
 * @param {object} [options={}] Options de supervision
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat et trace complète
 */
async function executeExperimentalProcedure(bot, procedure, options = {}) {
  const supervisedOptions = {
    ...options,
    timeoutMs: options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_SUPERVISED_TIMEOUT_MS,
    maxStepTimeoutMs: options.maxStepTimeoutMs !== undefined ? options.maxStepTimeoutMs : DEFAULT_SUPERVISED_STEP_TIMEOUT_MS,
    maxSteps: options.maxSteps !== undefined ? options.maxSteps : DEFAULT_SUPERVISED_MAX_STEPS,
    maxDropCount: options.maxDropCount !== undefined ? options.maxDropCount : DEFAULT_MAX_DROP_COUNT,
    skipPreconditions: false
  };

  return await executeProcedure(bot, procedure, supervisedOptions);
}

/**
 * Orchestrer le cycle opérationnel complet : génération Ollama, validation sémantique, enregistrement expérimental et exécution supervisée
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} options Options du cycle expérimental
 * @param {string} options.objective Objectif cible
 * @param {object} options.memory Instance de ProcedureMemory
 * @param {object} [options.registry=null] Instance d'ActionRegistry
 * @param {object} [options.context={}] Contexte d'inventaire et d'environnement
 * @param {string} [options.storageDir=null] Répertoire de persistance
 * @param {Function} [options.askOllamaFn=null] Fonction d'interrogation Ollama injectable
 * @param {AbortSignal} [options.abortSignal=null] Signal d'annulation
 * @param {number} [options.timeoutMs] Timeout global d'exécution
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat complet du cycle
 */
async function runExperimentalProcedureCycle(bot, options = {}) {
  const {
    objective,
    memory,
    registry = createDefaultRegistry(),
    context = {},
    storageDir = null,
    askOllamaFn = null,
    abortSignal = null,
    timeoutMs = DEFAULT_SUPERVISED_TIMEOUT_MS,
    maxStepTimeoutMs = DEFAULT_SUPERVISED_STEP_TIMEOUT_MS,
    maxSteps = DEFAULT_SUPERVISED_MAX_STEPS,
    inputs = {}
  } = options;

  const genResult = await generateProcedure({
    objective,
    context,
    registry,
    existingProcedures: memory ? memory.getAll() : [],
    signal: abortSignal,
    askOllamaFn
  });

  if (!genResult.success || !genResult.data?.procedure) {
    return createResult(
      false,
      genResult.reason || 'generation_failed',
      { stage: 'generation', generation: genResult.data },
      genResult.error || 'Failed to generate candidate procedure'
    );
  }

  const candidate = genResult.data.procedure;
  const regResult = await registerExperimentalProcedure(memory, candidate, {
    registry,
    storageDir,
    generationMetadata: genResult.data.generationMetadata
  });

  if (!regResult.success || !regResult.data?.procedure) {
    return createResult(
      false,
      regResult.reason || 'registration_failed',
      { stage: 'registration', registration: regResult.data },
      regResult.error || 'Failed to validate and register experimental procedure'
    );
  }

  const registeredProcedure = regResult.data.procedure;
  const execResult = await executeExperimentalProcedure(bot, registeredProcedure, {
    actionRegistry: registry,
    inputs,
    abortSignal,
    timeoutMs,
    maxStepTimeoutMs,
    maxSteps
  });

  return createResult(
    execResult.success,
    execResult.reason,
    {
      stage: 'execution',
      procedure: registeredProcedure,
      registration: regResult.data,
      execution: execResult.data,
      trace: execResult.data?.trace || null
    },
    execResult.error
  );
}

module.exports = {
  DEFAULT_SUPERVISED_TIMEOUT_MS,
  DEFAULT_SUPERVISED_STEP_TIMEOUT_MS,
  DEFAULT_SUPERVISED_MAX_STEPS,
  CRITICAL_ERROR_REASONS,
  resolveReference,
  resolveDynamicValues,
  buildExecutionTrace,
  executeProcedure,
  executeExperimentalProcedure,
  runExperimentalProcedureCycle
};
