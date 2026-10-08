const config = require('../config');

async function askOllama(promptText) {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL || 'llama3.1',
        prompt: promptText,
        stream: false,
        format: 'json',
        think: false,
        options: {
          temperature: 0.1 // Température très basse pour un agent plus logique
        }
      })
    });

    const data = await response.json();
    
    if (data.error) {
      console.error("Erreur de l'API Ollama :", data.error);
      return null;
    }

    // Récupérer : Lire la réponse ou le champ thinking des modèles qui raisonnent
    const raw = (data.response || data.thinking || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.warn("Réponse Ollama sans JSON :", raw.slice(0, 200));
      return null;
    }
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    console.warn("Erreur avec Ollama :", error.message);
    return null;
  }
}

module.exports = { askOllama };
