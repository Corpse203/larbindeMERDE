import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { createClient as createWsClient } from 'graphql-ws';

// ===== ENV =====
const {
  DLIVE_CLIENT_ID,
  DLIVE_CLIENT_SECRET,
  DLIVE_REDIRECT_URI,                // ex: https://skrymi.com
  DLIVE_TARGET_USERNAME = 'skrymi',  // username (pas display)
  PORT = 10000,

  ENABLE_CHAT_LISTENER = 'true',
  DLIVE_WS = 'wss://graphigostream.prd.dlive.tv/',

  // admin + liens
  ADMIN_PASSWORD = 'change-me',
  DISCORD_URL = 'https://discord.gg/ton-invite',
  YT_URL = 'https://youtube.com/@ton-chaine',
  TWITTER_URL = 'https://twitter.com/toncompte',

  // PERSISTENCE via ENV
  DLIVE_USER_REFRESH_TOKEN = '',     // 👈 on le colle ici côté Render
  COMMANDS_JSON = ''                 // 👈 JSON des commandes (optionnel)
} = process.env;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const OAUTH_AUTHORIZE = 'https://dlive.tv/o/authorize';
const OAUTH_TOKEN = 'https://dlive.tv/o/token';
const GQL_HTTP = 'https://graphigo.prd.dlive.tv/';

// ===== TOKENS EN MÉMOIRE (reconstruits via refresh_token d'env) =====
let userAccessToken = null;
let userRefreshToken = DLIVE_USER_REFRESH_TOKEN || null;
let userTokenExpAt = 0;

// ===== COMMANDES EN MÉMOIRE (charge depuis env au boot) =====
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
let COMMANDS = loadCommandsFromEnv(); // ⚠️ persistant jusqu’au redeploy

// ===== OAUTH =====
function basicAuthHeader() {
  const basic = Buffer.from(`${DLIVE_CLIENT_ID}:${DLIVE_CLIENT_SECRET}`).toString('base64');
  return `Basic ${basic}`;
}

// Échange du code → tokens (affichés à l’écran pour que tu copies le refresh)
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

// Refresh à partir du refresh_token (depuis env au boot)
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
  if (!resp.ok) throw new Error(`Refresh failed: ${resp.status} ${text}`);
  const json = JSON.parse(text);
  userAccessToken = json.access_token || userAccessToken;
  if (json.refresh_token) userRefreshToken = json.refresh_token; // si rotation
  const expiresIn = Number(json.expires_in || 3600);
  userTokenExpAt = Date.now() + expiresIn * 1000;
  return userAccessToken;
}

// ===== GraphQL HTTP (Authorization = token brut) =====
async function gqlHttp(query, variables) {
  const token = await refreshUserTokenIfNeeded();
  const resp = await fetch(GQL_HTTP, {
    method: 'POST',
    headers: {
      'Authorization': token, // IMPORTANT: sans "Bearer"
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

// ===== Envoi chat =====
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

// ===== Listener (WS) =====
import { setTimeout as delay } from 'timers/promises';
let wsClient = null;
let wsRunning = false;

async function ensureWsClient() {
  const token = await refreshUserTokenIfNeeded();
  wsClient = createWsClient({
    url: DLIVE_WS,
    connectionParams: { Authorization: token },
    keepAlive: 15000,
    retryAttempts: 100,
    retryWait: async function* () { while (true) yield 2000; }
  });
  return wsClient;
}

async function pickChatSubscriptionField() {
  const q = `
    query {
      __type(name: "Subscription") {
        fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } }
      }
    }
  `;
  const d = await gqlHttp(q, {});
  const fields = d.__type?.fields || [];
  for (const f of fields) {
    const lname = (f.name || '').toLowerCase();
    if (!lname.includes('chat')) continue;
    for (const a of (f.args || [])) {
      let t = a.type; while (t && !t.name && t.ofType) t = t.ofType;
      if (t?.kind === 'SCALAR' && t?.name === 'String') {
        return { fieldName: f.name, argName: a.name };
      }
    }
  }
  throw new Error('No chat-like subscription field found.');
}

function resolveCommand(cmdRaw = '') {
  const key = String(cmdRaw || '').trim();
  if (!key.startsWith('!')) return null;
  return COMMANDS[key] ?? COMMANDS[key.toLowerCase()] ?? null;
}

async function startChatListener(streamerUsername) {
  if (wsRunning) return;
  wsRunning = true;

  const { fieldName, argName } = await pickChatSubscriptionField();
  const subscriptionQuery = `
    subscription OnChat($${argName}: String!) {
      ${fieldName}(${argName}: $${argName}) {
        __typename
        content
        message
        text
        body
        sender { username displayname __typename }
        user   { username displayname __typename }
      }
    }
  `;
  const client = await ensureWsClient();
  const vars = { [argName]: streamerUsername };

  function extractText(payload) {
    const d = payload?.data?.[fieldName];
    if (!d) return null;
    if (typeof d === 'string') return d;
    return d.content || d.message || d.text || d.body || null;
  }

  client.subscribe(
    { query: subscriptionQuery, variables: vars },
    {
      next: async (payload) => {
        try {
          const txt = extractText(payload);
          if (!txt) return;
          const trimmed = String(txt).trim();
          if (!trimmed.startsWith('!')) return;

          const reply = resolveCommand(trimmed);
          if (reply) {
            await sendStreamchatMessage({ to: streamerUsername, message: reply, role: 'Member', subscribing: false });
          }
        } catch (e) { console.error('Listener error(next):', e.message); }
      },
      error: async (err) => {
        console.error('WS error:', err);
        wsRunning = false;
        await delay(2000);
        if (ENABLE_CHAT_LISTENER === 'true') startChatListener(streamerUsername).catch(() => {});
      },
      complete: async () => {
        console.log('WS complete');
        wsRunning = false;
        await delay(2000);
        if (ENABLE_CHAT_LISTENER === 'true') startChatListener(streamerUsername).catch(() => {});
      }
    }
  );

  console.log(`👂 Listener ON via ${fieldName}(${argName}:"${streamerUsername}")`);
}

async function stopChatListener() {
  try { wsClient?.dispose?.(); } catch {}
  wsClient = null;
  wsRunning = false;
  console.log('👂 Listener OFF');
}

// ===== ROUTES =====

// root = healthcheck + gestion redirect ?code=
app.get('/', async (req, res) => {
  if (!req.query.code) {
    return res.status(200).send('OK - env-persist (refresh in env), listener auto, admin: /admin');
  }
  try {
    const code = req.query.code.toString();
    const tok = await exchangeCodeForToken(code);

    // 👉 Montre le refresh pour que tu le copies dans Render env
    const show = { ...tok, access_token: tok.access_token ? '***' : null };
    res.status(200).send(
      `<h3>OAuth OK</h3><pre>${JSON.stringify(show, null, 2)}</pre>` +
      `<p><b>IMPORTANT :</b> copie <code>refresh_token</code> dans <code>DLIVE_USER_REFRESH_TOKEN</code> (Render → Environment), puis Restart.</p>`
    );

    // lance le listener maintenant
    if (ENABLE_CHAT_LISTENER === 'true') startChatListener(DLIVE_TARGET_USERNAME).catch(e => console.error('Listener error:', e.message));
  } catch (e) {
    res.status(500).send('Erreur callback (root): ' + e.message);
  }
});

// démarrer OAuth à la main
app.get('/auth/start', (req, res) => {
  const params = new URLSearchParams({
    client_id: DLIVE_CLIENT_ID,
    redirect_uri: DLIVE_REDIRECT_URI,
    response_type: 'code',
    scope: 'identity chat:write',
    state: 'mrlarbin'
  });
  res.redirect(`${OAUTH_AUTHORIZE}?${params.toString()}`);
});

// envoi manuel
app.get('/send', async (req, res) => {
  try {
    const msg = (req.query.msg || 'Ping depuis /send').toString();
    const result = await sendStreamchatMessage({ to: DLIVE_TARGET_USERNAME, message: msg, role: 'Member', subscribing: false });
    res.status(200).send(`Message envoyé.<pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send('Erreur envoi: ' + e.message);
  }
});

// ===== ADMIN simple =====
function requireAdmin(req, res, next) {
  const pass = req.query.key || req.headers['x-admin-key'] || req.body?.key;
  if (pass === ADMIN_PASSWORD) return next();
  res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_PASSWORD');
}

// page admin
app.get('/admin', requireAdmin, (req, res) => {
  const cmds = COMMANDS;
  const rows = Object.entries(cmds).map(([k,v]) => `<tr><td><input name="k" value="${k}"/></td><td><input name="v" value="${(v+'').replace(/"/g,'&quot;')}"/></td></tr>`).join('');
  res.send(`
    <h1>MrLarbin — Admin</h1>
    <p><b>Attention :</b> sans disque, les changements ne survivent pas au redeploy. Clique "Exporter JSON" et colle-le ensuite dans <code>COMMANDS_JSON</code> (Render → Environment), puis Restart.</p>
    <form method="POST" action="/admin/commands?key=${encodeURIComponent(ADMIN_PASSWORD)}">
      <table>${rows}</table>
      <button type="submit">Sauvegarder (mémoire)</button>
    </form>
    <form method="GET" action="/admin/export.json?key=${encodeURIComponent(ADMIN_PASSWORD)}">
      <button type="submit">Exporter JSON (à coller dans COMMANDS_JSON)</button>
    </form>
    <hr/>
    <form method="POST" action="/listener/start?key=${encodeURIComponent(ADMIN_PASSWORD)}"><button>Start listener</button></form>
    <form method="POST" action="/listener/stop?key=${encodeURIComponent(ADMIN_PASSWORD)}"><button>Stop listener</button></form>
  `);
});

// maj en mémoire
app.post('/admin/commands', requireAdmin, (req, res) => {
  const { k, v } = req.body;
  const map = {};
  if (Array.isArray(k) && Array.isArray(v)) {
    k.forEach((key, i) => { if (key && v[i] !== undefined) map[String(key).trim()] = String(v[i]); });
  } else if (k && v !== undefined) {
    map[String(k).trim()] = String(v);
  }
  COMMANDS = { ...COMMANDS, ...map };
  res.redirect(`/admin?key=${encodeURIComponent(ADMIN_PASSWORD)}`);
});

// export JSON pour l'env
app.get('/admin/export.json', requireAdmin, (_req, res) => {
  res.type('json').send(COMMANDS);
});

// start/stop listener
app.post('/listener/start', requireAdmin, async (_req, res) => {
  try { await startChatListener(DLIVE_TARGET_USERNAME); res.send('Listener started'); }
  catch (e) { res.status(500).send(e.message); }
});
app.post('/listener/stop', requireAdmin, async (_req, res) => {
  try { await stopChatListener(); res.send('Listener stopped'); }
  catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, () => {
  console.log('Server started on port', PORT);
  if (userRefreshToken && ENABLE_CHAT_LISTENER === 'true') {
    startChatListener(DLIVE_TARGET_USERNAME).catch(e => console.error('Listener error (boot):', e.message));
  } else if (ENABLE_CHAT_LISTENER === 'true') {
    console.log('Listener attend OAuth: pas de DLIVE_USER_REFRESH_TOKEN dans l\'env.');
  }
});
