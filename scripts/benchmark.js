const { performance } = require('node:perf_hooks');
const { Vec3 } = require('vec3');
const { createProcedureTemplate, validateProcedureSchema } = require('../src/procedures/schema');
const { createDefaultRegistry } = require('../src/procedures/registry');
const { validateProcedure } = require('../src/procedures/validator');
const { executeExperimentalProcedure } = require('../src/procedures/runner');
const { evaluateProcedureExecution } = require('../src/procedures/evaluator');
const { ProcedureMemory } = require('../src/procedures/memory');
const { selectProcedureForObjective } = require('../src/agent/manager');
const { scanEnvironment } = require('../src/perception/environment');

/**
 * Construire un bot Mineflayer simulé léger pour le benchmark
 * @param {object} [opts={}] Options d'état initial
 * @returns {object} Bot simulé
 */
function createBenchBot(opts = {}) {
  const inventoryItems = [...(opts.items || [])];
  const worldBlocks = new Map();

  const setBlock = (x, y, z, name) => {
    worldBlocks.set(`${x},${y},${z}`, {
      name,
      position: new Vec3(x, y, z),
      diggable: name !== 'air' && name !== 'bedrock',
      digTime: () => 5,
      drops: []
    });
  };

  setBlock(5, 64, 5, 'oak_log');

  const bot = {
    version: '1.20.4',
    health: 20,
    food: 20,
    entity: {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      height: 1.6
    },
    inventory: {
      slots: new Array(46).fill(null),
      items: () => inventoryItems.filter(Boolean),
      findInventoryItem: (name) => inventoryItems.find(i => i && i.name === name) || null,
      clearSimItems: () => {
        inventoryItems.length = 0;
      }
    },
    blockAt: (pos) => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      return worldBlocks.get(key) || { name: 'air', position: new Vec3(pos.x, pos.y, pos.z) };
    },
    canDigBlock: (b) => b && b.name !== 'air',
    dig: async (b) => {
      setBlock(b.position.x, b.position.y, b.position.z, 'air');
      inventoryItems.push({ name: 'oak_log', count: 1, type: 131, slot: 36 });
    },
    stopDigging: () => {},
    recipesFor: () => [
      {
        result: { id: 36, name: 'oak_planks', count: 4 },
        requiresTable: false,
        delta: [{ id: 131, name: 'oak_log', count: -1 }, { id: 36, name: 'oak_planks', count: 4 }]
      }
    ],
    craft: async () => {
      const logIdx = inventoryItems.findIndex(i => i && i.name === 'oak_log');
      if (logIdx !== -1) inventoryItems.splice(logIdx, 1);
      inventoryItems.push({ name: 'oak_planks', count: 4, type: 36, slot: 37 });
    },
    pathfinder: {
      isMoving: () => false,
      goto: async (goal) => {
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
      },
      stop: () => {},
      setGoal: () => {}
    }
  };

  return bot;
}

/**
 * Exécuter la suite complète de benchmarks d'OllaCraft et afficher un rapport structuré
 */
async function runBenchmarks() {
  const registry = createDefaultRegistry();

  const sampleProcedure = createProcedureTemplate({
    id: 'harvest_wood_and_craft_planks',
    name: 'Harvest Wood and Craft Planks',
    version: 1,
    status: 'experimental',
    parameters: {
      treeX: { type: 'number', default: 5 },
      treeY: { type: 'number', default: 64 },
      treeZ: { type: 'number', default: 5 }
    },
    preconditions: [
      { type: 'bot_health', value: 10, operator: 'gte' }
    ],
    steps: [
      {
        id: 'move_to_tree',
        action: 'goto_coordinates',
        parameters: { x: '$parameters.treeX', y: '$parameters.treeY', z: '$parameters.treeZ', range: 1 }
      },
      {
        id: 'break_log',
        action: 'break_block',
        parameters: { position: { x: 5, y: 64, z: 5 } }
      },
      {
        id: 'craft_planks',
        action: 'craft_recipe',
        parameters: { recipe: 'oak_planks', count: 1 }
      }
    ],
    postconditions: [
      { type: 'inventory_item', item: 'oak_planks', count: 4, operator: 'gte' }
    ],
    metadata: {
      tags: ['oak_planks', 'wood']
    }
  });

  // Mesurer : Validation statique et sémantique DSL
  const validationIterations = 1000;
  const tValStart = performance.now();
  for (let i = 0; i < validationIterations; i++) {
    validateProcedureSchema(sampleProcedure);
    validateProcedure(sampleProcedure, registry);
  }
  const tValTotal = performance.now() - tValStart;
  const valAvgMs = tValTotal / validationIterations;
  const valOpsPerSec = Math.round((validationIterations / tValTotal) * 1000);

  // Mesurer : Exécution supervisée + Évaluation indépendante + Détection de contradictions
  const execIterations = 100;
  let falsePositivesCaught = 0;
  const tExecStart = performance.now();
  for (let i = 0; i < execIterations; i++) {
    const isHallucinatedRun = i % 2 === 1;
    const bot = createBenchBot();
    const execRes = await executeExperimentalProcedure(bot, sampleProcedure, {
      actionRegistry: registry,
      skipPostconditions: true
    });
    if (isHallucinatedRun) {
      bot.inventory.clearSimItems();
    }
    const evalRes = await evaluateProcedureExecution(bot, sampleProcedure, execRes, {
      objective: 'oak_planks'
    });
    if (isHallucinatedRun && evalRes.data.status !== 'achieved' && evalRes.data.contradictions.length > 0) {
      falsePositivesCaught++;
    }
  }
  const tExecTotal = performance.now() - tExecStart;
  const execAvgMs = tExecTotal / execIterations;
  const falsePositiveCatchRate = (falsePositivesCaught / (execIterations / 2)) * 100;

  // Mesurer : Cycle de vie 4.6 (Promotion, Versionnement, Extraction de connaissances)
  const lifecycleIterations = 200;
  const tLifeStart = performance.now();
  const memory = new ProcedureMemory();
  memory.register(sampleProcedure);

  for (let i = 0; i < lifecycleIterations; i++) {
    const bot = createBenchBot();
    const execRes = await executeExperimentalProcedure(bot, sampleProcedure, { actionRegistry: registry });
    const evalRes = await evaluateProcedureExecution(bot, sampleProcedure, execRes, { objective: 'oak_planks' });
    await memory.recordEvaluation('harvest_wood_and_craft_planks', evalRes.data, {
      executionTrace: execRes.data.trace,
      context: { scenarioId: `bench_scen_${i}` }
    });
    memory.getKnowledge('oak_planks');
  }
  const tLifeTotal = performance.now() - tLifeStart;
  const lifeAvgMs = tLifeTotal / lifecycleIterations;

  // Mesurer : Scan 3D unifié de l'environnement (Rayon 16 blocs = 33x33x33 = 35 937 voxels)
  const scanBot = createBenchBot();
  const scanIterations = 10;
  const tScanStart = performance.now();
  for (let i = 0; i < scanIterations; i++) {
    scanEnvironment(scanBot, 16);
  }
  const tScanTotal = performance.now() - tScanStart;
  const scanAvgMs = tScanTotal / scanIterations;

  // Simuler : Économie d'appels LLM et de tokens sur 10 épisodes d'un objectif à 3 étapes
  const episodes = 10;
  const stepsPerObjective = 3;
  const avgTokensPerPlayerCall = 650;
  const avgTokensPerManagerCall = 520;
  const avgTokensPerGeneratorCall = 900;

  // Calculer : Coût en ReAct pur sans mémoire procédurale (3 appels Joueur + 1 appel Manager par épisode)
  const reactLlmCalls = episodes * (stepsPerObjective + 1);
  const reactTotalTokens = episodes * (stepsPerObjective * avgTokensPerPlayerCall + avgTokensPerManagerCall);

  // Calculer : Coût avec OllaCraft Phase 4 (1 génération initiale + 3 exécutions expérimentales supervisées, puis 7 exécutions validées directes)
  const procLlmCalls = 1 + 3;
  const procTotalTokens = avgTokensPerGeneratorCall + 3 * avgTokensPerManagerCall;
  const tokenSavingsPct = (((reactTotalTokens - procTotalTokens) / reactTotalTokens) * 100).toFixed(1);
  const callReductionPct = (((reactLlmCalls - procLlmCalls) / reactLlmCalls) * 100).toFixed(1);

  const promotedProc = memory.get('harvest_wood_and_craft_planks');
  const managerDecision = selectProcedureForObjective(memory, 'oak_planks', { onlyValidated: true });

  console.log('======================================================================');
  console.log('📊 OLLACRAFT — RAPPORT DE BENCHMARK ARCHITECTURE & APPRENTISSAGE (v4.6)');
  console.log('======================================================================\n');

  console.log('1. MOTEUR DSL & VALIDATION SÉMANTIQUE (schema.js + validator.js)');
  console.log(`   - Itérations           : ${validationIterations} validations complètes (graphe + types)`);
  console.log(`   - Latence moyenne      : ${valAvgMs.toFixed(3)} ms / procédure`);
  console.log(`   - Débit (Throughput)   : ${valOpsPerSec.toLocaleString('fr-FR')} procédures / sec\n`);

  console.log('2. EXÉCUTION SUPERVISÉE & ÉVALUATION RÉELLE (runner.js + evaluator.js)');
  console.log(`   - Itérations           : ${execIterations} cycles (Runner + Evaluator + Anti-Contradiction)`);
  console.log(`   - Latence moyenne      : ${execAvgMs.toFixed(3)} ms / cycle complet`);
  console.log(`   - Fausses réussites    : ${falsePositivesCaught}/${execIterations / 2} interceptées (${falsePositiveCatchRate.toFixed(0)} % de détection)\n`);

  console.log('3. MÉMOIRE PROCÉDURALE & CYCLE DE VIE (lifecycle.js + memory.js)');
  console.log(`   - Itérations           : ${lifecycleIterations} mises à jour + synthèse de connaissances`);
  console.log(`   - Latence moyenne      : ${lifeAvgMs.toFixed(3)} ms / cycle d'apprentissage`);
  console.log(`   - Statut final promu   : ${promotedProc.status} (Confiance effective : ${promotedProc.metadata.effectiveConfidenceScore})`);
  console.log(`   - Sélection Manager    : ${managerDecision?.procedure.id} (Fiable : ${managerDecision?.isReliable})\n`);

  console.log('4. PERCEPTION 3D UNIFIÉE (environment.js — 35 937 voxels / passe)');
  console.log(`   - Itérations           : ${scanIterations} scans complets (rayon 16 blocs)`);
  console.log(`   - Latence moyenne      : ${scanAvgMs.toFixed(2)} ms / scan 3D\n`);

  console.log('5. IMPACT COGNITIF SUR 10 ÉPISODES (ReAct Classique vs OllaCraft Phase 4.6)');
  console.log(`   - ReAct Classique      : ${reactLlmCalls} appels LLM (~${reactTotalTokens.toLocaleString('fr-FR')} tokens)`);
  console.log(`   - OllaCraft Procédural : ${procLlmCalls} appels LLM (~${procTotalTokens.toLocaleString('fr-FR')} tokens)`);
  console.log(`   - Gain Appels LLM      : -${callReductionPct} % d'inférences Ollama`);
  console.log(`   - Économie de Tokens   : -${tokenSavingsPct} % de tokens consommés`);
  console.log('======================================================================');
}

runBenchmarks().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exitCode = 1;
});
