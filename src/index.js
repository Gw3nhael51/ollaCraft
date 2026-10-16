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

// Handle bot spawn and initial setup on server
bot.on('spawn', () => {
  console.log('✅ Bot connected successfully!');

  // Authenticate bot via AuthMe with safety delay
  const pwd = config.AUTH_PASSWORD;
  if (pwd) {
    setTimeout(() => {
      bot.chat(`/register ${pwd} ${pwd}`);
      setTimeout(() => {
        bot.chat(`/login ${pwd}`);
        console.log(`🔑 Authentication attempt sent.`);
      }, 1000);
    }, 1500);
  }

  const mcData = require("minecraft-data")(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.allowFreeClear = true; // Clear tall grass during movement
  defaultMove.canDig = true;
  defaultMove.allow1by1towers = true;
  const scafolding = ['dirt', 'cobblestone', 'netherrack', 'stone'].map(name => bot.registry.blocksByName[name]?.id).filter(Boolean);
  defaultMove.scafoldingBlocks = scafolding;

  bot.pathfinder.setMovements(defaultMove);

  // Keep bot at surface if falling into water
  bot.on('physicsTick', () => {
    if (bot.entity.isInWater) {
      bot.setControlState('jump', true);
    }
  });

  if (!pwd && !state.hasStarted) {
    state.hasStarted = true;
    state.isSurviving = true;
    bot.chat("Autonomous ReAct mode ready. Objective : " + state.currentObjective);
    startManagerLoop(bot);
    void handleSurvivalRequest(bot);
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

  if (text.includes('successful') || text.includes('succès') || text.includes('logged in') || text.includes('registered')) {
    if (!state.hasStarted) {
      state.hasStarted = true;
      state.isSurviving = true;
      console.log("🚀 Connection confirmed by server! Launching autonomous mode.");
      bot.chat("Autonomous ReAct mode ready. Objective : " + state.currentObjective);
      startManagerLoop(bot);
      void handleSurvivalRequest(bot);
    }
  }

  checkAdvancementMessage(bot, state, message);
});

// Handle player control commands from chat
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  // Log chat messages for debugging
  console.log(`[CHAT SERVER] ${username ? username + ': ' : ''}${message}`);

  if (message === 'start') {
    if (state.isSurviving) return;
    state.isSurviving = true;
    bot.chat("Starting autonomous mode.");
    startManagerLoop(bot);
    await handleSurvivalRequest(bot);
  }

  if (message === 'stop') {
    state.isSurviving = false;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.chat("Stopping autonomous mode.");
  }

  if (message.startsWith('objectif ') || message.startsWith('goal ')) {
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

  if (message === 'inventaire' || message === 'inv') {
    const items = (bot.inventory?.slots || []).filter(Boolean);
    if (items.length === 0) {
      bot.chat("My pockets are completely empty!");
    } else {
      const list = items.map(item => `${item.count}x ${item.name}`).join(', ');
      bot.chat(`Inventory : ${list}`);
    }
  }

  if (message === 'coords' || message === 'pos') {
    const pos = bot.entity.position.floored();
    bot.chat(`Current coordinates : X:${pos.x}, Y:${pos.y}, Z:${pos.z}`);
  }

  if (message === 'tokens' || message === 'token') {
    const stats = state.tokenStats;
    bot.chat(`Tokens : Joueur [${stats.playerPromptTokens} in / ${stats.playerCompletionTokens} out] | Manager [${stats.managerPromptTokens} in / ${stats.managerCompletionTokens} out] | Total : ${stats.totalTokens}`);
  }
});

// Suspend autonomous survival on bot death
bot.on('death', () => {
  state.isSurviving = false;
  bot.chat("Bot died, autonomous mode suspended.");
});

// Display formatted server messages
bot.on('message', (jsonMsg) => {
  console.log(`[SERVER] ${jsonMsg.toAnsi()}`);
});

// Log disconnections and socket errors
bot.on('kicked', console.log);
bot.on('error', console.log);
