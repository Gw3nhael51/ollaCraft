const config = require('../infrastructure/config');
const invUtils = require('../perception/inventory');
const envUtils = require('../perception/environment');
const { getMcData, classifyOresByHarvestability } = require('../minecraft/wikiData');
const { getCurrentAdvancementInfo } = require('../perception/advancements');
const { resolveGoalPlan, getItemKnowledge, selectPrimaryRecipe } = require('../minecraft/knowledge');
const { findPortalFrameCandidate } = require('../actions/behaviors/world/portal');
const { formatBlockedActions } = require('./recovery');
const { formatWaypoints } = require('../core/progress');

// Knowledge sheets for objectives that are stages of the run rather than craftable items
const STAGE_WIKI_SUMMARIES = {
  bed: "Fiche Wiki : un lit se fabrique avec 3 laines de la MÊME couleur + 3 planches ('craft' cible 'bed'). La laine s'obtient en tuant des moutons ('hunt' cible 'sheep'). Le lit sert à définir le point de réapparition avant le Nether.",
  end_bed: "Fiche Wiki : il faut emporter un lit jusqu'au stronghold pour définir le point de réapparition avant le portail de l'End. Récupère celui du portail du Nether ('bed' cible 'pickup') ou fabriques-en un ('craft' cible 'bed').",
  blaze_rod: "Fiche Wiki : les 'blaze_rod' tombent des blazes, qui apparaissent dans les forteresses du Nether. Explore le Nether ('explore'), puis combats ('fight' cible 'blaze').",
  ender_pearl: "Fiche Wiki : les 'ender_pearl' tombent des endermen ('fight' cible 'enderman'), fréquents la nuit dans l'Overworld et dans les forêts biscornues du Nether.",
  stronghold: "Fiche Wiki : le stronghold se localise avec l'action 'stronghold' : un œil est lancé, son cap mesuré, puis un second lancer depuis un autre endroit permet de trianguler les coordonnées. L'action s'y rend ensuite toute seule.",
  end_portal: "Fiche Wiki : l'action 'endportal' trouve la salle du portail dans le stronghold, pose le lit (point de réapparition), remplit le cadre avec les 'ender_eye' et entre dans l'End.",
  ender_dragon: "Fiche Wiki : dans l'End, l'action 'dragon' détruit les cristaux à l'arc (ils soignent le dragon) puis attaque le dragon quand il se pose sur la fontaine centrale."
};

// Beyond this many block types the radar is trimmed to what matters, keeping the prompt short
const RADAR_ENTRY_LIMIT = 40;
const RADAR_PRIORITY_BLOCKS = new Set([
  'water', 'lava', 'obsidian', 'gravel', 'sand', 'crafting_table', 'furnace', 'chest', 'nether_portal',
  'spawner', 'nether_bricks', 'end_portal_frame', 'end_portal', 'stone', 'cobblestone', 'netherrack'
]);

/**
 * Generate stone mining advice based on currently owned tools and current objective
 * @param {object} bot Mineflayer bot instance
 * @param {string} [objectiveName=''] Current progression objective
 * @returns {string} Textual guidance for stone mining
 */
function getStoneHint(bot, objectiveName = '') {
  if (invUtils.hasToolType(bot, '_pickaxe')) {
    const pickaxeCount = invUtils.countItem(bot, 'wooden_pickaxe') + invUtils.countItem(bot, 'stone_pickaxe');
    return `TU POSSÈDES DÉJÀ UNE PIOCHE (${pickaxeCount}x). N'en fabrique PAS d'autre. Pour la cobblestone, utilise directement "mine" sur 'stone'.`;
  }
  if (objectiveName === 'nether_portal') {
    return "Pour 'nether_portal', ne perds pas de temps à fabriquer une pioche : explore ('explore' cible 'lava') pour trouver un lac de lave puis utilise 'portal'.";
  }
  return "Tu n'as AUCUNE pioche. Casser de la pierre sans pioche ne donne rien : fabrique d'abord une 'wooden_pickaxe'.";
}

/**
 * Compute progress gauge string for current target objective
 * @param {object} bot Mineflayer bot instance
 * @param {string} objectiveName Name of target item or advancement milestone
 * @param {object|null} [state=null] Global bot state (enables manual quantities and dynamic eye requirements)
 * @returns {string} Readable progress description
 */
function getObjectiveProgressText(bot, objectiveName, state = null) {
  const currentCount = invUtils.countItem(bot, objectiveName);
  const requiredCount = state
    ? invUtils.getQuestRequirement(bot, state, objectiveName)
    : (config.QUEST_AMOUNT[objectiveName] || 1);

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
    const rawName = mcData.items[id]?.name;
    const name = invUtils.isPlanks(rawName) && !invUtils.isPlanks(targetName) ? 'planks' : rawName;
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
  if (targetName === 'water_bucket') {
    return "Fiche Wiki : 'water_bucket' ne se mine pas à la pioche : il s'obtient en remplissant un 'bucket' vide sur une source d'eau ('water') via l'action 'portal' ou 'mine' (cible 'water').";
  }
  if (targetName === 'lava_bucket') {
    return "Fiche Wiki : 'lava_bucket' s'obtient en remplissant un 'bucket' vide sur une source de lave ('lava') via l'action 'portal' ou 'mine' (cible 'lava').";
  }
  if (targetName === 'nether_portal') {
    return "Fiche Wiki : 'nether_portal' se construit, s'allume et se traverse automatiquement via l'action 'portal' (target 'none') avec 'water_bucket' et 'flint_and_steel' près d'un lac de lave ('lava'), d'un portail actif ('nether_portal'), ou avec 10 'obsidian'. Ne mine PAS l'obsidienne sans pioche en diamant. Si aucune lave n'est visible, utilise 'explore'.";
  }

  if (STAGE_WIKI_SUMMARIES[targetName]) {
    return STAGE_WIKI_SUMMARIES[targetName];
  }

  const mcData = getMcData(bot);
  const knowledge = getItemKnowledge(bot, targetName);
  if (knowledge.method === 'mine') {
    const toolNote = knowledge.requiredTool ? ` (outil minimal : '${knowledge.requiredTool}')` : '';
    return `Fiche Wiki Minage : '${targetName}' s'obtient en minant '${knowledge.actionTarget}'${toolNote} avec l'action "mine". Il ne se fabrique PAS.`;
  }
  if (knowledge.method === 'combat') {
    return `Fiche Wiki : '${targetName}' s'obtient en tuant '${knowledge.actionTarget}' avec l'action "${knowledge.action}".`;
  }

  const itemDefinition = mcData.itemsByName[targetName];
  const recipes = itemDefinition ? mcData.recipes[itemDefinition.id] : null;

  if (recipes?.length > 0) {
    return formatRecipeSummary(mcData, selectPrimaryRecipe(mcData, recipes), targetName);
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
  if (!base?.furnace && !base?.chest) return "";

  const lines = ["- COORDONNÉES DE LA BASE :"];
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
 * Describe the portable crafting table situation
 * @param {object} bot Mineflayer bot instance
 * @param {object|null} craftingTable Crafting table block within reach, if any
 * @returns {string} Table status description
 */
function getTableStatusText(bot, craftingTable) {
  if (craftingTable) return "Oui (posé à portée, il sera récupéré en repartant)";
  if (invUtils.countItem(bot, 'crafting_table') > 0) {
    return "Oui (dans tes poches : 'craft' le pose et le reprend tout seul)";
  }
  return "Non (fabrique 'crafting_table' avec 4 planches avant tout craft 3x3)";
}

/**
 * Filter decorative plants and unbreakable blocks out of the scanned radar environment
 * @param {object} bot Mineflayer bot instance
 * @param {Record<string, number>} environment Scanned blocks dictionary
 * @returns {Record<string, number>} Filtered blocks dictionary for the LLM prompt
 */
function filterRadarEnvironment(bot, environment) {
  if (!environment || typeof environment !== 'object') return {};
  const mcData = getMcData(bot);
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => {
      if (name === 'nether_portal') return true;
      if (name.endsWith('_leaves')) return false;
      const block = mcData.blocksByName[name];
      if (!block) return false;
      return block.diggable !== false && !block.material?.includes('plant');
    })
  );
}

/**
 * Trim an oversized radar to the block types that matter (ores, wood, liquids, stations) plus the most common ones
 * @param {Record<string, number>} radar Filtered radar dictionary
 * @param {number} [limit=RADAR_ENTRY_LIMIT] Maximum number of block types kept
 * @returns {Record<string, number>} Radar with at most `limit` entries
 */
function limitRadarEntries(radar, limit = RADAR_ENTRY_LIMIT) {
  const entries = Object.entries(radar);
  if (entries.length <= limit) return radar;

  const isPriority = ([name]) => (
    RADAR_PRIORITY_BLOCKS.has(name) || name.endsWith('_ore') || invUtils.isWoodLog(name) || name.endsWith('_bed')
  );
  const priority = entries.filter(isPriority);
  const others = entries.filter(entry => !isPriority(entry)).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries([...priority, ...others].slice(0, limit));
}

/**
 * Build the invariant part of the prompt. It comes first and never changes between cycles,
 * so Ollama reuses its cached evaluation of this prefix instead of re-reading it every time.
 * @param {string} botName In-game name of the bot
 * @returns {string} Static rules and tool reference
 */
function buildStaticRules(botName) {
  return `
    Tu es ${botName}, un agent IA autonome dans Minecraft. Tu dois raisonner et t'adapter par toi-même.
    But final : terminer le jeu (Nether, blaze rods, ender pearls, stronghold, portail de l'End, Ender Dragon).

    TES OUTILS D'ACTION :
    - "wiki" : Pour consulter la recette et les conditions d'un bloc/item si tu doutes (ex: {"target": "iron_ingot"}).
    - "unstuck" : Si tu es bloqué dans un trou ou sous l'eau pour te dégager vers la surface.
    - "mine" : Pour récolter un bloc présent dans le Radar (ex: {"target": "log", "qty": 3} ou {"target": "stone", "qty": 3}).
    - "craft" : Pour fabriquer un objet (ex: {"target": "planks", "qty": 1} ou {"target": "wooden_pickaxe", "qty": 1}). L'établi est posé puis récupéré automatiquement.
    - "place" : Pour poser un four ou un coffre de tes poches au sol (ex: {"target": "furnace"}, {"target": "chest"}).
    - "smelt" : Pour faire fondre un minerai dans un four (ex: {"target": "raw_iron", "qty": 1}).
    - "chest" : Pour ouvrir le coffre de ta base et y ranger automatiquement tes blocs encombrants.
    - "portal" : Pour remplir ton seau d'eau, mouler/allumer le portail du Nether et entrer dedans. Depuis le Nether, {"target": "overworld"} te ramène.
    - "goto" : Pour retourner à un point de repère mémorisé (ex: {"target": "nether_portal"} ou {"target": "spawn_bed"}).
    - "bed" : Pour poser ton lit et définir ton point de réapparition ({"target": "pickup"} pour le reprendre).
    - "stronghold" : Pour localiser le stronghold (deux lancers d'œil + triangulation) puis t'y rendre.
    - "endportal" : Pour trouver la salle du portail, poser le lit, remplir le cadre d'yeux et entrer dans l'End.
    - "dragon" : Pour combattre l'Ender Dragon une fois dans l'End.
    - "procedure" : Pour exécuter une procédure autonome suggérée par le Manager (target = identifiant exact donné par le Manager).
    - "eat" : Pour consommer de la nourriture de ton inventaire.
    - "hunt" : Pour chasser un animal proche (ex: {"target": "cow"}, {"target": "sheep"}).
    - "fight" : Pour combattre un monstre hostile proche (ex: {"target": "zombie"}, {"target": "blaze"}).
    - "equip" : Pour équiper tes armures et placer le bouclier en main gauche (ex: {"target": "armor"}).
    - "explore" : Pour marcher et trouver de nouvelles ressources si rien d'utile n'est visible (target = ce que tu cherches, ex: "sheep", "diamond", "lava").

    RÈGLES DU JEU :
    - N'INVENTE RIEN : au moindre doute sur une recette, un outil ou une ressource, utilise "wiki". Le WikiCraft est ta source de vérité.
    - Ne fabrique jamais un outil que tu possèdes déjà.
    - N'attaque JAMAIS un minerai avec un outil insuffisant (ex: du diamant sans pioche en fer ne donne rien).
    - BOIS : n'importe quel bois convient. Utilise "log" pour miner et "planks" pour fabriquer : le système s'adapte.
    - ÉTABLI PORTABLE : tu ne possèdes qu'un établi et tu le gardes sur toi. "craft" le pose, fabrique, puis le casse et le récupère.
      Ne retourne JAMAIS à un ancien établi et n'utilise JAMAIS "place" pour 'crafting_table'. Sans établi, fabrique-le avec 4 planches.
      Si "craft" échoue parce que l'établi n'a pas pu être posé, tu l'as TOUJOURS sur toi : déplace-toi de quelques blocs ("explore") puis relance "craft". N'en fabrique pas un autre.
    - PLANCHES : une recette prend toutes ses planches dans UNE seule essence de bois. Des planches mélangées ne s'additionnent pas : refais des "planks" depuis un seul type de bûche.
    - PIERRE : la 'cobblestone' NE SE CRAFTE JAMAIS, elle s'obtient en minant 'stone'.
    - FER : mine 'iron_ore' (pioche en pierre minimum) pour avoir 'raw_iron', puis "smelt" sur 'raw_iron' dans un four ('furnace') avec du bois ou du charbon.
      Sans four posé : "craft" 'furnace' (8 cobblestone), "place" 'furnace', puis "smelt".
    - PORTAIL DU NETHER : si 'nether_portal' ou 'lava' est visible (ou si tu portes >= 10 'obsidian') et que tu as 'flint_and_steel' avec 'water_bucket' ou 'obsidian', appelle {"action": "portal", "target": "none"}.
      N'essaie JAMAIS de crafter de l'obsidienne, ni de la miner sans 'diamond_pickaxe'. Sans lave visible : "explore" (cible "lava").
    - LIT : avant d'entrer dans le Nether puis avant le portail de l'End, un lit doit définir ton point de réapparition. Les lits explosent dans le Nether et l'End : n'y utilise jamais "bed".
    - NETHER : explore pour trouver une forteresse et combats les blazes ('fight' cible 'blaze').
    - SURVIE : coincé ("bloqué dans un trou", "sous l'eau") -> "unstuck". Faim sous 15 -> "eat" ou "hunt". Ne mine pas sous tes pieds.
    - Si le Manager suggère "procedure", exécute-la avec le target exact (sauf urgence vitale "unstuck" ou "eat").
    - Une action listée dans "ACTIONS REFUSÉES" a échoué plusieurs fois À CET ENDROIT : ne la redemande pas sur place. Elle redevient possible dès que tu t'es déplacé ("explore") ou que ton inventaire a changé.

    FORMAT DE RÉPONSE :
    - "target" doit être UNIQUEMENT l'identifiant technique Minecraft (ex: "oak_log", "stone", "planks", "crafting_table", "chest") ou "none".
    - Strictement AUCUN texte explicatif, AUCUNE phrase, AUCUN espace dans "target". Toute ton analyse va dans "thought".
    Réponds UNIQUEMENT en JSON :
    {
      "thought": "1 ou 2 phrases courtes, 300 caractères maximum",
      "action": "mine" | "craft" | "place" | "explore" | "unstuck" | "wiki" | "smelt" | "eat" | "hunt" | "fight" | "chest" | "equip" | "portal" | "procedure" | "goto" | "bed" | "stronghold" | "endportal" | "dragon",
      "target": "identifiant_strict_sans_espace",
      "qty": 1
    }
  `;
}

/**
 * Build complete ReAct prompt for Ollama reasoning model: invariant rules first, live situation last
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {object} environment Surrounding scanned blocks
 * @param {object|null} craftingTable Nearby placed crafting table if available
 * @returns {string} Full prompt text
 */
function buildReactPrompt(bot, state, environment, craftingTable) {
  const envText = JSON.stringify(limitRadarEntries(filterRadarEnvironment(bot, environment)));
  const inventoryText = invUtils.getInventorySummary(bot);
  const terrainStatus = envUtils.checkTerrainSituation(bot);
  const availableCrafts = JSON.stringify(invUtils.getAvailableCrafts(bot, craftingTable));
  const advancementInfo = getCurrentAdvancementInfo(state);
  const unlockedText = state.unlockedAdvancements?.length > 0 ? state.unlockedAdvancements.map(a => `[${a}]`).join(', ') : 'aucun';
  const requiredAmount = invUtils.getQuestRequirement(bot, state, state.currentObjective);
  const progressText = getObjectiveProgressText(bot, state.currentObjective, state);
  const wikiSummary = getWikiKnowledgeSummary(bot, state.currentObjective);
  const goalPlan = resolveGoalPlan(bot, state.currentObjective, requiredAmount, state);
  const currentBiome = envUtils.getCurrentBiome ? envUtils.getCurrentBiome(bot) : 'plains';
  const tableStatus = getTableStatusText(bot, craftingTable);
  const ownedTools = invUtils.getOwnedTools(bot);
  const toolsText = ownedTools.length > 0 ? ownedTools.join(', ') : 'aucun';
  const baseInfo = formatBaseInfo(state.base);
  const subGoalText = state.managerSubGoal?.action
    ? `{"action": "${state.managerSubGoal.action}", "target": "${state.managerSubGoal.target || 'none'}"}`
    : "aucune action spécifique suggérée";

  const nearbyEntities = envUtils.scanNearbyEntities ? envUtils.scanNearbyEntities(bot, 20) : {};
  const entitiesText = Object.keys(nearbyEntities).length > 0 ? JSON.stringify(nearbyEntities) : "aucune";
  const exposedOres = environment?.exposedOres || (envUtils.scanExposedOres ? envUtils.scanExposedOres(bot, 16) : {});
  const { harvestable, unharvestable } = classifyOresByHarvestability(bot, exposedOres);
  const harvestableKeys = Object.keys(harvestable);
  const orePromptText = formatOrePromptText(harvestable, unharvestable);
  const detectedFrame = state.currentObjective === 'nether_portal' ? findPortalFrameCandidate(bot, 32) : null;
  const portalFrameHint = detectedFrame
    ? (detectedFrame.isComplete
      ? `\n    - PORTAIL COMPLET ÉTEINT DÉTECTÉ en (${detectedFrame.base.x}, ${detectedFrame.base.y}, ${detectedFrame.base.z}, axe ${detectedFrame.axis}) : utilise 'portal' avec un briquet pour l'allumer !`
      : `\n    - DÉBUT DE PORTAIL DÉTECTÉ (${detectedFrame.presentCount}/10 obsidienne) en (${detectedFrame.base.x}, ${detectedFrame.base.y}, ${detectedFrame.base.z}, axe ${detectedFrame.axis}) : complète-le avec de l'obsidienne ou de la lave via 'portal'.`)
    : '';
  const storageHint = state.currentObjective === 'nether_portal'
    ? "Pour 'nether_portal', NE fabrique PAS de coffre et n'utilise PAS 'chest' : les surplus encombrants sont gérés automatiquement. Concentre-toi sur 'explore' (cible 'lava') puis 'portal'."
    : "Si ton inventaire est trop encombré (terre, diorite, granit, blocs en surplus), fabrique un coffre ('craft' cible 'chest'), pose-le ('place' cible 'chest') et utilise \"chest\".";
  const manualNote = state.manualObjective ? ' (objectif fixé par le joueur : il passe avant la progression automatique)' : '';

  return `${buildStaticRules(bot.username || 'Herobrine')}
    ===== SITUATION ACTUELLE =====
    OBJECTIF GLOBAL : Obtenir '${state.currentObjective}'${manualNote}.
    - Progression chiffrée : ${progressText}
    - DIRECTIVE STRATÉGIQUE DU MANAGER : "${state.managerDirective || "Poursuivre la progression vers l'objectif actuel."}"
    - SOUS-OBJECTIF SUGGÉRÉ PAR LE MANAGER : ${subGoalText}
    - JALON / SUCCÈS OFFICIEL EN COURS : ${advancementInfo}
    - Succès déjà validés : ${unlockedText}

    CONNAISSANCES POUR L'OBJECTIF :
    - ${wikiSummary}
    - PLAN DE DÉPENDANCES (INVENTAIRE ACTUEL) : ${goalPlan.summary}
    - Pour vérifier : {"action": "wiki", "target": "${state.currentObjective}"}

    ÉTAT PHYSIQUE :
    - Dimension actuelle : ${bot.game?.dimension || 'overworld'}
    - Coordonnées actuelles : X:${Math.round(bot.entity.position.x)}, Y:${Math.round(bot.entity.position.y)}, Z:${Math.round(bot.entity.position.z)}
    - Santé : ${Math.round(bot.health)}/20 | Faim : ${Math.round(bot.food)}/20
    - Situation terrain : ${terrainStatus}
    - Inventaire : ${inventoryText}
    - OUTILS POSSÉDÉS : ${toolsText}
    - Établi disponible : ${tableStatus}
    - Points de repère mémorisés (action "goto") : ${formatWaypoints(bot, state)}
    ${baseInfo}

    ENVIRONNEMENT VISIBLE (RADAR) :
    - Biome actuel : ${currentBiome}${portalFrameHint}
    - Minerais visibles dans la caverne/parois : ${orePromptText}
    - Blocs : ${envText}
    - Entités/Créatures proches : ${entitiesText}

    CONSEILS POUR CETTE SITUATION :
    - Objets fabricables MAINTENANT avec ton inventaire : ${availableCrafts}
    - Minerais récoltables avec tes outils : ${harvestableKeys.length > 0 ? harvestableKeys.join(', ') : 'aucun actuellement'} (utilise "mine" pour les récolter).
    - ${getStoneHint(bot, state.currentObjective)}
    - ${storageHint}
    - Reste concentré sur ton objectif tant que la jauge (${progressText}) n'est pas remplie.

    RÉSULTAT DE TA DERNIÈRE ACTION (MÉMOIRE / FEEDBACK) :
    - Action tentée : ${state.lastActionResult.action} (${state.lastActionResult.target})
    - Résultat : ${state.lastActionResult.success ? "SUCCÈS" : "ÉCHEC"} -> ${state.lastActionResult.message}
    - ACTIONS REFUSÉES ICI (échecs répétés à cet endroit, déplace-toi avant de les retenter) : ${formatBlockedActions(state)}

    CONSIGNE : Analyse le résultat précédent, tes ressources et tes recettes. Déduis la prochaine action logique et réponds UNIQUEMENT avec le JSON demandé.
  `;
}

module.exports = { buildReactPrompt, buildStaticRules, filterRadarEnvironment, limitRadarEntries };
