import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

const {
  DLIVE_CLIENT_ID,
  DLIVE_CLIENT_SECRET,
  DLIVE_REDIRECT_URI,
  DLIVE_TARGET_DISPLAYNAME = 'skrymi',
  DLIVE_MESSAGE = 'Hello depuis MrLarbin (user token)',
  PORT = 3000,
} = process.env;

const app = express();
const OAUTH_AUTHORIZE = 'https://dlive.tv/o/authorize';
const OAUTH_TOKEN = 'https://dlive.tv/o/token';
const GQL = 'https://graphigo.prd.dlive.tv/';

// === Tokens en mémoire ===
let userAccessToken = null;
let userRefreshToken = null;
let userTokenExpAt = 0;

function basicAuthHeader() {
  const basic = Buffer.from(`${DLIVE_CLIENT_ID}:${DLIVE_CLIENT_SECRET}`).toString('base64');
  return `Basic ${basic}`;
}

async function exchangeCodeForToken(code) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: DLIVE_REDIRECT_URI,
    code
  });
  const resp = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const json = await resp.json();
  userAccessToken = json.access_token;
  userRefreshToken = json.refresh_token || userRefreshToken;
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;
}

async function refreshUserTokenIfNeeded() {
  const now = Date.now();
  if (userAccessToken && now < userTokenExpAt - 10000) return userAccessToken;
  if (!userRefreshToken) throw new Error("Pas de refresh_token, relance /auth/start");
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: userRefreshToken
  });
  const resp = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const json = await resp.json();
  userAccessToken = json.access_token;
  if (json.refresh_token) userRefreshToken = json.refresh_token;
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;
  return userAccessToken;
}

async function gqlUser(query, variables) {
  const token = await refreshUserTokenIfNeeded();
  const resp = await fetch(GQL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await resp.json();
  if (data.errors) throw new Error(JSON.stringify(data));
  return data.data;
}

// Construit l’input de sendStreamchatMessage
async function buildSendInput({ to, message }) {
  return {
    streamer: to,
    message,
    roomRole: "Member",
    subscribing: false
  };
}

async function sendStreamchatMessage({ to, message }) {
  const input = await buildSendInput({ to, message });
  const mutation = `
    mutation SendChat($input: SendStreamchatMessageInput!) {
      sendStreamchatMessage(input: $input) { __typename }
    }
  `;
  const data = await gqlUser(mutation, { input });
  return { ok: true, inputUsed: input, result: data.sendStreamchatMessage };
}

// === ROUTES ===
app.get('/', (_req, res) => res.send('OK - user-token mode (OAuth + refresh)'));

app.get('/auth/start', (req, res) => {
  const state = Buffer.from(JSON.stringify({
    m: req.query.message || DLIVE_MESSAGE,
    t: req.query.to || DLIVE_TARGET_DISPLAYNAME
  })).toString('base64url');
  const params = new URLSearchParams({
    client_id: DLIVE_CLIENT_ID,
    redirect_uri: DLIVE_REDIRECT_URI,
    response_type: 'code',
    scope: 'identity chat:write',
    state
  });
  res.redirect(`${OAUTH_AUTHORIZE}?${params.toString()}`);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    await exchangeCodeForToken(code.toString());
    const wanted = state ? JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) : {};
    const result = await sendStreamchatMessage({ to: wanted.t || DLIVE_TARGET_DISPLAYNAME, message: wanted.m || DLIVE_MESSAGE });
    res.send(`Message envoyé: <pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send("Erreur callback: " + e.message);
  }
});

app.get('/send', async (req, res) => {
  try {
    const msg = req.query.msg || DLIVE_MESSAGE;
    const to = req.query.to || DLIVE_TARGET_DISPLAYNAME;
    const result = await sendStreamchatMessage({ to, message: msg });
    res.send(`Message envoyé: <pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send("Erreur envoi: " + e.message);
  }
});

app.listen(PORT, () => console.log("Server started on port", PORT));
