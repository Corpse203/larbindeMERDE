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

// ====== Token d'app (client_credentials) ======
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

// ====== Helpers GraphQL + introspection ======
function unwrap(t) {
  // Récupère le "leaf" type (name/kind) en sautant NON_NULL/LIST/ofType...
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
        name
        fields {
          name
          args { name type { ...TypeRef } }
          type { ...TypeRef }
        }
      }
    }
  `;
  const data = await gql(q, {});
  return (data.__type.fields || []).find(f => f.name === name);
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

// ====== Construction automatique de l'input ======
async function buildSendStreamchatInput({ to, message }) {
  // 1) Mutation + type d'input
  const mf = await getMutationField('sendStreamchatMessage');
  if (!mf) throw new Error('Mutation sendStreamchatMessage introuvable');

  const argInput = (mf.args || []).find(a => a.name === 'input');
  if (!argInput) throw new Error('Argument "input" manquant sur sendStreamchatMessage');

  const inputTypeLeaf = unwrap(argInput.type); // INPUT_OBJECT SendStreamchatMessageInput
  const inputType = await getType(inputTypeLeaf.name);
  const fields = inputType?.inputFields || [];
  const fieldNames = fields.map(f => f.name);

  // 2) Choisir le champ "cible" (room/channel/streamer...)
  const targetCandidates = ['roomId','channelId','streamer','streamerName','channel','roomName'];
  const targetField = targetCandidates.find(n => fieldNames.includes(n));
  if (!targetField) {
    throw new Error(`Impossible d'identifier le champ cible (candidats: ${targetCandidates.join(', ')}). Champs dispo: ${fieldNames.join(', ')}`);
  }

  // 3) Choisir le champ "message" (message/content/text/body...)
  const msgCandidates = ['message','content','text','body'];
  const messageField = msgCandidates.find(n => fieldNames.includes(n));
  if (!messageField) {
    throw new Error(`Impossible d'identifier le champ message (candidats: ${msgCandidates.join(', ')}). Champs dispo: ${fieldNames.join(', ')}`);
  }

  // 4) roomRole si présent et requis → prendre une valeur ENUM valide
  let roomRoleValue = null;
  if (fieldNames.includes('roomRole')) {
    const roomRoleField = fields.find(f => f.name === 'roomRole');
    // type ENUM ?
    const rrLeaf = unwrap(roomRoleField.type);
    if (rrLeaf && rrLeaf.kind === 'ENUM') {
      const enumType = await getType(rrLeaf.name);
      const values = (enumType?.enumValues || []).map(v => v.name);
      // on tente des valeurs "classiques" si présentes, sinon la première
      const preferred = ['User','Viewer','Member','Normal','Guest'];
      roomRoleValue = preferred.find(v => values.includes(v)) || values[0];
      if (!roomRoleValue) {
        throw new Error(`roomRole est requis mais aucune valeur ENUM trouvée pour ${rrLeaf.name}`);
      }
    } else {
      // pas un enum ? on met une valeur neutre
      roomRoleValue = 'User';
    }
  }

  // 5) Construire l'input en remplissant les champs requis NON_NULL
  const input = {};
  for (const f of fields) {
    const leaf = unwrap(f.type);
    const isRequired = (f.type.kind === 'NON_NULL') || (f.type.ofType && f.type.kind === 'NON_NULL');
    if (f.name === targetField) input[f.name] = to;
    if (f.name === messageField) input[f.name] = message;
    if (f.name === 'roomRole' && roomRoleValue) input[f.name] = roomRoleValue;

    // si c'est requis et pas encore défini, on essaie d'assigner un défaut "raisonnable"
    if (isRequired && input[f.name] === undefined) {
      if (leaf.kind === 'SCALAR') {
        // string/ID → valeur non vide ; int/bool → valeur neutre
        if (leaf.name === 'String' || leaf.name === 'ID') input[f.name] = 'auto';
        else if (leaf.name === 'Int') input[f.name] = 0;
        else if (leaf.name === 'Boolean') input[f.name] = true;
        else input[f.name] = 'auto';
      } else if (leaf.kind === 'ENUM') {
        const enumType = await getType(leaf.name);
        const values = (enumType?.enumValues || []).map(v => v.name);
        input[f.name] = values[0] || null;
      } else {
        // INPUT_OBJECT / LIST etc. → on ne met rien par défaut
      }
    }
  }

  return { input, inputTypeName: inputTypeLeaf.name, picked: { targetField, messageField, roomRoleValue } };
}

async function sendChatMessageWithAppTokenAuto({ to, message }) {
  const { input, inputTypeName, picked } = await buildSendStreamchatInput({ to, message });
  const mutation = `
    mutation SendChat($input: ${inputTypeName}!) {
      sendStreamchatMessage(input: $input) { __typename }
    }
  `;
  const data = await gql(mutation, { input });
  return { ok: true, inputUsed: input, picked, result: data.sendStreamchatMessage };
}

// ====== ROUTES ======

// Healthcheck
app.get('/', (_req, res) => res.status(200).send('OK - MrLarbin app-token mode (auto schema + roomRole)'));

// Token d’app
app.get('/token/app', async (_req, res) => {
  try {
    const token = await getAppToken();
    res.type('json').send({ access_token: token, expires_at: appTokenExpiresAt });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Introspection: mutation
app.get('/schema/mutation', async (_req, res) => {
  try {
    const mf = await getMutationField('sendStreamchatMessage');
    res.type('json').send(mf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Introspection: type
app.get('/schema/type', async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).send('query param ?name= requis');
    const t = await getType(name.toString());
    res.type('json').send(t);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Envoi auto (choix des bons champs + roomRole)
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

// Envoi manuel (forcer le champ cible, messageField et roomRole)
// /send-app-manual?to=skrymi&targetField=roomId&msg=Hello&messageField=message&roomRole=User
app.get('/send-app-manual', async (req, res) => {
  try {
    const to = (req.query.to || DLIVE_TARGET_DISPLAYNAME).toString();
    const message = (req.query.msg || req.query.message || DLIVE_MESSAGE).toString();
    const targetField = req.query.targetField?.toString();
    const messageField = (req.query.messageField || 'message').toString();
    const forcedRoomRole = req.query.roomRole?.toString();

    const mf = await getMutationField('sendStreamchatMessage');
    const argInput = (mf.args || []).find(a => a.name === 'input');
    const inputTypeLeaf = unwrap(argInput.type);
    const inputTypeName = inputTypeLeaf.name;

    const input = {};
    if (targetField) input[targetField] = to;
    input[messageField] = message;
    if (forcedRoomRole) input.roomRole = forcedRoomRole;

    const mutation = `
      mutation SendChat($input: ${inputTypeName}!) {
        sendStreamchatMessage(input: $input) { __typename }
      }
    `;
    const data = await gql(mutation, { input });
    res.status(200).send(`Message envoyé (manuel).<pre>${JSON.stringify({ input, result: data.sendStreamchatMessage }, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send(`Erreur envoi (app token manuel): ${e.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MrLarbin app-token (auto schema + roomRole) on http://0.0.0.0:${PORT}`);
});
