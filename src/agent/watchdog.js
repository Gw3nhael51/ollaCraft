const { getRecoveryState } = require('./recovery');

// Oxygen goes from 20 (full) to 0; below this the bot stops whatever it is doing and swims up.
// At 10 it still has about 7 seconds of air, then roughly 10 seconds of drowning damage before dying.
const LOW_OXYGEN_LEVEL = 10;
const SAFE_OXYGEN_LEVEL = 16;

/**
 * React to a change of the bot's air supply: abort the running action and surface before drowning.
 * Skills hold the bot under water for tens of seconds (pathfinding along a lake bed, mining a submerged
 * block), far longer than its air lasts, and the decision loop only regains control between two actions.
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @returns {boolean} True if an emergency surfacing was triggered
 */
function handleBreath(bot, state) {
  const oxygen = bot.oxygenLevel ?? 20;

  if (oxygen >= SAFE_OXYGEN_LEVEL) {
    state.drowningAlert = false;
    return false;
  }
  if (oxygen > LOW_OXYGEN_LEVEL || state.drowningAlert || !state.isSurviving) return false;

  state.drowningAlert = true;
  console.log(`[WATCHDOG 🫧] Oxygen at ${oxygen}/20: aborting the current action and swimming up.`);

  // Invalidate the running action and take the controls back from the pathfinder
  state.activeActionId = (state.activeActionId || 0) + 1;
  bot.pathfinder?.setGoal?.(null);
  try {
    bot.stopDigging?.();
  } catch {
    // Nothing was being dug
  }
  bot.clearControlStates?.();
  bot.setControlState?.('jump', true);

  // The next cycle finishes the job: surface, then swim to dry land
  const recovery = getRecoveryState(state);
  const alreadyQueued = recovery.forcedQueue.some(decision => decision.action === 'unstuck');
  if (!alreadyQueued) {
    recovery.forcedQueue.unshift({
      action: 'unstuck',
      target: 'none',
      qty: 1,
      thought: "Alerte noyade : je remonte à la surface et je rejoins la terre ferme.",
      source: 'recovery'
    });
  }
  return true;
}

/**
 * Install the survival watchdogs that run independently of the decision loop
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 */
function installSurvivalWatchdog(bot, state) {
  bot.on('breath', () => handleBreath(bot, state));
}

module.exports = { installSurvivalWatchdog, handleBreath, LOW_OXYGEN_LEVEL };
