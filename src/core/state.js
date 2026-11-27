const { ProcedureMemory } = require('../procedures/memory');
const { DEFAULT_STORAGE_DIR } = require('../procedures/store');
const { ObjectiveGenerationTracker } = require('../procedures/matcher');

/**
 * Define shared global state for the autonomous agent
 */
module.exports = {
  isConnected: false,
  isSurviving: false,
  hasStarted: false,
  currentObjective: 'wooden_pickaxe',
  manualObjective: false,
  manualObjectiveQty: 1,
  unlockedAdvancements: [],
  currentAdvancement: 'Stone Age',
  completedQuests: new Set(),
  lastDeathPosition: null,
  lastSafePosition: null,
  base: {
    crafting_table: null,
    furnace: null,
    chest: null
  },
  // Position of the carried crafting table while it is deployed on the ground (null when in inventory)
  deployedTable: null,
  portalCastOrigin: null,
  // Named coordinates of major milestones (portals, spawn beds, stronghold) kept across deaths and restarts
  waypoints: {},
  // Sticky progression flags that cannot be derived from the inventory
  milestones: {},
  // Eye of Ender triangulation: recorded throws and the resulting stronghold estimate
  stronghold: {
    throws: [],
    estimate: null,
    located: false,
    reached: false
  },
  endPortal: {
    center: null,
    frameCount: 0,
    filledCount: 0
  },
  // Path of the JSON file persisting waypoints and milestones (null disables persistence, e.g. in tests)
  progressFile: null,
  netherPortalAttempts: 0,
  registeredPortalCoords: null,
  lastActionResult: {
    action: 'none',
    target: 'none',
    success: true,
    message: 'Bot initialized and ready.'
  },
  actionHistory: [],
  managerDirective: "Récolter du bois pour fabriquer les premiers outils.",
  managerSubGoal: null,
  procedureMemory: new ProcedureMemory({ storageDir: DEFAULT_STORAGE_DIR }),
  generationTracker: new ObjectiveGenerationTracker(),
  isManagerThinking: false,
  cyclesSinceLastManager: 0,
  activeActionId: 0,
  survivalSessionId: 0,
  // Failure memory, stagnation counters and forced decisions (managed by agent/recovery.js)
  recovery: null,
  lastDecisionSource: 'none',
  metrics: {
    deterministicDecisions: 0,
    llmDecisions: 0,
    managerLlmCalls: 0,
    recoveries: 0,
    refusals: 0
  },
  tokenStats: {
    playerPromptTokens: 0,
    playerCompletionTokens: 0,
    managerPromptTokens: 0,
    managerCompletionTokens: 0,
    totalTokens: 0
  }
};
