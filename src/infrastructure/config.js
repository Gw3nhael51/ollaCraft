/**
 * Central configuration module for bot credentials, progression, and blocks
 */
require("dotenv").config();

/**
 * Parse a positive integer environment variable with a fallback value
 * @param {string|undefined} raw Raw environment value
 * @param {number} fallback Default value when missing or invalid
 * @returns {number} Parsed positive integer
 */
function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen3.5:9B',
  OLLAMA_MODEL_PLAYER: process.env.OLLAMA_MODEL_PLAYER || process.env.OLLAMA_MODEL || 'qwen3.5:9B',
  OLLAMA_MODEL_MANAGER: process.env.OLLAMA_MODEL_MANAGER || process.env.OLLAMA_MODEL || 'qwen3.5:9B',
  // Explicit context window: the ReAct prompt exceeds Ollama's small default and would be silently truncated
  OLLAMA_NUM_CTX: parsePositiveInt(process.env.OLLAMA_NUM_CTX, 8192),
  // Hard cap on generated tokens. The schema bounds the "thought" length, so this is only a safety net:
  // it must stay comfortably above a complete answer or the JSON gets cut before its closing brace
  OLLAMA_NUM_PREDICT: parsePositiveInt(process.env.OLLAMA_NUM_PREDICT, 512),
  // Keep the model loaded between cycles to avoid reload latency
  OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '30m',
  AUTH_PASSWORD: process.env.MC_PASSWORD || '',
  // Whether the server runs an auth plugin (/register, /login). Defaults to true when a password is set.
  AUTH_ENABLED: process.env.MC_AUTH_PLUGIN === undefined
    ? Boolean(process.env.MC_PASSWORD)
    : ['true', '1', 'yes', 'on'].includes(process.env.MC_AUTH_PLUGIN.trim().toLowerCase()),
  BOT_CONFIG: {
    host: process.env.MC_HOST || 'localhost',
    port: Number.parseInt(process.env.MC_PORT) || 25565,
    username: process.env.MC_USERNAME || 'Ollama',
    version: process.env.MC_VERSION || '1.20.4'
  },

  SOFT_BLOCKS: new Set(['dirt', 'grass_block', 'sand', 'gravel', 'stone', 'cobblestone', 'clay']),
  VALID_GROUND_BLOCKS: new Set([
    'grass_block', 'dirt', 'stone', 'sand', 'cobblestone', 'deepslate',
    'cobbled_deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'obsidian', 'gravel'
  ]),
  VALID_ACTIONS: new Set([
    'mine', 'explore', 'craft', 'place', 'unstuck', 'smelt', 'eat', 'wiki', 'hunt', 'fight', 'chest', 'equip', 'portal', 'procedure',
    'goto', 'bed', 'stronghold', 'endportal', 'dragon'
  ]),
  QUEST_CHAIN: [
    'wooden_pickaxe',
    'cobblestone',
    'stone_pickaxe',
    'furnace',
    'raw_iron',
    'iron_ingot',
    'iron_pickaxe',
    'iron_sword',
    'shield',
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots',
    'bucket',
    'water_bucket',
    'flint_and_steel',
    'bed',
    'nether_portal',
    'blaze_rod',
    'blaze_powder',
    'ender_pearl',
    'ender_eye',
    'bow',
    'arrow',
    'end_bed',
    'stronghold',
    'end_portal',
    'ender_dragon'
  ],
  QUEST_AMOUNT: {
    cobblestone: 3,
    raw_iron: 3,
    iron_ore: 3,
    iron_ingot: 3,
    bucket: 1,
    water_bucket: 1,
    flint_and_steel: 1,
    bed: 1,
    nether_portal: 1,
    blaze_rod: 7,
    blaze_powder: 14,
    ender_pearl: 14,
    ender_eye: 14,
    bow: 1,
    arrow: 24,
    end_bed: 1,
    stronghold: 1,
    end_portal: 1,
    ender_dragon: 1
  },
  // Eyes needed to fill a whole End portal frame, plus the two throws used for triangulation
  END_PORTAL_FRAME_COUNT: 12,
  EYE_TRIANGULATION_THROWS: 2,
  // Sideways distance walked between the two eye throws; larger baseline means a more accurate intersection
  EYE_TRIANGULATION_BASELINE: parsePositiveInt(process.env.EYE_TRIANGULATION_BASELINE, 250),
  TOOL_SUFFIXES: ['_pickaxe', '_axe', '_shovel', '_sword', '_hoe', '_helmet', '_chestplate', '_leggings', '_boots', 'shield'],
  CRAFTING_TABLE_RANGE: 32,
  // The crafting table is carried: only a table this close is reused, otherwise the carried one is deployed
  PORTABLE_TABLE_REUSE_RANGE: 6,
  // Skip the LLM whenever the dependency planner already knows the next feasible step
  DETERMINISTIC_PLANNER: process.env.DETERMINISTIC_PLANNER !== 'false',
  // A spawn bed must be set before entering the Nether and before entering the End
  REQUIRE_SPAWN_BED: process.env.REQUIRE_SPAWN_BED !== 'false',
  // Radius around the world spawn where a server with operators refuses block placement and breaking
  // (server.properties "spawn-protection"). Once a refusal is seen there, the bot leaves the area before building
  SPAWN_PROTECTION_RADIUS: parsePositiveInt(process.env.SPAWN_PROTECTION_RADIUS, 16)
};
