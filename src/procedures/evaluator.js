const { createResult } = require('../actions/primitives/result');
const { resolveDynamicValues } = require('./schema');

/**
 * Compare two values using a relational or equality operator
 * @param {any} actual Actual evaluated value
 * @param {any} expected Target expected value
 * @param {string} [operator='gte'] Comparison operator ('eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'has')
 * @returns {boolean} True if condition is met
 */
function compareValues(actual, expected, operator = 'gte') {
  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'not_eq':
      return actual !== expected;
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
    case 'has':
      return Number(actual) >= Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    default:
      return actual === expected;
  }
}

/**
 * Count total units of an item across bot inventory slots
 * @param {object} bot Mineflayer bot instance
 * @param {string} itemName Canonical item identifier
 * @returns {number} Total matching items in inventory
 */
function getInventoryItemCount(bot, itemName) {
  if (!bot || !bot.inventory) return 0;
  const items = typeof bot.inventory.items === 'function'
    ? bot.inventory.items()
    : (Array.isArray(bot.inventory.items) ? bot.inventory.items : []);

  let count = 0;
  for (const item of items) {
    if (item && (item.name === itemName || String(item.type) === String(itemName))) {
      count += (typeof item.count === 'number' ? item.count : 1);
    }
  }
  return count;
}

/**
 * Compute Euclidean distance between two 3D positions
 * @param {object} pos1 First coordinates object
 * @param {object} pos2 Second coordinates object
 * @returns {number} Euclidean distance
 */
function getDistance(pos1, pos2) {
  if (!pos1 || !pos2) return Infinity;
  const dx = (pos1.x ?? 0) - (pos2.x ?? 0);
  const dy = (pos1.y ?? 0) - (pos2.y ?? 0);
  const dz = (pos1.z ?? 0) - (pos2.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

/**
 * Evaluate single inventory item count assertion
 * @param {object} bot Mineflayer bot instance
 * @param {object} assertion Assertion parameters
 * @returns {{ passed: boolean, actual: number, expected: number, operator: string, message?: string }}
 */
function evaluateInventoryItem(bot, assertion) {
  const itemName = assertion.item || assertion.itemName;
  const expectedCount = assertion.count !== undefined ? assertion.count : (assertion.expected !== undefined ? assertion.expected : 1);
  const operator = assertion.operator || 'gte';
  const actualCount = getInventoryItemCount(bot, itemName);
  const passed = compareValues(actualCount, expectedCount, operator);

  return {
    passed,
    actual: actualCount,
    expected: expectedCount,
    operator,
    message: passed ? null : `Expected inventory '${itemName}' ${operator} ${expectedCount}, but found ${actualCount}`
  };
}

/**
 * Evaluate block state assertion at coordinates
 * @param {object} bot Mineflayer bot instance
 * @param {object} assertion Assertion parameters
 * @returns {{ passed: boolean, actual: string, expected: string, operator: string, message?: string }}
 */
function evaluateBlockState(bot, assertion) {
  const position = assertion.position;
  const expectedBlock = assertion.block || assertion.blockName || assertion.expected;
  const operator = assertion.operator || 'eq';

  const block = typeof bot.blockAt === 'function' ? bot.blockAt(position) : null;
  const actualBlock = block ? block.name : 'air';

  let passed = false;
  if (Array.isArray(expectedBlock)) {
    passed = expectedBlock.includes(actualBlock);
  } else {
    passed = compareValues(actualBlock, expectedBlock, operator);
  }

  return {
    passed,
    actual: actualBlock,
    expected: expectedBlock,
    operator,
    message: passed ? null : `Expected block at (${position?.x},${position?.y},${position?.z}) ${operator} '${expectedBlock}', but found '${actualBlock}'`
  };
}

/**
 * Evaluate bot health assertion
 * @param {object} bot Mineflayer bot instance
 * @param {object} assertion Assertion parameters
 * @returns {{ passed: boolean, actual: number, expected: number, operator: string, message?: string }}
 */
function evaluateBotHealth(bot, assertion) {
  const expected = assertion.value !== undefined ? assertion.value : (assertion.expected !== undefined ? assertion.expected : 1);
  const operator = assertion.operator || 'gte';
  const actual = bot?.health ?? 0;
  const passed = compareValues(actual, expected, operator);

  return {
    passed,
    actual,
    expected,
    operator,
    message: passed ? null : `Expected bot health ${operator} ${expected}, but found ${actual}`
  };
}

/**
 * Evaluate bot hunger level assertion
 * @param {object} bot Mineflayer bot instance
 * @param {object} assertion Assertion parameters
 * @returns {{ passed: boolean, actual: number, expected: number, operator: string, message?: string }}
 */
function evaluateBotFood(bot, assertion) {
  const expected = assertion.value !== undefined ? assertion.value : (assertion.expected !== undefined ? assertion.expected : 1);
  const operator = assertion.operator || 'gte';
  const actual = bot?.food ?? 0;
  const passed = compareValues(actual, expected, operator);

  return {
    passed,
    actual,
    expected,
    operator,
    message: passed ? null : `Expected bot food ${operator} ${expected}, but found ${actual}`
  };
}

/**
 * Evaluate proximity between bot and target location
 * @param {object} bot Mineflayer bot instance
 * @param {object} assertion Assertion parameters
 * @returns {{ passed: boolean, actual: number, expected: number, message?: string }}
 */
function evaluateBotPosition(bot, assertion) {
  const targetPos = assertion.position;
  const maxDistance = assertion.maxDistance !== undefined ? assertion.maxDistance : 3;
  const botPos = bot?.entity?.position || { x: 0, y: 0, z: 0 };
  const actualDistance = getDistance(botPos, targetPos);
  const passed = actualDistance <= maxDistance;

  return {
    passed,
    actual: actualDistance,
    expected: maxDistance,
    message: passed ? null : `Expected bot distance <= ${maxDistance} from target, but distance is ${actualDistance.toFixed(2)}`
  };
}

/**
 * Evaluate single assertion against bot state
 * @param {object} bot Mineflayer bot instance
 * @param {object} assertion Assertion definition
 * @param {object} [context={}] Execution context for dynamic variable resolution
 * @returns {Promise<{ passed: boolean, type: string, actual: any, expected: any, message: string|null }>}
 */
async function evaluateAssertion(bot, assertion, context = {}) {
  const resolved = context ? resolveDynamicValues(assertion, context) : assertion;
  const type = resolved.type;

  let outcome;
  switch (type) {
    case 'inventory_item':
      outcome = evaluateInventoryItem(bot, resolved);
      break;
    case 'block_state':
      outcome = evaluateBlockState(bot, resolved);
      break;
    case 'bot_health':
      outcome = evaluateBotHealth(bot, resolved);
      break;
    case 'bot_food':
      outcome = evaluateBotFood(bot, resolved);
      break;
    case 'bot_position':
      outcome = evaluateBotPosition(bot, resolved);
      break;
    case 'custom':
      if (typeof resolved.fn === 'function') {
        const customRes = await resolved.fn(bot, context);
        outcome = {
          passed: Boolean(customRes),
          actual: customRes,
          expected: true,
          message: customRes ? null : (resolved.description || 'Custom predicate assertion failed')
        };
      } else {
        outcome = {
          passed: false,
          actual: null,
          expected: null,
          message: "Custom assertion missing executable 'fn' property"
        };
      }
      break;
    default:
      outcome = {
        passed: false,
        actual: null,
        expected: null,
        message: `Unknown assertion type '${type}'`
      };
      break;
  }

  return {
    passed: outcome.passed,
    type,
    assertion: resolved,
    actual: outcome.actual,
    expected: outcome.expected,
    message: outcome.message
  };
}

/**
 * Evaluate an array of precondition assertions before executing a procedure
 * @param {object} bot Mineflayer bot instance
 * @param {Array<object>} preconditions Precondition definitions
 * @param {object} [context={}] Execution context
 * @returns {Promise<{ success: boolean, reason: string, data: object, error: string|null }>}
 */
async function evaluatePreconditions(bot, preconditions, context = {}) {
  if (!Array.isArray(preconditions) || preconditions.length === 0) {
    return createResult(true, 'preconditions_met', { passed: [], total: 0 }, null);
  }

  const passed = [];
  const failed = [];

  for (const assertion of preconditions) {
    const outcome = await evaluateAssertion(bot, assertion, context);
    if (outcome.passed) {
      passed.push(outcome);
    } else {
      failed.push(outcome);
    }
  }

  if (failed.length > 0) {
    const errorDetails = failed.map(f => f.message).join('; ');
    return createResult(false, 'preconditions_failed', {
      passed,
      failed,
      total: preconditions.length
    }, `Preconditions failed: ${errorDetails}`);
  }

  return createResult(true, 'preconditions_met', {
    passed,
    total: preconditions.length
  }, null);
}

/**
 * Evaluate an array of postcondition assertions after executing procedure steps
 * @param {object} bot Mineflayer bot instance
 * @param {Array<object>} postconditions Postcondition definitions
 * @param {object} [context={}] Execution context
 * @returns {Promise<{ success: boolean, reason: string, data: object, error: string|null }>}
 */
async function evaluatePostconditions(bot, postconditions, context = {}) {
  if (!Array.isArray(postconditions) || postconditions.length === 0) {
    return createResult(true, 'postconditions_met', { passed: [], total: 0 }, null);
  }

  const passed = [];
  const failed = [];

  for (const assertion of postconditions) {
    const outcome = await evaluateAssertion(bot, assertion, context);
    if (outcome.passed) {
      passed.push(outcome);
    } else {
      failed.push(outcome);
    }
  }

  if (failed.length > 0) {
    const errorDetails = failed.map(f => f.message).join('; ');
    return createResult(false, 'postconditions_failed', {
      passed,
      failed,
      total: postconditions.length
    }, `Postconditions failed: ${errorDetails}`);
  }

  return createResult(true, 'postconditions_met', {
    passed,
    total: postconditions.length
  }, null);
}

module.exports = {
  compareValues,
  getInventoryItemCount,
  getDistance,
  evaluateAssertion,
  evaluatePreconditions,
  evaluatePostconditions
};
