/**
 * Central configuration module for bot credentials, progression, and blocks
 */
require("dotenv").config();

module.exports = {
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen3.5:9B',
  OLLAMA_MODEL_PLAYER: process.env.OLLAMA_MODEL_PLAYER || process.env.OLLAMA_MODEL || 'qwen3.5:9B',
  OLLAMA_MODEL_MANAGER: process.env.OLLAMA_MODEL_MANAGER || process.env.OLLAMA_MODEL || 'qwen3.5:9B',
  AUTH_PASSWORD: process.env.MC_PASSWORD || '',
  BOT_CONFIG: {
    host: process.env.MC_HOST || 'localhost',
    port: Number.parseInt(process.env.MC_PORT) || 25565,
    username: process.env.MC_USERNAME || 'Ollama',
    version: '1.20.4'
  },

  SOFT_BLOCKS: new Set(['dirt', 'grass_block', 'sand', 'gravel', 'stone', 'cobblestone', 'clay']),
  VALID_GROUND_BLOCKS: new Set(['grass_block', 'dirt', 'stone', 'sand', 'cobblestone', 'deepslate', 'gravel']),
  VALID_ACTIONS: new Set(['mine', 'explore', 'craft', 'place', 'unstuck', 'smelt', 'eat', 'wiki', 'hunt', 'fight', 'chest', 'equip', 'portal']),
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
    'bucket',
    'water_bucket',
    'flint_and_steel',
    'nether_portal',
    'blaze_rod',
    'blaze_powder',
    'ender_pearl',
    'ender_eye'
  ],
  QUEST_AMOUNT: {
    cobblestone: 3,
    raw_iron: 3,
    iron_ore: 3,
    iron_ingot: 3,
    bucket: 1,
    water_bucket: 1,
    flint_and_steel: 1,
    nether_portal: 1,
    blaze_rod: 7,
    blaze_powder: 12,
    ender_pearl: 12,
    ender_eye: 12
  },
  TOOL_SUFFIXES: ['_pickaxe', '_axe', '_shovel', '_sword', '_hoe', '_helmet', '_chestplate', '_leggings', '_boots', 'shield']
};
