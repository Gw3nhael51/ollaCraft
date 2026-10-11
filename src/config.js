require("dotenv").config();

module.exports = {
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen2.5:27b',
  AUTH_PASSWORD: process.env.MC_PASSWORD || '',
  BOT_CONFIG: {
    host: process.env.MC_HOST || 'localhost',
    port: Number.parseInt(process.env.MC_PORT) || 25565,
    username: process.env.MC_USERNAME || 'Ollama',
    version: '1.20.4'
  },

  SOFT_BLOCKS: new Set(['dirt', 'grass_block', 'sand', 'gravel', 'stone', 'cobblestone', 'clay']),
  VALID_GROUND_BLOCKS: new Set(['grass_block', 'dirt', 'stone', 'sand', 'cobblestone', 'deepslate', 'gravel']),
  VALID_ACTIONS: new Set(['mine', 'explore', 'craft', 'place', 'unstuck', 'smelt', 'eat', 'wiki', 'hunt', 'fight']),
  QUEST_CHAIN: ['wooden_axe', 'wooden_pickaxe', 'cobblestone', 'stone_pickaxe', 'stone_axe', 'furnace', 'raw_iron', 'iron_ingot', 'iron_pickaxe', 'diamond_pickaxe'],
  QUEST_AMOUNT: { cobblestone: 3, raw_iron: 3, iron_ore: 3, iron_ingot: 3 },
  TOOL_SUFFIXES: ['_pickaxe', '_axe', '_shovel', '_sword', '_hoe']
};
