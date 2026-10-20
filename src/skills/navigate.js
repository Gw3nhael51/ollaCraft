const crypto = require('node:crypto');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const config = require('../config');
const { getBestToolForBlock, isWoodLog } = require('../utils/inventory');

/**
 * Check whether an adjacent block can be dug quickly during an unstuck maneuver
 * @param {object|null} block Candidate block
 * @returns {boolean} True if block can be broken to escape
 */
function isDiggableObstacle(block) {
  if (!block?.name) return false;
  if (config.SOFT_BLOCKS.has(block.name)) return true;
  return block.name.endsWith('_leaves') || isWoodLog(block.name);
}

/**
 * Swim upwards recursively to reach water surface
 * @param {object} bot Mineflayer bot instance
 * @param {number} startTime Swimming start timestamp
 * @param {number} maxDurationMs Maximum swimming duration in milliseconds
 * @returns {Promise<void>}
 */
async function swimUpwardsStep(bot, startTime, maxDurationMs) {
  if (Date.now() - startTime >= maxDurationMs) return;

  await bot.waitForTicks(5);
  const currentEye = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  if (!currentEye || (currentEye.name !== 'water' && currentEye.name !== 'flowing_water')) {
    return;
  }

  await swimUpwardsStep(bot, startTime, maxDurationMs);
}

/**
 * Attempt to dig an escape tunnel through one of the cardinal walls
 * @param {object} bot Mineflayer bot instance
 * @param {Array<object>} cardinals Cardinal direction list
 * @param {number} index Tested direction index
 * @returns {Promise<boolean>} True if an escape path was successfully dug
 */
async function findAndDigEscapeRoute(bot, cardinals, index) {
  if (index >= cardinals.length) return false;

  const dir = cardinals[index];
  const sideEyeBlock = bot.blockAt(bot.entity.position.plus(dir).offset(0, 1, 0));
  const sideFeetBlock = bot.blockAt(bot.entity.position.plus(dir));

  if (isDiggableObstacle(sideEyeBlock)) {
    console.log(`[UNSTUCK] Passable wall found in direction (${dir.x}, ${dir.y}, ${dir.z}) : ${sideEyeBlock.name}. Digging escape path...`);
    try {
      const eyeTool = getBestToolForBlock(bot, sideEyeBlock);
      if (eyeTool) await bot.equip(eyeTool, 'hand').catch(() => {});
      await bot.dig(sideEyeBlock);

      if (isDiggableObstacle(sideFeetBlock)) {
        const feetTool = getBestToolForBlock(bot, sideFeetBlock);
        if (feetTool) await bot.equip(feetTool, 'hand').catch(() => {});
        await bot.dig(sideFeetBlock);
      }

      const targetPos = bot.entity.position.plus(dir);
      const { GoalNear } = goals;
      // Abort navigation if unstuck movement exceeds safety timeout
      const escapeGoto = bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
      const escapeTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout navigation unstuck")), 6000));
      await Promise.race([escapeGoto, escapeTimeout]);
      console.log("[UNSTUCK] Successfully escaped!");
      return true;
    } catch (err) {
      console.warn("[UNSTUCK] Escape digging failure :", err.message);
    }
  }

  return findAndDigEscapeRoute(bot, cardinals, index + 1);
}

/**
 * Attempt to extricate bot from holes, water or obstacles by breaking ceiling or swimming
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<{ success: boolean, message: string }>} Result of unstuck procedure
 */
async function skillUnstuck(bot) {
  bot.chat("Freeing myself...");
  console.log("[UNSTUCK] Launching unstuck procedure.");
  bot.clearControlStates();

  const eyeBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const isUnderwater = eyeBlock && (eyeBlock.name === 'water' || eyeBlock.name === 'flowing_water');

  // Swim urgently towards surface if submerged
  if (isUnderwater || bot.entity.isInWater) {
    console.log("[UNSTUCK] Bot is in water! Swimming urgently to surface...");
    bot.setControlState('jump', true);

    await swimUpwardsStep(bot, Date.now(), 8000);
    bot.setControlState('jump', false);
    return { success: true, message: "Emergency surfacing completed." };
  }

  // Check and break ceiling if solid block obstructs above
  const headBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0));
  if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air') {
    console.log(`[UNSTUCK] Obstacle detected above head : ${headBlock.name}. Breaking it.`);
    try {
      const tool = getBestToolForBlock(bot, headBlock);
      if (tool) await bot.equip(tool, 'hand').catch(() => {});
      await bot.dig(headBlock);
      console.log("[UNSTUCK] Ceiling block broken successfully.");
    } catch (error) {
      console.warn("[UNSTUCK] Failed to break ceiling block :", error.message);
    }
  } else {
    console.log("[UNSTUCK] Clear path above head, attempting jump...");
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

  console.log("[UNSTUCK] Searching for an escape opening in adjacent walls...");
  const escaped = await findAndDigEscapeRoute(bot, cardinals, 0);
  if (escaped) {
    return { success: true, message: "Dug exit route through wall to escape hole." };
  }

  return { success: false, message: "Unable to dig an exit through immediate surrounding walls." };
}

/**
 * Explore surroundings by walking towards safe randomized coordinates
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<{ success: boolean, message: string }>} Result of exploration movement
 */
async function skillExplore(bot) {
  const distance = crypto.randomInt(15, 25);
  const angle = (crypto.randomInt(0, 360) * Math.PI) / 180;
  const targetX = Math.round(bot.entity.position.x + Math.cos(angle) * distance);
  const targetZ = Math.round(bot.entity.position.z + Math.sin(angle) * distance);

  console.log(`[EXPLORE] Moving towards X:${targetX}, Z:${targetZ}...`);

  try {
    const { GoalNearXZ } = goals;
    const gotoPromise = bot.pathfinder.goto(new GoalNearXZ(targetX, targetZ, 3));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Exploration timeout")), 20000)
    );
    await Promise.race([gotoPromise, timeoutPromise]);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { success: true, message: "Exploratory movement completed to new zone." };
  } catch (error) {
    console.warn("Exploration impeded :", error.message);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { success: false, message: `Movement blocked (${error.message}).` };
  }
}

module.exports = { skillUnstuck, skillExplore, isDiggableObstacle };
