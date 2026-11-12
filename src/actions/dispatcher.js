const { skillMine } = require('./behaviors/blocks/mine');
const { skillCraft } = require('./behaviors/items/craft');
const { skillPlace } = require('./behaviors/blocks/place');
const { skillUnstuck, skillExplore } = require('./behaviors/movement/navigate');
const { skillWiki } = require('../minecraft/wiki');
const { skillSmelt } = require('./behaviors/items/smelt');
const { skillEat } = require('./behaviors/items/eat');
const { skillHunt, skillFight } = require('./behaviors/combat/combat');
const { skillChest } = require('./behaviors/items/storage');
const { skillEquip } = require('./behaviors/items/equip');
const { skillPortal } = require('./behaviors/world/portal');
const { createDefaultRegistry } = require('../procedures/registry');
const { validateProcedure } = require('../procedures/validator');
const { executeProcedure } = require('../procedures/runner');
const { ProcedureMemory } = require('../procedures/memory');
const { IDENTIFIER_REGEX, ALLOWED_STATUSES } = require('../procedures/schema');

const defaultActionRegistry = createDefaultRegistry();
const defaultProcedureMemory = new ProcedureMemory();

/**
 * Execute an autonomous registered procedure safely through semantic validation and runner
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string|object} target Procedure identifier or target descriptor
 * @param {number|object} [qty] Requested quantity or parameter payload
 * @param {object} [options={}] Optional runner overrides and dependencies
 * @returns {Promise<{ success: boolean, message: string }>} Execution result conforming to dispatcher contract
 */
async function skillProcedure(bot, state, target, qty, options = {}) {
  // Déterminer : Résoudre la mémoire et le registre applicables
  const memory = options.memory || state?.procedureMemory || defaultProcedureMemory;
  const registry = options.actionRegistry || defaultActionRegistry;

  // Extraire : Identifier la procédure cible
  let procedureId = null;
  let targetInputs = {};

  if (typeof target === 'string') {
    procedureId = target.trim();
  } else if (target && typeof target === 'object') {
    procedureId = typeof target.id === 'string' ? target.id.trim() : null;
    if (target.parameters && typeof target.parameters === 'object') {
      targetInputs = { ...target.parameters };
    }
  }

  // Vérifier : Valider la conformité de l'identifiant de procédure
  if (!procedureId || !IDENTIFIER_REGEX.test(procedureId)) {
    return {
      success: false,
      message: `Invalid procedure identifier '${procedureId}'.`
    };
  }

  // Rechercher : Obtenir la procédure enregistrée depuis la mémoire
  const procedure = memory.get(procedureId);
  if (!procedure) {
    return {
      success: false,
      message: `Procedure '${procedureId}' not found in procedure memory.`
    };
  }

  // Vérifier : Contrôler le statut de cycle de vie de la procédure
  if (!procedure.status || !ALLOWED_STATUSES.includes(procedure.status)) {
    return {
      success: false,
      message: `Procedure '${procedureId}' has invalid status '${procedure.status}'.`
    };
  }

  if (procedure.status === 'deprecated') {
    return {
      success: false,
      message: `Procedure '${procedureId}' is deprecated and cannot be executed.`
    };
  }

  // Résoudre : Agréger les paramètres d'entrée
  let inputs = {};
  if (qty && typeof qty === 'object') {
    inputs = { ...qty };
  } else {
    inputs = { ...targetInputs };
    if (options.inputs && typeof options.inputs === 'object') {
      inputs = { ...inputs, ...options.inputs };
    }
    if (typeof qty === 'number') {
      if (procedure.parameters?.count && inputs.count === undefined) {
        inputs.count = qty;
      } else if (procedure.parameters?.qty && inputs.qty === undefined) {
        inputs.qty = qty;
      } else if (procedure.parameters?.amount && inputs.amount === undefined) {
        inputs.amount = qty;
      }
    }
  }

  // Vérifier : Valider la présence et le type des paramètres déclarés
  if (procedure.parameters && typeof procedure.parameters === 'object') {
    for (const [paramName, paramDef] of Object.entries(procedure.parameters)) {
      if (paramDef && typeof paramDef === 'object') {
        const isRequired = paramDef.required === true;
        const hasValue = inputs[paramName] !== undefined;
        const hasDefault = paramDef.default !== undefined;

        if (isRequired && !hasValue && !hasDefault) {
          return {
            success: false,
            message: `Missing required parameter '${paramName}' for procedure '${procedureId}'.`
          };
        }

        if (hasValue && paramDef.type) {
          const val = inputs[paramName];
          if (paramDef.type === 'number' && typeof val !== 'number') {
            return {
              success: false,
              message: `Parameter '${paramName}' must be of type 'number', received '${typeof val}'.`
            };
          }
          if (paramDef.type === 'string' && typeof val !== 'string') {
            return {
              success: false,
              message: `Parameter '${paramName}' must be of type 'string', received '${typeof val}'.`
            };
          }
          if (paramDef.type === 'boolean' && typeof val !== 'boolean') {
            return {
              success: false,
              message: `Parameter '${paramName}' must be of type 'boolean', received '${typeof val}'.`
            };
          }
        }
      }
    }
  }

  // Valider : Effectuer la validation sémantique stricte via le registre
  const validation = validateProcedure(procedure, registry);
  if (!validation.valid) {
    return {
      success: false,
      message: `Validation failed for procedure '${procedureId}': ${validation.errors.join('; ')}`
    };
  }

  // Exécuter : Déléguer l'exécution séquentielle au runner
  let runnerResult;
  try {
    runnerResult = await executeProcedure(bot, procedure, {
      inputs,
      actionRegistry: registry,
      timeoutMs: options.timeoutMs,
      abortSignal: options.abortSignal,
      skipPreconditions: options.skipPreconditions,
      skipPostconditions: options.skipPostconditions
    });
  } catch (err) {
    return {
      success: false,
      message: `Procedure '${procedureId}' encountered unexpected error: ${err.message}`
    };
  }

  // Enregistrer : Mettre à jour les statistiques de réussite dans la mémoire
  if (typeof memory.recordExecution === 'function') {
    try {
      await memory.recordExecution(procedureId, runnerResult.success);
    } catch {
      // Ignorer : Tolérer les erreurs de persistance secondaire
    }
  }

  // Convertir : Retourner le résultat au format attendu par le dispatcher
  if (runnerResult.success) {
    return {
      success: true,
      message: `Procedure '${procedureId}' completed successfully.`
    };
  }

  const failReason = runnerResult.error || runnerResult.reason || 'Procedure execution failed';
  return {
    success: false,
    message: `Procedure '${procedureId}' failed: ${failReason}`
  };
}

/**
 * Route an AI-decided action to its corresponding execution skill
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} action Type of action to execute
 * @param {string|object} target Action target
 * @param {number|object} [qty] Requested quantity
 * @param {object} [options={}] Additional execution options
 * @returns {Promise<{ success: boolean, message: string }>} Execution result
 */
async function dispatchSkill(bot, state, action, target, qty, options = {}) {
  if (action === 'unstuck') return skillUnstuck(bot);
  if (action === 'explore') return skillExplore(bot);
  if (action === 'wiki') return skillWiki(bot, target);
  if (action === 'mine') return skillMine(bot, state, target, qty);
  if (action === 'craft') return skillCraft(bot, state, target, qty);
  if (action === 'place') return skillPlace(bot, state, target);
  if (action === 'smelt') return skillSmelt(bot, state, target, qty);
  if (action === 'eat') return skillEat(bot, target);
  if (action === 'hunt') return skillHunt(bot, target);
  if (action === 'fight') return skillFight(bot, target);
  if (action === 'chest') return skillChest(bot, state);
  if (action === 'equip') return skillEquip(bot, target);
  if (action === 'portal') return skillPortal(bot);
  if (action === 'procedure') return skillProcedure(bot, state, target, qty, options);
  return { success: false, message: `Unknown action '${action}'.` };
}

module.exports = {
  dispatchSkill,
  skillProcedure,
  defaultActionRegistry,
  defaultProcedureMemory
};
