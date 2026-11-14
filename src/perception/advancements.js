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
 * @returns {object|null} Next story advancement definition or null if completed
 */
function updateCurrentAdvancement(state) {
  let lastUnlockedIndex = -1;
  for (let i = 0; i < STORY_ADVANCEMENTS.length; i++) {
    if (state.unlockedAdvancements.includes(STORY_ADVANCEMENTS[i].name)) {
      lastUnlockedIndex = i;
    }
  }

  const nextCandidates = STORY_ADVANCEMENTS.slice(lastUnlockedIndex + 1);
  const currentAdvancement = nextCandidates.find(adv => adv.name !== 'Diamonds!') || nextCandidates[0] || null;
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

const ADVANCEMENT_INVENTORY_RULES = [
  { name: 'Stone Age', items: ['cobblestone', 'furnace'], suffixes: ['pickaxe'] },
  { name: 'Getting an Upgrade', items: ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'] },
  { name: 'Acquire Hardware', items: ['iron_ingot', 'iron_pickaxe', 'iron_sword', 'iron_chestplate', 'shield'] },
  { name: 'Suit Up', items: ['shield'], suffixes: ['helmet', 'chestplate', 'leggings', 'boots'] },
  { name: "Isn't It Iron Pick", items: ['iron_pickaxe', 'diamond_pickaxe'] },
  { name: 'Diamonds!', items: ['diamond', 'diamond_pickaxe'] },
  { name: 'Ice Bucket Challenge', items: ['obsidian', 'blaze_rod'], inNether: true },
  { name: 'We Need to Go Deeper', items: ['blaze_rod'], inNether: true },
  { name: 'Eye Spy', items: ['ender_eye'] }
];

/**
 * Evaluate whether a declarative advancement rule is satisfied by current inventory or dimension
 * @param {object} bot Mineflayer bot instance
 * @param {Set<string>} ownedNames Set of item names currently in inventory
 * @param {object} rule Advancement rule definition
 * @returns {boolean} True if rule is satisfied
 */
function isAdvancementRuleMet(bot, ownedNames, rule) {
  if (rule.inNether && bot.game?.dimension === 'the_nether') return true;
  if (rule.items?.some(name => ownedNames.has(name))) return true;
  if (rule.suffixes) {
    for (const itemName of ownedNames) {
      if (rule.suffixes.some(suffix => itemName.endsWith(suffix))) return true;
    }
  }
  return false;
}

/**
 * Synchronize unlocked advancements based on items already acquired in inventory
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 */
function syncAdvancementsWithInventory(bot, state) {
  const allSlots = (bot.inventory?.slots || []).filter(Boolean);
  const ownedNames = new Set(allSlots.map(item => item.name));

  let changed = false;
  for (const rule of ADVANCEMENT_INVENTORY_RULES) {
    if (!state.unlockedAdvancements.includes(rule.name) && isAdvancementRuleMet(bot, ownedNames, rule)) {
      state.unlockedAdvancements.push(rule.name);
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
