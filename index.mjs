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

// ===== Tokens en mémoire (à persister plus tard) =====
let userAccessToken = null;
let userRefreshToken = null;
let userTokenExpAt = 0;
let lastTokenPayload = null; // pour debug complet

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
  lastTokenPayload = json; // <-- garde tout pour /debug/token
  userAccessToken = json.access_token || null;
  userRefreshToken = json.refresh_token || null;
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;
  if (!userAccessToken) throw new Error(`No access_token in response: ${text}`);
  return json;
}

async function refreshUserTokenIfNeeded() {
  const now = Date.now();
  if (userAccessToken && now < userTokenExpAt - 10000) return userAccessToken;
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
  lastTokenPayload = json; // update debug
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

// ==== Helpers schéma = valeurs RoomRole (Member/Moderator/Owner) ====
const TypeRef = `
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}`;
function unwrap(t){ let c=t; while(c && !c.name && c.ofType) c=c.ofType; return c||t; }

async function getType(name) {
  const q = `
    ${TypeRef}
    query($name:String!){ __type(name:$name){ kind name inputFields{ name type{...TypeRef} } enumValues{ name } } }
  `;
  const data = await gqlUser(q, { name });
  return data.__type;
}

async function buildSendInput({ to, message }) {
  // On ne redemande pas tout le schéma : on sait déjà ce qui marche chez toi
  const enumType = await getType('RoomRole');
  const values = (enumType.enumValues || []).map(v => v.name);
  const roomRole = values.includes('Member') ? 'Member' : (values[0] || 'Member');

  return {
    streamer: to,
    message,
    roomRole,        // Member par défaut
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
  return { ok:true, inputUsed: input, result: data.sendStreamchatMessage };
}

// ================= ROUTES =================
app.get('/', (_req, res) => res.send('OK - user-token mode (debug)'));

// 0) Debug: voir le dernier payload token reçu/rafraîchi
app.get('/debug/token', (_req, res) => {
  res.type('json').send(lastTokenPayload || { info: 'aucun token encore' });
});

// 0bis) Debug: ping GraphQL avec une requête triviale (pas de mutation)
app.get('/debug/ping', async (_req, res) => {
  try {
    const data = await gqlUser('query { __typename }', {});
    res.type('json').send({ ok:true, data });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// 1) Démarrer OAuth (avec le COMPTE BOT)
app.get('/auth/start', (req, res) => {
  const state = Buffer.from(JSON.stringify({
    m: req.query.message || DLIVE_MESSAGE,
    t: req.query.to || DLIVE_TARGET_DISPLAYNAME,
    ts: Date.now()
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

// 2) Callback → échange code → tente de parler
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    let wanted = { m: DLIVE_MESSAGE, t: DLIVE_TARGET_DISPLAYNAME };
    if (state) {
      try { wanted = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')); } catch {}
    }

    const tok = await exchangeCodeForToken(code.toString());

    // Affiche le token et les scopes pour vérifier que "chat:write" est bien présent
    const tokenView = { ...tok, access_token: tok.access_token ? '***' : null, refresh_token: tok.refresh_token ? '***' : null };

    // Test simple GraphQL (doit réussir si le token est bon)
    await gqlUser('query { __typename }', {});

    // Puis envoi du message
    const result = await sendStreamchatMessage({ to: wanted.t, message: wanted.m });

    res.status(200).send(
      'OK callback — token reçu et utilisé.<br/>' +
      `<h3>Token (sanitizé):</h3><pre>${JSON.stringify(tokenView, null, 2)}</pre>` +
      `<h3>Résultat envoi:</h3><pre>${JSON.stringify(result, null, 2)}</pre>`
    );
  } catch (e) {
    res.status(500).send('Erreur callback: ' + e.message);
  }
});

// 3) Envoi avec token déjà stocké/rafraîchi
app.get('/send', async (req, res) => {
  try {
    const message = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();
    const to = (req.query.to || DLIVE_TARGET_DISPLAYNAME).toString();
    const result = await sendStreamchatMessage({ to, message });
    res.status(200).send(`Message envoyé (user token).<pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send('Erreur envoi: ' + e.message);
  }
});

app.listen(PORT, () => console.log('Server started on port', PORT));
