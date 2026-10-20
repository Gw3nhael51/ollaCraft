const { goals } = require('mineflayer-pathfinder');
const { autoEquipArmorAndShield } = require('./equip');

const PASSIVE_MOBS = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey'
]);

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'blaze', 'drowned', 'husk', 'stray'
]);

const HAZARDOUS_LOOT_BLOCKS = new Set([
  'lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block'
]);

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
      await collectDrops(bot, deathPos || startPos);
      return { success: true, message: `Target '${entityName}' eliminated successfully.` };
    }

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
  const cleanTarget = targetName && targetName !== 'none' && targetName !== 'animal' ? targetName : null;
  const target = findTargetEntity(bot, cleanTarget, PASSIVE_MOBS) || findTargetEntity(bot, null, PASSIVE_MOBS);
  if (!target) {
    return { success: false, message: `No passive animal (${targetName || 'cow, pig, chicken...'}) found nearby.` };
  }
  return executeCombat(bot, target);
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

module.exports = { skillHunt, skillFight, combatLoop, collectDrops, isPositionSafeForLoot };
