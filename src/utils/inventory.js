const config = require('../config');

function countItem(bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0);
}

function hasToolType(bot, suffix) {
  return bot.inventory.items().some(i => i.name.endsWith(suffix));
}

function getOwnedTools(bot) {
  const tools = bot.inventory.items().filter(i => config.TOOL_SUFFIXES.some(s => i.name.endsWith(s))).map(i => i.name);
  return [...new Set(tools)];
}

function isQuestDone(bot, name) {
  if (name === 'cobblestone') return countItem(bot, 'cobblestone') >= config.QUEST_AMOUNT.cobblestone || countItem(bot, 'stone_pickaxe') > 0;
  return countItem(bot, name) >= (config.QUEST_AMOUNT[name] || 1);
}

function syncObjective(bot, state) {
  if (state.manualObjective) return;
  const next = config.QUEST_CHAIN.find(name => !isQuestDone(bot, name)) || config.QUEST_CHAIN.at(-1);
  if (next !== state.currentObjective) {
    const old = state.currentObjective;
    state.currentObjective = next;
    bot.chat(`🚀 NOUVEAU PALIER : ${state.currentObjective}`);
    state.lastActionResult = {
      ...state.lastActionResult,
      message: `${state.lastActionResult.message} | Palier '${old}' terminé. NOUVEL objectif : obtenir '${state.currentObjective}'.`
    };
  }
}

function getInventorySummary(bot) {
  const items = bot.inventory.items();
  if (items.length === 0) return "Inventaire vide";
  const inv = {};
  items.forEach(item => {
    inv[item.name] = (inv[item.name] || 0) + item.count;
  });
  return JSON.stringify(inv);
}

function getAvailableCrafts(bot, craftingTable) {
  const commonItems = ['oak_planks', 'stick', 'crafting_table', 'wooden_axe', 'wooden_pickaxe', 'stone_pickaxe', 'stone_axe', 'furnace', 'wooden_sword'];
  const available = [];
  const hasTableInInv = countItem(bot, 'crafting_table') > 0;
  const dummyTable = craftingTable || (hasTableInInv ? { type: bot.registry.blocksByName['crafting_table']?.id, name: 'crafting_table' } : null);

  for (const name of commonItems) {
    const item = bot.registry.itemsByName[name];
    if (!item) continue;
    const tableToUse = config.CRAFT_2X2.has(name) ? null : dummyTable;
    const recipes = bot.recipesFor(item.id, null, 1, tableToUse);
    
    if (recipes.length > 0) {
      if (!craftingTable && !config.CRAFT_2X2.has(name)) {
        available.push(`${name} (nécessite de poser ton établi d'abord)`);
      } else {
        available.push(name);
      }
    }
  }
  return available;
}

function getBestToolForBlock(bot, block) {
  const items = bot.inventory.items();
  const name = block.name;
  if (name.includes('stone') || name.includes('cobble') || name.includes('ore') || name.includes('deepslate')) {
    return items.find(i => i.name.endsWith('_pickaxe'));
  }
  if (name.includes('log') || name.includes('wood') || name.includes('planks') || name === 'crafting_table') {
    return items.find(i => i.name.endsWith('_axe'));
  }
  if (name.includes('dirt') || name.includes('grass') || name.includes('sand') || name.includes('gravel') || name.includes('clay')) {
    return items.find(i => i.name.endsWith('_shovel'));
  }
  return null;
}

module.exports = {
  countItem, hasToolType, getOwnedTools, isQuestDone, syncObjective,
  getInventorySummary, getAvailableCrafts, getBestToolForBlock
};
