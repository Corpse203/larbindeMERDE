// index.mjs
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';

const {
  DLIVE_CLIENT_ID,
  DLIVE_CLIENT_SECRET,
  DLIVE_REDIRECT_URI,                    // ⚠️ mettre https://skrymi.com
  DLIVE_TARGET_DISPLAYNAME = 'skrymi',
  DLIVE_MESSAGE = 'Hello depuis MrLarbin (user token)',
  PORT = 3000,
} = process.env;

const app = express();

const OAUTH_AUTHORIZE = 'https://dlive.tv/o/authorize';
const OAUTH_TOKEN = 'https://dlive.tv/o/token';
const GQL = 'https://graphigo.prd.dlive.tv/';

// ===== Tokens en mémoire (persiste-les plus tard en DB si tu veux) =====
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
    redirect_uri: DLIVE_REDIRECT_URI,   // doit correspondre EXACTEMENT à ce qui est enregistré chez DLive
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

async function gqlUser(query, variables) {
  const token = await refreshUserTokenIfNeeded();
  const resp = await fetch(GQL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
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

// ========= Mutation d’envoi (selon ton schéma: streamer, message, roomRole, subscribing) =========
async function sendStreamchatMessage({ to, message, role = 'Member', subscribing = false }) {
  const mutation = `
    mutation SendChat($input: SendStreamchatMessageInput!) {
      sendStreamchatMessage(input: $input) { __typename }
    }
  `;
  const input = {
    streamer: to,
    message,
    roomRole: role,          // ENUM: Member | Moderator | Owner
    subscribing             // Boolean!
  };
  const data = await gqlUser(mutation, { input });
  return { ok: true, inputUsed: input, result: data.sendStreamchatMessage };
}

// ===================== ROUTES =====================

// 1) RACINE = Healthcheck + Gestion du redirect ?code=... (comme demandé par DLive)
app.get('/', async (req, res) => {
  // Si pas de code → healthcheck simple
  if (!req.query.code) {
    return res.status(200).send('OK - user-token mode (root redirect)'); 
  }

  // Si on reçoit ?code=... → on termine l’OAuth ici
  try {
    const code = req.query.code.toString();

    // On lit state si présent (sinon message/target par défaut)
    let wanted = { m: DLIVE_MESSAGE, t: DLIVE_TARGET_DISPLAYNAME, r: 'Member', s: false };
    if (req.query.state) {
      try {
        // Si tu utilises un state JSON encodé en base64url, décode-le ici.
        // Par défaut, DLive renvoie juste la chaîne fournie. Ce bloc tente un parse "au cas où".
        const raw = req.query.state.toString();
        const maybe = Buffer.from(raw, 'base64url').toString('utf8');
        wanted = { ...wanted, ...JSON.parse(maybe) };
      } catch {
        // Pas grave si state n’est pas un JSON base64url
      }
    }

    await exchangeCodeForToken(code);
    const result = await sendStreamchatMessage({
      to: wanted.t,
      message: wanted.m,
      role: wanted.r || 'Member',
      subscribing: wanted.s === true
    });

    res
      .status(200)
      .send(
        `OAuth OK via / (root). Jeton reçu et utilisé.<br>` +
        `<h3>Message:</h3><pre>${JSON.stringify(result, null, 2)}</pre>`
      );
  } catch (e) {
    res.status(500).send('Erreur callback (root): ' + e.message);
  }
});

// 2) Démarrer l’OAuth (utile si tu veux un bouton “Login with DLive”)
app.get('/auth/start', (req, res) => {
  // On peut encoder un petit JSON en base64url dans state pour transporter un message test
  const stateObj = {
    m: req.query.message || DLIVE_MESSAGE,
    t: req.query.to || DLIVE_TARGET_DISPLAYNAME,
    r: 'Member',
    s: false,
    ts: Date.now()
  };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

  const params = new URLSearchParams({
    client_id: DLIVE_CLIENT_ID,
    redirect_uri: DLIVE_REDIRECT_URI,        // ⚠️ https://skrymi.com (exact)
    response_type: 'code',
    scope: 'identity chat:write',
    state
  });

  res.redirect(`${OAUTH_AUTHORIZE}?${params.toString()}`);
});

// 3) Envoi d’un message (après avoir fait l’OAuth une fois)
app.get('/send', async (req, res) => {
  try {
    const message = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();
    const to = (req.query.to || DLIVE_TARGET_DISPLAYNAME).toString();
    const role = (req.query.role || 'Member').toString();   // Member/Moderator/Owner
    const subscribing = (req.query.subscribing === 'true' || req.query.subscribing === '1');

    const result = await sendStreamchatMessage({ to, message, role, subscribing });
    res.status(200).send(`Message envoyé (user token).<pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send('Erreur envoi: ' + e.message);
  }
});

app.listen(PORT, () => console.log('Server started on port', PORT));
