const crypto = require('node:crypto');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../config');

async function skillUnstuck(bot) {
  bot.chat("Je me dégage...");
  console.log("[UNSTUCK] Lancement de la procédure de dégagement.");
  bot.clearControlStates();

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
    console.log("[UNSTUCK] Aucun bloc au-dessus de ma tête, l'espace est libre.");
  }

  const cardinals = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ];

  console.log("[UNSTUCK] Recherche d'un bloc mou dans les parois autour de moi pour créer une issue...");
  for (const dir of cardinals) {
    const eyeBlock = bot.blockAt(bot.entity.position.plus(dir).offset(0, 1, 0));
    const feetBlock = bot.blockAt(bot.entity.position.plus(dir));

    if (eyeBlock && config.SOFT_BLOCKS.has(eyeBlock.name)) {
      console.log(`[UNSTUCK] Mur mou trouvé dans la direction ${dir} : ${eyeBlock.name}. Je creuse une issue...`);
      try {
        await bot.dig(eyeBlock);
        if (feetBlock && config.SOFT_BLOCKS.has(feetBlock.name)) {
          console.log(`[UNSTUCK] Je creuse aussi le bloc au niveau de mes pieds : ${feetBlock.name}.`);
          await bot.dig(feetBlock);
        }
        const targetPos = bot.entity.position.plus(dir);
        const { GoalNear } = goals;
        console.log(`[UNSTUCK] Déplacement vers l'issue créée en ${targetPos}...`);
        await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
        console.log("[UNSTUCK] Sortie réussie !");
        return { success: true, message: "Sortie creusée dans la paroi pour sortir du trou." };
      } catch (err) {
        console.warn("[UNSTUCK] Échec lors du creusage de sortie :", err.message);
      }
    }
  }

  console.log("[UNSTUCK] Échec : Aucun mur n'a pu être creusé.");
  return { success: false, message: "Impossible de creuser une issue dans les murs immédiats." };
}

async function skillExplore(bot) {
  const distance = crypto.randomInt(15, 25);
  const angle = (crypto.randomInt(0, 360) * Math.PI) / 180;
  const x = Math.round(bot.entity.position.x + Math.cos(angle) * distance);
  const z = Math.round(bot.entity.position.z + Math.sin(angle) * distance);

  try {
    const { GoalNearXZ } = goals;
    const gotoPromise = bot.pathfinder.goto(new GoalNearXZ(x, z, 3));
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout exploration")), 20000));
    await Promise.race([gotoPromise, timeoutPromise]);

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { success: true, message: "Déplacement exploratoire effectué vers une nouvelle zone." };
  } catch (error) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    console.warn("Exploration entravée :", error.message);
    return { success: false, message: `Déplacement bloqué (${error.message}).` };
  }
}

module.exports = { skillUnstuck, skillExplore };
