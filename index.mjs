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
const GQL = 'https://graphigo.prd.dlive.tv/';

// Cache en mémoire pour l'app access token
let appToken = null;
let appTokenExpiresAt = 0; // timestamp ms

async function getAppToken() {
  const now = Date.now();
  if (appToken && now < appTokenExpiresAt - 10_000) return appToken;

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
  if (!resp.ok) throw new Error(`Token (client_credentials) failed: ${resp.status} ${text}`);

  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Token response not JSON: ${text}`); }
  if (!json.access_token) throw new Error(`No access_token. Raw: ${text}`);

  appToken = json.access_token;
  const expiresIn = Number(json.expires_in || 3600);
  appTokenExpiresAt = Date.now() + expiresIn * 1000;
  return appToken;
}

async function gql(query, variables) {
  const token = await getAppToken();
  const resp = await fetch(GQL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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

/** Introspection helpers **/
const TypeRef = `
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}
`;

async function getMutationField(name) {
  const q = `
    ${TypeRef}
    query {
      __type(name: "Mutation") {
        name
        fields { name args { name type { ...TypeRef } } type { ...TypeRef } }
      }
    }
  `;
  const data = await gql(q, {});
  return (data.__type.fields || []).find(f => f.name === name);
}

async function getInputType(name) {
  const q = `
    ${TypeRef}
    query($name:String!) {
      __type(name: $name) {
        name
        inputFields { name type { ...TypeRef } }
      }
    }
  `;
  const data = await gql(q, { name });
  return data.__type;
}

/**
 * Envoi d’un message via sendStreamchatMessage(input: SendStreamchatMessageInput!)
 * On essaie d’abord de découvrir le/les champs attendus via introspection.
 * - champs possibles pour cibler la “room”: streamerName, streamer, channel, channelId, roomId
 * - message: "message" (si présent); sinon on essaie "content" comme fallback
 */
async function sendChatMessageWithAppTokenAuto({ to, message }) {
  // 1) introspect mutation + input
  const mf = await getMutationField('sendStreamchatMessage');
  if (!mf) throw new Error('Mutation sendStreamchatMessage introuvable dans le schéma');

  const inputArg = (mf.args || []).find(a => a.name === 'input');
  if (!inputArg) throw new Error('La mutation sendStreamchatMessage attend un argument "input"');

  // Le nom de type d’input (ex: SendStreamchatMessageInput)
  const inputTypeName =
    inputArg.type?.name ||
    inputArg.type?.ofType?.name ||
    inputArg.type?.ofType?.ofType?.name;

  if (!inputTypeName) throw new Error('Impossible de déterminer le type de l’argument input');

  const inputType = await getInputType(inputTypeName);
  const fields = (inputType?.inputFields || []).map(f => f.name);

  // 2) construire l'input object en se basant sur ce que le schéma expose
  const candidatesForTarget = ['streamerName', 'streamer', 'channel', 'channelId', 'roomId'];
  const targetField = candidatesForTarget.find(k => fields.includes(k));
  if (!targetField) {
    throw new Error(
      `Aucun champ cible connu trouvé dans ${inputTypeName}. Champs disponibles: ${fields.join(', ')}`
    );
  }

  let messageField = 'message';
  if (!fields.includes('message')) {
    if (fields.includes('content')) messageField = 'content';
    else throw new Error(`Aucun champ message/content dans ${inputTypeName}. Champs: ${fields.join(', ')}`);
  }

  const input = { [targetField]: to, [messageField]: message };

  // 3) exécuter la mutation (sélection minimale fiable)
  const mutation = `
    mutation SendChat($input: ${inputTypeName}!) {
      sendStreamchatMessage(input: $input) {
        __typename
      }
    }
  `;
  const data = await gql(mutation, { input });
  return { ok: true, inputUsed: input, result: data.sendStreamchatMessage };
}

// ============== ROUTES ==============

// Healthcheck
app.get('/', (_req, res) => res.status(200).send('OK - MrLarbin app-token mode (auto schema)'));

// Test: obtenir un app token (sans login)
app.get('/token/app', async (_req, res) => {
  try {
    const token = await getAppToken();
    res.type('json').send({ access_token: token, expires_at: appTokenExpiresAt });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Introspection brute : mutation sendStreamchatMessage
app.get('/schema/mutation', async (_req, res) => {
  try {
    const mf = await getMutationField('sendStreamchatMessage');
    res.type('json').send(mf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Introspection d’un type (ex: ?name=SendStreamchatMessageInput)
app.get('/schema/type', async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).send('query param ?name= requis');
    const t = await getInputType(name.toString());
    res.type('json').send(t);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Envoi auto (déduit les champs via introspection)
// /send-app?msg=Hello&to=skrymi
app.get('/send-app', async (req, res) => {
  try {
    const message = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();
    const to = (req.query.to || DLIVE_TARGET_DISPLAYNAME).toString();
    const result = await sendChatMessageWithAppTokenAuto({ to, message });
    res.status(200).send(`Message envoyé (auto).<pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send(`Erreur envoi (app token auto): ${e.message}`);
  }
});

// Envoi manuel si tu veux forcer le champ cible ou le champ message
// /send-app-manual?to=skrymi&targetField=streamerName&msg=Hello&messageField=message
app.get('/send-app-manual', async (req, res) => {
  try {
    const to = (req.query.to || DLIVE_TARGET_DISPLAYNAME).toString();
    const message = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();
    const targetField = (req.query.targetField || 'streamerName').toString();
    const messageField = (req.query.messageField || 'message').toString();

    // Trouve le vrai nom de l'input
    const mf = await getMutationField('sendStreamchatMessage');
    const inputArg = (mf.args || []).find(a => a.name === 'input');
    const inputTypeName =
      inputArg?.type?.name || inputArg?.type?.ofType?.name || inputArg?.type?.ofType?.ofType?.name;

    if (!inputTypeName) throw new Error('Impossible de déterminer le type de l’argument input');

    const mutation = `
      mutation SendChat($input: ${inputTypeName}!) {
        sendStreamchatMessage(input: $input) {
          __typename
        }
      }
    `;
    const input = { [targetField]: to, [messageField]: message };
    const data = await gql(mutation, { input });
    res.status(200).send(`Message envoyé (manuel).<pre>${JSON.stringify({ input, result: data.sendStreamchatMessage }, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send(`Erreur envoi (app token manuel): ${e.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MrLarbin app-token (auto schema) on http://0.0.0.0:${PORT}`);
});
