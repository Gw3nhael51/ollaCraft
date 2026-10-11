const { goals } = require('mineflayer-pathfinder');

const PASSIVE_MOBS = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey'
]);

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'blaze', 'drowned', 'husk', 'stray'
]);

// Trouver : Sélectionner la meilleure arme dans l'inventaire
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

// Récolter : Ramasser les objets tombés au sol
async function collectDrops(bot, position) {
  try {
    await bot.lookAt(position.offset(0, 0.5, 0));
    bot.setControlState('forward', true);
    await bot.waitForTicks(15);
  } catch {
    // Ignorer : Erreur de ramassage non bloquante
  } finally {
    bot.setControlState('forward', false);
  }
}

// Rechercher : Trouver l'entité la plus proche correspondant au critère
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

// Combattre : Approcher et éliminer une entité
async function executeCombat(bot, targetEntity) {
  const weapon = getBestWeapon(bot);
  if (weapon) {
    try {
      await bot.equip(weapon, 'hand');
    } catch {
      // Ignorer : Erreur d'équipement non bloquante
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

    async function engageTarget() {
      if (!targetEntity.isValid || targetEntity.health <= 0 || Date.now() - startTime >= maxDurationMs) {
        return;
      }

      const dist = bot.entity.position.distanceTo(targetEntity.position);
      if (dist <= 3.5) {
        await bot.lookAt(targetEntity.position.offset(0, targetEntity.height ? targetEntity.height * 0.8 : 1, 0));
        bot.attack(targetEntity);
        await bot.waitForTicks(12);
      } else {
        await bot.waitForTicks(4);
      }

      await engageTarget();
    }

    await engageTarget();

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    if (!targetEntity.isValid || targetEntity.health <= 0) {
      console.log(`[COMBAT] Cible éliminée, ramassage des drops...`);
      await collectDrops(bot, startPos);
      return { success: true, message: `Cible '${entityName}' éliminée avec succès.` };
    }

    return { success: false, message: `Combat interrompu contre '${entityName}' (temps écoulé).` };
  } catch (error) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { success: false, message: `Erreur durant le combat : ${error.message}` };
  }
}

// Chasser : Traquer et attaquer un animal passif
async function skillHunt(bot, targetName) {
  const entity = findTargetEntity(bot, targetName, PASSIVE_MOBS);
  if (!entity) {
    return { success: false, message: `Aucun animal passif correspondant à '${targetName || 'animal'}' à proximité.` };
  }
  return executeCombat(bot, entity);
}

// Combattre : Se défendre ou attaquer un monstre hostile
async function skillFight(bot, targetName) {
  const entity = findTargetEntity(bot, targetName, HOSTILE_MOBS);
  if (!entity) {
    return { success: false, message: `Aucun monstre hostile correspondant à '${targetName || 'monstre'}' à proximité.` };
  }
  return executeCombat(bot, entity);
}

module.exports = { skillHunt, skillFight };
