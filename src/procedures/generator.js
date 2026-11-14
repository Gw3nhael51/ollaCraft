const config = require('../infrastructure/config');
const { createResult } = require('../actions/primitives/result');
const { validateProcedureSchema } = require('./schema');
const { createDefaultRegistry } = require('./registry');

const DEFAULT_GENERATION_TIMEOUT_MS = 30000;
const MAX_CORRECTION_ATTEMPTS = 2;

/**
 * Extract and parse JSON object from raw LLM text response
 * @param {string} rawText Raw string output from LLM
 * @returns {object} Parsed JSON procedure object
 */
function extractProcedureJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new Error('Empty response from model');
  }

  let cleaned = rawText.trim();

  const markdownMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (markdownMatch && markdownMatch[1]) {
    cleaned = markdownMatch[1].trim();
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No valid JSON object structure found in response');
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Build dynamic system prompt containing context, action schemas, and strict DSL rules
 * @param {object} params Prompt construction parameters
 * @param {string} params.objective Target quest or crafting objective
 * @param {object} [params.context={}] Current inventory and environment context
 * @param {object} params.registry Action registry instance
 * @param {Array<object>} [params.existingProcedures=[]] Known procedures for reference
 * @returns {string} Formatted prompt string
 */
function buildGeneratorPrompt({ objective, context = {}, registry, existingProcedures = [] }) {
  const actionsList = registry.list().map(action => {
    const required = action.parametersSchema?.required || [];
    const optional = action.parametersSchema?.optional || [];
    return `- action: "${action.id}"
  description: "${action.description}"
  parameters: required=[${required.join(', ')}], optional=[${optional.join(', ')}]`;
  }).join('\n');

  const inventorySummary = Array.isArray(context.inventory)
    ? context.inventory.map(i => `${i.count}x ${i.name}`).join(', ') || 'empty'
    : (context.inventory || 'unknown');

  const environmentSummary = Array.isArray(context.blocks)
    ? context.blocks.map(b => b.name).filter(Boolean).slice(0, 10).join(', ')
    : 'standard overworld';

  const knownList = existingProcedures.slice(0, 5).map(p => `- ${p.id} (${p.status})`).join('\n') || 'none';

  return `You are the Autonomous Procedure Generator for a Minecraft AI agent.
Your mission is to construct a declarative JSON Procedure conforming strictly to the DSL schema.

TARGET OBJECTIVE:
"${objective}"

CURRENT CONTEXT:
- Inventory: ${inventorySummary}
- Surrounding Environment: ${environmentSummary}
- Known procedures for reference:
${knownList}

AUTHORIZED ACTIONS (You MUST ONLY choose actions from this list):
${actionsList}

STRICT SPECIFICATION RULES:
1. Output MUST be a single raw JSON object matching the Procedure DSL schema.
2. No Markdown formatting, no code fences, no introductory or trailing explanations.
3. Root fields required:
   - "id": unique lowercase identifier (regex: ^[a-z0-9_-]{1,64}$)
   - "version": 1
   - "name": human-readable title (max 128 chars)
   - "status": "experimental" (ALWAYS "experimental", never "validated")
   - "description": concise explanation of strategy (max 512 chars)
   - "parameters": input arguments schema
   - "preconditions": required initial conditions
   - "steps": array of 1 to 50 sequential steps
   - "postconditions": expected verified outcomes
   - "metadata": { "tags": ["${objective}"] }
4. In each step:
   - "id": step identifier (e.g. "step_1")
   - "action": MUST be one of the authorized action IDs above
   - "parameters": object matching the action's parameter specification
   - Dynamic references: use "$parameters.<name>" or "$steps.<previousStepId>.output.<prop>"
   - NEVER reference future steps or self.
5. Postconditions must state verifiable facts (e.g. inventory_item count).
6. Absolutely NO JavaScript code, NO eval, NO scripts, NO functions.`;
}

/**
 * Execute HTTP query to local Ollama inference service
 * @param {string} promptText Prompt delivered to the model
 * @param {object} options Query options
 * @param {string} options.model Target model name
 * @param {AbortSignal} [options.signal=null] Cancellation signal
 * @returns {Promise<string>} Raw model response text
 */
async function queryOllama(promptText, options = {}) {
  const host = config.OLLAMA_HOST || 'http://localhost:11434';
  const model = options.model || config.OLLAMA_MODEL_MANAGER || 'qwen2.5:latest';

  const response = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model,
      prompt: promptText,
      stream: false,
      format: 'json',
      options: {
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama HTTP error ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(String(data.error));
  }

  return (data.response || data.thinking || '').trim();
}

/**
 * Generate a candidate procedure conforming to the declarative DSL via Ollama
 * @param {object} options Generation invocation options
 * @param {string} options.objective Target quest or crafting objective
 * @param {object} [options.context={}] Inventory and environmental state
 * @param {object} [options.registry=null] Action registry containing available primitives
 * @param {Array<object>} [options.existingProcedures=[]] Already known procedures
 * @param {AbortSignal} [options.signal=null] External cancellation signal
 * @param {string} [options.model=null] Ollama model identifier override
 * @param {number} [options.timeoutMs=30000] Request timeout in milliseconds
 * @param {Function} [options.askOllamaFn=null] Optional dependency injection for Ollama queries
 * @returns {Promise<{ success: boolean, reason: string, data: object|null, error: string|null }>} Universal result
 */
async function generateProcedure(options = {}) {
  const {
    objective,
    context = {},
    registry = createDefaultRegistry(),
    existingProcedures = [],
    signal = null,
    model = config.OLLAMA_MODEL_MANAGER || 'qwen2.5:latest',
    timeoutMs = DEFAULT_GENERATION_TIMEOUT_MS,
    askOllamaFn = null
  } = options;

  const startTime = Date.now();

  if (!objective || typeof objective !== 'string' || objective.trim().length === 0) {
    return createResult(false, 'invalid_objective', null, 'Objective must be a non-empty string');
  }

  if (signal?.aborted) {
    return createResult(false, 'aborted', {
      procedure: null,
      rawResponse: null,
      generationMetadata: { model, durationMs: 0, attempts: 0 }
    }, 'Procedure generation aborted by caller');
  }

  const promptText = buildGeneratorPrompt({
    objective: objective.trim(),
    context,
    registry,
    existingProcedures
  });

  const queryFn = askOllamaFn || queryOllama;
  let attempts = 0;
  let lastRawResponse = null;
  let lastError = null;

  while (attempts < MAX_CORRECTION_ATTEMPTS) {
    attempts++;

    if (signal?.aborted) {
      return createResult(false, 'aborted', {
        procedure: null,
        rawResponse: lastRawResponse,
        generationMetadata: { model, durationMs: Date.now() - startTime, attempts }
      }, 'Procedure generation aborted by caller');
    }

    let timeoutTimer = null;
    let localSignal = signal;

    try {
      if (timeoutMs > 0) {
        const timeoutController = new AbortController();
        timeoutTimer = setTimeout(() => {
          timeoutController.abort(new Error('Generation timeout reached'));
        }, timeoutMs);

        if (signal) {
          signal.addEventListener('abort', () => timeoutController.abort(signal.reason), { once: true });
        }
        localSignal = timeoutController.signal;
      }

      const raw = await queryFn(promptText, { model, signal: localSignal });
      lastRawResponse = raw;

      if (localSignal?.aborted) {
        const isTimeout = String(localSignal.reason?.message || '').toLowerCase().includes('timeout');
        return createResult(false, isTimeout ? 'timeout' : 'aborted', {
          procedure: null,
          rawResponse: raw,
          generationMetadata: { model, durationMs: Date.now() - startTime, attempts }
        }, isTimeout ? 'Generation timeout reached' : 'Generation aborted by caller');
      }

      if (!raw || raw.trim().length === 0) {
        return createResult(false, 'empty_response', {
          procedure: null,
          rawResponse: raw,
          generationMetadata: { model, durationMs: Date.now() - startTime, attempts }
        }, 'Model returned an empty response');
      }

      let parsedProcedure;
      try {
        parsedProcedure = extractProcedureJson(raw);
      } catch (err) {
        lastError = err;
        continue;
      }

      if (parsedProcedure.status !== 'experimental') {
        parsedProcedure.status = 'experimental';
      }

      if (!Number.isInteger(parsedProcedure.version) || parsedProcedure.version < 1) {
        parsedProcedure.version = 1;
      }

      const schemaCheck = validateProcedureSchema(parsedProcedure);
      if (!schemaCheck.valid) {
        return createResult(false, 'invalid_schema', {
          procedure: null,
          errors: schemaCheck.errors,
          rawResponse: raw,
          generationMetadata: { model, durationMs: Date.now() - startTime, attempts }
        }, `Generated procedure violated schema: ${schemaCheck.errors.join('; ')}`);
      }

      if (Array.isArray(parsedProcedure.steps)) {
        for (const step of parsedProcedure.steps) {
          if (!registry.has(step.action)) {
            return createResult(false, 'unauthorized_action', {
              procedure: null,
              unauthorizedAction: step.action,
              rawResponse: raw,
              generationMetadata: { model, durationMs: Date.now() - startTime, attempts }
            }, `Action '${step.action}' is not authorized in ActionRegistry`);
          }
        }
      }

      return createResult(true, 'generated', {
        procedure: parsedProcedure,
        rawResponse: raw,
        generationMetadata: {
          model,
          durationMs: Date.now() - startTime,
          attempts
        }
      }, null);

    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError' || localSignal?.aborted) {
        const isTimeout = String(err.message).toLowerCase().includes('timeout') ||
          String(localSignal?.reason?.message).toLowerCase().includes('timeout');

        return createResult(false, isTimeout ? 'timeout' : 'aborted', {
          procedure: null,
          rawResponse: lastRawResponse,
          generationMetadata: { model, durationMs: Date.now() - startTime, attempts }
        }, isTimeout ? 'Generation timeout reached' : 'Generation aborted by caller');
      }
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }
  }

  return createResult(false, 'generation_failed', {
    procedure: null,
    rawResponse: lastRawResponse,
    generationMetadata: { model, durationMs: Date.now() - startTime, attempts }
  }, lastError ? lastError.message : 'Failed to generate valid procedure within retry limit');
}

module.exports = {
  DEFAULT_GENERATION_TIMEOUT_MS,
  MAX_CORRECTION_ATTEMPTS,
  extractProcedureJson,
  buildGeneratorPrompt,
  queryOllama,
  generateProcedure
};
