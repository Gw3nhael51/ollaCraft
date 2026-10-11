const { goals } = require('mineflayer-pathfinder');

const PASSIVE_MOBS = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey'
]);

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'blaze', 'drowned', 'husk', 'stray'
]);

/**
 * Sélectionne la meilleure arme présente dans l'inventaire
 * @param {object} bot Instance Mineflayer du bot
 * @returns {object|null} Meilleure arme trouvée ou null
 */
function getBestWeapon(bot) {
  const items = bot.inventory.items();
  const swordTiers = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'];
  for (const sword of swordTiers) {
    const item = items.find(i => i.name === sword);
    if (item) return item;
  }
  const axeTiers = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'];
  for (const axe of axeTiers) {
    const item = items.find(i => i.name === axe);
    if (item) return item;
  }
  return null;
}

/**
 * Avance vers la position de l'entité vaincue pour ramasser le butin
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} position Position de l'entité éliminée
 */
async function collectDrops(bot, position) {
  try {
    await bot.lookAt(position.offset(0, 0.5, 0));
    bot.setControlState('forward', true);
    await bot.waitForTicks(15);
  } catch {
    // Tolérance aux interruptions lors du ramassage
  } finally {
    bot.setControlState('forward', false);
  }
}

/**
 * Recherche l'entité la plus proche correspondant au nom ou à la catégorie
 * @param {object} bot Instance Mineflayer du bot
 * @param {string|null} targetName Nom précis recherché
 * @param {Set<string>|null} defaultSet Catégorie par défaut
 * @param {number} maxDistance Rayon maximal de recherche
 * @returns {object|null} Entité la plus proche ou null
 */
function findTargetEntity(bot, targetName, defaultSet, maxDistance = 25) {
  let closest = null;
  let minDistance = maxDistance;

  for (const id in bot.entities) {
    const entity = bot.entities[id];
    if (!entity || entity === bot.entity || !entity.isValid) continue;

    const matchesName = targetName && entity.name?.toLowerCase().includes(targetName.toLowerCase());
    const matchesSet = !targetName && defaultSet?.has(entity.name);

    if (matchesName || matchesSet) {
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist < minDistance) {
        minDistance = dist;
        closest = entity;
      }
    }
  }

  return closest;
}

/**
 * Exécute une passe unitaire d'attaque ou de temporisation contre une entité
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} targetEntity Entité à attaquer
 * @returns {Promise<void>}
 */
async function strikeTargetStep(bot, targetEntity) {
  const distance = bot.entity.position.distanceTo(targetEntity.position);
  if (distance <= 3.5) {
    const targetHeight = targetEntity.height ? targetEntity.height * 0.8 : 1;
    await bot.lookAt(targetEntity.position.offset(0, targetHeight, 0));
    bot.attack(targetEntity);
    await bot.waitForTicks(12);
    return;
  }
  await bot.waitForTicks(4);
}

/**
 * Maintient le combat récursif contre l'entité jusqu'à élimination ou fin du temps imparti
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} targetEntity Entité ciblée
 * @param {number} startTime Timestamp de début du combat
 * @param {number} maxDurationMs Durée maximale allouée
 * @returns {Promise<void>}
 */
async function combatLoop(bot, targetEntity, startTime, maxDurationMs) {
  if (!targetEntity.isValid || targetEntity.health <= 0 || Date.now() - startTime >= maxDurationMs) {
    return;
  }

  await strikeTargetStep(bot, targetEntity);
  await combatLoop(bot, targetEntity, startTime, maxDurationMs);
}

/**
 * Approche et attaque une entité cible jusqu'à élimination ou dépassement du délai
 * @param {object} bot Instance Mineflayer du bot
 * @param {object} targetEntity Entité à combattre
 * @returns {Promise<{ success: boolean, message: string }>} Résultat de l'affrontement
 */
async function executeCombat(bot, targetEntity) {
  const weapon = getBestWeapon(bot);
  if (weapon) {
    try {
      await bot.equip(weapon, 'hand');
    } catch {
      // Tolérer une erreur d'équipement si déjà équipé
    }
  }

  const { GoalFollow } = goals;
  const entityName = targetEntity.name;
  const startPos = targetEntity.position.clone();

  console.log(`[COMBAT] Traque de ${entityName}...`);

  const maxDurationMs = 30000;
  const startTime = Date.now();

  try {
    bot.pathfinder.setGoal(new GoalFollow(targetEntity, 2), true);

    await combatLoop(bot, targetEntity, startTime, maxDurationMs);

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    if (!targetEntity.isValid || targetEntity.health <= 0) {
      console.log(`[COMBAT] Cible éliminée, ramassage des drops...`);
      await collectDrops(bot, startPos);
      return { success: true, message: `Cible '${entityName}' éliminée avec succès.` };
    }

    return { success: false, message: `Combat interrompu contre '${entityName}' (délai dépassé ou cible hors de portée).` };
  } catch (err) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { success: false, message: `Erreur lors du combat contre '${entityName}' : ${err.message}` };
  }
}

/**
 * Chasse un animal pacifique pour obtenir de la nourriture ou des ressources
 * @param {object} bot Instance Mineflayer du bot
 * @param {string|null} targetName Nom de l'animal cravé
 * @returns {Promise<{ success: boolean, message: string }>} Résultat de la chasse
 */
async function skillHunt(bot, targetName) {
  const target = findTargetEntity(bot, targetName, PASSIVE_MOBS);
  if (!target) {
    return { success: false, message: `Aucun animal pacifique (${targetName || 'vache, cochon, poulet...'}) trouvé à proximité.` };
  }
  return executeCombat(bot, target);
}

/**
 * Attaque un monstre hostile pour se défendre ou récolter du butin
 * @param {object} bot Instance Mineflayer du bot
 * @param {string|null} targetName Nom du monstre à éliminer
 * @returns {Promise<{ success: boolean, message: string }>} Résultat du combat
 */
async function skillFight(bot, targetName) {
  const target = findTargetEntity(bot, targetName, HOSTILE_MOBS);
  if (!target) {
    return { success: false, message: `Aucun monstre hostile (${targetName || 'zombie, squelette, araignée...'}) trouvé à proximité.` };
  }
  return executeCombat(bot, target);
}

module.exports = { skillHunt, skillFight };
