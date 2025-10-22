import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

const {
  DLIVE_CLIENT_ID,
  DLIVE_CLIENT_SECRET,
  DLIVE_REDIRECT_URI,                  // ⚠️ ex: https://skrymi.com
  DLIVE_TARGET_USERNAME = 'skrymi',    // ⚠️ "username" (pas displayname)
  DLIVE_MESSAGE = 'Hello depuis MrLarbin',
  PORT = 3000,
} = process.env;

const app = express();
const OAUTH_AUTHORIZE = 'https://dlive.tv/o/authorize';
const OAUTH_TOKEN = 'https://dlive.tv/o/token';
const GQL = 'https://graphigo.prd.dlive.tv/';

// ===== Tokens en mémoire (persiste en DB si besoin) =====
let userAccessToken = null;
let userRefreshToken = null;
let userTokenExpAt = 0; // timestamp ms

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
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: form.toString()
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  const json = JSON.parse(text);

  userAccessToken = json.access_token || null;
  userRefreshToken = json.refresh_token || null;
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;

  if (!userAccessToken) throw new Error(`No access_token in response: ${text}`);
  return json;
}

async function refreshUserTokenIfNeeded() {
  const now = Date.now();
  if (userAccessToken && now < userTokenExpAt - 10_000) return userAccessToken;
  if (!userRefreshToken) throw new Error('No refresh_token; relance /auth/start');

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: userRefreshToken
  });

  const resp = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: form.toString()
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Refresh failed: ${resp.status} ${text}`);

  const json = JSON.parse(text);
  userAccessToken = json.access_token || userAccessToken;
  if (json.refresh_token) userRefreshToken = json.refresh_token;
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;

  return userAccessToken;
}

// ========= Appel GraphQL =========
// ⚠️ Très important: DLive attend l'Authorization = <ACCESS_TOKEN> (sans "Bearer ")
// Réf. leurs docs et exemples cURL. :contentReference[oaicite:2]{index=2} :contentReference[oaicite:3]{index=3}
async function gqlUser(query, variables) {
  const token = await refreshUserTokenIfNeeded();
  const resp = await fetch(GQL, {
    method: 'POST',
    headers: {
      'Authorization': token,              // <-- pas de "Bearer "
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const body = await resp.text();
  let data = {};
  try { data = JSON.parse(body); } catch {}

  if (!resp.ok || data.errors) {
    throw new Error(`GraphQL error: ${resp.status} ${body}`);
  }
  return data.data;
}

// ========= Mutation d’envoi (selon leurs docs) =========
// Input: streamer (username), message, roomRole (Member/Moderator/Owner), subscribing (Boolean)
async function sendStreamchatMessage({ to, message, role = 'Member', subscribing = false }) {
  const mutation = `
    mutation SendMsg($input: SendStreamchatMessageInput!) {
      sendStreamchatMessage(input: $input) { message { __typename } err { code message } }
    }
  `;
  // ⚠️ "streamer" = username (pas displayname). Docs l’indiquent. :contentReference[oaicite:4]{index=4}
  const input = { streamer: to, message, roomRole: role, subscribing };
  const data = await gqlUser(mutation, { input });
  return { ok: true, inputUsed: input, result: data.sendStreamchatMessage };
}

// ===================== ROUTES =====================

// Racine = healthcheck + gestion du redirect ?code=... (DLive t’a demandé redirect_uri = https://skrymi.com)
app.get('/', async (req, res) => {
  if (!req.query.code) {
    return res.status(200).send('OK - DLive user-token (root redirect) [Authorization header = raw token]');
  }
  try {
    const code = req.query.code.toString();

    // si tu utilises un "state" JSON encodé en base64url
    let wanted = { m: DLIVE_MESSAGE, t: DLIVE_TARGET_USERNAME, r: 'Member', s: false };
    if (req.query.state) {
      try {
        const raw = req.query.state.toString();
        const maybe = Buffer.from(raw, 'base64url').toString('utf8');
        wanted = { ...wanted, ...JSON.parse(maybe) };
      } catch {}
    }

    await exchangeCodeForToken(code);
    const result = await sendStreamchatMessage({
      to: wanted.t, message: wanted.m, role: wanted.r || 'Member', subscribing: !!wanted.s
    });

    res.status(200).send(
      `OAuth OK (root).<br>` +
      `<h3>Résultat envoi</h3><pre>${JSON.stringify(result, null, 2)}</pre>`
    );
  } catch (e) {
    res.status(500).send('Erreur callback (root): ' + e.message);
  }
});

// Optionnel: démarreur d’OAuth (si tu veux éviter de coller l’URL à la main)
app.get('/auth/start', (req, res) => {
  const stateObj = {
    m: req.query.message || DLIVE_MESSAGE,
    t: req.query.to || DLIVE_TARGET_USERNAME,
    r: 'Member',
    s: false,
    ts: Date.now()
  };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

  const params = new URLSearchParams({
    client_id: DLIVE_CLIENT_ID,
    redirect_uri: DLIVE_REDIRECT_URI,  // ex. https://skrymi.com
    response_type: 'code',
    scope: 'identity chat:write',
    state
  });

  res.redirect(`${OAUTH_AUTHORIZE}?${params.toString()}`);
});

// Envoi (après OAuth)
app.get('/send', async (req, res) => {
  try {
    const msg = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();
    const to = (req.query.to || DLIVE_TARGET_USERNAME).toString();
    const role = (req.query.role || 'Member').toString();   // Member/Moderator/Owner
    const subscribing = (req.query.subscribing === 'true' || req.query.subscribing === '1');

    const result = await sendStreamchatMessage({ to, message: msg, role, subscribing });
    res.status(200).send(`Message envoyé.<pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send('Erreur envoi: ' + e.message);
  }
});

app.listen(PORT, () => console.log('Server started on port', PORT));
