const { createResult } = require('../actions/primitives/result');
const { IDENTIFIER_REGEX } = require('./schema');
const { createDefaultRegistry } = require('./registry');
const { validateProcedure } = require('./validator');
const { saveProcedure, loadProcedure, listProcedures } = require('./store');

const STATUS_WEIGHTS = Object.freeze({
  validated: 2,
  experimental: 1,
  deprecated: 0
});

/**
 * Normaliser une chaîne brute en identifiant conforme au schéma DSL
 * @param {string} rawId Identifiant brut proposé
 * @returns {string} Identifiant normalisé valide
 */
function sanitizeProcedureId(rawId) {
  const cleaned = String(rawId || 'experimental_proc')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return cleaned.length > 0 ? cleaned : 'experimental_proc';
}

/**
 * Générer un identifiant de procédure unique garanti sans collision avec un ensemble d'identifiants existants
 * @param {string} baseId Identifiant de base souhaité
 * @param {Set<string>|Array<string>} [existingIds=[]] Identifiants déjà occupés
 * @returns {string} Identifiant unique conforme à IDENTIFIER_REGEX
 */
function generateUniqueProcedureId(baseId, existingIds = []) {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const cleanBase = sanitizeProcedureId(baseId);

  if (IDENTIFIER_REGEX.test(cleanBase) && !taken.has(cleanBase)) {
    return cleanBase;
  }

  let counter = 1;
  while (counter < 10000) {
    const suffix = `_exp_${counter}`;
    const prefixMaxLen = 64 - suffix.length;
    const candidate = `${cleanBase.slice(0, prefixMaxLen)}${suffix}`;
    if (!taken.has(candidate) && IDENTIFIER_REGEX.test(candidate)) {
      return candidate;
    }
    counter++;
  }

  const timestampSuffix = `_${Date.now().toString(36)}`;
  return `${cleanBase.slice(0, 64 - timestampSuffix.length)}${timestampSuffix}`;
}

/**
 * Mettre à jour les statistiques d'exécution d'une procédure et gérer sa promotion ou rétrogradation
 * @param {object} procedure Objet procédure à mettre à jour
 * @param {boolean} success Indicateur de succès de l'exécution
 * @returns {object} Procédure mise à jour avec ses nouvelles métadonnées et son statut
 */
function updateProcedureStats(procedure, success) {
  if (!procedure || typeof procedure !== 'object') {
    throw new Error('Procedure must be a valid object');
  }

  const metadata = procedure.metadata || {};
  const executionCount = (metadata.executionCount || 0) + 1;
  const successCount = (metadata.successCount || 0) + (success ? 1 : 0);
  const failureCount = (metadata.failureCount || 0) + (success ? 0 : 1);
  const confidenceScore = Number((successCount / executionCount).toFixed(3));
  const updatedAt = new Date().toISOString();

  let nextStatus = procedure.status || 'experimental';

  if (nextStatus === 'experimental') {
    if (executionCount >= 3 && confidenceScore >= 0.75) {
      nextStatus = 'validated';
    }
  } else if (nextStatus === 'validated') {
    if (executionCount >= 5 && confidenceScore < 0.50) {
      nextStatus = 'deprecated';
    }
  }

  return {
    ...procedure,
    status: nextStatus,
    metadata: {
      ...metadata,
      executionCount,
      successCount,
      failureCount,
      confidenceScore,
      updatedAt
    }
  };
}

/**
 * Filtrer et classer les procédures selon leurs tags, leur statut et leur score de confiance
 * @param {Array<object>} procedures Collection de procédures candidates
 * @param {object} [criteria={}] Critères de sélection
 * @param {string[]} [criteria.tags=[]] Tags requis
 * @param {string} [criteria.status] Filtre de statut optionnel
 * @param {number} [criteria.minConfidence=0] Seuil minimal de confiance
 * @returns {object|null} Meilleure procédure correspondante ou null
 */
function selectBestProcedure(procedures, criteria = {}) {
  if (!Array.isArray(procedures) || procedures.length === 0) {
    return null;
  }

  const { tags = [], status, minConfidence = 0 } = criteria;

  const candidates = procedures.filter(proc => {
    if (status && proc.status !== status) {
      return false;
    }

    const confidence = proc.metadata?.confidenceScore !== undefined ? proc.metadata.confidenceScore : 0.5;
    if (confidence < minConfidence) {
      return false;
    }

    if (tags.length > 0) {
      const procTags = new Set(proc.metadata?.tags || []);
      const matchesAll = tags.every(t => procTags.has(t));
      if (!matchesAll) return false;
    }

    return true;
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const weightA = STATUS_WEIGHTS[a.status] !== undefined ? STATUS_WEIGHTS[a.status] : 1;
    const weightB = STATUS_WEIGHTS[b.status] !== undefined ? STATUS_WEIGHTS[b.status] : 1;
    if (weightA !== weightB) {
      return weightB - weightA;
    }

    const confA = a.metadata?.confidenceScore !== undefined ? a.metadata.confidenceScore : 0.5;
    const confB = b.metadata?.confidenceScore !== undefined ? b.metadata.confidenceScore : 0.5;
    if (confA !== confB) {
      return confB - confA;
    }

    const execA = a.metadata?.executionCount || 0;
    const execB = b.metadata?.executionCount || 0;
    return execB - execA;
  });

  return candidates[0];
}

/**
 * Valider, attribuer un identifiant unique, enregistrer en mémoire et persister une procédure expérimentale
 * @param {ProcedureMemory} memory Instance de ProcedureMemory cible
 * @param {object} candidateProcedure Procédure candidate générée
 * @param {object} [options={}] Options d'enregistrement sécurisé
 * @param {object} [options.registry=null] ActionRegistry utilisé pour la validation sémantique
 * @param {string} [options.storageDir=null] Répertoire de persistance sur disque
 * @param {object} [options.generationMetadata=null] Métadonnées issues du générateur
 * @param {object} [options.validationOptions={}] Options supplémentaires pour validateProcedure
 * @param {boolean} [options.rejectOnValidatedCollision=false] Rejeter au lieu de renommer si l'ID appartient à une procédure validée
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat de l'enregistrement
 */
async function registerExperimentalProcedure(memory, candidateProcedure, options = {}) {
  if (!memory || typeof memory.get !== 'function') {
    return createResult(false, 'invalid_memory', null, 'Valid ProcedureMemory instance is required');
  }

  if (!candidateProcedure || typeof candidateProcedure !== 'object') {
    return createResult(false, 'invalid_procedure', null, 'Candidate procedure must be a valid object');
  }

  const registry = options.registry || createDefaultRegistry();
  const targetStorageDir = options.storageDir || memory.storageDir || null;

  const existingInMem = candidateProcedure.id ? memory.get(candidateProcedure.id) : null;
  if (existingInMem && existingInMem.status === 'validated' && options.rejectOnValidatedCollision) {
    return createResult(
      false,
      'validated_overwrite_forbidden',
      { id: candidateProcedure.id, existingProcedure: existingInMem },
      `Cannot overwrite existing validated procedure '${candidateProcedure.id}'`
    );
  }

  const existingIds = new Set(memory.getAll().map(p => p.id));

  if (targetStorageDir) {
    const diskList = await listProcedures(targetStorageDir);
    if (diskList.success && Array.isArray(diskList.data?.procedures)) {
      for (const diskProc of diskList.data.procedures) {
        existingIds.add(diskProc.id);
        if (
          diskProc.id === candidateProcedure.id &&
          diskProc.status === 'validated' &&
          options.rejectOnValidatedCollision
        ) {
          return createResult(
            false,
            'validated_overwrite_forbidden',
            { id: candidateProcedure.id, existingProcedure: diskProc },
            `Cannot overwrite existing validated procedure '${candidateProcedure.id}' on disk`
          );
        }
      }
    } else if (candidateProcedure.id) {
      const diskLoaded = await loadProcedure(candidateProcedure.id, targetStorageDir);
      if (diskLoaded.success && diskLoaded.data?.procedure) {
        existingIds.add(candidateProcedure.id);
      }
    }
  }

  const uniqueId = generateUniqueProcedureId(
    candidateProcedure.id || candidateProcedure.name || 'experimental_proc',
    existingIds
  );

  const now = new Date().toISOString();
  const baseMetadata = candidateProcedure.metadata || {};

  const preparedProcedure = {
    ...candidateProcedure,
    id: uniqueId,
    version: Number.isInteger(candidateProcedure.version) && candidateProcedure.version >= 1
      ? candidateProcedure.version
      : 1,
    status: 'experimental'
  };

  const validation = validateProcedure(preparedProcedure, registry, options.validationOptions || {});
  if (!validation.valid) {
    return createResult(
      false,
      'validation_failed',
      {
        errors: validation.errors,
        warnings: validation.warnings,
        analysis: validation.analysis
      },
      `Semantic validation failed: ${validation.errors.join('; ')}`
    );
  }

  const finalProcedure = {
    ...preparedProcedure,
    status: 'experimental',
    metadata: {
      author: baseMetadata.author || 'ollama_generator',
      createdAt: baseMetadata.createdAt || now,
      updatedAt: now,
      executionCount: 0,
      successCount: 0,
      failureCount: 0,
      confidenceScore: baseMetadata.confidenceScore !== undefined ? baseMetadata.confidenceScore : 0.5,
      tags: Array.isArray(baseMetadata.tags) ? [...baseMetadata.tags] : [],
      generationMetadata: options.generationMetadata || baseMetadata.generationMetadata || null,
      validationMetadata: {
        valid: true,
        validatedAt: now,
        analysis: validation.analysis,
        warningsCount: validation.warnings.length
      }
    }
  };

  let persistedPath = null;
  if (targetStorageDir) {
    const saveRes = await saveProcedure(finalProcedure, targetStorageDir, {
      preventOverwrite: true,
      allowOverwriteValidated: false
    });
    if (!saveRes.success) {
      return createResult(
        false,
        saveRes.reason || 'storage_error',
        saveRes.data,
        saveRes.error || 'Failed to persist experimental procedure to storage'
      );
    }
    persistedPath = saveRes.data?.path || null;
  }

  memory.register(finalProcedure);

  return createResult(true, 'registered', {
    id: finalProcedure.id,
    originalId: candidateProcedure.id || null,
    renamed: finalProcedure.id !== candidateProcedure.id,
    procedure: finalProcedure,
    path: persistedPath,
    validation: {
      valid: true,
      analysis: validation.analysis,
      warnings: validation.warnings
    }
  }, null);
}

/**
 * Registre en mémoire et gestionnaire de cycle de vie des procédures autonomes
 */
class ProcedureMemory {
  /**
   * Initialiser le gestionnaire de mémoire procédurale
   * @param {object} [options={}] Options de configuration
   * @param {string} [options.storageDir=null] Répertoire optionnel pour la persistance sur disque
   */
  constructor(options = {}) {
    this.storageDir = options.storageDir || null;
    this.procedures = new Map();
  }

  /**
   * Enregistrer une procédure en mémoire tout en protégeant les procédures validées contre l'écrasement expérimental
   * @param {object} procedure Objet procédure à enregistrer
   * @param {object} [options={}] Options d'enregistrement
   * @param {boolean} [options.allowOverwriteValidated=false] Autoriser explicitement le remplacement d'une procédure validée
   */
  register(procedure, options = {}) {
    if (!procedure?.id) {
      throw new Error("Procedure must provide an 'id'");
    }

    const existing = this.procedures.get(procedure.id);
    if (
      existing &&
      existing.status === 'validated' &&
      procedure.status === 'experimental' &&
      options.allowOverwriteValidated !== true
    ) {
      throw new Error(`Cannot overwrite validated procedure '${procedure.id}' with an experimental procedure`);
    }

    this.procedures.set(procedure.id, procedure);
  }

  /**
   * Enregistrer de manière sécurisée une nouvelle procédure générée avec statut expérimental et persistance
   * @param {object} candidateProcedure Procédure candidate
   * @param {object} [options={}] Options de validation et de stockage
   * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat de l'enregistrement
   */
  async registerExperimental(candidateProcedure, options = {}) {
    return await registerExperimentalProcedure(this, candidateProcedure, options);
  }

  /**
   * Récupérer une procédure par son identifiant
   * @param {string} id Identifiant de la procédure
   * @returns {object|null} Procédure trouvée ou null
   */
  get(id) {
    return this.procedures.get(id) || null;
  }

  /**
   * Vérifier si un identifiant de procédure existe déjà en mémoire
   * @param {string} id Identifiant de la procédure
   * @returns {boolean} Vrai si présente
   */
  has(id) {
    return this.procedures.has(id);
  }

  /**
   * Récupérer toutes les procédures enregistrées en mémoire
   * @returns {Array<object>} Tableau des procédures
   */
  getAll() {
    return Array.from(this.procedures.values());
  }

  /**
   * Sélectionner la meilleure procédure correspondant aux critères demandés
   * @param {object} criteria Critères de filtrage
   * @returns {object|null} Meilleure procédure ou null
   */
  selectBest(criteria) {
    return selectBestProcedure(this.getAll(), criteria);
  }

  /**
   * Enregistrer le résultat d'une exécution, mettre à jour les statistiques et persister sur disque si configuré
   * @param {string} procedureId Identifiant de la procédure
   * @param {boolean} success Indicateur de réussite
   * @returns {Promise<object|null>} Procédure mise à jour ou null
   */
  async recordExecution(procedureId, success) {
    const procedure = this.get(procedureId);
    if (!procedure) return null;

    const updated = updateProcedureStats(procedure, success);
    this.procedures.set(procedureId, updated);

    if (this.storageDir) {
      await saveProcedure(updated, this.storageDir, { allowOverwriteValidated: true });
    }

    return updated;
  }

  /**
   * Charger et mettre en cache toutes les procédures depuis le répertoire de stockage
   * @param {string} [storageDir=null] Répertoire de stockage
   * @returns {Promise<number>} Nombre de procédures chargées
   */
  async loadAll(storageDir = null) {
    const targetDir = storageDir || this.storageDir;
    if (!targetDir) {
      throw new Error('No storage directory specified for loading procedures');
    }

    const listResult = await listProcedures(targetDir);
    if (!listResult.success || !listResult.data?.procedures) {
      return 0;
    }

    for (const proc of listResult.data.procedures) {
      this.register(proc, { allowOverwriteValidated: true });
    }

    return listResult.data.procedures.length;
  }
}

module.exports = {
  STATUS_WEIGHTS,
  sanitizeProcedureId,
  generateUniqueProcedureId,
  updateProcedureStats,
  selectBestProcedure,
  registerExperimentalProcedure,
  ProcedureMemory
};
