import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { createClient as createWsClient } from 'graphql-ws';
import WebSocket from 'ws'; // ✅ nécessaire pour Node

// === ENV ===
const {
  DLIVE_CLIENT_ID,
  DLIVE_CLIENT_SECRET,
  DLIVE_REDIRECT_URI,
  DLIVE_TARGET_USERNAME = 'skrymi',
  PORT = 10000,

  ENABLE_CHAT_LISTENER = 'true',
  DLIVE_WS = 'wss://graphigostream.prd.dlive.tv/',

  ADMIN_PASSWORD = 'change-me',

  DISCORD_URL = 'https://discord.gg/ton-invite',
  YT_URL = 'https://youtube.com/@ton-chaine',
  TWITTER_URL = 'https://twitter.com/toncompte',

  DLIVE_USER_REFRESH_TOKEN = '',
  COMMANDS_JSON = '',
  CHAT_SUB_FIELD,
  CHAT_SUB_ARG,
} = process.env;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const OAUTH_AUTHORIZE = 'https://dlive.tv/o/authorize';
const OAUTH_TOKEN = 'https://dlive.tv/o/token';
const GQL_HTTP = 'https://graphigo.prd.dlive.tv/';

// === Tokens ===
let userAccessToken = null;
let userRefreshToken = DLIVE_USER_REFRESH_TOKEN || null;
let userTokenExpAt = 0;

// === Commandes ===
function loadCommandsFromEnv() {
  if (!COMMANDS_JSON) {
    return {
      "!coucou": "Bonjour maitre supreme Browkse, le roi du dev DLive qui a réussi à me créer",
      "!discord": `Le discord est : ${DISCORD_URL}`,
      "!yt": `YouTube : ${YT_URL}`,
      "!youtube": `YouTube : ${YT_URL}`,
      "!tw": `Twitter : ${TWITTER_URL}`,
      "!twitter": `Twitter : ${TWITTER_URL}`,
      "!x": `Twitter : ${TWITTER_URL}`,
      "!help": "Commandes: !coucou, !discord, !yt, !twitter"
    };
  }
  try { return JSON.parse(COMMANDS_JSON); } catch { return {}; }
}
let COMMANDS = loadCommandsFromEnv();

function resolveCommand(cmdRaw = '') {
  const key = String(cmdRaw || '').trim();
  if (!key.startsWith('!')) return null;
  return COMMANDS[key] ?? COMMANDS[key.toLowerCase()] ?? null;
}

// === OAuth ===
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
  return json;
}

async function refreshUserTokenIfNeeded() {
  const now = Date.now();
  if (userAccessToken && now < userTokenExpAt - 10_000) return userAccessToken;
  if (!userRefreshToken) throw new Error('No refresh_token; colle-le dans DLIVE_USER_REFRESH_TOKEN puis restart.');

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
  if (resp.status === 401 || /invalid_grant/i.test(text)) {
    userAccessToken = null;
    userRefreshToken = null;
    userTokenExpAt = 0;
    throw new Error(
      'Refresh failed: invalid_grant. Refaire /auth/start, puis copier le nouveau refresh_token dans DLIVE_USER_REFRESH_TOKEN (Render → Environment).'
    );
  }
  if (!resp.ok) throw new Error(`Refresh failed: ${resp.status} ${text}`);

  const json = JSON.parse(text);
  userAccessToken = json.access_token || userAccessToken;
  if (json.refresh_token) userRefreshToken = json.refresh_token;
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;
  return userAccessToken;
}

// === GraphQL ===
async function gqlHttp(query, variables) {
  const token = await refreshUserTokenIfNeeded();
  const resp = await fetch(GQL_HTTP, {
    method: 'POST',
    headers: {
      'Authorization': token, // pas de Bearer
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await resp.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!resp.ok || data.errors) throw new Error(`GraphQL error: ${resp.status} ${text}`);
  return data.data;
}

async function sendStreamchatMessage({ to, message, role = 'Member', subscribing = false }) {
  const mutation = `
    mutation SendMsg($input: SendStreamchatMessageInput!) {
      sendStreamchatMessage(input: $input) { message { __typename } err { code message } }
    }
  `;
  const input = { streamer: to, message, roomRole: role, subscribing };
  const data = await gqlHttp(mutation, { input });
  return { ok: true, inputUsed: input, result: data.sendStreamchatMessage };
}

// === WebSocket Listener ===
let wsClient = null;
let wsRunning = false;

async function ensureWsClient() {
  const token = await refreshUserTokenIfNeeded();
  wsClient = createWsClient({
    url: DLIVE_WS,
    webSocketImpl: WebSocket, // ✅ nécessaire pour Node
    connectionParams: { Authorization: token },
    keepAlive: 15000
  });
  return wsClient;
}

async function pickChatSubscriptionField() {
  if (CHAT_SUB_FIELD && CHAT_SUB_ARG) {
    console.log(`🔧 Subscription override: ${CHAT_SUB_FIELD}(${CHAT_SUB_ARG}:String!)`);
    return { fieldName: CHAT_SUB_FIELD, argName: CHAT_SUB_ARG };
  }
  throw new Error('No chat-like subscription field found (define CHAT_SUB_FIELD and CHAT_SUB_ARG in env)');
}

async function startChatListener(streamerUsername) {
  if (wsRunning) return;
  wsRunning = true;

  const { fieldName, argName } = await pickChatSubscriptionField();
  const query = `
    subscription OnChat($target: String!) {
      ${fieldName}(${argName}: $target) {
        __typename
        content
        message
        text
        body
        sender { username displayname }
        user { username displayname }
      }
    }`;

  const client = await ensureWsClient();
  client.subscribe(
    { query, variables: { target: streamerUsername } },
    {
      next: async (payload) => {
        try {
          const d = payload?.data?.[fieldName];
          const txt = d?.content || d?.message || d?.text || d?.body || '';
          if (!txt.startsWith('!')) return;
          const reply = resolveCommand(txt);
          if (reply) await sendStreamchatMessage({ to: streamerUsername, message: reply });
        } catch (e) { console.error('WS next:', e.message); }
      },
      error: (err) => { console.error('WS error:', err); wsRunning = false; },
      complete: () => { console.log('WS complete'); wsRunning = false; }
    }
  );

  console.log(`👂 Listener ON via ${fieldName}(${argName}:"${streamerUsername}")`);
}

// === ROUTES ===
app.get('/', async (req, res) => {
  if (!req.query.code)
    return res.status(200).send('OK - ready (auth/start once)');
  try {
    const tok = await exchangeCodeForToken(req.query.code);
    res.status(200).send(`<pre>${JSON.stringify(tok, null, 2)}</pre><p>Copie le refresh_token dans DLIVE_USER_REFRESH_TOKEN et Restart.</p>`);
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/auth/start', (req, res) => {
  const params = new URLSearchParams({
    client_id: DLIVE_CLIENT_ID,
    redirect_uri: DLIVE_REDIRECT_URI,
    response_type: 'code',
    scope: 'identity chat:write'
  });
  res.redirect(`${OAUTH_AUTHORIZE}?${params}`);
});

app.get('/send', async (req, res) => {
  try {
    const msg = (req.query.msg || 'ping').toString();
    const r = await sendStreamchatMessage({ to: DLIVE_TARGET_USERNAME, message: msg });
    res.status(200).send(`<pre>${JSON.stringify(r, null, 2)}</pre>`);
  } catch (e) { res.status(500).send(e.message); }
});

// === /cmd ===
app.get('/cmd', async (req, res) => {
  try {
    const to = (req.query.to || DLIVE_TARGET_USERNAME).toString();
    const cmd = (req.query.c || req.query.cmd || '').toString();
    if (!cmd) return res.status(400).send('Manque ?c= !ex: /cmd?c=!coucou');
    const reply = resolveCommand(cmd);
    if (!reply) return res.status(400).send('Commande inconnue');
    const r = await sendStreamchatMessage({ to, message: reply });
    res.status(200).send(`<pre>${JSON.stringify(r, null, 2)}</pre>`);
  } catch (e) { res.status(500).send(e.message); }
});

// === ADMIN ===
function requireAdmin(req, res, next) {
  const pass = req.query.key || req.body?.key;
  if (pass === ADMIN_PASSWORD) return next();
  res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_PASSWORD');
}

app.get('/admin', requireAdmin, (req, res) => {
  const rows = Object.entries(COMMANDS).map(([k,v]) =>
    `<tr><td><input name="k" value="${k}"/></td><td><input name="v" value="${v}"/></td></tr>`
  ).join('');
  res.send(`
    <h2>Admin commandes</h2>
    <form method="POST" action="/admin/commands?key=${encodeURIComponent(ADMIN_PASSWORD)}">
      <table>${rows}</table><button type="submit">Sauvegarder</button>
    </form>
  `);
});

app.post('/admin/commands', requireAdmin, (req, res) => {
  const { k, v } = req.body;
  const map = {};
  if (Array.isArray(k) && Array.isArray(v)) k.forEach((key,i)=>map[k[i]]=v[i]);
  COMMANDS = { ...COMMANDS, ...map };
  res.redirect(`/admin?key=${encodeURIComponent(ADMIN_PASSWORD)}`);
});

app.listen(PORT, () => {
  console.log('Server started on port', PORT);
  if (userRefreshToken && ENABLE_CHAT_LISTENER === 'true') {
    startChatListener(DLIVE_TARGET_USERNAME).catch(e=>console.error('Listener error (boot):', e.message));
  }
});
