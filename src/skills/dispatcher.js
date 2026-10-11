const { skillMine } = require('./mine');
const { skillCraft } = require('./craft');
const { skillPlace } = require('./place');
const { skillUnstuck, skillExplore } = require('./navigate');
const { skillWiki } = require('./wiki');

const { skillSmelt } = require('./smelt');
const { skillEat } = require('./eat');
const { skillHunt, skillFight } = require('./combat');

async function dispatchSkill(bot, state, action, target, qty) {
  if (action === 'unstuck') return skillUnstuck(bot);
  if (action === 'explore') return skillExplore(bot);
  if (action === 'wiki') return skillWiki(bot, target);
  if (action === 'mine') return skillMine(bot, state, target, qty);
  if (action === 'craft') return skillCraft(bot, target);
  if (action === 'place') return skillPlace(bot, state, target);
  if (action === 'smelt') return skillSmelt(bot, state, target, qty);
  if (action === 'eat') return skillEat(bot, target);
  if (action === 'hunt') return skillHunt(bot, target);
  if (action === 'fight') return skillFight(bot, target);
  return { success: false, message: `Action inconnue '${action}'.` };
}

module.exports = { dispatchSkill };
