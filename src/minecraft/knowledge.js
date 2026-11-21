const config = require('../infrastructure/config');
const invUtils = require('../perception/inventory');
const { getMcData, getBlockNamesForTarget, canHarvestBlock, isOreBlock } = require('./wikiData');

const SMELT_RECIPES = new Map([
  ['iron_ingot', { input: 'raw_iron', fallbackInput: 'iron_ore' }],
  ['gold_ingot', { input: 'raw_gold', fallbackInput: 'gold_ore' }],
  ['copper_ingot', { input: 'raw_copper', fallbackInput: 'copper_ore' }],
  ['glass', { input: 'sand', fallbackInput: null }],
  ['stone', { input: 'cobblestone', fallbackInput: null }],
  ['charcoal', { input: 'log', fallbackInput: null }]
]);

const BED_ACQUISITION = {
  method: 'craft',
  action: 'craft',
  target: 'bed',
  requiresTable: true,
  requires: [{ name: 'wool', count: 3 }, { name: 'planks', count: 3 }]
};

const SPECIAL_ACQUISITIONS = new Map([
  ['water_bucket', { method: 'scoop', action: 'mine', target: 'water', requires: [{ name: 'bucket', count: 1 }] }],
  ['lava_bucket', { method: 'scoop', action: 'mine', target: 'lava', requires: [{ name: 'bucket', count: 1 }] }],
  ['blaze_rod', { method: 'combat', action: 'fight', target: 'blaze', requires: [] }],
  ['ender_pearl', { method: 'combat', action: 'fight', target: 'enderman', requires: [] }],
  ['string', { method: 'combat', action: 'fight', target: 'spider', requires: [] }],
  ['feather', { method: 'combat', action: 'hunt', target: 'chicken', requires: [] }],
  ['wool', { method: 'combat', action: 'hunt', target: 'sheep', requires: [] }],
  // Gravel only drops flint about one time out of ten: the step repeats until flint lands in the inventory
  ['flint', { method: 'mine', action: 'mine', target: 'gravel', requires: [] }],
  ['bed', BED_ACQUISITION],
  ['end_bed', BED_ACQUISITION],
  ['nether_portal', { method: 'portal', action: 'portal', target: 'none', requires: [{ name: 'flint_and_steel', count: 1 }] }],
  ['stronghold', { method: 'triangulation', action: 'stronghold', target: 'none', requires: [] }],
  ['end_portal', { method: 'portal', action: 'endportal', target: 'none', requires: [] }],
  ['ender_dragon', { method: 'combat', action: 'dragon', target: 'none', requires: [] }]
]);

// Altitude where each ore is most common in 1.20: guides the descent when no ore block is loaded nearby
const ORE_DEPTH_HINTS = new Map([
  ['diamond', -58],
  ['redstone', -58],
  ['gold', -16],
  ['lapis', 0],
  ['iron', 15],
  ['copper', 44],
  ['coal', 44],
  ['emerald', 80]
]);

/**
 * Return the altitude where a resource is most common, for ores worth digging down to
 * @param {string} targetName Item or block identifier (e.g. 'diamond', 'deepslate_iron_ore', 'raw_gold')
 * @returns {number|null} Recommended Y level or null when the target is not a known ore
 */
function getOreDepthHint(targetName) {
  if (typeof targetName !== 'string') return null;
  const base = targetName
    .toLowerCase()
    .trim()
    .replace(/^deepslate_/, '')
    .replace(/^raw_/, '')
    .replace(/_ore$/, '')
    .replace(/_lazuli$/, '');
  return ORE_DEPTH_HINTS.has(base) ? ORE_DEPTH_HINTS.get(base) : null;
}

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
 * List the item names consumed by a recipe
 * @param {object} mcData Minecraft data registry
 * @param {object} recipe Recipe definition
 * @returns {string[]} Ingredient item names
 */
function getRecipeIngredientNames(mcData, recipe) {
  const rawIds = recipe.inShape ? recipe.inShape.flat().filter(Boolean) : (recipe.ingredients || []);
  return rawIds.map(id => mcData.items[id]?.name).filter(Boolean);
}

/**
 * Detect a storage-block "decompression" recipe (e.g. 1 diamond_block -> 9 diamond), useless to obtain a raw resource
 * @param {object} mcData Minecraft data registry
 * @param {object} recipe Recipe definition
 * @returns {boolean} True if the recipe only unpacks a storage block
 */
function isDecompressionRecipe(mcData, recipe) {
  const names = new Set(getRecipeIngredientNames(mcData, recipe));
  if (names.size !== 1) return false;
  const [onlyIngredient] = names;
  return (recipe.result?.count || 1) === 9 || onlyIngredient.endsWith('_block');
}

/**
 * Pick the recipe that builds an item from basic materials rather than unpacking or re-dyeing another item
 * @param {object} mcData Minecraft data registry
 * @param {Array<object>} recipes Candidate recipes for one item
 * @returns {object} Preferred recipe
 */
function selectPrimaryRecipe(mcData, recipes) {
  const constructive = recipes.filter(recipe => !isDecompressionRecipe(mcData, recipe));
  const withoutDye = constructive.find(recipe => !getRecipeIngredientNames(mcData, recipe).some(name => name.endsWith('_dye')));
  return withoutDye || constructive[0] || recipes[0];
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
 * Check whether an item is a raw resource dropped by an ore block (diamond, raw_iron, coal, redstone...)
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} targetName Nom de l'item désiré
 * @returns {boolean} True if at least one ore block yields the item
 */
function isOreResource(bot, targetName) {
  return getBlockNamesForTarget(bot, targetName).some(name => isOreBlock(name));
}

/**
 * Build the knowledge sheet of a resource obtained by mining, listing the tool only when none carried can harvest it
 * @param {object} bot Instance du bot Mineflayer
 * @param {string} cleanTarget Identifiant Minecraft cible
 * @param {{ blockName: string, requiredTool: string|null }|null} mineSrc Source de minage résolue
 * @returns {object} Fiche de connaissance structurée
 */
function buildMiningKnowledge(bot, cleanTarget, mineSrc) {
  const blockName = mineSrc?.blockName || cleanTarget;
  const requiredTool = mineSrc?.requiredTool || null;
  // A better pickaxe already carried satisfies the requirement: do not plan a redundant lower-tier tool
  const alreadyHarvestable = !requiredTool || blockName === 'log' || canHarvestBlock(bot, blockName).canHarvest;
  return {
    target: cleanTarget,
    method: 'mine',
    action: 'mine',
    actionTarget: blockName,
    outputCount: 1,
    requiresTable: false,
    requiresFurnace: false,
    requiredTool,
    prerequisites: alreadyHarvestable ? [] : [{ name: requiredTool, count: 1 }]
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

  // Any colored bed or wool resolves to its generic acquisition (the craft adapts to the wool color carried)
  let specialKey = cleanTarget;
  if (!SPECIAL_ACQUISITIONS.has(specialKey)) {
    if (invUtils.isBed(cleanTarget)) specialKey = 'bed';
    else if (invUtils.isWool(cleanTarget)) specialKey = 'wool';
  }

  if (SPECIAL_ACQUISITIONS.has(specialKey)) {
    const special = SPECIAL_ACQUISITIONS.get(specialKey);
    return {
      target: cleanTarget,
      method: special.method,
      action: special.action,
      actionTarget: special.target,
      outputCount: 1,
      requiresTable: Boolean(special.requiresTable),
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

  // Prioriser : Utiliser le minage pour la pierre, les bûches brutes et toute ressource issue d'un minerai.
  // Sans cela 'diamond', 'raw_iron' ou 'coal' se résolvaient en "décompresser un bloc de stockage" (plan circulaire).
  if (cleanTarget === 'cobblestone' || invUtils.isWoodLog(cleanTarget) || isOreResource(bot, cleanTarget)) {
    return buildMiningKnowledge(bot, cleanTarget, resolveMiningSource(bot, cleanTarget));
  }

  if (recipes?.length > 0) {
    const parsed = parseRecipeDefinition(mcData, selectPrimaryRecipe(mcData, recipes), cleanTarget);
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
    return buildMiningKnowledge(bot, cleanTarget, mineSrc);
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

  // L'établi est portable : 'craft' le déploie puis le récupère, il suffit d'en posséder un (aucune étape 'place')
  if (knowledge.requiresTable && !invUtils.findNearbyCraftingTable(bot, state)) {
    const tableOwned = virtualInventory.get('crafting_table') ?? invUtils.countItem(bot, 'crafting_table');
    if (tableOwned < 1) {
      collectDependencySteps(bot, 'crafting_table', 1, state, virtualInventory, visited, steps);
    }
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
  selectPrimaryRecipe,
  getOreDepthHint,
  SMELT_RECIPES,
  SPECIAL_ACQUISITIONS,
  ORE_DEPTH_HINTS
};
