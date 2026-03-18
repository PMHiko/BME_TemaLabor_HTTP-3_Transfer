import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Http3Server } from '@fails-components/webtransport';

const certPem = readFileSync('certs/server.crt', 'utf8');
const keyPem  = readFileSync('certs/server.key', 'utf8');

// --- Chat state ---
const clients = new Map(); // id -> { writer, username }
let nextId = 1;
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const ts  = () => new Date().toTimeString().slice(0, 8);

async function broadcast(msg, excludeId = null) {
  const data = enc(msg);
  for (const [id, { writer }] of clients) {
    if (id !== excludeId) {
      try { await writer.write(data); } catch { /* closed */ }
    }
  }
}

async function sendTo(id, msg) {
  try { await clients.get(id)?.writer.write(enc(msg)); } catch { /* ignore */ }
}

async function handleSession(session) {
  await session.ready;
  const sessionId = nextId++;

  const bidiReader = session.incomingBidirectionalStreams.getReader();
  const { value: stream } = await bidiReader.read();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  // First message = username
  const { value: firstChunk } = await reader.read();
  const firstMsg = JSON.parse(new TextDecoder().decode(firstChunk));
  const username = (firstMsg.type === 'join' && firstMsg.text?.trim())
    ? firstMsg.text.trim()
    : `User${sessionId}`;

  clients.set(sessionId, { writer, username });

  await sendTo(sessionId, {
    type: 'welcome', user: 'server',
    text: `Üdv, ${username}!`, timestamp: ts(),
    users: [...clients.values()].map(c => c.username),
  });

  await broadcast(
    { type: 'join', user: username, text: `${username} csatlakozott`, timestamp: ts() },
    sessionId,
  );

  console.log(`[+] ${username} (session ${sessionId})`);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const msg = JSON.parse(new TextDecoder().decode(value));
      if (msg.type === 'chat' && msg.text?.trim()) {
        const client = clients.get(sessionId);
        const out = { type: 'chat', user: client.username, text: msg.text, timestamp: ts() };
        console.log(`[chat] ${out.user}: ${out.text}`);
        await broadcast(out);
      }
    }
  } finally {
    const client = clients.get(sessionId);
    clients.delete(sessionId);
    console.log(`[-] ${client?.username} (session ${sessionId})`);
    await broadcast({
      type: 'leave', user: client?.username,
      text: `${client?.username} kilépett`, timestamp: ts(),
    });
  }
}

// --- HTTP/3 WebTransport server (4433) ---
const wt = new Http3Server({
  port: 4433,
  host: '::',
  secret: 'dev-secret-change-me',
  cert: certPem,
  privKey: keyPem,
});

wt.startServer();
console.log('QUIC  → https://localhost:4433/chat');

(async () => {
  const sessionStream = await wt.sessionStream('/chat');
  const sessionReader = sessionStream.getReader();
  while (true) {
    const { done, value: session } = await sessionReader.read();
    if (done) break;
    handleSession(session).catch(e => console.error('[session error]', e));
  }
})();

// --- HTTP server for static files (3000) ---
const indexHtml = readFileSync('public/index.html', 'utf8');

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(3000, '0.0.0.0', () => {
  console.log('HTTP  → http://localhost:3000');
});
