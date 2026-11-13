const { validateProcedureSchema, isDynamicReference, parseDynamicReference } = require('./schema');

const ALLOWED_PARAMETER_TYPES = Object.freeze(['string', 'number', 'boolean', 'object', 'array']);

const SUPPORTED_ASSERTION_TYPES = Object.freeze([
  'inventory_item',
  'block_state',
  'bot_health',
  'bot_food',
  'bot_position',
  'custom'
]);

const SUPPORTED_OPERATORS = Object.freeze([
  'eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'has',
  '==', '!=', '>', '>=', '<', '<='
]);

const STEP_RESULT_ROOT_SCHEMA = Object.freeze({
  success: { type: 'boolean' },
  reason: { type: 'string' },
  error: { type: 'string' },
  data: { type: 'object' }
});

/**
 * Créer une erreur de validation hybride compatible objet structuré et chaîne
 * @param {string} code Code d'erreur standardisé
 * @param {string} message Message explicatif lisible
 * @param {string|null} [stepId=null] Identifiant de l'étape concernée
 * @param {string|null} [field=null] Nom du champ ou paramètre en erreur
 * @returns {{ code: string, stepId: string|null, field: string|null, message: string }} Objet erreur enrichi
 */
function createValidationError(code, message, stepId = null, field = null) {
  const errObj = {
    code,
    stepId,
    field,
    message
  };

  Object.defineProperties(errObj, {
    toString: {
      value: () => message,
      enumerable: false
    },
    valueOf: {
      value: () => message,
      enumerable: false
    },
    includes: {
      value: (searchString, position) => message.includes(searchString, position),
      enumerable: false
    },
    match: {
      value: (matcher) => message.match(matcher),
      enumerable: false
    },
    toLowerCase: {
      value: () => message.toLowerCase(),
      enumerable: false
    }
  });

  return errObj;
}

/**
 * Créer un avertissement de validation structuré
 * @param {string} code Code d'avertissement
 * @param {string} message Description de l'avertissement
 * @param {string|null} [stepId=null] Identifiant de l'étape concernée
 * @param {string|null} [field=null] Champ concerné
 * @returns {{ code: string, stepId: string|null, field: string|null, message: string }} Avertissement
 */
function createValidationWarning(code, message, stepId = null, field = null) {
  return createValidationError(code, message, stepId, field);
}

/**
 * Déterminer le type effectif d'une valeur JavaScript pour le DSL
 * @param {any} value Valeur à inspecter
 * @returns {string} Nom du type ('string', 'number', 'boolean', 'array', 'object', 'null', 'undefined')
 */
function getValueType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'nan';
  return typeof value;
}

/**
 * Vérifier la correspondance entre un type fourni et une spécification de type attendue
 * @param {string|string[]} expectedType Type ou liste de types acceptés
 * @param {string} actualType Type observé
 * @returns {boolean} Vrai si les types sont compatibles
 */
function isTypeCompatible(expectedType, actualType) {
  if (!expectedType || !actualType) return true;
  const expectedList = Array.isArray(expectedType) ? expectedType : [expectedType];
  return expectedList.includes(actualType);
}

/**
 * Parcourir récursivement une structure pour extraire toutes les références dynamiques
 * @param {any} value Structure ou valeur à analyser
 * @param {string} [fieldPath=''] Chemin du champ parent
 * @returns {Array<{ ref: string, scope: string, targetId: string, path: string[], field: string }>} Références extraites
 */
function extractDynamicReferences(value, fieldPath = '') {
  const references = [];

  if (typeof value === 'string') {
    if (isDynamicReference(value)) {
      const parsed = parseDynamicReference(value);
      if (parsed) {
        references.push({ ref: value, ...parsed, field: fieldPath || null });
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      const nextPath = fieldPath ? `${fieldPath}[${idx}]` : `[${idx}]`;
      references.push(...extractDynamicReferences(item, nextPath));
    });
  } else if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const nextPath = fieldPath ? `${fieldPath}.${key}` : key;
      references.push(...extractDynamicReferences(val, nextPath));
    }
  }

  return references;
}

/**
 * Inspecter une structure pour détecter les chaînes ressemblant à des références malformées
 * @param {any} value Valeur ou objet à analyser
 * @param {string} [fieldPath=''] Chemin courant
 * @returns {Array<{ raw: string, field: string }>} Liste des références invalides
 */
function findMalformedReferences(value, fieldPath = '') {
  const malformed = [];

  if (typeof value === 'string') {
    if (value.startsWith('$') && !isDynamicReference(value)) {
      malformed.push({ raw: value, field: fieldPath || null });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      const nextPath = fieldPath ? `${fieldPath}[${idx}]` : `[${idx}]`;
      malformed.push(...findMalformedReferences(item, nextPath));
    });
  } else if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const nextPath = fieldPath ? `${fieldPath}.${key}` : key;
      malformed.push(...findMalformedReferences(val, nextPath));
    }
  }

  return malformed;
}

/**
 * Résoudre statiquement un chemin de propriété dans le schéma de sortie d'une étape
 * @param {object} targetActionDef Définition de l'action dans le registre
 * @param {string[]} pathSegments Segments du chemin après l'identifiant d'étape
 * @returns {{ valid: boolean, resolvedType: string|string[]|null, reason?: string }} Résultat de résolution
 */
function validateStepOutputPath(targetActionDef, pathSegments) {
  if (!Array.isArray(pathSegments) || pathSegments.length === 0) {
    return { valid: true, resolvedType: 'object' };
  }

  const rootProp = pathSegments[0];
  if (!Object.prototype.hasOwnProperty.call(STEP_RESULT_ROOT_SCHEMA, rootProp)) {
    return {
      valid: false,
      resolvedType: null,
      reason: `Property '${rootProp}' does not exist on step result (allowed root properties: success, reason, data, error)`
    };
  }

  if (rootProp !== 'data') {
    if (pathSegments.length > 1) {
      return {
        valid: false,
        resolvedType: null,
        reason: `Cannot traverse property '${pathSegments[1]}' on primitive step field '${rootProp}'`
      };
    }
    return { valid: true, resolvedType: STEP_RESULT_ROOT_SCHEMA[rootProp].type };
  }

  if (pathSegments.length === 1) {
    return { valid: true, resolvedType: 'object' };
  }

  const outputSchema = targetActionDef?.outputSchema;
  if (!outputSchema || typeof outputSchema !== 'object') {
    return { valid: true, resolvedType: null };
  }

  let currentSchema = { type: 'object', properties: outputSchema };
  for (let i = 1; i < pathSegments.length; i++) {
    const seg = pathSegments[i];
    const props = currentSchema.properties;

    if (!props || typeof props !== 'object') {
      if (currentSchema.type === 'object') {
        return { valid: true, resolvedType: null };
      }
      return {
        valid: false,
        resolvedType: null,
        reason: `Property '${seg}' is not accessible on non-object field '${pathSegments[i - 1]}'`
      };
    }

    if (!Object.prototype.hasOwnProperty.call(props, seg)) {
      return {
        valid: false,
        resolvedType: null,
        reason: `Property '${seg}' does not exist in output schema of action '${targetActionDef.id}'`
      };
    }

    currentSchema = props[seg];
  }

  return {
    valid: true,
    resolvedType: currentSchema?.type || null
  };
}

/**
 * Normaliser un opérateur de comparaison vers sa forme canonique
 * @param {string} [op='gte'] Opérateur brut
 * @returns {string} Opérateur normalisé
 */
function normalizeOperator(op = 'gte') {
  switch (op) {
    case '==': return 'eq';
    case '!=': return 'not_eq';
    case '>': return 'gt';
    case '>=':
    case 'has': return 'gte';
    case '<': return 'lt';
    case '<=': return 'lte';
    default: return op;
  }
}

/**
 * Vérifier si deux contraintes numériques sur la même grandeur sont contradictoires
 * @param {{ operator: string, value: number }} c1 Première contrainte
 * @param {{ operator: string, value: number }} c2 Seconde contrainte
 * @returns {boolean} Vrai si les deux conditions ne peuvent pas être satisfaites simultanément
 */
function areNumericConstraintsContradictory(c1, c2) {
  let min = -Infinity;
  let minStrict = false;
  let max = Infinity;
  let maxStrict = false;
  const eqValues = [];
  const notEqValues = new Set();

  for (const c of [c1, c2]) {
    const op = normalizeOperator(c.operator);
    const val = Number(c.value);
    if (Number.isNaN(val)) return false;

    if (op === 'eq') {
      eqValues.push(val);
    } else if (op === 'not_eq') {
      notEqValues.add(val);
    } else if (op === 'gt') {
      if (val > min || (val === min && !minStrict)) {
        min = val;
        minStrict = true;
      }
    } else if (op === 'gte') {
      if (val > min) {
        min = val;
        minStrict = false;
      }
    } else if (op === 'lt') {
      if (val < max || (val === max && !maxStrict)) {
        max = val;
        maxStrict = true;
      }
    } else if (op === 'lte') {
      if (val < max) {
        max = val;
        maxStrict = false;
      }
    }
  }

  if (eqValues.length === 2 && eqValues[0] !== eqValues[1]) {
    return true;
  }

  for (const eqVal of eqValues) {
    if (notEqValues.has(eqVal)) return true;
    if (eqVal < min || (eqVal === min && minStrict)) return true;
    if (eqVal > max || (eqVal === max && maxStrict)) return true;
  }

  if (min > max) return true;
  if (min === max && (minStrict || maxStrict)) return true;
  if (min === max && notEqValues.has(min)) return true;

  return false;
}

/**
 * Valider statiquement une liste de préconditions ou postconditions
 * @param {Array<object>} conditions Liste d'assertions
 * @param {'preconditions'|'postconditions'} kind Nature des conditions
 * @param {Set<string>} declaredParameters Paramètres déclarés
 * @param {Map<string, number>} stepIndexMap Index des étapes
 * @param {Array} errors Tableau d'erreurs à alimenter
 */
function validateConditions(conditions, kind, declaredParameters, stepIndexMap, errors) {
  if (!Array.isArray(conditions)) return;

  const isPre = kind === 'preconditions';
  const errorCode = isPre ? 'INCOHERENT_PRECONDITION' : 'UNVERIFIABLE_POSTCONDITION';
  const numericConstraintsBySubject = new Map();

  conditions.forEach((assertion, idx) => {
    if (!assertion || typeof assertion !== 'object') return;

    const fieldLabel = `${kind}[${idx}]`;
    const type = assertion.type;

    if (!SUPPORTED_ASSERTION_TYPES.includes(type)) {
      errors.push(createValidationError(
        errorCode,
        `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} uses unsupported assertion type '${type}'`,
        null,
        fieldLabel
      ));
      return;
    }

    if (assertion.operator !== undefined && !SUPPORTED_OPERATORS.includes(assertion.operator)) {
      errors.push(createValidationError(
        errorCode,
        `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} uses invalid operator '${assertion.operator}'`,
        null,
        `${fieldLabel}.operator`
      ));
    }

    const refs = extractDynamicReferences(assertion, fieldLabel);
    for (const ref of refs) {
      if (ref.scope === 'parameters' && !declaredParameters.has(ref.targetId)) {
        errors.push(createValidationError(
          errorCode,
          `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} references undeclared parameter '$parameters.${ref.targetId}'`,
          null,
          ref.field || fieldLabel
        ));
      } else if (ref.scope === 'steps') {
        if (isPre) {
          errors.push(createValidationError(
            'INCOHERENT_PRECONDITION',
            `Precondition at index ${idx} cannot reference step '$steps.${ref.targetId}' before execution`,
            null,
            ref.field || fieldLabel
          ));
        } else if (!stepIndexMap.has(ref.targetId)) {
          errors.push(createValidationError(
            'UNVERIFIABLE_POSTCONDITION',
            `Postcondition at index ${idx} references non-existent step '$steps.${ref.targetId}'`,
            null,
            ref.field || fieldLabel
          ));
        }
      }
    }

    if (type === 'inventory_item') {
      const itemName = assertion.item || assertion.itemName;
      if (typeof itemName !== 'string' || itemName.trim().length === 0) {
        errors.push(createValidationError(
          errorCode,
          `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('inventory_item') is missing a valid 'item' string`,
          null,
          `${fieldLabel}.item`
        ));
      }

      const rawCount = assertion.count !== undefined ? assertion.count : assertion.expected;
      if (rawCount !== undefined && !isDynamicReference(rawCount)) {
        if (typeof rawCount !== 'number' || Number.isNaN(rawCount) || rawCount < 0) {
          errors.push(createValidationError(
            errorCode,
            `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('inventory_item') has invalid count '${rawCount}' (must be a non-negative number)`,
            null,
            `${fieldLabel}.count`
          ));
        } else if (typeof itemName === 'string' && !isDynamicReference(itemName)) {
          const op = assertion.operator || 'gte';
          if (normalizeOperator(op) === 'lt' && rawCount === 0) {
            errors.push(createValidationError(
              errorCode,
              `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('inventory_item') requires impossible count < 0 for '${itemName}'`,
              null,
              `${fieldLabel}.count`
            ));
          }
          const subjectKey = `inventory:${itemName}`;
          const prevList = numericConstraintsBySubject.get(subjectKey) || [];
          for (const prev of prevList) {
            if (areNumericConstraintsContradictory(prev, { operator: op, value: rawCount })) {
              errors.push(createValidationError(
                errorCode,
                `Contradictory ${kind} on inventory item '${itemName}' between index ${prev.idx} and index ${idx}`,
                null,
                fieldLabel
              ));
            }
          }
          prevList.push({ operator: op, value: rawCount, idx });
          numericConstraintsBySubject.set(subjectKey, prevList);
        }
      }
    } else if (type === 'block_state') {
      const pos = assertion.position;
      const expectedBlock = assertion.block || assertion.blockName || assertion.expected;
      const validPos = isDynamicReference(pos) || (pos && typeof pos === 'object' && typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number');
      if (!validPos) {
        errors.push(createValidationError(
          errorCode,
          `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('block_state') requires a valid 'position' object {x, y, z}`,
          null,
          `${fieldLabel}.position`
        ));
      }
      if (!expectedBlock || (typeof expectedBlock !== 'string' && !Array.isArray(expectedBlock))) {
        errors.push(createValidationError(
          errorCode,
          `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('block_state') requires a valid 'block' string`,
          null,
          `${fieldLabel}.block`
        ));
      }
    } else if (type === 'bot_health' || type === 'bot_food') {
      const val = assertion.value !== undefined ? assertion.value : assertion.expected;
      if (val === undefined || (!isDynamicReference(val) && (typeof val !== 'number' || Number.isNaN(val)))) {
        errors.push(createValidationError(
          errorCode,
          `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('${type}') requires a numeric 'value'`,
          null,
          `${fieldLabel}.value`
        ));
      } else if (typeof val === 'number') {
        const op = assertion.operator || 'gte';
        const normOp = normalizeOperator(op);
        if (val < 0 || val > 20 || (normOp === 'gt' && val >= 20) || (normOp === 'lt' && val <= 0)) {
          errors.push(createValidationError(
            errorCode,
            `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('${type}') specifies impossible threshold (${op} ${val}) outside [0, 20]`,
            null,
            `${fieldLabel}.value`
          ));
        }
        const prevList = numericConstraintsBySubject.get(type) || [];
        for (const prev of prevList) {
          if (areNumericConstraintsContradictory(prev, { operator: op, value: val })) {
            errors.push(createValidationError(
              errorCode,
              `Contradictory ${kind} on '${type}' between index ${prev.idx} and index ${idx}`,
              null,
              fieldLabel
            ));
          }
        }
        prevList.push({ operator: op, value: val, idx });
        numericConstraintsBySubject.set(type, prevList);
      }
    } else if (type === 'bot_position') {
      const pos = assertion.position;
      const validPos = isDynamicReference(pos) || (pos && typeof pos === 'object' && typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number');
      if (!validPos) {
        errors.push(createValidationError(
          errorCode,
          `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('bot_position') requires a valid 'position' object {x, y, z}`,
          null,
          `${fieldLabel}.position`
        ));
      }
      if (assertion.maxDistance !== undefined && (typeof assertion.maxDistance !== 'number' || assertion.maxDistance < 0)) {
        errors.push(createValidationError(
          errorCode,
          `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('bot_position') requires 'maxDistance' >= 0`,
          null,
          `${fieldLabel}.maxDistance`
        ));
      }
    } else if (type === 'custom') {
      if (typeof assertion.fn !== 'function') {
        errors.push(createValidationError(
          errorCode,
          `${isPre ? 'Precondition' : 'Postcondition'} at index ${idx} ('custom') is missing an executable 'fn' predicate`,
          null,
          `${fieldLabel}.fn`
        ));
      }
    }
  });
}

/**
 * Valider l'intégrité sémantique, les actions du registre, les types, les références et la faisabilité statique d'une procédure
 * @param {object} procedure Définition de la procédure à valider
 * @param {object} actionRegistry Instance d'ActionRegistry contenant les actions autorisées
 * @param {object} [options={}] Options de configuration de la validation statique
 * @returns {{ valid: boolean, errors: Array, warnings: Array, analysis: { stepCount: number, validatedActions: number, dependencyCount: number } }} Verdict de validation
 */
function validateProcedure(procedure, actionRegistry, options = {}) {
  const errors = [];
  const warnings = [];
  const analysis = {
    stepCount: Array.isArray(procedure?.steps) ? procedure.steps.length : 0,
    validatedActions: 0,
    dependencyCount: 0
  };

  const schemaCheck = validateProcedureSchema(procedure);
  if (!schemaCheck.valid) {
    for (const msg of schemaCheck.errors) {
      errors.push(createValidationError('SCHEMA_VALIDATION_ERROR', msg, null, null));
    }
    return { valid: false, errors, warnings, analysis };
  }

  if (!actionRegistry || typeof actionRegistry.has !== 'function') {
    errors.push(createValidationError(
      'MISSING_ACTION_REGISTRY',
      'Action registry must be provided for semantic validation',
      null,
      null
    ));
    return { valid: false, errors, warnings, analysis };
  }

  const maxSteps = options.maxSteps !== undefined ? options.maxSteps : 50;
  if (procedure.steps.length > maxSteps) {
    errors.push(createValidationError(
      'MAX_STEPS_EXCEEDED',
      `Procedure step count (${procedure.steps.length}) exceeds maximum allowed steps (${maxSteps})`,
      null,
      'steps'
    ));
  }

  const parameterDefinitions = procedure.parameters || {};
  const declaredParameters = new Set(Object.keys(parameterDefinitions));

  for (const [paramName, paramSpec] of Object.entries(parameterDefinitions)) {
    if (!paramSpec || typeof paramSpec !== 'object' || Array.isArray(paramSpec)) {
      errors.push(createValidationError(
        'INVALID_PARAMETER_DECLARATION',
        `Declared parameter '${paramName}' must be a valid specification object`,
        null,
        paramName
      ));
      continue;
    }

    if (paramSpec.type !== undefined && !ALLOWED_PARAMETER_TYPES.includes(paramSpec.type)) {
      errors.push(createValidationError(
        'INVALID_PARAMETER_DECLARATION',
        `Declared parameter '${paramName}' has unsupported type '${paramSpec.type}'`,
        null,
        paramName
      ));
    }

    if (paramSpec.default !== undefined && paramSpec.type !== undefined) {
      const actualDefaultType = getValueType(paramSpec.default);
      if (!isTypeCompatible(paramSpec.type, actualDefaultType)) {
        errors.push(createValidationError(
          'INVALID_PARAMETER_DECLARATION',
          `Declared parameter '${paramName}' default value has type '${actualDefaultType}', expected '${paramSpec.type}'`,
          null,
          paramName
        ));
      }
    }
  }

  const stepIndexMap = new Map();
  const stepMap = new Map();
  procedure.steps.forEach((step, index) => {
    stepIndexMap.set(step.id, index);
    stepMap.set(step.id, step);
  });

  const preconditionedItems = new Set();
  if (Array.isArray(procedure.preconditions)) {
    for (const pre of procedure.preconditions) {
      if (pre && pre.type === 'inventory_item') {
        const item = pre.item || pre.itemName;
        const count = pre.count !== undefined ? pre.count : (pre.expected !== undefined ? pre.expected : 1);
        const op = normalizeOperator(pre.operator || 'gte');
        if (typeof item === 'string' && count > 0 && op !== 'lt' && op !== 'eq') {
          preconditionedItems.add(item);
        } else if (typeof item === 'string' && op === 'eq' && count > 0) {
          preconditionedItems.add(item);
        }
      }
    }
  }

  const firstItemProductionStep = new Map();
  procedure.steps.forEach((step, idx) => {
    const params = step.parameters || {};
    if (step.action === 'craft_recipe' && typeof params.recipe === 'string' && !isDynamicReference(params.recipe)) {
      if (!firstItemProductionStep.has(params.recipe)) {
        firstItemProductionStep.set(params.recipe, { index: idx, stepId: step.id, action: step.action });
      }
    } else if (step.action === 'withdraw_item' && typeof params.itemName === 'string' && !isDynamicReference(params.itemName)) {
      if (!firstItemProductionStep.has(params.itemName)) {
        firstItemProductionStep.set(params.itemName, { index: idx, stepId: step.id, action: step.action });
      }
    } else if (step.action === 'find_block' && typeof params.block === 'string' && !isDynamicReference(params.block)) {
      if (!firstItemProductionStep.has(params.block)) {
        firstItemProductionStep.set(params.block, { index: idx, stepId: step.id, action: step.action });
      }
    }
  });

  const forbiddenActions = new Set([
    ...(Array.isArray(options.forbiddenActions) ? options.forbiddenActions : []),
    ...(Array.isArray(procedure.constraints?.forbiddenActions) ? procedure.constraints.forbiddenActions : [])
  ]);

  const acquiredItemsSoFar = new Set(preconditionedItems);
  let hasOpenedContainer = false;

  procedure.steps.forEach((step, index) => {
    if (forbiddenActions.has(step.action)) {
      errors.push(createValidationError(
        'FORBIDDEN_ACTION',
        `Step '${step.id}' uses action '${step.action}' which is forbidden by declared constraints`,
        step.id,
        'action'
      ));
    }

    if (!actionRegistry.has(step.action)) {
      errors.push(createValidationError(
        'UNKNOWN_ACTION',
        `Step '${step.id}' references unknown action '${step.action}'`,
        step.id,
        'action'
      ));
      return;
    }

    analysis.validatedActions++;

    const actionDef = actionRegistry.get(step.action);
    const paramSchema = actionDef.parametersSchema || {};
    const requiredParams = paramSchema.required || [];
    const optionalParams = paramSchema.optional || [];
    const paramTypes = paramSchema.types || {};
    const stepParams = step.parameters || {};

    for (const req of requiredParams) {
      if (stepParams[req] === undefined) {
        errors.push(createValidationError(
          'MISSING_REQUIRED_PARAMETER',
          `Step '${step.id}' action '${step.action}' is missing required parameter '${req}'`,
          step.id,
          req
        ));
      }
    }

    const disallowUnknown = paramSchema.allowAdditionalProperties === false || options.disallowUnknownParameters === true;
    if (disallowUnknown && (requiredParams.length > 0 || optionalParams.length > 0 || paramSchema.allowAdditionalProperties === false)) {
      const allowedKeys = new Set([...requiredParams, ...optionalParams, ...Object.keys(paramTypes)]);
      for (const providedKey of Object.keys(stepParams)) {
        if (!allowedKeys.has(providedKey)) {
          errors.push(createValidationError(
            'UNKNOWN_PARAMETER',
            `Step '${step.id}' action '${step.action}' does not allow unknown parameter '${providedKey}'`,
            step.id,
            providedKey
          ));
        }
      }
    }

    const malformedRefs = findMalformedReferences(stepParams);
    for (const badRef of malformedRefs) {
      errors.push(createValidationError(
        'MALFORMED_REFERENCE',
        `Step '${step.id}' contains malformed dynamic reference '${badRef.raw}' in field '${badRef.field}'`,
        step.id,
        badRef.field
      ));
    }

    for (const [paramKey, paramValue] of Object.entries(stepParams)) {
      if (paramValue === undefined) continue;
      const expectedType = paramTypes[paramKey];
      if (!expectedType) continue;

      if (typeof paramValue === 'string' && isDynamicReference(paramValue)) {
        continue;
      }

      const actualType = getValueType(paramValue);
      if (!isTypeCompatible(expectedType, actualType)) {
        const expectedLabel = Array.isArray(expectedType) ? expectedType.join(' or ') : expectedType;
        errors.push(createValidationError(
          'INVALID_PARAMETER_TYPE',
          `Step '${step.id}' parameter '${paramKey}': expected ${expectedLabel}, received ${actualType}`,
          step.id,
          paramKey
        ));
      }
    }

    const dynamicRefs = extractDynamicReferences(stepParams);
    analysis.dependencyCount += dynamicRefs.length;

    for (const ref of dynamicRefs) {
      const rootFieldKey = ref.field ? ref.field.split(/[.[\]]/)[0] : null;
      const isDirectFieldRef = ref.field === rootFieldKey;
      const expectedFieldType = isDirectFieldRef && rootFieldKey ? paramTypes[rootFieldKey] : null;

      if (ref.scope === 'parameters') {
        if (!declaredParameters.has(ref.targetId)) {
          errors.push(createValidationError(
            'UNDECLARED_PARAMETER',
            `Step '${step.id}' references undeclared parameter '$parameters.${ref.targetId}'`,
            step.id,
            rootFieldKey || ref.targetId
          ));
        } else {
          const paramSpec = parameterDefinitions[ref.targetId];
          const declaredType = paramSpec?.type;
          if (declaredType && expectedFieldType && !isTypeCompatible(expectedFieldType, declaredType)) {
            const expectedLabel = Array.isArray(expectedFieldType) ? expectedFieldType.join(' or ') : expectedFieldType;
            errors.push(createValidationError(
              'INCOMPATIBLE_REFERENCE_TYPE',
              `Step '${step.id}' parameter '${rootFieldKey}' expects ${expectedLabel}, but '$parameters.${ref.targetId}' is declared as ${declaredType}`,
              step.id,
              rootFieldKey
            ));
          }
        }
      } else if (ref.scope === 'steps') {
        if (!stepIndexMap.has(ref.targetId)) {
          errors.push(createValidationError(
            'NON_EXISTENT_STEP_REFERENCE',
            `Step '${step.id}' references non-existent step '$steps.${ref.targetId}'`,
            step.id,
            rootFieldKey || ref.field
          ));
        } else {
          const dependencyIndex = stepIndexMap.get(ref.targetId);
          if (dependencyIndex === index) {
            errors.push(createValidationError(
              'CIRCULAR_DEPENDENCY',
              `Step '${step.id}' contains self-referencing circular dependency on itself`,
              step.id,
              rootFieldKey || ref.field
            ));
          } else if (dependencyIndex > index) {
            errors.push(createValidationError(
              'FUTURE_STEP_REFERENCE',
              `Step '${step.id}' references future step '${ref.targetId}' (dependency must precede step)`,
              step.id,
              rootFieldKey || ref.field
            ));
          } else {
            const targetStep = stepMap.get(ref.targetId);
            const targetActionDef = actionRegistry.get(targetStep.action);
            if (targetActionDef) {
              const pathValidation = validateStepOutputPath(targetActionDef, ref.path);
              if (!pathValidation.valid) {
                errors.push(createValidationError(
                  'INVALID_REFERENCE_PATH',
                  `Step '${step.id}' reference '${ref.ref}' is invalid: ${pathValidation.reason}`,
                  step.id,
                  rootFieldKey || ref.field
                ));
              } else if (pathValidation.resolvedType && expectedFieldType) {
                const resolvedTypes = Array.isArray(pathValidation.resolvedType)
                  ? pathValidation.resolvedType
                  : [pathValidation.resolvedType];
                const compatible = resolvedTypes.some(t => isTypeCompatible(expectedFieldType, t));
                if (!compatible) {
                  const expectedLabel = Array.isArray(expectedFieldType) ? expectedFieldType.join(' or ') : expectedFieldType;
                  const resolvedLabel = resolvedTypes.join(' or ');
                  errors.push(createValidationError(
                    'INCOMPATIBLE_REFERENCE_TYPE',
                    `Step '${step.id}' parameter '${rootFieldKey}' expects ${expectedLabel}, but reference '${ref.ref}' resolves to ${resolvedLabel}`,
                    step.id,
                    rootFieldKey
                  ));
                }
              }
            }
          }
        }
      }
    }

    if (step.action === 'open_container') {
      hasOpenedContainer = true;
    }

    if (step.action === 'craft_recipe' && typeof stepParams.recipe === 'string' && !isDynamicReference(stepParams.recipe)) {
      acquiredItemsSoFar.add(stepParams.recipe);
    } else if (step.action === 'withdraw_item' && typeof stepParams.itemName === 'string' && !isDynamicReference(stepParams.itemName)) {
      acquiredItemsSoFar.add(stepParams.itemName);
    } else if (step.action === 'break_block') {
      acquiredItemsSoFar.add('*');
    }

    const actionsRequiringItem = ['equip_item', 'place_block', 'consume_item', 'drop_item', 'deposit_item'];
    if (actionsRequiringItem.includes(step.action)) {
      const targetItem = stepParams.itemName;
      if (typeof targetItem === 'string' && !isDynamicReference(targetItem)) {
        const producer = firstItemProductionStep.get(targetItem);
        const alreadyAcquired = acquiredItemsSoFar.has(targetItem);

        if (!alreadyAcquired && producer && producer.index > index) {
          errors.push(createValidationError(
            'MISSING_LOGICAL_DEPENDENCY',
            `Step '${step.id}' (${step.action}) uses item '${targetItem}' before step '${producer.stepId}' (${producer.action}) produces or acquires it`,
            step.id,
            'itemName'
          ));
        } else if (
          step.action === 'equip_item' &&
          !alreadyAcquired &&
          !acquiredItemsSoFar.has('*') &&
          options.allowUnacquiredEquip !== true
        ) {
          errors.push(createValidationError(
            'MISSING_LOGICAL_DEPENDENCY',
            `Step '${step.id}' attempts to equip '${targetItem}' without prior acquisition step or inventory precondition`,
            step.id,
            'itemName'
          ));
        }
      }
    }

    if (
      (step.action === 'deposit_item' || step.action === 'withdraw_item') &&
      typeof stepParams.containerWindow === 'string' &&
      isDynamicReference(stepParams.containerWindow)
    ) {
      const parsedWinRef = parseDynamicReference(stepParams.containerWindow);
      if (parsedWinRef?.scope === 'steps' && stepMap.has(parsedWinRef.targetId)) {
        const sourceStep = stepMap.get(parsedWinRef.targetId);
        if (sourceStep.action !== 'open_container' && !hasOpenedContainer) {
          errors.push(createValidationError(
            'MISSING_LOGICAL_DEPENDENCY',
            `Step '${step.id}' (${step.action}) requires an opened container window, but step '${sourceStep.id}' is '${sourceStep.action}'`,
            step.id,
            'containerWindow'
          ));
        }
      }
    }
  });

  if (options.maxDependencies !== undefined && analysis.dependencyCount > options.maxDependencies) {
    errors.push(createValidationError(
      'MAX_DEPENDENCIES_EXCEEDED',
      `Procedure dependency count (${analysis.dependencyCount}) exceeds maximum allowed dependencies (${options.maxDependencies})`,
      null,
      'steps'
    ));
  }

  validateConditions(procedure.preconditions, 'preconditions', declaredParameters, stepIndexMap, errors);
  validateConditions(procedure.postconditions, 'postconditions', declaredParameters, stepIndexMap, errors);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    analysis
  };
}

module.exports = {
  ALLOWED_PARAMETER_TYPES,
  SUPPORTED_ASSERTION_TYPES,
  SUPPORTED_OPERATORS,
  createValidationError,
  createValidationWarning,
  extractDynamicReferences,
  validateProcedure
};
