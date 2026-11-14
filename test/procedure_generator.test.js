const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractProcedureJson,
  buildGeneratorPrompt,
  generateProcedure
} = require('../src/procedures/generator');
const { ActionRegistry } = require('../src/procedures/registry');

/**
 * Build simulated action registry for testing generator boundaries
 * @returns {ActionRegistry} Pre-populated test registry
 */
function createMockRegistry() {
  const registry = new ActionRegistry();
  registry.register({
    id: 'goto_coordinates',
    description: 'Navigate bot to coordinates',
    parametersSchema: { required: ['x', 'y', 'z'] },
    handler: async () => ({ success: true })
  });
  registry.register({
    id: 'break_block',
    description: 'Break block at coordinates',
    parametersSchema: { required: ['position'] },
    handler: async () => ({ success: true })
  });
  registry.register({
    id: 'craft_recipe',
    description: 'Craft recipe with count',
    parametersSchema: { required: ['recipe'] },
    handler: async () => ({ success: true })
  });
  return registry;
}

test('Generator: Parses valid pure JSON and markdown-fenced JSON responses', () => {
  const pureJson = '{"id":"craft_pickaxe","steps":[{"id":"step_1","action":"craft"}]}';
  const parsedPure = extractProcedureJson(pureJson);
  assert.equal(parsedPure.id, 'craft_pickaxe');

  const markdownJson = '```json\n{"id":"craft_axe","steps":[{"id":"step_1","action":"craft"}]}\n```';
  const parsedMarkdown = extractProcedureJson(markdownJson);
  assert.equal(parsedMarkdown.id, 'craft_axe');

  assert.throws(() => extractProcedureJson(''), /empty response/i);
  assert.throws(() => extractProcedureJson('This is not json at all'), /no valid json object/i);
});

test('Generator: Constructs prompt including action schemas from registry and filtered context', () => {
  const registry = createMockRegistry();
  const prompt = buildGeneratorPrompt({
    objective: 'craft_stone_pickaxe',
    context: {
      inventory: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
      blocks: [{ name: 'crafting_table' }]
    },
    registry,
    existingProcedures: [{ id: 'gather_wood', status: 'validated' }]
  });

  assert.match(prompt, /TARGET OBJECTIVE:\s*"craft_stone_pickaxe"/);
  assert.match(prompt, /goto_coordinates/);
  assert.match(prompt, /break_block/);
  assert.match(prompt, /craft_recipe/);
  assert.match(prompt, /3x cobblestone/);
  assert.match(prompt, /gather_wood \(validated\)/);
  assert.match(prompt, /"status": "experimental"/);
});

test('Generator: Successfully returns candidate procedure with forced experimental status', async () => {
  const registry = createMockRegistry();

  const mockResponse = JSON.stringify({
    id: 'craft_stone_pickaxe',
    version: 1,
    name: 'Craft Stone Pickaxe',
    status: 'validated',
    description: 'Assemble stone pickaxe using crafting table',
    parameters: {
      recipe: { type: 'string', default: 'stone_pickaxe' }
    },
    preconditions: [],
    steps: [
      {
        id: 'step_craft',
        action: 'craft_recipe',
        parameters: { recipe: '$parameters.recipe' }
      }
    ],
    postconditions: [
      {
        type: 'inventory_item',
        item: 'stone_pickaxe',
        operator: '>=',
        count: 1
      }
    ],
    metadata: {
      tags: ['craft_stone_pickaxe', 'tools']
    }
  });

  const result = await generateProcedure({
    objective: 'craft_stone_pickaxe',
    registry,
    askOllamaFn: async () => mockResponse
  });

  assert.equal(result.success, true);
  assert.equal(result.reason, 'generated');
  assert.ok(result.data.procedure);
  assert.equal(result.data.procedure.id, 'craft_stone_pickaxe');
  assert.equal(result.data.procedure.status, 'experimental');
  assert.equal(result.data.generationMetadata.attempts, 1);
});

test('Generator: Rejects procedures referencing unauthorized actions not in ActionRegistry', async () => {
  const registry = createMockRegistry();

  const mockResponse = JSON.stringify({
    id: 'malicious_eval_task',
    version: 1,
    name: 'Arbitrary Task',
    status: 'experimental',
    steps: [
      {
        id: 'step_hack',
        action: 'unauthorized_shell_exec',
        parameters: { command: 'rm -rf /' }
      }
    ]
  });

  const result = await generateProcedure({
    objective: 'hack_game',
    registry,
    askOllamaFn: async () => mockResponse
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'unauthorized_action');
  assert.match(result.error, /unauthorized_shell_exec/);
});

test('Generator: Enforces maximum limit of 50 steps', async () => {
  const registry = createMockRegistry();

  const excessiveSteps = Array.from({ length: 55 }, (_, i) => ({
    id: `step_${i + 1}`,
    action: 'goto_coordinates',
    parameters: { x: i, y: 64, z: 0 }
  }));

  const mockResponse = JSON.stringify({
    id: 'too_many_steps_task',
    version: 1,
    name: 'Gigantic Procedure',
    status: 'experimental',
    steps: excessiveSteps
  });

  const result = await generateProcedure({
    objective: 'huge_task',
    registry,
    askOllamaFn: async () => mockResponse
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'invalid_schema');
  assert.match(result.error, /exceeds maximum complexity limit of 50 steps/i);
});

test('Generator: Handles empty responses from inference model', async () => {
  const registry = createMockRegistry();

  const result = await generateProcedure({
    objective: 'empty_test',
    registry,
    askOllamaFn: async () => '   '
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'empty_response');
  assert.match(result.error, /empty response/i);
});

test('Generator: Handles malformed JSON with retries exhausted', async () => {
  const registry = createMockRegistry();

  const result = await generateProcedure({
    objective: 'malformed_test',
    registry,
    askOllamaFn: async () => 'Not a valid JSON payload at all!'
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'generation_failed');
});

test('Generator: Aborts cleanly when AbortSignal triggers', async () => {
  const registry = createMockRegistry();
  const controller = new AbortController();

  const promise = generateProcedure({
    objective: 'abort_test',
    registry,
    signal: controller.signal,
    askOllamaFn: async (_prompt, opts) => {
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      });
    }
  });

  controller.abort();
  const result = await promise;

  assert.equal(result.success, false);
  assert.equal(result.reason, 'aborted');
});

test('Generator: Normalizes timeout error when model takes too long', async () => {
  const registry = createMockRegistry();

  const result = await generateProcedure({
    objective: 'timeout_test',
    registry,
    timeoutMs: 10,
    askOllamaFn: async (_prompt, opts) => {
      return new Promise((resolve, reject) => {
        if (opts.signal?.aborted) {
          return reject(opts.signal.reason);
        }
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
        setTimeout(() => resolve('{}'), 50);
      });
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'timeout');
  assert.match(result.error, /timeout/i);
});
