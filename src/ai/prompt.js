const invUtils = require('../utils/inventory');
const envUtils = require('../utils/environment');

function getStoneHint(bot) {
  if (invUtils.hasToolType(bot, '_pickaxe')) {
    return \`TU POSSÈDES DÉJÀ UNE PIOCHE (\${invUtils.countItem(bot, 'wooden_pickaxe') + invUtils.countItem(bot, 'stone_pickaxe')}x). N'en fabrique PAS d'autre. Pour la cobblestone, utilise directement "mine" sur 'stone'.\`;
  }
  return "Tu n'as AUCUNE pioche. Casser de la pierre sans pioche ne donne rien : fabrique d'abord une 'wooden_pickaxe'.";
}

function buildReactPrompt(bot, state, environment, craftingTable) {
  const envText = JSON.stringify(environment);
  const inventoryText = invUtils.getInventorySummary(bot);
  const terrainStatus = envUtils.checkTerrainSituation(bot);
  const availableCrafts = JSON.stringify(invUtils.getAvailableCrafts(bot, craftingTable));
  const tableStatus = craftingTable ? "Oui (à proximité)" : (invUtils.countItem(bot, 'crafting_table') > 0 ? "Non (dans tes poches ! Utilise 'place' avec cible 'crafting_table' pour le poser)" : "Non (absent ou non posé)");
  const ownedTools = invUtils.getOwnedTools(bot);
  const toolsText = ownedTools.length > 0 ? ownedTools.join(', ') : 'aucun';

  return \`
    Tu es Herobrine, un agent IA autonome dans Minecraft. Tu dois raisonner et t'adapter par toi-même.

    OBJECTIF GLOBAL : Obtenir '\${state.currentObjective}'.

    ÉTAT PHYSIQUE :
    - Santé : \${Math.round(bot.health)}/20 | Faim : \${Math.round(bot.food)}/20
    - Situation terrain : \${terrainStatus}
    - Inventaire : \${inventoryText}
    - OUTILS POSSÉDÉS : \${toolsText}
    - Établi posé à proximité : \${tableStatus}

    ENVIRONNEMENT VISIBLE (RADAR) :
    \${envText}

    CONNAISSANCE DU JEU ET RÈGLES DE FABRICATION :
    - Objets fabricables MAINTENANT avec ton inventaire : \${availableCrafts}
    - Ne fabrique jamais un outil que tu possèdes déjà.
    - RÈGLE SUR LA PIERRE :
      * La 'cobblestone' NE SE CRAFTE JAMAIS. Elle s'obtient en minant 'stone' avec l'action "mine".
      * \${getStoneHint(bot)}
    - RÈGLES DE FABRICATION :
      * 1 bûche ('oak_log') donne 4 planches ('oak_planks') dans l'inventaire.
      * 2 planches ('oak_planks') donnent 4 bâtons ('stick') dans l'inventaire.
      * 4 planches ('oak_planks') donnent 1 établi ('crafting_table') dans l'inventaire.
      * 3 planches + 2 bâtons + établi posé au sol donnent 1 'wooden_pickaxe' ou 1 'wooden_axe'.
      * 3 cobblestone + 2 bâtons + établi posé au sol donnent 1 'stone_pickaxe' ou 1 'stone_axe'.
      * 8 cobblestone + établi posé au sol donnent 1 'furnace'.

    RÉSULTAT DE TA DERNIÈRE ACTION (MÉMOIRE / FEEDBACK) :
    - Action tentée : \${state.lastActionResult.action} (\${state.lastActionResult.target})
    - Résultat : \${state.lastActionResult.success ? "SUCCÈS" : "ÉCHEC"} -> \${state.lastActionResult.message}

    TES OUTILS D'ACTION :
    - "unstuck" : Si tu es bloqué dans un trou pour te dégager vers la surface.
    - "mine" : Pour récolter un bloc présent dans le Radar (ex: {"target": "oak_log", "qty": 3} ou {"target": "stone", "qty": 3}).
    - "craft" : Pour fabriquer un objet disponible dans tes recettes (ex: {"target": "oak_planks", "qty": 1}). NE JAMAIS faire craft de cobblestone !
    - "place" : Pour poser un objet de tes poches au sol (ex: {"target": "crafting_table"}).
    - "explore" : Pour marcher et trouver de nouvelles ressources si rien d'utile n'est visible.

    CONSIGNE : Analyse le résultat précédent, tes ressources et tes recettes. Déduis la prochaine action logique.
    Réponds UNIQUEMENT en JSON :
    {
      "thought": "Explication courte de ton raisonnement",
      "action": "mine" | "craft" | "place" | "explore" | "unstuck",
      "target": "nom_cible_si_applicable",
      "qty": 1
    }
  \`;
}

module.exports = { buildReactPrompt };
