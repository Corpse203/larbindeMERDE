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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS commands (
      k text PRIMARY KEY,
      v text NOT NULL,
      updated_at timestamptz DEFAULT now()
    );
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

// === Commands in DB ===
async function loadCommandsFromDB() {
  const { rows } = await pool.query(`SELECT k, v FROM commands ORDER BY k ASC`);
  const map = {};
  for (const r of rows) map[r.k] = r.v;
  return map;
}

async function upsertCommandDB(k, v) {
  await pool.query(
    `INSERT INTO commands(k, v) VALUES($1, $2)
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
    [k, v]
  );
}

async function deleteCommandDB(k) {
  await pool.query(`DELETE FROM commands WHERE k = $1`, [k]);
}

// ========= Tokens (mémoire) =========
let userAccessToken = null;
let userRefreshToken = null;
let userTokenExpAt = 0;

// ========= Commandes (defaults) =========
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

async function bootLoadTokensAndCommands() {
  await ensureSchema();
  // Commands
  try {
    const dbCmd = await loadCommandsFromDB();
    if (Object.keys(dbCmd).length > 0) {
      COMMANDS = dbCmd; // DB wins over defaults if present
      console.log(`🧩 ${Object.keys(COMMANDS).length} commandes chargées depuis Postgres.`);
    } else {
      const entries = Object.entries(COMMANDS);
      for (const [k, v] of entries) await upsertCommandDB(k, v);
      console.log(`🧩 commandes par défaut seedées en DB (${entries.length}).`);
    }
  } catch (e) {
    console.error('Commands load error:', e.message);
  }
  // Tokens
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
    console.log('ℹ️ Aucun token en DB. Va sur /auth/start pour initialiser.');
  }
}

async function exchangeCodeForToken(code) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: DLIVE_REDIRECT_URI, // = https://skrymi.com (Option A)
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
    userAccessToken = null; userRefreshToken = null; userTokenExpAt = 0;
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

// ========= GUARD admin =========
function requireAdmin(req, res, next) {
  const pass = req.query.key || req.body?.key;
  if (pass === ADMIN_PASSWORD) return next();
  res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_PASSWORD');
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

// ---- Commands API (JSON) ----
app.get('/api/commands', requireAdmin, async (_req, res) => {
  try {
    const map = await loadCommandsFromDB();
    res.json({ ok: true, commands: map });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/commands', requireAdmin, async (req, res) => {
  try {
    const k = String(req.body.k || '').trim();
    const v = String(req.body.v ?? '');
    if (!k.startsWith('!')) return res.status(400).json({ ok: false, error: 'La clé doit commencer par !' });
    if (!k || v === '') return res.status(400).json({ ok: false, error: 'k et v requis' });
    await upsertCommandDB(k, v);
    COMMANDS[k] = v; // sync mémoire
    res.json({ ok: true, k, v });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/commands/:k', requireAdmin, async (req, res) => {
  try {
    const k = decodeURIComponent(req.params.k || '');
    if (!k.startsWith('!')) return res.status(400).json({ ok: false, error: 'Clé invalide' });
    await deleteCommandDB(k);
    delete COMMANDS[k]; // sync mémoire
    res.json({ ok: true, k });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/commands/export', requireAdmin, async (_req, res) => {
  const map = await loadCommandsFromDB();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=commands.json');
  res.send(JSON.stringify(map, null, 2));
});

app.post('/api/commands/import', requireAdmin, async (req, res) => {
  try {
    const imported = req.body || {};
    const entries = Object.entries(imported);
    for (const [k, v] of entries) {
      if (k.startsWith('!')) {
        await upsertCommandDB(k, String(v));
        COMMANDS[k] = String(v);
      }
    }
    res.json({ ok: true, count: entries.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Admin UI (jolie) ----
app.get('/admin', requireAdmin, async (req, res) => {
  const key = encodeURIComponent(req.query.key || '');
  res.send(`
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Admin Commandes</title>
<style>
  :root{
    --bg:#0b0f14;--bg2:#0d1117;--glass:rgba(19,25,33,.6);
    --card:#0f1722;--muted:#94a3b8;--text:#e2e8f0;--acc:#22d3ee;--acc2:#38bdf8;--danger:#ef4444;--ok:#10b981;
    --bord:#1f2937;--input:#0b1220;--input-b:#253042;--shadow:0 20px 60px rgba(0,0,0,.35);
  }
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 10% -10%, rgba(34,211,238,.12), transparent 40%),radial-gradient(900px 600px at 90% 10%, rgba(56,189,248,.12), transparent 50%),linear-gradient(0deg,var(--bg),var(--bg2));color:var(--text);font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Arial}
  header{padding:18px 20px;border-bottom:1px solid var(--bord);backdrop-filter:saturate(140%) blur(8px);background:linear-gradient(0deg,var(--glass),rgba(13,17,23,.7));position:sticky;top:0;z-index:20}
  h1{margin:0;font-size:18px;letter-spacing:.2px}
  main{max-width:1024px;margin:24px auto;padding:0 16px}
  .card{background:linear-gradient(180deg,rgba(15,23,34,.9),rgba(11,17,26,.85));border:1px solid var(--bord);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
  .head{display:flex;gap:16px;align-items:center;padding:16px;border-bottom:1px solid var(--bord)}
  .muted{color:var(--muted);font-size:13px}
  .row{display:flex;gap:12px;flex-wrap:wrap}
  input[type=text], textarea{flex:1;min-width:220px;background:var(--input);border:1px solid var(--input-b);color:var(--text);border-radius:12px;padding:12px 14px;outline:none}
  input[type=text]:focus, textarea:focus{border-color:var(--acc)}
  textarea{width:100%;min-height:110px;resize:vertical}
  button{background:linear-gradient(180deg,var(--acc),var(--acc2));color:#001018;border:none;border-radius:12px;padding:11px 16px;cursor:pointer;font-weight:600;box-shadow:0 6px 18px rgba(34,211,238,.25)}
  button.secondary{background:#1f2937;color:#e5e7eb;border:1px solid var(--bord);box-shadow:none}
  button.danger{background:linear-gradient(180deg,#f87171,#ef4444);color:#180000;box-shadow:0 6px 18px rgba(239,68,68,.25)}
  button.ghost{background:transparent;border:1px solid var(--bord);color:var(--text)}
  table{width:100%;border-collapse:collapse}
  th,td{padding:12px;border-bottom:1px solid var(--bord);vertical-align:top}
  tr:hover td{background:rgba(34,211,238,.03)}
  .k{font-family:ui-monospace,Consolas,monospace}
  .actions{display:flex;gap:8px;justify-content:flex-end}
  .footer{display:flex;gap:10px;justify-content:space-between;align-items:center;padding:14px 16px;background:linear-gradient(0deg,var(--glass),rgba(13,17,23,.7));border-top:1px solid var(--bord)}
  .pill{display:inline-flex;gap:6px;align-items:center;background:rgba(34,211,238,.08);border:1px solid rgba(34,211,238,.35);padding:8px 12px;border-radius:999px;font-size:12px;color:#ccfbf1}
  .tag{display:inline-block;background:#111827;border:1px solid #1f2937;border-radius:999px;padding:4px 8px;font-size:12px;color:#e5e7eb}
  .hint{font-size:12px;color:#a3a3a3}
</style>
</head>
<body>
<header><h1>Admin Commandes</h1></header>
<main>
  <div class="card">
    <div class="head">
      <div>
        <div class="muted">Gère les réponses <b>!...</b> (persistantes en DB). Tape la commande dans le chat pour tester.</div>
        <div class="hint">Exemples: <span class="tag">!coucou</span> <span class="tag">!discord</span> <span class="tag">!yt</span></div>
      </div>
      <div style="flex:1"></div>
      <a class="pill" href="/api/commands/export?key=${key}">Exporter JSON</a>
      <label class="pill" style="cursor:pointer">
        Importer JSON
        <input type="file" id="importFile" accept="application/json" style="display:none">
      </label>
    </div>
    <div style="padding:16px">
      <div class="row" style="margin-bottom:8px">
        <input id="newK" type="text" placeholder="!nouvelle-commande" />
      </div>
      <div class="row" style="margin-bottom:10px">
        <textarea id="newV" placeholder="Réponse à envoyer dans le chat"></textarea>
      </div>
      <div class="row" style="justify-content:flex-end">
        <button id="addBtn">Ajouter / Mettre à jour</button>
      </div>
    </div>
    <div style="padding:0 16px 8px">
      <table id="tbl"><thead>
        <tr><th style="width:260px">Commande</th><th>Réponse</th><th style="width:200px"></th></tr>
      </thead><tbody id="tbody"></tbody></table>
    </div>
    <div class="footer">
      <div class="muted">Connecté en mode admin.</div>
      <div class="actions">
        <button class="secondary" id="reloadBtn">Recharger</button>
        <button class="ghost" id="testBtn">Tester !coucou</button>
      </div>
    </div>
  </div>
</main>
<script>
const key = ${JSON.stringify(req.query.key || '')};

async function fetchCommands(){
  const res = await fetch('/api/commands?key=' + encodeURIComponent(key));
  const j = await res.json();
  if(!j.ok) throw new Error(j.error || 'fetch error');
  return j.commands || {};
}
function renderRows(map){
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  Object.entries(map).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([k,v])=>{
    const tr = document.createElement('tr');
    const tdK = document.createElement('td'); tdK.innerHTML = '<span class="k">'+k+'</span>';
    const tdV = document.createElement('td'); tdV.textContent = v;
    const tdA = document.createElement('td'); tdA.className = 'actions';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Éditer';
    editBtn.onclick = () => { document.getElementById('newK').value = k; document.getElementById('newV').value = v; window.scrollTo({top:0,behavior:"smooth"}); };

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = 'Supprimer';
    delBtn.onclick = async () => {
      if(!confirm('Supprimer '+k+' ?')) return;
      const res = await fetch('/api/commands/'+encodeURIComponent(k)+'?key='+encodeURIComponent(key), { method:'DELETE' });
      const j = await res.json();
      if(!j.ok) return alert(j.error||'Erreur suppression');
      loadAndRender();
    };

    tdA.append(editBtn, delBtn);
    tr.append(tdK, tdV, tdA);
    tbody.append(tr);
  });
}
async function loadAndRender(){ try{ renderRows(await fetchCommands()); }catch(e){ alert(e.message); } }

document.getElementById('addBtn').onclick = async () => {
  const k = document.getElementById('newK').value.trim();
  const v = document.getElementById('newV').value;
  if(!k.startsWith('!')) return alert('La commande doit commencer par !');
  const res = await fetch('/api/commands?key='+encodeURIComponent(key), {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({k,v})
  });
  const j = await res.json();
  if(!j.ok) return alert(j.error||'Erreur sauvegarde');
  document.getElementById('newK').value=''; document.getElementById('newV').value='';
  loadAndRender();
};

document.getElementById('reloadBtn').onclick = loadAndRender;
document.getElementById('testBtn').onclick = ()=>{ window.open('/cmd?c=!coucou','_blank'); };

document.getElementById('importFile').onchange = async (ev)=>{
  const file = ev.target.files?.[0]; if(!file) return;
  try{
    const txt = await file.text();
    const json = JSON.parse(txt);
    const res = await fetch('/api/commands/import?key='+encodeURIComponent(key), {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(json)
    });
    const j = await res.json();
    if(!j.ok) throw new Error(j.error||'Import erreur');
    alert('Import OK: '+(j.count||0)+' entrées');
    loadAndRender();
  }catch(e){ alert(e.message); }
};

loadAndRender();
</script>
</body>
</html>
  `);
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
  await bootLoadTokensAndCommands(); // tokens + commandes
  if (ENABLE_CHAT_LISTENER === 'true') bootListener();
});
