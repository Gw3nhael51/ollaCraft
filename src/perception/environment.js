const { Vec3 } = require('vec3');
const { isOreBlock } = require('../minecraft/wikiData');

const BAD_BLOCK_TTL_MS = 120000;
const badBlocksRegistry = new Map();

/**
 * Marquer une position de bloc comme temporairement inaccessible
 * @param {object} pos Coordonnées du bloc
 * @param {number} [ttlMs=BAD_BLOCK_TTL_MS] Durée d'expiration en millisecondes
 */
function markBadBlock(pos, ttlMs = BAD_BLOCK_TTL_MS) {
  if (!pos) return;
  const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  badBlocksRegistry.set(key, Date.now() + ttlMs);
}

/**
 * Vérifier si une position de bloc est actuellement dans la liste noire temporaire
 * @param {object} pos Coordonnées du bloc
 * @param {number} [now=Date.now()] Horodatage de référence
 * @returns {boolean} Vrai si le bloc est encore bloqué
 */
function isBadBlock(pos, now = Date.now()) {
  if (!pos) return false;
  const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  const expiresAt = badBlocksRegistry.get(key);
  if (!expiresAt) return false;
  if (now >= expiresAt) {
    badBlocksRegistry.delete(key);
    return false;
  }
  return true;
}

/**
 * Réinitialiser la liste noire temporaire des blocs (ex: après réapparition)
 */
function clearBadBlocks() {
  badBlocksRegistry.clear();
}

const WATER_BLOCK_NAMES = new Set(['water', 'flowing_water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const FLOODED_ZONE_TTL_MS = 15 * 60 * 1000;
const FLOODED_ZONE_RADIUS = 14;
const HORIZONTAL_OFFSETS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const floodedZones = [];

/**
 * Check whether a block is water (or a plant that only exists under water)
 * @param {object|null} block Candidate block
 * @returns {boolean} True if the bot cannot breathe in this block
 */
function isWaterBlock(block) {
  return Boolean(block?.name && WATER_BLOCK_NAMES.has(block.name));
}

/**
 * Check whether reaching a block means working under water: water right above it or on several sides
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Candidate target block (with position)
 * @returns {boolean} True if the block sits in or under water
 */
function isBlockSubmerged(bot, block) {
  if (!block?.position || typeof bot.blockAt !== 'function') return false;
  if (isWaterBlock(bot.blockAt(block.position.offset(0, 1, 0)))) return true;
  const wetSides = HORIZONTAL_OFFSETS.filter(offset => isWaterBlock(bot.blockAt(block.position.plus(offset)))).length;
  return wetSides >= 2;
}

/**
 * Remember a flooded cave or mine the bot had to escape from, so it works somewhere else for a while
 * @param {object} pos Position where the bot was trapped under water
 * @param {number} [radius=FLOODED_ZONE_RADIUS] Radius of the area to avoid
 * @param {number} [ttlMs=FLOODED_ZONE_TTL_MS] How long the area is avoided
 */
function markFloodedZone(pos, radius = FLOODED_ZONE_RADIUS, ttlMs = FLOODED_ZONE_TTL_MS) {
  if (!pos) return;
  floodedZones.push({ x: pos.x, y: pos.y, z: pos.z, radius, expiresAt: Date.now() + ttlMs });
  if (floodedZones.length > 12) floodedZones.shift();
}

/**
 * Check whether a position lies inside an area recently recorded as flooded
 * @param {object} pos Position to test
 * @param {number} [now=Date.now()] Reference timestamp
 * @returns {boolean} True if the position should be avoided
 */
function isInFloodedZone(pos, now = Date.now()) {
  if (!pos) return false;
  for (let i = floodedZones.length - 1; i >= 0; i--) {
    const zone = floodedZones[i];
    if (now >= zone.expiresAt) {
      floodedZones.splice(i, 1);
      continue;
    }
    if (Math.hypot(pos.x - zone.x, pos.y - zone.y, pos.z - zone.z) <= zone.radius) return true;
  }
  return false;
}

/**
 * Forget every recorded flooded area
 */
function clearFloodedZones() {
  floodedZones.length = 0;
}

const KNOWN_LAVA_LIMIT = 64;
const knownLavaRegistry = new Map();

/**
 * Remember a lava source block position for later Nether portal casting
 * @param {object} pos Lava source coordinates
 * @param {string} [dimension='overworld'] Dimension where the lava was seen
 */
function rememberLava(pos, dimension = 'overworld') {
  if (!pos) return;
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const z = Math.floor(pos.z);
  const key = `${dimension}:${x},${y},${z}`;
  knownLavaRegistry.delete(key);
  knownLavaRegistry.set(key, { position: new Vec3(x, y, z), dimension, seenAt: Date.now() });
  if (knownLavaRegistry.size > KNOWN_LAVA_LIMIT) {
    knownLavaRegistry.delete(knownLavaRegistry.keys().next().value);
  }
}

/**
 * List remembered lava sources sorted by distance, skipping blacklisted ones
 * @param {object|null} fromPos Reference position for distance sorting
 * @param {string} [dimension='overworld'] Dimension filter
 * @returns {Array<{ position: Vec3, dimension: string, seenAt: number }>} Sorted remembered lava entries
 */
function getKnownLava(fromPos, dimension = 'overworld') {
  const entries = [...knownLavaRegistry.values()]
    .filter(entry => entry.dimension === dimension && !isBadBlock(entry.position));
  if (!fromPos) return entries;
  return entries.sort((a, b) => a.position.distanceTo(fromPos) - b.position.distanceTo(fromPos));
}

/**
 * Forget remembered lava sources around a position (ex: unusable pool)
 * @param {object} centerPos Center coordinates
 * @param {number} [radius=8] Forget radius in blocks
 */
function forgetLava(centerPos, radius = 8) {
  if (!centerPos) return;
  for (const [key, entry] of knownLavaRegistry) {
    if (entry.position.distanceTo(centerPos) <= radius) knownLavaRegistry.delete(key);
  }
}

/**
 * Clear every remembered lava source
 */
function clearKnownLava() {
  knownLavaRegistry.clear();
}

/**
 * Record a single scanned block and check whether it is an exposed ore within oreRadius
 * @param {object} bot Mineflayer bot instance
 * @param {Record<string, number>} blocks Aggregated block counts
 * @param {Record<string, number>} exposedOres Aggregated exposed ore counts
 * @param {Vec3} targetPos Coordinates of scanned block
 * @param {boolean} withinOreRadius Whether position falls within ore detection radius
 */
function recordScannedBlock(bot, blocks, exposedOres, targetPos, withinOreRadius) {
  const block = bot.blockAt(targetPos);
  if (!block || AIR_BLOCK_NAMES.has(block.name)) return;
  if (isBadBlock(targetPos)) return;

  blocks[block.name] = (blocks[block.name] || 0) + 1;
  if (block.name === 'lava' && (!block.metadata || block.metadata === 0)) {
    rememberLava(targetPos, bot.game?.dimension || 'overworld');
  }
  if (!withinOreRadius || !isOreBlock(block.name)) return;

  const blockWithPos = block.position ? block : { ...block, position: targetPos.clone() };
  if (isBlockExposedToAir(bot, blockWithPos)) {
    exposedOres[block.name] = (exposedOres[block.name] || 0) + 1;
  }
}

/**
 * Scan cubic blocks and exposed ores in a single pass around the bot's current position
 * @param {object} bot Mineflayer bot instance
 * @param {number} radius Scanning radius in blocks
 * @param {number} [oreRadius] Sub-radius for exposed ore inspection
 * @returns {Record<string, number>} Dictionary of block types and occurrence counts (with non-enumerable exposedOres)
 */
function scanEnvironment(bot, radius, oreRadius = 16) {
  const blocks = {};
  const exposedOres = {};
  const botPosition = bot.entity.position.floored();
  const targetPos = new Vec3(0, 0, 0);
  const yMin = Math.max(-8, -radius);
  const yMax = Math.min(8, radius);

  for (let x = -radius; x <= radius; x++) {
    const inOreX = Math.abs(x) <= oreRadius;
    for (let y = yMin; y <= yMax; y++) {
      for (let z = -radius; z <= radius; z++) {
        targetPos.set(botPosition.x + x, botPosition.y + y, botPosition.z + z);
        recordScannedBlock(bot, blocks, exposedOres, targetPos, inOreX && Math.abs(z) <= oreRadius);
      }
    }
  }

  Object.defineProperty(blocks, 'exposedOres', {
    value: exposedOres,
    enumerable: false,
    configurable: true
  });
  return blocks;
}

/**
 * Analyze immediate obstacles around the bot to detect whether it is trapped in a hole
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Description textuelle de la situation du terrain
 */
function checkTerrainSituation(bot) {
  const pos = bot.entity.position.floored();

  // Check water immersion first
  const eyeBlock = bot.blockAt(pos.offset(0, 1, 0));
  if (eyeBlock && (eyeBlock.name === 'water' || eyeBlock.name === 'flowing_water')) {
    return "Sous l'eau ! Risque de noyade imminent. Action recommandée : unstuck.";
  }

  // Floating or wading: digging is five times slower and most skills misbehave, so get out first
  if (bot.entity.isInLava) {
    return "Dans la lave ! Danger de mort. Action recommandée : unstuck.";
  }
  if (bot.entity.isInWater) {
    return "Dans l'eau (tête hors de l'eau) : rejoins la terre ferme avant d'agir. Action recommandée : unstuck.";
  }

  // Verify whether overhead clearance is obstructed
  const headAboveBlock = bot.blockAt(pos.offset(0, 2, 0));
  const isCeilingBlocked = headAboveBlock?.boundingBox === 'block';

  const directions = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ];

  let solidSides = 0;
  
  for (const dir of directions) {
    const feetBlock = bot.blockAt(pos.plus(dir));
    const sideEyeBlock = bot.blockAt(pos.plus(dir).offset(0, 1, 0));
    if (feetBlock?.boundingBox === 'block' && sideEyeBlock?.boundingBox === 'block') {
      solidSides++;
    }
  }

  // Consider bot trapped if surrounded and ceiling is blocked
  if (solidSides >= 4 && isCeilingBlocked) {
    return "Enfermé sous terre avec plafond bloqué. Action recommandée : unstuck.";
  }

  if (solidSides >= 4) {
    return "Dans un puits profond de 1x1. Action recommandée : unstuck.";
  }

  return "Terrain libre.";
}

// Natural terrain forming a cave or mine ceiling. Leaves, logs and buildings stand on the surface and never count
const TERRAIN_CEILING_BLOCKS = new Set([
  'stone', 'dirt', 'grass_block', 'deepslate', 'granite', 'diorite', 'andesite',
  'gravel', 'sand', 'sandstone', 'tuff', 'cobblestone', 'cobbled_deepslate', 'netherrack',
  'calcite', 'dripstone_block', 'clay', 'terracotta', 'red_sand', 'red_sandstone', 'coarse_dirt', 'rooted_dirt'
]);
// Below this altitude no tree grows in the Overworld, even under open sky (sea level is 63): pits and ravines count as underground
const SURFACE_MIN_Y = 58;
// Highest block of the Overworld
const WORLD_TOP_Y = 320;

/**
 * Find the highest natural terrain block in the column above the bot
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxRise] How far above the feet to look (defaults to the top of the world)
 * @returns {number|null} Altitude of the topmost terrain block above, or null under open sky
 */
function findTerrainTopAbove(bot, maxRise = null) {
  const pos = bot?.entity?.position;
  if (!pos || typeof bot.blockAt !== 'function') return null;
  const base = pos.floored();
  const rise = maxRise ?? WORLD_TOP_Y - base.y;
  let top = null;
  for (let dy = 2; dy <= rise; dy++) {
    const block = bot.blockAt(base.offset(0, dy, 0));
    if (block && TERRAIN_CEILING_BLOCKS.has(block.name)) top = base.y + dy;
  }
  return top;
}

/**
 * Check whether solid terrain blocks sit above the bot, indicating an enclosed cave or overhang
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxRise=20] How far above the feet to look
 * @returns {boolean} True when a terrain ceiling block is found within that height
 */
function hasTerrainAbove(bot, maxRise = 20) {
  return findTerrainTopAbove(bot, maxRise) !== null;
}

/**
 * Tell whether the bot is cut off from the surface of the Overworld: under a rock ceiling (cave, mine)
 * or deep in a pit or ravine where no tree or animal can be found
 * @param {object} bot Mineflayer bot instance
 * @returns {boolean} True when surface resources require climbing back up first
 */
function isBelowSurface(bot) {
  const pos = bot?.entity?.position;
  if (!pos) return false;
  if (pos.y < SURFACE_MIN_Y) return true;
  return findTerrainTopAbove(bot) !== null;
}

/**
 * Estimate the altitude where the bot will stand once out of its cave or mine
 * @param {object} bot Mineflayer bot instance
 * @returns {number} Surface altitude estimate
 */
function estimateSurfaceY(bot) {
  const top = findTerrainTopAbove(bot);
  return top === null ? SURFACE_MIN_Y + 4 : top + 1;
}

/**
 * Count living entities (passive and hostile mobs) close to the bot
 * @param {object} bot Mineflayer bot instance
 * @param {number} radius Detection radius in blocks
 * @returns {Record<string, number>} Dictionnaire des noms d'entités et quantités
 */
function scanNearbyEntities(bot, radius = 20) {
  const entities = {};
  if (!bot.entities) return entities;
  for (const id in bot.entities) {
    const entity = bot.entities[id];
    if (!entity || entity === bot.entity || !entity.name) continue;
    if (entity.type !== 'mob' && entity.type !== 'animal' && entity.type !== 'hostile') continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist <= radius) {
      entities[entity.name] = (entities[entity.name] || 0) + 1;
    }
  }
  return entities;
}

/**
 * Return current biome name of the bot position
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Nom du biome ou 'plains' par défaut
 */
function getCurrentBiome(bot) {
  const block = bot.blockAt(bot.entity.position);
  if (!block?.biome) return 'plains';
  const biomeEntry = bot.registry?.biomes?.[block.biome];
  return biomeEntry?.name || 'plains';
}

const VALUABLE_ORES = {
  has: (name) => isOreBlock(name)
};

const AIR_BLOCK_NAMES = new Set(['air', 'cave_air', 'void_air']);

const ADJACENT_OFFSETS = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];

/**
 * Verify if a given block has at least one face exposed to air and free of lava
 * @param {object} bot Mineflayer bot instance
 * @param {object} block Bloc à inspecter
 * @returns {boolean} True si le bloc est directement exposé à l'air
 */
function isBlockExposedToAir(bot, block) {
  if (!block?.position) return false;
  let touchesAir = false;

  for (const offset of ADJACENT_OFFSETS) {
    const neighbor = bot.blockAt(block.position.plus(offset));
    if (!neighbor) continue;
    if (neighbor.name === 'lava' || neighbor.name === 'flowing_lava') {
      return false;
    }
    if (AIR_BLOCK_NAMES.has(neighbor.name)) {
      touchesAir = true;
    }
  }

  return touchesAir;
}

/**
 * Scan valuable ores exposed to air inside nearby cavities around the bot
 * @param {object} bot Mineflayer bot instance
 * @param {number} radius Detection radius in blocks
 * @returns {Record<string, number>} Dictionnaire des minerais exposés et leurs quantités
 */
function scanExposedOres(bot, radius = 16) {
  return scanEnvironment(bot, radius, radius).exposedOres;
}

module.exports = {
  scanEnvironment,
  checkTerrainSituation,
  scanNearbyEntities,
  getCurrentBiome,
  scanExposedOres,
  isBlockExposedToAir,
  markBadBlock,
  isBadBlock,
  clearBadBlocks,
  isWaterBlock,
  isBlockSubmerged,
  markFloodedZone,
  isInFloodedZone,
  clearFloodedZones,
  findTerrainTopAbove,
  hasTerrainAbove,
  isBelowSurface,
  estimateSurfaceY,
  SURFACE_MIN_Y,
  rememberLava,
  getKnownLava,
  forgetLava,
  clearKnownLava,
  VALUABLE_ORES
};
