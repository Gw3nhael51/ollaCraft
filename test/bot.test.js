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
