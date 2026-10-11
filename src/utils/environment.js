const { Vec3 } = require('vec3');

/**
 * Scanne les blocs cubiques dans un rayon donné autour de la position actuelle du bot
 * @param {object} bot Instance Mineflayer du bot
 * @param {number} radius Rayon de balayage en blocs
 * @returns {Record<string, number>} Dictionnaire des types de blocs et de leurs occurrences
 */
function scanEnvironment(bot, radius) {
  const blocks = {};
  const botPosition = bot.entity.position.floored();

  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      for (let z = -radius; z <= radius; z++) {
        const targetPos = botPosition.offset(x, y, z);
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
 * Analyse les obstacles immédiats autour du bot pour détecter s'il est bloqué dans un trou
 * @param {object} bot Instance Mineflayer du bot
 * @returns {string} Description textuelle de la situation du terrain
 */
function checkTerrainSituation(bot) {
  const pos = bot.entity.position.floored();

  // Détection prioritaire : immersion dans l'eau
  const eyeBlock = bot.blockAt(pos.offset(0, 1, 0));
  if (eyeBlock && (eyeBlock.name === 'water' || eyeBlock.name === 'flowing_water')) {
    return "Sous l'eau ! Risque de noyade imminent. Action recommandée : unstuck.";
  }

  // Vérifier si la tête et le dessus sont dégagés
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

  // N'est considéré bloqué que si les 4 côtés sont fermés ET le dessus est fermé, ou 4 côtés fermés avec impossibilité de sauter
  if (solidSides >= 4 && isCeilingBlocked) {
    return "Enfermé sous terre avec plafond bloqué. Action recommandée : unstuck.";
  }

  if (solidSides >= 4) {
    return "Dans un puits profond de 1x1. Action recommandée : unstuck.";
  }

  return "Terrain libre.";
}

/**
 * Dénombre les entités vivantes (mobs passifs et hostiles) proches du bot
 * @param {object} bot Instance Mineflayer du bot
 * @param {number} radius Rayon de détection en blocs
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
 * Retourne le nom du biome actuel du bot
 * @param {object} bot Instance Mineflayer du bot
 * @returns {string} Nom du biome ou 'plains' par défaut
 */
function getCurrentBiome(bot) {
  const block = bot.blockAt(bot.entity.position);
  if (!block?.biome) return 'plains';
  const biomeEntry = bot.registry?.biomes?.[block.biome];
  return biomeEntry?.name || 'plains';
}

const VALUABLE_ORES = new Set([
  'coal_ore', 'deepslate_coal_ore',
  'iron_ore', 'deepslate_iron_ore',
  'copper_ore', 'deepslate_copper_ore',
  'gold_ore', 'deepslate_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'diamond_ore', 'deepslate_diamond_ore',
  'emerald_ore', 'deepslate_emerald_ore'
]);

const AIR_BLOCK_NAMES = new Set(['air', 'cave_air', 'void_air']);

const ADJACENT_OFFSETS = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];

/**
 * Vérifie si un bloc donné a au moins une face en contact avec l'air et sans lave
 * @param {object} bot Instance Mineflayer du bot
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
 * Scanne les minerais précieux exposés à l'air dans les cavités proches du bot
 * @param {object} bot Instance Mineflayer du bot
 * @param {number} radius Rayon de détection en blocs
 * @returns {Record<string, number>} Dictionnaire des minerais exposés et leurs quantités
 */
function scanExposedOres(bot, radius = 16) {
  const exposedOres = {};
  const botPosition = bot.entity.position.floored();

  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      for (let z = -radius; z <= radius; z++) {
        const targetPos = botPosition.offset(x, y, z);
        const block = bot.blockAt(targetPos);
        if (block && VALUABLE_ORES.has(block.name) && isBlockExposedToAir(bot, block)) {
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
