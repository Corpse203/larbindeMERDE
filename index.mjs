import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import axios from 'axios';
import pg from 'pg';

// ========= ENV =========
const {
  DLIVE_CLIENT_ID,
  DLIVE_CLIENT_SECRET,
  DLIVE_REDIRECT_URI,                // ICI: https://skrymi.com (racine)
  DLIVE_TARGET_USERNAME = 'skrymi',  // username exact pour ENVOYER
  DLIVE_CHANNEL = 'Skrymi',          // display name (pour ECOUTER, résolu en username)
  ADMIN_PASSWORD = 'change-me',
  ENABLE_CHAT_LISTENER = 'true',
  PORT = 10000,
  DATABASE_URL,                      // postgres://... (Render Postgres)
  // (optionnel) seed si DB vide au 1er boot
  DLIVE_USER_REFRESH_TOKEN = '',
  // Liens défaut pour commandes
  DISCORD_URL = 'https://discord.gg/ton-invite',
  YT_URL = 'https://youtube.com/@ton-chaine',
  TWITTER_URL = 'https://twitter.com/toncompte'
} = process.env;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL manquant (Render Postgres).');
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const OAUTH_AUTHORIZE = 'https://dlive.tv/o/authorize';
const OAUTH_TOKEN = 'https://dlive.tv/o/token';
const GQL_HTTP = 'https://graphigo.prd.dlive.tv/';

// ========= Postgres =========
const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id            text PRIMARY KEY,
      access_token  text,
      refresh_token text,
      expires_at_ms bigint
    );
  `);
  await pool.query(`
    INSERT INTO oauth_tokens (id) VALUES ('dlive_user')
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function loadTokensFromDB() {
  const { rows } = await pool.query(
    'SELECT access_token, refresh_token, expires_at_ms FROM oauth_tokens WHERE id=$1 LIMIT 1',
    ['dlive_user']
  );
  return rows[0] || null;
}

async function saveTokensToDB({ access_token, refresh_token, expires_at_ms }) {
  await pool.query(
    `UPDATE oauth_tokens
     SET access_token=$2, refresh_token=$3, expires_at_ms=$4
     WHERE id=$1`,
    ['dlive_user', access_token || null, refresh_token || null, Number(expires_at_ms) || 0]
  );
}

// ========= Tokens (mémoire) =========
let userAccessToken = null;
let userRefreshToken = null;
let userTokenExpAt = 0;

// ========= Commandes =========
let COMMANDS = {
  '!coucou': 'Bonjour maitre supreme Browkse, le roi du dev DLive qui a réussi à me créer',
  '!skrymi': "bonjour oh grand maitre qui possède un étron sauvage d'une taille gigantesque, comment va tu oh vénéré maitre de toute chose",
  '!discord': `Le discord est : ${DISCORD_URL}`,
  '!yt': `YouTube : ${YT_URL}`,
  '!youtube': `YouTube : ${YT_URL}`,
  '!tw': `Twitter : ${TWITTER_URL}`,
  '!twitter': `Twitter : ${TWITTER_URL}`,
  '!x': `Twitter : ${TWITTER_URL}`,
  '!help': 'Commandes: !coucou, !skrymi, !discord, !yt, !twitter'
};

function resolveCommand(cmdRaw = '') {
  const key = String(cmdRaw || '').trim();
  if (!key.startsWith('!')) return null;
  return COMMANDS[key] ?? COMMANDS[key.toLowerCase()] ?? null;
}

// ========= OAuth helpers =========
function basicAuthHeader() {
  const basic = Buffer.from(`${DLIVE_CLIENT_ID}:${DLIVE_CLIENT_SECRET}`).toString('base64');
  return `Basic ${basic}`;
}

async function bootLoadTokens() {
  await ensureSchema();
  const row = await loadTokensFromDB();
  if (row && (row.refresh_token || row.access_token)) {
    userAccessToken = row.access_token || null;
    userRefreshToken = row.refresh_token || null;
    userTokenExpAt = Number(row.expires_at_ms || 0);
    console.log('🔐 Tokens chargés depuis Postgres.');
    return;
  }
  if (DLIVE_USER_REFRESH_TOKEN) {
    userRefreshToken = DLIVE_USER_REFRESH_TOKEN;
    userAccessToken = null;
    userTokenExpAt = 0;
    await saveTokensToDB({ access_token: null, refresh_token: userRefreshToken, expires_at_ms: 0 });
    console.log('🪙 Seed refresh_token depuis env → sauvegardé en DB.');
  } else {
    console.log('ℹ️ Aucun token en DB. Lance /auth/start une fois pour initialiser.');
  }
}

async function exchangeCodeForToken(code) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: DLIVE_REDIRECT_URI, // = https://skrymi.com
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
  if (!resp.ok) {
    console.error('[oauth] exchange failed', resp.status, text);
    throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  }
  const json = JSON.parse(text);

  userAccessToken = json.access_token || null;
  userRefreshToken = json.refresh_token || null;
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;

  await saveTokensToDB({
    access_token: userAccessToken,
    refresh_token: userRefreshToken,
    expires_at_ms: userTokenExpAt
  });

  return json;
}

async function refreshUserTokenIfNeeded() {
  const now = Date.now();

  // Recharge depuis DB si mémoire vide
  if (!userRefreshToken) {
    const row = await loadTokensFromDB();
    userAccessToken = row?.access_token || null;
    userRefreshToken = row?.refresh_token || null;
    userTokenExpAt = Number(row?.expires_at_ms || 0);
  }

  if (userAccessToken && now < userTokenExpAt - 10_000) return userAccessToken;
  if (!userRefreshToken) throw new Error('No refresh_token; fais /auth/start pour initialiser.');

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
    console.error('[oauth] refresh invalid_grant', text);
    await saveTokensToDB({ access_token: null, refresh_token: null, expires_at_ms: 0 });
    userAccessToken = null;
    userRefreshToken = null;
    userTokenExpAt = 0;
    throw new Error('Refresh failed: invalid_grant. Refaire /auth/start une fois.');
  }

  if (!resp.ok) {
    console.error('[oauth] refresh failed', resp.status, text);
    throw new Error(`Refresh failed: ${resp.status} ${text}`);
  }

  const json = JSON.parse(text);
  userAccessToken = json.access_token || userAccessToken;
  if (json.refresh_token) userRefreshToken = json.refresh_token; // rotation possible
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;

  await saveTokensToDB({
    access_token: userAccessToken,
    refresh_token: userRefreshToken,
    expires_at_ms: userTokenExpAt
  });

  return userAccessToken;
}

// ========= GraphQL HTTP (envoi) =========
async function gqlHttp(query, variables) {
  const token = await refreshUserTokenIfNeeded();
  const resp = await fetch(GQL_HTTP, {
    method: 'POST',
    headers: {
      'Authorization': token, // token brut, sans "Bearer"
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await resp.text();
  let data = {};
  try { data = JSON.parse(body); } catch {}
  if (!resp.ok || data.errors) throw new Error(`GraphQL error: ${resp.status} ${body}`);
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

// ========= Resolve username (pour listener) =========
async function resolveStreamer(displayname) {
  const query = {
    operationName: 'LivestreamPage',
    variables: {
      displayname,
      add: false,
      isLoggedIn: false,
      isMe: false,
      showUnpicked: false,
      order: 'PickTime'
    },
    extensions: {
      persistedQuery: { version: 1, sha256Hash: '2e6216b014c465c64e5796482a3078c7ec7fbc2742d93b072c03f523dbcf71e2' }
    }
  };
  const res = await fetch(GQL_HTTP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(query)
  });
  if (!res.ok) throw new Error(`Graphigo HTTP ${res.status}`);
  const data = await res.json();
  const username = data?.data?.userByDisplayName?.username;
  if (!username) throw new Error(`Channel "${displayname}" introuvable`);
  return username;
}

// ========= Listener WS (non-auth, persisted query officielle) =========
function subscribeChat(streamerUsername, onMessage) {
  const ws = new WebSocket('wss://graphigostream.prd.dlive.tv/', 'graphql-ws');

  ws.on('open', () => {
    console.log(`[dlive] WS ouvert pour ${streamerUsername}`);
    ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));

    ws.send(JSON.stringify({
      id: '2',
      type: 'start',
      payload: {
        variables: { streamer: streamerUsername, viewer: '' },
        extensions: { persistedQuery: { version: 1, sha256Hash: '1246db4612a2a1acc520afcbd34684cdbcebad35bcfff29dcd7916a247722a7a' } },
        operationName: 'StreamMessageSubscription',
        query:
          'subscription StreamMessageSubscription($streamer: String!, $viewer: String) {' +
          '  streamMessageReceived(streamer: $streamer, viewer: $viewer) {' +
          '    type' +
          '    ... on ChatText { id emojis content createdAt subLength ...VStreamChatSenderInfoFrag __typename }' +
          '    ... on ChatGift { id gift amount message recentCount expireDuration ...VStreamChatSenderInfoFrag __typename }' +
          '    ... on ChatFollow { id ...VStreamChatSenderInfoFrag __typename }' +
          '    ... on ChatHost { id viewer ...VStreamChatSenderInfoFrag __typename }' +
          '    ... on ChatSubscription { id month ...VStreamChatSenderInfoFrag __typename }' +
          '    ... on ChatExtendSub { id month length ...VStreamChatSenderInfoFrag __typename }' +
          '    ... on ChatChangeMode { mode __typename }' +
          '    ... on ChatSubStreak { id ...VStreamChatSenderInfoFrag length __typename }' +
          '    ... on ChatClip { id url ...VStreamChatSenderInfoFrag __typename }' +
          '    ... on ChatDelete { ids __typename }' +
          '    ... on ChatBan { id ...VStreamChatSenderInfoFrag bannedBy { id displayname __typename } bannedByRoomRole __typename }' +
          '    ... on ChatModerator { id ...VStreamChatSenderInfoFrag add __typename }' +
          '    ... on ChatEmoteAdd { id ...VStreamChatSenderInfoFrag emote __typename }' +
          '    ... on ChatTimeout { id ...VStreamChatSenderInfoFrag minute bannedBy { id displayname __typename } bannedByRoomRole __typename }' +
          '    ... on ChatTCValueAdd { id ...VStreamChatSenderInfoFrag amount totalAmount __typename }' +
          '    ... on ChatGiftSub { id ...VStreamChatSenderInfoFrag count receiver __typename }' +
          '    ... on ChatGiftSubReceive { id ...VStreamChatSenderInfoFrag gifter __typename }' +
          '    __typename' +
          '  }' +
          '}' +
          'fragment VStreamChatSenderInfoFrag on SenderInfo { subscribing role roomRole sender { id username displayname avatar partnerStatus badges effect __typename } __typename }'
      }
    }));
  });

  ws.on('message', (buf) => {
    try {
      const data = JSON.parse(buf.toString());
      if (data.type === 'connection_ack' || data.type === 'ka') return;
      const msg = data?.payload?.data?.streamMessageReceived?.[0];
      if (!msg) return;
      onMessage(msg);
    } catch (e) {
      console.error('[ws] parse error:', e?.message || String(e));
    }
  });

  ws.on('error', (e) => {
    console.error('[ws] erreur:', e?.message || String(e));
  });

  ws.on('close', (code) => {
    console.log(`[ws] fermé (${code}). Reconnexion dans 5s...`);
    setTimeout(() => subscribeChat(streamerUsername, onMessage), 5000);
  });

  return ws;
}

// ========= Boot listener =========
async function bootListener() {
  try {
    const streamer = DLIVE_TARGET_USERNAME || await resolveStreamer(DLIVE_CHANNEL);
    console.log(`[boot] écoute du chat sur username="${streamer}" (display="${DLIVE_CHANNEL}")`);
    subscribeChat(streamer, async (msg) => {
      if (msg?.type !== 'Message' || msg?.__typename !== 'ChatText') return;
      const content = (msg.content || '').trim();
      if (!content.startsWith('!')) return;
      const reply = resolveCommand(content);
      if (!reply) return;
      try {
        await sendStreamchatMessage({ to: streamer, message: reply, role: 'Member', subscribing: false });
      } catch (e) {
        console.error('[bot] envoi échoué:', e.message);
      }
    });
  } catch (e) {
    console.error('[boot] listener erreur:', e.message);
  }
}

// ========= ROUTES =========

// HEALTH + échange de code sur la RACINE
app.get('/', async (req, res) => {
  // Si redirigé par DLive (Option A) → échange et PERSISTE
  if (req.query.code) {
    try {
      console.log('[oauth] callback code =', String(req.query.code).slice(0, 8) + '...');
      const tok = await exchangeCodeForToken(req.query.code.toString());
      return res
        .status(200)
        .send(
          `<h3>OAuth OK ✅</h3>` +
          `<pre>${JSON.stringify({ ...tok, access_token: '***' }, null, 2)}</pre>` +
          `<p>Tokens enregistrés en base. Tu peux fermer cette page.</p>`
        );
    } catch (e) {
      console.error('[oauth] callback error:', e?.message || e);
      return res.status(500).send('Erreur callback: ' + (e.message || e));
    }
  }
  // Sinon: page info
  res.status(200).send('OK - listener + OAuth persistant (Postgres). Va sur /auth/start pour initialiser si DB vide.');
});

// Démarrer OAuth
app.get('/auth/start', (req, res) => {
  try {
    const params = new URLSearchParams({
      client_id: DLIVE_CLIENT_ID,
      redirect_uri: DLIVE_REDIRECT_URI,  // = https://skrymi.com
      response_type: 'code',
      scope: 'identity chat:write',
      state: 'skrymi_oauth'
    });
    const url = `https://dlive.tv/o/authorize?${params.toString()}`;
    console.log('[oauth] auth/start ->', url);
    res.redirect(url);
  } catch (e) {
    res.status(500).send('Erreur /auth/start: ' + (e.message || e));
  }
});

// Envoi manuel
app.get('/send', async (req, res) => {
  try {
    const msg = (req.query.msg || 'ping').toString();
    const r = await sendStreamchatMessage({ to: DLIVE_TARGET_USERNAME, message: msg });
    res.status(200).send(`<pre>${JSON.stringify(r, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

// Commande manuelle
app.get('/cmd', async (req, res) => {
  try {
    const to = (req.query.to || DLIVE_TARGET_USERNAME).toString();
    const cmd = (req.query.c || req.query.cmd || '').toString();
    if (!cmd) return res.status(400).send('Manque ?c= — ex: /cmd?c=!coucou');
    const reply = resolveCommand(cmd);
    if (!reply) return res.status(400).send('Commande inconnue');
    const r = await sendStreamchatMessage({ to, message: reply });
    res.status(200).send(`<pre>${JSON.stringify(r, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

// Admin simple
function requireAdmin(req, res, next) {
  const pass = req.query.key || req.body?.key;
  if (pass === ADMIN_PASSWORD) return next();
  res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_PASSWORD');
}
app.get('/admin', requireAdmin, (req, res) => {
  const rows = Object.entries(COMMANDS)
    .map(([k,v]) => `<tr><td><input name="k" value="${k}"/></td><td><input name="v" value="${(v+'').replace(/"/g,'&quot;')}"/></td></tr>`)
    .join('');
  res.send(`
    <h2>Admin commandes</h2>
    <form method="POST" action="/admin/commands?key=${encodeURIComponent(ADMIN_PASSWORD)}">
      <table>${rows}</table>
      <button type="submit">Sauvegarder (mémoire)</button>
    </form>
  `);
});
app.post('/admin/commands', requireAdmin, (req, res) => {
  const { k, v } = req.body;
  const map = {};
  if (Array.isArray(k) && Array.isArray(v)) k.forEach((key,i)=>{ if (key) map[String(k[i]).trim()] = String(v[i]); });
  else if (k && v !== undefined) map[String(k).trim()] = String(v);
  COMMANDS = { ...COMMANDS, ...map };
  res.redirect(`/admin?key=${encodeURIComponent(ADMIN_PASSWORD)}`);
});

// Debug utiles (facultatif)
app.get('/debug/env', (_req, res) => {
  res.json({
    DLIVE_CLIENT_ID,
    DLIVE_REDIRECT_URI,
    has_DATABASE_URL: !!process.env.DATABASE_URL,
    target_username: process.env.DLIVE_TARGET_USERNAME,
    channel_display: process.env.DLIVE_CHANNEL
  });
});
app.get('/debug/token-db', async (_req, res) => {
  try {
    const row = await loadTokensFromDB();
    res.json({
      has_access_token: !!row?.access_token,
      has_refresh_token: !!row?.refresh_token,
      expires_at_ms: row?.expires_at_ms || 0
    });
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});
app.get('/admin/reset-tokens', async (_req, res) => {
  try {
    await saveTokensToDB({ access_token: null, refresh_token: null, expires_at_ms: 0 });
    userAccessToken = null; userRefreshToken = null; userTokenExpAt = 0;
    res.send('OK: tokens remis à zéro. Refaire /auth/start.');
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

// ========= START =========
app.listen(PORT, async () => {
  console.log('Server started on port', PORT);
  await bootLoadTokens();           // charge/seed depuis DB/env
  if (ENABLE_CHAT_LISTENER === 'true') bootListener();
});
