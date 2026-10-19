const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const GLOBAL_BAD_BLOCKS = new Set();
const { getBestToolForBlock, countItem, getInventorySummary } = require('../utils/inventory');
const { getBlockDrops, canHarvestBlock, getBlockNamesForTarget } = require('../utils/wikiData');
const { isBlockExposedToAir, VALUABLE_ORES } = require('../utils/environment');

/**
 * Move briefly towards destroyed block position to vacuum item drops
 * @param {object} bot Mineflayer bot instance
 * @param {object} position Mined block position vector
 */
async function collectDrops(bot, position) {
  try {
    await bot.lookAt(position.offset(0.5, 0.5, 0.5));
    bot.setControlState('forward', true);
    await bot.waitForTicks(8);
  } catch {
    // Tolerate movement interruptions during pickup
  } finally {
    bot.setControlState('forward', false);
  }
}

/**
 * Target, approach, and mine a single block matching requested resource
 * @param {object} bot Mineflayer bot instance
 * @param {string} targetName Targeted resource name
 * @param {object|null} [state] Global bot state
 * @param {number} [actionId] Active action identifier
 * @returns {Promise<{ success: boolean, empty: boolean, message: string }>}
 */
async function mineSingleTarget(bot, targetName, state = null, actionId = 0) {
  if (state && state.activeActionId !== actionId) {
    return { success: false, empty: true, message: "Action cancelled." };
  }

  const isOpportunistic = targetName === 'opportuniste' || targetName === 'ore' || targetName === 'ores';
  const candidateBlockNames = isOpportunistic ? VALUABLE_ORES : new Set(getBlockNamesForTarget(bot, targetName));

  const targetBlock = bot.findBlock({
    matching: (block) => {
      if (!block?.position) return candidateBlockNames.has(block?.name);
      if (!candidateBlockNames.has(block.name) || GLOBAL_BAD_BLOCKS.has(getPosKey(block.position))) return false;
      if (isOpportunistic) {
        return isBlockExposedToAir(bot, block) && canHarvestBlock(bot, block).canHarvest;
      }
      return true;
    },
    maxDistance: 30
  });

  if (!targetBlock) {
    const errorTarget = isOpportunistic ? 'exposed ore' : targetName;
    return { success: false, empty: true, message: `No block matching '${errorTarget}' found nearby.` };
  }

  // Verify required tool according to wiki harvest rules
  const harvestCheck = canHarvestBlock(bot, targetBlock);
  if (!harvestCheck.canHarvest) {
    return { success: false, empty: false, message: harvestCheck.message };
  }

  const bestTool = getBestToolForBlock(bot, targetBlock);
  if (bestTool) {
    try {
      await bot.equip(bestTool, 'hand');
    } catch {
      // Ignore tool equipping error if already held in hand
    }
  }

  const expectedDrops = getBlockDrops(bot, targetBlock.name);
  const initialCounts = new Map(expectedDrops.map(name => [name, countItem(bot, name)]));

  try {
    const { GoalNear } = goals;

    console.log(`[MINE] Moving towards ${targetBlock.name}...`);
    const gotoPromise = bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2));
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Navigation timeout")), 15000));
    await Promise.race([gotoPromise, timeoutPromise]);

    if (state && state.activeActionId !== actionId) {
      return { success: false, empty: true, message: "Action cancelled." };
    }

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    const blockToBreak = bot.blockAt(targetBlock.position);
    await bot.lookAt(targetBlock.position.offset(0.5, 0.5, 0.5));

    const finalTool = getBestToolForBlock(bot, blockToBreak);
    if (finalTool) {
      try {
        await bot.equip(finalTool, 'hand');
      } catch {
        // Ignore equipping error
      }
    }

    console.log(`[MINE] Digging ${targetBlock.name}...`);
    const digPromise = bot.dig(blockToBreak);
    const digTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Digging timeout")), 10000));
    await Promise.race([digPromise, digTimeout]);
    console.log(`[MINE] Block broken, collecting loot...`);

    if (state && state.activeActionId !== actionId) {
      return { success: false, empty: true, message: "Action cancelled." };
    }

    try {
      await bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));
    } catch {
      // Continue item collection despite slight navigation offset
    }

    await collectDrops(bot, targetBlock.position);

    // Wait for inventory update packets
    await bot.waitForTicks(6);

    let collectedItemName = null;
    let collectedQuantity = 0;

    for (const dropName of expectedDrops) {
      const currentCount = countItem(bot, dropName);
      const initialCount = initialCounts.get(dropName) || 0;
      const difference = currentCount - initialCount;
      if (difference > 0) {
        collectedItemName = dropName;
        collectedQuantity = difference;
        break;
      }
    }

    if (collectedQuantity <= 0) {
      return {
        success: false,
        empty: false,
        message: `Block '${blockToBreak.name}' broken but no '${expectedDrops.join('/')}' collected.`
      };
    }

    // Extract immediately adjacent blocks from the same vein
    let veinExtraCount = 0;
    if (VALUABLE_ORES.has(blockToBreak.name) && (!state || state.activeActionId === actionId)) {
      veinExtraCount = await harvestConnectedVein(bot, targetBlock.position, blockToBreak.name, 6, state, actionId);
    }

    const totalCollected = collectedQuantity + veinExtraCount;
    const veinMsg = veinExtraCount > 0 ? ` (+${veinExtraCount} vein block(s))` : '';

    return {
      success: true,
      empty: false,
      message: `+${totalCollected} '${collectedItemName}' collected${veinMsg}.`
    };
  } catch (error) {
    console.warn("Mining failure :", error.message);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    GLOBAL_BAD_BLOCKS.add(getPosKey(targetBlock.position));
    return { success: false, empty: false, message: `Block unreachable (${error.message}).` };
  }
}

const VEIN_DIRECTIONS = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];

/**
 * Format position into a unique coordinate key
 * @param {object} pos Vec3 position or block
 * @returns {string} Coordinate key x,y,z
 */
function getPosKey(pos) {
  if (!pos) return '';
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/**
 * Attempt to mine a specific vein block if valid and safe
 * @param {object} bot Mineflayer bot instance
 * @param {object} neighborPos Target block position to mine
 * @param {object} neighborBlock Target block object
 * @returns {Promise<boolean>} True if block was successfully extracted
 */
async function mineVeinBlock(bot, neighborPos, neighborBlock) {
  try {
    const tool = getBestToolForBlock(bot, neighborBlock);
    if (tool) await bot.equip(tool, 'hand').catch(() => {});

    console.log(`[VEIN] Extracting additional vein block (${neighborBlock.name}) at (${getPosKey(neighborPos)})...`);
    await bot.lookAt(neighborPos.offset(0.5, 0.5, 0.5));
    await bot.dig(neighborBlock);
    await collectDrops(bot, neighborPos);
    return true;
  } catch (err) {
    console.warn(`[VEIN] Unable to mine adjacent block : ${err.message}`);
    GLOBAL_BAD_BLOCKS.add(getPosKey(neighborPos));
    return false;
  }
}

/**
 * Explore directions sequentially around a vein block
 * @param {object} bot Mineflayer bot instance
 * @param {object} current Center block position
 * @param {number} dirIndex Current direction index
 * @param {object} veinState Vein exploration state
 * @returns {Promise<number>} Total blocks harvested
 */
async function exploreVeinDirections(bot, current, dirIndex, veinState) {
  if (
    dirIndex >= VEIN_DIRECTIONS.length ||
    veinState.harvested >= veinState.maxVeinBlocks ||
    (veinState.globalState && veinState.globalState.activeActionId !== veinState.actionId)
  ) {
    return veinState.harvested;
  }

  const dir = VEIN_DIRECTIONS[dirIndex];
  const neighborPos = current.plus(dir);
  const key = getPosKey(neighborPos);

  if (!veinState.visited.has(key)) {
    veinState.visited.add(key);

    const neighborBlock = bot.blockAt(neighborPos);
    if (neighborBlock && veinState.targetTypes.has(neighborBlock.name) && !GLOBAL_BAD_BLOCKS.has(key)) {
      const harvestCheck = canHarvestBlock(bot, neighborBlock);
      if (harvestCheck.canHarvest) {
        const touchesLava = VEIN_DIRECTIONS.some(d => {
          const checkBlock = bot.blockAt(neighborPos.plus(d));
          return checkBlock && (checkBlock.name === 'lava' || checkBlock.name === 'flowing_lava');
        });

        if (!touchesLava) {
          const success = await mineVeinBlock(bot, neighborPos, neighborBlock);
          if (success) {
            veinState.queue.push(neighborPos);
            veinState.harvested++;
            return exploreVeinDirections(bot, current, dirIndex + 1, veinState);
          }
        }
      }
    }
  }

  return exploreVeinDirections(bot, current, dirIndex + 1, veinState);
}

/**
 * Traverse vein branches recursively without while-await loop
 * @param {object} bot Mineflayer bot instance
 * @param {object} veinState Vein exploration state
 * @returns {Promise<number>} Total harvested
 */
async function processVeinQueue(bot, veinState) {
  if (
    veinState.queue.length === 0 ||
    veinState.harvested >= veinState.maxVeinBlocks ||
    (veinState.globalState && veinState.globalState.activeActionId !== veinState.actionId)
  ) {
    return veinState.harvested;
  }

  const current = veinState.queue.shift();
  await exploreVeinDirections(bot, current, 0, veinState);

  return processVeinQueue(bot, veinState);
}

/**
 * Extract connected adjacent blocks from the same vein to collect all ores
 * @param {object} bot Mineflayer bot instance
 * @param {object} originPos Initial broken ore position
 * @param {string} oreType Name of ore block
 * @param {number} [maxVeinBlocks] Maximum vein blocks to harvest
 * @param {object|null} [globalState] Global bot state
 * @param {number} [actionId] Active action identifier
 * @returns {Promise<number>} Extra vein blocks harvested
 */
async function harvestConnectedVein(bot, originPos, oreType, maxVeinBlocks = 8, globalState = null, actionId = 0) {
  const originKey = getPosKey(originPos);
  const visited = new Set([originKey]);
  const queue = [originPos];

  const targetTypes = new Set([oreType]);
  if (oreType.startsWith('deepslate_')) {
    targetTypes.add(oreType.replace('deepslate_', ''));
  } else {
    targetTypes.add(`deepslate_${oreType}`);
  }

  return processVeinQueue(bot, { queue, visited, targetTypes, harvested: 0, maxVeinBlocks, globalState, actionId });
}

/**
 * Search and mine exposed opportunistic ore recursively
 * @param {object} bot Mineflayer bot instance
 * @param {number} currentCount Current count of harvested ores
 * @param {number} maxCount Maximum count desired
 * @param {object|null} [state] Global bot state
 * @param {number} [actionId] Active action identifier
 * @returns {Promise<number>} Total count harvested
 */
async function harvestNearbyExposedOresStep(bot, currentCount, maxCount, state = null, actionId = 0) {
  if (currentCount >= maxCount || (state && state.activeActionId !== actionId)) return currentCount;

  const oreBlock = bot.findBlock({
    matching: (block) => {
      if (!VALUABLE_ORES.has(block.name)) return false;
      if (GLOBAL_BAD_BLOCKS.has(getPosKey(block.position))) return false;
      const harvestCheck = canHarvestBlock(bot, block);
      if (!harvestCheck.canHarvest) return false;
      return isBlockExposedToAir(bot, block);
    },
    maxDistance: 8
  });

  if (!oreBlock) return currentCount;

  console.log(`[OPPORTUNISTIC MINER] Found '${oreBlock.name}' exposed to air! Mining immediately...`);
  const singleResult = await mineSingleTarget(bot, oreBlock.name, state, actionId);
  if (!singleResult.success) return currentCount;

  return harvestNearbyExposedOresStep(bot, currentCount + 1, maxCount, state, actionId);
}

/**
 * Search and opportunistically mine exposed valuable ores around bot
 * @param {object} bot Mineflayer bot instance
 * @param {number} [maxCount] Maximum opportunistic ores to harvest per pass
 * @param {object|null} [state] Global bot state
 * @param {number} [actionId] Active action identifier
 * @returns {Promise<number>} Total ores harvested
 */
async function harvestNearbyExposedOres(bot, maxCount = 2, state = null, actionId = 0) {
  return harvestNearbyExposedOresStep(bot, 0, maxCount, state, actionId);
}

/**
 * Execute a repeated mining pass step
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Name of target item or block
 * @param {number} remaining Number of remaining blocks to harvest
 * @param {number} successfullyMined Number of blocks already harvested
 * @param {string} lastFailureMessage Last failure message
 * @param {number} actionId Active action identifier
 * @returns {Promise<{ successfullyMined: number, lastFailureMessage: string }>}
 */
async function runMiningSteps(bot, state, targetName, remaining, successfullyMined, lastFailureMessage, actionId) {
  // Abort immediately if action timed out or survival mode stopped
  if (remaining <= 0 || !state.isSurviving || state.activeActionId !== actionId) {
    return { successfullyMined, lastFailureMessage };
  }

  const result = await mineSingleTarget(bot, targetName, state, actionId);
  const nextFailure = result.message;

  if (result.empty || state.activeActionId !== actionId) {
    return { successfullyMined, lastFailureMessage: nextFailure };
  }

  const nextSuccess = result.success ? successfullyMined + 1 : successfullyMined;
  return runMiningSteps(bot, state, targetName, remaining - 1, nextSuccess, nextFailure, actionId);
}

/**
 * Execute repeated mining session to fulfill target quantity
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} targetName Block or item name to mine
 * @param {number} count Number of blocks to harvest
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function skillMine(bot, state, targetName, count) {
  const actionId = state.activeActionId;
  // Cap per-cycle block count to prevent safety timeout overflows
  const targetQuantity = Math.min(3, Math.max(1, count || 1));
  const { successfullyMined, lastFailureMessage } = await runMiningSteps(bot, state, targetName, targetQuantity, 0, '', actionId);

  if (successfullyMined === 0) {
    return { success: false, message: `Mining failed for '${targetName}' : ${lastFailureMessage}` };
  }

  let opportunisticMessage = '';
  if (state.isSurviving && state.activeActionId === actionId && targetName !== 'dirt') {
    const extraOresCount = await harvestNearbyExposedOres(bot, 2, state, actionId);
    if (extraOresCount > 0) {
      opportunisticMessage = ` + ${extraOresCount} opportunistic exposed ore(s)`;
    }
  }

  return {
    success: true,
    message: `${successfullyMined} block(s) harvested for '${targetName}'${opportunisticMessage}. Inventory : ${getInventorySummary(bot)}`
  };
}

module.exports = { skillMine, harvestNearbyExposedOres };
