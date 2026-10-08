async function askOllama(promptText) {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.1',
        prompt: promptText,
        stream: false,
        format: 'json'
      })
    });

    const data = await response.json();
    return JSON.parse(data.response);
  } catch (error) {
    console.warn("Erreur avec Ollama :", error.message);
    return null;
  }
}

module.exports = { askOllama };
