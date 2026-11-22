const fs = require('node:fs');
const path = require('node:path');
const config = require('../infrastructure/config');

const PROGRESS_VERSION = 1;
const KNOWN_DIMENSIONS = new Set(['overworld', 'the_nether', 'the_end']);

/**
 * Normalize a raw dimension identifier into 'overworld', 'the_nether' or 'the_end'
 * @param {string|undefined|null} rawDimension Dimension name reported by the server
 * @returns {string} Normalized dimension name
 */
function normalizeDimension(rawDimension) {
  if (typeof rawDimension !== 'string' || !rawDimension) return 'overworld';
  const clean = rawDimension.toLowerCase().replace(/^minecraft:/, '');
  if (clean === 'nether') return 'the_nether';
  if (clean === 'end') return 'the_end';
  return KNOWN_DIMENSIONS.has(clean) ? clean : 'overworld';
}

/**
 * Return the normalized dimension the bot currently stands in
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Normalized dimension name
 */
function getDimension(bot) {
  return normalizeDimension(bot?.game?.dimension);
}

/**
 * Build the default progress file path, isolated per server and bot account
 * @returns {string} Absolute path of the progress JSON file
 */
function getDefaultProgressFile() {
  const { host, port, username } = config.BOT_CONFIG;
  const slug = `${host}_${port}_${username}`.replace(/[^a-z0-9_.-]/gi, '_');
  return path.resolve(process.cwd(), 'data', `progress-${slug}.json`);
}

/**
 * Reduce a position vector to rounded plain coordinates safe for JSON storage
 * @param {object} pos Position with x, y, z
 * @returns {{ x: number, y: number, z: number }|null} Plain coordinates or null
 */
function toPlainPosition(pos) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;
  return {
    x: Math.round(pos.x),
    y: Math.round(Number.isFinite(pos.y) ? pos.y : 64),
    z: Math.round(pos.z)
  };
}

/**
 * Write waypoints, milestones and stronghold data to disk when persistence is enabled
 * @param {object} state Global bot state
 * @returns {boolean} True if the file was written
 */
function persistProgress(state) {
  if (!state?.progressFile) return false;
  try {
    fs.mkdirSync(path.dirname(state.progressFile), { recursive: true });
    const payload = {
      version: PROGRESS_VERSION,
      savedAt: new Date().toISOString(),
      waypoints: state.waypoints || {},
      milestones: state.milestones || {},
      stronghold: state.stronghold || null,
      endPortal: state.endPortal || null
    };
    fs.writeFileSync(state.progressFile, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.warn('[PROGRESS] Failed to persist progress:', error.message);
    return false;
  }
}

/**
 * Load persisted waypoints and milestones into state and enable persistence on the given file
 * @param {object} state Global bot state
 * @param {string} [filePath] Progress file path
 * @returns {number} Number of waypoints restored
 */
function loadProgress(state, filePath = getDefaultProgressFile()) {
  state.progressFile = filePath;
  try {
    if (!fs.existsSync(filePath)) return 0;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.waypoints && typeof parsed.waypoints === 'object') state.waypoints = parsed.waypoints;
    if (parsed?.milestones && typeof parsed.milestones === 'object') state.milestones = parsed.milestones;
    if (parsed?.stronghold && typeof parsed.stronghold === 'object') {
      state.stronghold = { throws: [], estimate: null, located: false, reached: false, ...parsed.stronghold };
    }
    if (parsed?.endPortal && typeof parsed.endPortal === 'object') {
      state.endPortal = { center: null, frameCount: 0, filledCount: 0, ...parsed.endPortal };
    }
    return Object.keys(state.waypoints || {}).length;
  } catch (error) {
    console.warn('[PROGRESS] Failed to load progress:', error.message);
    return 0;
  }
}

/**
 * Record or update a named waypoint for a milestone location
 * @param {object} state Global bot state
 * @param {string} name Waypoint identifier (e.g. 'nether_portal')
 * @param {object} pos Position with x, y, z
 * @param {string} [dimension='overworld'] Dimension the position belongs to
 * @param {string} [note=''] Short human-readable description
 * @returns {object|null} Stored waypoint or null if the position is invalid
 */
function saveWaypoint(state, name, pos, dimension = 'overworld', note = '') {
  const plain = toPlainPosition(pos);
  if (!state || !name || !plain) return null;
  if (!state.waypoints) state.waypoints = {};

  const waypoint = { ...plain, dimension: normalizeDimension(dimension), note, savedAt: Date.now() };
  const previous = state.waypoints[name];
  state.waypoints[name] = waypoint;

  const moved = !previous || previous.x !== waypoint.x || previous.y !== waypoint.y || previous.z !== waypoint.z || previous.dimension !== waypoint.dimension;
  if (moved) {
    console.log(`[WAYPOINT] '${name}' saved at (${waypoint.x}, ${waypoint.y}, ${waypoint.z}) in ${waypoint.dimension}.`);
    persistProgress(state);
  }
  return waypoint;
}

/**
 * Retrieve a named waypoint
 * @param {object} state Global bot state
 * @param {string} name Waypoint identifier
 * @returns {object|null} Waypoint or null
 */
function getWaypoint(state, name) {
  return state?.waypoints?.[name] || null;
}

/**
 * Delete a named waypoint
 * @param {object} state Global bot state
 * @param {string} name Waypoint identifier
 * @returns {boolean} True if a waypoint was removed
 */
function removeWaypoint(state, name) {
  if (!state?.waypoints?.[name]) return false;
  delete state.waypoints[name];
  persistProgress(state);
  return true;
}

/**
 * List waypoints, optionally restricted to one dimension
 * @param {object} state Global bot state
 * @param {string|null} [dimension=null] Dimension filter
 * @returns {Array<object>} Waypoints with their name
 */
function listWaypoints(state, dimension = null) {
  const wanted = dimension ? normalizeDimension(dimension) : null;
  return Object.entries(state?.waypoints || {})
    .filter(([, wp]) => !wanted || wp.dimension === wanted)
    .map(([name, wp]) => ({ name, ...wp }));
}

/**
 * Compute the horizontal distance between the bot and a waypoint
 * @param {object} bot Mineflayer bot instance
 * @param {object} waypoint Waypoint or plain position
 * @returns {number} Horizontal distance in blocks (Infinity when unknown)
 */
function horizontalDistanceTo(bot, waypoint) {
  const pos = bot?.entity?.position;
  if (!pos || !waypoint) return Infinity;
  return Math.hypot(waypoint.x - pos.x, waypoint.z - pos.z);
}

/**
 * Set a sticky progression flag and persist it
 * @param {object} state Global bot state
 * @param {string} name Milestone identifier
 * @param {*} [value=true] Milestone value
 */
function setMilestone(state, name, value = true) {
  if (!state || !name) return;
  if (!state.milestones) state.milestones = {};
  if (state.milestones[name] === value) return;
  state.milestones[name] = value;
  console.log(`[MILESTONE] '${name}' = ${JSON.stringify(value)}`);
  persistProgress(state);
}

/**
 * Check whether a sticky progression flag is set
 * @param {object} state Global bot state
 * @param {string} name Milestone identifier
 * @returns {boolean} True if the milestone is truthy
 */
function hasMilestone(state, name) {
  return Boolean(state?.milestones?.[name]);
}

// Extra distance walked beyond the protected radius so the whole work area lies outside it
const SPAWN_PROTECTION_MARGIN = 6;

/**
 * Measure the horizontal distance between the bot and the world spawn point
 * @param {object} bot Mineflayer bot instance
 * @returns {number} Distance in blocks (Infinity when unknown)
 */
function getSpawnDistance(bot) {
  const spawn = bot?.spawnPoint;
  const pos = bot?.entity?.position;
  if (!spawn || !pos) return Infinity;
  return Math.hypot(pos.x - spawn.x, pos.z - spawn.z);
}

/**
 * Remember that the server refused a block placement next to the world spawn (spawn protection)
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {boolean} True if the refusal happened inside the protected radius and was recorded
 */
function noteRefusedPlacement(bot, state) {
  if (!state || getDimension(bot) !== 'overworld') return false;
  if (getSpawnDistance(bot) > config.SPAWN_PROTECTION_RADIUS + SPAWN_PROTECTION_MARGIN) return false;
  setMilestone(state, 'spawn_protection', true);
  return true;
}

/**
 * Tell whether the bot stands in the spawn area where the server is known to refuse building
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {boolean} True if the bot should walk away before placing or breaking blocks
 */
function isInsideProtectedSpawn(bot, state) {
  return hasMilestone(state, 'spawn_protection') &&
    getDimension(bot) === 'overworld' &&
    getSpawnDistance(bot) <= config.SPAWN_PROTECTION_RADIUS + SPAWN_PROTECTION_MARGIN;
}

/**
 * Format the known waypoints into compact text for chat or prompts
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {string} Human-readable waypoint summary
 */
function formatWaypoints(bot, state) {
  const all = listWaypoints(state);
  if (all.length === 0) return 'aucun';
  const here = getDimension(bot);
  return all
    .map(wp => {
      const sameDimension = wp.dimension === here;
      const distance = sameDimension ? `${Math.round(horizontalDistanceTo(bot, wp))} blocs` : `autre dimension (${wp.dimension})`;
      return `${wp.name} (${wp.x}, ${wp.y}, ${wp.z} | ${distance})`;
    })
    .join(' ; ');
}

module.exports = {
  normalizeDimension,
  getDimension,
  getDefaultProgressFile,
  toPlainPosition,
  loadProgress,
  persistProgress,
  saveWaypoint,
  getWaypoint,
  removeWaypoint,
  listWaypoints,
  horizontalDistanceTo,
  setMilestone,
  hasMilestone,
  getSpawnDistance,
  noteRefusedPlacement,
  isInsideProtectedSpawn,
  formatWaypoints
};
