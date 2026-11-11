/**
 * Format standardized primitive execution result
 * @param {boolean} success Operational success indicator
 * @param {string} reason Stable machine-readable status reason
 * @param {object|null} [data=null] World-verified payload data
 * @param {string|null} [error=null] Technical error description
 * @returns {{ success: boolean, reason: string, data: object|null, error: string|null }}
 */
function createResult(success, reason, data = null, error = null) {
  return {
    success: Boolean(success),
    reason: String(reason),
    data: data ? { ...data } : null,
    error: error ? String(error) : null
  };
}

module.exports = {
  createResult
};
