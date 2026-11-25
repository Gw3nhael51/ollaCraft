const config = require('../infrastructure/config');
const invUtils = require('../perception/inventory');
const { resolveGoalPlan } = require('../minecraft/knowledge');
const { getMcData } = require('../minecraft/wikiData');

// Common French (and shorthand) names accepted by the goal command, mapped to Minecraft identifiers
const GOAL_ALIASES = new Map([
  ['diamant', 'diamond'], ['diamants', 'diamond'],
  ['fer', 'iron_ingot'], ['lingot_de_fer', 'iron_ingot'], ['or', 'gold_ingot'],
  ['charbon', 'coal'], ['bois', 'log'], ['buches', 'log'], ['planches', 'planks'], ['pierre', 'cobblestone'],
  ['obsidienne', 'obsidian'], ['silex', 'flint'], ['briquet', 'flint_and_steel'],
  ['pioche_en_bois', 'wooden_pickaxe'], ['pioche_en_pierre', 'stone_pickaxe'],
  ['pioche_en_fer', 'iron_pickaxe'], ['pioche_en_diamant', 'diamond_pickaxe'],
  ['epee_en_fer', 'iron_sword'], ['épée_en_fer', 'iron_sword'],
  ['epee_en_diamant', 'diamond_sword'], ['épée_en_diamant', 'diamond_sword'],
  ['seau', 'bucket'], ['seau_d_eau', 'water_bucket'], ['four', 'furnace'], ['coffre', 'chest'],
  ['etabli', 'crafting_table'], ['établi', 'crafting_table'], ['bouclier', 'shield'],
  ['lit', 'bed'], ['laine', 'wool'], ['arc', 'bow'], ['fleche', 'arrow'], ['fleches', 'arrow'], ['flèche', 'arrow'], ['flèches', 'arrow'],
  ['perle', 'ender_pearl'], ['perle_de_l_ender', 'ender_pearl'],
  ['oeil', 'ender_eye'], ['œil', 'ender_eye'], ['oeil_de_l_ender', 'ender_eye'],
  ['baton_de_blaze', 'blaze_rod'], ['poudre_de_blaze', 'blaze_powder'],
  ['nether', 'nether_portal'], ['portail', 'nether_portal'], ['portail_du_nether', 'nether_portal'],
  ['end', 'end_portal'], ['portail_de_l_end', 'end_portal'],
  ['dragon', 'ender_dragon']
]);

// Objectives that are stages of the run or generic families rather than registry items
const SPECIAL_OBJECTIVES = new Set([
  ...config.QUEST_CHAIN, 'log', 'planks', 'wool', 'bed'
]);

// Steps too basic to be worth announcing when summarizing a plan in chat
const TRIVIAL_PLAN_TARGETS = new Set(['log', 'planks', 'stick', 'crafting_table']);
const AUTO_KEYWORDS = new Set(['auto', 'automatique', 'reset']);

/**
 * Check whether a name designates something the bot can pursue
 * @param {string} name Candidate objective identifier
 * @param {object|null} [bot=null] Mineflayer bot instance
 * @returns {boolean} True for a known item, block or stage objective
 */
function isKnownObjective(name, bot = null) {
  if (SPECIAL_OBJECTIVES.has(name)) return true;
  const mcData = getMcData(bot);
  return Boolean(mcData.itemsByName?.[name] || mcData.blocksByName?.[name]);
}

/**
 * Parse a goal chat command such as "objectif diamond 3", "goal pioche en fer" or "objectif auto"
 * @param {string} message Raw chat message
 * @param {object|null} [bot=null] Mineflayer bot instance used for registry validation
 * @returns {{ type: 'auto' }|{ type: 'goal', objective: string, qty: number }|{ type: 'error', message: string }} Parsed command
 */
function parseGoalCommand(message, bot = null) {
  const words = String(message || '').trim().toLowerCase().split(/\s+/).slice(1);
  if (words.length === 0) {
    return { type: 'error', message: "Usage : objectif <item> [quantité] | objectif auto" };
  }
  if (words.length === 1 && AUTO_KEYWORDS.has(words[0])) {
    return { type: 'auto' };
  }

  let qty = 1;
  const lastWord = words.at(-1);
  if (words.length > 1 && /^\d+$/.test(lastWord)) {
    qty = Math.max(1, Math.min(64, Number.parseInt(lastWord, 10)));
    words.pop();
  }

  const raw = words.join('_').replace(/['’]/g, '_').replace(/^minecraft:/, '');
  const objective = GOAL_ALIASES.get(raw) || raw;
  if (!isKnownObjective(objective, bot)) {
    return { type: 'error', message: `Objectif inconnu : '${raw}'. Utilise un identifiant Minecraft (ex: diamond, iron_pickaxe, ender_dragon).` };
  }
  return { type: 'goal', objective, qty };
}

/**
 * Summarize the prerequisite chain the bot will follow to reach an objective from its current inventory
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} objective Objective identifier
 * @param {number} [qty=1] Wanted quantity
 * @returns {{ satisfied: boolean, chain: string, stepCount: number }} Human-readable chain for chat
 */
function describeGoalPlan(bot, state, objective, qty = 1) {
  const plan = resolveGoalPlan(bot, objective, qty, state);
  if (plan.satisfied) {
    return { satisfied: true, chain: `'${objective}' est déjà obtenu.`, stepCount: 0 };
  }

  const milestones = plan.steps
    .filter(step => !TRIVIAL_PLAN_TARGETS.has(step.target) || step === plan.steps.at(-1))
    .map(step => `${step.action} ${step.target}${step.qty > 1 ? ` x${step.qty}` : ''}`);
  const chain = milestones.length > 0 ? milestones.join(' -> ') : `${plan.nextAction?.action || 'explore'} ${plan.nextAction?.target || objective}`;
  return { satisfied: false, chain, stepCount: plan.steps.length };
}

/**
 * Make an objective requested by the user the bot's current goal, ahead of the automatic chain
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} objective Objective identifier
 * @param {number} [qty=1] Wanted quantity
 * @returns {{ satisfied: boolean, chain: string, stepCount: number }} Plan summary for the new goal
 */
function setManualGoal(bot, state, objective, qty = 1) {
  state.manualObjective = true;
  state.currentObjective = objective;
  state.manualObjectiveQty = Math.max(1, qty);
  state.managerSubGoal = null;
  state.managerDirective = `Objectif demandé par le joueur : obtenir ${qty}x '${objective}'. Suis le plan de dépendances.`;
  if (state.recovery) {
    state.recovery.forcedQueue = [];
    state.recovery.cyclesOnObjective = 0;
    state.recovery.stagnantCycles = 0;
  }
  return describeGoalPlan(bot, state, objective, qty);
}

/**
 * Give control back to the automatic progression chain
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 */
function clearManualGoal(bot, state) {
  state.manualObjective = false;
  state.manualObjectiveQty = 1;
  state.managerSubGoal = null;
  invUtils.syncObjective(bot, state);
}

module.exports = {
  parseGoalCommand,
  describeGoalPlan,
  setManualGoal,
  clearManualGoal,
  isKnownObjective,
  GOAL_ALIASES
};
