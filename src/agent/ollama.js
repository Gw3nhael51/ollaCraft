const config = require('../infrastructure/config');
const state = require('../core/state');

// The reasoning text is length-bounded by the schema itself: an unbounded "thought" used to hit the token
// cap mid-sentence, cutting the JSON before its action and closing brace
const THOUGHT_MAX_LENGTH = 320;
const DIRECTIVE_MAX_LENGTH = 220;

const PLAYER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', maxLength: THOUGHT_MAX_LENGTH },
    action: {
      type: 'string',
      enum: Array.from(config.VALID_ACTIONS)
    },
    target: { type: 'string', maxLength: 32 },
    qty: { type: 'integer', minimum: 1, maximum: 64 }
  },
  required: ['thought', 'action', 'target']
};

const MANAGER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', maxLength: THOUGHT_MAX_LENGTH },
    directive: { type: 'string', maxLength: DIRECTIVE_MAX_LENGTH },
    suggestedAction: {
      type: 'string',
      enum: Array.from(config.VALID_ACTIONS)
    },
    suggestedTarget: { type: 'string', maxLength: 32 }
  },
  required: ['thought', 'directive', 'suggestedAction', 'suggestedTarget']
};

/**
 * Sélectionner le schéma de sortie structurée selon le rôle de l'agent
 * @param {string} role Rôle de l'appelant ('joueur' ou 'manager')
 * @returns {object} Schéma JSON strict
 */
function getFormatSchema(role) {
  return role === 'manager' ? MANAGER_JSON_SCHEMA : PLAYER_JSON_SCHEMA;
}

/**
 * Enregistrer la consommation de tokens de la requête dans les statistiques globales
 * @param {object} data Réponse brute de l'API Ollama
 * @param {string} role Rôle de l'agent ('joueur' ou 'manager')
 */
function recordTokenUsage(data, role) {
  if (!state?.tokenStats) return;

  const promptTokens = data.prompt_eval_count || 0;
  const completionTokens = data.eval_count || 0;
  const isManager = role === 'manager';

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

/**
 * Interroger le modèle Ollama local pour obtenir une décision JSON structurée
 * @param {string} promptText Prompt complet envoyé au modèle
 * @param {string} [modelName] Nom du modèle Ollama cible
 * @param {string} [role] Rôle de l'appelant ('joueur' ou 'manager')
 * @param {object} [options={}] Options d'inférence
 * @param {number} [options.temperature=0.1] Température d'échantillonnage (augmentée quand le bot stagne)
 * @returns {Promise<object|null>} Décision JSON analysée ou null en cas d'échec
 */
async function askOllama(promptText, modelName = config.OLLAMA_MODEL_PLAYER, role = 'joueur', options = {}) {
  try {
    const host = config.OLLAMA_HOST || 'http://localhost:11434';
    const temperature = Number.isFinite(options.temperature) ? Math.min(1, Math.max(0, options.temperature)) : 0.1;
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
        keep_alive: config.OLLAMA_KEEP_ALIVE,
        options: {
          temperature,
          num_ctx: config.OLLAMA_NUM_CTX,
          num_predict: config.OLLAMA_NUM_PREDICT
        }
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error("Ollama API error :", data.error);
      return null;
    }

    recordTokenUsage(data, role);

    const raw = (data.response || data.thinking || '').trim();
    const parsed = parseModelJson(raw);
    if (!parsed) {
      console.warn("Ollama response without valid JSON :", raw.slice(0, 200));
    }
    return parsed;
  } catch (error) {
    console.warn("Error communicating with Ollama :", error.message);
    return null;
  }
}

/**
 * Read one string field out of a JSON text that may be cut before its end
 * @param {string} raw Raw model output
 * @param {string} field Field name
 * @returns {string|null} Field value or null when absent or itself cut
 */
function extractStringField(raw, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
  return match ? match[1] : null;
}

/**
 * Parse the model's JSON answer, salvaging the decision fields when the output was cut before the closing brace
 * @param {string} raw Raw model output
 * @returns {object|null} Parsed decision, a partial decision recovered from truncated JSON, or null
 */
function parseModelJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // Fall through to the field-by-field salvage below
    }
  }

  // Truncated or malformed output: a complete "action" (or "suggestedAction") is enough to act on
  const action = extractStringField(raw, 'action');
  if (action) {
    const qtyMatch = /"qty"\s*:\s*(\d+)/.exec(raw);
    return {
      thought: extractStringField(raw, 'thought') || '',
      action,
      target: extractStringField(raw, 'target') || 'none',
      ...(qtyMatch ? { qty: Number.parseInt(qtyMatch[1], 10) } : {})
    };
  }
  const suggestedAction = extractStringField(raw, 'suggestedAction');
  if (suggestedAction) {
    return {
      thought: extractStringField(raw, 'thought') || '',
      directive: extractStringField(raw, 'directive') || '',
      suggestedAction,
      suggestedTarget: extractStringField(raw, 'suggestedTarget') || 'none'
    };
  }
  return null;
}

module.exports = { askOllama, getFormatSchema, parseModelJson, PLAYER_JSON_SCHEMA, MANAGER_JSON_SCHEMA };
