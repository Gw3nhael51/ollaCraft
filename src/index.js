const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const config = require('./config');
const state = require('./state');
const { syncObjective } = require('./utils/inventory');
const { handleSurvivalRequest } = require('./ai/loop');
const { checkAdvancementMessage } = require('./utils/advancements');

const bot = mineflayer.createBot(config.BOT_CONFIG);
bot.loadPlugin(pathfinder);

  bot.on('spawn', () => {
    console.log('✅ Le bot est connecté !');
    
    // Authentification via AuthMe (délai augmenté pour s'assurer que le serveur est prêt)
    const pwd = config.AUTH_PASSWORD;
    if (pwd) {
      setTimeout(() => {
        bot.chat(`/register ${pwd} ${pwd}`);
        setTimeout(() => {
          bot.chat(`/login ${pwd}`);
          console.log(`🔑 Tentative d'authentification envoyée.`);
        }, 1000);
      }, 1500);
    }

    const mcData = require("minecraft-data")(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.allowFreeClear = true; // Casser les herbes hautes
    defaultMove.canDig = true;
    defaultMove.allow1by1towers = true;
    const scafolding = ['dirt', 'cobblestone', 'netherrack', 'stone'].map(name => bot.registry.blocksByName[name]?.id).filter(Boolean);
    defaultMove.scafoldingBlocks = scafolding;

    bot.pathfinder.setMovements(defaultMove);

    // Réflexe vital : maintenir le bot à la surface s'il tombe dans l'eau
    bot.on('physicsTick', () => {
      if (bot.entity.isInWater) {
        bot.setControlState('jump', true);
      }
    });

    if (!pwd && !state.hasStarted) {
      state.hasStarted = true;
      state.isSurviving = true;
      bot.chat("Mode autonome ReAct prêt. Objectif : " + state.currentObjective);
      void handleSurvivalRequest(bot);
    }
  });

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
        console.log("🚀 Connexion confirmée par le serveur ! Lancement du mode autonome.");
        bot.chat("Mode autonome ReAct prêt. Objectif : " + state.currentObjective);
        void handleSurvivalRequest(bot);
      }
    }

    checkAdvancementMessage(bot, state, message);
  });

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  // LOG TOUTs LES MESSAGES POUR DEBUG AUTHME
  console.log(`[CHAT SERVER] ${username ? username + ': ' : ''}${message}`);

  if (message === 'start') {
    if (state.isSurviving) return;
    state.isSurviving = true;
    bot.chat("Démarrage du mode autonome.");
    await handleSurvivalRequest(bot);
  }

  if (message === 'stop') {
    state.isSurviving = false;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.chat("Arrêt du mode autonome.");
  }

  if (message.startsWith('objectif ')) {
    const newGoal = message.split(' ')[1]?.trim();
    if (newGoal === 'auto') {
      state.manualObjective = false;
      syncObjective(bot, state);
      bot.chat(`Progression automatique. Objectif : ${state.currentObjective}`);
    } else if (newGoal) {
      state.manualObjective = true;
      state.currentObjective = newGoal;
      bot.chat(`Nouvel objectif enregistré : ${state.currentObjective}`);
    }
  }

  if (message === 'inventaire') {
    const items = bot.inventory.items();
    if (items.length === 0) {
      bot.chat("Mes poches sont complètement vides !");
    } else {
      const liste = items.map(item => `${item.count}x ${item.name}`).join(', ');
      bot.chat(`J'ai sur moi : ${liste}`);
    }
  }

  if (message === 'coords' || message === 'pos') {
    const pos = bot.entity.position.floored();
    bot.chat(`Mes coordonnées actuelles : X:${pos.x}, Y:${pos.y}, Z:${pos.z}`);
  }
});

bot.on('death', () => {
  state.isSurviving = false;
  bot.chat("Je suis mort, mode autonome suspendu.");
});

bot.on('message', (jsonMsg) => {
  console.log(`[SERVEUR] ${jsonMsg.toAnsi()}`);
});

bot.on('kicked', console.log);
bot.on('error', console.log);
