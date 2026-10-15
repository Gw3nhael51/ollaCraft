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
 * Determine the next story advancement remaining to unlock
 * @param {object} state Global bot state
 * @returns {object|null} Définition du prochain progrès ou null si terminé
 */
function updateCurrentAdvancement(state) {
  const currentAdvancement = STORY_ADVANCEMENTS.find(advancement => !state.unlockedAdvancements.includes(advancement.name));
  state.currentAdvancement = currentAdvancement ? currentAdvancement.name : 'Free the End (Terminé)';
  return currentAdvancement;
}

/**
 * Construct external URL for the advancement badge image without local downloading
 * @param {string} advancementName Nom du progrès débloqué
 * @returns {string} Safe URL pointing to external icon API
 */
function getAdvancementBadgeUrl(advancementName) {
  const icon = ADVANCEMENT_ICONS[advancementName] || 'diamond';
  const encodedTitle = encodeURIComponent("Progrès..accompli..!");
  const encodedName = encodeURIComponent(advancementName.replace(/\s+/g, '..'));
  return `https://minecraft-api.com/api/achivements/${icon}/${encodedTitle}/${encodedName}`;
}

/**
 * Process server chat announcements to register advancements granted to the bot
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state Global bot state
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
 * Synchronize unlocked advancements based on items already acquired in inventory
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} state Global bot state
 */
function syncAdvancementsWithInventory(bot, state) {
  const allSlots = (bot.inventory?.slots || []).filter(Boolean);
  const hasItem = name => allSlots.some(item => item.name === name);
  const hasItemMatching = suffix => allSlots.some(item => item.name.endsWith(suffix));

  const rules = [
    {
      name: 'Stone Age',
      condition: () => hasItem('cobblestone') || hasItem('furnace') || hasItemMatching('pickaxe')
    },
    {
      name: 'Getting an Upgrade',
      condition: () => hasItem('stone_pickaxe') || hasItem('iron_pickaxe') || hasItem('diamond_pickaxe')
    },
    {
      name: 'Acquire Hardware',
      condition: () => hasItem('iron_ingot') || hasItem('iron_pickaxe') || hasItem('iron_sword') || hasItem('iron_chestplate') || hasItem('shield')
    },
    {
      name: 'Suit Up',
      condition: () => hasItemMatching('helmet') || hasItemMatching('chestplate') || hasItemMatching('leggings') || hasItemMatching('boots')
    },
    {
      name: "Isn't It Iron Pick",
      condition: () => hasItem('iron_pickaxe') || hasItem('diamond_pickaxe')
    },
    {
      name: 'Diamonds!',
      condition: () => hasItem('diamond') || hasItem('diamond_pickaxe') || hasItem('diamond_sword') || hasItem('diamond_chestplate')
    },
    {
      name: 'Ice Bucket Challenge',
      condition: () => hasItem('obsidian')
    },
    {
      name: 'Eye Spy',
      condition: () => hasItem('ender_eye')
    }
  ];

  let changed = false;
  for (const { name, condition } of rules) {
    if (!state.unlockedAdvancements.includes(name) && condition()) {
      state.unlockedAdvancements.push(name);
      changed = true;
    }
  }

  if (changed) {
    updateCurrentAdvancement(state);
  }
}

/**
 * Return description of the current advancement being pursued
 * @param {object} state Global bot state
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
  getAdvancementBadgeUrl,
  syncAdvancementsWithInventory
};
