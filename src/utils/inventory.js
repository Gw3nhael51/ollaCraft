const config = require('../config');

/**
 * Compte la quantité totale d'un objet donné dans l'inventaire
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} name Nom de l'item recherché
 * @returns {number} Quantité cumulée de l'item
 */
function countItem(bot, name) {
  return bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

/**
 * Vérifie si le bot possède au moins un outil d'un type spécifique
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} suffix Suffixe du type d'outil (ex: '_pickaxe', '_axe')
 * @returns {boolean} True si un outil correspondant est possédé
 */
function hasToolType(bot, suffix) {
  return bot.inventory.items().some(item => item.name.endsWith(suffix));
}

/**
 * Retourne la liste dédoublée des outils présents dans l'inventaire
 * @param {object} bot Instance Mineflayer du bot
 * @returns {string[]} Liste des noms d'outils possédés
 */
function getOwnedTools(bot) {
  const tools = bot.inventory.items()
    .filter(item => config.TOOL_SUFFIXES.some(suffix => item.name.endsWith(suffix)))
    .map(item => item.name);
  return [...new Set(tools)];
}

/**
 * Détermine si un objectif de quête est atteint selon l'inventaire actuel
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} questName Nom de l'objectif à vérifier
 * @returns {boolean} True si l'objectif est complété
 */
function isQuestDone(bot, questName) {
  if (questName === 'cobblestone') {
    const requiredAmount = config.QUEST_AMOUNT.cobblestone || 3;
    return countItem(bot, 'cobblestone') >= requiredAmount || countItem(bot, 'stone_pickaxe') > 0;
  }

  if (questName === 'raw_iron' || questName === 'iron_ore') {
    const requiredAmount = config.QUEST_AMOUNT.raw_iron || config.QUEST_AMOUNT.iron_ore || 3;
    const hasRawIron = countItem(bot, 'raw_iron') >= requiredAmount;
    const hasIronOre = countItem(bot, 'iron_ore') >= requiredAmount;
    const hasIronIngot = countItem(bot, 'iron_ingot') > 0;
    return hasRawIron || hasIronOre || hasIronIngot;
  }

  if (questName === 'iron_ingot') {
    const requiredAmount = config.QUEST_AMOUNT.iron_ingot || 3;
    return countItem(bot, 'iron_ingot') >= requiredAmount || countItem(bot, 'iron_pickaxe') > 0;
  }

  return countItem(bot, questName) >= (config.QUEST_AMOUNT[questName] || 1);
}

/**
 * Met à jour l'objectif courant du bot selon la chaîne de progression
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state État global du bot
 */
function syncObjective(bot, state) {
  if (state.manualObjective) return;

  const nextObjective = config.QUEST_CHAIN.find(name => !isQuestDone(bot, name)) || config.QUEST_CHAIN.at(-1);
  if (nextObjective !== state.currentObjective) {
    const previousObjective = state.currentObjective;
    state.currentObjective = nextObjective;

    if (previousObjective && previousObjective !== nextObjective) {
      bot.chat(`🚀 NOUVEAU PALIER : ${state.currentObjective}`);
      state.lastActionResult = {
        ...state.lastActionResult,
        message: `${state.lastActionResult.message} | Palier '${previousObjective}' terminé. NOUVEL objectif : obtenir '${state.currentObjective}'.`
      };
    }
  }
}

/**
 * Génère un résumé JSON compact du contenu de l'inventaire
 * @param {object} bot Instance Mineflayer du bot
 * @returns {string} Représentation textuelle de l'inventaire
 */
function getInventorySummary(bot) {
  const inventoryItems = bot.inventory.items();
  if (inventoryItems.length === 0) return "Inventaire vide";

  const summary = {};
  inventoryItems.forEach(item => {
    summary[item.name] = (summary[item.name] || 0) + item.count;
  });
  return JSON.stringify(summary);
}

/**
 * Retourne la liste des crafts réalisables immédiatement avec l'inventaire
 * @param {object} bot Instance Mineflayer du bot
 * @param {object|null} craftingTable Bloc établi posé à proximité si disponible
 * @returns {string[]} Liste des objets fabricables et conditions
 */
function getAvailableCrafts(bot, craftingTable) {
  const targetItemsToCheck = [
    'oak_planks', 'birch_planks', 'spruce_planks', 'stick', 'crafting_table',
    'wooden_axe', 'wooden_pickaxe', 'stone_pickaxe', 'stone_axe', 'furnace', 'wooden_sword'
  ];
  const availableCrafts = [];
  const hasCraftingTableInInventory = countItem(bot, 'crafting_table') > 0;
  const dummyTable = craftingTable || (hasCraftingTableInInventory ? { type: bot.registry.blocksByName['crafting_table']?.id, name: 'crafting_table' } : null);

  for (const itemName of targetItemsToCheck) {
    const itemDefinition = bot.registry.itemsByName[itemName];
    if (!itemDefinition) continue;

    const recipesInInventoryGrid = bot.recipesFor(itemDefinition.id, null, 1, null);
    if (recipesInInventoryGrid.length > 0) {
      availableCrafts.push(itemName);
      continue;
    }

    if (dummyTable) {
      const recipesWithTable = bot.recipesFor(itemDefinition.id, null, 1, dummyTable);
      if (recipesWithTable.length > 0) {
        if (!craftingTable) {
          availableCrafts.push(`${itemName} (nécessite de poser ton établi d'abord)`);
        } else {
          availableCrafts.push(itemName);
        }
      }
    }
  }

  return availableCrafts;
}

const PICKAXE_ORDER = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
const AXE_ORDER = ['netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe'];
const SHOVEL_ORDER = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'golden_shovel', 'stone_shovel', 'wooden_shovel'];

/**
 * Sélectionne le meilleur outil dans l'inventaire pour casser un bloc donné
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} block Bloc ciblé
 * @returns {object|null} Meilleur outil trouvé ou null
 */
function getBestToolForBlock(bot, block) {
  const inventoryItems = bot.inventory.items();
  const blockName = block?.name || '';

  if (blockName.includes('stone') || blockName.includes('cobble') || blockName.includes('ore') || blockName.includes('deepslate') || blockName.includes('debris') || blockName.includes('obsidian') || blockName.includes('brick') || blockName.includes('furnace')) {
    for (const toolName of PICKAXE_ORDER) {
      const toolItem = inventoryItems.find(item => item.name === toolName);
      if (toolItem) return toolItem;
    }
  }

  if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('planks') || blockName === 'crafting_table' || blockName.includes('fence') || blockName.includes('chest')) {
    for (const toolName of AXE_ORDER) {
      const toolItem = inventoryItems.find(item => item.name === toolName);
      if (toolItem) return toolItem;
    }
  }

  if (blockName.includes('dirt') || blockName.includes('grass') || blockName.includes('sand') || blockName.includes('gravel') || blockName.includes('clay') || blockName.includes('mud')) {
    for (const toolName of SHOVEL_ORDER) {
      const toolItem = inventoryItems.find(item => item.name === toolName);
      if (toolItem) return toolItem;
    }
  }

  return null;
}

module.exports = {
  countItem,
  hasToolType,
  getOwnedTools,
  isQuestDone,
  syncObjective,
  getInventorySummary,
  getAvailableCrafts,
  getBestToolForBlock
};
