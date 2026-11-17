const config = require('../infrastructure/config');
const invUtils = require('../perception/inventory');
const { getMcData, getBlockNamesForTarget, canHarvestBlock } = require('./wikiData');

const SMELT_RECIPES = new Map([
  ['iron_ingot', { input: 'raw_iron', fallbackInput: 'iron_ore' }],
  ['gold_ingot', { input: 'raw_gold', fallbackInput: 'gold_ore' }],
  ['copper_ingot', { input: 'raw_copper', fallbackInput: 'copper_ore' }],
  ['glass', { input: 'sand', fallbackInput: null }],
  ['stone', { input: 'cobblestone', fallbackInput: null }],
  ['charcoal', { input: 'log', fallbackInput: null }]
]);

const SPECIAL_ACQUISITIONS = new Map([
  ['water_bucket', { method: 'scoop', action: 'mine', target: 'water', requires: [{ name: 'bucket', count: 1 }] }],
  ['lava_bucket', { method: 'scoop', action: 'mine', target: 'lava', requires: [{ name: 'bucket', count: 1 }] }],
  ['blaze_rod', { method: 'combat', action: 'fight', target: 'blaze', requires: [] }],
  ['ender_pearl', { method: 'combat', action: 'fight', target: 'enderman', requires: [] }],
  ['nether_portal', { method: 'portal', action: 'portal', target: 'none', requires: [{ name: 'flint_and_steel', count: 1 }] }]
]);

const PICKAXE_TIER_TOOLS = [
  'wooden_pickaxe',
  'stone_pickaxe',
  'iron_pickaxe',
  'diamond_pickaxe',
  'netherite_pickaxe'
];

/**
 * Normaliser le nom d'un ingrédient pour les ressources génériques de bois
 * @param {string} rawName Nom brut de l'item
 * @param {string} targetName Nom de l'item fabriqué
 * @returns {string} Nom normalisé
 */
function normalizeIngredientName(rawName, targetName) {
  if (!rawName) return rawName;
  if (invUtils.isPlanks(rawName) && !invUtils.isPlanks(targetName)) {
    return 'planks';
  }
  if (invUtils.isWoodLog(rawName) && invUtils.isPlanks(targetName)) {
    return 'log';
  }
  return rawName;
}

/**
 * Extraire les ingrédients normalisés et métadonnées d'une recette Minecraft
 * @param {object} mcData Registre minecraft-data
 * @param {object} recipe Recette issue de mcData
 * @param {string} targetName Nom de l'item produit
 * @returns {{ ingredients: Array<{ name: string, count: number }>, outputCount: number, requiresTable: boolean }}
 */
function parseRecipeDefinition(mcData, recipe, targetName) {
  const requiresTable = Boolean(
    recipe.inShape && (recipe.inShape.length > 2 || (recipe.inShape[0] && recipe.inShape[0].length > 2))
  );
  const rawIds = recipe.inShape
    ? recipe.inShape.flat().filter(Boolean)
    : (recipe.ingredients || []);

  const counts = new Map();
  for (const id of rawIds) {
    const rawName = mcData.items[id]?.name;
    const normalized = normalizeIngredientName(rawName, targetName);
    if (normalized) {
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }

  const ingredients = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
  return {
    ingredients,
    outputCount: recipe.result?.count || 1,
    requiresTable
  };
}

/**
 * Sélectionner l'outil minimal requis pour récolter un bloc donné
 * @param {object} mcData Registre minecraft-data
 * @param {string} blockName Nom du bloc
 * @returns {string|null} Nom de l'outil minimal requis ou null
 */
function getMinimumHarvestTool(mcData, blockName) {
  const blockDef = mcData.blocksByName[blockName];
  if (!blockDef?.harvestTools) return null;

  const toolNames = Object.keys(blockDef.harvestTools)
    .map(id => mcData.items[id]?.name)
    .filter(Boolean);

  for (const tierTool of PICKAXE_TIER_TOOLS) {
    if (toolNames.includes(tierTool)) return tierTool;
  }
  return toolNames[0] || null;
}

/**
 * Choisir le bloc source le plus pertinent à miner pour obtenir un item cible
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} targetName Nom de l'item désiré
 * @returns {{ blockName: string, requiredTool: string|null }|null} Source de minage ou null
 */
function resolveMiningSource(bot, targetName) {
  const mcData = getMcData(bot);
  if (invUtils.isWoodLog(targetName)) {
    return { blockName: 'log', requiredTool: null };
  }

  const candidates = getBlockNamesForTarget(bot, targetName);
  const validBlocks = candidates.filter(name => Boolean(mcData.blocksByName[name]));
  if (validBlocks.length === 0) return null;

  // Privilégier : Préférer la variante non-deepslate quand elle existe
  const preferredBlock = validBlocks.find(name => !name.startsWith('deepslate_')) || validBlocks[0];
  return {
    blockName: preferredBlock,
    requiredTool: getMinimumHarvestTool(mcData, preferredBlock)
  };
}

/**
 * Consulter les connaissances structurées Minecraft pour obtenir un item ou bloc
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} targetName Identifiant Minecraft cible
 * @returns {object} Fiche de connaissance structurée (méthode, prérequis, recette, outil)
 */
function getItemKnowledge(bot, targetName) {
  const cleanTarget = typeof targetName === 'string' ? targetName.toLowerCase().trim() : '';
  if (!cleanTarget) {
    return { target: '', method: 'unknown', prerequisites: [] };
  }

  if (SPECIAL_ACQUISITIONS.has(cleanTarget)) {
    const special = SPECIAL_ACQUISITIONS.get(cleanTarget);
    return {
      target: cleanTarget,
      method: special.method,
      action: special.action,
      actionTarget: special.target,
      outputCount: 1,
      requiresTable: false,
      requiresFurnace: false,
      requiredTool: null,
      prerequisites: special.requires
    };
  }

  if (SMELT_RECIPES.has(cleanTarget)) {
    const smelt = SMELT_RECIPES.get(cleanTarget);
    return {
      target: cleanTarget,
      method: 'smelt',
      action: 'smelt',
      actionTarget: smelt.input,
      outputCount: 1,
      requiresTable: false,
      requiresFurnace: true,
      requiredTool: null,
      prerequisites: [{ name: smelt.input, count: 1 }]
    };
  }

  const mcData = getMcData(bot);
  const lookupName = invUtils.isPlanks(cleanTarget) ? 'oak_planks' : cleanTarget;
  const itemDef = mcData.itemsByName[lookupName];
  const recipes = itemDef ? mcData.recipes[itemDef.id] : null;

  // Prioriser : Utiliser le minage pour la pierre et les bûches brutes
  if (cleanTarget === 'cobblestone' || invUtils.isWoodLog(cleanTarget)) {
    const mineSrc = resolveMiningSource(bot, cleanTarget);
    return {
      target: cleanTarget,
      method: 'mine',
      action: 'mine',
      actionTarget: mineSrc?.blockName || cleanTarget,
      outputCount: 1,
      requiresTable: false,
      requiresFurnace: false,
      requiredTool: mineSrc?.requiredTool || null,
      prerequisites: mineSrc?.requiredTool ? [{ name: mineSrc.requiredTool, count: 1 }] : []
    };
  }

  if (recipes?.length > 0) {
    const parsed = parseRecipeDefinition(mcData, recipes[0], cleanTarget);
    return {
      target: cleanTarget,
      method: 'craft',
      action: 'craft',
      actionTarget: invUtils.isPlanks(cleanTarget) ? 'planks' : cleanTarget,
      outputCount: parsed.outputCount,
      requiresTable: parsed.requiresTable,
      requiresFurnace: false,
      requiredTool: null,
      prerequisites: parsed.ingredients
    };
  }

  const mineSrc = resolveMiningSource(bot, cleanTarget);
  if (mineSrc) {
    return {
      target: cleanTarget,
      method: 'mine',
      action: 'mine',
      actionTarget: mineSrc.blockName,
      outputCount: 1,
      requiresTable: false,
      requiresFurnace: false,
      requiredTool: mineSrc.requiredTool,
      prerequisites: mineSrc.requiredTool ? [{ name: mineSrc.requiredTool, count: 1 }] : []
    };
  }

  return {
    target: cleanTarget,
    method: 'unknown',
    action: 'explore',
    actionTarget: 'none',
    outputCount: 1,
    requiresTable: false,
    requiresFurnace: false,
    requiredTool: null,
    prerequisites: []
  };
}

/**
 * Vérifier si une station (établi ou fourneau) est disponible à proximité
 * @param {object} bot Instance du bot Mineflayer
 * @param {object|null} state État global du bot
 * @param {'crafting_table'|'furnace'} stationName Nom de la station
 * @returns {boolean} Vrai si la station est posée à portée
 */
function hasPlacedStation(bot, state, stationName) {
  if (stationName === 'crafting_table') {
    return Boolean(invUtils.findNearbyCraftingTable(bot, state));
  }
  const blockId = bot.registry?.blocksByName?.[stationName]?.id;
  const nearby = blockId && typeof bot.findBlock === 'function'
    ? bot.findBlock({ matching: blockId, maxDistance: config.CRAFTING_TABLE_RANGE })
    : null;
  return Boolean(nearby || state?.base?.[stationName]);
}

/**
 * Décomposer récursivement un objectif en étapes élémentaires selon l'inventaire actuel
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} targetName Cible actuelle
 * @param {number} neededCount Quantité totale désirée
 * @param {object|null} state État global du bot
 * @param {Map<string, number>} virtualInventory Inventaire simulé
 * @param {Set<string>} visited Ensemble anti-cycles
 * @param {Array<object>} steps Liste ordonnée des étapes collectées
 */
function collectDependencySteps(bot, targetName, neededCount, state, virtualInventory, visited, steps) {
  const clean = typeof targetName === 'string' ? targetName.toLowerCase().trim() : '';
  if (!clean || visited.has(clean)) return;

  const owned = virtualInventory.get(clean) ?? invUtils.countItem(bot, clean);
  if (owned >= neededCount) {
    return;
  }

  const deficit = neededCount - owned;
  const knowledge = getItemKnowledge(bot, clean);
  visited.add(clean);

  // Résoudre : Satisfaire les prérequis de matériaux ou d'outils avant l'étape courante
  const operationsNeeded = knowledge.method === 'craft'
    ? Math.ceil(deficit / Math.max(1, knowledge.outputCount))
    : deficit;

  for (const prereq of knowledge.prerequisites) {
    const isToolReq = prereq.name === knowledge.requiredTool;
    const reqTotal = isToolReq ? 1 : prereq.count * operationsNeeded;
    collectDependencySteps(bot, prereq.name, reqTotal, state, virtualInventory, visited, steps);
  }

  if (knowledge.requiresTable && !hasPlacedStation(bot, state, 'crafting_table')) {
    const tableOwned = virtualInventory.get('crafting_table') ?? invUtils.countItem(bot, 'crafting_table');
    if (tableOwned < 1) {
      collectDependencySteps(bot, 'crafting_table', 1, state, virtualInventory, visited, steps);
    }
    steps.push({
      action: 'place',
      target: 'crafting_table',
      qty: 1,
      reason: `Poser un établi pour fabriquer '${clean}'.`
    });
  }

  if (knowledge.requiresFurnace && !hasPlacedStation(bot, state, 'furnace')) {
    const furnaceOwned = virtualInventory.get('furnace') ?? invUtils.countItem(bot, 'furnace');
    if (furnaceOwned < 1) {
      collectDependencySteps(bot, 'furnace', 1, state, virtualInventory, visited, steps);
    }
    steps.push({
      action: 'place',
      target: 'furnace',
      qty: 1,
      reason: `Poser un fourneau pour fondre '${clean}'.`
    });
  }

  const actionQty = knowledge.method === 'craft' ? operationsNeeded : deficit;
  steps.push({
    action: knowledge.action || 'explore',
    target: knowledge.actionTarget || clean,
    qty: Math.max(1, actionQty),
    reason: `Obtenir ${deficit}x '${clean}' (${knowledge.method}).`
  });

  // Consommer : Déduire les ingrédients utilisés de l'inventaire virtuel
  if (knowledge.method === 'craft' || knowledge.method === 'smelt') {
    for (const prereq of knowledge.prerequisites) {
      if (prereq.name === knowledge.requiredTool) continue;
      const currentQty = virtualInventory.get(prereq.name) ?? invUtils.countItem(bot, prereq.name);
      virtualInventory.set(prereq.name, Math.max(0, currentQty - prereq.count * actionQty));
    }
  }

  const producedTotal = knowledge.method === 'craft'
    ? operationsNeeded * knowledge.outputCount
    : deficit;
  virtualInventory.set(clean, owned + producedTotal);
  visited.delete(clean);
}

/**
 * Calculer le plan complet des dépendances manquantes pour atteindre un objectif
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} targetObjective Objectif global visé
 * @param {number} [requiredQty=1] Quantité requise pour valider l'objectif
 * @param {object|null} [state=null] État global du bot
 * @returns {{
 *   target: string,
 *   satisfied: boolean,
 *   missingCount: number,
 *   steps: Array<{ action: string, target: string, qty: number, reason: string }>,
 *   nextAction: { action: string, target: string, qty: number, reason: string }|null,
 *   summary: string
 * }} Plan de dépendances résolu
 */
function resolveGoalPlan(bot, targetObjective, requiredQty = 1, state = null) {
  const cleanTarget = typeof targetObjective === 'string' ? targetObjective.toLowerCase().trim() : '';
  if (!cleanTarget) {
    return {
      target: '',
      satisfied: true,
      missingCount: 0,
      steps: [],
      nextAction: null,
      summary: 'Aucun objectif défini.'
    };
  }

  const owned = invUtils.countItem(bot, cleanTarget);
  const missingCount = Math.max(0, requiredQty - owned);
  if (missingCount === 0) {
    return {
      target: cleanTarget,
      satisfied: true,
      missingCount: 0,
      steps: [],
      nextAction: null,
      summary: `Objectif '${cleanTarget}' déjà satisfait (${owned}/${requiredQty}).`
    };
  }

  const virtualInventory = new Map();
  const steps = [];
  collectDependencySteps(bot, cleanTarget, requiredQty, state, virtualInventory, new Set(), steps);

  // Vérifier : Contrôler si la première étape de minage est bloquée par un outil manquant
  if (steps.length > 0 && steps[0].action === 'mine' && steps[0].target !== 'log') {
    const harvestCheck = canHarvestBlock(bot, steps[0].target);
    if (!harvestCheck.canHarvest && harvestCheck.requiredTools?.length > 0) {
      const minTool = PICKAXE_TIER_TOOLS.find(t => harvestCheck.requiredTools.includes(t)) || harvestCheck.requiredTools[0];
      const prefixSteps = [];
      collectDependencySteps(bot, minTool, 1, state, new Map(), new Set(), prefixSteps);
      steps.unshift(...prefixSteps);
    }
  }

  const nextAction = steps[0] || null;
  const summarySteps = steps
    .slice(0, 6)
    .map(s => {
      const qtySuffix = s.qty > 1 ? ` x${s.qty}` : '';
      return `${s.action}(${s.target}${qtySuffix})`;
    })
    .join(' -> ');
  const summary = nextAction
    ? `Plan pour '${cleanTarget}' (${owned}/${requiredQty}) : ${summarySteps}. Prochaine étape immédiate : ${nextAction.action} '${nextAction.target}'.`
    : `Aucune étape déterministe trouvée pour '${cleanTarget}'.`;

  return {
    target: cleanTarget,
    satisfied: false,
    missingCount,
    steps,
    nextAction,
    summary
  };
}

module.exports = {
  getItemKnowledge,
  resolveGoalPlan,
  parseRecipeDefinition,
  SMELT_RECIPES,
  SPECIAL_ACQUISITIONS
};
