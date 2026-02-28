import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  initDb,
  getStream,
  createStream,
  setStreamActive,
  startSession,
  endSession,
  updateSessionFrameCount,
  hashPassword,
  verifyPassword,
} from './db.js';
import { installDeviceExtension } from './device-extension.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3080;

const app = express();
const server = createServer(app);
app.use(express.static(join(__dirname, '..', 'public')));

// streamId -> { broadcaster: ws, viewers: Set(ws), latestFrame: Buffer, sessionId: number }
const streams = new Map();

async function ensureDb() {
  try {
    await initDb();
  } catch (e) {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let role = null;
  let streamId = null;
  let sessionId = null;
  let authenticated = false;
  let frameCount = 0;

  ws.on('message', async (data, isBinary) => {
    if (!authenticated) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'auth' || typeof msg.streamId !== 'string' || typeof msg.password !== 'string') {
          ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Send type, streamId, and password' }));
          setTimeout(() => ws.close(), 100);
          return;
        }
        const id = String(msg.streamId).trim().toLowerCase();
        const password = msg.password;
        if (!id || id.length > 64) {
          ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Invalid stream ID' }));
          setTimeout(() => ws.close(), 100);
          return;
        }

        if (msg.role === 'broadcast') {
          const existing = getStream(id);
          if (existing) {
            const valid = await verifyPassword(password, existing.password_hash);
            if (!valid) {
              ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Invalid password for this stream' }));
              setTimeout(() => ws.close(), 100);
              return;
            }
            const cur = streams.get(id);
            if (cur && cur.broadcaster) {
              cur.broadcaster.close();
            }
          } else {
            const passwordHash = await hashPassword(password);
            createStream(id, passwordHash);
          }
          setStreamActive(id, 1);
          if (!streams.has(id)) streams.set(id, { broadcaster: null, viewers: new Set(), latestFrame: null, sessionId: null });
          const s = streams.get(id);
          if (s.broadcaster) s.broadcaster.close();
          s.broadcaster = ws;
          s.sessionId = startSession(id, 'broadcast').id;
          role = 'broadcast';
          streamId = id;
          sessionId = s.sessionId;
          authenticated = true;
          ws.send(JSON.stringify({ type: 'auth', ok: true, role: 'broadcast', streamId: id }));
          s.viewers.forEach((v) => {
            if (v.readyState === 1) v.send(JSON.stringify({ type: 'stream_status', status: 'live', streamId: id }));
          });
          return;
        }

        if (msg.role === 'watch') {
          const row = getStream(id);
          if (!row) {
            ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Stream not found' }));
            setTimeout(() => ws.close(), 100);
            return;
          }
          const valid = await verifyPassword(password, row.password_hash);
          if (!valid) {
            ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Invalid password' }));
            setTimeout(() => ws.close(), 100);
            return;
          }
          if (!streams.has(id)) streams.set(id, { broadcaster: null, viewers: new Set(), latestFrame: null, sessionId: null });
          const s = streams.get(id);
          s.viewers.add(ws);
          sessionId = startSession(id, 'watch').id;
          role = 'watch';
          streamId = id;
          authenticated = true;
          ws.send(JSON.stringify({ type: 'auth', ok: true, role: 'watch', streamId: id }));
          const status = s.broadcaster && s.broadcaster.readyState === 1 ? 'live' : 'waiting';
          ws.send(JSON.stringify({ type: 'stream_status', status, streamId: id }));
          if (s.latestFrame) ws.send(s.latestFrame, { binary: true });
          return;
        }

        ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Unknown role' }));
        setTimeout(() => ws.close(), 100);
        return;
      } catch (err) {
        ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Invalid request' }));
        setTimeout(() => ws.close(), 100);
      }
      return;
    }

    if (role === 'broadcast' && isBinary && streamId) {
      frameCount++;
      const s = streams.get(streamId);
      if (s) {
        s.latestFrame = data;
        if (sessionId && frameCount % 30 === 0) updateSessionFrameCount(sessionId, frameCount);
        s.viewers.forEach((v) => {
          if (v.readyState === 1) v.send(data, { binary: true });
        });
      }
    }
  });

  ws.on('close', () => {
    if (!streamId) return;
    const s = streams.get(streamId);
    if (!s) return;
    if (role === 'broadcast' && ws === s.broadcaster) {
      s.broadcaster = null;
      setStreamActive(streamId, 0);
      if (s.sessionId) endSession(s.sessionId, s.viewers.size, frameCount);
      s.viewers.forEach((v) => {
        if (v.readyState === 1) v.send(JSON.stringify({ type: 'stream_status', status: 'disconnected', streamId }));
      });
      if (s.viewers.size === 0) streams.delete(streamId);
    }
    if (role === 'watch') {
      s.viewers.delete(ws);
      if (sessionId) endSession(sessionId);
      if (s.viewers.size === 0 && !s.broadcaster) streams.delete(streamId);
    }
  });
});

// Device extension: allow microcontrollers to push frames via HTTP (no change to existing logic)
function injectFrame(streamId, buffer) {
  const id = String(streamId).trim().toLowerCase();
  if (!id) return;
  if (!streams.has(id)) {
    streams.set(id, { broadcaster: null, viewers: new Set(), latestFrame: null, sessionId: null });
  }
  const s = streams.get(id);
  s.latestFrame = buffer;
  setStreamActive(id, 1);
  s.viewers.forEach((v) => {
    if (v.readyState === 1) v.send(buffer, { binary: true });
  });
}
installDeviceExtension(app, injectFrame);

async function main() {
  await ensureDb();
  server.listen(PORT, () => {
    console.log('Stream server http://localhost:' + PORT);
    console.log('  Broadcast: http://localhost:' + PORT + '/broadcast.html');
    console.log('  Watch:     http://localhost:' + PORT + '/watch.html');
    console.log('  Device API: http://localhost:' + PORT + '/api/device/info');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
