const { saveProcedure, listProcedures } = require('./store');

const STATUS_WEIGHTS = Object.freeze({
  validated: 2,
  experimental: 1,
  deprecated: 0
});

/**
 * Update procedure execution statistics and handle lifecycle promotion/demotion
 * @param {object} procedure Procedure object to update
 * @param {boolean} success Whether the procedure execution succeeded
 * @returns {object} Updated procedure object with updated metadata and status
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
 * Filter and rank procedures according to tags, status, and confidence score
 * @param {Array<object>} procedures Collection of candidate procedures
 * @param {object} [criteria={}] Search criteria
 * @param {string[]} [criteria.tags=[]] Required matching tags
 * @param {string} [criteria.status] Desired status filter
 * @param {number} [criteria.minConfidence=0] Minimum confidence threshold
 * @returns {object|null} Highest ranked procedure matching criteria
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
 * In-memory registry and lifecycle tracker for autonomous procedures
 */
class ProcedureMemory {
  /**
   * Initialize in-memory procedure store
   * @param {object} [options={}] Memory options
   * @param {string} [options.storageDir=null] Optional directory path for disk persistence
   */
  constructor(options = {}) {
    this.storageDir = options.storageDir || null;
    this.procedures = new Map();
  }

  /**
   * Register or overwrite a procedure in memory
   * @param {object} procedure Validated procedure object
   */
  register(procedure) {
    if (!procedure?.id) {
      throw new Error("Procedure must provide an 'id'");
    }
    this.procedures.set(procedure.id, procedure);
  }

  /**
   * Retrieve procedure by identifier
   * @param {string} id Procedure identifier
   * @returns {object|null}
   */
  get(id) {
    return this.procedures.get(id) || null;
  }

  /**
   * Retrieve all registered procedures
   * @returns {Array<object>}
   */
  getAll() {
    return Array.from(this.procedures.values());
  }

  /**
   * Search best matching procedure for requested criteria
   * @param {object} criteria Filter criteria
   * @returns {object|null}
   */
  selectBest(criteria) {
    return selectBestProcedure(this.getAll(), criteria);
  }

  /**
   * Record execution result, update statistics, and persist to storage if configured
   * @param {string} procedureId Procedure identifier
   * @param {boolean} success Execution success indicator
   * @returns {Promise<object|null>} Updated procedure or null if not found
   */
  async recordExecution(procedureId, success) {
    const procedure = this.get(procedureId);
    if (!procedure) return null;

    const updated = updateProcedureStats(procedure, success);
    this.procedures.set(procedureId, updated);

    if (this.storageDir) {
      await saveProcedure(updated, this.storageDir);
    }

    return updated;
  }

  /**
   * Load and cache all procedures from storage directory
   * @param {string} [storageDir=null] Storage directory path override
   * @returns {Promise<number>} Number of loaded procedures
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
      this.register(proc);
    }

    return listResult.data.procedures.length;
  }
}

module.exports = {
  STATUS_WEIGHTS,
  updateProcedureStats,
  selectBestProcedure,
  ProcedureMemory
};
