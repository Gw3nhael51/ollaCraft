const { skillMine } = require('./mine');
const { skillCraft } = require('./craft');
const { skillPlace } = require('./place');
const { skillUnstuck, skillExplore } = require('./navigate');
const { skillWiki } = require('./wiki');
const { skillSmelt } = require('./smelt');
const { skillEat } = require('./eat');
const { skillHunt, skillFight } = require('./combat');
const { skillChest } = require('./storage');
const { skillEquip } = require('./equip');
const { skillPortal } = require('./portal');

/**
 * Route an AI-decided action to its corresponding execution skill
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {string} action Type of action to execute
 * @param {string} target Action target
 * @param {number} qty Requested quantity
 * @returns {Promise<{ success: boolean, message: string }>} Execution result
 */
async function dispatchSkill(bot, state, action, target, qty) {
  if (action === 'unstuck') return skillUnstuck(bot);
  if (action === 'explore') return skillExplore(bot);
  if (action === 'wiki') return skillWiki(bot, target);
  if (action === 'mine') return skillMine(bot, state, target, qty);
  if (action === 'craft') return skillCraft(bot, state, target);
  if (action === 'place') return skillPlace(bot, state, target);
  if (action === 'smelt') return skillSmelt(bot, state, target, qty);
  if (action === 'eat') return skillEat(bot, target);
  if (action === 'hunt') return skillHunt(bot, target);
  if (action === 'fight') return skillFight(bot, target);
  if (action === 'chest') return skillChest(bot, state);
  if (action === 'equip') return skillEquip(bot, target);
  if (action === 'portal') return skillPortal(bot);
  return { success: false, message: `Unknown action '${action}'.` };
}

module.exports = { dispatchSkill };
