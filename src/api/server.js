const http = require('node:http');
const crypto = require('node:crypto');
const { buildSnapshot } = require('./snapshot');

/**
 * Compare a provided API key with the expected one without leaking timing information
 * @param {string|undefined} provided Key sent by the client
 * @param {string} expected Configured key
 * @returns {boolean} True when both keys match
 */
function isValidKey(provided, expected) {
  if (typeof provided !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Send a JSON response
 * @param {http.ServerResponse} res Node response
 * @param {number} status HTTP status code
 * @param {object} body Serializable payload
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

/**
 * Create the read-only status API of the bot. It exposes GET /status (protected by the X-API-Key header)
 * and GET /health (public, no bot data).
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {{ apiKey: string, startedAt?: number }} options API key and process start timestamp
 * @returns {http.Server} Server, not yet listening
 */
function createStatusServer(bot, state, { apiKey, startedAt = Date.now() }) {
  return http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    if (path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path !== '/status') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (!isValidKey(req.headers['x-api-key'], apiKey)) {
      sendJson(res, 401, { error: 'Invalid or missing API key' });
      return;
    }
    try {
      sendJson(res, 200, buildSnapshot(bot, state, { startedAt }));
    } catch (error) {
      console.warn('[API] Failed to build status snapshot:', error.message);
      sendJson(res, 500, { error: 'Failed to build status' });
    }
  });
}

/**
 * Start the status API when it is configured. Nothing is exposed without both a port and an API key.
 * @param {object} bot Mineflayer bot instance
 * @param {object} state Global bot state
 * @param {{ port: number, host: string, apiKey: string }} options API settings from the configuration
 * @returns {http.Server|null} Listening server, or null when the API is disabled
 */
function startStatusApi(bot, state, { port, host, apiKey }) {
  if (!port) return null;
  if (!apiKey) {
    console.warn('[API] BOT_API_PORT is set but BOT_API_KEY is empty: status API not started.');
    return null;
  }
  const server = createStatusServer(bot, state, { apiKey });
  server.on('error', error => console.warn('[API] Status API error:', error.message));
  server.listen(port, host, () => console.log(`📡 Status API listening on ${host}:${port}`));
  return server;
}

module.exports = { createStatusServer, startStatusApi, isValidKey };
