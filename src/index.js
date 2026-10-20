const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const config = require('./config');
const state = require('./state');
const { syncObjective } = require('./utils/inventory');
const { handleSurvivalRequest } = require('./ai/loop');
const { startManagerLoop } = require('./ai/manager');
const { checkAdvancementMessage } = require('./utils/advancements');

const bot = mineflayer.createBot(config.BOT_CONFIG);
bot.loadPlugin(pathfinder);

const AUTH_SUCCESS_PATTERNS = ['successful login', 'successfully registered', 'already logged in', 'connexion réussie', 'logged in!'];
const AUTH_IGNORE_PATTERNS = ['already have registered', 'please, login', '/login'];
let shouldResumeAfterDeath = false;

/**
 * Check whether a server message confirms successful authentication
 * @param {string} text Lowercase server message
 * @returns {boolean} True if authenticated
 */
function isAuthConfirmed(text) {
  return !AUTH_IGNORE_PATTERNS.some(p => text.includes(p)) && AUTH_SUCCESS_PATTERNS.some(p => text.includes(p));
}

/**
 * Synchronize inventory progression and start or resume autonomous survival loop
 */
function launchAutonomousLoop() {
  setTimeout(() => {
    syncObjective(bot, state);
    state.hasStarted = true;
    state.isSurviving = true;
    console.log(`🚀 Autonomous mode active. Objective : ${state.currentObjective}`);
    bot.chat("Autonomous ReAct mode ready. Objective : " + state.currentObjective);
    void startManagerLoop(bot);
    void handleSurvivalRequest(bot);
  }, 600);
}

// Configure movement rules and water physics once upon initial spawn
bot.once('spawn', () => {
  const mcData = require("minecraft-data")(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.allowFreeClear = true; // Clear tall grass during movement
  defaultMove.canDig = true;
  defaultMove.allow1by1towers = true;
  const scafolding = ['dirt', 'cobblestone', 'netherrack', 'stone'].map(name => bot.registry.blocksByName[name]?.id).filter(Boolean);
  defaultMove.scafoldingBlocks = scafolding;

  bot.pathfinder.setMovements(defaultMove);

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
});

/**
 * Update manual or automatic objective from player chat command
 * @param {string} message Raw chat command
 */
function handleGoalCommand(message) {
  const newGoal = message.split(' ')[1]?.trim();
  if (newGoal === 'auto') {
    state.manualObjective = false;
    syncObjective(bot, state);
    bot.chat(`Automatic progression. Objective : ${state.currentObjective}`);
  } else if (newGoal) {
    state.manualObjective = true;
    state.currentObjective = newGoal;
    bot.chat(`New objective registered : ${state.currentObjective}`);
  }
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
    bot.chat(`Inventory : ${list}`);
  }
}

// Handle player control commands from chat
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  // Log chat messages for debugging
  console.log(`[CHAT SERVER] ${username ? username + ': ' : ''}${message}`);

  if (message === 'start' && !state.isSurviving) {
    state.isSurviving = true;
    bot.chat("Starting autonomous mode.");
    void startManagerLoop(bot);
    await handleSurvivalRequest(bot);
    return;
  }

  if (message === 'stop') {
    state.isSurviving = false;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.chat("Stopping autonomous mode.");
    return;
  }

  if (message.startsWith('objectif ') || message.startsWith('goal ')) {
    handleGoalCommand(message);
    return;
  }

  if (message === 'inventaire' || message === 'inv') {
    reportInventoryInChat();
    return;
  }

  if (message === 'coords' || message === 'pos') {
    const pos = bot.entity.position.floored();
    bot.chat(`Current coordinates : X:${pos.x}, Y:${pos.y}, Z:${pos.z}`);
    return;
  }

  if (message === 'tokens' || message === 'token') {
    const stats = state.tokenStats;
    bot.chat(`Tokens : Joueur [${stats.playerPromptTokens} in / ${stats.playerCompletionTokens} out] | Manager [${stats.managerPromptTokens} in / ${stats.managerCompletionTokens} out] | Total : ${stats.totalTokens}`);
  }
});

// Suspend autonomous survival on bot death and schedule respawn recovery
bot.on('death', () => {
  shouldResumeAfterDeath = state.isSurviving;
  state.isSurviving = false;
  state.activeActionId = (state.activeActionId || 0) + 1;
  state.lastDeathPosition = bot.entity?.position ? bot.entity.position.clone() : null;
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
