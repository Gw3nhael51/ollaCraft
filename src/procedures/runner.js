const { createResult } = require('../actions/primitives/result');
const { createDefaultRegistry } = require('./registry');
const { validateProcedure } = require('./validator');
const { isDynamicReference, parseDynamicReference } = require('./schema');

/**
 * Resolve dynamic reference against execution context
 * @param {string} refString Dynamic reference expression
 * @param {object} context Active procedure execution context
 * @returns {any} Resolved value
 */
function resolveReference(refString, context) {
  const parsed = parseDynamicReference(refString);
  if (!parsed) {
    throw new Error(`Malformed dynamic reference: '${refString}'`);
  }

  if (parsed.scope === 'parameters') {
    const paramValue = context.parameters[parsed.targetId];
    if (paramValue === undefined) {
      throw new Error(`Reference '${refString}' could not be resolved: parameter '${parsed.targetId}' is undefined`);
    }
    return paramValue;
  }

  if (parsed.scope === 'steps') {
    const stepResult = context.stepResults[parsed.targetId];
    if (!stepResult) {
      throw new Error(`Reference '${refString}' could not be resolved: step '${parsed.targetId}' produced no result`);
    }

    let current = stepResult;
    for (const segment of parsed.path) {
      if (current === null || current === undefined || typeof current !== 'object') {
        throw new Error(`Reference '${refString}' could not traverse property '${segment}' on non-object`);
      }
      current = current[segment];
    }

    if (current === undefined) {
      throw new Error(`Reference '${refString}' resolved to undefined`);
    }

    return current;
  }

  throw new Error(`Unknown reference scope '${parsed.scope}' in '${refString}'`);
}

/**
 * Recursively resolve all dynamic expressions within a parameters structure
 * @param {any} value Parameter payload containing static or dynamic values
 * @param {object} context Active execution context
 * @returns {any} Fully evaluated data structure with resolved values
 */
function resolveDynamicValues(value, context) {
  if (typeof value === 'string') {
    if (isDynamicReference(value)) {
      return resolveReference(value, context);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveDynamicValues(item, context));
  }

  if (value && typeof value === 'object') {
    const resolved = {};
    for (const [key, val] of Object.entries(value)) {
      resolved[key] = resolveDynamicValues(val, context);
    }
    return resolved;
  }

  return value;
}

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

    return createResult(true, 'completed', {
      procedureId: procedure.id,
      durationMs: Date.now() - context.startTime,
      stepsExecuted,
      stepResults: context.stepResults,
      stepTraces: context.stepTraces
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
