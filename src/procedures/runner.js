const { createResult } = require('../actions/primitives/result');
const { createDefaultRegistry } = require('./registry');
const { validateProcedure } = require('./validator');
const { isDynamicReference, parseDynamicReference, resolveReference, resolveDynamicValues } = require('./schema');
const { evaluatePreconditions, evaluatePostconditions } = require('./evaluator');

/**
 * Execute a validated procedure step by step in sequence
 * @param {object} bot Mineflayer bot instance
 * @param {object} procedure Procedure definition object
 * @param {object} [options={}] Execution options
 * @param {object} [options.inputs={}] Input parameter arguments
 * @param {object} [options.actionRegistry=null] Registry containing allowed actions
 * @param {number} [options.timeoutMs=0] Global procedure timeout in milliseconds
 * @param {AbortSignal} [options.abortSignal=null] External cancellation signal
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function executeProcedure(bot, procedure, options = {}) {
  const registry = options.actionRegistry || createDefaultRegistry();
  const inputs = options.inputs || {};
  const globalTimeoutMs = options.timeoutMs || 0;
  const abortSignal = options.abortSignal;

  const validation = validateProcedure(procedure, registry);
  if (!validation.valid) {
    return createResult(false, 'invalid_procedure', { errors: validation.errors }, 'Procedure failed semantic validation');
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
    startTime: Date.now()
  };

  if (abortSignal?.aborted) {
    return createResult(false, 'aborted', {
      procedureId: procedure.id,
      stepsExecuted: 0,
      stepTraces: []
    }, 'Procedure execution was aborted before start');
  }

  let globalTimer = null;
  let timedOut = false;

  const executePipeline = async () => {
    if (!options.skipPreconditions && procedure.preconditions && procedure.preconditions.length > 0) {
      const preResult = await evaluatePreconditions(bot, procedure.preconditions, context);
      if (!preResult.success) {
        return createResult(false, 'preconditions_failed', {
          procedureId: procedure.id,
          preconditionsResult: preResult.data,
          stepTraces: []
        }, preResult.error);
      }
    }

    let stepsExecuted = 0;

    for (const step of procedure.steps) {
      if (abortSignal?.aborted) {
        return createResult(false, 'aborted', {
          procedureId: procedure.id,
          stepsExecuted,
          stepResults: context.stepResults,
          stepTraces: context.stepTraces
        }, 'Procedure execution aborted by caller');
      }

      if (timedOut) {
        return createResult(false, 'timeout', {
          procedureId: procedure.id,
          stepsExecuted,
          stepResults: context.stepResults,
          stepTraces: context.stepTraces
        }, 'Procedure global execution timed out');
      }

      let resolvedStepParams;
      try {
        resolvedStepParams = resolveDynamicValues(step.parameters || {}, context);
      } catch (err) {
        return createResult(false, 'resolution_error', {
          failedStepId: step.id,
          procedureId: procedure.id,
          stepTraces: context.stepTraces
        }, err.message);
      }

      const actionDef = registry.get(step.action);
      const stepTimeoutMs = step.timeoutMs || actionDef.defaultTimeoutMs;
      const retries = step.retries || 0;

      let stepResult = null;
      let attempt = 0;
      const stepStartTime = Date.now();

      while (attempt <= retries) {
        attempt++;
        try {
          stepResult = await actionDef.handler(bot, resolvedStepParams, {
            timeoutMs: stepTimeoutMs,
            abortSignal
          });
        } catch (err) {
          stepResult = createResult(false, 'error', null, String(err?.message || err));
        }

        if (stepResult.success || abortSignal?.aborted || timedOut) {
          break;
        }
      }

      const stepTrace = {
        stepId: step.id,
        action: step.action,
        parameters: resolvedStepParams,
        success: stepResult.success,
        reason: stepResult.reason,
        attempts: attempt,
        durationMs: Date.now() - stepStartTime
      };
      context.stepTraces.push(stepTrace);
      context.stepResults[step.id] = stepResult;
      stepsExecuted++;

      if (!stepResult.success) {
        if (!step.optional) {
          return createResult(false, 'step_failed', {
            procedureId: procedure.id,
            failedStepId: step.id,
            stepResult,
            stepsExecuted,
            stepResults: context.stepResults,
            stepTraces: context.stepTraces
          }, `Step '${step.id}' (${step.action}) failed: ${stepResult.reason}`);
        }
      }
    }

    let postResult = null;
    if (!options.skipPostconditions && procedure.postconditions && procedure.postconditions.length > 0) {
      postResult = await evaluatePostconditions(bot, procedure.postconditions, context);
      if (!postResult.success) {
        return createResult(false, 'postconditions_failed', {
          procedureId: procedure.id,
          durationMs: Date.now() - context.startTime,
          stepsExecuted,
          stepResults: context.stepResults,
          stepTraces: context.stepTraces,
          postconditionsResult: postResult.data
        }, postResult.error);
      }
    }

    return createResult(true, 'completed', {
      procedureId: procedure.id,
      durationMs: Date.now() - context.startTime,
      stepsExecuted,
      stepResults: context.stepResults,
      stepTraces: context.stepTraces,
      postconditionsResult: postResult?.data || null
    }, null);
  };

  try {
    if (globalTimeoutMs > 0) {
      const timeoutPromise = new Promise((resolve) => {
        globalTimer = setTimeout(() => {
          timedOut = true;
          resolve(createResult(false, 'timeout', {
            procedureId: procedure.id,
            stepTraces: context.stepTraces
          }, 'Global procedure timeout reached'));
        }, globalTimeoutMs);
      });

      return await Promise.race([executePipeline(), timeoutPromise]);
    }

    return await executePipeline();
  } finally {
    if (globalTimer) {
      clearTimeout(globalTimer);
    }
  }
}

module.exports = {
  resolveReference,
  resolveDynamicValues,
  executeProcedure
};
