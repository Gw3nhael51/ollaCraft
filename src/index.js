const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const config = require('./config');
const state = require('./state');
const { syncObjective } = require('./utils/inventory');
const { handleSurvivalRequest } = require('./ai/loop');

const bot = mineflayer.createBot(config.BOT_CONFIG);
bot.loadPlugin(pathfinder);

bot.on('spawn', () => {
  console.log('✅ Le bot est connecté !');
  const defaultMove = new Movements(bot);
  defaultMove.allowFreeClear = true;
  bot.pathfinder.setMovements(defaultMove);

  if (!state.hasStarted) {
    state.hasStarted = true;
    state.isSurviving = true;
    bot.chat("Mode autonome ReAct prêt. Objectif : " + state.currentObjective);
    setTimeout(() => handleSurvivalRequest(bot), 1000);
  }
});

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;

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
      bot.chat(`Progression automatique. Objectif : \${state.currentObjective}`);
    } else if (newGoal) {
      state.manualObjective = true;
      state.currentObjective = newGoal;
      bot.chat(`Nouvel objectif enregistré : \${state.currentObjective}`);
    }
  }

  if (message === 'inventaire') {
    const items = bot.inventory.items();
    if (items.length === 0) {
      bot.chat("Mes poches sont complètement vides !");
    } else {
      const liste = items.map(item => `\${item.count}x \${item.name}`).join(', ');
      bot.chat(`J'ai sur moi : \${liste}`);
    }
  }
});

bot.on('death', () => {
  state.isSurviving = false;
  bot.chat("Je suis mort, mode autonome suspendu.");
});

bot.on('kicked', console.log);
bot.on('error', console.log);
