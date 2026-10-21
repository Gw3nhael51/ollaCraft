const test = require('node:test');
const assert = require('node:assert/strict');
const mcData = require('minecraft-data')('1.20.4');
const state = require('../src/state');
const invUtils = require('../src/utils/inventory');
const advUtils = require('../src/utils/advancements');
const storage = require('../src/skills/storage');
const manager = require('../src/ai/manager');

const { resolvePlayerDecision } = require('../src/ai/loop');
const { skillWiki } = require('../src/skills/wiki');
const { dispatchSkill } = require('../src/skills/dispatcher');
const { computeCraftOperations } = require('../src/skills/craft');
const { computeSmeltPlan } = require('../src/skills/smelt');
const { skillHunt, isPositionSafeForLoot } = require('../src/skills/combat');
const { buildObsidianFrame, PORTAL_BUILD_STEPS } = require('../src/skills/portal');
const { scanEnvironment } = require('../src/utils/environment');
const { getBlockNamesForTarget, getOreBlockNames } = require('../src/utils/wikiData');
const { buildReactPrompt, filterRadarEnvironment } = require('../src/ai/prompt');
const { isDiggableObstacle } = require('../src/skills/navigate');

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

test('Crafting table detection uses unified range, checks base coordinates, and clears missing table', () => {
  const bot = createMockBot([
    { name: 'oak_planks', count: 3 },
    { name: 'stick', count: 2 }
  ]);
  const tablePos = { x: 20, y: 64, z: 0 };
  state.base.crafting_table = tablePos;
  bot.entity.position.distanceTo = (target) => Math.hypot(target.x, target.z);
  bot.blockAt = (pos) => (pos === tablePos ? { name: 'crafting_table', position: tablePos } : { name: 'air' });
  bot.recipesFor = (id, _meta, _count, table) => (table ? [{ id }] : []);

  const table = invUtils.findNearbyCraftingTable(bot, state);
  assert.equal(table?.name, 'crafting_table');

  const sanitized = manager.sanitizeManagerOutput(bot, {
    suggestedAction: 'craft',
    suggestedTarget: 'wooden_pickaxe',
    directive: 'Craft wooden pickaxe'
  });
  assert.equal(sanitized.suggestedAction, 'craft');
  assert.equal(sanitized.suggestedTarget, 'wooden_pickaxe');

  const farPos = { x: 40, y: 64, z: 0 };
  state.base.crafting_table = farPos;
  bot.blockAt = (pos) => (pos === farPos ? { name: 'crafting_table', position: farPos } : { name: 'air' });
  assert.equal(invUtils.findNearbyCraftingTable(bot, state), null);

  bot.blockAt = () => ({ name: 'air' });
  assert.equal(invUtils.findNearbyCraftingTable(bot, state), null);
  assert.equal(state.base.crafting_table, null);
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
