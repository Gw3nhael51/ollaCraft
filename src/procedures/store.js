const fs = require('node:fs/promises');
const path = require('node:path');
const { createResult } = require('../actions/primitives/result');
const { validateProcedureSchema } = require('./schema');

const DEFAULT_STORAGE_DIR = path.resolve(process.cwd(), 'data/procedures');

/**
 * Résoudre le chemin complet du fichier JSON d'une procédure
 * @param {string} procedureId Identifiant de la procédure
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Répertoire de stockage
 * @returns {string} Chemin absolu du fichier
 */
function getProcedurePath(procedureId, storageDir = DEFAULT_STORAGE_DIR) {
  return path.join(storageDir, `${procedureId}.json`);
}

/**
 * Persister une définition de procédure sur disque au format JSON avec protection des procédures validées
 * @param {object} procedure Objet procédure à sauvegarder
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Répertoire cible
 * @param {object} [options={}] Options de sauvegarde et de protection
 * @param {boolean} [options.preventOverwrite=false] Interdire tout écrasement d'un fichier existant
 * @param {boolean} [options.allowOverwriteValidated=false] Autoriser explicitement le remplacement d'une procédure validée
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat de sauvegarde
 */
async function saveProcedure(procedure, storageDir = DEFAULT_STORAGE_DIR, options = {}) {
  const schemaValidation = validateProcedureSchema(procedure);
  if (!schemaValidation.valid) {
    return createResult(false, 'invalid_schema', { errors: schemaValidation.errors }, 'Cannot save invalid procedure');
  }

  try {
    await fs.mkdir(storageDir, { recursive: true });
    const targetPath = getProcedurePath(procedure.id, storageDir);

    try {
      const existingRaw = await fs.readFile(targetPath, 'utf8');
      if (options.preventOverwrite) {
        return createResult(
          false,
          'already_exists',
          { id: procedure.id, path: targetPath },
          `Procedure '${procedure.id}' already exists in storage`
        );
      }

      const existingParsed = JSON.parse(existingRaw);
      if (
        existingParsed &&
        existingParsed.status === 'validated' &&
        procedure.status === 'experimental' &&
        options.allowOverwriteValidated !== true
      ) {
        return createResult(
          false,
          'validated_overwrite_forbidden',
          { id: procedure.id, path: targetPath, existingStatus: existingParsed.status },
          `Cannot overwrite validated procedure '${procedure.id}' with an experimental procedure`
        );
      }
    } catch {
    }

    const content = JSON.stringify(procedure, null, 2);
    await fs.writeFile(targetPath, content, 'utf8');

    return createResult(true, 'saved', {
      id: procedure.id,
      path: targetPath,
      procedure
    }, null);
  } catch (err) {
    return createResult(false, 'storage_error', null, String(err?.message || err));
  }
}

/**
 * Charger et valider une procédure depuis le disque par son identifiant
 * @param {string} procedureId Identifiant de la procédure à charger
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Répertoire source
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat de chargement
 */
async function loadProcedure(procedureId, storageDir = DEFAULT_STORAGE_DIR) {
  const targetPath = getProcedurePath(procedureId, storageDir);

  try {
    const rawContent = await fs.readFile(targetPath, 'utf8');
    const parsed = JSON.parse(rawContent);

    const schemaValidation = validateProcedureSchema(parsed);
    if (!schemaValidation.valid) {
      return createResult(false, 'invalid_schema', { errors: schemaValidation.errors }, 'Loaded procedure file contains invalid schema');
    }

    return createResult(true, 'loaded', {
      id: procedureId,
      path: targetPath,
      procedure: parsed
    }, null);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return createResult(false, 'not_found', { id: procedureId }, `Procedure '${procedureId}' was not found`);
    }
    return createResult(false, 'read_error', null, String(err?.message || err));
  }
}

/**
 * Énumérer et charger toutes les procédures valides stockées dans un répertoire
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Répertoire source
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Liste des procédures
 */
async function listProcedures(storageDir = DEFAULT_STORAGE_DIR) {
  try {
    await fs.mkdir(storageDir, { recursive: true });
    const files = await fs.readdir(storageDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    const procedures = [];
    const skipped = [];

    for (const file of jsonFiles) {
      const procedureId = path.basename(file, '.json');
      const loaded = await loadProcedure(procedureId, storageDir);
      if (loaded.success && loaded.data?.procedure) {
        procedures.push(loaded.data.procedure);
      } else {
        skipped.push({ file, reason: loaded.reason, error: loaded.error });
      }
    }

    return createResult(true, 'listed', {
      procedures,
      skipped,
      count: procedures.length
    }, null);
  } catch (err) {
    return createResult(false, 'list_error', null, String(err?.message || err));
  }
}

/**
 * Supprimer le fichier d'une procédure sur le disque
 * @param {string} procedureId Identifiant de la procédure à supprimer
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Répertoire cible
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Résultat de suppression
 */
async function deleteProcedure(procedureId, storageDir = DEFAULT_STORAGE_DIR) {
  const targetPath = getProcedurePath(procedureId, storageDir);

  try {
    await fs.unlink(targetPath);
    return createResult(true, 'deleted', { id: procedureId, path: targetPath }, null);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return createResult(false, 'not_found', { id: procedureId }, `Procedure '${procedureId}' was not found`);
    }
    return createResult(false, 'delete_error', null, String(err?.message || err));
  }
}

module.exports = {
  DEFAULT_STORAGE_DIR,
  getProcedurePath,
  saveProcedure,
  loadProcedure,
  listProcedures,
  deleteProcedure
};
