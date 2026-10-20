const config = require('../config');
const invUtils = require('../utils/inventory');
const envUtils = require('../utils/environment');
const { getMcData, classifyOresByHarvestability } = require('../utils/wikiData');
const { getCurrentAdvancementInfo } = require('../utils/advancements');

/**
 * Generate stone mining advice based on currently owned tools
 * @param {object} bot Mineflayer bot instance
 * @returns {string} Textual guidance for stone mining
 */
function getStoneHint(bot) {
  if (invUtils.hasToolType(bot, '_pickaxe')) {
    const pickaxeCount = invUtils.countItem(bot, 'wooden_pickaxe') + invUtils.countItem(bot, 'stone_pickaxe');
    return `TU POSSÈDES DÉJÀ UNE PIOCHE (${pickaxeCount}x). N'en fabrique PAS d'autre. Pour la cobblestone, utilise directement "mine" sur 'stone'.`;
  }
  return "Tu n'as AUCUNE pioche. Casser de la pierre sans pioche ne donne rien : fabrique d'abord une 'wooden_pickaxe'.";
}

/**
 * Compute progress gauge string for current target objective
 * @param {object} bot Mineflayer bot instance
 * @param {string} objectiveName Name of target item or advancement milestone
 * @returns {string} Readable progress description
 */
function getObjectiveProgressText(bot, objectiveName) {
  const currentCount = invUtils.countItem(bot, objectiveName);
  const requiredCount = config.QUEST_AMOUNT[objectiveName] || 1;

  if (currentCount >= requiredCount) {
    return `${currentCount}/${requiredCount} (PALIER COMPLÉTÉ, passe à l'étape suivante)`;
  }

  const missingCount = requiredCount - currentCount;
  return `${currentCount}/${requiredCount} (il t'en manque encore ${missingCount} pour valider ce palier et débloquer la suite)`;
}

/**
 * Format a primary crafting recipe into a concise WikiCraft description
 * @param {object} mcData Minecraft data registry
 * @param {object} primaryRecipe Recipe definition object
 * @param {string} targetName Target item name
 * @returns {string} Formatted crafting summary
 */
function formatRecipeSummary(mcData, primaryRecipe, targetName) {
  const needsCraftingTable = primaryRecipe.inShape && (primaryRecipe.inShape.length > 2 || primaryRecipe.inShape[0].length > 2);
  const rawIds = primaryRecipe.inShape ? primaryRecipe.inShape.flat().filter(Boolean) : (primaryRecipe.ingredients || []);
  const countMap = {};

  for (const id of rawIds) {
    const name = mcData.items[id]?.name;
    if (name) countMap[name] = (countMap[name] || 0) + 1;
  }

  const ingredientsSummary = Object.entries(countMap).map(([name, count]) => `${count}x ${name}`).join(' + ');
  return `Fiche Wiki Craft : ${ingredientsSummary} -> ${primaryRecipe.result.count}x ${targetName} (Établi requis : ${needsCraftingTable ? 'Oui' : 'Non'}).`;
}

/**
 * Extract concise technical knowledge summary from WikiCraft for target item
 * @param {object} bot Mineflayer bot instance
 * @param {string} targetName Name of target item or block
 * @returns {string} Summary craft/harvest information
 */
function getWikiKnowledgeSummary(bot, targetName) {
  if (targetName === 'iron_ingot') {
    return "Fiche Wiki : 'iron_ingot' s'obtient en faisant fondre du 'raw_iron' dans un four ('furnace') avec du combustible (bûches, planches ou charbon).";
  }

  const mcData = getMcData(bot);
  const itemDefinition = mcData.itemsByName[targetName];
  const recipes = itemDefinition ? mcData.recipes[itemDefinition.id] : null;

  if (recipes?.length > 0) {
    return formatRecipeSummary(mcData, recipes[0], targetName);
  }

  const blockDefinition = mcData.blocksByName[targetName];
  if (blockDefinition?.harvestTools) {
    const validToolNames = Object.keys(blockDefinition.harvestTools).map(id => mcData.items[id]?.name).filter(Boolean);
    return `Fiche Wiki Minage : Nécessite l'un des outils suivants : ${validToolNames.slice(0, 3).join(', ')}.`;
  }

  return "Consulte le WikiCraft avec l'action 'wiki' si tu as le moindre doute.";
}

/**
 * Format base station coordinates block for the prompt
 * @param {object} base Base station coordinates map
 * @returns {string} Formatted base coordinates text
 */
function formatBaseInfo(base) {
  if (!base.crafting_table && !base.furnace && !base.chest) return "";

  const lines = ["- COORDONNÉES DE LA BASE :"];
  if (base.crafting_table) lines.push(`  * Établi (crafting_table) en : ${base.crafting_table.x}, ${base.crafting_table.y}, ${base.crafting_table.z}`);
  if (base.furnace) lines.push(`  * Four (furnace) en : ${base.furnace.x}, ${base.furnace.y}, ${base.furnace.z}`);
  if (base.chest) lines.push(`  * Coffre de stockage (chest) en : ${base.chest.x}, ${base.chest.y}, ${base.chest.z}`);
  lines.push("  -> Utilise ces informations pour y retourner si besoin.");
  return lines.join('\n');
}

/**
 * Format visible ore classification summary for the prompt
 * @param {Record<string, number>} harvestable Harvestable ores map
 * @param {Record<string, { count: number, requiredTools: string[] }>} unharvestable Unharvestable ores map
 * @returns {string} Formatted ore summary text
 */
function formatOrePromptText(harvestable, unharvestable) {
  const harvestableKeys = Object.keys(harvestable);
  const unharvestableKeys = Object.keys(unharvestable);
  if (harvestableKeys.length === 0 && unharvestableKeys.length === 0) return "aucun";

  const parts = [];
  if (harvestableKeys.length > 0) {
    const harvestableList = harvestableKeys.map(k => `${harvestable[k]}x ${k}`).join(', ');
    parts.push(`Récoltables avec tes outils : ${harvestableList}`);
  }
  if (unharvestableKeys.length > 0) {
    const summary = unharvestableKeys.map(k => {
      const toolsDesc = unharvestable[k].requiredTools.slice(0, 2).join(' ou ');
      return `${unharvestable[k].count}x ${k} (nécessite ${toolsDesc})`;
    }).join(', ');
    parts.push(`Visibles mais outil insuffisant : ${summary}`);
  }
  return parts.join(' | ');
}

/**
 * Determine crafting table availability status string
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} craftingTable Placed crafting table block
 * @returns {string} Table status description
 */
function getTableStatusText(bot, craftingTable) {
  if (craftingTable) return "Oui (à proximité)";
  if (invUtils.countItem(bot, 'crafting_table') > 0) {
    return "Non (dans tes poches ! Utilise 'place' avec cible 'crafting_table' pour le poser)";
  }
  return "Non (absent ou non posé)";
}

/**
 * Build complete ReAct prompt for Ollama reasoning model
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {object} environment Surrounding scanned blocks
 * @param {object|null} craftingTable Nearby placed crafting table if available
 * @returns {string} Full prompt text
 */
function buildReactPrompt(bot, state, environment, craftingTable) {
  const envText = JSON.stringify(environment);
  const inventoryText = invUtils.getInventorySummary(bot);
  const terrainStatus = envUtils.checkTerrainSituation(bot);
  const availableCrafts = JSON.stringify(invUtils.getAvailableCrafts(bot, craftingTable));
  const advancementInfo = getCurrentAdvancementInfo(state);
  const unlockedText = state.unlockedAdvancements?.length > 0 ? state.unlockedAdvancements.map(a => `[${a}]`).join(', ') : 'aucun';
  const progressText = getObjectiveProgressText(bot, state.currentObjective);
  const wikiSummary = getWikiKnowledgeSummary(bot, state.currentObjective);
  const currentBiome = envUtils.getCurrentBiome ? envUtils.getCurrentBiome(bot) : 'plains';
  const tableStatus = getTableStatusText(bot, craftingTable);
  const ownedTools = invUtils.getOwnedTools(bot);
  const toolsText = ownedTools.length > 0 ? ownedTools.join(', ') : 'aucun';
  const baseInfo = formatBaseInfo(state.base);

  const nearbyEntities = envUtils.scanNearbyEntities ? envUtils.scanNearbyEntities(bot, 20) : {};
  const entitiesText = Object.keys(nearbyEntities).length > 0 ? JSON.stringify(nearbyEntities) : "aucune";
  const exposedOres = envUtils.scanExposedOres ? envUtils.scanExposedOres(bot, 16) : {};
  const { harvestable, unharvestable } = classifyOresByHarvestability(bot, exposedOres);
  const harvestableKeys = Object.keys(harvestable);
  const orePromptText = formatOrePromptText(harvestable, unharvestable);

  return `
    Tu es ${bot.username || 'Herobrine'}, un agent IA autonome dans Minecraft. Tu dois raisonner et t'adapter par toi-même.

    OBJECTIF GLOBAL : Obtenir '${state.currentObjective}'.
    - Progression chiffrée : ${progressText}
    - DIRECTIVE STRATÉGIQUE DU MANAGER : "${state.managerDirective || "Poursuivre la progression vers l'objectif actuel."}"
    - JALON / SUCCÈS OFFICIEL EN COURS : ${advancementInfo}
    - Succès déjà validés : ${unlockedText}

    BASE DE CONNAISSANCES WIKICRAFT POUR L'OBJECTIF :
    - ${wikiSummary}
    - RÈGLE FONDAMENTALE : Si tu as le moindre doute sur une recette, un outil ou la façon d'obtenir une ressource, N'INVENTE RIEN : utilise immédiatement l'action "wiki" (ex: {"action": "wiki", "target": "${state.currentObjective}"}). Le WikiCraft est ta source de vérité.

    ÉTAT PHYSIQUE :
    - Coordonnées actuelles : X:${Math.round(bot.entity.position.x)}, Y:${Math.round(bot.entity.position.y)}, Z:${Math.round(bot.entity.position.z)}
    - Santé : ${Math.round(bot.health)}/20 | Faim : ${Math.round(bot.food)}/20
    - Situation terrain : ${terrainStatus}
    - Inventaire : ${inventoryText}
    - OUTILS POSSÉDÉS : ${toolsText}
    - Établi posé à proximité : ${tableStatus}
    ${baseInfo}

    ENVIRONNEMENT VISIBLE (RADAR) :
    - Biome actuel : ${currentBiome}
    - Minerais visibles dans la caverne/parois : ${orePromptText}
    - Blocs : ${envText}
    - Entités/Créatures proches : ${entitiesText}

    CONNAISSANCE DU JEU ET RÈGLES DE FABRICATION :
    - Objets fabricables MAINTENANT avec ton inventaire : ${availableCrafts}
    - Ne fabrique jamais un outil que tu possèdes déjà.
    - RÈGLE MINEUR OPPORTUNISTE :
      * Si des minerais sont récoltables (${harvestableKeys.length > 0 ? harvestableKeys.join(', ') : 'aucun actuellement'}), utilise "mine" pour les récolter !
      * N'attaque JAMAIS un minerai si ton outil est insuffisant (ex: casser du diamant sans pioche en fer le détruit sans rien drop).
    - RÈGLE SUR LE BOIS ET L'ÉTABLI :
      * N'importe quel type de bois (oak, birch, jungle, acacia, spruce, dark_oak, etc.) convient pour faire des planches, des bâtons, des outils ou un établi.
      * Tu peux utiliser directement "log" pour miner n'importe quel bois et "planks" pour fabriquer tes planches : le système s'adapte automatiquement.
      * Pour faire un établi ('crafting_table'), transforme d'abord tes bûches en planches ('craft' avec 'planks'), puis crafte l'établi dans tes poches.
      * Une fois la 'crafting_table' fabriquée, n'oublie pas de la poser au sol avec l'action "place" pour débloquer les crafts 3x3.
    - RÈGLE SUR LA PIERRE :
      * La 'cobblestone' NE SE CRAFTE JAMAIS. Elle s'obtient en minant 'stone' avec l'action "mine".
      * ${getStoneHint(bot)}
    - RÈGLE SUR LE FER :
      * Pour avoir 'raw_iron', mine 'iron_ore' avec au moins une 'stone_pickaxe'.
      * Pour avoir 'iron_ingot', utilise "smelt" sur 'raw_iron' dans un four ('furnace').
      * Si aucun four n'est posé, fabrique-le ("craft" avec 'furnace') à l'établi avec 8 cobblestone, pose-le au sol ("place" avec 'furnace'), puis utilise "smelt" sur 'raw_iron' (avec du bois ou du charbon comme combustible).
    - RÈGLE SUR LE STOCKAGE :
      * Si ton inventaire est trop encombré (beaucoup de terre, diorite, granit, blocs en surplus), fabrique un coffre ('craft' cible 'chest'), pose-le ('place' cible 'chest') et utilise l'action "chest" pour déposer et trier tes surplus.

    STRATÉGIE DE SURVIE ET DÉCISION :
    - Si tu es coincé ("bloqué dans un trou", "terrain impraticable"), utilise ABSOLUMENT l'action "unstuck".
    - Si ton objectif nécessite un établi, vérifie si tu en as un posé à proximité avant de crafter l'outil.
    - Ne mine pas sous tes pieds directement pour éviter la chute ou l'étouffement.
    - Si ta faim descend sous 15, mange ('eat') ou chasse des animaux ('hunt').
    - Reste concentré sur ton objectif global tant que la jauge (${progressText}) n'est pas remplie.

    RÉSULTAT DE TA DERNIÈRE ACTION (MÉMOIRE / FEEDBACK) :
    - Action tentée : ${state.lastActionResult.action} (${state.lastActionResult.target})
    - Résultat : ${state.lastActionResult.success ? "SUCCÈS" : "ÉCHEC"} -> ${state.lastActionResult.message}

    TES OUTILS D'ACTION :
    - "wiki" : Pour consulter la recette et les conditions d'un bloc/item si tu doutes (ex: {"target": "iron_ingot"}).
    - "unstuck" : Si tu es bloqué dans un trou pour te dégager vers la surface.
    - "mine" : Pour récolter un bloc présent dans le Radar (ex: {"target": "log", "qty": 3} ou {"target": "stone", "qty": 3}).
    - "craft" : Pour fabriquer un objet disponible dans tes recettes (ex: {"target": "planks", "qty": 1} ou {"target": "wooden_pickaxe", "qty": 1}).
    - "place" : Pour poser un objet de tes poches au sol (ex: {"target": "crafting_table"}, {"target": "furnace"}, {"target": "chest"}).
    - "smelt" : Pour faire fondre un minerai dans un four (ex: {"target": "raw_iron", "qty": 1}).
    - "chest" : Pour ouvrir le coffre de ta base et y ranger automatiquement tes blocs encombrants (terre, surplus de pierre, etc.).
    - "portal" : Pour remplir ton seau d'eau, mouler/allumer le portail du Nether et entrer dedans.
    - "eat" : Pour consommer de la nourriture de ton inventaire.
    - "hunt" : Pour chasser un animal proche (ex: {"target": "cow"} ou {"target": "pig"}).
    - "fight" : Pour combattre un monstre hostile proche pour te défendre ou récolter du butin (ex: {"target": "zombie"}).
    - "equip" : Pour équiper tes armures et placer le bouclier en main gauche (ex: {"target": "armor"} ou {"target": "shield"}).
    - "explore" : Pour marcher et trouver de nouvelles ressources si rien d'utile n'est visible.

    CONSIGNE : Analyse le résultat précédent, tes ressources et tes recettes. Déduis la prochaine action logique.
    Réponds UNIQUEMENT en JSON :
    {
      "thought": "Explication courte de ton raisonnement",
      "action": "mine" | "craft" | "place" | "explore" | "unstuck" | "wiki" | "smelt" | "eat" | "hunt" | "fight" | "chest" | "equip" | "portal",
      "target": "nom_cible_si_applicable",
      "qty": 1
    }
  `;
}

module.exports = { buildReactPrompt };
