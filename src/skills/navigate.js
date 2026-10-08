const crypto = require('node:crypto');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../config');

async function skillUnstuck(bot) {
  bot.chat("Je me dégage...");
  bot.clearControlStates();

  const headBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0));
  if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air') {
    try {
      await bot.dig(headBlock);
    } catch (error) {
      console.warn("Impossible de casser le plafond :", error.message);
    }
  }

  const cardinals = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ];

  for (const dir of cardinals) {
    const eyeBlock = bot.blockAt(bot.entity.position.plus(dir).offset(0, 1, 0));
    const feetBlock = bot.blockAt(bot.entity.position.plus(dir));

    if (eyeBlock && config.SOFT_BLOCKS.has(eyeBlock.name)) {
      try {
        await bot.dig(eyeBlock);
        if (feetBlock && config.SOFT_BLOCKS.has(feetBlock.name)) {
          await bot.dig(feetBlock);
        }
        const targetPos = bot.entity.position.plus(dir);
        const { GoalNear } = goals;
        await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
        return { success: true, message: "Sortie creusée dans la paroi pour sortir du trou." };
      } catch (err) {
        console.warn("Échec creusage de sortie :", err.message);
      }
    }
  }

  return { success: false, message: "Impossible de creuser une issue dans les murs immédiats." };
}

async function skillExplore(bot) {
  const distance = crypto.randomInt(20, 35);
  const angle = (crypto.randomInt(0, 360) * Math.PI) / 180;
  const x = Math.round(bot.entity.position.x + Math.cos(angle) * distance);
  const z = Math.round(bot.entity.position.z + Math.sin(angle) * distance);

  try {
    const { GoalNear } = goals;
    await bot.pathfinder.goto(new GoalNear(x, bot.entity.position.y, z, 3));
    return { success: true, message: "Déplacement exploratoire effectué vers une nouvelle zone." };
  } catch (error) {
    console.warn("Exploration entravée :", error.message);
    return { success: false, message: `Déplacement bloqué (\${error.message}).` };
  }
}

module.exports = { skillUnstuck, skillExplore };
