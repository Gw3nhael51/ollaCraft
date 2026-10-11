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
    action: 'aucun',
    target: 'aucune',
    success: true,
    message: 'Bot initialisé et prêt.'
  }
};
