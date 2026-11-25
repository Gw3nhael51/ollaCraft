const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../../../infrastructure/config');
const { countItem } = require('../../../perception/inventory');
const {
  getDimension, getWaypoint, saveWaypoint, persistProgress, setMilestone, toPlainPosition
} = require('../../../core/progress');
const { travelTowards } = require('../movement/waypoint');
const { approachPosition } = require('../blocks/placement');
const { ensureSpawnBed } = require('./bed');

// Loaded chunks are scanned through walls, so the frame is usually visible from the surface above the stronghold
const FRAME_SCAN_RADIUS = 128;
// Where to stand and rescan when the frame is not within range of the triangulated point
const SEARCH_OFFSETS = [
  [0, 0], [72, 0], [0, 72], [-72, 0], [0, -72],
  [72, 72], [-72, 72], [-72, -72], [72, -72],
  [144, 0], [0, 144], [-144, 0], [0, -144]
];

/**
 * Return the End portal tracking record stored in state, creating it if missing
 * @param {object} state Global bot state
 * @returns {object} End portal record
 */
function getEndPortalState(state) {
  if (!state.endPortal) {
    state.endPortal = { center: null, frameCount: 0, filledCount: 0 };
  }
  return state.endPortal;
}

/**
 * Check whether an End portal frame block already holds an Eye of Ender
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} block Frame block
 * @returns {boolean} True if the frame is filled
 */
function isFrameFilled(bot, block) {
  if (!block) return false;
  const props = typeof block.getProperties === 'function' ? block.getProperties() : block.properties;
  if (props && props.eye !== undefined) {
    return props.eye === true || props.eye === 'true';
  }
  // Block states are ordered eye=true first (4 facings), then eye=false
  const definition = bot.registry?.blocksByName?.end_portal_frame;
  if (definition && Number.isFinite(block.stateId)) {
    return block.stateId - definition.minStateId < 4;
  }
  return false;
}

/**
 * Scan loaded chunks for the End portal frame and summarize it
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxDistance=FRAME_SCAN_RADIUS] Scan radius
 * @returns {{ frames: Array<object>, center: Vec3, filled: number }|null} Frame summary or null when not found
 */
function scanPortalFrames(bot, maxDistance = FRAME_SCAN_RADIUS) {
  const frameId = bot.registry?.blocksByName?.end_portal_frame?.id;
  if (!frameId || typeof bot.findBlocks !== 'function') return null;

  const positions = bot.findBlocks({ matching: frameId, maxDistance, count: 24 });
  if (!Array.isArray(positions) || positions.length === 0) return null;

  // Keep the ring the nearest frame belongs to (a portal is 12 frames within a 5x5 square)
  const anchor = positions[0];
  const ring = positions.filter(pos => Math.abs(pos.x - anchor.x) <= 5 && Math.abs(pos.z - anchor.z) <= 5 && pos.y === anchor.y);
  const frames = ring
    .map((pos) => {
      const block = bot.blockAt(pos);
      if (!block) return null;
      return block.position ? block : { ...block, position: pos };
    })
    .filter(Boolean);
  if (frames.length === 0) return null;

  const sum = ring.reduce((acc, pos) => ({ x: acc.x + pos.x, z: acc.z + pos.z }), { x: 0, z: 0 });
  const center = new Vec3(Math.round(sum.x / ring.length), anchor.y, Math.round(sum.z / ring.length));
  const filled = frames.filter(block => isFrameFilled(bot, block)).length;
  return { frames, center, filled };
}

/**
 * Move to the next search position around the triangulated point when no frame is in scan range
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Search step result
 */
async function searchForPortalRoom(bot, state) {
  const record = getEndPortalState(state);
  const anchor = state.stronghold?.estimate || getWaypoint(state, 'stronghold');
  if (!anchor) {
    return { success: false, message: "The stronghold is not located yet: use 'stronghold' to triangulate it first." };
  }

  const index = (record.searchIndex || 0) % SEARCH_OFFSETS.length;
  const [dx, dz] = SEARCH_OFFSETS[index];
  const target = { x: anchor.x + dx, y: bot.entity.position.y, z: anchor.z + dz };
  const leg = await travelTowards(bot, target, { radius: 10, ignoreY: true, legDistance: 56, timeoutMs: 35000 });

  if (leg.arrived || !leg.progressed) {
    // This position is exhausted (reached, or unreachable): scan from the next one
    record.searchIndex = (record.searchIndex || 0) + 1;
    persistProgress(state);
  }
  return {
    success: leg.arrived || leg.progressed,
    message: `No End portal frame within ${FRAME_SCAN_RADIUS} blocks; searching around the triangulated point (position ${index + 1}/${SEARCH_OFFSETS.length}).`
  };
}

/**
 * Insert Eyes of Ender into every empty frame the bot can reach
 * @param {object} bot Mineflayer bot instance
 * @param {Array<object>} emptyFrames Frame blocks without an eye
 * @param {number} [index=0] Current frame index
 * @param {number} [placed=0] Eyes placed so far
 * @returns {Promise<number>} Number of eyes inserted
 */
async function fillPortalFrames(bot, emptyFrames, index = 0, placed = 0) {
  if (index >= emptyFrames.length) return placed;
  const eyeItem = bot.inventory.items().find(i => i.name === 'ender_eye');
  if (!eyeItem) return placed;

  const frame = emptyFrames[index];
  let inserted = false;
  try {
    await approachPosition(bot, frame.position.offset(0.5, 1, 0.5), 3.5, 10000);
    await bot.equip(eyeItem, 'hand');
    await bot.lookAt(frame.position.offset(0.5, 0.9, 0.5), true);
    await bot.activateBlock(bot.blockAt(frame.position) || frame);
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(6);
    inserted = isFrameFilled(bot, bot.blockAt(frame.position));
  } catch (error) {
    console.warn(`[END PORTAL] Could not fill frame at (${frame.position.x}, ${frame.position.y}, ${frame.position.z}) :`, error.message);
  }

  return fillPortalFrames(bot, emptyFrames, index + 1, placed + (inserted ? 1 : 0));
}

/**
 * Wait until the server moves the bot into the End
 * @param {object} bot Mineflayer bot instance
 * @param {number} [ticksLeft=160] Remaining ticks to wait
 * @returns {Promise<boolean>} True once the bot is in the End
 */
async function waitForEndDimension(bot, ticksLeft = 160) {
  if (getDimension(bot) === 'the_end') return true;
  if (ticksLeft <= 0 || typeof bot.waitForTicks !== 'function') return false;
  await bot.waitForTicks(10);
  return waitForEndDimension(bot, ticksLeft - 10);
}

/**
 * Step into the active End portal and wait for the dimension change
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Entry result
 */
async function enterEndPortal(bot, state) {
  const portalId = bot.registry?.blocksByName?.end_portal?.id;
  const portalBlock = portalId ? bot.findBlock({ matching: portalId, maxDistance: 12 }) : null;
  if (!portalBlock) {
    return { success: false, message: 'All frames are filled but no active End portal block was found.' };
  }

  console.log(`[END PORTAL] Entering the End portal at (${portalBlock.position.x}, ${portalBlock.position.y}, ${portalBlock.position.z})...`);
  let navTimer = null;
  try {
    const { x, y, z } = portalBlock.position;
    const gotoPromise = bot.pathfinder.goto(new goals.GoalBlock(x, y, z));
    const timeoutPromise = new Promise((_, reject) => {
      navTimer = setTimeout(() => reject(new Error('Navigation timeout towards End portal')), 8000);
    });
    await Promise.race([gotoPromise, timeoutPromise]);
  } catch {
    // Fall through to a direct walk into the portal surface
  } finally {
    if (navTimer) clearTimeout(navTimer);
    bot.pathfinder.setGoal?.(null);
  }

  if (getDimension(bot) !== 'the_end') {
    try {
      await bot.lookAt(portalBlock.position.offset(0.5, 0.5, 0.5), true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await bot.waitForTicks(25);
    } finally {
      bot.clearControlStates?.();
    }
  }

  if (await waitForEndDimension(bot)) {
    setMilestone(state, 'entered_end', true);
    return { success: true, message: "Entered the End! Use 'dragon' to destroy the crystals and fight the Ender Dragon." };
  }
  return { success: false, message: 'Stepped towards the End portal but the dimension did not change yet.' };
}

/**
 * Find the End portal room, set the spawn bed, fill the frame with Eyes of Ender and enter the End
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {Promise<{ success: boolean, message: string }>} Step result
 */
async function skillEndPortal(bot, state) {
  const dimension = getDimension(bot);
  if (dimension === 'the_end') {
    return { success: true, message: "Already in the End. Use 'dragon' to fight the Ender Dragon." };
  }
  if (dimension !== 'overworld') {
    return { success: false, message: 'The End portal is in an Overworld stronghold: go back through the Nether portal first.' };
  }

  const record = getEndPortalState(state);
  let scan = scanPortalFrames(bot);
  if (!scan) {
    const known = record.center || getWaypoint(state, 'end_portal');
    if (known && Math.hypot(known.x - bot.entity.position.x, known.z - bot.entity.position.z) > 64) {
      const leg = await travelTowards(bot, { x: known.x, y: bot.entity.position.y, z: known.z }, { radius: 16, ignoreY: true, legDistance: 56, timeoutMs: 35000 });
      return leg.arrived || leg.progressed
        ? { success: true, message: `Returning to the End portal: ${Math.round(leg.remaining)} blocks remaining.` }
        : { success: false, message: `No progress towards the known End portal (${leg.error || 'path blocked'}).` };
    }
    return searchForPortalRoom(bot, state);
  }

  record.center = toPlainPosition(scan.center);
  record.frameCount = scan.frames.length;
  record.filledCount = scan.filled;
  saveWaypoint(state, 'end_portal', scan.center, 'overworld', 'End portal room');
  persistProgress(state);

  if (bot.entity.position.distanceTo(scan.center) > 7) {
    const leg = await travelTowards(bot, scan.center.offset(0, 1, 0), { radius: 4, timeoutMs: 40000 });
    if (!leg.arrived) {
      return leg.progressed
        ? { success: true, message: `End portal frame found at (${scan.center.x}, ${scan.center.y}, ${scan.center.z}); digging towards it, ${Math.round(leg.remaining)} blocks remaining.` }
        : { success: false, message: `End portal frame found but no progress towards it (${leg.error || 'path blocked'}).` };
    }
    scan = scanPortalFrames(bot, 24) || scan;
  }

  // The respawn point must be next to the portal before the one-way trip into the End
  const bed = await ensureSpawnBed(bot, state, 'end_spawn_bed', { reuseRange: 32 });
  if (!bed.success) {
    return { success: false, message: `Spawn bed required before entering the End: ${bed.message}` };
  }

  const emptyFrames = scan.frames.filter(block => !isFrameFilled(bot, block));
  if (emptyFrames.length > 0) {
    const eyesAvailable = countItem(bot, 'ender_eye');
    const placed = await fillPortalFrames(bot, emptyFrames);
    const rescan = scanPortalFrames(bot, 24) || scan;
    record.filledCount = rescan.filled;
    record.frameCount = rescan.frames.length;
    persistProgress(state);

    const stillEmpty = rescan.frames.length - rescan.filled;
    if (stillEmpty > 0) {
      const shortage = Math.max(0, stillEmpty - countItem(bot, 'ender_eye'));
      const reason = shortage > 0
        ? `${shortage} more 'ender_eye' needed (had ${eyesAvailable})`
        : 'some frames were out of reach, retrying';
      return {
        success: placed > 0,
        message: `End portal frame ${rescan.filled}/${config.END_PORTAL_FRAME_COUNT} filled: ${reason}.`
      };
    }
  }

  return enterEndPortal(bot, state);
}

module.exports = {
  skillEndPortal,
  scanPortalFrames,
  isFrameFilled,
  fillPortalFrames,
  enterEndPortal,
  getEndPortalState,
  SEARCH_OFFSETS
};
