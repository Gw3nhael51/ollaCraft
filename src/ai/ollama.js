const config = require('../config');
const state = require('../state');

const PLAYER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: {
      type: 'string',
      enum: Array.from(config.VALID_ACTIONS)
    },
    target: { type: 'string' }
  },
  required: ['thought', 'action', 'target']
};

const MANAGER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    directive: { type: 'string' },
    suggestedAction: {
      type: 'string',
      enum: Array.from(config.VALID_ACTIONS)
    },
    suggestedTarget: { type: 'string' }
  },
  required: ['thought', 'directive', 'suggestedAction', 'suggestedTarget']
};

/**
 * Get schema definition based on role
 * @param {string} role Calling role ('joueur' or 'manager')
 * @returns {object} JSON schema
 */
function getFormatSchema(role) {
  return role === 'manager' ? MANAGER_JSON_SCHEMA : PLAYER_JSON_SCHEMA;
}

/**
 * Query local Ollama model to obtain a structured JSON decision
 * @param {string} promptText Full prompt sent to the model
 * @param {string} [modelName] Name of target Ollama model
 * @param {string} [role] Calling role ('joueur' or 'manager')
 * @returns {Promise<object|null>} Parsed JSON decision or null on failure
 */
async function askOllama(promptText, modelName = config.OLLAMA_MODEL_PLAYER, role = 'joueur') {
  try {
    const host = config.OLLAMA_HOST || 'http://localhost:11434';
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: modelName,
        prompt: promptText,
        stream: false,
        format: getFormatSchema(role),
        think: false,
        options: {
          temperature: 0.1
        }
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error("Ollama API error :", data.error);
      return null;
    }

    const promptTokens = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;
    const isManager = role === 'manager';

    if (state?.tokenStats) {
      if (isManager) {
        state.tokenStats.managerPromptTokens += promptTokens;
        state.tokenStats.managerCompletionTokens += completionTokens;
      } else {
        state.tokenStats.playerPromptTokens += promptTokens;
        state.tokenStats.playerCompletionTokens += completionTokens;
      }
      state.tokenStats.totalTokens += promptTokens + completionTokens;

      const roleTag = isManager ? 'MANAGER' : 'JOUEUR';
      console.log(`[TOKENS 📊] ${roleTag}: ${promptTokens} in / ${completionTokens} out | Total session: ${state.tokenStats.totalTokens}`);
    }

    const raw = (data.response || data.thinking || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.warn("Ollama response without valid JSON :", raw.slice(0, 200));
      return null;
    }
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    console.warn("Error communicating with Ollama :", error.message);
    return null;
  }
}

module.exports = { askOllama, getFormatSchema, PLAYER_JSON_SCHEMA, MANAGER_JSON_SCHEMA };
