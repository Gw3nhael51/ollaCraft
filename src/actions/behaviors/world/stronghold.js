const config = require('../../../infrastructure/config');
const { countItem } = require('../../../perception/inventory');
const { getDimension, saveWaypoint, persistProgress } = require('../../../core/progress');
const {
  computeFlightHeading, triangulateStronghold, computeBaselinePoint, perpendicularOffset
} = require('../../../minecraft/triangulation');
const { travelTowards } = require('../movement/waypoint');
const { pickUpDroppedItem } = require('../blocks/placement');

// An Eye of Ender lives 80 ticks (4 s) before dropping or shattering
const EYE_FLIGHT_TIMEOUT_MS = 6000;
const ARRIVAL_RADIUS = 24;
// Fraction of the configured baseline that is enough to throw the second eye
const BASELINE_COMPLETION_RATIO = 0.8;
// Shortest sideways distance still giving a usable angle when the terrain blocks the full baseline
const MIN_USABLE_BASELINE = 90;

/**
 * Return the stronghold tracking record stored in state, creating it if missing
 * @param {object} state Global bot state
 * @returns {object} Stronghold record
 */
function getStrongholdState(state) {
  if (!state.stronghold) {
    state.stronghold = { throws: [], estimate: null, located: false, reached: false };
  }
  if (!Array.isArray(state.stronghold.throws)) state.stronghold.throws = [];
  return state.stronghold;
}

/**
 * Check whether an entity is a flying Eye of Ender
 * @param {object} entity Mineflayer entity
 * @returns {boolean} True for a thrown eye
 */
function isEyeEntity(entity) {
  if (!entity) return false;
  return entity.name === 'eye_of_ender' || /eye of ender/i.test(entity.displayName || '');
}

/**
 * Throw an Eye of Ender and record the positions of the flying eye until it disappears
 * @param {object} bot Mineflayer bot instance
 * @param {number} [timeoutMs=EYE_FLIGHT_TIMEOUT_MS] Maximum tracking duration
 * @returns {Promise<Array<{ x: number, y: number, z: number }>>} Recorded flight positions
 */
async function throwEyeAndTrack(bot, timeoutMs = EYE_FLIGHT_TIMEOUT_MS) {
  const eyeItem = bot.inventory.items().find(i => i.name === 'ender_eye');
  if (!eyeItem) return [];
  await bot.equip(eyeItem, 'hand');

  const samples = [];
  let tracked = null;
  let finish = null;
  const done = new Promise((resolve) => { finish = resolve; });

  const record = (entity) => {
    samples.push({ x: entity.position.x, y: entity.position.y, z: entity.position.z });
  };
  const onSpawn = (entity) => {
    if (tracked || !isEyeEntity(entity)) return;
    if (entity.position.distanceTo(bot.entity.position) > 8) return;
    tracked = entity;
    record(entity);
  };
  const onMove = (entity) => {
    if (entity === tracked) record(entity);
  };
  const onGone = (entity) => {
    if (entity === tracked) finish();
  };

  bot.on('entitySpawn', onSpawn);
  bot.on('entityMoved', onMove);
  bot.on('entityGone', onGone);
  const timer = setTimeout(() => finish(), timeoutMs);

  try {
    bot.activateItem();
    await done;
  } finally {
    clearTimeout(timer);
    bot.removeListener('entitySpawn', onSpawn);
    bot.removeListener('entityMoved', onMove);
    bot.removeListener('entityGone', onGone);
  }
  return samples;
}

/**
 * Walk to where the eye ended its flight and pick it up when it did not shatter (4 times out of 5)
 * @param {object} bot Mineflayer bot instance
 * @param {Array<{ x: number, y: number, z: number }>} samples Recorded flight positions
 * @param {number} eyesBefore Eye count right after the throw
 * @returns {Promise<boolean>} True if the eye was recovered
 */
async function recoverThrownEye(bot, samples, eyesBefore) {
  const landing = samples.at(-1);
  if (!landing) return false;
  try {
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(12);
    await travelTowards(bot, { x: landing.x, y: bot.entity.position.y, z: landing.z }, { radius: 1, ignoreY: true, timeoutMs: 10000 });
    return await pickUpDroppedItem(bot, () => countItem(bot, 'ender_eye') > eyesBefore, 'ender_eye', bot.entity.position, 3);
  } catch {
    return false;
  }
}

/**
 * Throw one eye, measure its bearing and triangulate once two bearings are known
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Throw outcome
 */
async function performEyeThrow(bot, state) {
  const record = getStrongholdState(state);
  const origin = { x: bot.entity.position.x, z: bot.entity.position.z };

  const samples = await throwEyeAndTrack(bot);
  const eyesAfterThrow = countItem(bot, 'ender_eye');
  const flight = computeFlightHeading(samples);
  if (!flight) {
    return { success: false, message: 'The thrown Eye of Ender could not be tracked; move to open sky and throw again.' };
  }

  const recovered = await recoverThrownEye(bot, samples, eyesAfterThrow);
  const recoveryNote = recovered ? ' Eye recovered.' : ' Eye lost (shattered or out of reach).';

  if (flight.overhead) {
    // The eye dived instead of climbing: the stronghold is within a few blocks, no second throw needed
    record.estimate = { x: Math.round(flight.end.x), z: Math.round(flight.end.z), angleDeg: 90, errorRadius: 16 };
    record.located = true;
    record.reached = true;
    saveWaypoint(state, 'stronghold', { x: record.estimate.x, y: 40, z: record.estimate.z }, 'overworld', 'eye dived here');
    persistProgress(state);
    return { success: true, message: `The eye dived into the ground: the stronghold is right below (${record.estimate.x}, ${record.estimate.z}).${recoveryNote}` };
  }

  record.throws.push({ x: Math.round(origin.x * 10) / 10, z: Math.round(origin.z * 10) / 10, heading: flight.heading });
  record.baselineTarget = null;
  persistProgress(state);
  const bearingDeg = Math.round((flight.heading * 180) / Math.PI);

  if (record.throws.length < config.EYE_TRIANGULATION_THROWS) {
    return {
      success: true,
      message: `Eye #1 thrown from (${Math.round(origin.x)}, ${Math.round(origin.z)}), bearing ${bearingDeg} deg.${recoveryNote} Now walking ${config.EYE_TRIANGULATION_BASELINE} blocks sideways for the second throw.`
    };
  }

  const [throwA, throwB] = record.throws.slice(-2);
  const estimate = triangulateStronghold(throwA, throwB);
  if (!estimate.valid) {
    // Keep the freshest bearing and take another one from a wider angle
    record.throws = [throwB];
    persistProgress(state);
    return { success: false, message: `Triangulation rejected: ${estimate.reason}. Keeping the last bearing and moving further sideways.` };
  }

  record.estimate = { x: estimate.x, z: estimate.z, angleDeg: estimate.angleDeg, errorRadius: estimate.errorRadius };
  record.located = true;
  record.reached = false;
  saveWaypoint(state, 'stronghold', { x: estimate.x, y: 40, z: estimate.z }, 'overworld', 'triangulated with 2 eyes');
  persistProgress(state);

  const summary = `Stronghold triangulé : X ${estimate.x}, Z ${estimate.z} (~${estimate.distance} blocs, angle ${estimate.angleDeg.toFixed(1)}°, ±${estimate.errorRadius})`;
  console.log(`[STRONGHOLD] ${summary}`);
  bot.chat?.(summary.slice(0, 240));
  return {
    success: true,
    message: `Eye #2 thrown, bearing ${bearingDeg} deg.${recoveryNote} Stronghold triangulated at X ${estimate.x}, Z ${estimate.z} (about ${estimate.distance} blocks away, error radius ~${estimate.errorRadius}).`
  };
}

/**
 * Walk sideways from the first bearing until the baseline is long enough for the second throw
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ ready: boolean, result: { success: boolean, message: string }|null }>} Ready flag or the step result
 */
async function walkBaseline(bot, state) {
  const record = getStrongholdState(state);
  const firstThrow = record.throws[0];
  const baseline = config.EYE_TRIANGULATION_BASELINE;
  const offsetNow = () => Math.abs(perpendicularOffset(firstThrow, bot.entity.position));

  if (offsetNow() >= baseline * BASELINE_COMPLETION_RATIO) return { ready: true, result: null };

  if (!record.baselineTarget) {
    record.baselineTarget = computeBaselinePoint(firstThrow, baseline, record.baselineSide || 1);
  }
  const target = { x: record.baselineTarget.x, y: bot.entity.position.y, z: record.baselineTarget.z };
  const leg = await travelTowards(bot, target, { radius: 8, ignoreY: true, legDistance: 56, timeoutMs: 35000 });

  if (leg.arrived || offsetNow() >= baseline * BASELINE_COMPLETION_RATIO) {
    return { ready: true, result: null };
  }
  if (leg.progressed) {
    record.baselineFailures = 0;
    return {
      ready: false,
      result: { success: true, message: `Walking the triangulation baseline: ${Math.round(offsetNow())}/${baseline} blocks sideways.` }
    };
  }

  // Blocked: try the other side, and settle for a shorter baseline rather than never throwing
  record.baselineFailures = (record.baselineFailures || 0) + 1;
  if (record.baselineFailures >= 2 && offsetNow() >= MIN_USABLE_BASELINE) {
    return { ready: true, result: null };
  }
  if (record.baselineFailures >= 2) {
    record.baselineSide = -(record.baselineSide || 1);
    record.baselineTarget = null;
    record.baselineFailures = 0;
  }
  return {
    ready: false,
    result: { success: false, message: `Baseline walk blocked (${leg.error || 'no path'}) at ${Math.round(offsetNow())}/${baseline} blocks; trying another way.` }
  };
}

/**
 * Travel towards the triangulated stronghold position, one leg per call
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Travel result
 */
async function travelToStronghold(bot, state) {
  const record = getStrongholdState(state);
  const estimate = record.estimate;
  const distance = () => Math.hypot(estimate.x - bot.entity.position.x, estimate.z - bot.entity.position.z);

  if (distance() > ARRIVAL_RADIUS) {
    const target = { x: estimate.x, y: bot.entity.position.y, z: estimate.z };
    const leg = await travelTowards(bot, target, { radius: 12, ignoreY: true, legDistance: 56, timeoutMs: 35000 });
    if (distance() > ARRIVAL_RADIUS) {
      return leg.progressed
        ? { success: true, message: `Travelling to the stronghold (${estimate.x}, ${estimate.z}): ${Math.round(distance())} blocks remaining.` }
        : { success: false, message: `No progress towards the stronghold (${leg.error || 'path blocked'}), ${Math.round(distance())} blocks remaining.` };
    }
  }

  record.reached = true;
  persistProgress(state);
  return {
    success: true,
    message: `Arrived above the triangulated stronghold (${estimate.x}, ${estimate.z}). Use 'endportal' to find the portal room below.`
  };
}

/**
 * Locate and reach the stronghold: two Eye of Ender throws from different places, triangulation, then travel
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Step result
 */
async function skillStronghold(bot, state) {
  if (getDimension(bot) !== 'overworld') {
    return { success: false, message: 'Strongholds are located from the Overworld: go back through the portal first.' };
  }

  const record = getStrongholdState(state);
  if (record.located && record.estimate) {
    return travelToStronghold(bot, state);
  }

  if (countItem(bot, 'ender_eye') < 1) {
    return { success: false, message: "No 'ender_eye' left to throw. Craft more (ender_pearl + blaze_powder)." };
  }

  if (record.throws.length > 0) {
    const baseline = await walkBaseline(bot, state);
    if (!baseline.ready) return baseline.result;
  }

  return performEyeThrow(bot, state);
}

module.exports = {
  skillStronghold,
  throwEyeAndTrack,
  performEyeThrow,
  travelToStronghold,
  getStrongholdState,
  isEyeEntity
};
