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

/* =======================
   1) Token d’app (client_credentials)
   ======================= */
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

  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`No access_token. Raw: ${text}`);

  appToken = json.access_token;
  const expiresIn = Number(json.expires_in || 3600);
  appTokenExpiresAt = Date.now() + expiresIn * 1000;
  return appToken;
}

/* =======================
   2) Helpers GraphQL + introspection
   ======================= */
function unwrap(t) {
  let cur = t;
  while (cur && !cur.name && cur.ofType) cur = cur.ofType;
  return cur || t;
}

const TypeRef = `
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}
`;

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

async function getMutationField(name) {
  const q = `
    ${TypeRef}
    query {
      __type(name: "Mutation") {
        fields {
          name
          args { name type { ...TypeRef } }
          type { ...TypeRef }
        }
      }
    }
  `;
  const data = await gql(q, {});
  const fields = data.__type?.fields || [];
  return fields.find(f => f.name === name);
}

async function getType(name) {
  const q = `
    ${TypeRef}
    query($name:String!) {
      __type(name: $name) {
        kind name
        inputFields { name type { ...TypeRef } }
        enumValues { name }
        fields { name type { ...TypeRef } }
      }
    }
  `;
  const data = await gql(q, { name });
  return data.__type;
}

/* =======================
   3) Envoi auto : construit l'input depuis le schéma
   ======================= */
async function buildSendStreamchatInputAuto({ to, message }) {
  // Mutation + type d'input
  const mf = await getMutationField('sendStreamchatMessage');
  if (!mf) throw new Error('Mutation sendStreamchatMessage introuvable');

  const argInput = (mf.args || []).find(a => a.name === 'input');
  if (!argInput) throw new Error('Argument "input" manquant sur sendStreamchatMessage');

  const inputTypeLeaf = unwrap(argInput.type); // INPUT_OBJECT SendStreamchatMessageInput
  const inputType = await getType(inputTypeLeaf.name);
  const fields = inputType?.inputFields || [];
  const names = fields.map(f => f.name);

  // d’après ton schéma: streamer, message, roomRole, subscribing sont requis
  if (!names.includes('streamer')) throw new Error('Champ requis "streamer" absent');
  if (!names.includes('message')) throw new Error('Champ requis "message" absent');

  // roomRole (ENUM) → choisir une valeur valide ; si enum absent, fallback "Member"
  let roomRole = 'Member';
  if (names.includes('roomRole')) {
    const rr = fields.find(f => f.name === 'roomRole');
    const leaf = unwrap(rr.type);
    if (leaf.kind === 'ENUM') {
      const enumType = await getType(leaf.name);
      const values = (enumType?.enumValues || []).map(v => v.name);
      // essaie 'Member' sinon première valeur
      roomRole = values.includes('Member') ? 'Member' : (values[0] || 'Member');
    }
  }

  // subscribing:Boolean! → false par défaut
  const subscribing = names.includes('subscribing') ? false : undefined;

  const input = { streamer: to, message };
  if (roomRole !== undefined) input.roomRole = roomRole;
  if (subscribing !== undefined) input.subscribing = subscribing;

  return { input, inputTypeName: inputTypeLeaf.name };
}

async function sendChatMessageAuto({ to, message }) {
  const { input, inputTypeName } = await buildSendStreamchatInputAuto({ to, message });
  const mutation = `
    mutation SendChat($input: ${inputTypeName}!) {
      sendStreamchatMessage(input: $input) { __typename }
    }
  `;
  const data = await gql(mutation, { input });
  return { ok: true, inputUsed: input, result: data.sendStreamchatMessage };
}

/* =======================
   4) Routes HTTP
   ======================= */

// Healthcheck
app.get('/', (_req, res) => {
  res.status(200).send('OK - MrLarbin app-token mode (manual fixed)');
});

// Voir/obtenir un app token (debug)
app.get('/token/app', async (_req, res) => {
  try {
    const token = await getAppToken();
    res.type('json').send({ access_token: token, expires_at: appTokenExpiresAt });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Introspection: mutation et type
app.get('/schema/mutation', async (_req, res) => {
  try {
    const mf = await getMutationField('sendStreamchatMessage');
    res.type('json').send(mf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});
app.get('/schema/type', async (req, res) => {
  try {
    const name = req.query.name?.toString();
    if (!name) return res.status(400).send('query param ?name= requis');
    const t = await getType(name);
    res.type('json').send(t);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Envoi AUTO (construit l'input selon le schéma)
app.get('/send-app', async (req, res) => {
  try {
    const message = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();
    const to = (req.query.to || DLIVE_TARGET_DISPLAYNAME).toString();
    const result = await sendChatMessageAuto({ to, message });
    res.status(200).send(`Message envoyé (auto).<pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send(`Erreur envoi (app token auto): ${e.message}`);
  }
});

// Envoi MANUEL (corrigé): forcer streamer/message + roomRole + subscribing
// Exemple : /send-app-manual?to=skrymi&targetField=streamer&msg=Hello&messageField=message&roomRole=Member&subscribing=false
app.get('/send-app-manual', async (req, res) => {
  try {
    const to = (req.query.to || DLIVE_TARGET_DISPLAYNAME).toString();
    const message = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();

    // champs forcés par query
    const targetField = (req.query.targetField || 'streamer').toString();   // DOIT être "streamer"
    const messageField = (req.query.messageField || 'message').toString();  // DOIT être "message"
    const forcedRoomRole = req.query.roomRole?.toString();                  // Member / Moderator / Owner
    const subscribingParam = req.query.subscribing;                          // 'true' / 'false' / '1' / '0'
    const subscribing =
      subscribingParam !== undefined
        ? (subscribingParam === 'true' || subscribingParam === '1')
        : false;

    // nom réel du type d'input
    const mf = await getMutationField('sendStreamchatMessage');
    const argInput = (mf.args || []).find(a => a.name === 'input');
    const inputTypeLeaf = unwrap(argInput.type);
    const inputTypeName = inputTypeLeaf.name;

    // construire l'input conformément à ton schéma
    const input = {
      [targetField]: to,
      [messageField]: message,
      subscribing,                // ⚠️ requis par ton schéma
    };
    if (forcedRoomRole) input.roomRole = forcedRoomRole; // Member / Moderator / Owner

    const mutation = `
      mutation SendChat($input: ${inputTypeName}!) {
        sendStreamchatMessage(input: $input) { __typename }
      }
    `;
    const data = await gql(mutation, { input });
    res.status(200).send(
      `Message envoyé (manuel).<pre>${JSON.stringify({ input, result: data.sendStreamchatMessage }, null, 2)}</pre>`
    );
  } catch (e) {
    res.status(500).send(`Erreur envoi (app token manuel): ${e.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MrLarbin app-token server on http://0.0.0.0:${PORT}`);
});
