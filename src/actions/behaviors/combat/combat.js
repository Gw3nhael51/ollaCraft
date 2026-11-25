const { goals } = require('mineflayer-pathfinder');
const { autoEquipArmorAndShield } = require('../items/equip');

const PASSIVE_MOBS = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey'
]);

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'blaze', 'drowned', 'husk', 'stray'
]);

const HAZARDOUS_LOOT_BLOCKS = new Set([
  'lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block'
]);

// Same radius for the planner and the skill: an animal the planner sees must be one the skill hunts
const HUNT_SEARCH_RADIUS = 28;
// Animals hunted for a material only they drop: another species is no substitute (unlike meat for food)
const MATERIAL_HUNT_TARGETS = new Set(['sheep', 'chicken']);
// Hunt targets meaning "any animal"
const GENERIC_HUNT_TARGETS = new Set(['none', 'animal', 'animals', 'food', 'any']);
// An animal the bot could not reach is left alone for a while instead of being chased again and again
const UNREACHABLE_TARGET_TTL_MS = 3 * 60 * 1000;
const unreachableTargets = new Map();
// Sheep wool color index (lower four bits of the 'wool' metadata) to item color; bit 0x10 means sheared
const WOOL_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
];
const SHEARED_FLAG = 0x10;
// Time allowed to walk onto the drops of a kill
const DROP_PICKUP_BUDGET_MS = 7000;
const DROP_PICKUP_RADIUS = 6;

/**
 * Read a named metadata value of an entity (baby flag, sheep wool...)
 * @param {object} bot Mineflayer bot instance
 * @param {object} entity Entity to inspect
 * @param {string} key Metadata key name from minecraft-data
 * @returns {*} Metadata value or undefined when unknown
 */
function getEntityMetadata(bot, entity, key) {
  const keys = bot.registry?.entitiesByName?.[entity?.name]?.metadataKeys;
  const index = Array.isArray(keys) ? keys.indexOf(key) : -1;
  return index === -1 ? undefined : entity.metadata?.[index];
}

/**
 * Tell whether an animal is a baby: babies drop nothing when killed
 * @param {object} bot Mineflayer bot instance
 * @param {object} entity Animal entity
 * @returns {boolean} True for a baby animal
 */
function isBabyAnimal(bot, entity) {
  return getEntityMetadata(bot, entity, 'baby') === true;
}

/**
 * Read the wool color of a sheep and whether it was sheared
 * @param {object} bot Mineflayer bot instance
 * @param {object} entity Sheep entity
 * @returns {{ color: string|null, sheared: boolean }} Wool state (color null when unknown)
 */
function getSheepWool(bot, entity) {
  const raw = getEntityMetadata(bot, entity, 'wool');
  if (typeof raw !== 'number') return { color: null, sheared: false };
  return { color: WOOL_COLORS[raw & 0x0f] || null, sheared: (raw & SHEARED_FLAG) !== 0 };
}

/**
 * Remember that an animal could not be reached so the next hunts pick another one
 * @param {object} entity Animal entity
 * @param {number} [now=Date.now()] Reference timestamp
 */
function markUnreachableTarget(entity, now = Date.now()) {
  if (entity?.id === undefined) return;
  unreachableTargets.set(entity.id, now + UNREACHABLE_TARGET_TTL_MS);
}

/**
 * Check whether an animal was recently found unreachable
 * @param {object} entity Animal entity
 * @param {number} [now=Date.now()] Reference timestamp
 * @returns {boolean} True while the animal must be left alone
 */
function isUnreachableTarget(entity, now = Date.now()) {
  const expiresAt = unreachableTargets.get(entity?.id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    unreachableTargets.delete(entity.id);
    return false;
  }
  return true;
}

/**
 * Forget every animal marked unreachable
 */
function clearUnreachableTargets() {
  unreachableTargets.clear();
}

/**
 * Measure the distance between two positions, whatever vector implementation they use
 * @param {object} a First position
 * @param {object} b Second position
 * @returns {number} Euclidean distance
 */
function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Count the wool carried per color
 * @param {object} bot Mineflayer bot instance
 * @returns {Map<string, number>} Wool count by color
 */
function countWoolByColor(bot) {
  const totals = new Map();
  for (const item of bot.inventory?.items?.() || []) {
    if (item?.name?.endsWith('_wool')) {
      const color = item.name.slice(0, -'_wool'.length);
      totals.set(color, (totals.get(color) || 0) + item.count);
    }
  }
  return totals;
}

/**
 * Find the best animal to hunt: alive, adult, not left alone as unreachable, and for sheep not sheared.
 * Sheep of the wool color already being collected come first, since a bed needs three of the same color.
 * @param {object} bot Mineflayer bot instance
 * @param {string|null} species Wanted species, or null for any passive animal
 * @param {number} [maxDistance=HUNT_SEARCH_RADIUS] Search radius
 * @returns {object|null} Animal to hunt or null
 */
function findHuntTarget(bot, species, maxDistance = HUNT_SEARCH_RADIUS) {
  const origin = bot.entity?.position;
  if (!origin || !bot.entities) return null;
  const now = Date.now();
  const woolOwned = species === 'sheep' ? countWoolByColor(bot) : null;

  let best = null;
  let bestScore = Infinity;
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity || entity.isValid === false || !entity.position) continue;
    const matches = species ? entity.name === species : PASSIVE_MOBS.has(entity.name);
    if (!matches || isBabyAnimal(bot, entity) || isUnreachableTarget(entity, now)) continue;

    const distance = distanceBetween(origin, entity.position);
    if (distance > maxDistance) continue;

    let score = distance;
    if (entity.name === 'sheep') {
      const wool = getSheepWool(bot, entity);
      if (wool.sheared) continue;
      // Each wool of the same color already carried is worth a long walk: it saves a whole extra sheep
      if (woolOwned && wool.color) score -= (woolOwned.get(wool.color) || 0) * maxDistance;
    }
    if (score < bestScore) {
      bestScore = score;
      best = entity;
    }
  }
  return best;
}

/**
 * List the dropped item entities lying around a position
 * @param {object} bot Mineflayer bot instance
 * @param {object} around Center of the search
 * @param {number} radius Search radius
 * @param {Set<number>} skipped Item entity ids already tried
 * @returns {Array<object>} Item entities, nearest to the bot first
 */
function findDroppedItems(bot, around, radius, skipped) {
  const origin = bot.entity?.position || around;
  return Object.values(bot.entities || {})
    .filter(entity => (
      entity && entity.name === 'item' && entity.isValid !== false && entity.position &&
      !skipped.has(entity.id) && distanceBetween(entity.position, around) <= radius &&
      isPositionSafeForLoot(bot, entity.position)
    ))
    .sort((a, b) => distanceBetween(a.position, origin) - distanceBetween(b.position, origin));
}

/**
 * Walk onto every item dropped around a kill so it is really picked up
 * @param {object} bot Mineflayer bot instance
 * @param {object} around Death position of the animal
 * @param {number} [budgetMs=DROP_PICKUP_BUDGET_MS] Time allowed for the pickup
 * @returns {Promise<number>} Number of dropped items walked to
 */
async function pickUpDropsAround(bot, around, budgetMs = DROP_PICKUP_BUDGET_MS) {
  if (!around || typeof bot.pathfinder?.goto !== 'function' || !goals.GoalBlock) return 0;
  const deadline = Date.now() + budgetMs;
  const tried = new Set();
  let visited = 0;

  // Drops can take a couple of ticks to show up after the death animation
  if (findDroppedItems(bot, around, DROP_PICKUP_RADIUS, tried).length === 0) await bot.waitForTicks?.(5);

  while (Date.now() < deadline) {
    const drop = findDroppedItems(bot, around, DROP_PICKUP_RADIUS, tried)[0];
    if (!drop) break;
    tried.add(drop.id);
    visited += 1;

    let timer = null;
    const pos = drop.position;
    try {
      const goto = Promise.resolve(bot.pathfinder.goto(new goals.GoalBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))));
      goto.catch(() => {});
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Drop pickup timeout')), Math.max(500, Math.min(3500, deadline - Date.now())));
      });
      await Promise.race([goto, timeout]);
      await bot.waitForTicks?.(3);
    } catch {
      // Out of reach (fell into a hole, behind a fence): try the next drop
    } finally {
      if (timer) clearTimeout(timer);
      bot.pathfinder.setGoal?.(null);
      bot.clearControlStates?.();
    }
  }
  return visited;
}

/**
 * Snapshot the carried item counts by name
 * @param {object} bot Mineflayer bot instance
 * @returns {Map<string, number>} Item counts
 */
function snapshotInventory(bot) {
  const counts = new Map();
  for (const item of bot.inventory?.items?.() || []) {
    if (item?.name) counts.set(item.name, (counts.get(item.name) || 0) + item.count);
  }
  return counts;
}

/**
 * List the items gained since a snapshot
 * @param {object} bot Mineflayer bot instance
 * @param {Map<string, number>} before Snapshot taken before the hunt
 * @returns {Array<{ name: string, count: number }>} Gained items
 */
function diffInventory(bot, before) {
  const gained = [];
  for (const [name, count] of snapshotInventory(bot)) {
    const delta = count - (before.get(name) || 0);
    if (delta > 0) gained.push({ name, count: delta });
  }
  return gained;
}

/**
 * Check whether a target position is safe from lava and fire hazards before looting
 * @param {object} bot Mineflayer bot instance
 * @param {object} position Position vector to inspect
 * @returns {boolean} True if safe to approach
 */
function isPositionSafeForLoot(bot, position) {
  if (!position || typeof bot.blockAt !== 'function') return true;
  const blockAtPos = bot.blockAt(position);
  const blockBelow = typeof position.offset === 'function' ? bot.blockAt(position.offset(0, -1, 0)) : null;
  return !HAZARDOUS_LOOT_BLOCKS.has(blockAtPos?.name) && !HAZARDOUS_LOOT_BLOCKS.has(blockBelow?.name);
}

/**
 * Select the best weapon available in inventory
 * @param {object} bot Mineflayer bot instance
 * @returns {object|null} Best weapon item found or null
 */
function getBestWeapon(bot) {
  const items = bot.inventory.items();
  const swordTiers = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'];
  for (const sword of swordTiers) {
    const item = items.find(i => i.name === sword);
    if (item) return item;
  }
  const axeTiers = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'];
  for (const axe of axeTiers) {
    const item = items.find(i => i.name === axe);
    if (item) return item;
  }
  return null;
}

/**
 * Move towards the eliminated entity position to collect loot drops
 * @param {object} bot Mineflayer bot instance
 * @param {object} position Defeated entity position
 */
async function collectDrops(bot, position) {
  if (!position || !isPositionSafeForLoot(bot, position)) return;
  try {
    await bot.lookAt(position.offset(0, 0.5, 0));
    bot.setControlState('forward', true);
    await bot.waitForTicks(15);
  } catch {
    // Tolerate movement interruptions during pickup
  } finally {
    bot.setControlState('forward', false);
  }
}

/**
 * Find the closest entity matching target name or category
 * @param {object} bot Mineflayer bot instance
 * @param {string|null} targetName Target entity name query
 * @param {Set<string>|null} defaultSet Default category entity set
 * @param {number} maxDistance Maximum search radius
 * @returns {object|null} Closest matching entity or null
 */
function findTargetEntity(bot, targetName, defaultSet, maxDistance = 25) {
  let closest = null;
  let minDistance = maxDistance;

  for (const id in bot.entities) {
    const entity = bot.entities[id];
    if (!entity || entity === bot.entity || !entity.isValid) continue;

    const matchesName = targetName && entity.name?.toLowerCase().includes(targetName.toLowerCase());
    const matchesSet = !targetName && defaultSet?.has(entity.name);

    if (matchesName || matchesSet) {
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist < minDistance) {
        minDistance = dist;
        closest = entity;
      }
    }
  }

  return closest;
}

/**
 * Execute a single attack strike or pacing step against target entity
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target entity to strike
 * @returns {Promise<void>}
 */
async function strikeTargetStep(bot, targetEntity) {
  const distance = bot.entity.position.distanceTo(targetEntity.position);
  if (distance <= 3.5) {
    const targetHeight = targetEntity.height ? targetEntity.height * 0.8 : 1;
    await bot.lookAt(targetEntity.position.offset(0, targetHeight, 0));
    bot.attack(targetEntity);
    await bot.waitForTicks(12);
    return;
  }
  await bot.waitForTicks(4);
}

/**
 * Maintain recursive combat against target entity until defeated or timeout
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target entity to combat
 * @param {number} startTime Combat start timestamp
 * @param {number} maxDurationMs Maximum allocated duration in milliseconds
 * @param {object|null} [lastValidPos] Last recorded valid position of target entity
 * @returns {Promise<object|null>} Final valid position of target entity
 */
async function combatLoop(bot, targetEntity, startTime, maxDurationMs, lastValidPos = null) {
  const currentPos = targetEntity?.position?.clone ? targetEntity.position.clone() : (targetEntity?.position || lastValidPos);
  if (!targetEntity.isValid || targetEntity.health <= 0 || Date.now() - startTime >= maxDurationMs) {
    return currentPos;
  }

  await strikeTargetStep(bot, targetEntity);
  const postStrikePos = targetEntity?.position?.clone ? targetEntity.position.clone() : (targetEntity?.position || currentPos);
  return combatLoop(bot, targetEntity, startTime, maxDurationMs, postStrikePos);
}

/**
 * Approach and fight target entity until defeated or timeout
 * @param {object} bot Mineflayer bot instance
 * @param {object} targetEntity Target entity to fight
 * @returns {Promise<{ success: boolean, message: string }>} Result of the encounter
 */
async function executeCombat(bot, targetEntity) {
  // Equip best armor pieces and off-hand shield prior to engagement
  try {
    await autoEquipArmorAndShield(bot);
  } catch {
    // Tolerate equipment error and proceed with combat
  }

  const weapon = getBestWeapon(bot);
  if (weapon) {
    try {
      await bot.equip(weapon, 'hand');
    } catch {
      // Tolerate equipment error if already holding weapon
    }
  }

  const { GoalFollow } = goals;
  const entityName = targetEntity.name;
  const startPos = targetEntity.position.clone();

  console.log(`[COMBAT] Tracking ${entityName}...`);

  const maxDurationMs = 30000;
  const startTime = Date.now();

  try {
    bot.pathfinder.setGoal(new GoalFollow(targetEntity, 2), true);

    const deathPos = await combatLoop(bot, targetEntity, startTime, maxDurationMs, startPos);

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    if (!targetEntity.isValid || targetEntity.health <= 0) {
      console.log(`[COMBAT] Target eliminated, collecting drops from ${ entityName }...`);
      const lootPos = deathPos || startPos;
      // Walk onto the dropped items; without any visible item entity, fall back to a short push towards the body
      const pickedUp = await pickUpDropsAround(bot, lootPos);
      if (pickedUp === 0) await collectDrops(bot, lootPos);
      return { success: true, message: `Target '${entityName}' eliminated successfully.` };
    }

    // Chasing the same animal again would fail the same way: leave it alone for a while
    if (PASSIVE_MOBS.has(entityName)) markUnreachableTarget(targetEntity);
    return { success: false, message: `Combat interrupted against '${entityName}' (timeout or target out of reach).` };
  } catch (err) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { success: false, message: `Error during combat with '${entityName}' : ${err.message}` };
  }
}

/**
 * Hunt peaceful animal to acquire food or crafting supplies
 * @param {object} bot Mineflayer bot instance
 * @param {string|null} targetName Name of the targeted animal
 * @returns {Promise<{ success: boolean, message: string }>} Result of the hunt
 */
async function skillHunt(bot, targetName) {
  const requested = typeof targetName === 'string' ? targetName.toLowerCase().trim() : '';
  const species = requested && !GENERIC_HUNT_TARGETS.has(requested) ? requested : null;
  // Meat comes from any animal, but wool or feathers only from their own species: never kill a cow for wool
  const allowSubstitute = !species || !MATERIAL_HUNT_TARGETS.has(species);
  const target = (species && findHuntTarget(bot, species)) || (allowSubstitute ? findHuntTarget(bot, null) : null);
  if (!target) {
    return {
      success: false,
      message: species && !allowSubstitute
        ? `No huntable '${species}' within ${HUNT_SEARCH_RADIUS} blocks (babies, sheared sheep and unreachable ones are skipped): explore to find another herd.`
        : `No passive animal (${targetName || 'cow, pig, chicken...'}) found nearby.`
    };
  }

  const before = snapshotInventory(bot);
  const outcome = await executeCombat(bot, target);
  if (!outcome.success) return outcome;

  const gained = diffInventory(bot, before);
  const lootText = gained.length > 0 ? gained.map(item => `+${item.count} ${item.name}`).join(', ') : 'nothing collected';
  // An adult unsheared sheep always drops one wool: killing it without getting the wool is no progress
  if (target.name === 'sheep' && !gained.some(item => item.name.endsWith('_wool'))) {
    return { success: false, message: `Sheep killed but its wool was not picked up (${lootText}).` };
  }
  return { success: true, message: `${outcome.message} Loot: ${lootText}.` };
}

/**
 * Attack hostile mob for defense or loot collection
 * @param {object} bot Mineflayer bot instance
 * @param {string|null} targetName Name of the target hostile mob
 * @returns {Promise<{ success: boolean, message: string }>} Result of the combat
 */
async function skillFight(bot, targetName) {
  const target = findTargetEntity(bot, targetName, HOSTILE_MOBS);
  if (!target) {
    return { success: false, message: `No hostile mob (${targetName || 'zombie, skeleton, spider...'}) found nearby.` };
  }
  return executeCombat(bot, target);
}

module.exports = {
  skillHunt,
  skillFight,
  combatLoop,
  collectDrops,
  isPositionSafeForLoot,
  findHuntTarget,
  pickUpDropsAround,
  getSheepWool,
  isBabyAnimal,
  markUnreachableTarget,
  clearUnreachableTargets,
  HUNT_SEARCH_RADIUS
};
