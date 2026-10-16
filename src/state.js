/**
 * Define shared global state for the autonomous agent
 */
module.exports = {
  isSurviving: false,
  hasStarted: false,
  currentObjective: 'wooden_axe',
  manualObjective: false,
  unlockedAdvancements: [],
  currentAdvancement: 'Stone Age',
  completedQuests: new Set(),
  lastDeathPosition: null,
  base: {
    crafting_table: null,
    furnace: null,
    chest: null
  },
  lastActionResult: {
    action: 'none',
    target: 'none',
    success: true,
    message: 'Bot initialized and ready.'
  },
  actionHistory: [],
  managerDirective: "Récolter du bois pour fabriquer les premiers outils.",
  managerSubGoal: null,
  isManagerThinking: false,
  tokenStats: {
    playerPromptTokens: 0,
    playerCompletionTokens: 0,
    managerPromptTokens: 0,
    managerCompletionTokens: 0,
    totalTokens: 0
  }
};
