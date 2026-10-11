const crypto = require('node:crypto');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../config');

/**
 * Tente d'extraire le bot d'un trou, de l'eau ou d'un piège en brisant le plafond ou en nageant vers le haut
 * @param {object} bot Instance Mineflayer du bot
 * @returns {Promise<{ success: boolean, message: string }>} Résultat de la tentative de dégagement
 */
async function skillUnstuck(bot) {
  bot.chat("Je me dégage...");
  console.log("[UNSTUCK] Lancement de la procédure de dégagement.");
  bot.clearControlStates();

  const eyeBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const isUnderwater = eyeBlock && (eyeBlock.name === 'water' || eyeBlock.name === 'flowing_water');

  // Urgence vitale : nager vers la surface si le bot est immergé
  if (isUnderwater || bot.entity.isInWater) {
    console.log("[UNSTUCK] Le bot est dans l'eau ! Nage d'urgence vers la surface...");
    bot.setControlState('jump', true);

    const swimStartTime = Date.now();
    while (Date.now() - swimStartTime < 8000) {
      await bot.waitForTicks(5);
      const currentEye = bot.blockAt(bot.entity.position.offset(0, 1, 0));
      if (!currentEye || (currentEye.name !== 'water' && currentEye.name !== 'flowing_water')) {
        break;
      }
    }
    bot.setControlState('jump', false);
    return { success: true, message: "Remontée d'urgence à la surface de l'eau effectuée." };
  }

  // Vérifier et casser le plafond si un bloc solide obstrue le dessus
  const headBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0));
  if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air') {
    console.log(`[UNSTUCK] Bloc détecté au-dessus de ma tête : ${headBlock.name}. Je le casse.`);
    try {
      await bot.dig(headBlock);
      console.log("[UNSTUCK] Plafond cassé avec succès.");
    } catch (error) {
      console.warn("[UNSTUCK] Impossible de casser le plafond :", error.message);
    }
  } else {
    console.log("[UNSTUCK] Aucun bloc au-dessus de ma tête, tentative de saut...");
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    await bot.waitForTicks(10);
    bot.setControlState('jump', false);
    bot.setControlState('forward', false);
  }

  const cardinals = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ];

  console.log("[UNSTUCK] Recherche d'un passage dans les parois autour...");
  for (const dir of cardinals) {
    const sideEyeBlock = bot.blockAt(bot.entity.position.plus(dir).offset(0, 1, 0));
    const sideFeetBlock = bot.blockAt(bot.entity.position.plus(dir));

    if (sideEyeBlock && config.SOFT_BLOCKS.has(sideEyeBlock.name)) {
      console.log(`[UNSTUCK] Paroi franchissable trouvée dans la direction ${dir} : ${sideEyeBlock.name}. Je creuse une issue...`);
      try {
        await bot.dig(sideEyeBlock);
        if (sideFeetBlock && config.SOFT_BLOCKS.has(sideFeetBlock.name)) {
          await bot.dig(sideFeetBlock);
        }
        const targetPos = bot.entity.position.plus(dir);
        const { GoalNear } = goals;
        await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
        console.log("[UNSTUCK] Sortie réussie !");
        return { success: true, message: "Sortie creusée dans la paroi pour sortir du trou." };
      } catch (err) {
        console.warn("[UNSTUCK] Échec lors du creusage de sortie :", err.message);
      }
    }
  }

  return { success: false, message: "Impossible de creuser une issue dans les murs immédiats." };
}

/**
 * Explore les environs en marchant vers une coordonnée aléatoire sécurisée
 * @param {object} bot Instance Mineflayer du bot
 * @returns {Promise<{ success: boolean, message: string }>} Résultat du déplacement exploratoire
 */
async function skillExplore(bot) {
  const distance = crypto.randomInt(15, 25);
  const angle = (crypto.randomInt(0, 360) * Math.PI) / 180;
  const targetX = Math.round(bot.entity.position.x + Math.cos(angle) * distance);
  const targetZ = Math.round(bot.entity.position.z + Math.sin(angle) * distance);

  console.log(`[EXPLORE] Déplacement vers X:${targetX}, Z:${targetZ}...`);

  try {
    const { GoalNearXZ } = goals;
    const gotoPromise = bot.pathfinder.goto(new GoalNearXZ(targetX, targetZ, 3));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout exploration")), 20000)
    );
    await Promise.race([gotoPromise, timeoutPromise]);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { success: true, message: "Déplacement exploratoire effectué vers une nouvelle zone." };
  } catch (error) {
    console.warn("Exploration entravée :", error.message);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { success: false, message: `Déplacement bloqué (${error.message}).` };
  }
}

module.exports = { skillUnstuck, skillExplore };
