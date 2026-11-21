/**
 * Eye of Ender triangulation: two throws from different places give two bearings whose
 * intersection is the stronghold. Headings are world angles in radians (0 = +X, PI/2 = +Z).
 */

const MIN_INTERSECTION_ANGLE_DEG = 2;
const MAX_STRONGHOLD_DISTANCE = 30000;
// Towards a far stronghold the eye climbs about 8 blocks; when the stronghold is within 12 blocks it dives at it instead
const DIVE_THRESHOLD = -0.5;

/**
 * Derive the horizontal bearing of a thrown Eye of Ender from its recorded positions
 * @param {Array<{ x: number, y: number, z: number }>} samples Successive entity positions during the flight
 * @param {number} [minTravel=1.5] Minimum horizontal travel needed for a reliable bearing
 * @returns {{ heading: number, travel: number, verticalDelta: number, overhead: boolean, end: { x: number, z: number } }|null} Bearing or null when unusable
 */
function computeFlightHeading(samples, minTravel = 1.5) {
  if (!Array.isArray(samples) || samples.length < 2) return null;

  const first = samples[0];
  let farthest = first;
  let maxTravel = 0;
  let lowestY = first.y;
  for (const sample of samples) {
    const travel = Math.hypot(sample.x - first.x, sample.z - first.z);
    if (travel > maxTravel) {
      maxTravel = travel;
      farthest = sample;
    }
    if (sample.y < lowestY) lowestY = sample.y;
  }

  const last = samples.at(-1);
  const verticalDelta = last.y - first.y;
  // A diving eye flies straight to its target: the stronghold is where the flight ends
  const overhead = verticalDelta < DIVE_THRESHOLD && lowestY - first.y < DIVE_THRESHOLD;
  const end = { x: last.x, z: last.z };

  if (maxTravel < minTravel) {
    return overhead ? { heading: 0, travel: maxTravel, verticalDelta, overhead: true, end } : null;
  }

  return {
    heading: Math.atan2(farthest.z - first.z, farthest.x - first.x),
    travel: maxTravel,
    verticalDelta,
    overhead,
    end
  };
}

/**
 * Intersect two bearings in the horizontal plane
 * @param {{ x: number, z: number }} originA First throw position
 * @param {number} headingA First bearing in radians
 * @param {{ x: number, z: number }} originB Second throw position
 * @param {number} headingB Second bearing in radians
 * @returns {{ x: number, z: number, distanceA: number, distanceB: number, angleDeg: number }|null} Intersection or null if parallel
 */
function intersectHeadings(originA, headingA, originB, headingB) {
  const ax = Math.cos(headingA);
  const az = Math.sin(headingA);
  const bx = Math.cos(headingB);
  const bz = Math.sin(headingB);

  const cross = ax * bz - az * bx;
  if (Math.abs(cross) < 1e-9) return null;

  const dx = originB.x - originA.x;
  const dz = originB.z - originA.z;
  const distanceA = (dx * bz - dz * bx) / cross;
  const distanceB = (dx * az - dz * ax) / cross;

  return {
    x: originA.x + ax * distanceA,
    z: originA.z + az * distanceA,
    distanceA,
    distanceB,
    angleDeg: (Math.asin(Math.min(1, Math.abs(cross))) * 180) / Math.PI
  };
}

/**
 * Estimate how far off the intersection may be for a given bearing measurement error
 * @param {number} distance Distance from the throws to the intersection
 * @param {number} angleDeg Angle between the two bearings in degrees
 * @param {number} [headingErrorDeg=0.5] Assumed bearing error in degrees
 * @returns {number} Approximate error radius in blocks
 */
function estimateErrorRadius(distance, angleDeg, headingErrorDeg = 0.5) {
  const angleRad = (Math.max(0.1, angleDeg) * Math.PI) / 180;
  const errorRad = (headingErrorDeg * Math.PI) / 180;
  return Math.round((Math.abs(distance) * Math.tan(errorRad)) / Math.sin(angleRad));
}

/**
 * Locate the stronghold from two Eye of Ender throws made at different places
 * @param {{ x: number, z: number, heading: number }} throwA First throw (position and bearing)
 * @param {{ x: number, z: number, heading: number }} throwB Second throw (position and bearing)
 * @param {object} [options={}] Validation thresholds
 * @param {number} [options.minAngleDeg=MIN_INTERSECTION_ANGLE_DEG] Minimum angle between both bearings
 * @param {number} [options.maxDistance=MAX_STRONGHOLD_DISTANCE] Maximum plausible distance
 * @returns {{ valid: boolean, x?: number, z?: number, angleDeg?: number, distance?: number, errorRadius?: number, reason?: string }} Estimate or rejection reason
 */
function triangulateStronghold(throwA, throwB, options = {}) {
  const minAngleDeg = options.minAngleDeg ?? MIN_INTERSECTION_ANGLE_DEG;
  const maxDistance = options.maxDistance ?? MAX_STRONGHOLD_DISTANCE;

  if (!throwA || !throwB || !Number.isFinite(throwA.heading) || !Number.isFinite(throwB.heading)) {
    return { valid: false, reason: 'two throws with a measured bearing are required' };
  }

  const hit = intersectHeadings(throwA, throwA.heading, throwB, throwB.heading);
  if (!hit) {
    return { valid: false, reason: 'the two bearings are parallel' };
  }
  if (hit.angleDeg < minAngleDeg) {
    return { valid: false, reason: `the bearings differ by only ${hit.angleDeg.toFixed(2)} degrees, throw from further sideways` };
  }
  if (hit.distanceA <= 0 || hit.distanceB <= 0) {
    return { valid: false, reason: 'the bearings diverge (intersection behind a throw)' };
  }
  if (hit.distanceA > maxDistance || hit.distanceB > maxDistance) {
    return { valid: false, reason: 'the intersection is implausibly far away' };
  }

  const distance = Math.max(hit.distanceA, hit.distanceB);
  return {
    valid: true,
    x: Math.round(hit.x),
    z: Math.round(hit.z),
    angleDeg: hit.angleDeg,
    distance: Math.round(distance),
    errorRadius: estimateErrorRadius(distance, hit.angleDeg)
  };
}

/**
 * Compute where to walk for the second throw: sideways from the first bearing, so both bearings cross at a wide angle
 * @param {{ x: number, z: number, heading: number }} firstThrow First throw (position and bearing)
 * @param {number} baseline Sideways distance in blocks
 * @param {number} [side=1] 1 for the left of the bearing, -1 for the right
 * @returns {{ x: number, z: number }} Target position for the second throw
 */
function computeBaselinePoint(firstThrow, baseline, side = 1) {
  const perpendicular = firstThrow.heading + (side >= 0 ? 1 : -1) * (Math.PI / 2);
  return {
    x: Math.round(firstThrow.x + Math.cos(perpendicular) * baseline),
    z: Math.round(firstThrow.z + Math.sin(perpendicular) * baseline)
  };
}

/**
 * Measure how far sideways a position lies from the line of the first bearing
 * @param {{ x: number, z: number, heading: number }} firstThrow First throw (position and bearing)
 * @param {{ x: number, z: number }} position Current position
 * @returns {number} Signed perpendicular distance in blocks
 */
function perpendicularOffset(firstThrow, position) {
  const dx = position.x - firstThrow.x;
  const dz = position.z - firstThrow.z;
  return dz * Math.cos(firstThrow.heading) - dx * Math.sin(firstThrow.heading);
}

module.exports = {
  computeFlightHeading,
  intersectHeadings,
  estimateErrorRadius,
  triangulateStronghold,
  computeBaselinePoint,
  perpendicularOffset,
  MIN_INTERSECTION_ANGLE_DEG
};
