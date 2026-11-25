const { Vec3 } = require('vec3');
const { countItem } = require('../../../perception/inventory');
const { getDimension, setMilestone, hasMilestone } = require('../../../core/progress');
const { autoEquipArmorAndShield } = require('../items/equip');
const { travelTowards } = require('../movement/waypoint');

// Vanilla arrow physics per tick: position += motion, then motion *= 0.99 and motion.y -= 0.05
const ARROW_SPEED = 3;
const ARROW_GRAVITY = 0.05;
const ARROW_DRAG = 0.99;
const BOW_CHARGE_TICKS = 22;
const BOW_RANGE = 70;
const MELEE_REACH = 5.5;
// The exit fountain sits at the center of the main island
const FOUNTAIN = { x: 0, z: 0 };
const ISLAND_RADIUS = 46;

/**
 * Simulate the height reached by an arrow after covering a horizontal distance
 * @param {number} pitch Launch angle in radians (positive is up)
 * @param {number} horizontalDistance Horizontal distance to cover
 * @returns {number|null} Height relative to the launch point, or null if the arrow never gets that far
 */
function simulateArrowHeight(pitch, horizontalDistance) {
  let vx = Math.cos(pitch) * ARROW_SPEED;
  let vy = Math.sin(pitch) * ARROW_SPEED;
  let x = 0;
  let y = 0;
  for (let tick = 0; tick < 200; tick++) {
    const nextX = x + vx;
    const nextY = y + vy;
    if (nextX >= horizontalDistance) {
      const ratio = vx > 0 ? (horizontalDistance - x) / vx : 0;
      return y + (nextY - y) * ratio;
    }
    x = nextX;
    y = nextY;
    vx *= ARROW_DRAG;
    vy = vy * ARROW_DRAG - ARROW_GRAVITY;
    if (y < -256) return null;
  }
  return null;
}

/**
 * Compute how high above a target to aim a fully drawn bow so the arrow drops onto it
 * @param {number} horizontalDistance Horizontal distance to the target
 * @param {number} heightDiff Target height minus shooter eye height
 * @returns {{ reachable: boolean, pitch: number, lift: number }} Launch angle and vertical aim correction in blocks
 */
function computeBowAim(horizontalDistance, heightDiff) {
  const distance = Math.max(0.5, horizontalDistance);
  const direct = Math.atan2(heightDiff, distance);
  const maxPitch = Math.min(Math.PI / 2 - 0.05, direct + Math.PI / 4);
  const step = Math.PI / 360;

  // Raise the aim from the straight line until the arrow no longer falls short (the flattest, fastest arc)
  let low = direct;
  let high = null;
  for (let pitch = direct + step; pitch <= maxPitch; pitch += step) {
    const height = simulateArrowHeight(pitch, distance);
    if (height !== null && height >= heightDiff) {
      high = pitch;
      break;
    }
    low = pitch;
  }
  if (high === null) {
    return { reachable: false, pitch: low, lift: Math.tan(low) * distance - heightDiff };
  }

  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    const height = simulateArrowHeight(mid, distance);
    if (height === null || height < heightDiff) low = mid;
    else high = mid;
  }

  const pitch = (low + high) / 2;
  return { reachable: true, pitch, lift: Math.tan(pitch) * distance - heightDiff };
}

/**
 * List living entities of a given type in the End
 * @param {object} bot Mineflayer bot instance
 * @param {string} name Entity type name
 * @returns {Array<object>} Matching entities, nearest first
 */
function findEntities(bot, name) {
  const origin = bot.entity.position;
  return Object.values(bot.entities || {})
    .filter(entity => entity && entity !== bot.entity && entity.name === name && entity.isValid !== false)
    .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin));
}

/**
 * Detect victory: portal blocks only appear in the central fountain once the dragon is dead
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True if the exit portal is active
 */
function isExitPortalActive(bot) {
  const portalId = bot.registry?.blocksByName?.end_portal?.id;
  if (!portalId || typeof bot.findBlock !== 'function') return false;
  return Boolean(bot.findBlock({ matching: portalId, maxDistance: 96 }));
}

/**
 * Draw the bow fully and release an arrow at a position, compensating for gravity
 * @param {object} bot Mineflayer bot instance
 * @param {Vec3} targetPos Position to hit
 * @returns {Promise<boolean>} True if an arrow was released
 */
async function shootArrowAt(bot, targetPos) {
  const bow = bot.inventory.items().find(i => i.name === 'bow');
  if (!bow || countItem(bot, 'arrow') === 0) return false;

  const eye = bot.entity.position.offset(0, 1.52, 0);
  const horizontal = Math.hypot(targetPos.x - eye.x, targetPos.z - eye.z);
  const aim = computeBowAim(horizontal, targetPos.y - eye.y);
  if (!aim.reachable) return false;

  const aimPoint = new Vec3(targetPos.x, targetPos.y + aim.lift, targetPos.z);
  try {
    await bot.equip(bow, 'hand');
    await bot.lookAt(aimPoint, true);
    bot.activateItem();
    await bot.waitForTicks(BOW_CHARGE_TICKS);
    await bot.lookAt(aimPoint, true);
    bot.deactivateItem();
    await bot.waitForTicks(4);
    return true;
  } catch {
    bot.deactivateItem?.();
    return false;
  }
}

/**
 * Shoot the nearest End crystals: each one heals the dragon, and any projectile blows it up
 * @param {object} bot Mineflayer bot instance
 * @param {Array<object>} crystals End crystal entities, nearest first
 * @param {number} arrowsLeft Maximum arrows to spend this step
 * @param {number} [fired=0] Arrows fired so far
 * @returns {Promise<number>} Arrows fired
 */
async function shootCrystals(bot, crystals, arrowsLeft, fired = 0) {
  if (arrowsLeft <= 0) return fired;
  const target = crystals.find(crystal => crystal.isValid !== false && crystal.position.distanceTo(bot.entity.position) <= BOW_RANGE);
  if (!target) return fired;

  const released = await shootArrowAt(bot, target.position.offset(0, 1, 0));
  if (!released) return fired;
  return shootCrystals(bot, crystals, arrowsLeft - 1, fired + 1);
}

/**
 * Strike the dragon. Its head takes full damage and is a separate hitbox numbered right after the dragon itself
 * @param {object} bot Mineflayer bot instance
 * @param {object} dragon Ender Dragon entity
 */
function strikeDragon(bot, dragon) {
  if (typeof bot._client?.write === 'function' && Number.isInteger(dragon.id)) {
    bot.swingArm?.();
    bot._client.write('use_entity', { target: dragon.id + 1, mouse: 1, sneaking: false });
  }
  bot.attack(dragon);
}

/**
 * Hit the dragon repeatedly while it stays within reach (perched on the fountain or swooping)
 * @param {object} bot Mineflayer bot instance
 * @param {object} dragon Ender Dragon entity
 * @param {number} strikesLeft Remaining strikes this step
 * @param {number} [landed=0] Strikes performed so far
 * @returns {Promise<number>} Strikes performed
 */
async function meleeDragon(bot, dragon, strikesLeft, landed = 0) {
  if (strikesLeft <= 0 || dragon.isValid === false) return landed;
  if (dragon.position.distanceTo(bot.entity.position) > MELEE_REACH + 2) return landed;

  await bot.lookAt(dragon.position.offset(0, 1.5, 0), true).catch(() => {});
  strikeDragon(bot, dragon);
  await bot.waitForTicks(12);
  return meleeDragon(bot, dragon, strikesLeft - 1, landed + 1);
}

/**
 * Equip the best sword available for melee strikes
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<void>}
 */
async function equipSword(bot) {
  const tiers = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'];
  const items = bot.inventory.items();
  const sword = tiers.map(name => items.find(i => i.name === name)).find(Boolean);
  if (sword) await bot.equip(sword, 'hand').catch(() => {});
}

/**
 * Fight one bounded round against the Ender Dragon: crystals first, then the dragon itself
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Round result
 */
async function skillDragon(bot, state) {
  if (getDimension(bot) !== 'the_end') {
    return { success: false, message: "The Ender Dragon lives in the End: use 'endportal' to get there." };
  }

  if (hasMilestone(state, 'dragon_defeated') || isExitPortalActive(bot)) {
    setMilestone(state, 'dragon_defeated', true);
    return { success: true, message: 'The Ender Dragon is defeated: the exit portal is open. Game completed!' };
  }

  await autoEquipArmorAndShield(bot).catch(() => {});

  // The arrival platform is off to the side: get onto the main island first
  const pos = bot.entity.position;
  if (Math.hypot(pos.x - FOUNTAIN.x, pos.z - FOUNTAIN.z) > ISLAND_RADIUS) {
    const leg = await travelTowards(bot, { x: FOUNTAIN.x, y: pos.y, z: FOUNTAIN.z }, { radius: ISLAND_RADIUS - 8, ignoreY: true, legDistance: 32, timeoutMs: 30000 });
    return leg.arrived || leg.progressed
      ? { success: true, message: `Crossing to the main End island: ${Math.round(leg.remaining)} blocks from the center.` }
      : { success: false, message: `Cannot reach the main End island yet (${leg.error || 'no path'}); bridge with blocks if a gap blocks the way.` };
  }

  const hasBow = countItem(bot, 'bow') > 0 && countItem(bot, 'arrow') > 0;
  const crystals = findEntities(bot, 'end_crystal');
  if (hasBow && crystals.length > 0) {
    const fired = await shootCrystals(bot, crystals, 4);
    if (fired > 0) {
      const remaining = findEntities(bot, 'end_crystal').length;
      return { success: true, message: `Fired ${fired} arrow(s) at End crystals: ${remaining} crystal(s) still visible, ${countItem(bot, 'arrow')} arrow(s) left.` };
    }
  }

  const dragon = findEntities(bot, 'ender_dragon')[0];
  if (!dragon) {
    return { success: true, message: 'No dragon in sight yet; holding position near the fountain.' };
  }

  const distance = dragon.position.distanceTo(bot.entity.position);
  if (distance <= MELEE_REACH + 2) {
    await equipSword(bot);
    const strikes = await meleeDragon(bot, dragon, 8);
    return { success: true, message: `Struck the Ender Dragon ${strikes} time(s) at close range.` };
  }

  if (hasBow && distance <= BOW_RANGE) {
    // Lead the shot by the distance the dragon covers while the arrow flies
    const flightTicks = distance / ARROW_SPEED;
    const velocity = dragon.velocity || new Vec3(0, 0, 0);
    const predicted = dragon.position.offset(velocity.x * flightTicks, 1.5 + velocity.y * flightTicks, velocity.z * flightTicks);
    const released = await shootArrowAt(bot, predicted);
    if (released) {
      return { success: true, message: `Shot at the Ender Dragon from ${Math.round(distance)} blocks, ${countItem(bot, 'arrow')} arrow(s) left.` };
    }
  }

  // Without a clear shot, wait by the fountain where the dragon comes down to perch
  if (Math.hypot(pos.x - FOUNTAIN.x, pos.z - FOUNTAIN.z) > 8) {
    await travelTowards(bot, { x: FOUNTAIN.x + 4, y: pos.y, z: FOUNTAIN.z }, { radius: 3, ignoreY: true, timeoutMs: 15000 });
  } else {
    await bot.waitForTicks(40);
  }
  const crystalNote = crystals.length > 0 && !hasBow ? ` ${crystals.length} crystal(s) keep healing it and no bow is available.` : '';
  return { success: true, message: `Waiting by the fountain for the dragon to perch (${Math.round(distance)} blocks away).${crystalNote}` };
}

module.exports = {
  skillDragon,
  computeBowAim,
  simulateArrowHeight,
  isExitPortalActive,
  findEntities
};
