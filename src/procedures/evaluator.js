const config = require('../infrastructure/config');
const { createResult } = require('../actions/primitives/result');
const { VALID_DESTINATIONS } = require('../actions/primitives/items');
const {
  countItem,
  isQuestDone,
  isWoodLog,
  isPlanks
} = require('../perception/inventory');
const { scanNearbyEntities } = require('../perception/environment');
const { resolveDynamicValues } = require('./schema');

const EVALUATION_STATUSES = Object.freeze([
  'achieved',
  'partially_achieved',
  'not_achieved',
  'inconclusive'
]);

const RESOURCE_SHORTAGE_REASONS = Object.freeze(new Set([
  'missing_item',
  'missing_ingredients',
  'missing_table',
  'preconditions_failed',
  'not_a_container',
  'no_fuel',
  'no_input'
]));

const MINED_BLOCK_TO_DROP = Object.freeze({
  stone: 'cobblestone',
  deepslate: 'cobbled_deepslate',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  gold_ore: 'raw_gold',
  deepslate_gold_ore: 'raw_gold',
  copper_ore: 'raw_copper',
  deepslate_copper_ore: 'raw_copper',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone'
});

/**
 * Comparer deux valeurs selon un opérateur relationnel ou d'égalité
 * @param {any} actual Valeur observée
 * @param {any} expected Valeur attendue
 * @param {string} [operator='gte'] Opérateur de comparaison
 * @returns {boolean} Vrai si la condition est remplie
 */
function compareValues(actual, expected, operator = 'gte') {
  switch (operator) {
    case 'eq':
    case '==':
      return actual === expected;
    case 'not_eq':
    case '!=':
      return actual !== expected;
    case 'gt':
    case '>':
      return Number(actual) > Number(expected);
    case 'gte':
    case '>=':
    case 'has':
      return Number(actual) >= Number(expected);
    case 'lt':
    case '<':
      return Number(actual) < Number(expected);
    case 'lte':
    case '<=':
      return Number(actual) <= Number(expected);
    default:
      return actual === expected;
  }
}

/**
 * Vérifier si la perception de l'inventaire du bot est disponible
 * @param {object} bot Instance du bot Mineflayer
 * @returns {boolean} Vrai si l'inventaire est observable
 */
function isInventoryObservable(bot) {
  if (!bot || !bot.inventory) return false;
  return (
    typeof bot.inventory.items === 'function' ||
    Array.isArray(bot.inventory.items) ||
    Array.isArray(bot.inventory.slots)
  );
}

/**
 * Compter le nombre total d'unités d'un objet dans l'inventaire en réutilisant la perception existante
 * @param {object} bot Instance du bot Mineflayer
 * @param {string|number} itemName Identifiant ou nom canonique de l'objet
 * @returns {number} Quantité totale présente dans l'inventaire
 */
function getInventoryItemCount(bot, itemName) {
  if (!isInventoryObservable(bot) || itemName === undefined || itemName === null) {
    return 0;
  }

  let perceptionCount = 0;
  if (typeof itemName === 'string') {
    perceptionCount = countItem(bot, itemName);
  }

  const items = typeof bot.inventory.items === 'function'
    ? bot.inventory.items()
    : (Array.isArray(bot.inventory.items) ? bot.inventory.items : []);

  let directCount = 0;
  const cleanName = typeof itemName === 'string' ? itemName.toLowerCase().trim() : null;
  for (const item of items) {
    if (!item) continue;
    const matchesDirect = item.name === itemName || String(item.type) === String(itemName);
    const matchesLog = cleanName && isWoodLog(cleanName) && cleanName === 'log' && isWoodLog(item.name);
    const matchesPlank = cleanName && isPlanks(cleanName) && cleanName === 'planks' && isPlanks(item.name);
    if (matchesDirect || matchesLog || matchesPlank) {
      directCount += (typeof item.count === 'number' ? item.count : 1);
    }
  }

  return Math.max(perceptionCount, directCount);
}

/**
 * Calculer la distance euclidienne entre deux positions tridimensionnelles
 * @param {object} posA Première coordonnée
 * @param {object} posB Seconde coordonnée
 * @returns {number} Distance euclidienne
 */
function getDistance(posA, posB) {
  if (!posA || !posB) return Infinity;
  const dx = (posA.x ?? 0) - (posB.x ?? 0);
  const dy = (posA.y ?? 0) - (posB.y ?? 0);
  const dz = (posA.z ?? 0) - (posB.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

/**
 * Résoudre l'index d'emplacement d'inventaire correspondant à une destination d'équipement
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} destination Emplacement cible ('hand', 'head', 'torso', 'legs', 'feet', 'off-hand')
 * @returns {number|null} Index du slot ou null
 */
function resolveEquipmentSlot(bot, destination) {
  if (typeof bot?.getEquipmentDestSlot === 'function') {
    try {
      const slot = bot.getEquipmentDestSlot(destination);
      if (typeof slot === 'number') return slot;
    } catch {
      // Ignorer : Replier sur la correspondance standard des emplacements
    }
  }

  switch (destination) {
    case 'head': return 5;
    case 'torso': return 6;
    case 'legs': return 7;
    case 'feet': return 8;
    case 'off-hand': return 45;
    case 'hand': return bot?.quickBarSlot !== undefined ? 36 + bot.quickBarSlot : 36;
    default: return null;
  }
}

/**
 * Observer l'objet actuellement équipé dans un emplacement spécifique du bot
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} [destination='hand'] Emplacement d'équipement
 * @returns {{ observable: boolean, itemName: string|null }} Observation de l'équipement
 */
function observeEquippedItem(bot, destination = 'hand') {
  if (!bot || typeof bot !== 'object') {
    return { observable: false, itemName: null };
  }

  if (!VALID_DESTINATIONS.includes(destination)) {
    return { observable: false, itemName: null };
  }

  const hasEquipmentSource = Boolean(
    bot.heldItem !== undefined ||
    bot.equipment ||
    Array.isArray(bot.inventory?.slots)
  );

  if (!hasEquipmentSource) {
    return { observable: false, itemName: null };
  }

  if (destination === 'hand' && bot.heldItem !== undefined) {
    return { observable: true, itemName: bot.heldItem ? bot.heldItem.name : null };
  }

  const slotIndex = resolveEquipmentSlot(bot, destination);
  if (slotIndex !== null && Array.isArray(bot.inventory?.slots)) {
    const slotItem = bot.inventory.slots[slotIndex];
    if (slotItem) {
      return { observable: true, itemName: slotItem.name || null };
    }
  }

  if (bot.equipment && Object.prototype.hasOwnProperty.call(bot.equipment, destination)) {
    const eqItem = bot.equipment[destination];
    return { observable: true, itemName: eqItem ? eqItem.name : null };
  }

  return { observable: true, itemName: null };
}

/**
 * Évaluer une assertion portant sur la présence et la quantité d'un objet dans l'inventaire
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Paramètres de l'assertion
 * @returns {{ passed: boolean, status: string, verifiable: boolean, actual: any, expected: any, operator: string, message: string|null }}
 */
function evaluateInventoryItem(bot, assertion) {
  const itemName = assertion.item || assertion.itemName;
  const expectedCount = assertion.count !== undefined ? assertion.count : (assertion.expected !== undefined ? assertion.expected : 1);
  const operator = assertion.operator || 'gte';

  if (typeof itemName !== 'string' || itemName.trim().length === 0) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedCount,
      operator,
      message: "Unverifiable inventory assertion: missing valid 'item' identifier"
    };
  }

  if (!isInventoryObservable(bot)) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedCount,
      operator,
      message: `Inventory observation unavailable for item '${itemName}'`
    };
  }

  const actualCount = getInventoryItemCount(bot, itemName);
  const passed = compareValues(actualCount, expectedCount, operator);

  return {
    passed,
    status: passed ? 'verified' : 'failed',
    verifiable: true,
    actual: actualCount,
    expected: expectedCount,
    operator,
    message: passed ? null : `Expected inventory '${itemName}' ${operator} ${expectedCount}, but found ${actualCount}`
  };
}

/**
 * Évaluer une assertion portant sur l'équipement d'un objet dans un emplacement précis
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Paramètres de l'assertion
 * @returns {{ passed: boolean, status: string, verifiable: boolean, actual: any, expected: any, operator: string, message: string|null }}
 */
function evaluateEquippedItem(bot, assertion) {
  const expectedItem = assertion.item || assertion.itemName || assertion.expected;
  const destination = assertion.destination || assertion.slot || 'hand';
  const operator = assertion.operator || 'eq';

  if (typeof expectedItem !== 'string' || expectedItem.trim().length === 0) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedItem || null,
      operator,
      message: "Unverifiable equipment assertion: missing valid 'item' identifier"
    };
  }

  const observation = observeEquippedItem(bot, destination);
  if (!observation.observable) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedItem,
      operator,
      message: `Equipment observation unavailable for destination '${destination}'`
    };
  }

  const actualItem = observation.itemName;
  const passed = compareValues(actualItem, expectedItem, operator);

  return {
    passed,
    status: passed ? 'verified' : 'failed',
    verifiable: true,
    actual: actualItem,
    expected: expectedItem,
    operator,
    message: passed
      ? null
      : `Expected '${expectedItem}' equipped in '${destination}' (${operator}), but found '${actualItem || 'none'}'`
  };
}

/**
 * Évaluer une assertion portant sur l'état d'un bloc aux coordonnées données dans le monde
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Paramètres de l'assertion
 * @returns {{ passed: boolean, status: string, verifiable: boolean, actual: any, expected: any, operator: string, message: string|null }}
 */
function evaluateBlockState(bot, assertion) {
  const position = assertion.position;
  const expectedBlock = assertion.block || assertion.blockName || assertion.expected;
  const operator = assertion.operator || 'eq';

  if (!position || typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedBlock || null,
      operator,
      message: "Unverifiable block assertion: missing valid 'position' coordinates"
    };
  }

  if (!expectedBlock || (typeof expectedBlock !== 'string' && !Array.isArray(expectedBlock))) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedBlock || null,
      operator,
      message: "Unverifiable block assertion: missing valid expected 'block' name"
    };
  }

  if (!bot || typeof bot.blockAt !== 'function') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedBlock,
      operator,
      message: `World block observation unavailable at (${position.x},${position.y},${position.z})`
    };
  }

  const block = bot.blockAt(position);
  if (!block || typeof block.name !== 'string') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedBlock,
      operator,
      message: `Block state unknown at (${position.x},${position.y},${position.z}): chunk unloaded or block null`
    };
  }

  const actualBlock = block.name;
  const passed = Array.isArray(expectedBlock)
    ? expectedBlock.includes(actualBlock)
    : compareValues(actualBlock, expectedBlock, operator);

  return {
    passed,
    status: passed ? 'verified' : 'failed',
    verifiable: true,
    actual: actualBlock,
    expected: expectedBlock,
    operator,
    message: passed
      ? null
      : `Expected block at (${position.x},${position.y},${position.z}) ${operator} '${expectedBlock}', but found '${actualBlock}'`
  };
}

/**
 * Extraire la liste des objets présents dans un conteneur ouvert ou mémorisé
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} [context={}] Contexte d'exécution
 * @returns {{ observable: boolean, items: Array<object> }} Contenu observé du conteneur
 */
function observeContainerItems(bot, context = {}) {
  const windowObj = bot?.currentWindow || context?.containerWindow || bot?.lastOpenedContainer || null;
  if (!windowObj || typeof windowObj !== 'object') {
    return { observable: false, items: [] };
  }

  if (typeof windowObj.containerItems === 'function') {
    return { observable: true, items: windowObj.containerItems().filter(Boolean) };
  }

  if (typeof windowObj.items === 'function') {
    return { observable: true, items: windowObj.items().filter(Boolean) };
  }

  if (Array.isArray(windowObj.slots)) {
    const containerSlotLimit = typeof windowObj.inventoryStart === 'number'
      ? windowObj.inventoryStart
      : Math.max(0, windowObj.slots.length - 36);
    const items = (containerSlotLimit > 0 ? windowObj.slots.slice(0, containerSlotLimit) : windowObj.slots).filter(Boolean);
    return { observable: true, items };
  }

  return { observable: false, items: [] };
}

/**
 * Évaluer une assertion portant sur le contenu d'un conteneur Minecraft
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Paramètres de l'assertion
 * @param {object} [context={}] Contexte d'exécution
 * @returns {{ passed: boolean, status: string, verifiable: boolean, actual: any, expected: any, operator: string, message: string|null }}
 */
function evaluateContainerItem(bot, assertion, context = {}) {
  const itemName = assertion.item || assertion.itemName;
  const expectedCount = assertion.count !== undefined ? assertion.count : (assertion.expected !== undefined ? assertion.expected : 1);
  const operator = assertion.operator || 'gte';

  if (typeof itemName !== 'string' || itemName.trim().length === 0) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedCount,
      operator,
      message: "Unverifiable container assertion: missing valid 'item' identifier"
    };
  }

  const containerObs = observeContainerItems(bot, context);
  if (!containerObs.observable) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedCount,
      operator,
      message: `Container observation unavailable for item '${itemName}'`
    };
  }

  const actualCount = containerObs.items.reduce((sum, item) => {
    if (item && (item.name === itemName || String(item.type) === String(itemName))) {
      return sum + (typeof item.count === 'number' ? item.count : 1);
    }
    return sum;
  }, 0);

  const passed = compareValues(actualCount, expectedCount, operator);

  return {
    passed,
    status: passed ? 'verified' : 'failed',
    verifiable: true,
    actual: actualCount,
    expected: expectedCount,
    operator,
    message: passed
      ? null
      : `Expected container '${itemName}' ${operator} ${expectedCount}, but found ${actualCount}`
  };
}

/**
 * Évaluer une assertion portant sur l'état ou l'élimination d'une entité dans le monde
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Paramètres de l'assertion
 * @returns {{ passed: boolean, status: string, verifiable: boolean, actual: any, expected: any, operator: string, message: string|null }}
 */
function evaluateEntityState(bot, assertion) {
  const entityId = assertion.entityId !== undefined ? assertion.entityId : assertion.id;
  const entityName = assertion.entity || assertion.entityName || assertion.name || assertion.target;
  const radius = typeof assertion.radius === 'number' ? assertion.radius : (typeof assertion.maxDistance === 'number' ? assertion.maxDistance : 32);
  const expectedState = assertion.type === 'entity_eliminated'
    ? 'eliminated'
    : (assertion.state || (assertion.expected !== undefined ? assertion.expected : 'eliminated'));

  if (entityId === undefined && (typeof entityName !== 'string' || entityName.trim().length === 0)) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedState,
      operator: assertion.operator || 'eq',
      message: "Unverifiable entity assertion: missing 'entityId' or 'entity' name"
    };
  }

  if (!bot || !bot.entities || typeof bot.entities !== 'object') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: expectedState,
      operator: assertion.operator || 'eq',
      message: 'Entity observation unavailable: bot.entities is missing'
    };
  }

  if (entityId !== undefined) {
    const entity = bot.entities[entityId];
    const isAlive = Boolean(
      entity &&
      entity.isValid !== false &&
      (entity.health === undefined || entity.health > 0)
    );
    const actualState = isAlive ? 'alive' : 'eliminated';
    const normalizedExpected = (expectedState === 'dead' || expectedState === 'absent' || expectedState === false)
      ? 'eliminated'
      : (expectedState === 'present' || expectedState === true ? 'alive' : expectedState);
    const passed = actualState === normalizedExpected;

    return {
      passed,
      status: passed ? 'verified' : 'failed',
      verifiable: true,
      actual: actualState,
      expected: normalizedExpected,
      operator: 'eq',
      message: passed
        ? null
        : `Expected entity '${entityId}' state to be '${normalizedExpected}', but observed '${actualState}'`
    };
  }

  const cleanName = entityName.toLowerCase().trim();
  let aliveCount = 0;

  if (bot.entity?.position && typeof bot.entity.position.distanceTo === 'function') {
    const nearbyCounts = scanNearbyEntities(bot, radius);
    aliveCount = nearbyCounts[cleanName] || 0;
  }

  if (aliveCount === 0) {
    for (const id of Object.keys(bot.entities)) {
      const entity = bot.entities[id];
      if (!entity || entity === bot.entity) continue;
      const matchesName = String(entity.name || entity.username || '').toLowerCase() === cleanName;
      if (!matchesName) continue;
      if (entity.isValid === false || (entity.health !== undefined && entity.health <= 0)) continue;
      const dist = bot.entity?.position && entity.position
        ? getDistance(bot.entity.position, entity.position)
        : 0;
      if (dist <= radius) {
        aliveCount++;
      }
    }
  }

  if (typeof assertion.count === 'number') {
    const operator = assertion.operator || 'eq';
    const passed = compareValues(aliveCount, assertion.count, operator);
    return {
      passed,
      status: passed ? 'verified' : 'failed',
      verifiable: true,
      actual: aliveCount,
      expected: assertion.count,
      operator,
      message: passed
        ? null
        : `Expected living entity '${cleanName}' count ${operator} ${assertion.count}, but found ${aliveCount}`
    };
  }

  const expectsEliminated = expectedState === 'eliminated' || expectedState === 'dead' || expectedState === 'absent' || expectedState === 0;
  const passed = expectsEliminated ? aliveCount === 0 : aliveCount > 0;
  const actualState = aliveCount === 0 ? 'eliminated' : 'alive';
  const expectedLabel = expectsEliminated ? 'eliminated' : 'alive';

  return {
    passed,
    status: passed ? 'verified' : 'failed',
    verifiable: true,
    actual: actualState,
    expected: expectedLabel,
    operator: 'eq',
    message: passed
      ? null
      : `Expected entity '${cleanName}' to be '${expectedLabel}', but found ${aliveCount} alive nearby`
  };
}

/**
 * Évaluer une assertion portant sur la santé du bot
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Paramètres de l'assertion
 * @returns {{ passed: boolean, status: string, verifiable: boolean, actual: any, expected: any, operator: string, message: string|null }}
 */
function evaluateBotHealth(bot, assertion) {
  const expected = assertion.value !== undefined ? assertion.value : (assertion.expected !== undefined ? assertion.expected : 1);
  const operator = assertion.operator || 'gte';

  if (!bot || typeof bot.health !== 'number') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected,
      operator,
      message: 'Bot health observation unavailable'
    };
  }

  const actual = bot.health;
  const passed = compareValues(actual, expected, operator);

  return {
    passed,
    status: passed ? 'verified' : 'failed',
    verifiable: true,
    actual,
    expected,
    operator,
    message: passed ? null : `Expected bot health ${operator} ${expected}, but found ${actual}`
  };
}

/**
 * Évaluer une assertion portant sur le niveau de faim du bot
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Paramètres de l'assertion
 * @returns {{ passed: boolean, status: string, verifiable: boolean, actual: any, expected: any, operator: string, message: string|null }}
 */
function evaluateBotFood(bot, assertion) {
  const expected = assertion.value !== undefined ? assertion.value : (assertion.expected !== undefined ? assertion.expected : 1);
  const operator = assertion.operator || 'gte';

  if (!bot || typeof bot.food !== 'number') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected,
      operator,
      message: 'Bot food observation unavailable'
    };
  }

  const actual = bot.food;
  const passed = compareValues(actual, expected, operator);

  return {
    passed,
    status: passed ? 'verified' : 'failed',
    verifiable: true,
    actual,
    expected,
    operator,
    message: passed ? null : `Expected bot food ${operator} ${expected}, but found ${actual}`
  };
}

/**
 * Évaluer la proximité spatiale entre le bot et une position cible
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Paramètres de l'assertion
 * @returns {{ passed: boolean, status: string, verifiable: boolean, actual: any, expected: any, operator: string, message: string|null }}
 */
function evaluateBotPosition(bot, assertion) {
  const targetPos = assertion.position;
  const maxDistance = assertion.maxDistance !== undefined ? assertion.maxDistance : 3;

  if (!targetPos || typeof targetPos.x !== 'number' || typeof targetPos.y !== 'number' || typeof targetPos.z !== 'number') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: maxDistance,
      operator: 'lte',
      message: "Unverifiable bot_position assertion: missing valid target 'position'"
    };
  }

  const botPos = bot?.entity?.position;
  if (!botPos || typeof botPos.x !== 'number' || typeof botPos.y !== 'number' || typeof botPos.z !== 'number') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      actual: null,
      expected: maxDistance,
      operator: 'lte',
      message: 'Bot position observation unavailable'
    };
  }

  const actualDistance = getDistance(botPos, targetPos);
  const passed = actualDistance <= maxDistance;

  return {
    passed,
    status: passed ? 'verified' : 'failed',
    verifiable: true,
    actual: actualDistance,
    expected: maxDistance,
    operator: 'lte',
    message: passed ? null : `Expected bot distance <= ${maxDistance} from target, but distance is ${actualDistance.toFixed(2)}`
  };
}

/**
 * Évaluer une assertion élémentaire contre l'état réel observé dans Minecraft
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} assertion Définition de l'assertion
 * @param {object} [context={}] Contexte d'exécution pour la résolution dynamique
 * @returns {Promise<{
 *   passed: boolean,
 *   status: 'verified'|'failed'|'unknown',
 *   verifiable: boolean,
 *   type: string,
 *   assertion: object,
 *   actual: any,
 *   expected: any,
 *   message: string|null
 * }>} Résultat de l'assertion
 */
async function evaluateAssertion(bot, assertion, context = {}) {
  if (!assertion || typeof assertion !== 'object') {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      type: 'unknown',
      assertion: assertion || {},
      actual: null,
      expected: null,
      message: 'Assertion definition is missing or invalid'
    };
  }

  let resolved;
  try {
    resolved = context ? resolveDynamicValues(assertion, context) : assertion;
  } catch (err) {
    return {
      passed: false,
      status: 'unknown',
      verifiable: false,
      type: assertion.type || 'unknown',
      assertion,
      actual: null,
      expected: null,
      message: `Dynamic reference in assertion could not be resolved: ${err.message}`
    };
  }

  const type = resolved.type;
  let outcome;

  switch (type) {
    case 'inventory_item':
      outcome = evaluateInventoryItem(bot, resolved);
      break;
    case 'equipped_item':
    case 'equipment':
      outcome = evaluateEquippedItem(bot, resolved);
      break;
    case 'block_state':
      outcome = evaluateBlockState(bot, resolved);
      break;
    case 'container_item':
      outcome = evaluateContainerItem(bot, resolved, context);
      break;
    case 'entity_state':
    case 'entity_eliminated':
      outcome = evaluateEntityState(bot, resolved);
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
        try {
          const customRes = await resolved.fn(bot, context);
          if (customRes === 'unknown' || customRes === null || customRes === undefined) {
            outcome = {
              passed: false,
              status: 'unknown',
              verifiable: false,
              actual: customRes,
              expected: true,
              message: resolved.description || 'Custom predicate observation returned unknown'
            };
          } else {
            const passed = Boolean(customRes);
            outcome = {
              passed,
              status: passed ? 'verified' : 'failed',
              verifiable: true,
              actual: customRes,
              expected: true,
              message: passed ? null : (resolved.description || 'Custom predicate assertion failed')
            };
          }
        } catch (err) {
          outcome = {
            passed: false,
            status: 'unknown',
            verifiable: false,
            actual: null,
            expected: true,
            message: `Custom assertion threw error: ${err.message}`
          };
        }
      } else {
        outcome = {
          passed: false,
          status: 'unknown',
          verifiable: false,
          actual: null,
          expected: null,
          message: "Custom assertion missing executable 'fn' property"
        };
      }
      break;
    default:
      outcome = {
        passed: false,
        status: 'unknown',
        verifiable: false,
        actual: null,
        expected: null,
        message: `Unverifiable or unknown assertion type '${type}'`
      };
      break;
  }

  return {
    passed: Boolean(outcome.passed && outcome.status === 'verified'),
    status: outcome.status || (outcome.passed ? 'verified' : 'failed'),
    verifiable: outcome.verifiable !== false,
    type,
    assertion: resolved,
    actual: outcome.actual,
    expected: outcome.expected,
    message: outcome.message
  };
}

/**
 * Évaluer un tableau de préconditions avant l'exécution d'une procédure
 * @param {object} bot Instance du bot Mineflayer
 * @param {Array<object>} preconditions Définitions des préconditions
 * @param {object} [context={}] Contexte d'exécution
 * @returns {Promise<{ success: boolean, reason: string, data: object, error: string|null }>}
 */
async function evaluatePreconditions(bot, preconditions, context = {}) {
  if (!Array.isArray(preconditions) || preconditions.length === 0) {
    return createResult(true, 'preconditions_met', { passed: [], failed: [], unknown: [], total: 0 }, null);
  }

  const passed = [];
  const failed = [];
  const unknown = [];

  for (const assertion of preconditions) {
    const outcome = await evaluateAssertion(bot, assertion, context);
    if (outcome.status === 'verified' && outcome.passed) {
      passed.push(outcome);
    } else if (outcome.status === 'unknown') {
      unknown.push(outcome);
      failed.push(outcome);
    } else {
      failed.push(outcome);
    }
  }

  if (failed.length > 0) {
    const errorDetails = failed.map(f => f.message).join('; ');
    return createResult(false, 'preconditions_failed', {
      passed,
      failed,
      unknown,
      total: preconditions.length
    }, `Preconditions failed: ${errorDetails}`);
  }

  return createResult(true, 'preconditions_met', {
    passed,
    failed: [],
    unknown: [],
    total: preconditions.length
  }, null);
}

/**
 * Évaluer un tableau de postconditions déclarées après l'exécution d'une procédure
 * @param {object} bot Instance du bot Mineflayer
 * @param {Array<object>} postconditions Définitions des postconditions
 * @param {object} [context={}] Contexte d'exécution
 * @returns {Promise<{ success: boolean, reason: string, data: object, error: string|null }>}
 */
async function evaluatePostconditions(bot, postconditions, context = {}) {
  if (!Array.isArray(postconditions) || postconditions.length === 0) {
    return createResult(true, 'postconditions_met', { passed: [], failed: [], unknown: [], total: 0 }, null);
  }

  const passed = [];
  const failed = [];
  const unknown = [];

  for (const assertion of postconditions) {
    const outcome = await evaluateAssertion(bot, assertion, context);
    if (outcome.status === 'verified' && outcome.passed) {
      passed.push(outcome);
    } else if (outcome.status === 'unknown') {
      unknown.push(outcome);
      failed.push(outcome);
    } else {
      failed.push(outcome);
    }
  }

  if (failed.length > 0) {
    const reason = unknown.length > 0 && unknown.length === failed.length
      ? 'postconditions_unknown'
      : 'postconditions_failed';
    const errorDetails = failed.map(f => f.message).join('; ');
    return createResult(false, reason, {
      passed,
      failed,
      unknown,
      total: postconditions.length
    }, `Postconditions failed: ${errorDetails}`);
  }

  return createResult(true, 'postconditions_met', {
    passed,
    failed: [],
    unknown: [],
    total: postconditions.length
  }, null);
}

/**
 * Extraire la nature et la cible d'un objectif initial sous forme structurée
 * @param {string|object} rawObjective Objectif initial fourni
 * @param {object} [procedure=null] Procédure évaluée
 * @returns {{ kind: string, target: string|null, count: number, destination?: string, position?: object }|null}
 */
function parseObjectiveDescriptor(rawObjective, procedure = null) {
  let source = rawObjective;
  if (!source && procedure) {
    if (Array.isArray(procedure.metadata?.tags) && procedure.metadata.tags.length > 0) {
      source = procedure.metadata.tags[0];
    } else if (typeof procedure.id === 'string') {
      source = procedure.id.replace(/_exp_\d+$/, '');
    }
  }

  if (!source) return null;

  if (typeof source === 'object') {
    const kind = String(source.type || source.kind || 'item').toLowerCase().trim();
    const target = typeof source.target === 'string'
      ? source.target.toLowerCase().trim()
      : (typeof source.item === 'string' ? source.item.toLowerCase().trim() : null);
    const count = typeof source.count === 'number' && source.count > 0
      ? source.count
      : (target && config.QUEST_AMOUNT?.[target] ? config.QUEST_AMOUNT[target] : 1);
    return {
      kind,
      target,
      count,
      destination: source.destination || 'hand',
      position: source.position || null
    };
  }

  if (typeof source !== 'string') return null;
  const clean = source.toLowerCase().trim().replace(/_exp_\d+$/, '');
  if (!clean || clean === 'none') return null;

  const prefixes = [
    { prefix: 'equip_', kind: 'equip' },
    { prefix: 'kill_', kind: 'entity' },
    { prefix: 'hunt_', kind: 'entity' },
    { prefix: 'fight_', kind: 'entity' },
    { prefix: 'eliminate_', kind: 'entity' },
    { prefix: 'place_', kind: 'place' },
    { prefix: 'deposit_', kind: 'container' },
    { prefix: 'store_', kind: 'container' },
    { prefix: 'craft_', kind: 'item' },
    { prefix: 'mine_', kind: 'item' },
    { prefix: 'harvest_', kind: 'item' },
    { prefix: 'gather_', kind: 'item' },
    { prefix: 'obtain_', kind: 'item' },
    { prefix: 'smelt_', kind: 'item' }
  ];

  for (const { prefix, kind } of prefixes) {
    if (clean.startsWith(prefix)) {
      const rawTarget = clean.slice(prefix.length);
      const target = kind === 'item' && MINED_BLOCK_TO_DROP[rawTarget]
        ? MINED_BLOCK_TO_DROP[rawTarget]
        : rawTarget;
      const count = config.QUEST_AMOUNT?.[target] || config.QUEST_AMOUNT?.[rawTarget] || 1;
      return { kind, target, count };
    }
  }

  const mappedTarget = MINED_BLOCK_TO_DROP[clean] || clean;
  const count = config.QUEST_AMOUNT?.[clean] || config.QUEST_AMOUNT?.[mappedTarget] || 1;
  return { kind: 'item', target: mappedTarget, count };
}

/**
 * Évaluer de manière indépendante si l'objectif initial du bot est réellement atteint dans Minecraft
 * @param {object} bot Instance du bot Mineflayer
 * @param {string|object} rawObjective Objectif initial demandé
 * @param {object} [options={}] Contexte et options d'évaluation
 * @returns {Promise<{
 *   achieved: boolean,
 *   partiallyAchieved: boolean,
 *   status: 'verified'|'failed'|'unknown',
 *   verifiable: boolean,
 *   descriptor: object|null,
 *   actual: any,
 *   expected: any,
 *   message: string|null
 * }>} Verdict indépendant sur l'objectif
 */
async function evaluateObjective(bot, rawObjective, options = {}) {
  const descriptor = parseObjectiveDescriptor(rawObjective, options.procedure || null);
  if (!descriptor || !descriptor.target) {
    return {
      achieved: false,
      partiallyAchieved: false,
      status: 'unknown',
      verifiable: false,
      descriptor: null,
      actual: null,
      expected: null,
      message: 'Initial objective could not be determined or lacks a verifiable target'
    };
  }

  const { kind, target, count } = descriptor;

  if (kind === 'equip') {
    const eqRes = evaluateEquippedItem(bot, {
      item: target,
      destination: descriptor.destination || 'hand'
    });
    return {
      achieved: eqRes.passed,
      partiallyAchieved: false,
      status: eqRes.status,
      verifiable: eqRes.verifiable,
      descriptor,
      actual: eqRes.actual,
      expected: eqRes.expected,
      message: eqRes.message
    };
  }

  if (kind === 'entity') {
    const entRes = evaluateEntityState(bot, {
      type: 'entity_eliminated',
      entity: target,
      state: 'eliminated'
    });
    return {
      achieved: entRes.passed,
      partiallyAchieved: false,
      status: entRes.status,
      verifiable: entRes.verifiable,
      descriptor,
      actual: entRes.actual,
      expected: entRes.expected,
      message: entRes.message
    };
  }

  if (kind === 'container') {
    const contRes = evaluateContainerItem(bot, {
      item: target,
      count,
      operator: 'gte'
    }, options.context || {});
    const partiallyAchieved = !contRes.passed && contRes.status === 'failed' && typeof contRes.actual === 'number' && contRes.actual > 0;
    return {
      achieved: contRes.passed,
      partiallyAchieved,
      status: contRes.status,
      verifiable: contRes.verifiable,
      descriptor,
      actual: contRes.actual,
      expected: contRes.expected,
      message: contRes.message
    };
  }

  if (kind === 'place') {
    if (descriptor.position) {
      const blockRes = evaluateBlockState(bot, {
        position: descriptor.position,
        block: target,
        operator: 'eq'
      });
      return {
        achieved: blockRes.passed,
        partiallyAchieved: false,
        status: blockRes.status,
        verifiable: blockRes.verifiable,
        descriptor,
        actual: blockRes.actual,
        expected: blockRes.expected,
        message: blockRes.message
      };
    }

    if (!bot || (typeof bot.findBlock !== 'function' && typeof bot.blockAt !== 'function')) {
      return {
        achieved: false,
        partiallyAchieved: false,
        status: 'unknown',
        verifiable: false,
        descriptor,
        actual: null,
        expected: target,
        message: `World observation unavailable to verify placement of '${target}'`
      };
    }

    let placedBlock = null;
    if (typeof bot.findBlock === 'function') {
      placedBlock = bot.findBlock({
        matching: (b) => b && b.name === target,
        maxDistance: 32
      });
    }

    const achieved = Boolean(placedBlock);
    return {
      achieved,
      partiallyAchieved: false,
      status: achieved ? 'verified' : 'failed',
      verifiable: true,
      descriptor,
      actual: placedBlock ? placedBlock.name : 'absent',
      expected: target,
      message: achieved ? null : `Expected placed block '${target}' nearby, but none was found`
    };
  }

  if (!isInventoryObservable(bot)) {
    return {
      achieved: false,
      partiallyAchieved: false,
      status: 'unknown',
      verifiable: false,
      descriptor,
      actual: null,
      expected: count,
      message: `Inventory observation unavailable to verify objective '${target}'`
    };
  }

  let questMet = false;
  if (Array.isArray(config.QUEST_CHAIN) && config.QUEST_CHAIN.includes(target)) {
    try {
      questMet = isQuestDone(bot, target, options.state || {});
    } catch {
      questMet = false;
    }
  }

  const actualCount = getInventoryItemCount(bot, target);
  const achieved = questMet || actualCount >= count;
  const baselineCount = typeof options.initialCount === 'number' ? options.initialCount : 0;
  const partiallyAchieved = !achieved && actualCount > baselineCount && actualCount > 0;

  return {
    achieved,
    partiallyAchieved,
    status: achieved ? 'verified' : 'failed',
    verifiable: true,
    descriptor,
    actual: actualCount,
    expected: count,
    message: achieved
      ? null
      : `Objective '${target}' requires at least ${count} in inventory, but observed ${actualCount}`
  };
}

/**
 * Détecter les contradictions entre les affirmations de la trace du Runner et l'état réel de Minecraft
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} executionTrace Trace d'exécution issue du Runner
 * @returns {Array<{ stepId: string, action: string, code: string, message: string }>} Liste des contradictions détectées
 */
function detectTraceContradictions(bot, executionTrace) {
  const contradictions = [];
  const steps = Array.isArray(executionTrace?.steps)
    ? executionTrace.steps
    : (Array.isArray(executionTrace?.stepTraces) ? executionTrace.stepTraces : []);

  if (steps.length === 0 || !bot) {
    return contradictions;
  }

  steps.forEach((step, idx) => {
    if (!step || !step.success) return;

    const subsequentSteps = steps.slice(idx + 1).filter(s => s && s.success);
    const params = step.parameters || {};
    const output = step.output || {};

    if (step.action === 'craft_recipe') {
      const craftedItem = output.item || params.recipe;
      if (typeof craftedItem === 'string' && isInventoryObservable(bot)) {
        const consumedLater = subsequentSteps.some(s =>
          s.action === 'craft_recipe' ||
          s.action === 'drop_item' ||
          s.action === 'deposit_item' ||
          s.action === 'place_block'
        );
        if (!consumedLater && getInventoryItemCount(bot, craftedItem) <= 0) {
          contradictions.push({
            stepId: step.stepId || step.id || `step_${idx}`,
            action: step.action,
            code: 'CRAFT_OUTPUT_MISSING_IN_INVENTORY',
            message: `Runner trace claims step '${step.stepId || step.id}' crafted '${craftedItem}', but inventory contains 0`
          });
        }
      }
    } else if (step.action === 'equip_item') {
      const itemName = output.itemName || params.itemName;
      const destination = output.destination || params.destination || 'hand';
      if (typeof itemName === 'string') {
        const changedLater = subsequentSteps.some(s =>
          (s.action === 'equip_item' && ((s.parameters?.destination || 'hand') === destination)) ||
          (s.action === 'drop_item' && s.parameters?.itemName === itemName) ||
          (s.action === 'deposit_item' && s.parameters?.itemName === itemName)
        );
        if (!changedLater) {
          const eqObs = observeEquippedItem(bot, destination);
          if (eqObs.observable && eqObs.itemName !== itemName) {
            contradictions.push({
              stepId: step.stepId || step.id || `step_${idx}`,
              action: step.action,
              code: 'EQUIPPED_ITEM_MISMATCH',
              message: `Runner trace claims '${itemName}' was equipped in '${destination}', but observed '${eqObs.itemName || 'none'}'`
            });
          }
        }
      }
    } else if (step.action === 'break_block') {
      const pos = output.position || params.position;
      const brokenBlockName = output.blockName;
      if (pos && typeof pos.x === 'number' && typeof bot.blockAt === 'function') {
        const placedLaterAtSamePos = subsequentSteps.some(s => s.action === 'place_block');
        if (!placedLaterAtSamePos) {
          const currentBlock = bot.blockAt(pos);
          if (
            currentBlock &&
            typeof currentBlock.name === 'string' &&
            currentBlock.name !== 'air' &&
            currentBlock.name !== 'cave_air' &&
            currentBlock.name !== 'void_air' &&
            (!brokenBlockName || currentBlock.name === brokenBlockName)
          ) {
            contradictions.push({
              stepId: step.stepId || step.id || `step_${idx}`,
              action: step.action,
              code: 'BROKEN_BLOCK_STILL_PRESENT',
              message: `Runner trace claims block at (${pos.x},${pos.y},${pos.z}) was broken, but '${currentBlock.name}' is still present`
            });
          }
        }
      }
    } else if (step.action === 'place_block') {
      const placedPos = output.placedPosition;
      const blockName = output.blockName || params.blockName;
      if (placedPos && typeof placedPos.x === 'number' && typeof bot.blockAt === 'function') {
        const brokenLater = subsequentSteps.some(s => s.action === 'break_block');
        if (!brokenLater) {
          const currentBlock = bot.blockAt(placedPos);
          if (currentBlock && (currentBlock.name === 'air' || (blockName && currentBlock.name !== blockName))) {
            contradictions.push({
              stepId: step.stepId || step.id || `step_${idx}`,
              action: step.action,
              code: 'PLACED_BLOCK_MISSING',
              message: `Runner trace claims '${blockName || 'block'}' was placed at (${placedPos.x},${placedPos.y},${placedPos.z}), but observed '${currentBlock.name}'`
            });
          }
        }
      }
    }
  });

  return contradictions;
}

/**
 * Déterminer si un échec est imputable à un manque de ressources plutôt qu'à un défaut intrinsèque de la procédure
 * @param {object} executionTrace Trace ou résultat d'exécution du Runner
 * @param {Array<object>} failedConditions Conditions en échec
 * @returns {boolean} Vrai si l'échec provient d'un manque de ressources
 */
function detectResourceShortage(executionTrace, failedConditions = []) {
  if (!executionTrace) return false;

  if (RESOURCE_SHORTAGE_REASONS.has(executionTrace.status) || RESOURCE_SHORTAGE_REASONS.has(executionTrace.reason)) {
    return true;
  }

  const steps = Array.isArray(executionTrace.steps)
    ? executionTrace.steps
    : (Array.isArray(executionTrace.stepTraces) ? executionTrace.stepTraces : []);

  for (const step of steps) {
    if (step && !step.success && RESOURCE_SHORTAGE_REASONS.has(step.reason)) {
      return true;
    }
  }

  if (
    executionTrace.status === 'preconditions_failed' &&
    failedConditions.some(c => c.type === 'inventory_item')
  ) {
    return true;
  }

  return false;
}

/**
 * Calculer le score de confiance objectif uniquement à partir des observations vérifiables et de la cohérence
 * @param {object} params Paramètres de calcul de confiance
 * @param {number} params.verifiedCount Nombre de faits vérifiés avec succès
 * @param {number} params.failedCount Nombre de conditions vérifiables en échec
 * @param {number} params.unknownCount Nombre d'observations manquantes ou non vérifiables
 * @param {number} params.contradictionsCount Nombre de contradictions entre la trace et l'état réel
 * @returns {number} Score de confiance borné entre 0 et 1
 */
function computeEvaluationConfidence({
  verifiedCount = 0,
  failedCount = 0,
  unknownCount = 0,
  contradictionsCount = 0
}) {
  const verifiableCount = verifiedCount + failedCount;
  const totalCount = verifiableCount + unknownCount;

  if (totalCount === 0 || verifiableCount === 0) {
    return 0;
  }

  const observabilityRatio = verifiableCount / totalCount;
  const verificationRatio = verifiedCount / verifiableCount;

  let rawScore = observabilityRatio * verificationRatio;

  if (contradictionsCount > 0) {
    rawScore -= contradictionsCount * 0.5;
  }

  const clamped = Math.max(0, Math.min(1, rawScore));
  return Number(clamped.toFixed(3));
}

/**
 * Évaluer rigoureusement le résultat d'exécution d'une procédure sans modifier son statut en mémoire
 * @param {object} bot Instance du bot Mineflayer
 * @param {object} procedure Définition de la procédure évaluée
 * @param {object} executionTrace Trace ou résultat d'exécution produit par le Runner
 * @param {object} [options={}] Options d'évaluation
 * @param {string|object} [options.objective=null] Objectif initial du bot
 * @param {object} [options.state=null] État global optionnel du bot
 * @param {number} [options.initialObjectiveCount=0] Quantité initiale possédée avant l'exécution
 * @param {object} [options.context={}] Contexte additionnel pour la résolution dynamique
 * @returns {Promise<{
 *   success: boolean,
 *   reason: string,
 *   data: {
 *     procedureId: string,
 *     status: 'achieved'|'partially_achieved'|'not_achieved'|'inconclusive',
 *     executionSuccess: boolean,
 *     postconditionsPassed: boolean,
 *     objectiveAchieved: boolean,
 *     verifiedFacts: Array<object>,
 *     failedConditions: Array<object>,
 *     unknownConditions: Array<object>,
 *     contradictions: Array<object>,
 *     resourceShortage: boolean,
 *     deprecateRecommended: boolean,
 *     confidence: number
 *   },
 *   error: string|null
 * }>} Résultat complet d'évaluation
 */
async function evaluateProcedureExecution(bot, procedure, executionTrace, options = {}) {
  const procedureId = procedure?.id || executionTrace?.procedureId || 'unknown_procedure';
  const normalizedTrace = executionTrace?.trace || executionTrace?.data?.trace || executionTrace?.data || executionTrace || {};
  const steps = Array.isArray(normalizedTrace.steps)
    ? normalizedTrace.steps
    : (Array.isArray(normalizedTrace.stepTraces) ? normalizedTrace.stepTraces : []);

  const stepResults = normalizedTrace.stepResults || {};
  if (Object.keys(stepResults).length === 0) {
    for (const step of steps) {
      if (step && (step.stepId || step.id)) {
        stepResults[step.stepId || step.id] = {
          success: step.success,
          reason: step.reason,
          data: step.output || null,
          error: step.error || null
        };
      }
    }
  }

  const evalContext = {
    procedureId,
    parameters: options.context?.parameters || {},
    stepResults,
    containerWindow: options.context?.containerWindow || null,
    ...options.context
  };

  const executionSuccess = Boolean(
    normalizedTrace.success === true &&
    (normalizedTrace.status === 'completed' || !normalizedTrace.status)
  );

  const verifiedFacts = [];
  const failedConditions = [];
  const unknownConditions = [];

  const postconditions = Array.isArray(procedure?.postconditions) ? procedure.postconditions : [];
  let postconditionsPassed = false;

  if (postconditions.length > 0) {
    const postRes = await evaluatePostconditions(bot, postconditions, evalContext);
    for (const item of postRes.data.passed) {
      verifiedFacts.push({
        source: 'postcondition',
        type: item.type,
        actual: item.actual,
        expected: item.expected
      });
    }
    for (const item of postRes.data.failed) {
      if (item.status === 'unknown') {
        unknownConditions.push({
          source: 'postcondition',
          type: item.type,
          message: item.message
        });
      }
      failedConditions.push({
        source: 'postcondition',
        type: item.type,
        status: item.status,
        actual: item.actual,
        expected: item.expected,
        message: item.message
      });
    }
    postconditionsPassed = postRes.success && unknownConditions.length === 0;
  } else {
    postconditionsPassed = executionSuccess && isInventoryObservable(bot);
  }

  const objectiveOutcome = await evaluateObjective(bot, options.objective || null, {
    procedure,
    state: options.state || null,
    initialCount: options.initialObjectiveCount || 0,
    context: evalContext
  });

  let objectiveAchieved = false;
  if (objectiveOutcome.status === 'verified' && objectiveOutcome.achieved) {
    objectiveAchieved = true;
    verifiedFacts.push({
      source: 'objective',
      type: objectiveOutcome.descriptor?.kind || 'objective',
      target: objectiveOutcome.descriptor?.target || null,
      actual: objectiveOutcome.actual,
      expected: objectiveOutcome.expected
    });
  } else if (objectiveOutcome.status === 'unknown') {
    unknownConditions.push({
      source: 'objective',
      type: objectiveOutcome.descriptor?.kind || 'objective',
      target: objectiveOutcome.descriptor?.target || null,
      message: objectiveOutcome.message
    });
    failedConditions.push({
      source: 'objective',
      type: objectiveOutcome.descriptor?.kind || 'objective',
      status: 'unknown',
      actual: objectiveOutcome.actual,
      expected: objectiveOutcome.expected,
      message: objectiveOutcome.message
    });
  } else {
    failedConditions.push({
      source: 'objective',
      type: objectiveOutcome.descriptor?.kind || 'objective',
      status: 'failed',
      actual: objectiveOutcome.actual,
      expected: objectiveOutcome.expected,
      message: objectiveOutcome.message
    });
  }

  const contradictions = detectTraceContradictions(bot, normalizedTrace);
  for (const contradiction of contradictions) {
    failedConditions.push({
      source: 'contradiction',
      type: contradiction.code,
      status: 'failed',
      stepId: contradiction.stepId,
      message: contradiction.message
    });
  }

  if (contradictions.length > 0) {
    postconditionsPassed = false;
  }

  const realFailedCount = failedConditions.filter(f => f.status !== 'unknown').length;
  const confidence = computeEvaluationConfidence({
    verifiedCount: verifiedFacts.length,
    failedCount: realFailedCount,
    unknownCount: unknownConditions.length,
    contradictionsCount: contradictions.length
  });

  let status = 'not_achieved';
  if (unknownConditions.length > 0 && verifiedFacts.length === 0 && realFailedCount === 0) {
    status = 'inconclusive';
  } else if (unknownConditions.length > 0 && !objectiveAchieved) {
    status = 'inconclusive';
  } else if (executionSuccess && postconditionsPassed && objectiveAchieved && contradictions.length === 0) {
    status = 'achieved';
  } else if (
    objectiveAchieved ||
    objectiveOutcome.partiallyAchieved ||
    (verifiedFacts.length > 0 && (postconditionsPassed || executionSuccess))
  ) {
    status = 'partially_achieved';
  } else {
    status = 'not_achieved';
  }

  const resourceShortage = detectResourceShortage(normalizedTrace, failedConditions);
  const deprecateRecommended = status === 'not_achieved' && !resourceShortage && unknownConditions.length === 0;

  return createResult(true, 'evaluation_completed', {
    procedureId,
    status,
    executionSuccess,
    postconditionsPassed,
    objectiveAchieved,
    verifiedFacts,
    failedConditions,
    unknownConditions,
    contradictions,
    resourceShortage,
    deprecateRecommended,
    confidence
  }, null);
}

module.exports = {
  EVALUATION_STATUSES,
  RESOURCE_SHORTAGE_REASONS,
  compareValues,
  getInventoryItemCount,
  getDistance,
  observeEquippedItem,
  observeContainerItems,
  evaluateAssertion,
  evaluatePreconditions,
  evaluatePostconditions,
  parseObjectiveDescriptor,
  evaluateObjective,
  detectTraceContradictions,
  detectResourceShortage,
  computeEvaluationConfidence,
  evaluateProcedureExecution
};
