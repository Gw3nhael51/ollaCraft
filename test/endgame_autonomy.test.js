const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const mcData = require('minecraft-data')('1.20.4');

const config = require('../src/infrastructure/config');
const globalState = require('../src/core/state');
const invUtils = require('../src/perception/inventory');
const { resolveGoalPlan, getItemKnowledge, getOreDepthHint } = require('../src/minecraft/knowledge');
const triangulation = require('../src/minecraft/triangulation');
const recovery = require('../src/agent/recovery');
const planner = require('../src/agent/planner');
const goals = require('../src/agent/goals');
const progress = require('../src/core/progress');
const { handleSurvivalRequest } = require('../src/agent/loop');
const { buildReactPrompt, buildStaticRules } = require('../src/agent/prompt');
const { dispatchSkill } = require('../src/actions/dispatcher');
const { skillCraft } = require('../src/actions/behaviors/items/craft');
const { findBedPlacement, ensureSpawnBed } = require('../src/actions/behaviors/world/bed');
const { skillStronghold } = require('../src/actions/behaviors/world/stronghold');
const { isFrameFilled, scanPortalFrames } = require('../src/actions/behaviors/world/endportal');
const { computeBowAim, simulateArrowHeight } = require('../src/actions/behaviors/combat/dragon');
const { skillGoto } = require('../src/actions/behaviors/movement/waypoint');
const { ProcedureMemory } = require('../src/procedures/memory');
const { findPlacementSpots, placeItemNearby, isCellObstructed } = require('../src/actions/behaviors/blocks/placement');
const { deployCraftingTable } = require('../src/actions/behaviors/items/table');
const { hasDropAhead, getHeadingAwayFromSpawn } = require('../src/actions/behaviors/movement/navigate');
const { parseModelJson, PLAYER_JSON_SCHEMA, MANAGER_JSON_SCHEMA } = require('../src/agent/ollama');
const { handleBreath, LOW_OXYGEN_LEVEL } = require('../src/agent/watchdog');
const { getBlockNamesForTarget } = require('../src/minecraft/wikiData');
const water = require('../src/actions/behaviors/movement/water');
const environment = require('../src/perception/environment');
const { skillUnstuck, isDiggableObstacle } = require('../src/actions/behaviors/movement/navigate');

/**
 * Give a bot a rule-based voxel world and a minimal swimming simulation driven by its control states,
 * so water escapes can be played out: forward moves along the look direction, jump rises in water,
 * releasing it sinks, solid blocks stop the body, and gravity applies out of the water.
 * @param {object} bot Mock bot
 * @param {(x: number, y: number, z: number) => string} blockNameAt Rule returning the block name of a cell
 * @returns {{ setBlock: Function, dug: string[] }} World handle
 */
function attachSwimWorld(bot, blockNameAt) {
  const overrides = new Map();
  const dug = [];
  const keyOf = (x, y, z) => `${x},${y},${z}`;
  const nameAt = (x, y, z) => overrides.get(keyOf(x, y, z)) ?? blockNameAt(x, y, z);
  const makeBlock = (x, y, z) => {
    const name = nameAt(x, y, z);
    const passable = name === 'air' || name === 'water';
    return { name, boundingBox: passable ? 'empty' : 'block', position: new Vec3(x, y, z), diggable: name !== 'bedrock' };
  };
  const isSolid = (x, y, z) => {
    const name = nameAt(Math.floor(x), Math.floor(y), Math.floor(z));
    return name !== 'air' && name !== 'water';
  };
  const bodyFits = (x, y, z) => !isSolid(x, y, z) && !isSolid(x, y + 1.6, z);

  bot.blockAt = (pos) => makeBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  bot.findBlock = () => null;
  bot.findBlocks = () => [];
  bot.dig = async (block) => {
    dug.push(`${block.name}@${block.position.x},${block.position.y},${block.position.z}`);
    // Water pours into the opening when any neighbour is water, otherwise it becomes air
    const { x, y, z } = block.position;
    const wet = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => nameAt(x + dx, y + dy, z + dz) === 'water');
    overrides.set(keyOf(x, y, z), wet ? 'water' : 'air');
  };

  let yaw = 0;
  const controls = {};
  bot.look = async (newYaw) => { yaw = newYaw; };
  bot.setControlState = (name, value) => { controls[name] = value; };
  bot.clearControlStates = () => { Object.keys(controls).forEach((name) => { controls[name] = false; }); };

  const refreshLiquidFlag = () => {
    const pos = bot.entity.position;
    bot.entity.isInWater = nameAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) === 'water';
  };
  const stepOnce = () => {
    const pos = bot.entity.position;
    let { x, y, z } = pos;
    const inWater = nameAt(Math.floor(x), Math.floor(y), Math.floor(z)) === 'water';

    let nextY = y;
    if (inWater) nextY += controls.jump ? 0.1 : -0.1;
    else if (!isSolid(x, y - 0.05, z)) nextY -= 0.3;
    else if (controls.jump) nextY += 0.5;
    if (bodyFits(x, nextY, z)) y = nextY;
    else if (nextY < y) y = Math.floor(y);

    if (controls.forward) {
      // Mineflayer yaw: looking with yaw = atan2(-dx, -dz) faces the direction (dx, dz)
      const nextX = x - Math.sin(yaw) * 0.2;
      const nextZ = z - Math.cos(yaw) * 0.2;
      if (bodyFits(nextX, y, nextZ)) {
        x = nextX;
        z = nextZ;
      }
    }
    bot.entity.position = new Vec3(x, y, z);
    refreshLiquidFlag();
  };
  bot.waitForTicks = async (ticks = 1) => {
    for (let i = 0; i < ticks; i++) stepOnce();
  };

  refreshLiquidFlag();
  return { setBlock: (x, y, z, name) => overrides.set(keyOf(x, y, z), name), dug };
}

/**
 * Flooded chamber with a solid ceiling whose only way out dives through a lower tunnel, then rises into a
 * dry cave. Everything lies in the z=0 plane inside solid stone.
 * @param {number} x Cell X
 * @param {number} y Cell Y
 * @param {number} z Cell Z
 * @returns {string} Block name
 */
function floodedMineLayout(x, y, z) {
  if (z !== 0) return 'stone';
  if (x >= 0 && x <= 2 && y >= 10 && y <= 12) return 'water'; // flooded chamber, ceiling at y=13
  if (x >= 2 && x <= 6 && y >= 8 && y <= 9) return 'water'; // tunnel below the chamber
  if (x === 6 && y >= 10 && y <= 13) return 'water'; // shaft rising to the surface of the water
  if (x >= 6 && x <= 9 && y >= 14 && y <= 15) return 'air'; // dry cave above, floor at x=7..9
  return 'stone';
}

const IRON_GEAR = [
  ['iron_pickaxe', 1], ['iron_sword', 1], ['shield', 1],
  ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['iron_boots', 1]
];

/**
 * Build an inventory item stack from the real registry
 * @param {string} name Item name
 * @param {number} [count=1] Stack size
 * @returns {object} Item stack
 */
function makeItem(name, count = 1) {
  return { name, count, type: mcData.itemsByName[name].id, metadata: 0 };
}

/**
 * Create an offline bot with a real registry, a simple inventory and inert movement
 * @param {Array<[string, number]>} [items=[]] Inventory content
 * @param {object} [options={}] Dimension and position overrides
 * @returns {object} Mock bot
 */
function createBot(items = [], options = {}) {
  const slots = new Array(46).fill(null);
  items.forEach(([name, count], index) => {
    slots[9 + index] = makeItem(name, count);
  });

  const bot = {
    username: 'TestBot',
    version: '1.20.4',
    registry: mcData,
    health: 20,
    food: 20,
    game: { dimension: options.dimension || 'overworld' },
    entity: { position: options.position || new Vec3(0, 64, 0) },
    entities: {},
    inventory: {
      slots,
      items() { return slots.filter(Boolean); },
      emptySlotCount() { return slots.slice(9, 45).filter(slot => !slot).length; }
    },
    findBlock: () => null,
    findBlocks: () => [],
    blockAt: (pos) => ({ name: 'air', boundingBox: 'empty', position: pos }),
    recipesFor: () => [],
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    clearControlStates() {},
    setControlState() {},
    stopDigging() {},
    chat() {},
    equip: async (item) => { bot.heldItem = item; },
    lookAt: async () => {},
    waitForTicks: async () => {}
  };

  bot.give = (name, count = 1) => {
    const existing = slots.find(slot => slot?.name === name);
    if (existing) existing.count += count;
    else slots[slots.findIndex((slot, index) => index >= 9 && !slot)] = makeItem(name, count);
  };
  bot.take = (name, count = 1) => {
    const index = slots.findIndex(slot => slot?.name === name);
    if (index === -1) return;
    slots[index].count -= count;
    if (slots[index].count <= 0) slots[index] = null;
  };
  return bot;
}

/**
 * Create an isolated bot state so tests never leak into each other
 * @param {object} [overrides={}] State overrides
 * @returns {object} Fresh state
 */
function createState(overrides = {}) {
  return {
    isSurviving: true,
    currentObjective: 'wooden_pickaxe',
    manualObjective: false,
    manualObjectiveQty: 1,
    unlockedAdvancements: [],
    currentAdvancement: 'Stone Age',
    completedQuests: new Set(),
    base: { crafting_table: null, furnace: null, chest: null },
    deployedTable: null,
    waypoints: {},
    milestones: {},
    stronghold: { throws: [], estimate: null, located: false, reached: false },
    endPortal: { center: null, frameCount: 0, filledCount: 0 },
    progressFile: null,
    lastActionResult: { action: 'none', target: 'none', success: true, message: 'ready' },
    actionHistory: [],
    managerDirective: '',
    managerSubGoal: null,
    activeActionId: 0,
    recovery: null,
    metrics: { deterministicDecisions: 0, llmDecisions: 0, managerLlmCalls: 0, recoveries: 0 },
    ...overrides
  };
}

/**
 * Give a bot a small editable world: flat grass at y=63 around the origin, placing and digging blocks
 * @param {object} bot Mock bot
 * @returns {{ get: Function, set: Function, placed: string[] }} World handle
 */
function attachFlatWorld(bot) {
  const blocks = new Map();
  const key = (pos) => `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  const placed = [];

  const set = (pos, name) => {
    const position = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    if (name === 'air') blocks.delete(key(position));
    else blocks.set(key(position), { name, type: mcData.blocksByName[name].id, boundingBox: mcData.blocksByName[name].boundingBox, position });
  };
  const get = (pos) => blocks.get(key(pos)) || {
    name: 'air',
    type: 0,
    boundingBox: 'empty',
    position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
  };

  for (let x = -6; x <= 6; x++) {
    for (let z = -6; z <= 6; z++) set(new Vec3(x, 63, z), 'grass_block');
  }

  bot.blockAt = get;
  bot.findBlock = ({ matching, maxDistance = 16, point }) => {
    const origin = point || bot.entity.position;
    let best = null;
    let bestDistance = Infinity;
    for (const block of blocks.values()) {
      const distance = block.position.distanceTo(origin);
      if (distance > maxDistance) continue;
      let matches = block.type === matching;
      if (typeof matching === 'function') matches = matching(block);
      else if (Array.isArray(matching)) matches = matching.includes(block.type);
      if (matches && distance < bestDistance) {
        best = block;
        bestDistance = distance;
      }
    }
    return best;
  };
  bot.placeBlock = async (referenceBlock, face) => {
    const target = referenceBlock.position.plus(face);
    set(target, bot.heldItem.name);
    placed.push(bot.heldItem.name);
    bot.take(bot.heldItem.name, 1);
  };
  bot.dig = async (block) => {
    const name = get(block.position).name;
    set(block.position, 'air');
    if (name !== 'air') bot.give(name, 1);
  };

  return { get, set, placed };
}

test('Dependency planner mines raw resources instead of unpacking storage blocks and chains tool prerequisites', () => {
  const emptyBot = createBot();
  for (const resource of ['diamond', 'raw_iron', 'coal']) {
    const knowledge = getItemKnowledge(emptyBot, resource);
    assert.equal(knowledge.method, 'mine', `${resource} must be mined`);
    const plan = resolveGoalPlan(emptyBot, resource, 1, createState());
    assert.equal(plan.steps.some(step => step.target.endsWith('_block')), false, `${resource} plan must not craft a storage block`);
  }

  // Diamond is impossible with a stone pickaxe: the plan first builds the iron pickaxe, then mines the diamond
  const stoneAgeBot = createBot([['stone_pickaxe', 1], ['crafting_table', 1], ['stick', 4]]);
  const steps = resolveGoalPlan(stoneAgeBot, 'diamond', 2, createState()).steps.map(step => `${step.action}:${step.target}`);
  const ironPickIndex = steps.indexOf('craft:iron_pickaxe');
  const diamondIndex = steps.indexOf('mine:diamond_ore');
  assert.ok(steps.indexOf('mine:iron_ore') !== -1 && steps.indexOf('smelt:raw_iron') !== -1);
  assert.ok(ironPickIndex !== -1 && diamondIndex > ironPickIndex);

  // A better pickaxe already carried satisfies the requirement: no redundant iron pickaxe
  const diamondPickBot = createBot([['diamond_pickaxe', 1]]);
  assert.deepEqual(
    resolveGoalPlan(diamondPickBot, 'diamond', 1, createState()).steps.map(step => `${step.action}:${step.target}`),
    ['mine:diamond_ore']
  );

  // The portable table is never "placed" as a plan step, and side resources resolve to their real source
  const bedSteps = resolveGoalPlan(emptyBot, 'bed', 1, createState()).steps.map(step => `${step.action}:${step.target}`);
  assert.ok(bedSteps.includes('hunt:sheep') && bedSteps.at(-1) === 'craft:bed');
  assert.equal(bedSteps.includes('place:crafting_table'), false);
  assert.equal(getItemKnowledge(emptyBot, 'flint').actionTarget, 'gravel');
  assert.equal(getItemKnowledge(emptyBot, 'string').actionTarget, 'spider');
  assert.equal(getItemKnowledge(emptyBot, 'feather').actionTarget, 'chicken');

  assert.equal(getOreDepthHint('diamond'), -58);
  assert.equal(getOreDepthHint('deepslate_iron_ore'), 15);
  assert.equal(getOreDepthHint('oak_log'), null);
});

test('Quest chain runs to the Ender Dragon with spawn beds, dynamic eye needs and no false shortcuts', () => {
  assert.deepEqual(config.QUEST_CHAIN.slice(-12), [
    'bed', 'nether_portal', 'blaze_rod', 'blaze_powder', 'ender_pearl', 'ender_eye',
    'bow', 'arrow', 'end_bed', 'stronghold', 'end_portal', 'ender_dragon'
  ]);

  const objectiveOf = (bot, state) => {
    invUtils.syncObjective(bot, state);
    return state.currentObjective;
  };

  assert.equal(objectiveOf(createBot(), createState()), 'wooden_pickaxe');

  const portalReady = [...IRON_GEAR, ['flint_and_steel', 1], ['water_bucket', 1]];
  assert.equal(objectiveOf(createBot(portalReady), createState()), 'bed');
  assert.equal(objectiveOf(createBot([...portalReady, ['white_bed', 1]]), createState()), 'nether_portal');

  // In the Nether the rods come first; a looted bow must not skip the whole Nether stage
  assert.equal(objectiveOf(createBot(IRON_GEAR, { dimension: 'the_nether' }), createState()), 'blaze_rod');
  assert.equal(objectiveOf(createBot([...IRON_GEAR, ['blaze_rod', 7]], { dimension: 'the_nether' }), createState()), 'blaze_powder');
  assert.equal(objectiveOf(createBot([...portalReady, ['white_bed', 1], ['bow', 1]]), createState()), 'nether_portal');

  const withEyes = [...IRON_GEAR, ['ender_eye', 14]];
  assert.equal(objectiveOf(createBot(withEyes), createState()), 'bow');
  assert.equal(objectiveOf(createBot([...withEyes, ['bow', 1], ['arrow', 24]]), createState()), 'end_bed');
  assert.equal(objectiveOf(createBot([...withEyes, ['bow', 1], ['arrow', 24], ['white_bed', 1]]), createState()), 'stronghold');

  // Eyes thrown for triangulation and eyes placed in the frame lower the requirement instead of regressing the quest
  assert.equal(invUtils.getEyeRequirement(createState()), 14);
  const located = createState({ stronghold: { throws: [{}, {}], estimate: { x: 0, z: 0 }, located: true, reached: true } });
  assert.equal(invUtils.getEyeRequirement(located), 12);
  const afterThrows = [...IRON_GEAR, ['ender_eye', 12], ['bow', 1], ['arrow', 24], ['white_bed', 1]];
  assert.equal(objectiveOf(createBot(afterThrows), located), 'end_portal');
  located.endPortal.filledCount = 5;
  assert.equal(invUtils.getEyeRequirement(located), 7);

  // Losing the eyes after locating the stronghold sends the bot back for blaze rods through the Nether
  const lostEyes = createState({
    stronghold: { throws: [{}, {}], estimate: { x: 0, z: 0 }, located: true, reached: true },
    waypoints: { spawn_bed: { x: 0, y: 64, z: 0, dimension: 'overworld' } }
  });
  assert.equal(objectiveOf(createBot([...IRON_GEAR, ['bow', 1], ['arrow', 24]]), lostEyes), 'nether_portal');

  // Nothing else can be pursued inside the End
  assert.equal(objectiveOf(createBot([], { dimension: 'the_end' }), createState()), 'ender_dragon');
});

test('Goal command parses aliases and quantities and builds the prerequisite chain for a direct objective', () => {
  const bot = createBot([['stone_pickaxe', 1], ['crafting_table', 1], ['stick', 4]]);

  assert.deepEqual(goals.parseGoalCommand('objectif diamant 3', bot), { type: 'goal', objective: 'diamond', qty: 3 });
  assert.deepEqual(goals.parseGoalCommand('goal iron_pickaxe', bot), { type: 'goal', objective: 'iron_pickaxe', qty: 1 });
  assert.deepEqual(goals.parseGoalCommand('objectif pioche en fer', bot), { type: 'goal', objective: 'iron_pickaxe', qty: 1 });
  assert.deepEqual(goals.parseGoalCommand('objectif dragon', bot), { type: 'goal', objective: 'ender_dragon', qty: 1 });
  assert.deepEqual(goals.parseGoalCommand('objectif auto', bot), { type: 'auto' });
  assert.equal(goals.parseGoalCommand('objectif licorne_magique', bot).type, 'error');
  assert.equal(goals.parseGoalCommand('objectif', bot).type, 'error');

  const state = createState();
  const plan = goals.setManualGoal(bot, state, 'diamond', 3);
  assert.equal(state.manualObjective, true);
  assert.equal(state.currentObjective, 'diamond');
  assert.equal(state.manualObjectiveQty, 3);
  assert.equal(plan.satisfied, false);
  assert.ok(plan.chain.indexOf('craft iron_pickaxe') !== -1);
  assert.ok(plan.chain.indexOf('craft iron_pickaxe') < plan.chain.indexOf('mine diamond_ore x3'));

  // The manual objective keeps priority until the requested quantity is really owned
  invUtils.syncObjective(bot, state);
  assert.equal(state.currentObjective, 'diamond');
  bot.give('diamond', 2);
  invUtils.syncObjective(bot, state);
  assert.equal(state.manualObjective, true);
  bot.give('diamond', 1);
  invUtils.syncObjective(bot, state);
  assert.equal(state.manualObjective, false);
  assert.notEqual(state.currentObjective, 'diamond');
});

test('Deterministic planner decides without the model: plan steps, reflexes and stage logistics', () => {
  // Next feasible plan step
  const woodBot = createBot([['oak_log', 3]]);
  const woodState = createState({ currentObjective: 'wooden_pickaxe' });
  const craftStep = planner.getDeterministicDecision(woodBot, woodState);
  assert.equal(craftStep.action, 'craft');
  assert.equal(craftStep.target, 'planks');

  // A resource that is not loaded nearby becomes a targeted exploration, a visible one is mined
  const minerBot = createBot([['iron_pickaxe', 1]]);
  const minerState = createState({ currentObjective: 'diamond', manualObjective: true });
  assert.deepEqual(
    [planner.getDeterministicDecision(minerBot, minerState).action, planner.getDeterministicDecision(minerBot, minerState).target],
    ['explore', 'diamond_ore']
  );
  minerBot.findBlock = ({ matching }) => {
    const candidate = { name: 'deepslate_diamond_ore', position: new Vec3(3, -50, 2) };
    return typeof matching === 'function' && matching(candidate) ? candidate : null;
  };
  assert.equal(planner.getDeterministicDecision(minerBot, minerState).action, 'mine');

  // A step that keeps failing here is not retried on the spot, and not sent to the model either:
  // the bot relocates, and the step becomes available again once it has moved
  recovery.blockAction(minerState, 'mine', 'diamond_ore', 'unreachable', Date.now(), minerBot);
  const remedy = planner.getDeterministicDecision(minerBot, minerState);
  assert.deepEqual([remedy.action, remedy.target, remedy.source], ['explore', 'diamond_ore', 'remedy']);
  assert.match(remedy.note, /mine diamond_ore/);

  minerBot.entity.position = minerBot.entity.position.offset(recovery.RELEASE_DISTANCE + 1, 0, 0);
  assert.equal(planner.getDeterministicDecision(minerBot, minerState).action, 'mine');

  // Only a step that failed in several different places is handed over to the model
  recovery.blockAction(minerState, 'mine', 'diamond_ore', 'unreachable again', Date.now(), minerBot);
  recovery.getFailureEntry(minerState, 'mine', 'diamond_ore').rounds = recovery.MAX_REMEDY_ROUNDS + 1;
  assert.equal(planner.getDeterministicDecision(minerBot, minerState), null);

  // Survival reflex
  const hungryBot = createBot([['bread', 2]]);
  hungryBot.food = 5;
  assert.equal(planner.getDeterministicDecision(hungryBot, createState()).action, 'eat');

  // Nether logistics
  const netherBot = createBot(IRON_GEAR, { dimension: 'the_nether' });
  assert.deepEqual(
    [planner.getStageDecision(netherBot, createState({ currentObjective: 'bow' })).action, planner.getStageDecision(netherBot, createState({ currentObjective: 'bow' })).target],
    ['portal', 'overworld']
  );
  assert.equal(planner.getStageDecision(netherBot, createState({ currentObjective: 'blaze_rod' })).action, 'explore');
  netherBot.entities = { 7: { name: 'blaze', position: new Vec3(5, 64, 5), isValid: true } };
  assert.equal(planner.getStageDecision(netherBot, createState({ currentObjective: 'blaze_rod' })).action, 'fight');

  // Back to the memorized portal after a death, late-game skills, End fight
  const farFromPortal = createState({
    currentObjective: 'nether_portal',
    waypoints: { nether_portal: { x: 300, y: 64, z: 0, dimension: 'overworld' } }
  });
  const returning = planner.getStageDecision(createBot(), farFromPortal);
  assert.deepEqual([returning.action, returning.target], ['goto', 'nether_portal']);
  farFromPortal.waypoints.nether_portal.x = 10;
  assert.equal(planner.getStageDecision(createBot(), farFromPortal), planner.DEFER);

  assert.equal(planner.getStageDecision(createBot(), createState({ currentObjective: 'stronghold' })).action, 'stronghold');
  assert.equal(planner.getStageDecision(createBot(), createState({ currentObjective: 'end_portal' })).action, 'endportal');
  assert.equal(planner.getStageDecision(createBot([], { dimension: 'the_end' }), createState()).action, 'dragon');

  // The bed left by the Nether portal is fetched and reused for the stronghold
  const bedState = createState({
    currentObjective: 'end_bed',
    waypoints: { spawn_bed: { x: 60, y: 64, z: 0, dimension: 'overworld' } }
  });
  const fetchBed = planner.getStageDecision(createBot(), bedState);
  assert.deepEqual([fetchBed.action, fetchBed.target], ['goto', 'spawn_bed']);
  bedState.waypoints.spawn_bed.x = 6;
  const pickup = planner.getStageDecision(createBot(), bedState);
  assert.deepEqual([pickup.action, pickup.target], ['bed', 'pickup']);
});

test('Anti-loop memory blocks repeated failures, detects stagnation and forces a different action', () => {
  const bot = createBot([['oak_log', 2]]);
  const state = createState();
  const decision = { action: 'mine', target: 'oak_log' };
  const now = Date.now();

  recovery.recordOutcome(bot, state, decision, { success: false, message: 'Block unreachable' }, now);
  assert.equal(recovery.isActionBlocked(state, 'mine', 'oak_log', now), false);
  recovery.recordOutcome(bot, state, decision, { success: false, message: 'Block unreachable' }, now);
  assert.equal(recovery.isActionBlocked(state, 'mine', 'oak_log', now), true);
  assert.match(recovery.formatBlockedActions(state), /mine\(oak_log\) x2/);
  assert.ok(recovery.getSuggestedTemperature(state) > 0.1 && recovery.getSuggestedTemperature(state) <= 0.7);

  // The block expires, and a success clears it immediately
  assert.equal(recovery.isActionBlocked(state, 'mine', 'oak_log', now + recovery.FAILURE_TTL_MS + 1), false);
  recovery.recordOutcome(bot, state, decision, { success: false, message: 'again' }, now);
  recovery.recordOutcome(bot, state, decision, { success: false, message: 'again' }, now);
  recovery.recordOutcome(bot, state, decision, { success: true, message: 'ok' }, now);
  assert.equal(recovery.isActionBlocked(state, 'mine', 'oak_log', now), false);

  // "Successful" cycles that change nothing (same place, same inventory) are a loop too
  const idleState = createState();
  const wiki = { action: 'wiki', target: 'stone' };
  for (let i = 0; i <= recovery.STAGNATION_CYCLE_LIMIT; i++) {
    idleState.actionHistory.push({ ...wiki, success: true });
    idleState.lastActionResult = { ...wiki, success: true, message: 'wiki' };
    recovery.recordOutcome(bot, idleState, wiki, { success: true, message: 'wiki' });
  }
  const verdict = recovery.detectStuck(bot, idleState);
  assert.equal(verdict.stuck, true);
  assert.match(verdict.reason, /sans aucun progrès/);

  // Breaking the loop: a different action is queued, the repeated one is refused, stale directives are dropped
  idleState.managerSubGoal = { action: 'wiki', target: 'stone' };
  const { decision: forced, blocked } = recovery.forceRecovery(bot, idleState, verdict.reason);
  assert.notEqual(`${forced.action}:${forced.target}`, 'wiki:stone');
  assert.equal(blocked, 'wiki:stone');
  assert.equal(recovery.isActionBlocked(idleState, 'wiki', 'stone'), true);
  assert.equal(idleState.managerSubGoal, null);
  assert.equal(idleState.metrics.recoveries, 1);
  assert.deepEqual(recovery.takeForcedDecision(idleState), forced);
  assert.equal(recovery.detectStuck(bot, idleState).stuck, false);

  // The manual debug command always refuses the last action, even a "successful" one
  const manualState = createState({ lastActionResult: { action: 'explore', target: 'none', success: true, message: 'moved' } });
  const manual = recovery.forceRecovery(bot, manualState, 'commande debug du joueur', { manual: true });
  assert.equal(manual.blocked, 'explore:none');
  assert.notEqual(`${manual.decision.action}:${manual.decision.target}`, 'explore:none');

  const report = recovery.describeDebugState(bot, manualState);
  assert.equal(report.length, 5);
  assert.ok(report.every(line => line.startsWith('[DEBUG]') && line.length <= 256));

  // Waiting for the dragon must never trigger a relocation next to the void
  const endBot = createBot([], { dimension: 'the_end' });
  const endState = createState();
  for (let i = 0; i < 12; i++) {
    recovery.recordOutcome(endBot, endState, { action: 'dragon', target: 'none' }, { success: true, message: 'waiting' });
  }
  assert.equal(recovery.detectStuck(endBot, endState).stuck, false);
});

test('ReAct loop executes planned steps without calling the model and replaces a refused model decision', async () => {
  const saved = { ...globalState };
  const previousGeneration = process.env.ENABLE_PROCEDURE_GENERATION;
  process.env.ENABLE_PROCEDURE_GENERATION = 'false';

  try {
    Object.assign(globalState, createState(), {
      procedureMemory: new ProcedureMemory(),
      survivalSessionId: 77,
      cyclesSinceLastManager: 0,
      isManagerThinking: false,
      managerSubGoal: { action: 'explore', target: 'none', isReliable: false }
    });

    let modelCalls = 0;
    const dispatched = [];
    const deps = {
      scheduleNext: false,
      runManagerFn: async () => {},
      askOllamaFn: async () => {
        modelCalls += 1;
        return { thought: 'retry', action: 'mine', target: 'oak_log', qty: 1 };
      },
      dispatchSkillFn: async (_bot, _state, action, target) => {
        dispatched.push(`${action}:${target}`);
        return { success: true, message: 'done' };
      }
    };

    // The dependency plan knows the next step: no model call at all
    const plannedBot = createBot([['oak_log', 3]]);
    await handleSurvivalRequest(plannedBot, 77, deps);
    assert.equal(modelCalls, 0);
    assert.deepEqual(dispatched, ['craft:planks']);
    assert.equal(globalState.metrics.deterministicDecisions, 1);
    assert.equal(globalState.lastDecisionSource, 'plan');

    // No deterministic step exists for this objective: the model is asked, but its refused answer is replaced
    globalState.manualObjective = true;
    globalState.currentObjective = 'saddle';
    globalState.managerSubGoal = { action: 'explore', target: 'none', isReliable: false };
    recovery.blockAction(globalState, 'mine', 'oak_log', 'unreachable twice');

    await handleSurvivalRequest(createBot(), 77, deps);
    assert.equal(modelCalls, 1);
    assert.equal(dispatched.length, 2);
    // The refused request becomes a relocation, and the feedback tells the model why
    assert.equal(dispatched[1], 'explore:oak_log');
    assert.equal(globalState.metrics.refusals, 1);
    assert.equal(globalState.metrics.recoveries, 0);
    assert.match(globalState.lastActionResult.message, /'mine oak_log' refusée/);
    assert.equal(globalState.lastDecisionSource, 'remedy');
  } finally {
    Object.assign(globalState, saved);
    if (previousGeneration === undefined) delete process.env.ENABLE_PROCEDURE_GENERATION;
    else process.env.ENABLE_PROCEDURE_GENERATION = previousGeneration;
  }
});

test('Portable crafting table is deployed for a 3x3 craft, then broken and collected when leaving it', async () => {
  const pickaxeId = mcData.itemsByName.wooden_pickaxe.id;
  const setupBot = () => {
    const bot = createBot([['oak_planks', 3], ['stick', 2], ['crafting_table', 1]]);
    const world = attachFlatWorld(bot);
    bot.recipesFor = (id, _meta, _min, table) => (id === pickaxeId && table ? [{ id, delta: [] }] : []);
    bot.craft = async () => { bot.give('wooden_pickaxe', 1); };
    return { bot, world };
  };

  // Default: place, craft, break, collect
  const first = setupBot();
  const state = createState({ currentObjective: 'wooden_pickaxe' });
  const result = await skillCraft(first.bot, state, 'wooden_pickaxe', 1);
  assert.equal(result.success, true);
  assert.match(result.message, /collected back into inventory/);
  assert.deepEqual(first.world.placed, ['crafting_table']);
  assert.equal(invUtils.countItem(first.bot, 'wooden_pickaxe'), 1);
  assert.equal(invUtils.countItem(first.bot, 'crafting_table'), 1);
  assert.equal(state.deployedTable, null);
  assert.equal(first.bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 16 }), null);
  assert.equal(state.base.crafting_table, null);

  // Kept deployed for a follow-up craft, the table is collected as soon as another kind of action starts
  const second = setupBot();
  const keepState = createState({ currentObjective: 'wooden_pickaxe' });
  const kept = await skillCraft(second.bot, keepState, 'wooden_pickaxe', 1, { keepTable: true });
  assert.equal(kept.success, true);
  assert.ok(keepState.deployedTable);
  assert.equal(invUtils.countItem(second.bot, 'crafting_table'), 0);

  await dispatchSkill(second.bot, keepState, 'chest', 'none', 1);
  assert.equal(keepState.deployedTable, null);
  assert.equal(invUtils.countItem(second.bot, 'crafting_table'), 1);

  // Without any table the craft explains what to do instead of walking to an old base
  const noTableBot = createBot([['oak_planks', 3], ['stick', 2]]);
  attachFlatWorld(noTableBot);
  const refused = await skillCraft(noTableBot, createState(), 'wooden_pickaxe', 1);
  assert.equal(refused.success, false);
  assert.match(refused.message, /Craft one first/);
});

test('Spawn bed is placed and used before leaving the Overworld, and its coordinates are memorized', async () => {
  const bot = createBot([['white_bed', 1]]);
  const world = attachFlatWorld(bot);
  const emitter = new EventEmitter();
  bot.on = emitter.on.bind(emitter);
  bot.removeListener = emitter.removeListener.bind(emitter);
  let activated = null;
  bot.activateBlock = async (block) => {
    activated = block.name;
    emitter.emit('messagestr', 'Respawn point set');
  };

  const placement = findBedPlacement(bot);
  assert.ok(placement);
  assert.equal(placement.foot.distanceTo(placement.head), 1);
  assert.ok(placement.foot.distanceTo(bot.entity.position) >= 2);

  const state = createState();
  const result = await ensureSpawnBed(bot, state, 'spawn_bed');
  assert.equal(result.success, true);
  assert.equal(result.placed, true);
  assert.equal(activated, 'white_bed');
  assert.deepEqual(world.placed, ['white_bed']);
  assert.equal(invUtils.countItem(bot, 'bed'), 0);
  assert.equal(state.waypoints.spawn_bed.dimension, 'overworld');
  assert.equal(state.milestones.active_spawn, 'spawn_bed');

  // A nearby spawn bed is reused instead of placing another one
  const again = await ensureSpawnBed(bot, state, 'spawn_bed');
  assert.equal(again.success, true);
  assert.equal(again.placed, false);

  // The stronghold bed is a separate requirement: without a bed it explains how to get one
  const missing = await ensureSpawnBed(bot, state, 'end_spawn_bed');
  assert.equal(missing.success, false);
  assert.match(missing.message, /sheep/);

  // Beds explode outside the Overworld
  const netherBot = createBot([['white_bed', 1]], { dimension: 'the_nether' });
  const netherResult = await ensureSpawnBed(netherBot, createState(), 'spawn_bed');
  assert.equal(netherResult.success, false);
});

test('Nether portal entry requires and sets the spawn bed, memorizes both sides, and the return trip uses them', async () => {
  /**
   * Build a bot standing next to an active Nether portal in the Overworld
   * @param {Array<[string, number]>} items Inventory content
   * @returns {{ bot: object, world: object }} Bot and world handle
   */
  const setupPortalSite = (items) => {
    const bot = createBot(items);
    const world = attachFlatWorld(bot);
    world.set(new Vec3(3, 64, 3), 'nether_portal');
    const emitter = new EventEmitter();
    bot.on = emitter.on.bind(emitter);
    bot.removeListener = emitter.removeListener.bind(emitter);
    bot.activateBlock = async () => { emitter.emit('messagestr', 'Respawn point set'); };
    bot.pathfinder.goto = async () => {
      bot.game.dimension = 'the_nether';
      bot.entity.position = new Vec3(8, 70, 8);
    };
    return { bot, world };
  };

  // Without a bed the bot does not step into the portal
  const noBed = setupPortalSite([['flint_and_steel', 1]]);
  const noBedState = createState({ currentObjective: 'nether_portal' });
  const refused = await dispatchSkill(noBed.bot, noBedState, 'portal', 'none', 1);
  assert.equal(refused.success, false);
  assert.match(refused.message, /spawn bed is required before entering/);
  assert.equal(noBed.bot.game.dimension, 'overworld');
  assert.ok(noBedState.waypoints.nether_portal, 'the portal position is memorized even before entering');

  // With a bed: it is placed and used first, then both portal sides are memorized
  const ready = setupPortalSite([['flint_and_steel', 1], ['white_bed', 1]]);
  const state = createState({ currentObjective: 'nether_portal' });
  const entered = await dispatchSkill(ready.bot, state, 'portal', 'none', 1);
  assert.equal(entered.success, true);
  assert.deepEqual(ready.world.placed, ['white_bed']);
  assert.equal(ready.bot.game.dimension, 'the_nether');
  assert.equal(state.waypoints.spawn_bed.dimension, 'overworld');
  assert.deepEqual([state.waypoints.nether_portal.x, state.waypoints.nether_portal.z], [3, 3]);
  assert.deepEqual(
    [state.waypoints.nether_exit.x, state.waypoints.nether_exit.y, state.waypoints.nether_exit.z, state.waypoints.nether_exit.dimension],
    [8, 70, 8, 'the_nether']
  );

  // Far from the portal in the Nether: the bot first walks back to the memorized exit...
  const netherBot = ready.bot;
  netherBot.entity.position = new Vec3(150, 70, 8);
  netherBot.findBlock = () => null;
  netherBot.pathfinder.goto = async (goal) => {
    netherBot.entity.position = new Vec3(goal.x, netherBot.entity.position.y, goal.z);
  };
  const heading = await dispatchSkill(netherBot, state, 'portal', 'overworld', 1);
  assert.equal(heading.success, true);
  assert.match(heading.message, /Heading back to the Nether portal/);
  assert.equal(netherBot.game.dimension, 'the_nether');

  // ...then steps through it and records where it comes out
  const portalId = mcData.blocksByName.nether_portal.id;
  netherBot.findBlock = ({ matching }) => (matching === portalId ? { name: 'nether_portal', position: new Vec3(8, 70, 8) } : null);
  netherBot.pathfinder.goto = async () => {
    netherBot.game.dimension = 'overworld';
    netherBot.entity.position = new Vec3(-20, 66, 44);
  };
  const back = await dispatchSkill(netherBot, state, 'portal', 'overworld', 1);
  assert.equal(back.success, true);
  assert.equal(netherBot.game.dimension, 'overworld');
  assert.deepEqual([state.waypoints.nether_portal.x, state.waypoints.nether_portal.z], [-20, 44]);
});

test('Milestone waypoints persist to disk, survive a restart and drive the goto skill', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollacraft-progress-'));
  const file = path.join(tempDir, 'progress.json');

  try {
    assert.equal(progress.normalizeDimension('minecraft:the_nether'), 'the_nether');
    assert.equal(progress.normalizeDimension(undefined), 'overworld');

    const state = createState();
    assert.equal(progress.loadProgress(state, file), 0);
    progress.saveWaypoint(state, 'nether_portal', new Vec3(120.6, 64.2, -43.4), 'overworld', 'portal');
    progress.setMilestone(state, 'active_spawn', 'spawn_bed');
    state.stronghold = { throws: [{ x: 0, z: 0, heading: 1 }], estimate: { x: 900, z: -400 }, located: true, reached: false };
    progress.persistProgress(state);

    // A new session reads everything back
    const restarted = createState();
    assert.equal(progress.loadProgress(restarted, file), 1);
    assert.deepEqual(
      [restarted.waypoints.nether_portal.x, restarted.waypoints.nether_portal.y, restarted.waypoints.nether_portal.z],
      [121, 64, -43]
    );
    assert.equal(restarted.milestones.active_spawn, 'spawn_bed');
    assert.equal(restarted.stronghold.located, true);

    // goto walks towards the waypoint leg by leg and refuses other dimensions or unknown names
    const bot = createBot();
    bot.pathfinder.goto = async (goal) => {
      bot.entity.position = new Vec3(goal.x, goal.y ?? bot.entity.position.y, goal.z);
    };
    const firstLeg = await skillGoto(bot, restarted, 'nether_portal');
    assert.equal(firstLeg.success, true);
    assert.match(firstLeg.message, /Moved closer/);

    let arrived = firstLeg;
    for (let i = 0; i < 8 && !/Arrived/.test(arrived.message); i++) {
      arrived = await skillGoto(bot, restarted, 'nether_portal');
    }
    assert.match(arrived.message, /Arrived at waypoint 'nether_portal'/);

    assert.equal((await skillGoto(bot, restarted, 'unknown_place')).success, false);
    const netherBot = createBot([], { dimension: 'the_nether' });
    assert.equal((await skillGoto(netherBot, restarted, 'nether_portal')).success, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Stronghold triangulation intersects two eye bearings and rejects unusable geometry', () => {
  const stronghold = { x: 1480, z: -925 };
  const throwFrom = (x, z) => ({ x, z, heading: Math.atan2(stronghold.z - z, stronghold.x - x) });

  const first = throwFrom(10, 20);
  const baselinePoint = triangulation.computeBaselinePoint(first, 250, 1);
  assert.ok(Math.abs(Math.abs(triangulation.perpendicularOffset(first, baselinePoint)) - 250) < 1.5);

  const exact = triangulation.triangulateStronghold(first, throwFrom(baselinePoint.x, baselinePoint.z));
  assert.equal(exact.valid, true);
  assert.ok(Math.abs(exact.x - stronghold.x) <= 1 && Math.abs(exact.z - stronghold.z) <= 1);
  assert.ok(exact.angleDeg > 5);

  // A small bearing error stays within the announced error radius
  const noisySecond = throwFrom(baselinePoint.x, baselinePoint.z);
  noisySecond.heading += (0.3 * Math.PI) / 180;
  const noisy = triangulation.triangulateStronghold(first, noisySecond);
  assert.equal(noisy.valid, true);
  assert.ok(Math.hypot(noisy.x - stronghold.x, noisy.z - stronghold.z) <= noisy.errorRadius);

  // Same spot, parallel bearings, or bearings that diverge are rejected
  assert.equal(triangulation.triangulateStronghold(first, { ...first }).valid, false);
  assert.equal(triangulation.triangulateStronghold(first, { x: first.x + 2, z: first.z + 1, heading: first.heading + 0.001 }).valid, false);
  const diverging = { x: baselinePoint.x, z: baselinePoint.z, heading: first.heading + (baselinePoint.z > first.z ? 0.5 : -0.5) };
  assert.equal(triangulation.triangulateStronghold(first, diverging).valid, false);

  // Bearing measured from the flying eye: it climbs towards a far stronghold and dives onto a near one
  const far = [];
  for (let i = 0; i <= 12; i++) far.push({ x: i * Math.cos(0.7), y: 65 + i * 0.6, z: i * Math.sin(0.7) });
  const farFlight = triangulation.computeFlightHeading(far);
  assert.ok(Math.abs(farFlight.heading - 0.7) < 1e-6);
  assert.equal(farFlight.overhead, false);

  const near = [];
  for (let i = 0; i <= 6; i++) near.push({ x: i * 0.5, y: 65 - i * 1.5, z: 0 });
  assert.equal(triangulation.computeFlightHeading(near).overhead, true);
  assert.equal(triangulation.computeFlightHeading([{ x: 0, y: 65, z: 0 }]), null);
});

test('Stronghold skill throws exactly two eyes from different places, triangulates, then travels there', async () => {
  const strongholdPos = new Vec3(1480, 30, -925);
  const bot = createBot([['ender_eye', 2]]);
  const emitter = new EventEmitter();
  bot.on = emitter.on.bind(emitter);
  bot.removeListener = emitter.removeListener.bind(emitter);
  bot.pathfinder.goto = async (goal) => {
    bot.entity.position = new Vec3(goal.x, bot.entity.position.y, goal.z);
  };

  // A thrown eye flies 12 blocks towards the stronghold while climbing, then disappears
  const throwOrigins = [];
  bot.activateItem = () => {
    const start = bot.entity.position.offset(0, 1.5, 0);
    throwOrigins.push(start.clone());
    const heading = Math.atan2(strongholdPos.z - start.z, strongholdPos.x - start.x);
    const eye = { name: 'eye_of_ender', position: start.clone() };
    bot.take('ender_eye', 1);
    emitter.emit('entitySpawn', eye);
    for (let i = 1; i <= 12; i++) {
      eye.position = start.offset(Math.cos(heading) * i, i * 0.6, Math.sin(heading) * i);
      emitter.emit('entityMoved', eye);
    }
    emitter.emit('entityGone', eye);
  };

  const state = createState({ currentObjective: 'stronghold' });
  const firstThrow = await skillStronghold(bot, state);
  assert.equal(firstThrow.success, true);
  assert.equal(state.stronghold.throws.length, 1);
  assert.equal(state.stronghold.located, false);

  // The bot walks sideways before the second throw instead of throwing again from the same line
  let step = firstThrow;
  for (let i = 0; i < 12 && !state.stronghold.located; i++) {
    step = await skillStronghold(bot, state);
  }
  assert.equal(state.stronghold.located, true);
  assert.equal(throwOrigins.length, 2);
  assert.equal(invUtils.countItem(bot, 'ender_eye'), 0);
  assert.ok(Math.abs(triangulation.perpendicularOffset(state.stronghold.throws[0], throwOrigins[1])) >= config.EYE_TRIANGULATION_BASELINE * 0.8);
  assert.ok(Math.hypot(state.stronghold.estimate.x - strongholdPos.x, state.stronghold.estimate.z - strongholdPos.z) <= 4);
  assert.equal(state.waypoints.stronghold.x, state.stronghold.estimate.x);
  assert.match(step.message, /triangulated/);

  // Then it travels to the estimate, leg by leg, without spending another eye
  for (let i = 0; i < 60 && !state.stronghold.reached; i++) {
    await skillStronghold(bot, state);
  }
  assert.equal(state.stronghold.reached, true);
  assert.equal(throwOrigins.length, 2);
  assert.ok(Math.hypot(bot.entity.position.x - strongholdPos.x, bot.entity.position.z - strongholdPos.z) <= 30);
});

test('End portal frames are read from block states and bow shots compensate for gravity', () => {
  const bot = createBot();
  const frameDef = mcData.blocksByName.end_portal_frame;
  assert.equal(isFrameFilled(bot, { getProperties: () => ({ eye: true }) }), true);
  assert.equal(isFrameFilled(bot, { getProperties: () => ({ eye: false }) }), false);
  assert.equal(isFrameFilled(bot, { stateId: frameDef.minStateId + 1 }), true);
  assert.equal(isFrameFilled(bot, { stateId: frameDef.defaultState }), false);

  // A 12-frame ring around (100, 30, 200) with 3 eyes already inserted
  const ring = [];
  for (const x of [99, 100, 101]) ring.push(new Vec3(x, 30, 198), new Vec3(x, 30, 202));
  for (const z of [199, 200, 201]) ring.push(new Vec3(98, 30, z), new Vec3(102, 30, z));
  bot.findBlocks = () => ring;
  bot.blockAt = (pos) => {
    const index = ring.findIndex(p => p.equals(pos));
    return { name: 'end_portal_frame', position: pos, stateId: index < 3 ? frameDef.minStateId : frameDef.defaultState };
  };
  const scan = scanPortalFrames(bot);
  assert.equal(scan.frames.length, 12);
  assert.equal(scan.filled, 3);
  assert.deepEqual([scan.center.x, scan.center.y, scan.center.z], [100, 30, 200]);

  // Aiming above a crystal 40 blocks away and 30 blocks up makes the simulated arrow land on it
  const aim = computeBowAim(40, 30);
  assert.equal(aim.reachable, true);
  assert.ok(aim.lift > 0);
  assert.ok(Math.abs(simulateArrowHeight(aim.pitch, 40) - 30) < 0.25);
  assert.equal(computeBowAim(400, 0).reachable, false);
});

test('End portal skill sets the spawn bed, fills the frame with eyes, then enters the End', async () => {
  const frameDef = mcData.blocksByName.end_portal_frame;
  const center = new Vec3(0, 64, 0);
  const ring = [];
  for (const x of [-1, 0, 1]) ring.push(new Vec3(x, 64, -2), new Vec3(x, 64, 2));
  for (const z of [-1, 0, 1]) ring.push(new Vec3(-2, 64, z), new Vec3(2, 64, z));

  /**
   * Build a bot standing in a portal room where three frames already hold an eye
   * @param {number} eyeCount Eyes of Ender carried
   * @returns {{ bot: object, state: object }} Bot and its state
   */
  const setupPortalRoom = (eyeCount) => {
    const bot = createBot([['ender_eye', eyeCount], ['white_bed', 1]], { position: new Vec3(4, 64, 0) });
    const world = attachFlatWorld(bot);
    const emitter = new EventEmitter();
    bot.on = emitter.on.bind(emitter);
    bot.removeListener = emitter.removeListener.bind(emitter);

    const filled = new Set(ring.slice(0, 3).map(String));
    const baseBlockAt = bot.blockAt;
    bot.blockAt = (pos) => {
      const framePos = ring.find(p => p.equals(pos));
      if (!framePos) return baseBlockAt(pos);
      return {
        name: 'end_portal_frame',
        type: frameDef.id,
        position: framePos,
        stateId: filled.has(String(framePos)) ? frameDef.minStateId : frameDef.defaultState
      };
    };
    bot.findBlocks = () => ring;
    bot.activateBlock = async (block) => {
      if (block.name.endsWith('_bed')) {
        emitter.emit('messagestr', 'Respawn point set');
        return;
      }
      if (block.name === 'end_portal_frame' && bot.heldItem?.name === 'ender_eye') {
        filled.add(String(block.position));
        bot.take('ender_eye', 1);
        if (filled.size === ring.length) world.set(center, 'end_portal');
      }
    };
    bot.pathfinder.goto = async () => {
      if (filled.size === ring.length) bot.game.dimension = 'the_end';
    };

    const state = createState({
      currentObjective: 'end_portal',
      stronghold: { throws: [{}, {}], estimate: { x: 0, z: 0 }, located: true, reached: true }
    });
    return { bot, state };
  };

  // Not enough eyes: every available eye is inserted and the remaining need is reported and tracked
  const short = setupPortalRoom(4);
  const partial = await dispatchSkill(short.bot, short.state, 'endportal', 'none', 1);
  assert.equal(partial.success, true);
  assert.match(partial.message, /7\/12 filled: 5 more 'ender_eye' needed/);
  assert.equal(short.state.endPortal.filledCount, 7);
  assert.equal(invUtils.getEyeRequirement(short.state), 5);
  assert.ok(short.state.waypoints.end_spawn_bed, 'the spawn bed is set before touching the frame');
  assert.equal(short.bot.game.dimension, 'overworld');

  // Enough eyes: bed, frame, then the dimension change
  const full = setupPortalRoom(9);
  const entered = await dispatchSkill(full.bot, full.state, 'endportal', 'none', 1);
  assert.equal(entered.success, true);
  assert.match(entered.message, /Entered the End/);
  assert.equal(full.state.endPortal.filledCount, 12);
  assert.equal(invUtils.countItem(full.bot, 'ender_eye'), 0);
  assert.equal(invUtils.countItem(full.bot, 'bed'), 0);
  assert.deepEqual(
    [full.state.waypoints.end_portal.x, full.state.waypoints.end_portal.y, full.state.waypoints.end_portal.z],
    [0, 64, 0]
  );
  assert.equal(full.state.waypoints.end_spawn_bed.dimension, 'overworld');
  assert.equal(full.state.milestones.active_spawn, 'end_spawn_bed');
  assert.equal(full.state.milestones.entered_end, true);
});

test('Dragon skill crosses to the island, shoots crystals with the bow and detects victory from the exit portal', async () => {
  const bot = createBot([['bow', 1], ['arrow', 6], ['iron_sword', 1]], { dimension: 'the_end', position: new Vec3(100, 49, 0) });
  bot.pathfinder.goto = async (goal) => {
    bot.entity.position = new Vec3(goal.x, bot.entity.position.y, goal.z);
  };
  let released = 0;
  bot.activateItem = () => {};
  bot.deactivateItem = () => {
    released += 1;
    bot.take('arrow', 1);
  };
  bot.attack = () => {};
  const state = createState({ currentObjective: 'ender_dragon' });

  // The arrival platform is away from the main island
  const crossing = await dispatchSkill(bot, state, 'dragon', 'none', 1);
  assert.equal(crossing.success, true);
  assert.match(crossing.message, /main End island/);

  bot.entity.position = new Vec3(6, 64, 0);
  bot.entities = {
    1: { name: 'end_crystal', position: new Vec3(30, 90, 10), isValid: true },
    2: { name: 'ender_dragon', id: 2, position: new Vec3(-40, 100, 0), isValid: true }
  };
  const volley = await dispatchSkill(bot, state, 'dragon', 'none', 1);
  assert.equal(volley.success, true);
  assert.equal(released, 4);
  assert.match(volley.message, /Fired 4 arrow\(s\) at End crystals/);
  assert.equal(state.milestones.dragon_defeated, undefined);

  // Portal blocks only exist in the fountain once the dragon is dead
  const exitPortalId = mcData.blocksByName.end_portal.id;
  bot.findBlock = ({ matching }) => (matching === exitPortalId ? { name: 'end_portal', position: new Vec3(0, 62, 0) } : null);
  const victory = await dispatchSkill(bot, state, 'dragon', 'none', 1);
  assert.equal(victory.success, true);
  assert.equal(state.milestones.dragon_defeated, true);

  // Outside the End the skill points to the portal instead
  const overworldBot = createBot();
  assert.equal((await dispatchSkill(overworldBot, createState(), 'dragon', 'none', 1)).success, false);
});

test('Player prompt starts with an invariant prefix and exposes refused actions and waypoints', () => {
  const bot = createBot([['oak_log', 2]]);
  const stateA = createState({ currentObjective: 'wooden_pickaxe' });
  const stateB = createState({
    currentObjective: 'iron_ingot',
    waypoints: { nether_portal: { x: 50, y: 64, z: 0, dimension: 'overworld' } }
  });
  recovery.blockAction(stateB, 'mine', 'iron_ore', 'Block unreachable');

  const prefix = buildStaticRules(bot.username);
  const promptA = buildReactPrompt(bot, stateA, { stone: 4 }, null);
  const promptB = buildReactPrompt(bot, stateB, { stone: 9, iron_ore: 2 }, null);

  // The shared prefix lets Ollama reuse its cached evaluation between cycles
  assert.ok(promptA.startsWith(prefix) && promptB.startsWith(prefix));
  assert.ok(prefix.length > 2000);
  assert.ok(promptB.includes('mine(iron_ore) x2'));
  assert.ok(promptB.includes('nether_portal (50, 64, 0'));
  assert.ok(promptA.includes('ACTIONS REFUSÉES ICI (échecs répétés à cet endroit, déplace-toi avant de les retenter) : aucune'));
  assert.ok(prefix.includes('ÉTABLI PORTABLE'));
});

// ---------------------------------------------------------------------------------------------------------
// Regressions from the first overnight run: hundreds of [ANTI-LOOP] interceptions on plain crafts, 5 deaths
// (3 drownings), truncated JSON answers and a dripleaf stem mistaken for a log.
// ---------------------------------------------------------------------------------------------------------

test('Placement never picks a cell the bot overlaps, places through grass and retries after a server refusal', async () => {
  // Standing near a block edge, the bot's body spills over the neighbouring column: the server refuses a block there
  const bot = createBot([['crafting_table', 1]], { position: new Vec3(0.9, 64, 0.5) });
  const world = attachFlatWorld(bot);

  const spots = findPlacementSpots(bot);
  assert.ok(spots.length > 0);
  assert.ok(spots.every(spot => !isCellObstructed(bot, spot.position)));
  assert.equal(spots.some(spot => spot.position.x === 1 && spot.position.z === 0 && spot.position.y === 64), false);
  assert.equal(spots[0].position.y, 64, 'the preferred spot is on the floor at the bot level');

  // A creature standing on a cell makes it unusable too
  const occupied = spots[0].position;
  bot.entities = { 9: { type: 'animal', name: 'sheep', height: 1.3, position: new Vec3(occupied.x + 0.5, occupied.y, occupied.z + 0.5) } };
  assert.equal(findPlacementSpots(bot).some(spot => spot.position.equals(occupied)), false);
  bot.entities = {};

  // Ground covered with grass is still valid: the placed block replaces the plant
  for (let x = -6; x <= 6; x++) {
    for (let z = -6; z <= 6; z++) world.set(new Vec3(x, 64, z), 'short_grass');
  }
  assert.ok(findPlacementSpots(bot).length > 0);

  // One refusal is not a failure: the next best spot is tried
  let attempts = 0;
  const realPlace = bot.placeBlock;
  bot.placeBlock = async (reference, face) => {
    attempts += 1;
    if (attempts === 1) throw new Error('Server refused to place crafting_table at (2, 64, 0): the block is still air');
    return realPlace(reference, face);
  };
  const placed = await placeItemNearby(bot, bot.inventory.items()[0], { maxAttempts: 3 });
  assert.equal(placed.success, true);
  assert.equal(attempts, 2);

  // When every spot is refused, the outcome says so instead of looking like "no room"
  const blockedBot = createBot([['crafting_table', 1]]);
  attachFlatWorld(blockedBot);
  blockedBot.placeBlock = async () => {
    throw new Error('Server refused to place crafting_table at (2, 64, 0): the block is still air');
  };
  const refused = await placeItemNearby(blockedBot, blockedBot.inventory.items()[0], { maxAttempts: 3 });
  assert.equal(refused.success, false);
  assert.equal(refused.refused, true);
});

test('A table refused next to the world spawn reveals spawn protection and the bot walks out before building', async () => {
  const bot = createBot([['oak_planks', 3], ['stick', 2], ['crafting_table', 1]]);
  attachFlatWorld(bot);
  bot.spawnPoint = new Vec3(2, 64, 1);
  bot.placeBlock = async () => {
    throw new Error('Server refused to place crafting_table at (2, 64, 0): the block is still air');
  };
  const state = createState({ currentObjective: 'wooden_pickaxe' });

  const deployment = await deployCraftingTable(bot, state);
  assert.equal(deployment.success, false);
  assert.equal(deployment.refused, true);
  assert.equal(state.milestones.spawn_protection, true);

  // The craft explains that the table is still carried, so the model does not craft or "place" another one
  const craft = await skillCraft(bot, state, 'wooden_pickaxe', 1);
  assert.equal(craft.success, false);
  assert.match(craft.message, /You still carry it/);
  assert.equal(invUtils.countItem(bot, 'crafting_table'), 1);

  // Inside the protected radius the planner leaves first, straight away from the spawn
  const leaving = planner.getDeterministicDecision(bot, state);
  assert.deepEqual([leaving.action, leaving.target], ['explore', 'leave_spawn']);
  bot.entity.position = new Vec3(12, 64, 1);
  assert.ok(Math.abs(getHeadingAwayFromSpawn(bot, 64)) < 1e-9);

  // Outside it, the normal plan resumes
  bot.entity.position = new Vec3(60, 64, 1);
  assert.equal(getHeadingAwayFromSpawn(bot, 24), null);
  assert.equal(planner.getDeterministicDecision(bot, state).action, 'craft');

  // A refusal far from the spawn (a mob in the way) does not flag the area
  const farState = createState();
  await deployCraftingTable(bot, farState);
  assert.equal(farState.milestones.spawn_protection, undefined);
});

test('A refusal is tied to where and with what the action failed: moving or a new inventory lifts it', () => {
  const bot = createBot([['oak_planks', 3], ['stick', 2], ['crafting_table', 1]]);
  const state = createState();
  const craft = { action: 'craft', target: 'wooden_pickaxe' };
  const failure = { success: false, message: 'crafting table could not be set down here' };
  const now = Date.now();

  recovery.recordOutcome(bot, state, craft, failure, now);
  recovery.recordOutcome(bot, state, craft, failure, now);
  assert.equal(recovery.isActionBlocked(state, 'craft', 'wooden_pickaxe', now, bot), true);
  assert.equal(recovery.getFailureEntry(state, 'craft', 'wooden_pickaxe').rounds, 1);

  // A few blocks further the same craft is allowed again, without waiting for a timer
  bot.entity.position = bot.entity.position.offset(recovery.RELEASE_DISTANCE, 0, 0);
  assert.equal(recovery.isActionBlocked(state, 'craft', 'wooden_pickaxe', now, bot), false);

  // Failing again at the new place refuses it again and counts one more round
  recovery.recordOutcome(bot, state, craft, failure, now);
  recovery.recordOutcome(bot, state, craft, failure, now);
  assert.equal(recovery.isActionBlocked(state, 'craft', 'wooden_pickaxe', now, bot), true);
  assert.equal(recovery.getFailureEntry(state, 'craft', 'wooden_pickaxe').rounds, 2);

  // Getting the missing ingredient changes the inventory, which also lifts the refusal
  bot.give('oak_planks', 1);
  assert.equal(recovery.isActionBlocked(state, 'craft', 'wooden_pickaxe', now, bot), false);

  // The remedy is a relocation carrying the reason; none is offered inside the End
  recovery.blockAction(state, 'craft', 'wooden_pickaxe', 'no room', now, bot);
  const remedy = recovery.buildRemedyDecision(bot, state, craft);
  assert.deepEqual([remedy.action, remedy.target], ['explore', 'relocate']);
  assert.match(remedy.note, /craft wooden_pickaxe' refusée/);
  assert.equal(recovery.buildRemedyDecision(createBot([], { dimension: 'the_end' }), state, craft), null);
});

test('Planner and skills agree: mixed plank types, an out-of-reach furnace and fake logs', async () => {
  // 2 oak + 2 birch planks cannot make a table: the plan first crafts planks of a single type
  const mixedBot = createBot([['oak_planks', 2], ['birch_planks', 2], ['spruce_log', 1]]);
  assert.equal(invUtils.countItem(mixedBot, 'planks'), 4);
  assert.equal(invUtils.countBestPlankStack(mixedBot), 2);
  assert.deepEqual(
    resolveGoalPlan(mixedBot, 'crafting_table', 1, createState()).steps.map(step => `${step.action}:${step.target}`),
    ['craft:planks', 'craft:crafting_table']
  );
  assert.deepEqual(
    resolveGoalPlan(createBot([['oak_planks', 4]]), 'crafting_table', 1, createState()).steps.map(step => `${step.action}:${step.target}`),
    ['craft:crafting_table']
  );

  const tableRefusal = await skillCraft(mixedBot, createState(), 'crafting_table', 1);
  assert.equal(tableRefusal.success, false);
  assert.match(tableRefusal.message, /same wood type/);

  // The craft skill names the real cause instead of a bare "missing components"
  const pickaxeBot = createBot([['oak_planks', 2], ['birch_planks', 1], ['stick', 2], ['crafting_table', 1]]);
  attachFlatWorld(pickaxeBot);
  const mixedCraft = await skillCraft(pickaxeBot, createState({ currentObjective: 'wooden_pickaxe' }), 'wooden_pickaxe', 1);
  assert.equal(mixedCraft.success, false);
  assert.match(mixedCraft.message, /mixed wood types/);
  assert.equal(invUtils.countItem(pickaxeBot, 'crafting_table'), 1, 'the table is collected even when the craft fails');

  // A remembered furnace 400 blocks away is unusable for the smelt skill, so the plan builds a new one
  const smelterItems = [['stone_pickaxe', 1], ['raw_iron', 3], ['oak_planks', 4], ['cobblestone', 8], ['crafting_table', 1]];
  const smelterBot = createBot(smelterItems);
  const farFurnace = new Vec3(400, 64, 0);
  smelterBot.blockAt = (pos) => (pos.x === 400 ? { name: 'furnace', position: farFurnace } : { name: 'air', boundingBox: 'empty', position: pos });
  const farState = createState({ base: { crafting_table: null, furnace: farFurnace, chest: null } });
  const farSteps = resolveGoalPlan(smelterBot, 'iron_ingot', 3, farState).steps.map(step => `${step.action}:${step.target}`);
  assert.deepEqual(farSteps, ['craft:furnace', 'place:furnace', 'smelt:raw_iron']);

  // With a furnace in range the plan smelts directly
  const furnaceId = mcData.blocksByName.furnace.id;
  smelterBot.findBlock = ({ matching }) => {
    const candidate = { name: 'furnace', type: furnaceId, position: new Vec3(3, 64, 0) };
    const matches = typeof matching === 'function' ? matching(candidate) : matching === furnaceId;
    return matches ? candidate : null;
  };
  assert.deepEqual(
    resolveGoalPlan(smelterBot, 'iron_ingot', 3, createState()).steps.map(step => `${step.action}:${step.target}`),
    ['smelt:raw_iron']
  );

  // Only the Nether fungi have wooden stems
  assert.equal(invUtils.isWoodLog('big_dripleaf_stem'), false);
  assert.equal(invUtils.isWoodLog('mushroom_stem'), false);
  assert.equal(invUtils.isWoodLog('pumpkin_stem'), false);
  assert.equal(invUtils.isWoodLog('crimson_stem'), true);
  assert.equal(invUtils.isWoodLog('stripped_warped_stem'), true);
  assert.equal(invUtils.isWoodLog('oak_log'), true);
  const logBlocks = getBlockNamesForTarget(createBot(), 'log');
  assert.equal(logBlocks.includes('big_dripleaf_stem'), false);
  assert.ok(logBlocks.includes('oak_log') && logBlocks.includes('crimson_stem'));
});

test('Model answers are length-bounded by the schema and a truncated JSON is salvaged when it holds an action', () => {
  assert.ok(PLAYER_JSON_SCHEMA.properties.thought.maxLength <= 400);
  assert.ok(MANAGER_JSON_SCHEMA.properties.thought.maxLength <= 400);
  assert.ok(MANAGER_JSON_SCHEMA.properties.directive.maxLength <= 400);
  assert.ok(config.OLLAMA_NUM_PREDICT >= 512);

  assert.deepEqual(
    parseModelJson('{"thought": "ok", "action": "mine", "target": "oak_log", "qty": 2}'),
    { thought: 'ok', action: 'mine', target: 'oak_log', qty: 2 }
  );

  // Cut after the decision fields: still usable
  const cutAfterAction = parseModelJson('{"thought": "Je dois couper du bois", "action": "mine", "target": "oak_log", "qt');
  assert.deepEqual(cutAfterAction, { thought: 'Je dois couper du bois', action: 'mine', target: 'oak_log' });
  const cutManager = parseModelJson('{"thought": "x", "directive": "Mine du fer", "suggestedAction": "mine", "suggestedTarget": "iron_or');
  assert.equal(cutManager.suggestedAction, 'mine');
  assert.equal(cutManager.suggestedTarget, 'none');

  // Cut inside the reasoning, before any action: nothing can be recovered
  assert.equal(parseModelJson('{"thought": "Je réfléchis longuement à la meilleure façon de'), null);
  assert.equal(parseModelJson(''), null);
});

test('Survival watchdog aborts the running action when air runs low, and bursts stop at cliffs', () => {
  const bot = createBot();
  let goalCleared = false;
  let jumping = false;
  bot.pathfinder.setGoal = () => { goalCleared = true; };
  bot.setControlState = (control, value) => { if (control === 'jump') jumping = value; };
  const state = createState({ activeActionId: 4 });

  bot.oxygenLevel = 18;
  assert.equal(handleBreath(bot, state), false);

  // Low air: the action is invalidated, the controls are taken back and a surfacing step is queued first
  bot.oxygenLevel = LOW_OXYGEN_LEVEL;
  assert.equal(handleBreath(bot, state), true);
  assert.equal(state.activeActionId, 5);
  assert.equal(goalCleared, true);
  assert.equal(jumping, true);
  assert.deepEqual(recovery.takeForcedDecision(state).action, 'unstuck');

  // It does not fire again until the bot has breathed
  bot.oxygenLevel = 4;
  assert.equal(handleBreath(bot, state), false);
  bot.oxygenLevel = 20;
  handleBreath(bot, state);
  bot.oxygenLevel = 6;
  assert.equal(handleBreath(bot, state), true);

  // The planner reflex covers the case where the alert is seen between two actions
  const divingBot = createBot();
  divingBot.oxygenLevel = 9;
  divingBot.entity.isInWater = true;
  assert.equal(planner.getDeterministicDecision(divingBot, createState()).action, 'unstuck');

  // A plateau ending at x=0: walking east runs off the edge, walking west stays on solid ground
  const cliffBot = createBot([], { position: new Vec3(0.5, 64, 0.5) });
  cliffBot.blockAt = (pos) => (pos.y === 63 && pos.x <= 0
    ? { name: 'stone', boundingBox: 'block', position: pos }
    : { name: 'air', boundingBox: 'empty', position: pos });
  assert.equal(hasDropAhead(cliffBot, 0), true);
  assert.equal(hasDropAhead(cliffBot, Math.PI), false);
});

// ---------------------------------------------------------------------------------------------------------
// Getting stuck in water: the regular pathfinder always holds jump in water, so in a flooded gallery it pins
// the bot against the ceiling. The escape must find a real route to air, dive or dig, and leave the area.
// ---------------------------------------------------------------------------------------------------------

test('Water escape dives through a flooded gallery when floating up leads nowhere, then avoids the area', async () => {
  environment.clearFloodedZones();
  const bot = createBot([['iron_pickaxe', 1]], { position: new Vec3(0.5, 11, 0.5) });
  const world = attachSwimWorld(bot, floodedMineLayout);
  const origin = bot.entity.position.clone();

  // Under water with a ceiling right above: swimming up, the old behavior, cannot reach air
  assert.equal(water.isHeadSubmerged(bot), true);
  assert.equal(water.scanWaterColumn(bot).opensToAir, false);

  // The route goes down through the lower tunnel, back up the shaft, and ends on the dry floor of the cave
  const route = water.findEscapeRoute(bot);
  assert.ok(route);
  assert.equal(route.digs, 0);
  assert.equal(route.dry, true);
  assert.ok(route.path.some(step => step.cell.y === 8), 'the route dives below the chamber');
  const end = route.path.at(-1).cell;
  assert.deepEqual([end.x, end.y, end.z], [7, 14, 0]);

  const result = await skillUnstuck(bot);
  assert.equal(result.success, true);
  assert.match(result.message, /flooded area/);
  assert.equal(bot.entity.isInWater, false);
  assert.equal(water.isHeadSubmerged(bot), false);
  assert.ok(bot.entity.position.x >= 7 && bot.entity.position.y >= 14);
  assert.deepEqual(world.dug, []);
  assert.equal(bot.autoFloatSuspended, false, 'the automatic floating is handed back after the dive');

  // The flooded gallery is remembered, and the next decision is to go and work somewhere else
  assert.equal(environment.isInFloodedZone(origin), true);
  const next = planner.getDeterministicDecision(bot, createState({ currentObjective: 'raw_iron', manualObjective: true }));
  assert.deepEqual([next.action, next.target], ['explore', 'relocate']);
  assert.match(next.thought, /inondée/);

  environment.clearFloodedZones();
  assert.equal(environment.isInFloodedZone(origin), false);
});

test('Water escape breaks a thin ceiling, swims to the shore of open water, and reports failure when sealed in', async () => {
  environment.clearFloodedZones();

  // A flooded pocket closed by a single block, with a dry gallery above: digging up is the quickest way out
  const digger = createBot([['iron_pickaxe', 1]], { position: new Vec3(0.5, 10, 0.5) });
  const pocket = attachSwimWorld(digger, (x, y, z) => {
    if (z !== 0) return 'stone';
    if (x >= 0 && x <= 1 && y >= 10 && y <= 11) return 'water';
    if (x >= 0 && x <= 3 && y >= 13 && y <= 14) return 'air';
    return 'stone';
  });
  const dugOut = await water.escapeWater(digger);
  assert.equal(dugOut.success, true);
  assert.equal(dugOut.enclosed, true);
  assert.deepEqual(pocket.dug, ['stone@0,12,0']);
  assert.match(dugOut.message, /broke 1 block/);
  assert.equal(digger.entity.isInWater, false);
  assert.ok(digger.entity.position.y >= 13);

  // Open water: straight up to the surface, then onto the shore, and nothing is recorded as flooded
  const swimmer = createBot([], { position: new Vec3(0.5, 61, 0.5) });
  attachSwimWorld(swimmer, (x, y, z) => {
    if (y >= 64) return 'air';
    if (y >= 60 && Math.abs(x) <= 6 && Math.abs(z) <= 6) return 'water';
    return 'stone';
  });
  const lakeStart = swimmer.entity.position.clone();
  assert.equal(water.scanWaterColumn(swimmer).opensToAir, true);
  const ashore = await water.escapeWater(swimmer);
  assert.equal(ashore.success, true);
  assert.equal(ashore.enclosed, false);
  assert.equal(swimmer.entity.isInWater, false);
  assert.ok(Math.abs(swimmer.entity.position.x) >= 7 || Math.abs(swimmer.entity.position.z) >= 7);
  assert.equal(environment.isInFloodedZone(lakeStart), false);

  // Sealed in unbreakable rock: no pretend success, so the decision loop knows the bot is still in danger
  const trapped = createBot([], { position: new Vec3(0.5, 10, 0.5) });
  attachSwimWorld(trapped, (x, y, z) => (z === 0 && x >= 0 && x <= 1 && y >= 10 && y <= 11 ? 'water' : 'bedrock'));
  assert.equal(water.findEscapeRoute(trapped), null);
  const failed = await skillUnstuck(trapped);
  assert.equal(failed.success, false);
  assert.match(failed.message, /Still under water/);

  environment.clearFloodedZones();
});

test('Submerged blocks are not mining targets, and standing in water is a reason to get out before acting', () => {
  const bot = createBot([['stone_pickaxe', 1]]);
  const ore = { name: 'iron_ore', position: new Vec3(5, 60, 5) };
  const airAt = (pos) => ({ name: 'air', boundingBox: 'empty', position: pos });
  bot.findBlock = ({ matching }) => (typeof matching === 'function' && matching(ore) ? ore : null);
  const state = createState({ currentObjective: 'raw_iron', manualObjective: true });

  // Water right above the ore: the bot looks for another one instead of diving for it
  bot.blockAt = (pos) => (pos.x === 5 && pos.y === 61 && pos.z === 5 ? { name: 'water', position: pos } : airAt(pos));
  assert.equal(environment.isBlockSubmerged(bot, ore), true);
  const search = planner.getDeterministicDecision(bot, state);
  assert.deepEqual([search.action, search.target], ['explore', 'iron_ore']);

  // The same ore in a dry wall is mined
  bot.blockAt = airAt;
  assert.equal(environment.isBlockSubmerged(bot, ore), false);
  assert.equal(planner.getDeterministicDecision(bot, state).action, 'mine');

  // An ore inside a recorded flooded area is skipped too
  environment.markFloodedZone(new Vec3(4, 60, 4));
  assert.equal(planner.getDeterministicDecision(bot, state).action, 'explore');
  environment.clearFloodedZones();

  // Wading or floating (head out of the water) is reported and handled before any other step
  const wader = createBot([['oak_log', 3]]);
  wader.entity.isInWater = true;
  assert.match(environment.checkTerrainSituation(wader), /Dans l'eau/);
  const reflex = planner.getDeterministicDecision(wader, createState());
  assert.equal(reflex.action, 'unstuck');

  // On dry land, unstuck digs through any rock the carried tool breaks quickly, not only soft blocks
  const miner = createBot();
  miner.digTime = (block) => (block.name === 'deepslate' ? 2500 : 30000);
  assert.equal(isDiggableObstacle({ name: 'deepslate', boundingBox: 'block' }, miner), true);
  assert.equal(isDiggableObstacle({ name: 'obsidian', boundingBox: 'block' }, miner), false);
  assert.equal(isDiggableObstacle({ name: 'deepslate', boundingBox: 'block' }), false);
  assert.equal(isDiggableObstacle({ name: 'dirt', boundingBox: 'block' }), true);
});
