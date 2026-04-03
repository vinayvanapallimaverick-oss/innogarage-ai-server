#!/usr/bin/env node
/**
 * One-time script to generate a Gmail OAuth2 refresh token for innogarage.ai.
 *
 * Run ONCE from the project root:
 *   node server/scripts/setup-gmail-token.js
 *
 * What it does:
 *   1. Opens your browser to authorize Gmail send access
 *   2. Captures the authorization code via a local HTTP server
 *   3. Exchanges the code for tokens
 *   4. Prints the two Railway env vars you need to add
 *
 * Which account to authorize:
 *   Sign in with whichever Gmail address you want innogarage.ai to send OTP
 *   emails FROM (e.g. your own Gmail or a dedicated noreply address).
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { exec } = require('child_process');

// ─── Load env ──────────────────────────────────────────────────────────────

function readEnvFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return acc;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return acc;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      acc[key] = val;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

const envPath = path.join(__dirname, '..', '.env');
const env = { ...readEnvFile(envPath), ...process.env };

const CLIENT_ID     = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in server/.env\n');
  process.exit(1);
}

// ─── OAuth2 parameters ─────────────────────────────────────────────────────

const PORT         = 9876;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE        = 'https://www.googleapis.com/auth/gmail.send';

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline` +
  `&prompt=consent` +
  `&response_type=code`;

// ─── Local callback server ─────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let urlObj;
  try { urlObj = new URL(req.url, `http://localhost:${PORT}`); }
  catch { res.writeHead(400); res.end('Bad request'); return; }

  if (urlObj.pathname !== '/callback') {
    res.writeHead(404); res.end('Not found'); return;
  }

  const code  = urlObj.searchParams.get('code');
  const error = urlObj.searchParams.get('error');

  const colour = error ? '#ef4444' : '#22c55e';
  const msg    = error ? `❌ Error: ${error}` : '✅ Authorized! You can close this tab.';

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<html><body style="font-family:sans-serif;max-width:460px;margin:40px auto;padding:20px;">
    <h2 style="color:${colour}">innogarage.ai Gmail Setup</h2>
    <p>${msg}</p></body></html>`);

  server.close();

  if (error || !code) {
    console.error('\n❌  Google authorization failed:', error || 'no code received');
    process.exit(1);
  }

  exchangeCode(code);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} is already in use. Close the other process and try again.\n`);
  } else {
    console.error('\n❌  Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  innogarage.ai  ·  Gmail API Setup');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n📌  Step 1: A browser window will open.');
  console.log('    Sign in with the Gmail you want to send OTP emails FROM.');
  console.log('    Click "Continue" / "Allow" to grant send permission.\n');

  openBrowser(authUrl);
});

// ─── Code exchange ─────────────────────────────────────────────────────────

function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
  }).toString();

  const options = {
    hostname: 'oauth2.googleapis.com',
    path:     '/token',
    method:   'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      let tokens;
      try { tokens = JSON.parse(data); }
      catch { console.error('\n❌  Could not parse token response:', data); return; }

      if (tokens.error) {
        console.error('\n❌  Token exchange failed:', tokens.error_description || tokens.error);

        if (tokens.error === 'redirect_uri_mismatch') {
          console.error('\n   Fix: In Google Cloud Console → Credentials → your OAuth client,');
          console.error(`   add  http://localhost:${PORT}/callback  to "Authorized redirect URIs".\n`);
        }
        return;
      }

      if (!tokens.refresh_token) {
        console.error('\n❌  No refresh token in response. This usually means the account was already');
        console.error('    authorized before. Revoke access at https://myaccount.google.com/permissions');
        console.error('    then run this script again.\n');
        return;
      }

      printResult(tokens.refresh_token);
    });
  });

  req.on('error', (e) => console.error('\n❌  HTTPS request error:', e.message));
  req.write(body);
  req.end();
}

// ─── Output ────────────────────────────────────────────────────────────────

function printResult(refreshToken) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅  Success! Add these to Railway:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`  GMAIL_REFRESH_TOKEN=${refreshToken}`);
  console.log(`  GMAIL_FROM=<the Gmail address you just authorized>\n`);
  console.log('  Railway → your service → Variables tab → New Variable\n');
  console.log('  Railway will redeploy automatically. Signup/login will work immediately after.\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// ─── Cross-platform browser open ──────────────────────────────────────────

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'  ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
                                    `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      console.log('  Could not open browser automatically. Open this URL manually:');
      console.log(`\n  ${url}\n`);
    }
  });
}
