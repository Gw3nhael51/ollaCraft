const STORY_ADVANCEMENTS = [
  { name: 'Stone Age', desc: 'Miner de la pierre pour obtenir de la cobblestone' },
  { name: 'Getting an Upgrade', desc: 'Fabriquer une pioche en pierre' },
  { name: 'Acquire Hardware', desc: 'Faire fondre du minerai de fer dans un four pour obtenir un lingot' },
  { name: 'Suit Up', desc: 'Fabriquer une pièce d’armure pour se protéger' },
  { name: "Isn't It Iron Pick", desc: 'Fabriquer une pioche en fer' },
  { name: 'Diamonds!', desc: 'Miner des diamants avec la pioche en fer' },
  { name: 'Ice Bucket Challenge', desc: 'Former de l’obsidienne avec de l’eau et de la lave puis la miner' },
  { name: 'We Need to Go Deeper', desc: 'Construire un portail avec de l’obsidienne, l’allumer et entrer dans le Nether' },
  { name: 'A Terrible Fortress', desc: 'Explorer le Nether pour trouver une forteresse' },
  { name: 'Into Fire', desc: 'Vaincre des Blazes pour obtenir des bâtons de Blaze' },
  { name: 'Eye Spy', desc: 'Crafter des yeux de l’Ender et localiser le Stronghold' },
  { name: 'The End?', desc: 'Placer les yeux dans le portail et entrer dans la dimension de l’End' },
  { name: 'Free the End', desc: 'Détruire les cristaux et éliminer l’Ender Dragon' }
];

const ADVANCEMENT_ICONS = {
  'Stone Age': 'wooden_pickaxe',
  'Getting an Upgrade': 'stone_pickaxe',
  'Acquire Hardware': 'iron_ingot',
  'Suit Up': 'iron_chestplate',
  "Isn't It Iron Pick": 'iron_pickaxe',
  'Diamonds!': 'diamond',
  'Ice Bucket Challenge': 'obsidian',
  'We Need to Go Deeper': 'flint_and_steel',
  'Into Fire': 'blaze_rod',
  'Eye Spy': 'ender_eye',
  'Free the End': 'dragon_head',
  'Monster Hunter': 'iron_sword',
  'Sweet Dreams': 'red_bed'
};

/**
 * Détermine le prochain progrès officiel de l'histoire restant à débloquer
 * @param {object} state État global du bot
 * @returns {object|null} Définition du prochain progrès ou null si terminé
 */
function updateCurrentAdvancement(state) {
  const currentAdvancement = STORY_ADVANCEMENTS.find(advancement => !state.unlockedAdvancements.includes(advancement.name));
  state.currentAdvancement = currentAdvancement ? currentAdvancement.name : 'Free the End (Terminé)';
  return currentAdvancement;
}

/**
 * Construit l'URL externe vers l'image du badge de succès sans téléchargement local
 * @param {string} advancementName Nom du progrès débloqué
 * @returns {string} URL sécurisée vers l'API d'icônes
 */
function getAdvancementBadgeUrl(advancementName) {
  const icon = ADVANCEMENT_ICONS[advancementName] || 'diamond';
  const encodedTitle = encodeURIComponent("Progrès..accompli..!");
  const encodedName = encodeURIComponent(advancementName.replace(/\s+/g, '..'));
  return `https://minecraft-api.com/api/achivements/${icon}/${encodedTitle}/${encodedName}`;
}

/**
 * Traite les annonces du serveur pour enregistrer les succès attribués au bot
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state État global du bot
 * @param {string} rawServerMessage Message texte reçu du serveur
 */
function checkAdvancementMessage(bot, state, rawServerMessage) {
  const botUsername = bot?.username?.toLowerCase();
  if (botUsername && !rawServerMessage.toLowerCase().includes(botUsername)) {
    return;
  }

  const advancementMatch = /(?:advancement|progrès|succès)\s*\[(.*?)\]/i.exec(rawServerMessage);
  if (!advancementMatch) return;

  const advancementName = advancementMatch[1];
  if (!state.unlockedAdvancements.includes(advancementName)) {
    state.unlockedAdvancements.push(advancementName);
    const nextAdvancement = updateCurrentAdvancement(state);

    console.log(`\n🏆 PROGRÈS ACCOMPLI : [${advancementName}] !`);
    console.log(`🖼️ Badge officiel : ${getAdvancementBadgeUrl(advancementName)}`);
    if (nextAdvancement) {
      console.log(`🎯 PROCHAIN JALON : [${nextAdvancement.name}] - ${nextAdvancement.desc}\n`);
      bot.chat(`🏆 Succès [${advancementName}] débloqué ! Prochain jalon : [${nextAdvancement.name}]`);
    } else {
      bot.chat(`🏆 Félicitations ! Tous les jalons majeurs sont accomplis !`);
    }
  }
}

/**
 * Retourne le descriptif du progrès officiel actuellement poursuivi
 * @param {object} state État global du bot
 * @returns {string} Libellé et description du jalon
 */
function getCurrentAdvancementInfo(state) {
  const currentAdvancement = STORY_ADVANCEMENTS.find(advancement => advancement.name === state.currentAdvancement);
  if (!currentAdvancement) return "Tous les succès majeurs sont accomplis !";
  return `[${currentAdvancement.name}] - ${currentAdvancement.desc}`;
}

module.exports = {
  STORY_ADVANCEMENTS,
  updateCurrentAdvancement,
  checkAdvancementMessage,
  getCurrentAdvancementInfo,
  getAdvancementBadgeUrl
};
