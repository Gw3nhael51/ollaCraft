const config = require('../infrastructure/config');

const DEFAULT_MAX_GENERATION_ATTEMPTS = 3;
const DEFAULT_GENERATION_COOLDOWN_MS = 60000;

const TRIVIAL_OBJECTIVES = new Set([
  'none',
  'idle',
  'unstuck',
  'explore',
  'look',
  'wander',
  'eat',
  'air'
]);

/**
 * Assess whether an objective is complex enough to require a multi-step autonomous procedure
 * @param {string} objective Target objective identifier or description
 * @returns {boolean} True if the objective qualifies as complex
 */
function isComplexObjective(objective) {
  if (!objective || typeof objective !== 'string') {
    return false;
  }

  const clean = objective.toLowerCase().trim();
  if (clean.length === 0 || TRIVIAL_OBJECTIVES.has(clean)) {
    return false;
  }

  if (Array.isArray(config.QUEST_CHAIN) && config.QUEST_CHAIN.includes(clean)) {
    return true;
  }

  const complexPrefixes = ['craft_', 'mine_', 'smelt_', 'build_', 'obtain_', 'gather_', 'kill_', 'hunt_'];
  if (complexPrefixes.some(prefix => clean.startsWith(prefix))) {
    return true;
  }

  const complexSuffixes = ['_pickaxe', '_sword', '_axe', '_shovel', '_hoe', '_helmet', '_chestplate', '_leggings', '_boots', '_table', '_portal', '_furnace', '_ingot'];
  if (complexSuffixes.some(suffix => clean.endsWith(suffix))) {
    return true;
  }

  return clean.length >= 4;
}

/**
 * Manage generation attempts per objective to prevent cognitive loops and rate-limit LLM prompts
 */
class ObjectiveGenerationTracker {
  /**
   * Initialize objective generation tracker
   * @param {object} [options={}] Tracker configuration options
   * @param {number} [options.maxAttempts=3] Maximum allowed generation attempts per objective
   * @param {number} [options.cooldownMs=60000] Minimum duration required between generation retries
   */
  constructor(options = {}) {
    this.maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
      ? options.maxAttempts
      : DEFAULT_MAX_GENERATION_ATTEMPTS;
    this.cooldownMs = Number.isInteger(options.cooldownMs) && options.cooldownMs >= 0
      ? options.cooldownMs
      : DEFAULT_GENERATION_COOLDOWN_MS;
    this.attempts = new Map();
  }

  /**
   * Retrieve or initialize tracking state record for an objective
   * @param {string} objective Objective identifier
   * @returns {object} Objective tracking entry
   */
  getRecord(objective) {
    const key = String(objective || '').toLowerCase().trim();
    if (!this.attempts.has(key)) {
      this.attempts.set(key, {
        objectiveKey: key,
        generationAttempts: 0,
        maxAttempts: this.maxAttempts,
        lastAttemptAt: null,
        status: 'idle',
        lastFailure: null
      });
    }
    return this.attempts.get(key);
  }

  /**
   * Check whether an objective is eligible for a new generation attempt
   * @param {string} objective Objective identifier
   * @returns {{ allowed: boolean, reason: string }} Authorization decision and reason
   */
  canAttempt(objective) {
    if (!objective || typeof objective !== 'string' || objective.trim().length === 0) {
      return { allowed: false, reason: 'Invalid or empty objective identifier' };
    }

    const record = this.getRecord(objective);

    if (record.status === 'resolved') {
      return { allowed: false, reason: 'Objective is already resolved with validated procedure' };
    }

    if (record.generationAttempts >= this.maxAttempts) {
      return {
        allowed: false,
        reason: `Maximum generation attempts (${this.maxAttempts}) reached for '${record.objectiveKey}'`
      };
    }

    if (record.lastAttemptAt && this.cooldownMs > 0) {
      const elapsed = Date.now() - new Date(record.lastAttemptAt).getTime();
      if (elapsed < this.cooldownMs) {
        const remainingSec = Math.ceil((this.cooldownMs - elapsed) / 1000);
        return {
          allowed: false,
          reason: `Generation attempt in cooldown for '${record.objectiveKey}', wait ${remainingSec}s`
        };
      }
    }

    return { allowed: true, reason: 'Eligible for generation' };
  }

  /**
   * Record a new generation attempt invocation
   * @param {string} objective Objective identifier
   * @returns {object} Updated tracking record
   */
  recordAttempt(objective) {
    const record = this.getRecord(objective);
    record.generationAttempts += 1;
    record.lastAttemptAt = new Date().toISOString();
    record.status = record.generationAttempts >= this.maxAttempts ? 'exhausted' : 'pending';
    return { ...record };
  }

  /**
   * Record a failed generation attempt
   * @param {string} objective Objective identifier
   * @param {string} errorReason Detailed error or rejection reason
   * @returns {object} Updated tracking record
   */
  recordFailure(objective, errorReason) {
    const record = this.getRecord(objective);
    record.lastFailure = String(errorReason || 'Unknown generation failure');
    if (record.generationAttempts >= this.maxAttempts) {
      record.status = 'exhausted';
    }
    return { ...record };
  }

  /**
   * Record successful generation and validation of a procedure for this objective
   * @param {string} objective Objective identifier
   * @returns {object} Updated tracking record
   */
  recordSuccess(objective) {
    const record = this.getRecord(objective);
    record.status = 'resolved';
    record.lastFailure = null;
    return { ...record };
  }

  /**
   * Reset tracking status for a specific objective or all objectives
   * @param {string} [objective=null] Specific objective identifier or null for complete reset
   */
  reset(objective = null) {
    if (objective) {
      const key = String(objective).toLowerCase().trim();
      this.attempts.delete(key);
    } else {
      this.attempts.clear();
    }
  }

  /**
   * Export all tracking entries for persistence
   * @returns {Array<object>} Serializable array of tracking records
   */
  exportState() {
    return Array.from(this.attempts.values());
  }

  /**
   * Restore tracking entries from serialized data
   * @param {Array<object>} data Array of tracking records
   */
  importState(data) {
    if (!Array.isArray(data)) return;
    for (const item of data) {
      if (item && item.objectiveKey) {
        this.attempts.set(item.objectiveKey, { ...item });
      }
    }
  }
}

/**
 * Evaluate objective coverage against procedure memory and generation tracker
 * @param {object} memory ProcedureMemory instance
 * @param {string} objective Target objective identifier
 * @param {ObjectiveGenerationTracker} tracker Active generation tracker instance
 * @param {object} [options={}] Additional evaluation options
 * @param {boolean} [options.allowExperimentalReuse=true] Whether an existing experimental procedure should be reused
 * @returns {{
 *   objective: string,
 *   status: 'validated_available'|'experimental_available'|'eligible_for_generation'|'attempts_exhausted'|'in_cooldown'|'trivial_objective'|'invalid_objective',
 *   procedure: object|null,
 *   isReliable: boolean,
 *   canGenerate: boolean,
 *   reason: string,
 *   record: object|null
 * }} Detailed coverage assessment
 */
function evaluateObjectiveCoverage(memory, objective, tracker, options = {}) {
  const allowExperimental = options.allowExperimentalReuse !== false;

  if (!objective || typeof objective !== 'string' || objective.trim().length === 0) {
    return {
      objective: 'none',
      status: 'invalid_objective',
      procedure: null,
      isReliable: false,
      canGenerate: false,
      reason: 'Empty or invalid objective identifier',
      record: null
    };
  }

  const cleanObjective = objective.toLowerCase().trim();

  if (memory && typeof memory.getAll === 'function') {
    const all = memory.getAll();
    const matching = all.filter(proc => {
      if (!proc || proc.status === 'deprecated') return false;
      const tags = Array.isArray(proc.metadata?.tags) ? proc.metadata.tags.map(t => String(t).toLowerCase()) : [];
      const id = String(proc.id || '').toLowerCase();
      const name = String(proc.name || '').toLowerCase();

      return tags.includes(cleanObjective) ||
        id === cleanObjective ||
        id === `obtain_${cleanObjective}` ||
        id === `craft_${cleanObjective}` ||
        id === `mine_${cleanObjective}` ||
        id.includes(cleanObjective) ||
        name.includes(cleanObjective);
    });

    const validated = matching.filter(p => p.status === 'validated');
    if (validated.length > 0) {
      validated.sort((a, b) => {
        const confA = a.metadata?.confidenceScore !== undefined ? a.metadata.confidenceScore : 0.5;
        const confB = b.metadata?.confidenceScore !== undefined ? b.metadata.confidenceScore : 0.5;
        if (confA !== confB) return confB - confA;
        return (b.metadata?.executionCount || 0) - (a.metadata?.executionCount || 0);
      });

      return {
        objective: cleanObjective,
        status: 'validated_available',
        procedure: validated[0],
        isReliable: true,
        canGenerate: false,
        reason: `Validated procedure '${validated[0].id}' already available`,
        record: tracker?.getRecord(cleanObjective) || null
      };
    }

    if (allowExperimental) {
      const experimental = matching.filter(p => p.status === 'experimental');
      if (experimental.length > 0) {
        experimental.sort((a, b) => {
          const confA = a.metadata?.confidenceScore !== undefined ? a.metadata.confidenceScore : 0.5;
          const confB = b.metadata?.confidenceScore !== undefined ? b.metadata.confidenceScore : 0.5;
          return confB - confA;
        });

        return {
          objective: cleanObjective,
          status: 'experimental_available',
          procedure: experimental[0],
          isReliable: false,
          canGenerate: false,
          reason: `Experimental procedure '${experimental[0].id}' available for testing and improvement`,
          record: tracker?.getRecord(cleanObjective) || null
        };
      }
    }
  }

  if (!isComplexObjective(cleanObjective)) {
    return {
      objective: cleanObjective,
      status: 'trivial_objective',
      procedure: null,
      isReliable: false,
      canGenerate: false,
      reason: `Objective '${cleanObjective}' is trivial or non-composite, generation omitted`,
      record: tracker?.getRecord(cleanObjective) || null
    };
  }

  const activeTracker = tracker || new ObjectiveGenerationTracker();
  const attemptDecision = activeTracker.canAttempt(cleanObjective);

  if (!attemptDecision.allowed) {
    const isExhausted = activeTracker.getRecord(cleanObjective).generationAttempts >= activeTracker.maxAttempts;
    return {
      objective: cleanObjective,
      status: isExhausted ? 'attempts_exhausted' : 'in_cooldown',
      procedure: null,
      isReliable: false,
      canGenerate: false,
      reason: attemptDecision.reason,
      record: activeTracker.getRecord(cleanObjective)
    };
  }

  return {
    objective: cleanObjective,
    status: 'eligible_for_generation',
    procedure: null,
    isReliable: false,
    canGenerate: true,
    reason: `Objective '${cleanObjective}' is complex and uncovered, eligible for procedure generation`,
    record: activeTracker.getRecord(cleanObjective)
  };
}

module.exports = {
  DEFAULT_MAX_GENERATION_ATTEMPTS,
  DEFAULT_GENERATION_COOLDOWN_MS,
  TRIVIAL_OBJECTIVES,
  isComplexObjective,
  ObjectiveGenerationTracker,
  evaluateObjectiveCoverage
};
