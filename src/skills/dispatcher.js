const { skillMine } = require('./mine');
const { skillCraft } = require('./craft');
const { skillPlace } = require('./place');
const { skillUnstuck, skillExplore } = require('./navigate');

async function dispatchSkill(bot, state, action, target, qty) {
  if (action === 'unstuck') return skillUnstuck(bot);
  if (action === 'explore') return skillExplore(bot);
  if (action === 'mine') return skillMine(bot, state, target, qty);
  if (action === 'craft') return skillCraft(bot, target);
  if (action === 'place') return skillPlace(bot, target);
  return { success: false, message: `Action inconnue '\${action}'.` };
}

module.exports = { dispatchSkill };
