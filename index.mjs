import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

const {
  DLIVE_CLIENT_ID,
  DLIVE_CLIENT_SECRET,
  DLIVE_TARGET_DISPLAYNAME = 'skrymi',
  DLIVE_MESSAGE = 'Hello depuis MrLarbin (app token)',
  PORT = 3000,
} = process.env;

if (!DLIVE_CLIENT_ID || !DLIVE_CLIENT_SECRET) {
  console.warn('⚠️ Missing env: DLIVE_CLIENT_ID et/ou DLIVE_CLIENT_SECRET');
}

const app = express();

// Cache en mémoire pour l'app access token
let appToken = null;
let appTokenExpiresAt = 0; // timestamp ms

async function getAppToken() {
  const now = Date.now();
  if (appToken && now < appTokenExpiresAt - 10_000) {
    return appToken;
  }
  const basic = Buffer.from(`${DLIVE_CLIENT_ID}:${DLIVE_CLIENT_SECRET}`).toString('base64');
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'chat:write'
  });

  const resp = await fetch('https://dlive.tv/o/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Token (client_credentials) failed: ${resp.status} ${text}`);
  }

  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`Token response not JSON: ${text}`);
  }
  if (!json.access_token) {
    throw new Error(`No access_token. Raw: ${text}`);
  }
  appToken = json.access_token;
  const expiresIn = Number(json.expires_in || 3600);
  appTokenExpiresAt = Date.now() + expiresIn * 1000;
  return appToken;
}

async function sendChatMessageWithAppToken({ streamer, message }) {
  const token = await getAppToken();
  const GQL = 'https://graphigo.prd.dlive.tv/';

  // ⚠️ Le nom exact de la mutation peut varier selon le schéma.
  // On commence avec sendChatMessage(streamer, message).
  const mutation = `
    mutation SendChat($streamer: String!, $message: String!) {
      sendChatMessage(streamer: $streamer, message: $message) {
        id
        content
        createdAt
      }
    }
  `;

  const resp = await fetch(GQL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: mutation,
      variables: { streamer, message }
    })
  });

  const body = await resp.text();
  let data = {};
  try { data = JSON.parse(body); } catch {}
  if (!resp.ok || data.errors) {
    throw new Error(`GraphQL error: ${resp.status} ${body}`);
  }
  return data.data.sendChatMessage;
}

// Healthcheck
app.get('/', (_req, res) => {
  res.status(200).send('OK - MrLarbin app-token mode');
});

// Test: obtenir un app token (sans login)
app.get('/token/app', async (_req, res) => {
  try {
    const token = await getAppToken();
    res.type('json').send({ access_token: token, expires_at: appTokenExpiresAt });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Envoyer un message sans login: /send-app?msg=Hello&to=skrymi
app.get('/send-app', async (req, res) => {
  try {
    const message = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();
    const to = (req.query.to || DLIVE_TARGET_DISPLAYNAME).toString();
    const streamer = to.toLowerCase();
    const result = await sendChatMessageWithAppToken({ streamer, message });
    res.status(200).send(`Message envoyé à ${streamer} (app token).<pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send(`Erreur envoi (app token): ${e.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MrLarbin app-token server on http://0.0.0.0:${PORT}`);
});
