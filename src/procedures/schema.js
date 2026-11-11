const CURRENT_DSL_VERSION = 1;

const ALLOWED_STATUSES = Object.freeze(['experimental', 'validated', 'deprecated']);

const IDENTIFIER_REGEX = /^[a-z0-9_-]{1,64}$/;

const DYNAMIC_REF_REGEX = /^\$(steps\.[a-z0-9_-]+(\.[a-zA-Z0-9_.-]+)*|parameters\.[a-z0-9_-]+)$/;

/**
 * Test whether a value string is a dynamic reference to parameters or previous steps
 * @param {any} value Value to test
 * @returns {boolean} True if string matches dynamic reference format
 */
function isDynamicReference(value) {
  if (typeof value !== 'string') return false;
  return DYNAMIC_REF_REGEX.test(value);
}

/**
 * Parse dynamic reference string into root scope, target identifier, and path segments
 * @param {string} refString Dynamic reference string
 * @returns {{ scope: 'steps'|'parameters', targetId: string, path: string[] }|null} Parsed reference components
 */
function parseDynamicReference(refString) {
  if (!isDynamicReference(refString)) return null;

  const raw = refString.slice(1);
  const parts = raw.split('.');
  const scope = parts[0];
  const targetId = parts[1];
  const path = parts.slice(2);

  return { scope, targetId, path };
}

/**
 * Validate deep schema structure and integrity of a procedure definition object
 * @param {any} procedure Procedure object to validate
 * @returns {{ valid: boolean, errors: string[] }} Validation result and error descriptions
 */
function validateProcedureSchema(procedure) {
  const errors = [];

  if (!procedure || typeof procedure !== 'object' || Array.isArray(procedure)) {
    return { valid: false, errors: ['Procedure root must be a non-null object'] };
  }

  if (typeof procedure.id !== 'string' || !IDENTIFIER_REGEX.test(procedure.id)) {
    errors.push(`Field 'id' must be a valid identifier matching ${IDENTIFIER_REGEX}`);
  }

  if (typeof procedure.name !== 'string' || procedure.name.trim().length === 0 || procedure.name.length > 128) {
    errors.push("Field 'name' must be a non-empty string with maximum 128 characters");
  }

  if (!Number.isInteger(procedure.version) || procedure.version < 1) {
    errors.push("Field 'version' must be an integer >= 1");
  }

  if (!ALLOWED_STATUSES.includes(procedure.status)) {
    errors.push(`Field 'status' must be one of: ${ALLOWED_STATUSES.join(', ')}`);
  }

  if (procedure.description !== undefined) {
    if (typeof procedure.description !== 'string' || procedure.description.length > 512) {
      errors.push("Field 'description' must be a string with maximum 512 characters");
    }
  }

  if (procedure.parameters !== undefined) {
    if (!procedure.parameters || typeof procedure.parameters !== 'object' || Array.isArray(procedure.parameters)) {
      errors.push("Field 'parameters' must be an object schema of declared input arguments");
    }
  }

  if (procedure.preconditions !== undefined) {
    if (!Array.isArray(procedure.preconditions)) {
      errors.push("Field 'preconditions' must be an array of precondition assertions");
    } else {
      procedure.preconditions.forEach((p, idx) => {
        if (!p || typeof p !== 'object' || typeof p.type !== 'string' || p.type.trim().length === 0) {
          errors.push(`Precondition at index ${idx} must be an object with a non-empty 'type' string`);
        }
      });
    }
  }

  if (!Array.isArray(procedure.steps) || procedure.steps.length === 0) {
    errors.push("Field 'steps' must be a non-empty array of execution steps");
  } else if (procedure.steps.length > 50) {
    errors.push("Field 'steps' exceeds maximum complexity limit of 50 steps");
  } else {
    const seenStepIds = new Set();

    procedure.steps.forEach((step, idx) => {
      if (!step || typeof step !== 'object') {
        errors.push(`Step at index ${idx} must be an object`);
        return;
      }

      if (typeof step.id !== 'string' || !IDENTIFIER_REGEX.test(step.id)) {
        errors.push(`Step at index ${idx} has invalid 'id': must match ${IDENTIFIER_REGEX}`);
      } else if (seenStepIds.has(step.id)) {
        errors.push(`Step identifier '${step.id}' is duplicated within procedure`);
      } else {
        seenStepIds.add(step.id);
      }

      if (typeof step.action !== 'string' || step.action.trim().length === 0) {
        errors.push(`Step '${step.id || idx}' must declare a non-empty 'action' string`);
      }

      if (step.parameters !== undefined && (typeof step.parameters !== 'object' || step.parameters === null || Array.isArray(step.parameters))) {
        errors.push(`Step '${step.id || idx}' parameters must be an object`);
      }

      if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 0)) {
        errors.push(`Step '${step.id || idx}' timeoutMs must be a positive integer`);
      }

      if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0 || step.retries > 5)) {
        errors.push(`Step '${step.id || idx}' retries must be an integer between 0 and 5`);
      }
    });
  }

  if (procedure.postconditions !== undefined) {
    if (!Array.isArray(procedure.postconditions)) {
      errors.push("Field 'postconditions' must be an array of postcondition expectations");
    } else {
      procedure.postconditions.forEach((p, idx) => {
        if (!p || typeof p !== 'object' || typeof p.type !== 'string' || p.type.trim().length === 0) {
          errors.push(`Postcondition at index ${idx} must be an object with a non-empty 'type' string`);
        }
      });
    }
  }

  if (procedure.metadata !== undefined) {
    if (!procedure.metadata || typeof procedure.metadata !== 'object' || Array.isArray(procedure.metadata)) {
      errors.push("Field 'metadata' must be an object");
    } else {
      const { confidenceScore, executionCount, successCount, failureCount } = procedure.metadata;
      if (confidenceScore !== undefined && (typeof confidenceScore !== 'number' || confidenceScore < 0 || confidenceScore > 1)) {
        errors.push("Metadata 'confidenceScore' must be a float between 0 and 1");
      }
      if (executionCount !== undefined && (!Number.isInteger(executionCount) || executionCount < 0)) {
        errors.push("Metadata 'executionCount' must be an integer >= 0");
      }
      if (successCount !== undefined && (!Number.isInteger(successCount) || successCount < 0)) {
        errors.push("Metadata 'successCount' must be an integer >= 0");
      }
      if (failureCount !== undefined && (!Number.isInteger(failureCount) || failureCount < 0)) {
        errors.push("Metadata 'failureCount' must be an integer >= 0");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generate standard compliant procedure skeleton
 * @param {object} [partial={}] Initial property overrides
 * @returns {object} Valid default procedure object
 */
function createProcedureTemplate(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: partial.id || 'unnamed_procedure',
    version: partial.version || CURRENT_DSL_VERSION,
    name: partial.name || 'Unnamed Procedure',
    status: partial.status || 'experimental',
    description: partial.description || '',
    parameters: partial.parameters || {},
    preconditions: partial.preconditions || [],
    steps: partial.steps || [],
    postconditions: partial.postconditions || [],
    metadata: {
      author: partial.metadata?.author || 'system',
      createdAt: partial.metadata?.createdAt || now,
      updatedAt: partial.metadata?.updatedAt || now,
      executionCount: partial.metadata?.executionCount || 0,
      successCount: partial.metadata?.successCount || 0,
      failureCount: partial.metadata?.failureCount || 0,
      confidenceScore: partial.metadata?.confidenceScore !== undefined ? partial.metadata.confidenceScore : 0.5,
      tags: partial.metadata?.tags || []
    }
  };
}

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

module.exports = {
  CURRENT_DSL_VERSION,
  ALLOWED_STATUSES,
  IDENTIFIER_REGEX,
  DYNAMIC_REF_REGEX,
  isDynamicReference,
  parseDynamicReference,
  resolveReference,
  resolveDynamicValues,
  validateProcedureSchema,
  createProcedureTemplate
};
