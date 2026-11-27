const test = require('node:test');
const assert = require('node:assert/strict');
const mcData = require('minecraft-data')('1.20.4');
const config = require('../src/config');
const state = require('../src/state');
const invUtils = require('../src/utils/inventory');
const advUtils = require('../src/utils/advancements');
const storage = require('../src/skills/storage');
const manager = require('../src/ai/manager');

const { resolvePlayerDecision, getReliableProcedureDecision } = require('../src/ai/loop');
const { skillWiki } = require('../src/skills/wiki');
const { dispatchSkill } = require('../src/skills/dispatcher');
const { computeCraftOperations } = require('../src/skills/craft');
const { computeSmeltPlan } = require('../src/skills/smelt');
const { skillHunt, isPositionSafeForLoot } = require('../src/skills/combat');
const { buildObsidianFrame, findCastOriginNearLava, castPortalWithMold, markLavaClusterBad, findBestLavaPool, findPortalFrameCandidate, orientOffset, countScaffoldBlocks, pourBucketAtFace, emptyLavaBucketSafely, executeFallbackPortalTeleport, PORTAL_BUILD_STEPS } = require('../src/skills/portal');
const { scanEnvironment, clearBadBlocks } = require('../src/utils/environment');
const { skillPlace } = require('../src/skills/place');
const { getBlockNamesForTarget, getOreBlockNames } = require('../src/utils/wikiData');
const { buildReactPrompt, filterRadarEnvironment } = require('../src/ai/prompt');
const { isDiggableObstacle, skillUnstuck, moveExploreStep, hasSolidCeilingAbove, headingToMineflayerYaw, isBoxStuck, skillExplore, tryPillarUp } = require('../src/skills/navigate');
const { getFormatSchema, PLAYER_JSON_SCHEMA, MANAGER_JSON_SCHEMA } = require('../src/ai/ollama');
const { breakBlockAt } = require('../src/actions/primitives/blocks');

/**
 * Create a lightweight offline mock of a Mineflayer bot instance
 * @param {Array<{ name: string, count?: number }>} itemsList Inventory items
 * @param {string} [dimension] Current dimension name
 * @returns {object} Mock bot object
 */
function createMockBot(itemsList = [], dimension = 'overworld') {
  const slots = new Array(46).fill(null);
  itemsList.forEach((it, idx) => {
    const def = mcData.itemsByName[it.name];
    slots[idx + 9] = { name: it.name, count: it.count || 1, type: def ? def.id : idx };
  });

  const pos = {
    x: 0,
    y: 64,
    z: 0,
    floored() { return this; },
    offset() { return this; },
    plus() { return this; },
    distanceTo() { return 5; }
  };

  return {
    username: 'TestBot',
    version: '1.20.4',
    registry: mcData,
    health: 20,
    food: 20,
    game: { dimension },
    entity: { position: pos },
    inventory: {
      slots,
      items() { return slots.filter(Boolean); }
    },
    findBlock() { return null; },
    blockAt() { return { name: 'air', boundingBox: 'empty' }; },
    recipesFor() { return []; },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    chat() {}
  };
}

test('Storage retains key progression materials and limits bulk blocks to 32', () => {
  assert.equal(storage.isItemToStore({ name: 'flint', count: 10 }), false);
  assert.equal(storage.isItemToStore({ name: 'blaze_rod', count: 5 }), false);
  assert.equal(storage.isItemToStore({ name: 'ender_pearl', count: 12 }), false);
  assert.equal(storage.isItemToStore({ name: 'obsidian', count: 10 }), false);
  assert.equal(storage.isItemToStore({ name: 'gravel', count: 32 }), false);
  assert.equal(storage.isItemToStore({ name: 'gravel', count: 40 }), true);
});

test('Storage frees full inventory slots by tossing flowers and surplus bulk while keeping essentials', async () => {
  const stacks = [
    { name: 'flint_and_steel', type: 1, metadata: null, count: 1 },
    { name: 'water_bucket', type: 2, metadata: null, count: 1 },
    { name: 'raw_iron', type: 3, metadata: null, count: 5 },
    { name: 'orange_tulip', type: 4, metadata: null, count: 2 },
    { name: 'cobblestone', type: 5, metadata: null, count: 64 },
    { name: 'cobblestone', type: 5, metadata: null, count: 40 }
  ];
  let freeSlots = 0;
  const tossed = [];

  const bot = {
    inventory: {
      items: () => stacks,
      emptySlotCount: () => freeSlots
    },
    toss: async (type, _meta, count) => {
      const idx = stacks.findIndex(s => s.type === type && s.count === count);
      if (idx !== -1) {
        tossed.push(stacks[idx].name);
        stacks.splice(idx, 1);
        freeSlots += 1;
      }
    }
  };

  const freed = await storage.freeInventorySlotIfFull(bot, 2);
  assert.equal(freed, true);
  assert.deepEqual(tossed, ['orange_tulip', 'cobblestone']);
  assert.ok(stacks.some(s => s.name === 'flint_and_steel'));
  assert.ok(stacks.some(s => s.name === 'water_bucket'));
  assert.ok(stacks.some(s => s.name === 'raw_iron'));
  const remainingCobble = stacks.filter(s => s.name === 'cobblestone').reduce((sum, s) => sum + s.count, 0);
  assert.equal(remainingCobble, 64);
  assert.equal(storage.isItemToStore({ name: 'tuff', count: 64 }), true);
});

test('Progression resumes at current stage when keeping advanced gear', () => {
  const botMidGame = createMockBot([
    { name: 'iron_pickaxe', count: 1 },
    { name: 'iron_sword', count: 1 },
    { name: 'shield', count: 1 }
  ]);
  invUtils.syncObjective(botMidGame, state);
  assert.equal(state.currentObjective, 'iron_helmet');

  botMidGame.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
  botMidGame.inventory.slots[6] = { name: 'iron_chestplate', count: 1 };
  botMidGame.inventory.slots[7] = { name: 'iron_leggings', count: 1 };
  botMidGame.inventory.slots[8] = { name: 'iron_boots', count: 1 };
  botMidGame.inventory.slots[45] = { name: 'shield', count: 1 };
  botMidGame.inventory.slots[11] = null;

  state.base.furnace = null;
  state.managerDirective = "Récolter du bois pour fabriquer les premiers outils.";
  const furnacePos = { x: 4, y: 64, z: 2 };
  botMidGame.findBlock = ({ matching }) => (matching === mcData.blocksByName.furnace.id ? { name: 'furnace', position: furnacePos } : null);

  invUtils.syncObjective(botMidGame, state);
  assert.equal(state.currentObjective, 'bucket');
  assert.deepEqual(state.base.furnace, furnacePos);
  assert.ok(state.managerDirective.includes('bucket'));
});

test('Diamonds! advancement requires actual diamond items and speedrun skips to Ice Bucket Challenge', () => {
  state.unlockedAdvancements = [];
  const botWithBucket = createMockBot([
    { name: 'iron_pickaxe', count: 1 },
    { name: 'bucket', count: 1 },
    { name: 'water_bucket', count: 1 },
    { name: 'flint_and_steel', count: 1 }
  ]);
  advUtils.syncAdvancementsWithInventory(botWithBucket, state);
  assert.equal(state.unlockedAdvancements.includes('Diamonds!'), false);
  assert.equal(state.currentAdvancement, 'Ice Bucket Challenge');

  const botWithDiamond = createMockBot([{ name: 'diamond', count: 1 }]);
  advUtils.syncAdvancementsWithInventory(botWithDiamond, state);
  assert.equal(state.unlockedAdvancements.includes('Diamonds!'), true);
});

test('Wiki, Manager sanitization, and ReAct prompt generation work offline', () => {
  const bot = createMockBot([{ name: 'iron_pickaxe', count: 1 }]);
  const wikiRes = skillWiki(bot, 'iron_pickaxe');
  assert.equal(wikiRes.success, true);

  const sanitized = manager.sanitizeManagerOutput(bot, {
    suggestedAction: 'smelt',
    suggestedTarget: 'iron_ingot',
    directive: 'Smelt iron'
  });
  assert.equal(sanitized.suggestedAction, 'mine');
  assert.equal(sanitized.suggestedTarget, 'iron_ore');

  state.managerSubGoal = { action: 'mine', target: 'iron_ore' };
  const prompt = buildReactPrompt(bot, state, { stone: 10 }, null);
  assert.ok(prompt.includes(state.currentObjective));
  assert.ok(prompt.includes('{"action": "mine", "target": "iron_ore"}'));

  const fallbackDecision = resolvePlayerDecision(null);
  assert.equal(fallbackDecision.action, 'mine');
  assert.equal(fallbackDecision.target, 'iron_ore');
});

test('Crafting table is portable: short reuse range, no base memory, carried table grants craft access', () => {
  const bot = createMockBot([
    { name: 'oak_planks', count: 3 },
    { name: 'stick', count: 2 }
  ]);
  const tableId = mcData.blocksByName.crafting_table.id;
  state.deployedTable = null;
  state.base.crafting_table = null;
  bot.recipesFor = (id, _meta, _count, table) => (table ? [{ id }] : []);

  // A placed table is only reused within arm's reach and is never memorized as a base to walk back to
  const requestedRanges = [];
  bot.findBlock = ({ matching, maxDistance }) => {
    requestedRanges.push(maxDistance);
    return matching === tableId ? { name: 'crafting_table', position: { x: 2, y: 64, z: 0 } } : null;
  };
  assert.equal(invUtils.findNearbyCraftingTable(bot, state)?.name, 'crafting_table');
  assert.equal(requestedRanges[0], config.PORTABLE_TABLE_REUSE_RANGE);
  assert.equal(state.base.crafting_table, null);

  // Without any table, 3x3 recipes are flagged as needing a crafting table first
  bot.findBlock = () => null;
  assert.equal(invUtils.findNearbyCraftingTable(bot, state), null);
  assert.equal(invUtils.hasCraftingTableAccess(bot, state), false);
  assert.ok(invUtils.getAvailableCrafts(bot, null).some(entry => entry.startsWith('wooden_pickaxe (')));

  // Carrying the table is enough: the Manager keeps 'craft' and never asks to place the table by hand
  bot.inventory.slots[20] = { name: 'crafting_table', count: 1, type: mcData.itemsByName.crafting_table.id };
  assert.equal(invUtils.hasCraftingTableAccess(bot, state), true);
  assert.ok(invUtils.getAvailableCrafts(bot, null).includes('wooden_pickaxe'));

  const sanitized = manager.sanitizeManagerOutput(bot, {
    suggestedAction: 'craft',
    suggestedTarget: 'wooden_pickaxe',
    directive: 'Craft wooden pickaxe'
  });
  assert.equal(sanitized.suggestedAction, 'craft');
  assert.equal(sanitized.suggestedTarget, 'wooden_pickaxe');

  const redirected = manager.sanitizeManagerOutput(bot, {
    suggestedAction: 'place',
    suggestedTarget: 'crafting_table',
    directive: 'Pose ton établi'
  });
  assert.notEqual(`${redirected.suggestedAction}:${redirected.suggestedTarget}`, 'place:crafting_table');

  // A deployed table is tracked until it is confirmed gone
  const deployedPos = { x: 1, y: 64, z: 1 };
  state.deployedTable = deployedPos;
  bot.blockAt = (pos) => (pos === deployedPos ? { name: 'crafting_table', position: deployedPos } : { name: 'air' });
  assert.equal(invUtils.findNearbyCraftingTable(bot, state)?.position, deployedPos);

  bot.blockAt = () => ({ name: 'air' });
  assert.equal(invUtils.findNearbyCraftingTable(bot, state), null);
  assert.equal(state.deployedTable, null);
});

test('Manager supports wiki action and defaults missing target to currentObjective', () => {
  const bot = createMockBot();
  state.currentObjective = 'iron_pickaxe';

  const explicitWiki = manager.sanitizeManagerOutput(bot, {
    suggestedAction: 'wiki',
    suggestedTarget: 'furnace',
    directive: 'Check furnace recipe in wiki'
  });
  assert.equal(explicitWiki.suggestedAction, 'wiki');
  assert.equal(explicitWiki.suggestedTarget, 'furnace');

  const fallbackTargetWiki = manager.sanitizeManagerOutput(bot, {
    suggestedAction: 'wiki',
    suggestedTarget: 'none',
    directive: 'Check current objective recipe'
  });
  assert.equal(fallbackTargetWiki.suggestedAction, 'wiki');
  assert.equal(fallbackTargetWiki.suggestedTarget, 'iron_pickaxe');
});

test('Craft skill forwards qty from dispatcher, bounds by available ingredients, and caps tools to 1', async () => {
  const bot = createMockBot([
    { name: 'ender_pearl', count: 7 },
    { name: 'blaze_powder', count: 10 }
  ]);
  const pearlId = mcData.itemsByName.ender_pearl.id;
  const powderId = mcData.itemsByName.blaze_powder.id;
  const eyeId = mcData.itemsByName.ender_eye.id;
  const mockRecipe = {
    id: eyeId,
    delta: [
      { id: pearlId, count: -1 },
      { id: powderId, count: -1 },
      { id: eyeId, count: 1 }
    ]
  };

  assert.equal(computeCraftOperations(bot, mockRecipe, 'ender_eye', 12), 7);
  assert.equal(computeCraftOperations(bot, mockRecipe, 'iron_pickaxe', 5), 1);

  let executedCount = 0;
  bot.recipesFor = () => [mockRecipe];
  bot.waitForTicks = async () => {};
  bot.craft = async (_recipe, count) => {
    executedCount = count;
    bot.inventory.slots[20] = { name: 'ender_eye', count, type: eyeId };
  };

  const result = await dispatchSkill(bot, state, 'craft', 'ender_eye', 12);
  assert.equal(result.success, true);
  assert.equal(executedCount, 7);
  assert.ok(result.message.includes("7x 'ender_eye'"));
});

test('Smelt skill calculates fuel requirements and waits for full batch output', async () => {
  const planWithPlanks = computeSmeltPlan(3, 3, { name: 'oak_planks', count: 4 });
  assert.equal(planWithPlanks.inputCount, 3);
  assert.equal(planWithPlanks.fuelCount, 2);
  assert.equal(planWithPlanks.timeoutMs, 41000);

  const planWithCoal = computeSmeltPlan(6, 6, { name: 'coal', count: 2 });
  assert.equal(planWithCoal.inputCount, 6);
  assert.equal(planWithCoal.fuelCount, 1);

  const planFuelLimited = computeSmeltPlan(5, 5, { name: 'oak_log', count: 2 });
  assert.equal(planFuelLimited.inputCount, 3);
  assert.equal(planFuelLimited.fuelCount, 2);

  const bot = createMockBot([
    { name: 'raw_iron', count: 3 },
    { name: 'oak_planks', count: 4 }
  ]);
  const furnacePos = { x: 2, y: 64, z: 0 };
  bot.findBlock = () => ({ name: 'furnace', position: furnacePos });

  let fuelAdded = 0;
  let inputAdded = 0;
  let outputCount = 0;
  let updateListener = null;

  bot.openFurnace = async () => ({
    fuelItem: () => null,
    inputItem: () => (outputCount < inputAdded ? { count: inputAdded - outputCount } : null),
    outputItem: () => (outputCount > 0 ? { name: 'iron_ingot', count: outputCount } : null),
    putFuel: async (_type, _meta, count) => { fuelAdded = count; },
    putInput: async (_type, _meta, count) => {
      inputAdded = count;
      setImmediate(() => {
        outputCount = 1;
        if (updateListener) updateListener();
        outputCount = 3;
        if (updateListener) updateListener();
      });
    },
    on: (_event, cb) => { updateListener = cb; },
    removeListener: () => { updateListener = null; },
    takeOutput: async () => ({ name: 'iron_ingot', count: outputCount }),
    close: () => {}
  });

  const smeltRes = await dispatchSkill(bot, state, 'smelt', 'raw_iron', 3);
  assert.equal(smeltRes.success, true);
  assert.equal(fuelAdded, 2);
  assert.equal(inputAdded, 3);
  assert.equal(outputCount, 3);
  assert.ok(smeltRes.message.includes("3x 'raw_iron'"));

  bot.inventory.emptySlotCount = () => 0;
  bot.openFurnace = async () => ({
    fuelItem: () => ({ count: 2 }),
    inputItem: () => null,
    outputItem: () => ({ name: 'iron_ingot', count: 1 }),
    putFuel: async () => {},
    putInput: async () => {},
    on: () => {},
    removeListener: () => {},
    takeOutput: async () => null,
    close: () => {}
  });
  const fullSmeltRes = await dispatchSkill(bot, state, 'smelt', 'raw_iron', 1);
  assert.equal(fullSmeltRes.success, false);
  assert.ok(fullSmeltRes.message.includes('inventory is full'));
});

test('Progression requires a spawn bed before nether_portal, then stays on nether_portal despite missing pickaxe', () => {
  const botPortalReady = createMockBot([
    { name: 'flint_and_steel', count: 1 },
    { name: 'water_bucket', count: 1 }
  ]);
  state.waypoints = {};

  // Portal prerequisites skip the gear quests but never the spawn bed
  invUtils.syncObjective(botPortalReady, state);
  assert.equal(state.currentObjective, 'bed');

  // Carrying a bed (it is placed right before entering the portal) unlocks the portal quest
  botPortalReady.inventory.slots[30] = { name: 'white_bed', count: 1, type: mcData.itemsByName.white_bed.id };
  invUtils.syncObjective(botPortalReady, state);
  assert.equal(state.currentObjective, 'nether_portal');

  // So does a spawn bed already placed and memorized
  botPortalReady.inventory.slots[30] = null;
  state.waypoints = { spawn_bed: { x: 10, y: 64, z: 10, dimension: 'overworld' } };
  invUtils.syncObjective(botPortalReady, state);
  assert.equal(state.currentObjective, 'nether_portal');

  state.waypoints = {};
});

test('Combat collects drops at actual death position instead of initial position and avoids lava', async () => {
  const bot = createMockBot([{ name: 'iron_sword', count: 1 }]);
  let lookedAtPos = null;
  bot.lookAt = async (pos) => { lookedAtPos = pos; };
  bot.setControlState = () => {};
  bot.clearControlStates = () => {};
  bot.waitForTicks = async () => {};
  bot.equip = async () => {};

  const makeVec = (x, y, z) => ({
    x,
    y,
    z,
    clone() { return makeVec(this.x, this.y, this.z); },
    offset(dx, dy, dz) { return makeVec(this.x + dx, this.y + dy, this.z + dz); }
  });

  const cowEntity = {
    name: 'cow',
    isValid: true,
    health: 10,
    height: 1.4,
    position: makeVec(5, 64, 0)
  };
  bot.entities = { 1: cowEntity };
  bot.entity.position.distanceTo = () => 2.5;
  bot.attack = (target) => {
    target.position = makeVec(18, 64, 4);
    target.health = 0;
    target.isValid = false;
  };

  const huntRes = await skillHunt(bot, 'cow');
  assert.equal(huntRes.success, true);
  assert.equal(lookedAtPos.x, 18);
  assert.equal(lookedAtPos.z, 4);

  bot.blockAt = () => ({ name: 'lava' });
  assert.equal(isPositionSafeForLoot(bot, makeVec(18, 64, 4)), false);

  bot.recipesFor = (id, _meta, _count, table) => (table ? [{ id }] : []);
  const allCrafts = invUtils.getAvailableCrafts(bot, { name: 'crafting_table' });
  assert.ok(allCrafts.includes('iron_shovel'));
  assert.ok(allCrafts.includes('iron_chestplate'));
});

test('Portal builder assembles all 11 blocks (including top-left corner and horizontal roof) using multi-face placement', async () => {
  const { Vec3 } = require('vec3');
  const bot = createMockBot([{ name: 'obsidian', count: 11 }]);
  const worldBlocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;

  for (let x = -2; x <= 3; x++) {
    for (let y = 63; y <= 64; y++) {
      const pos = new Vec3(x, y, 0);
      worldBlocks.set(key(pos), { name: 'grass_block', position: pos });
    }
  }

  bot.blockAt = (pos) => worldBlocks.get(key(pos)) || { name: 'air', position: pos };
  bot.findBlock = () => worldBlocks.get('0,64,0');
  bot.equip = async () => {};
  bot.lookAt = async () => {};
  bot.waitForTicks = async () => {};
  bot.dig = async (block) => {
    worldBlocks.set(key(block.position), { name: 'air', position: block.position });
  };
  bot.placeBlock = async (refBlock, faceVec) => {
    const placedPos = refBlock.position.plus(faceVec);
    worldBlocks.set(key(placedPos), { name: 'obsidian', position: placedPos });
  };

  assert.equal(PORTAL_BUILD_STEPS.length, 11);
  const res = await buildObsidianFrame(bot);
  assert.equal(res.success, true);

  const base = new Vec3(0, 64, 0);
  for (const step of PORTAL_BUILD_STEPS) {
    const pos = base.plus(step.offset);
    assert.equal(bot.blockAt(pos).name, 'obsidian', `Expected obsidian at (${pos.x},${pos.y},${pos.z})`);
  }

  bot.placeBlock = async () => {
    throw new Error('Placement obstructed');
  };
  const incompletePos = new Vec3(10, 64, 0);
  worldBlocks.set(key(incompletePos), { name: 'grass_block', position: incompletePos });
  bot.findBlock = () => worldBlocks.get(key(incompletePos));
  const failRes = await buildObsidianFrame(bot);
  assert.equal(failRes.success, false);
  assert.ok(failRes.message.includes('incomplete'));
});

test('Unified 3D scan collects blocks and exposed ores in one pass and wikiData caches results', () => {
  const { Vec3 } = require('vec3');
  const bot = createMockBot([{ name: 'stone_pickaxe', count: 1 }]);
  bot.entity.position = new Vec3(0, 64, 0);

  let blockAtCalls = 0;
  bot.blockAt = (pos) => {
    blockAtCalls++;
    if (pos.x === 1 && pos.y === 64 && pos.z === 0) {
      return { name: 'iron_ore', position: pos.clone() };
    }
    return { name: 'air', position: pos.clone() };
  };

  const env = scanEnvironment(bot, 2, 2);
  assert.equal(env.iron_ore, 1);
  assert.equal(env.exposedOres.iron_ore, 1);
  assert.equal(JSON.stringify(env), '{"iron_ore":1}');

  const callsAfterScan = blockAtCalls;
  const prompt = buildReactPrompt(bot, state, env, null);
  assert.ok(prompt.includes('1x iron_ore'));
  assert.equal(blockAtCalls, callsAfterScan + 11);

  const logsFirst = getBlockNamesForTarget(bot, 'log');
  const logsSecond = getBlockNamesForTarget(bot, 'wood');
  assert.equal(logsFirst, logsSecond);
  assert.deepEqual(getBlockNamesForTarget(bot, 'oak_log'), ['oak_log']);
  assert.equal(getOreBlockNames(bot), getOreBlockNames(bot));
});

test('Wood species isolation, generic plank wiki recipes, and foliage unstuck prevent early-game loops', () => {
  const bot = createMockBot([
    { name: 'jungle_log', count: 40 },
    { name: 'jungle_planks', count: 5 }
  ]);

  assert.equal(invUtils.countItem(bot, 'oak_log'), 0);
  assert.equal(invUtils.countItem(bot, 'jungle_log'), 40);
  assert.equal(invUtils.countItem(bot, 'log'), 40);
  assert.equal(invUtils.countItem(bot, 'oak_planks'), 0);
  assert.equal(invUtils.countItem(bot, 'planks'), 5);

  const wikiPickaxe = skillWiki(bot, 'wooden_pickaxe');
  assert.ok(wikiPickaxe.message.includes('3x planks'));
  assert.ok(!wikiPickaxe.message.includes('oak_planks'));

  assert.equal(isDiggableObstacle({ name: 'jungle_leaves' }), true);
  assert.equal(isDiggableObstacle({ name: 'jungle_log' }), true);
  assert.equal(isDiggableObstacle({ name: 'bedrock' }), false);
});

test('Water bucket scooping via mine/place and solid block placement on tree logs work offline', async () => {
  const { Vec3 } = require('vec3');
  const bot = createMockBot([
    { name: 'bucket', count: 1 },
    { name: 'crafting_table', count: 1 }
  ]);
  bot.entity.position = new Vec3(0, 64, 0);
  bot.clearControlStates = () => {};
  bot.equip = async () => {};
  bot.lookAt = async () => {};
  bot.waitForTicks = async () => {};

  const wikiWater = skillWiki(bot, 'water_bucket');
  assert.ok(wikiWater.message.includes("Fill an empty 'bucket'"));

  const waterId = mcData.blocksByName.water.id;
  const waterPos = new Vec3(2, 64, 0);
  bot.findBlock = ({ matching }) => {
    const candidate = { name: 'water', type: waterId, metadata: 0, position: waterPos };
    return matching(candidate) ? candidate : null;
  };
  bot.activateItem = async () => {
    bot.inventory.slots[9] = { name: 'water_bucket', count: 1, type: mcData.itemsByName.water_bucket.id };
  };

  const scoopRes = await dispatchSkill(bot, state, 'mine', 'water', 1);
  assert.equal(scoopRes.success, true);
  assert.equal(invUtils.countItem(bot, 'water_bucket'), 1);

  const logPos = new Vec3(1, 63, 0);
  bot.findBlock = ({ matching }) => {
    const candidate = { name: 'oak_log', boundingBox: 'block', position: logPos };
    return matching(candidate) ? candidate : null;
  };
  bot.placeBlock = async () => {};

  const placeRes = await dispatchSkill(bot, state, 'place', 'crafting_table', 1);
  assert.equal(placeRes.success, true);

  const equipOrder = [];
  const armorBot = createMockBot([
    { name: 'iron_helmet', count: 1 },
    { name: 'iron_chestplate', count: 1 },
    { name: 'iron_leggings', count: 1 },
    { name: 'iron_boots', count: 1 },
    { name: 'shield', count: 1 }
  ]);
  armorBot.equip = async (item, dest) => {
    equipOrder.push(`${item.name}->${dest}`);
  };

  const equipRes = await dispatchSkill(armorBot, state, 'equip', 'armor', 1);
  assert.equal(equipRes.success, true);
  assert.deepEqual(equipOrder, [
    'iron_helmet->head',
    'iron_chestplate->torso',
    'iron_leggings->legs',
    'iron_boots->feet',
    'shield->off-hand'
  ]);
});

test('Event-driven Manager skips intermediate successes and triggers on failures, loops, objectives, or heartbeat', () => {
  const bot = createMockBot([{ name: 'oak_log', count: 2 }]);
  const mockState = {
    managerSubGoal: { action: 'mine', target: 'log' },
    lastActionResult: { action: 'mine', target: 'log', success: true, message: 'OK' },
    actionHistory: [{ action: 'mine', target: 'log', success: true }],
    cyclesSinceLastManager: 0
  };

  assert.equal(manager.shouldRunManager(bot, mockState, false), false);
  mockState.cyclesSinceLastManager = 1;
  assert.equal(manager.shouldRunManager(bot, mockState, false), false);
  mockState.cyclesSinceLastManager = 2;
  assert.equal(manager.shouldRunManager(bot, mockState, false), true);

  mockState.cyclesSinceLastManager = 0;
  assert.equal(manager.shouldRunManager(bot, mockState, true), true);

  mockState.lastActionResult = { action: 'craft', target: 'planks', success: false, message: 'Failed' };
  assert.equal(manager.shouldRunManager(bot, mockState, false), true);
});

test('Radar prompt filters out decorative plants and unbreakable blocks while keeping actionable blocks', () => {
  const bot = createMockBot();
  const rawEnvironment = {
    stone: 42,
    oak_log: 5,
    iron_ore: 3,
    water: 10,
    short_grass: 25,
    tall_grass: 12,
    dandelion: 4,
    poppy: 2,
    bedrock: 15
  };

  const filtered = filterRadarEnvironment(bot, rawEnvironment);
  assert.deepEqual(filtered, {
    stone: 42,
    oak_log: 5,
    iron_ore: 3,
    water: 10
  });

  const prompt = buildReactPrompt(bot, state, rawEnvironment, null);
  assert.ok(prompt.includes('"stone":42'));
  assert.ok(prompt.includes('"oak_log":5'));
  assert.ok(!prompt.includes('short_grass'));
  assert.ok(!prompt.includes('dandelion'));
  assert.ok(!prompt.includes('bedrock'));
});

test('Ollama configuration supports custom host and structured outputs schemas constrain actions', () => {
  assert.equal(typeof config.OLLAMA_HOST, 'string');
  assert.ok(config.OLLAMA_HOST.startsWith('http'));

  const playerSchema = getFormatSchema('joueur');
  assert.equal(playerSchema, PLAYER_JSON_SCHEMA);
  assert.equal(playerSchema.type, 'object');
  assert.deepEqual(playerSchema.required, ['thought', 'action', 'target']);
  assert.deepEqual(playerSchema.properties.action.enum, Array.from(config.VALID_ACTIONS));

  const managerSchema = getFormatSchema('manager');
  assert.equal(managerSchema, MANAGER_JSON_SCHEMA);
  assert.equal(managerSchema.type, 'object');
  assert.deepEqual(managerSchema.required, ['thought', 'directive', 'suggestedAction', 'suggestedTarget']);
  assert.deepEqual(managerSchema.properties.suggestedAction.enum, Array.from(config.VALID_ACTIONS));
  assert.equal(playerSchema.properties.target.maxLength, 32);
  assert.equal(managerSchema.properties.suggestedTarget.maxLength, 32);
});

test('Target sanitization filters out hallucinated text', () => {
  // Tester : Nettoyer un texte verbeux issu du LLM
  const verboseDecision = {
    action: 'craft',
    target: "planks_oak_planks_from_logs_in_inventory_and_mine_more_if_needed_but_first_craft_planks_to_clear_space_for_chest_or_table_logic: I have logs",
    thought: 'Need planks'
  };
  const resolved = resolvePlayerDecision(verboseDecision);
  assert.equal(resolved.action, 'craft');
  assert.equal(resolved.target, 'none');

  // Tester : Conserver une cible valide
  const validDecision = { action: 'mine', target: 'oak_log', qty: 3 };
  const resolvedValid = resolvePlayerDecision(validDecision);
  assert.equal(resolvedValid.action, 'mine');
  assert.equal(resolvedValid.target, 'oak_log');
  assert.equal(resolvedValid.qty, 3);
});

test('Structural refactoring step 1 exposes new modules and action primitives', () => {
  // Charger : Vérifier les modules relocalisés de la nouvelle structure
  const directDispatcher = require('../src/actions/dispatcher');
  const directLoop = require('../src/agent/loop');
  const directManager = require('../src/agent/manager');
  const directPrompt = require('../src/agent/prompt');
  const directState = require('../src/core/state');
  const directConfig = require('../src/infrastructure/config');
  const directInventory = require('../src/perception/inventory');
  const directEnvironment = require('../src/perception/environment');
  const directWikiData = require('../src/minecraft/wikiData');

  assert.equal(typeof directDispatcher.dispatchSkill, 'function');
  assert.equal(typeof directLoop.handleSurvivalRequest, 'function');
  assert.equal(typeof directManager.runManagerCycle, 'function');
  assert.equal(typeof directPrompt.buildReactPrompt, 'function');
  assert.equal(typeof directState.currentObjective, 'string');
  assert.equal(typeof directConfig.BOT_CONFIG, 'object');
  assert.equal(typeof directInventory.countItem, 'function');
  assert.equal(typeof directEnvironment.scanEnvironment, 'function');
  assert.equal(typeof directWikiData.getMcData, 'function');

  // Vérifier : Contrôler l'exposition des primitives élémentaires
  const primMovement = require('../src/actions/primitives/movement');
  const primBlocks = require('../src/actions/primitives/blocks');
  const primItems = require('../src/actions/primitives/items');
  const primContainer = require('../src/actions/primitives/container');
  const primCombat = require('../src/actions/primitives/combat');

  assert.equal(typeof primMovement.gotoCoordinates, 'function');
  assert.equal(typeof primMovement.jump, 'function');
  assert.equal(typeof primMovement.stopMovement, 'function');
  assert.equal(typeof primBlocks.breakBlockAt, 'function');
  assert.equal(typeof primBlocks.placeBlockOnFace, 'function');
  assert.equal(typeof primItems.equipItem, 'function');
  assert.equal(typeof primItems.consumeItem, 'function');
  assert.equal(typeof primItems.craftRecipe, 'function');
  assert.equal(typeof primItems.dropItem, 'function');
  assert.equal(typeof primContainer.openContainer, 'function');
  assert.equal(typeof primContainer.depositItem, 'function');
  assert.equal(typeof primContainer.withdrawItem, 'function');
  assert.equal(typeof primContainer.transferItem, 'function');
  assert.equal(typeof primContainer.closeContainer, 'function');
  assert.equal(typeof primCombat.attackEntity, 'function');
  assert.equal(typeof primCombat.attackTarget, 'function');
  assert.equal(typeof primCombat.followEntity, 'function');
  assert.equal(typeof primCombat.faceTarget, 'function');
});

test('Radar keeps nether_portal, findCastOriginNearLava locates flat site, and water unstuck navigates to dry land', async () => {
  const { Vec3 } = require('vec3');
  const botRadar = createMockBot();
  const filtered = filterRadarEnvironment(botRadar, {
    stone: 10,
    nether_portal: 6,
    bedrock: 15,
    dandelion: 4,
    short_grass: 8
  });
  assert.deepEqual(filtered, { stone: 10, nether_portal: 6 });

  const blocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  for (let x = -12; x <= 12; x++) {
    for (let z = -12; z <= 12; z++) {
      blocks.set(key(new Vec3(x, 63, z)), { name: 'stone', position: new Vec3(x, 63, z) });
      blocks.set(key(new Vec3(x, 64, z)), { name: 'stone', position: new Vec3(x, 64, z) });
    }
  }
  blocks.set(key(new Vec3(0, 64, 0)), { name: 'lava', position: new Vec3(0, 64, 0), metadata: 0 });
  const lavaBot = {
    blockAt: (pos) => blocks.get(key(pos)) || { name: 'air', position: pos }
  };
  const castOrigin = findCastOriginNearLava(lavaBot, new Vec3(0, 64, 0));
  assert.ok(castOrigin);
  assert.equal(castOrigin.y, 64);

  const waterBot = createMockBot();
  let goalReached = null;
  waterBot.entity.isInWater = true;
  waterBot.clearControlStates = () => {};
  waterBot.setControlState = () => {};
  waterBot.waitForTicks = async () => {};
  waterBot.blockAt = (pos) => {
    if (pos.x === 6 && pos.y === 64 && pos.z === 0) return { name: 'grass_block', position: new Vec3(6, 64, 0) };
    return { name: 'air', position: pos };
  };
  waterBot.findBlock = () => ({ name: 'grass_block', position: new Vec3(6, 64, 0) });
  waterBot.pathfinder.goto = async (goal) => {
    goalReached = { x: goal.x, y: goal.y, z: goal.z };
    // Reaching the shore takes the bot out of the water: unstuck only reports success when that is true
    waterBot.entity.isInWater = false;
  };

  const unstuckRes = await skillUnstuck(waterBot);
  assert.equal(unstuckRes.success, true);
  assert.ok(unstuckRes.message.includes('dry land'));
  assert.deepEqual(goalReached, { x: 6, y: 65, z: 0 });
});

test('Nether portal prompt skips pickaxe advice and unreachable mold marks lava pool bad', async () => {
  const { Vec3 } = require('vec3');
  const prevObjective = state.currentObjective;
  state.currentObjective = 'nether_portal';
  const noPickBot = createMockBot([{ name: 'flint_and_steel', count: 1 }, { name: 'water_bucket', count: 1 }]);
  const prompt = buildReactPrompt(noPickBot, state, { stone: 20 }, null);
  assert.ok(prompt.includes("ne perds pas de temps à fabriquer une pioche"));
  assert.equal(prompt.includes("fabrique d'abord une 'wooden_pickaxe'"), false);
  state.currentObjective = prevObjective;

  const blocks = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  for (let x = -12; x <= 12; x++) {
    for (let z = -12; z <= 12; z++) {
      blocks.set(key(new Vec3(x, 25, z)), { name: 'stone', position: new Vec3(x, 25, z) });
      blocks.set(key(new Vec3(x, 26, z)), { name: 'stone', position: new Vec3(x, 26, z) });
    }
  }
  const lavaPos = new Vec3(0, 26, 0);
  const lavaBlock = { name: 'lava', position: lavaPos, metadata: 0 };
  blocks.set(key(lavaPos), lavaBlock);

  const farBot = createMockBot([{ name: 'cobblestone', count: 32 }, { name: 'water_bucket', count: 1 }]);
  farBot.entity.position = {
    x: 0,
    y: 48,
    z: 0,
    floored() { return new Vec3(0, 48, 0); },
    distanceTo(other) { return Math.hypot(other.x, other.y - 48, other.z); }
  };
  farBot.blockAt = (pos) => blocks.get(key(pos)) || { name: 'air', position: pos };
  farBot.clearControlStates = () => {};
  farBot.pathfinder.goto = async () => {
    throw new Error('Took to long to decide path to goal!');
  };

  const castRes = await castPortalWithMold(farBot, { portalCastOrigin: null }, lavaBlock);
  assert.equal(castRes.success, false);
  assert.ok(castRes.message.includes('unreachable'));

  const grassStandBot = {
    blockAt: (pos) => {
      if (pos.y <= 64 && Math.abs(pos.x) <= 6 && Math.abs(pos.z) <= 6) {
        if (pos.x === 0 && pos.y === 64 && pos.z === 0) return { name: 'lava', position: pos };
        return { name: 'grass_block', position: pos };
      }
      if (pos.y === 65) return { name: 'short_grass', boundingBox: 'empty', position: pos };
      return { name: 'air', position: pos };
    }
  };
  const grassOrigin = findCastOriginNearLava(grassStandBot, new Vec3(0, 64, 0));
  assert.ok(grassOrigin);

  const emptyWorldBot = createMockBot([{ name: 'cobblestone', count: 32 }, { name: 'water_bucket', count: 1 }]);
  emptyWorldBot.blockAt = (pos) => ({ name: 'air', position: pos });
  const badLavaRes = await castPortalWithMold(emptyWorldBot, { portalCastOrigin: null }, { name: 'lava', position: new Vec3(20, 64, 20) });
  assert.equal(badLavaRes.success, false);
  assert.ok(badLavaRes.message.includes('marked lava pool bad'));

  const lavaId = mcData.blocksByName.lava.id;
  const clusterBlocks = new Map([
    ['40,20,40', { name: 'lava', type: lavaId, metadata: 0, position: new Vec3(40, 20, 40) }],
    ['41,20,40', { name: 'lava', type: lavaId, metadata: 0, position: new Vec3(41, 20, 40) }]
  ]);
  const clusterBot = createMockBot();
  clusterBot.blockAt = (pos) => clusterBlocks.get(`${pos.x},${pos.y},${pos.z}`) || { name: 'air', type: 0, position: pos };
  clusterBot.findBlocks = ({ matching }) => Array.from(clusterBlocks.values()).filter(matching).map(b => b.position);
  assert.ok(findBestLavaPool(clusterBot));
  markLavaClusterBad(clusterBot, new Vec3(40, 20, 40), 4);
  assert.equal(findBestLavaPool(clusterBot), null);

  const prevObj = state.currentObjective;
  state.currentObjective = 'nether_portal';
  const portalPrompt = buildReactPrompt(createMockBot(), state, { stone: 10 }, null);
  assert.ok(portalPrompt.includes("NE fabrique PAS de coffre"));
  state.currentObjective = prevObj;

  const moveBot = createMockBot();
  moveBot.clearControlStates = () => {};
  moveBot.pathfinder = {
    movements: { canDig: true, allow1by1towers: true },
    setGoal: () => {},
    goto: async () => {
      assert.equal(moveBot.pathfinder.movements.canDig, false);
      assert.equal(moveBot.pathfinder.movements.allow1by1towers, false);
    }
  };
  await moveExploreStep(moveBot, 10, 10, true);
  assert.equal(moveBot.pathfinder.movements.canDig, true);
  assert.equal(moveBot.pathfinder.movements.allow1by1towers, true);

  const ceilingBot = createMockBot();
  ceilingBot.entity.position = new Vec3(0, 64, 0);
  ceilingBot.blockAt = (pos) => ({ name: pos.y === 69 ? 'stone' : 'air' });
  assert.equal(hasSolidCeilingAbove(ceilingBot), true);

  ceilingBot.blockAt = (pos) => ({ name: pos.y === 69 ? 'oak_leaves' : 'air' });
  assert.equal(hasSolidCeilingAbove(ceilingBot), false);

  const yawEast = headingToMineflayerYaw(0);
  assert.ok(Math.abs(-Math.sin(yawEast) - 1) < 1e-6 && Math.abs(-Math.cos(yawEast)) < 1e-6);
  const yawSouth = headingToMineflayerYaw(Math.PI / 2);
  assert.ok(Math.abs(-Math.sin(yawSouth)) < 1e-6 && Math.abs(-Math.cos(yawSouth) - 1) < 1e-6);
  const yawWest = headingToMineflayerYaw(Math.PI);
  assert.ok(Math.abs(-Math.sin(yawWest) + 1) < 1e-6 && Math.abs(-Math.cos(yawWest)) < 1e-6);
  const yawNorth = headingToMineflayerYaw(-Math.PI / 2);
  assert.ok(Math.abs(-Math.sin(yawNorth)) < 1e-6 && Math.abs(-Math.cos(yawNorth) + 1) < 1e-6);

  assert.equal(isBoxStuck([{ x: -471, z: 57 }, { x: -458, z: 49 }, { x: -480, z: 57 }, { x: -487, z: 69 }]), true);
  assert.equal(isBoxStuck([{ x: -471, z: 57 }, { x: -430, z: 57 }, { x: -480, z: 57 }, { x: -487, z: 69 }]), false);
  assert.equal(isBoxStuck([{ x: 0, z: 0 }, { x: 5, z: 5 }]), false);
});

test('Data-driven tool selection, safe unequip in breakBlockAt, and mold scaffold gathering work accurately', async () => {
  const { Vec3 } = require('vec3');

  const mixedBot = createMockBot([
    { name: 'golden_pickaxe' },
    { name: 'stone_pickaxe' },
    { name: 'iron_axe' },
    { name: 'iron_shovel' },
    { name: 'iron_hoe' },
    { name: 'iron_sword' },
    { name: 'water_bucket' }
  ]);
  assert.equal(invUtils.getBestToolForBlock(mixedBot, { name: 'iron_ore' })?.name, 'stone_pickaxe');
  assert.equal(invUtils.getBestToolForBlock(mixedBot, { name: 'crimson_stem' })?.name, 'iron_axe');
  assert.equal(invUtils.getBestToolForBlock(mixedBot, { name: 'soul_soil' })?.name, 'iron_shovel');
  assert.equal(invUtils.getBestToolForBlock(mixedBot, { name: 'snow' })?.name, 'iron_shovel');
  assert.equal(invUtils.getBestToolForBlock(mixedBot, { name: 'nether_wart_block' })?.name, 'iron_hoe');

  const goldOnlyBot = createMockBot([{ name: 'golden_pickaxe' }]);
  assert.equal(invUtils.getBestToolForBlock(goldOnlyBot, { name: 'iron_ore' }), null);
  assert.equal(invUtils.getBestToolForBlock(goldOnlyBot, { name: 'netherrack' })?.name, 'golden_pickaxe');

  const ironBot = createMockBot([{ name: 'iron_pickaxe' }, { name: 'iron_sword' }]);
  assert.equal(invUtils.getBestToolForBlock(ironBot, { name: 'obsidian' }), null);
  assert.equal(invUtils.getBestToolForBlock(ironBot, { name: 'granite' })?.name, 'iron_pickaxe');
  assert.equal(invUtils.getBestToolForBlock(ironBot, { name: 'basalt' })?.name, 'iron_pickaxe');
  assert.equal(invUtils.getBestToolForBlock(ironBot, { name: 'netherrack' })?.name, 'iron_pickaxe');

  const wrongToolsBot = createMockBot([{ name: 'iron_sword' }, { name: 'water_bucket' }]);
  assert.equal(invUtils.getBestToolForBlock(wrongToolsBot, { name: 'stone' }), null);
  assert.equal(invUtils.getBestToolForBlock(wrongToolsBot, { name: 'dirt' }), null);
  assert.equal(invUtils.isToolOrWeapon('iron_sword'), true);
  assert.equal(invUtils.isToolOrWeapon('dirt'), false);

  const actions = [];
  let brokenStone = false;
  const stoneBreakBot = createMockBot([{ name: 'iron_pickaxe' }]);
  stoneBreakBot.entity.position = new Vec3(0, 64, 0);
  stoneBreakBot.lookAt = async () => {};
  stoneBreakBot.canDigBlock = () => true;
  stoneBreakBot.blockAt = (pos) => {
    if (pos.x === 2 && pos.y === 64 && pos.z === 0) {
      return brokenStone ? { name: 'air', diggable: false } : { name: 'stone', diggable: true };
    }
    return { name: 'air', diggable: false };
  };
  stoneBreakBot.equip = async (item) => { actions.push(`equip:${item.name}`); };
  stoneBreakBot.dig = async () => { actions.push('dig:stone'); brokenStone = true; };
  const stoneRes = await breakBlockAt(stoneBreakBot, new Vec3(2, 64, 0));
  assert.equal(stoneRes.success, true);
  assert.deepEqual(actions, ['equip:iron_pickaxe', 'dig:stone']);

  const dirtActions = [];
  let brokenDirt = false;
  const dirtBreakBot = createMockBot([{ name: 'iron_sword' }]);
  dirtBreakBot.heldItem = { name: 'iron_sword' };
  dirtBreakBot.entity.position = new Vec3(0, 64, 0);
  dirtBreakBot.lookAt = async () => {};
  dirtBreakBot.canDigBlock = () => true;
  dirtBreakBot.blockAt = (pos) => {
    if (pos.x === 2 && pos.y === 64 && pos.z === 0) {
      return brokenDirt ? { name: 'air', diggable: false } : { name: 'dirt', diggable: true };
    }
    return { name: 'air', diggable: false };
  };
  dirtBreakBot.unequip = async (slot) => { dirtActions.push(`unequip:${slot}`); };
  dirtBreakBot.dig = async () => { dirtActions.push('dig:dirt'); brokenDirt = true; };
  const dirtRes = await breakBlockAt(dirtBreakBot, new Vec3(2, 64, 0));
  assert.equal(dirtRes.success, true);
  assert.deepEqual(dirtActions, ['unequip:hand', 'dig:dirt']);

  const prevState = {
    currentObjective: state.currentObjective,
    lastActionResult: state.lastActionResult,
    managerDirective: state.managerDirective,
    managerSubGoal: state.managerSubGoal
  };
  try {
    state.currentObjective = 'nether_portal';
    state.lastActionResult = null;
    const lavaBot = createMockBot([{ name: 'flint_and_steel' }, { name: 'water_bucket' }]);
    assert.equal(countScaffoldBlocks(lavaBot), 0);
    const lavaId = mcData.blocksByName.lava.id;
    lavaBot.findBlock = ({ matching }) => {
      if (typeof matching !== 'function') return null;
      const lavaCandidate = { name: 'lava', type: lavaId, metadata: 0, position: new Vec3(4, 64, 0) };
      if (matching(lavaCandidate)) return lavaCandidate;
      const grassCandidate = { name: 'grass_block', type: mcData.blocksByName.grass_block.id, position: new Vec3(2, 63, 0) };
      if (matching(grassCandidate)) return grassCandidate;
      return null;
    };
    const assigned = manager.tryAssignPortalOrNetherGoal(lavaBot);
    assert.equal(assigned, true);
    assert.deepEqual(state.managerSubGoal, { action: 'mine', target: 'dirt', qty: 6, isReliable: true });

    const loopDecision = getReliableProcedureDecision(state);
    assert.equal(loopDecision.action, 'mine');
    assert.equal(loopDecision.target, 'dirt');
    assert.equal(loopDecision.qty, 6);
  } finally {
    state.currentObjective = prevState.currentObjective;
    state.lastActionResult = prevState.lastActionResult;
    state.managerDirective = prevState.managerDirective;
    state.managerSubGoal = prevState.managerSubGoal;
  }
});

test('Portal frame detector handles X/Z complete and partial frames without ignoring unlit portals', () => {
  const { Vec3 } = require('vec3');
  const obsidianId = mcData.blocksByName.obsidian.id;
  const lavaId = mcData.blocksByName.lava.id;
  const grassId = mcData.blocksByName.grass_block.id;

  const posKey = (p) => `${p.x},${p.y},${p.z}`;
  const coreSteps = PORTAL_BUILD_STEPS.filter(s => !s.isCorner);

  const zBase = new Vec3(5, 64, 10);
  const zSet = new Set(coreSteps.map(s => posKey(zBase.plus(orientOffset(s.offset, 'z')))));
  const zUpperBlock = zBase.plus(orientOffset(new Vec3(-1, 3, 0), 'z'));

  const createFrameBot = (items, obsKeys, seedObsPositions, extraOpts = {}) => {
    const b = createMockBot(items);
    b.blockAt = (pos) => {
      if (obsKeys.has(posKey(pos))) return { name: 'obsidian', type: obsidianId, position: pos };
      if (extraOpts.grassPos && posKey(pos) === posKey(extraOpts.grassPos)) {
        return { name: 'grass_block', type: grassId, position: pos };
      }
      return { name: 'air', boundingBox: 'empty' };
    };
    b.findBlocks = ({ matching }) => {
      if (matching === obsidianId) return seedObsPositions;
      if (typeof matching === 'function' && seedObsPositions.some(p => matching({ type: obsidianId, position: p }))) {
        return seedObsPositions;
      }
      return [];
    };
    b.findBlock = ({ matching }) => {
      if (typeof matching !== 'function') return null;
      if (extraOpts.lavaPos) {
        const lavaCandidate = { name: 'lava', type: lavaId, metadata: 0, position: extraOpts.lavaPos };
        if (matching(lavaCandidate)) return lavaCandidate;
      }
      if (extraOpts.grassPos) {
        const grassCandidate = { name: 'grass_block', type: grassId, position: extraOpts.grassPos };
        if (matching(grassCandidate)) return grassCandidate;
      }
      return null;
    };
    return b;
  };

  const zCandidate = findPortalFrameCandidate(createFrameBot([], zSet, [zUpperBlock]), 48);
  assert.ok(zCandidate);
  assert.equal(zCandidate.axis, 'z');
  assert.equal(zCandidate.isComplete, true);
  assert.equal(zCandidate.presentCount, 10);
  assert.equal(zCandidate.missingCount, 0);
  assert.deepEqual([zCandidate.base.x, zCandidate.base.y, zCandidate.base.z], [5, 64, 10]);

  const xBase = new Vec3(0, 64, 0);
  const partialXSet = new Set(coreSteps.slice(0, 4).map(s => posKey(xBase.plus(s.offset))));
  const partialXCandidate = findPortalFrameCandidate(createFrameBot([], partialXSet, [new Vec3(0, 64, 0)]), 48);
  assert.ok(partialXCandidate);
  assert.equal(partialXCandidate.axis, 'x');
  assert.equal(partialXCandidate.isComplete, false);
  assert.equal(partialXCandidate.presentCount, 4);
  assert.equal(partialXCandidate.missingCount, 6);

  const straySet = new Set([posKey(new Vec3(10, 64, 10))]);
  assert.equal(findPortalFrameCandidate(createFrameBot([], straySet, [new Vec3(10, 64, 10)]), 48), null);

  const prevState = {
    currentObjective: state.currentObjective,
    lastActionResult: state.lastActionResult,
    managerDirective: state.managerDirective,
    managerSubGoal: state.managerSubGoal
  };
  try {
    state.currentObjective = 'nether_portal';
    state.lastActionResult = null;

    const completeBot = createFrameBot([{ name: 'flint_and_steel' }], zSet, [zUpperBlock]);
    assert.equal(manager.findPortalOpportunity(completeBot), 'complete_frame');
    assert.equal(manager.tryAssignPortalOrNetherGoal(completeBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'portal', target: 'none', isReliable: true });

    const partial6Set = new Set(coreSteps.slice(0, 6).map(s => posKey(xBase.plus(s.offset))));
    const partialObsBot = createFrameBot([{ name: 'obsidian', count: 4 }], partial6Set, [new Vec3(0, 64, 0)]);
    assert.equal(manager.findPortalOpportunity(partialObsBot), 'partial_frame_obsidian');
    assert.equal(manager.tryAssignPortalOrNetherGoal(partialObsBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'portal', target: 'none', isReliable: true });

    const partialLavaBot = createFrameBot(
      [{ name: 'flint_and_steel' }, { name: 'water_bucket' }],
      partial6Set,
      [new Vec3(0, 64, 0)],
      { lavaPos: new Vec3(12, 64, 0), grassPos: new Vec3(2, 63, 0) }
    );
    assert.equal(manager.findPortalOpportunity(partialLavaBot), 'partial_frame_lava');
    assert.equal(manager.tryAssignPortalOrNetherGoal(partialLavaBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'mine', target: 'dirt', qty: 6, isReliable: true });
  } finally {
    state.currentObjective = prevState.currentObjective;
    state.lastActionResult = prevState.lastActionResult;
    state.managerDirective = prevState.managerDirective;
    state.managerSubGoal = prevState.managerSubGoal;
  }
});

test('skillPlace rejects furnace surface/hitbox overlap, blacklists failed spot, and falls back to valid ground', async () => {
  const { Vec3 } = require('vec3');
  clearBadBlocks();

  const furnaceSurface = { name: 'furnace', boundingBox: 'block', position: new Vec3(2, 99, 0) };
  const hitboxOverlap = { name: 'stone', boundingBox: 'block', position: new Vec3(1, 99, 0) };
  const failingGround = { name: 'stone', boundingBox: 'block', position: new Vec3(3, 99, 0) };
  const validGround = { name: 'dirt', boundingBox: 'block', position: new Vec3(-1, 99, 2) };
  const candidates = [furnaceSurface, hitboxOverlap, failingGround, validGround];

  const rejectedAt = [];
  const placedAt = [];
  const state = { base: {} };

  const bot = {
    entity: { position: new Vec3(0.8, 100, 0.5) },
    inventory: { items: () => [{ name: 'furnace', count: 1 }] },
    findBlock: ({ matching }) => candidates.find(block => matching(block)) || null,
    blockAt: (pos) => ({ name: 'air', position: pos }),
    equip: async () => {},
    lookAt: async () => {},
    waitForTicks: async () => {},
    placeBlock: async (refBlock) => {
      const key = `${refBlock.position.x},${refBlock.position.y},${refBlock.position.z}`;
      if (key === '3,99,0') {
        rejectedAt.push(key);
        throw new Error('Server refused to place furnace at (3, 100, 0): the block is still air');
      }
      placedAt.push(key);
    }
  };

  try {
    const result = await skillPlace(bot, state, 'furnace');
    assert.equal(result.success, true);
    assert.deepEqual(rejectedAt, ['3,99,0']);
    assert.deepEqual(placedAt, ['-1,99,2']);
    assert.equal(state.base.furnace.x, -1);
    assert.equal(state.base.furnace.y, 100);
    assert.equal(state.base.furnace.z, 2);
  } finally {
    clearBadBlocks();
  }
});

test('pourBucketAtFace returns false when bucket empties without target liquid and true when target forms water', async () => {
  const { Vec3 } = require('vec3');
  const targetPos = new Vec3(0, 68, -1);
  const refPos = new Vec3(0, 67, -1);
  const faceVec = new Vec3(0, 1, 0);
  const standPos = new Vec3(0, 64, 2);
  const waterExpected = new Set(['water', 'flowing_water']);

  let inv = [{ name: 'water_bucket', count: 1 }];
  let targetBlockName = 'air';
  let activateCalls = 0;

  const botSpill = {
    entity: { position: new Vec3(0.5, 64, 2.5) },
    inventory: { items: () => inv },
    blockAt: (pos) => (pos.equals(targetPos) ? { name: targetBlockName, position: pos } : { name: 'cobblestone', position: pos }),
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    clearControlStates: () => {},
    equip: async () => {},
    lookAt: async () => {},
    waitForTicks: async () => {},
    activateItem: async () => {
      activateCalls += 1;
      inv = [{ name: 'bucket', count: 1 }];
    }
  };

  const spillResult = await pourBucketAtFace(botSpill, 'water_bucket', targetPos, refPos, faceVec, standPos, waterExpected);
  assert.equal(spillResult, false);
  assert.equal(activateCalls, 1);

  inv = [{ name: 'water_bucket', count: 1 }];
  targetBlockName = 'air';
  activateCalls = 0;

  const botRetrySuccess = {
    ...botSpill,
    activateItem: async () => {
      activateCalls += 1;
      if (activateCalls === 2) {
        inv = [{ name: 'bucket', count: 1 }];
        targetBlockName = 'water';
      }
    }
  };

  const retryResult = await pourBucketAtFace(botRetrySuccess, 'water_bucket', targetPos, refPos, faceVec, standPos, waterExpected);
  assert.equal(retryResult, true);
  assert.equal(activateCalls, 2);
});

test('Lava memory records scanned sources, sorts by distance, and forgets blacklisted pools', () => {
  const { Vec3 } = require('vec3');
  const env = require('../src/utils/environment');
  env.clearKnownLava();
  env.clearBadBlocks();
  try {
    const lavaId = 10;
    const bot = {
      game: { dimension: 'overworld' },
      entity: { position: new Vec3(0, 64, 0) },
      registry: { blocksByName: { lava: { id: lavaId } } },
      blockAt: (pos) => {
        if (pos.x === 3 && pos.y === 62 && pos.z === 3) return { name: 'lava', type: lavaId, metadata: 0, position: pos };
        if (pos.x === -2 && pos.y === 60 && pos.z === 0) return { name: 'lava', type: lavaId, metadata: 3, position: pos };
        return { name: 'stone', position: pos };
      }
    };
    env.scanEnvironment(bot, 4, 4);
    env.rememberLava(new Vec3(100, 20, 100));
    const known = env.getKnownLava(new Vec3(0, 64, 0));
    assert.equal(known.length, 2);
    assert.deepEqual([known[0].position.x, known[0].position.y, known[0].position.z], [3, 62, 3]);
    assert.equal(env.getKnownLava(new Vec3(0, 64, 0), 'the_nether').length, 0);

    markLavaClusterBad(bot, new Vec3(3, 62, 3), 2);
    const afterForget = env.getKnownLava(new Vec3(0, 64, 0));
    assert.equal(afterForget.length, 1);
    assert.equal(afterForget[0].position.x, 100);
  } finally {
    env.clearKnownLava();
    env.clearBadBlocks();
  }
});

test('Deep descent goal targets lava layer and dispatcher redirects mine lava to explore during nether_portal', async () => {
  const { Vec3 } = require('vec3');
  const { createMaxYGoal, descendTowardsLavaDepth } = require('../src/skills/navigate');
  const goal = createMaxYGoal(-50);
  assert.equal(goal.isEnd({ y: -50 }), true);
  assert.equal(goal.isEnd({ y: -49 }), false);
  assert.equal(goal.heuristic({ y: -30 }), 20);

  let requestedGoal = null;
  const bot = {
    entity: { position: new Vec3(0, 70, 0) },
    pathfinder: {
      setGoal: () => {},
      goto: async (g) => {
        requestedGoal = g;
        bot.entity.position = new Vec3(0, 50, 0);
      }
    },
    clearControlStates: () => {}
  };
  const descended = await descendTowardsLavaDepth(bot, 2000);
  assert.equal(descended, true);
  assert.equal(requestedGoal.isEnd({ y: 50 }), true);
  assert.equal(requestedGoal.isEnd({ y: 51 }), false);

  const prevObjective = state.currentObjective;
  let mineCalled = false;
  const navBot = {
    game: { dimension: 'the_nether' },
    entity: { position: new Vec3(0, 70, 0), isInWater: false },
    registry: { blocksByName: {} },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air' }),
    findBlock: () => { mineCalled = true; return null; },
    pathfinder: { setGoal: () => {}, goto: async () => {}, movements: null },
    clearControlStates: () => {}
  };
  try {
    state.currentObjective = 'nether_portal';
    const res = await dispatchSkill(navBot, state, 'mine', 'lava_bucket', 1);
    assert.equal(typeof res.success, 'boolean');
    assert.ok(!/No 'lava' source block found nearby/.test(res.message));
    assert.equal(mineCalled, false);
  } finally {
    state.currentObjective = prevObjective;
  }
});

test('Hybrid Nether portal: lava_bucket recovery, water explore isolation, and diamond fallback supervision', async () => {
  const { Vec3 } = require('vec3');
  const env = require('../src/utils/environment');
  env.clearKnownLava();
  env.clearBadBlocks();

  let lavaInv = [{ name: 'lava_bucket', count: 1 }];
  const lavaId = mcData.blocksByName.lava.id;
  const lavaPourBot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: mcData,
    inventory: { items: () => lavaInv },
    blockAt: (pos) => {
      if (pos.y === 63) return { name: 'stone', position: pos };
      if (pos.x === 2 && pos.y === 64 && pos.z === 0) return { name: 'lava', type: lavaId, metadata: 0, position: pos };
      return { name: 'air', position: pos };
    },
    findBlock: ({ matching }) => {
      const candidate = { name: 'lava', type: lavaId, metadata: 0, position: new Vec3(2, 64, 0) };
      return matching(candidate) ? candidate : null;
    },
    equip: async () => {},
    lookAt: async () => {},
    waitForTicks: async () => {},
    activateItem: async () => {
      lavaInv = [{ name: 'bucket', count: 1 }];
    }
  };
  const emptied = await emptyLavaBucketSafely(lavaPourBot);
  assert.equal(emptied, true);
  assert.equal(invUtils.countItem(lavaPourBot, 'bucket'), 1);

  env.rememberLava(new Vec3(70, 93, 5), 'overworld');
  let exploreInv = [{ name: 'bucket', count: 1 }];
  const waterId = mcData.blocksByName.water.id;
  const waterBlock = { name: 'water', type: waterId, metadata: 0, position: new Vec3(8, 62, 0) };
  const visitedGoals = [];
  const waterBot = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0), isInWater: false },
    registry: mcData,
    inventory: { items: () => exploreInv },
    blockAt: () => ({ name: 'air' }),
    findBlock: ({ matching }) => (typeof matching === 'function' && matching(waterBlock) ? waterBlock : null),
    pathfinder: {
      movements: null,
      setGoal: () => {},
      goto: async (goal) => {
        visitedGoals.push({ x: goal.x, y: goal.y, z: goal.z });
        waterBot.entity.position = new Vec3(7, 63, 0);
      }
    },
    clearControlStates: () => {},
    equip: async () => {},
    lookAt: async () => {},
    waitForTicks: async () => {},
    activateItem: async () => {
      exploreInv = [{ name: 'water_bucket', count: 1 }];
    }
  };

  const exploreRes = await skillExplore(waterBot, { currentObjective: 'nether_portal' }, 'water');
  assert.equal(exploreRes.success, true);
  assert.equal(invUtils.countItem(waterBot, 'water_bucket'), 1);
  assert.ok(visitedGoals.every(g => g.x !== 70 || g.z !== 5));

  const prevState = {
    currentObjective: state.currentObjective,
    lastActionResult: state.lastActionResult,
    managerDirective: state.managerDirective,
    managerSubGoal: state.managerSubGoal,
    useDiamondPortalFallback: state.useDiamondPortalFallback,
    portalCastFailures: state.portalCastFailures,
    baseCraftingTable: state.base?.crafting_table
  };

  try {
    state.currentObjective = 'nether_portal';
    state.lastActionResult = null;
    state.useDiamondPortalFallback = false;

    const noWaterBot = {
      game: { dimension: 'overworld' },
      entity: { position: new Vec3(0, 64, 0), isInWater: false },
      registry: mcData,
      inventory: {
        items: () => [
          { name: 'iron_pickaxe', count: 1 },
          { name: 'flint_and_steel', count: 1 },
          { name: 'lava_bucket', count: 1 },
          { name: 'bucket', count: 1 }
        ]
      },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
      findBlock: () => null,
      findBlocks: () => [],
      health: 20,
      food: 20
    };
    assert.equal(manager.tryAssignPortalOrNetherGoal(noWaterBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'explore', target: 'water', isReliable: true });

    state.useDiamondPortalFallback = true;
    const diamondOreId = mcData.blocksByName.deepslate_diamond_ore.id;
    const diamondBlock = { name: 'deepslate_diamond_ore', type: diamondOreId, position: new Vec3(2, -54, 0) };
    const diamondMineBot = {
      ...noWaterBot,
      findBlock: ({ matching }) => (typeof matching === 'function' && matching(diamondBlock) ? diamondBlock : null)
    };
    assert.equal(manager.tryAssignPortalOrNetherGoal(diamondMineBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'mine', target: 'diamond_ore', qty: 3, isReliable: true });

    const tableId = mcData.blocksByName.crafting_table.id;
    const tableBlock = { name: 'crafting_table', type: tableId, position: new Vec3(1, 64, 0) };
    const craftDiamondPickBot = {
      ...noWaterBot,
      inventory: {
        items: () => [
          { name: 'iron_pickaxe', count: 1 },
          { name: 'diamond', count: 3 },
          { name: 'stick', count: 2 }
        ]
      },
      findBlock: ({ matching }) => (
        matching === tableId || (typeof matching === 'function' && matching(tableBlock)) ? tableBlock : null
      )
    };
    assert.equal(manager.tryAssignPortalOrNetherGoal(craftDiamondPickBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'craft', target: 'diamond_pickaxe', isReliable: true });

    const stonePickDiamondBot = {
      ...noWaterBot,
      inventory: {
        items: () => [
          { name: 'stone_pickaxe', count: 1 },
          { name: 'iron_ingot', count: 3 },
          { name: 'stick', count: 12 },
          { name: 'water_bucket', count: 1 },
          { name: 'flint_and_steel', count: 1 }
        ]
      },
      findBlock: ({ matching }) => (typeof matching === 'function' && matching(diamondBlock) ? diamondBlock : null)
    };
    assert.equal(manager.tryAssignPortalOrNetherGoal(stonePickDiamondBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'explore', target: 'log', isReliable: true });

    const stonePickWithTableBot = {
      ...stonePickDiamondBot,
      findBlock: ({ matching }) => {
        if (matching === tableId) return tableBlock;
        if (typeof matching === 'function' && matching(diamondBlock)) return diamondBlock;
        if (typeof matching === 'function' && matching(tableBlock)) return tableBlock;
        return null;
      }
    };
    assert.equal(manager.tryAssignPortalOrNetherGoal(stonePickWithTableBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'craft', target: 'iron_pickaxe', isReliable: true });

    const noIronFallbackBot = {
      ...stonePickDiamondBot,
      inventory: {
        items: () => [
          { name: 'stone_pickaxe', count: 1 },
          { name: 'water_bucket', count: 1 },
          { name: 'flint_and_steel', count: 1 }
        ]
      }
    };
    manager.tryAssignPortalOrNetherGoal(noIronFallbackBot);
    assert.notEqual(state.managerSubGoal?.target, 'diamond_ore');
    assert.equal(state.useDiamondPortalFallback, false);

    const noPickBot = {
      ...noWaterBot,
      inventory: {
        items: () => [
          { name: 'iron_ingot', count: 3 },
          { name: 'stick', count: 12 },
          { name: 'water_bucket', count: 1 },
          { name: 'flint_and_steel', count: 1 }
        ]
      }
    };
    assert.equal(manager.tryAssignPortalOrNetherGoal(noPickBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'explore', target: 'log', isReliable: true });
  } finally {
    env.clearKnownLava();
    env.clearBadBlocks();
    state.currentObjective = prevState.currentObjective;
    state.lastActionResult = prevState.lastActionResult;
    state.managerDirective = prevState.managerDirective;
    state.managerSubGoal = prevState.managerSubGoal;
    state.useDiamondPortalFallback = prevState.useDiamondPortalFallback;
    state.portalCastFailures = prevState.portalCastFailures;
    if (state.base) state.base.crafting_table = prevState.baseCraftingTable;
  }
});

test('3-turn /portal nether fallback enforces nether_portal milestone gate, sets keepInventory=true, and teleports to registered portal', async () => {
  const { Vec3 } = require('vec3');
  const prevState = {
    currentObjective: state.currentObjective,
    managerDirective: state.managerDirective,
    managerSubGoal: state.managerSubGoal,
    netherPortalAttempts: state.netherPortalAttempts,
    registeredPortalCoords: state.registeredPortalCoords
  };

  try {
    state.registeredPortalCoords = { x: 100, y: 64, z: -20 };
    state.netherPortalAttempts = 3;

    state.currentObjective = 'iron_pickaxe';
    const refused = await executeFallbackPortalTeleport(createMockBot([]), state);
    assert.equal(refused.success, false);
    assert.ok(refused.message.includes('Accès refusé'));

    state.currentObjective = 'nether_portal';
    const chatMessages = [];
    const portalBlockId = mcData.blocksByName.nether_portal.id;
    const portalBot = {
      username: 'Ollama',
      game: { dimension: 'overworld' },
      entity: { position: new Vec3(0, 64, 0) },
      registry: mcData,
      inventory: { items: () => [] },
      chat: (msg) => chatMessages.push(msg),
      waitForTicks: async () => {},
      findBlock: ({ matching }) => (
        matching === portalBlockId ? { name: 'nether_portal', type: portalBlockId, position: new Vec3(100, 64, -20) } : null
      ),
      pathfinder: {
        setGoal: () => {},
        goto: async () => {
          portalBot.game.dimension = 'the_nether';
        }
      }
    };

    assert.equal(manager.tryAssignPortalOrNetherGoal(portalBot), true);
    assert.deepEqual(state.managerSubGoal, { action: 'portal', target: 'none', isReliable: true });

    const res = await executeFallbackPortalTeleport(portalBot, state);
    assert.equal(res.success, true);
    assert.ok(chatMessages.includes('/gamerule keepInventory true'));
    assert.ok(chatMessages.includes('/execute in minecraft:the_nether run gamerule keepInventory true'));
    assert.ok(chatMessages.includes('/tp Ollama 100 64 -20'));
  } finally {
    state.currentObjective = prevState.currentObjective;
    state.managerDirective = prevState.managerDirective;
    state.managerSubGoal = prevState.managerSubGoal;
    state.netherPortalAttempts = prevState.netherPortalAttempts;
    state.registeredPortalCoords = prevState.registeredPortalCoords;
  }
});

test('tryPillarUp digs overhead stone, raises bot altitude with cobblestone, and aborts safely on overhead lava', async () => {
  const { Vec3 } = require('vec3');
  let cobbleCount = 1;
  let stoneBroken = false;
  const worldBlocks = new Map([
    ['0,7,0', 'stone']
  ]);

  const pillarBot = {
    registry: mcData,
    entity: { position: new Vec3(0, 8, 0), isInWater: false },
    inventory: {
      items: () => (cobbleCount > 0 ? [{ name: 'cobblestone', type: mcData.itemsByName.cobblestone.id, count: cobbleCount }] : [])
    },
    blockAt: (pos) => {
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (key === '0,10,0' && !stoneBroken) return { name: 'stone', position: new Vec3(0, 10, 0) };
      const name = worldBlocks.get(key) || 'air';
      return { name, position: pos.clone ? pos.clone() : new Vec3(pos.x, pos.y, pos.z) };
    },
    equip: async () => {},
    lookAt: async () => {},
    setControlState: () => {},
    clearControlStates: () => {},
    waitForTicks: async () => {},
    dig: async (block) => {
      if (block.position.x === 0 && block.position.y === 10 && block.position.z === 0) {
        stoneBroken = true;
      }
    },
    placeBlock: async (refBlock, face) => {
      const placedPos = refBlock.position.plus(face);
      worldBlocks.set(`${placedPos.x},${placedPos.y},${placedPos.z}`, 'cobblestone');
      cobbleCount -= 1;
      pillarBot.entity.position = new Vec3(0, 9, 0);
    },
    pathfinder: { setGoal: () => {} }
  };

  const climbed = await tryPillarUp(pillarBot, 10000);
  assert.equal(climbed, true);
  assert.equal(stoneBroken, true);
  assert.equal(pillarBot.entity.position.y, 9);

  let lavaDigCalled = false;
  const lavaBot = {
    registry: mcData,
    entity: { position: new Vec3(0, 8, 0), isInWater: false },
    inventory: {
      items: () => [{ name: 'cobblestone', type: mcData.itemsByName.cobblestone.id, count: 4 }]
    },
    blockAt: (pos) => {
      if (pos.x === 0 && pos.y === 10 && pos.z === 0) return { name: 'lava', position: new Vec3(0, 10, 0) };
      if (pos.x === 0 && pos.y === 7 && pos.z === 0) return { name: 'stone', position: new Vec3(0, 7, 0) };
      return { name: 'air', position: pos };
    },
    equip: async () => {},
    lookAt: async () => {},
    setControlState: () => {},
    clearControlStates: () => {},
    waitForTicks: async () => {},
    dig: async () => { lavaDigCalled = true; },
    placeBlock: async () => {},
    pathfinder: { setGoal: () => {} }
  };

  const lavaOutcome = await tryPillarUp(lavaBot, 10000);
  assert.equal(lavaOutcome, false);
  assert.equal(lavaDigCalled, false);
});

test('buildObsidianFrame tolerates null block positions and builds on cobbled_deepslate under cave_air', async () => {
  const { Vec3 } = require('vec3');
  const placed = new Set();
  const dug = new Set();
  const baseKey = (p) => `${p.x},${p.y},${p.z}`;
  const frameBot = {
    registry: mcData,
    entity: { position: new Vec3(0, -40, 2) },
    inventory: {
      items: () => [
        { name: 'obsidian', count: 10 },
        { name: 'cobblestone', count: 8 }
      ]
    },
    blockAt: (pos) => {
      const k = baseKey(pos);
      if (placed.has(k)) return { name: 'obsidian', position: pos };
      if (pos.y <= -41 && !dug.has(k)) return { name: 'cobbled_deepslate', position: pos };
      return { name: 'cave_air', position: pos, boundingBox: 'empty' };
    },
    findBlock: ({ matching }) => {
      assert.equal(matching({ name: 'cobbled_deepslate', position: null }), true);
      assert.equal(matching({ name: 'air', position: null }), false);
      const ground = { name: 'cobbled_deepslate', position: new Vec3(0, -41, 0) };
      return matching(ground) ? ground : null;
    },
    equip: async () => {},
    lookAt: async () => {},
    dig: async (block) => {
      dug.add(baseKey(block.position));
    },
    placeBlock: async (refBlock, face) => {
      const targetPos = refBlock.position.plus(face);
      const k = baseKey(targetPos);
      dug.delete(k);
      placed.add(k);
    },
    waitForTicks: async () => {},
    pathfinder: { goto: async () => {}, setGoal: () => {} }
  };

  const frameRes = await buildObsidianFrame(frameBot);
  assert.equal(frameRes.success, true);
  assert.ok(frameRes.portalInnerPos);
});

test('portal loop breaker skips blacklisted partial frames and respects blocked portal/explore pairs', () => {
  const { Vec3 } = require('vec3');
  const state = require('../src/core/state');
  const { markBadBlock } = require('../src/perception/environment');
  const { blockAction } = require('../src/agent/recovery');
  const { findPortalFrameCandidate } = require('../src/actions/behaviors/world/portal');
  const { tryAssignPortalOrNetherGoal } = require('../src/agent/manager');

  clearBadBlocks();
  const prev = {
    currentObjective: state.currentObjective,
    lastActionResult: state.lastActionResult,
    managerDirective: state.managerDirective,
    managerSubGoal: state.managerSubGoal,
    recovery: state.recovery,
    useDiamondPortalFallback: state.useDiamondPortalFallback,
    registeredPortalCoords: state.registeredPortalCoords
  };

  try {
    const obsidianId = mcData.blocksByName.obsidian.id;
    const lavaId = mcData.blocksByName.lava.id;
    const basePos = new Vec3(2, 53, 113);
    const frameObsidian = [new Vec3(2, 53, 113), new Vec3(3, 53, 113), new Vec3(1, 54, 113)];
    const lavaPos = new Vec3(10, 32, 118);

    const bot = {
      registry: mcData,
      health: 20,
      food: 20,
      game: { dimension: 'minecraft:overworld' },
      entity: { position: new Vec3(10, 32, 116), isInWater: false },
      entities: {},
      inventory: {
        items: () => [
          { name: 'flint_and_steel', count: 1 },
          { name: 'water_bucket', count: 1 },
          { name: 'stone_pickaxe', count: 1 },
          { name: 'cobblestone', count: 64 }
        ]
      },
      blockAt: (pos) => {
        if (frameObsidian.some(p => p.equals(pos))) return { name: 'obsidian', type: obsidianId, position: pos };
        if (pos.equals(lavaPos)) return { name: 'lava', type: lavaId, metadata: 0, position: pos };
        return { name: 'air', type: 0, position: pos };
      },
      findBlocks: ({ matching }) => {
        if (matching === obsidianId) return frameObsidian;
        const pool = [lavaPos, lavaPos.offset(1, 0, 0), lavaPos.offset(0, 0, 1), lavaPos.offset(1, 0, 1)];
        return pool.filter(p => typeof matching === 'function' && matching({ type: lavaId, metadata: 0, position: p }));
      },
      findBlock: ({ matching }) => {
        if (typeof matching === 'function' && matching({ type: lavaId, metadata: 0, position: lavaPos })) {
          return { name: 'lava', type: lavaId, metadata: 0, position: lavaPos };
        }
        return null;
      }
    };

    assert.ok(findPortalFrameCandidate(bot, 48));
    for (const pos of frameObsidian) markBadBlock(pos);
    assert.equal(findPortalFrameCandidate(bot, 48), null);

    state.currentObjective = 'nether_portal';
    state.useDiamondPortalFallback = false;
    state.registeredPortalCoords = null;
    state.recovery = null;
    state.lastActionResult = { action: 'explore', target: 'lava', success: false, message: 'Exploration timeout' };
    blockAction(state, 'portal', 'none', 'Lava pool unreachable', Date.now(), bot);

    assert.equal(tryAssignPortalOrNetherGoal(bot), true);
    assert.equal(state.managerSubGoal.action, 'explore');
    assert.equal(state.managerSubGoal.target, 'lava');

    blockAction(state, 'explore', 'lava', 'Exploration timeout', Date.now(), bot);
    state.managerSubGoal = null;
    assert.equal(tryAssignPortalOrNetherGoal(bot), false);
    assert.equal(state.managerSubGoal, null);
  } finally {
    clearBadBlocks();
    Object.assign(state, prev);
  }
});
