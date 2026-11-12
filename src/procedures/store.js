const fs = require('node:fs/promises');
const path = require('node:path');
const { createResult } = require('../actions/primitives/result');
const { validateProcedureSchema } = require('./schema');

const DEFAULT_STORAGE_DIR = path.resolve(process.cwd(), 'data/procedures');

/**
 * Resolve full path for a procedure JSON file
 * @param {string} procedureId Identifier of the procedure
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Directory hosting procedure files
 * @returns {string} Absolute file path
 */
function getProcedurePath(procedureId, storageDir = DEFAULT_STORAGE_DIR) {
  return path.join(storageDir, `${procedureId}.json`);
}

/**
 * Persist a procedure definition object to disk as formatted JSON
 * @param {object} procedure Procedure object to save
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Target storage directory
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
 */
async function saveProcedure(procedure, storageDir = DEFAULT_STORAGE_DIR) {
  const schemaValidation = validateProcedureSchema(procedure);
  if (!schemaValidation.valid) {
    return createResult(false, 'invalid_schema', { errors: schemaValidation.errors }, 'Cannot save invalid procedure');
  }

  try {
    await fs.mkdir(storageDir, { recursive: true });
    const targetPath = getProcedurePath(procedure.id, storageDir);
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
 * Load and validate a procedure definition from disk by identifier
 * @param {string} procedureId Identifier of procedure to load
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Source storage directory
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
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
 * Enumerate and load all valid procedures stored in a directory
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Source storage directory
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
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
 * Remove a procedure file from disk
 * @param {string} procedureId Identifier of procedure to delete
 * @param {string} [storageDir=DEFAULT_STORAGE_DIR] Target storage directory
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>}
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
