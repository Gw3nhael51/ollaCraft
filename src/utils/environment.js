const { Vec3 } = require('vec3');
const { isOreBlock } = require('./wikiData');

/**
 * Scan cubic blocks in a given radius around the bot's current position
 * @param {object} bot Mineflayer bot instance
 * @param {number} radius Scanning radius in blocks
 * @returns {Record<string, number>} Dictionary of block types and occurrence counts
 */
function scanEnvironment(bot, radius) {
  const blocks = {};
  const botPosition = bot.entity.position.floored();
  const targetPos = new Vec3(0, 0, 0);
  const yMin = Math.max(-8, -radius);
  const yMax = Math.min(8, radius);

  for (let x = -radius; x <= radius; x++) {
    for (let y = yMin; y <= yMax; y++) {
      for (let z = -radius; z <= radius; z++) {
        targetPos.set(botPosition.x + x, botPosition.y + y, botPosition.z + z);
        const block = bot.blockAt(targetPos);
        if (block && block.name !== 'air' && block.name !== 'cave_air') {
          blocks[block.name] = (blocks[block.name] || 0) + 1;
        }
      }
    }
  }
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
  const exposedOres = {};
  const botPosition = bot.entity.position.floored();
  const targetPos = new Vec3(0, 0, 0);
  const yMin = Math.max(-8, -radius);
  const yMax = Math.min(8, radius);

  for (let x = -radius; x <= radius; x++) {
    for (let y = yMin; y <= yMax; y++) {
      for (let z = -radius; z <= radius; z++) {
        targetPos.set(botPosition.x + x, botPosition.y + y, botPosition.z + z);
        const block = bot.blockAt(targetPos);
        if (block && isOreBlock(block.name) && isBlockExposedToAir(bot, block)) {
          exposedOres[block.name] = (exposedOres[block.name] || 0) + 1;
        }
      }
    }
  }

  return exposedOres;
}

module.exports = {
  scanEnvironment,
  checkTerrainSituation,
  scanNearbyEntities,
  getCurrentBiome,
  scanExposedOres,
  isBlockExposedToAir,
  VALUABLE_ORES
};
