const { validateProcedureSchema, isDynamicReference, parseDynamicReference } = require('./schema');

/**
 * Recursively scan an arbitrary value or nested object/array for dynamic references
 * @param {any} value Any data structure or value to inspect
 * @returns {Array<{ ref: string, scope: string, targetId: string, path: string[] }>} Extracted dynamic references
 */
function extractDynamicReferences(value) {
  const references = [];

  if (typeof value === 'string') {
    if (isDynamicReference(value)) {
      const parsed = parseDynamicReference(value);
      if (parsed) {
        references.push({ ref: value, ...parsed });
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      references.push(...extractDynamicReferences(item));
    }
  } else if (value && typeof value === 'object') {
    for (const val of Object.values(value)) {
      references.push(...extractDynamicReferences(val));
    }
  }

  return references;
}

/**
 * Validate semantic integrity, registry actions, and step dependency DAG for a procedure
 * @param {object} procedure Procedure definition to validate
 * @param {object} actionRegistry ActionRegistry instance holding allowed actions
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }} Semantic validation verdict
 */
function validateProcedure(procedure, actionRegistry) {
  const errors = [];
  const warnings = [];

  const schemaCheck = validateProcedureSchema(procedure);
  if (!schemaCheck.valid) {
    errors.push(...schemaCheck.errors);
    return { valid: false, errors, warnings };
  }

  if (!actionRegistry || typeof actionRegistry.has !== 'function') {
    errors.push('Action registry must be provided for semantic validation');
    return { valid: false, errors, warnings };
  }

  const declaredParameters = new Set(Object.keys(procedure.parameters || {}));
  const stepIndexMap = new Map();

  procedure.steps.forEach((step, index) => {
    stepIndexMap.set(step.id, index);
  });

  procedure.steps.forEach((step, index) => {
    if (!actionRegistry.has(step.action)) {
      errors.push(`Step '${step.id}' references unknown action '${step.action}'`);
      return;
    }

    const actionDef = actionRegistry.get(step.action);
    const requiredParams = actionDef.parametersSchema?.required || [];
    const stepParams = step.parameters || {};

    for (const req of requiredParams) {
      if (stepParams[req] === undefined) {
        errors.push(`Step '${step.id}' action '${step.action}' is missing required parameter '${req}'`);
      }
    }

    const dynamicRefs = extractDynamicReferences(stepParams);

    for (const ref of dynamicRefs) {
      if (ref.scope === 'parameters') {
        if (!declaredParameters.has(ref.targetId)) {
          errors.push(`Step '${step.id}' references undeclared parameter '$parameters.${ref.targetId}'`);
        }
      } else if (ref.scope === 'steps') {
        if (!stepIndexMap.has(ref.targetId)) {
          errors.push(`Step '${step.id}' references non-existent step '$steps.${ref.targetId}'`);
        } else {
          const dependencyIndex = stepIndexMap.get(ref.targetId);
          if (dependencyIndex === index) {
            errors.push(`Step '${step.id}' contains self-referencing circular dependency on itself`);
          } else if (dependencyIndex > index) {
            errors.push(`Step '${step.id}' references future step '${ref.targetId}' (dependency must precede step)`);
          }
        }
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

module.exports = {
  extractDynamicReferences,
  validateProcedure
};
