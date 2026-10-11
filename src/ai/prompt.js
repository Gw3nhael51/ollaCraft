const config = require('../config');
const invUtils = require('../utils/inventory');
const envUtils = require('../utils/environment');
const { getMcData } = require('../utils/wikiData');
const { getCurrentAdvancementInfo } = require('../utils/advancements');

/**
 * Génère le conseil spécifique au minage de la pierre selon les outils possédés
 * @param {object} bot Instance Mineflayer du bot
 * @returns {string} Indication textuelle sur la pierre
 */
function getStoneHint(bot) {
  if (invUtils.hasToolType(bot, '_pickaxe')) {
    const pickaxeCount = invUtils.countItem(bot, 'wooden_pickaxe') + invUtils.countItem(bot, 'stone_pickaxe');
    return `TU POSSÈDES DÉJÀ UNE PIOCHE (${pickaxeCount}x). N'en fabrique PAS d'autre. Pour la cobblestone, utilise directement "mine" sur 'stone'.`;
  }
  return "Tu n'as AUCUNE pioche. Casser de la pierre sans pioche ne donne rien : fabrique d'abord une 'wooden_pickaxe'.";
}

/**
 * Calcule la jauge de progression chiffrée de l'objectif en cours
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} objectiveName Nom de l'item ou du palier ciblé
 * @returns {string} Jauge de complétion lisible
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
 * Extrait la fiche technique synthétique issue du WikiCraft pour l'objectif ciblé
 * @param {object} bot Instance Mineflayer du bot
 * @param {string} targetName Nom de l'item ou du bloc à inspecter
 * @returns {string} Fiche synthétique d'obtention
 */
function getWikiKnowledgeSummary(bot, targetName) {
  const mcData = getMcData(bot);
  const itemDefinition = mcData.itemsByName[targetName];
  const blockDefinition = mcData.blocksByName[targetName];

  if (targetName === 'iron_ingot') {
    return "Fiche Wiki : 'iron_ingot' s'obtient en faisant fondre du 'raw_iron' dans un four ('furnace') avec du combustible (bûches, planches ou charbon).";
  }

  if (itemDefinition) {
    const recipes = mcData.recipes[itemDefinition.id];
    if (recipes && recipes.length > 0) {
      const primaryRecipe = recipes[0];
      const needsCraftingTable = primaryRecipe.inShape && (primaryRecipe.inShape.length > 2 || primaryRecipe.inShape[0].length > 2);
      const ingredientsList = [];

      if (primaryRecipe.inShape) {
        primaryRecipe.inShape.flat().filter(Boolean).forEach(id => ingredientsList.push(mcData.items[id]?.name));
      } else if (primaryRecipe.ingredients) {
        primaryRecipe.ingredients.forEach(id => ingredientsList.push(mcData.items[id]?.name));
      }

      const countMap = {};
      ingredientsList.forEach(name => { countMap[name] = (countMap[name] || 0) + 1; });
      const ingredientsSummary = Object.entries(countMap).map(([name, count]) => `${count}x ${name}`).join(' + ');

      return `Fiche Wiki Craft : ${ingredientsSummary} -> ${primaryRecipe.result.count}x ${targetName} (Établi requis : ${needsCraftingTable ? 'Oui' : 'Non'}).`;
    }
  }

  if (blockDefinition?.harvestTools) {
    const validToolNames = Object.keys(blockDefinition.harvestTools).map(id => mcData.items[id]?.name).filter(Boolean);
    return `Fiche Wiki Minage : Nécessite l'un des outils suivants : ${validToolNames.slice(0, 3).join(', ')}.`;
  }

  return "Consulte le WikiCraft avec l'action 'wiki' si tu as le moindre doute.";
}

/**
 * Construit le prompt complet ReAct destiné au modèle de raisonnement Ollama
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state État global du bot
 * @param {object} environment Scan des blocs environnants
 * @param {object|null} craftingTable Établi posé à proximité
 * @returns {string} Texte complet du prompt
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

  let tableStatus = "Non (absent ou non posé)";
  if (craftingTable) {
    tableStatus = "Oui (à proximité)";
  } else if (invUtils.countItem(bot, 'crafting_table') > 0) {
    tableStatus = "Non (dans tes poches ! Utilise 'place' avec cible 'crafting_table' pour le poser)";
  }

  const ownedTools = invUtils.getOwnedTools(bot);
  const toolsText = ownedTools.length > 0 ? ownedTools.join(', ') : 'aucun';

  let baseInfo = "";
  if (state.base.crafting_table || state.base.furnace) {
    baseInfo = `- COORDONNÉES DE LA BASE :\n`;
    if (state.base.crafting_table) baseInfo += `  * Établi (crafting_table) en : ${state.base.crafting_table.x}, ${state.base.crafting_table.y}, ${state.base.crafting_table.z}\n`;
    if (state.base.furnace) baseInfo += `  * Four (furnace) en : ${state.base.furnace.x}, ${state.base.furnace.y}, ${state.base.furnace.z}\n`;
    if (state.base.chest) baseInfo += `  * Coffre de stockage (chest) en : ${state.base.chest.x}, ${state.base.chest.y}, ${state.base.chest.z}\n`;
    baseInfo += `  -> Utilise ces informations pour y retourner si besoin.`;
  }

  const nearbyEntities = envUtils.scanNearbyEntities ? envUtils.scanNearbyEntities(bot, 20) : {};
  const entitiesText = Object.keys(nearbyEntities).length > 0 ? JSON.stringify(nearbyEntities) : "aucune";

  return `
    Tu es ${bot.username || 'Herobrine'}, un agent IA autonome dans Minecraft. Tu dois raisonner et t'adapter par toi-même.

    OBJECTIF GLOBAL : Obtenir '${state.currentObjective}'.
    - Progression chiffrée : ${progressText}
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
    - Blocs : ${envText}
    - Entités/Créatures proches : ${entitiesText}

    CONNAISSANCE DU JEU ET RÈGLES DE FABRICATION :
    - Objets fabricables MAINTENANT avec ton inventaire : ${availableCrafts}
    - Ne fabrique jamais un outil que tu possèdes déjà.
    - RÈGLE SUR LA PIERRE :
      * La 'cobblestone' NE SE CRAFTE JAMAIS. Elle s'obtient en minant 'stone' avec l'action "mine".
      * ${getStoneHint(bot)}
    - RÈGLE SUR LE FER :
      * Pour avoir 'raw_iron', mine 'iron_ore' avec au moins une 'stone_pickaxe'.
      * Pour avoir 'iron_ingot', utilise "smelt" sur 'raw_iron' dans un four ('furnace').
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
    - "mine" : Pour récolter un bloc présent dans le Radar (ex: {"target": "oak_log", "qty": 3} ou {"target": "stone", "qty": 3}).
    - "craft" : Pour fabriquer un objet disponible dans tes recettes (ex: {"target": "iron_pickaxe", "qty": 1}).
    - "place" : Pour poser un objet de tes poches au sol (ex: {"target": "crafting_table"}, {"target": "furnace"}, {"target": "chest"}).
    - "smelt" : Pour faire fondre un minerai dans un four (ex: {"target": "raw_iron", "qty": 1}).
    - "chest" : Pour ouvrir le coffre de ta base et y ranger automatiquement tes blocs encombrants (terre, surplus de pierre, etc.).
    - "eat" : Pour consommer de la nourriture de ton inventaire.
    - "hunt" : Pour chasser un animal proche (ex: {"target": "cow"} ou {"target": "pig"}).
    - "fight" : Pour combattre un monstre hostile proche pour te défendre ou récolter du butin (ex: {"target": "zombie"}).
    - "explore" : Pour marcher et trouver de nouvelles ressources si rien d'utile n'est visible.

    CONSIGNE : Analyse le résultat précédent, tes ressources et tes recettes. Déduis la prochaine action logique.
    Réponds UNIQUEMENT en JSON :
    {
      "thought": "Explication courte de ton raisonnement",
      "action": "mine" | "craft" | "place" | "explore" | "unstuck" | "wiki" | "smelt" | "eat" | "hunt" | "fight" | "chest",
      "target": "nom_cible_si_applicable",
      "qty": 1
    }
  `;
}

module.exports = { buildReactPrompt };
