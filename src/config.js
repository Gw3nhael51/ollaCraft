module.exports = {
  BOT_CONFIG: {
    host: 'localhost',
    port: 25565,
    username: 'Herobrine',
    version: '1.20.4'
  },
  CRAFT_2X2: new Set(['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'stick', 'crafting_table']),
  SOFT_BLOCKS: new Set(['dirt', 'grass_block', 'sand', 'gravel', 'stone', 'cobblestone', 'clay']),
  VALID_GROUND_BLOCKS: new Set(['grass_block', 'dirt', 'stone', 'sand', 'cobblestone', 'deepslate', 'gravel']),
  VALID_ACTIONS: new Set(['mine', 'explore', 'craft', 'place', 'unstuck']),
  QUEST_CHAIN: ['wooden_axe', 'wooden_pickaxe', 'cobblestone', 'stone_pickaxe', 'stone_axe', 'furnace'],
  QUEST_AMOUNT: { cobblestone: 3 },
  TOOL_SUFFIXES: ['_pickaxe', '_axe', '_shovel', '_sword', '_hoe']
};
