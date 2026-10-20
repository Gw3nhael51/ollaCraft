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
const { buildReactPrompt } = require('../src/ai/prompt');

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
  assert.equal(state.currentObjective, 'bucket');
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
});
