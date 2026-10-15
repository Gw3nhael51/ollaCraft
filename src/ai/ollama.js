const config = require('../config');

/**
 * Query local Ollama model to obtain a structured JSON decision
 * @param {string} promptText Full prompt sent to the model
 * @param {string} [modelName] Name of target Ollama model
 * @returns {Promise<object|null>} Parsed JSON decision or null on failure
 */
async function askOllama(promptText, modelName = config.OLLAMA_MODEL_PLAYER) {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: modelName,
        prompt: promptText,
        stream: false,
        format: 'json',
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

module.exports = { askOllama };
