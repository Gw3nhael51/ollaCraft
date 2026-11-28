const { goals } = require('mineflayer-pathfinder');
const { getDimension, getWaypoint, listWaypoints } = require('../../../core/progress');

// Long trips are cut into legs: chunks further away are not loaded, so the pathfinder cannot plan through them
const LEG_DISTANCE = 40;
const LEG_TIMEOUT_MS = 30000;

/**
 * Walk one leg towards a destination, returning how much closer the bot got
 * @param {object} bot Mineflayer bot instance
 * @param {{ x: number, y: number, z: number }} destination Target coordinates
 * @param {object} [options={}] Travel options
 * @param {number} [options.radius=4] Distance at which the destination counts as reached
 * @param {boolean} [options.ignoreY=false] Only match the horizontal position (unknown altitude)
 * @param {number} [options.legDistance=LEG_DISTANCE] Maximum length of one leg
 * @param {number} [options.timeoutMs=LEG_TIMEOUT_MS] Maximum duration of one leg
 * @returns {Promise<{ arrived: boolean, progressed: boolean, remaining: number, error: string|null }>} Leg outcome
 */
async function travelTowards(bot, destination, options = {}) {
  const radius = options.radius ?? 4;
  const legDistance = options.legDistance ?? LEG_DISTANCE;
  const timeoutMs = options.timeoutMs ?? LEG_TIMEOUT_MS;
  const ignoreY = Boolean(options.ignoreY);

  const horizontalTo = () => Math.hypot(destination.x - bot.entity.position.x, destination.z - bot.entity.position.z);
  // With a known altitude, digging down or climbing counts as progress too
  const distanceTo = () => (ignoreY
    ? horizontalTo()
    : Math.hypot(horizontalTo(), destination.y - bot.entity.position.y));
  const hasArrived = () => {
    const closeEnough = horizontalTo() <= radius + 1;
    return ignoreY ? closeEnough : closeEnough && Math.abs(destination.y - bot.entity.position.y) <= radius + 3;
  };

  const startDistance = horizontalTo();
  const startTotal = distanceTo();
  if (hasArrived()) return { arrived: true, progressed: false, remaining: startTotal, error: null };

  const pos = bot.entity.position;
  const verticalGap = ignoreY ? 0 : destination.y - pos.y;
  const needsSteppedAscent = !ignoreY && verticalGap > 16 && startDistance <= legDistance + 8;
  let goal;
  if (startDistance > legDistance + 8) {
    const scale = legDistance / startDistance;
    goal = new goals.GoalNearXZ(
      Math.round(pos.x + (destination.x - pos.x) * scale),
      Math.round(pos.z + (destination.z - pos.z) * scale),
      3
    );
  } else if (ignoreY) {
    goal = new goals.GoalNearXZ(Math.round(destination.x), Math.round(destination.z), Math.max(1, radius));
  } else if (needsSteppedAscent && typeof goals.GoalY === 'function') {
    // Climb in short vertical legs instead of asking pathfinder for a 100-block vertical route at once
    goal = new goals.GoalY(Math.round(Math.min(destination.y, pos.y + 12)));
  } else {
    goal = new goals.GoalNear(Math.round(destination.x), Math.round(destination.y), Math.round(destination.z), Math.max(1, radius));
  }

  let navTimer = null;
  let error = null;
  try {
    const gotoPromise = bot.pathfinder.goto(goal);
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error('Travel leg timeout')), timeoutMs);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } catch (err) {
    error = err.message;
  } finally {
    if (navTimer) clearTimeout(navTimer);
    bot.pathfinder.setGoal?.(null);
    bot.clearControlStates?.();
  }

  // If pathfinder failed to climb towards a high waypoint, pillar up directly with lava-safe checks
  if (needsSteppedAscent && startTotal - distanceTo() < 3) {
    const { tryPillarUp } = require('./navigate');
    const pillared = await tryPillarUp(bot, Math.min(20000, timeoutMs));
    if (pillared) error = null;
  }

  const remaining = distanceTo();
  return {
    arrived: hasArrived(),
    progressed: startTotal - remaining >= 3,
    remaining,
    error
  };
}

/**
 * Travel back to a memorized milestone location (portal, spawn bed, stronghold...), one leg per call
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} target Waypoint name
 * @returns {Promise<{ success: boolean, message: string }>} Travel result
 */
async function skillGoto(bot, state, target) {
  const name = typeof target === 'string' ? target.toLowerCase().trim() : '';
  const waypoint = getWaypoint(state, name);
  if (!waypoint) {
    const known = listWaypoints(state).map(wp => wp.name).join(', ') || 'none';
    return { success: false, message: `Unknown waypoint '${target}'. Known waypoints: ${known}.` };
  }

  const dimension = getDimension(bot);
  if (waypoint.dimension !== dimension) {
    return {
      success: false,
      message: `Waypoint '${name}' is in ${waypoint.dimension} but you are in ${dimension}. Travel through a portal first.`
    };
  }

  console.log(`[GOTO] Heading to waypoint '${name}' at (${waypoint.x}, ${waypoint.y}, ${waypoint.z})...`);
  const leg = await travelTowards(bot, waypoint, { radius: 4 });
  if (leg.arrived) {
    return { success: true, message: `Arrived at waypoint '${name}' (${waypoint.x}, ${waypoint.y}, ${waypoint.z}).` };
  }
  if (leg.progressed) {
    return { success: true, message: `Moved closer to waypoint '${name}': ${Math.round(leg.remaining)} blocks remaining.` };
  }
  return {
    success: false,
    message: `No progress towards waypoint '${name}' (${leg.error || 'path blocked'}), ${Math.round(leg.remaining)} blocks remaining.`
  };
}

module.exports = { skillGoto, travelTowards, LEG_DISTANCE };
