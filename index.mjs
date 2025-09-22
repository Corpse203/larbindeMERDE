
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';

const {
  DLIVE_CLIENT_ID,
  DLIVE_CLIENT_SECRET,
  DLIVE_REDIRECT_URI,
  DLIVE_TARGET_DISPLAYNAME,
  DLIVE_MESSAGE,
  PORT = 3000,
} = process.env;

if (!DLIVE_CLIENT_ID || !DLIVE_CLIENT_SECRET || !DLIVE_REDIRECT_URI) {
  console.warn('⚠️ Missing env: DLIVE_CLIENT_ID, DLIVE_CLIENT_SECRET, DLIVE_REDIRECT_URI are required');
}

const app = express();

// Health check for Render
app.get('/', (_req, res) => {
  res.status(200).send('OK - MrLarbin up');
});

// Begin OAuth2 flow; we encode message & target into state
app.get('/auth/start', (req, res) => {
  const statePayload = {
    m: req.query.message || DLIVE_MESSAGE || 'Hello from MrLarbin',
    t: req.query.to || DLIVE_TARGET_DISPLAYNAME || 'skrymi',
    ts: Date.now()
  };
  const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

  const params = new URLSearchParams({
    client_id: DLIVE_CLIENT_ID,
    redirect_uri: DLIVE_REDIRECT_URI,
    response_type: 'code',
    scope: 'identity chat:write',
    state
  });
  res.redirect(`https://dlive.tv/o/authorize?${params.toString()}`);
});

// Convenience route: /send?msg=Hello&to=skrymi
app.get('/send', async (req, res) => {
  const q = new URLSearchParams({
    message: req.query.msg || req.query.message || DLIVE_MESSAGE || 'Hello from MrLarbin',
    to: req.query.to || DLIVE_TARGET_DISPLAYNAME || 'skrymi',
  });
  res.redirect('/auth/start?' + q.toString());
});

// OAuth2 callback: exchange code for token, then send chat message
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');
    let wanted = { m: DLIVE_MESSAGE || 'Hello from MrLarbin', t: DLIVE_TARGET_DISPLAYNAME || 'skrymi' };
    if (state) {
      try { wanted = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')); } catch {}
    }

    const basic = Buffer.from(`${DLIVE_CLIENT_ID}:${DLIVE_CLIENT_SECRET}`).toString('base64');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      redirect_uri: DLIVE_REDIRECT_URI,
      code
    });

    const tokenResp = await fetch('https://dlive.tv/o/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      return res.status(502).send('Token exchange failed: ' + txt);
    }
    const tokens = await tokenResp.json();
    const accessToken = tokens.access_token;
    if (!accessToken) return res.status(502).send('No access_token in token response');

    const result = await sendChatMessage({
      accessToken,
      displayName: wanted.t,
      message: wanted.m
    });

    res.status(200).send(`Message envoyé à ${wanted.t} !<pre>${JSON.stringify(result, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send('Callback error: ' + e.message);
  }
});

// Helper to send message into a DLive streamer's chat
async function sendChatMessage({ accessToken, displayName, message }) {
  const GQL = 'https://graphigo.prd.dlive.tv/';

  // A simple guess: dlive usernames are often lowercase; if resolution fails, try lowercased display name.
  const username = (displayName || '').toLowerCase();

  const mutation = `
    mutation SendChat($streamer: String!, $message: String!) {
      sendChatMessage(streamer: $streamer, message: $message) {
        id
        content
        createdAt
      }
    }
  `;

  const resp = await fetch(GQL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: mutation, variables: { streamer: username, message } })
  });

  const data = await resp.json();
  if (!resp.ok || data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data, null, 2)}`);
  }
  return data.data.sendChatMessage;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MrLarbin server listening on http://0.0.0.0:${PORT}`);
});
