const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const config = require('./infrastructure/config');
const state = require('./core/state');
const { syncObjective, getBestToolForBlock, getQuestRequirement } = require('./perception/inventory');
const { autoEquipArmorAndShield } = require('./actions/behaviors/items/equip');
const { handleSurvivalRequest } = require('./agent/loop');
const { startManagerLoop } = require('./agent/manager');
const { checkAdvancementMessage } = require('./perception/advancements');
const { clearBadBlocks } = require('./perception/environment');
const { parseGoalCommand, describeGoalPlan, setManualGoal, clearManualGoal } = require('./agent/goals');
const { forceRecovery, describeDebugState } = require('./agent/recovery');
const {
  loadProgress, getDimension, getWaypoint, saveWaypoint, removeWaypoint, listWaypoints,
  setMilestone, horizontalDistanceTo
} = require('./core/progress');

const bot = mineflayer.createBot(config.BOT_CONFIG);
bot.loadPlugin(pathfinder);

// Restore the milestone coordinates (portals, spawn beds, stronghold) saved by previous sessions
const restoredWaypoints = loadProgress(state);
if (restoredWaypoints > 0) {
  console.log(`🧭 Restored ${restoredWaypoints} waypoint(s) from ${state.progressFile}.`);
}

const AUTH_SUCCESS_PATTERNS = ['successful login', 'successfully registered', 'already logged in', 'connexion réussie', 'logged in!'];
const AUTH_IGNORE_PATTERNS = ['already have registered', 'please, login', '/login'];
const DEBUG_COMMANDS = new Set(['debug', 'debloque', 'débloque', 'coince', 'coincé', 'unstuck']);
const DEBUG_INFO_COMMANDS = new Set(['debug info', 'debug status', 'debug etat', 'debug état']);
const CHAT_LINE_LIMIT = 240;
let shouldResumeAfterDeath = false;
let respawningAfterDeath = false;

/**
 * Check whether a server message confirms successful authentication
 * @param {string} text Lowercase server message
 * @returns {boolean} True if authenticated
 */
function isAuthConfirmed(text) {
  return !AUTH_IGNORE_PATTERNS.some(p => text.includes(p)) && AUTH_SUCCESS_PATTERNS.some(p => text.includes(p));
}

/**
 * Send a chat line trimmed to the server's message length limit
 * @param {string} text Message to send
 */
function say(text) {
  bot.chat(String(text).slice(0, CHAT_LINE_LIMIT));
}

/**
 * Wait briefly after authentication for server plugins (e.g. AuthMe) to restore inventory slots
 * @param {number} [retriesLeft] Remaining polling attempts
 * @returns {Promise<void>}
 */
async function waitForInventoryRestore(retriesLeft = 8) {
  const hasItems = (bot.inventory?.slots || []).slice(5).some(Boolean);
  if (hasItems || retriesLeft <= 0) return;
  await new Promise(resolve => setTimeout(resolve, 250));
  return waitForInventoryRestore(retriesLeft - 1);
}

/**
 * Load persisted procedures from disk storage
 * @returns {Promise<number>} Number of loaded procedures
 */
async function initializeProcedureMemory() {
  if (!state.procedureMemory || typeof state.procedureMemory.loadAll !== 'function') {
    return 0;
  }
  try {
    const loadedCount = await state.procedureMemory.loadAll();
    console.log(`📚 Loaded ${loadedCount} persisted procedure(s) from ${state.procedureMemory.storageDir}.`);
    return loadedCount;
  } catch (error) {
    console.warn("⚠️ Failed to load persisted procedures:", error.message);
    return 0;
  }
}

/**
 * Synchronize inventory progression and start or resume autonomous survival loop
 */
function launchAutonomousLoop() {
  setTimeout(async () => {
    await initializeProcedureMemory();
    await waitForInventoryRestore();
    await autoEquipArmorAndShield(bot);
    syncObjective(bot, state);
    state.hasStarted = true;
    state.isSurviving = true;
    state.survivalSessionId = (state.survivalSessionId || 0) + 1;
    const sessionId = state.survivalSessionId;
    console.log(`🚀 Autonomous mode active. Objective : ${state.currentObjective}`);
    bot.chat("Autonomous ReAct mode ready. Objective : " + state.currentObjective);
    await startManagerLoop(bot);
    void handleSurvivalRequest(bot, sessionId);
  }, 800);
}

/**
 * Record portal coordinates when the bot changes dimension by walking through a portal
 * @param {string} previous Dimension the bot came from
 * @param {string} dimension Dimension the bot arrived in
 */
function recordDimensionTransition(previous, dimension) {
  console.log(`[DIMENSION] ${previous} -> ${dimension}`);
  // Nothing from the previous dimension is reachable any more
  state.deployedTable = null;
  state.managerSubGoal = null;

  const pos = bot.entity?.position;
  if (!pos) return;
  if (previous === 'overworld' && dimension === 'the_nether') {
    saveWaypoint(state, 'nether_exit', pos, 'the_nether', 'Nether portal (Nether side)');
  } else if (previous === 'the_nether' && dimension === 'overworld') {
    saveWaypoint(state, 'nether_portal', pos, 'overworld', 'Nether portal (Overworld side)');
  } else if (dimension === 'the_end') {
    setMilestone(state, 'entered_end', true);
  }
}

/**
 * After a death, check that the bot really respawned at its bed; forget the bed if it was destroyed
 */
function verifySpawnBedAfterRespawn() {
  const activeSpawn = state.milestones?.active_spawn;
  const bedWaypoint = activeSpawn ? getWaypoint(state, activeSpawn) : null;
  if (!bedWaypoint) return;

  const sameDimension = bedWaypoint.dimension === getDimension(bot);
  if (sameDimension && horizontalDistanceTo(bot, bedWaypoint) <= 16) {
    say(`Réapparu à mon lit (${bedWaypoint.x}, ${bedWaypoint.y}, ${bedWaypoint.z}). Je reprends.`);
    return;
  }

  console.log(`[BED] Respawned away from '${activeSpawn}': the bed is gone or obstructed, waypoint cleared.`);
  removeWaypoint(state, activeSpawn);
  setMilestone(state, 'active_spawn', null);
  say("Mon lit n'existe plus : il me faudra en refaire un.");
}

// Configure movement rules and water physics once upon initial spawn
bot.once('spawn', () => {
  const mcData = require("minecraft-data")(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.allowFreeClear = true; // Clear tall grass during movement
  defaultMove.canDig = true;
  defaultMove.allow1by1towers = true;
  const scafolding = [
    'dirt', 'cobblestone', 'netherrack', 'stone', 'diorite', 'andesite',
    'granite', 'cobbled_deepslate', 'deepslate', 'tuff', 'oak_planks', 'end_stone'
  ].map(name => bot.registry.itemsByName[name]?.id).filter(Boolean);
  defaultMove.scafoldingBlocks = scafolding;

  bot.pathfinder.setMovements(defaultMove);
  bot.pathfinder.bestHarvestTool = (block) => getBestToolForBlock(bot, block);

  // Keep bot at surface if falling into water
  let wasInWater = false;
  bot.on('physicsTick', () => {
    if (bot.entity.isInWater) {
      wasInWater = true;
      bot.setControlState('jump', true);
    } else if (wasInWater) {
      wasInWater = false;
      bot.setControlState('jump', false);
    }
  });
});

// Handle bot spawn and respawn events on server
bot.on('spawn', () => {
  console.log('✅ Bot spawned on server!');
  const dimension = getDimension(bot);
  console.log(`[DIMENSION] Spawned in dimension: ${dimension}`);

  const previousDimension = state.lastDimension;
  state.lastDimension = dimension;

  if (respawningAfterDeath) {
    // A respawn is not a portal trip: do not record portal coordinates here
    respawningAfterDeath = false;
    verifySpawnBedAfterRespawn();
  } else if (previousDimension && previousDimension !== dimension) {
    recordDimensionTransition(previousDimension, dimension);
  }

  if (shouldResumeAfterDeath) {
    shouldResumeAfterDeath = false;
    launchAutonomousLoop();
    return;
  }

  // Authenticate bot via AuthMe with safety delay
  const pwd = config.AUTH_PASSWORD;
  if (pwd && !state.hasStarted) {
    setTimeout(() => {
      bot.chat(`/login ${pwd}`);
      console.log(`🔑 Authentication attempt sent.`);
    }, 1500);
  } else if (!pwd && !state.hasStarted) {
    launchAutonomousLoop();
  }
});

// Handle server messages for authentication and advancements
bot.on('messagestr', (message) => {
  const text = message.toLowerCase();
  const pwd = config.AUTH_PASSWORD;

  if (text.includes('/register') && pwd) {
    bot.chat(`/register ${pwd} ${pwd}`);
  } else if (text.includes('/login') && pwd) {
    bot.chat(`/login ${pwd}`);
  }

  if (isAuthConfirmed(text) && !state.hasStarted) {
    console.log("🚀 Connection confirmed by server! Launching autonomous mode.");
    launchAutonomousLoop();
  }

  checkAdvancementMessage(bot, state, message);
  if (state.unlockedAdvancements.includes('Free the End')) {
    setMilestone(state, 'dragon_defeated', true);
  }
});

/**
 * Set an objective requested by a player and announce the prerequisite chain the bot will follow
 * @param {string} message Raw chat command
 */
function handleGoalCommand(message) {
  const command = parseGoalCommand(message, bot);

  if (command.type === 'error') {
    say(command.message);
    return;
  }

  if (command.type === 'auto') {
    clearManualGoal(bot, state);
    say(`Progression automatique. Objectif : ${state.currentObjective}`);
    return;
  }

  const plan = setManualGoal(bot, state, command.objective, command.qty);
  if (plan.satisfied) {
    clearManualGoal(bot, state);
    say(`${plan.chain} Objectif actuel : ${state.currentObjective}`);
    return;
  }

  // When the objective is not directly reachable, the chain shows what will be built first (e.g. iron pickaxe before diamond)
  say(`Nouvel objectif : ${command.qty}x ${command.objective} (${plan.stepCount} étapes)`);
  say(`Plan : ${plan.chain}`);
  console.log(`[GOAL] Manual objective '${command.objective}' x${command.qty} : ${plan.chain}`);
}

/**
 * Report the situation and break the current failure loop by forcing a different action
 * @param {boolean} infoOnly When true, only report without changing the bot's course
 */
function handleDebugCommand(infoOnly) {
  const report = describeDebugState(bot, state);
  report.forEach(line => console.log(line));
  say(report[0]);
  say(report[1]);

  if (infoOnly) {
    say(report[2]);
    say(report[3]);
    return;
  }

  if (!state.isSurviving) {
    say("Mode autonome arrêté : rien à débloquer. Tape 'start' pour le relancer.");
    return;
  }

  const { decision, blocked } = forceRecovery(bot, state, 'commande debug du joueur', { manual: true });
  const blockedNote = blocked ? ` | '${blocked.replace(':', ' ')}' interdite 5 min` : '';
  say(`Déblocage forcé -> ${decision.action} ${decision.target}${blockedNote}`);
}

/**
 * Report current bot inventory contents in chat
 */
function reportInventoryInChat() {
  const items = (bot.inventory?.slots || []).filter(Boolean);
  if (items.length === 0) {
    bot.chat("My pockets are completely empty!");
  } else {
    const list = items.map(item => `${item.count}x ${item.name}`).join(', ');
    say(`Inventory : ${list}`);
  }
}

/**
 * Report the memorized milestone coordinates in chat
 */
function reportWaypointsInChat() {
  const waypoints = listWaypoints(state);
  if (waypoints.length === 0) {
    say("Aucun point de repère mémorisé pour l'instant.");
    return;
  }
  const here = getDimension(bot);
  waypoints.forEach((wp) => {
    const distance = wp.dimension === here ? `${Math.round(horizontalDistanceTo(bot, wp))} blocs` : wp.dimension;
    say(`${wp.name} : ${wp.x}, ${wp.y}, ${wp.z} (${distance})`);
  });
}

// Handle player control commands from chat
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  // Log chat messages for debugging
  console.log(`[CHAT SERVER] ${username ? username + ': ' : ''}${message}`);
  const command = message.trim().toLowerCase();

  if (command === 'start' && !state.isSurviving) {
    await autoEquipArmorAndShield(bot);
    syncObjective(bot, state);
    state.isSurviving = true;
    state.survivalSessionId = (state.survivalSessionId || 0) + 1;
    const sessionId = state.survivalSessionId;
    bot.chat(`Starting autonomous mode. Objective : ${state.currentObjective}`);
    await startManagerLoop(bot);
    await handleSurvivalRequest(bot, sessionId);
    return;
  }

  if (command === 'stop') {
    state.isSurviving = false;
    state.survivalSessionId = (state.survivalSessionId || 0) + 1;
    state.activeActionId = (state.activeActionId || 0) + 1;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.chat("Stopping autonomous mode.");
    return;
  }

  if (command.startsWith('objectif ') || command.startsWith('goal ')) {
    handleGoalCommand(message);
    return;
  }

  if (DEBUG_INFO_COMMANDS.has(command)) {
    handleDebugCommand(true);
    return;
  }

  if (DEBUG_COMMANDS.has(command)) {
    handleDebugCommand(false);
    return;
  }

  if (command === 'plan') {
    const required = getQuestRequirement(bot, state, state.currentObjective);
    const plan = describeGoalPlan(bot, state, state.currentObjective, required);
    say(`Objectif ${state.currentObjective} x${required} : ${plan.chain}`);
    return;
  }

  if (command === 'waypoints' || command === 'reperes' || command === 'repères') {
    reportWaypointsInChat();
    return;
  }

  if (command === 'inventaire' || command === 'inv') {
    reportInventoryInChat();
    return;
  }

  if (command === 'coords' || command === 'pos') {
    const pos = bot.entity.position.floored();
    bot.chat(`Current coordinates : X:${pos.x}, Y:${pos.y}, Z:${pos.z}`);
    return;
  }

  if (command === 'tokens' || command === 'token') {
    const stats = state.tokenStats;
    const metrics = state.metrics;
    bot.chat(`Tokens : Joueur [${stats.playerPromptTokens} in / ${stats.playerCompletionTokens} out] | Manager [${stats.managerPromptTokens} in / ${stats.managerCompletionTokens} out] | Total : ${stats.totalTokens}`);
    say(`Décisions : ${metrics.deterministicDecisions} sans LLM / ${metrics.llmDecisions} via LLM | Manager LLM : ${metrics.managerLlmCalls} | Déblocages : ${metrics.recoveries}`);
  }
});

// Suspend autonomous survival on bot death and schedule respawn recovery
bot.on('death', () => {
  shouldResumeAfterDeath = state.isSurviving;
  respawningAfterDeath = true;
  state.isSurviving = false;
  state.activeActionId = (state.activeActionId || 0) + 1;
  state.lastDeathPosition = bot.entity?.position ? bot.entity.position.clone() : null;
  if (state.lastDeathPosition) {
    saveWaypoint(state, 'death', state.lastDeathPosition, getDimension(bot), 'last death (dropped items)');
  }
  state.actionHistory = [];
  state.lastActionResult = {
    action: 'none',
    target: 'none',
    success: true,
    message: 'Bot respawned and ready.'
  };
  state.managerSubGoal = null;
  state.managerDirective = "Récolter du bois pour fabriquer les premiers outils.";
  state.cyclesSinceLastManager = 0;
  // Stations and the deployed table are lost with the death location; milestone waypoints are kept on purpose
  state.base = { crafting_table: null, furnace: null, chest: null };
  state.deployedTable = null;
  state.recovery = null;
  clearBadBlocks();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  bot.chat("Bot died, waiting for respawn to resume progression.");
});

// Display formatted server messages
bot.on('message', (jsonMsg) => {
  console.log(`[SERVER] ${jsonMsg.toAnsi()}`);
});

// Log disconnections and socket errors
bot.on('kicked', console.log);
bot.on('error', console.log);
