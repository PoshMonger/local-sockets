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

// streamId -> stream state (see defaultStreamState)
const streams = new Map();

/** No frames for this long → viewers see "waiting" (momentary interruption). */
const DEVICE_WAIT_MS = Number(process.env.DEVICE_WAIT_MS) || 5_000;
/** No frames for this long → DB inactive, end device broadcast session, viewers see "inactive". */
const DEVICE_INACTIVE_MS = Number(process.env.DEVICE_INACTIVE_MS) || 15_000;

function defaultStreamState() {
  return {
    broadcaster: null,
    viewers: new Set(),
    latestFrame: null,
    sessionId: null,
    deviceBroadcastSessionId: null,
    deviceFrameCount: 0,
    deviceLastFrameAt: 0,
    deviceWaitTimer: null,
    deviceInactiveTimer: null,
  };
}

function ensureStream(streamId) {
  if (!streams.has(streamId)) {
    streams.set(streamId, defaultStreamState());
  }
  return streams.get(streamId);
}

function migrateStreamState(s) {
  if (s.deviceLastFrameAt === undefined) {
    s.deviceBroadcastSessionId = null;
    s.deviceFrameCount = 0;
    s.deviceLastFrameAt = 0;
    s.deviceWaitTimer = null;
    s.deviceInactiveTimer = null;
  }
}

function clearDeviceInactivityTimers(s) {
  if (s.deviceWaitTimer) {
    clearTimeout(s.deviceWaitTimer);
    s.deviceWaitTimer = null;
  }
  if (s.deviceInactiveTimer) {
    clearTimeout(s.deviceInactiveTimer);
    s.deviceInactiveTimer = null;
  }
}

function deviceSourceActive(s) {
  return !s.broadcaster || s.broadcaster.readyState !== 1;
}

function notifyViewersStatus(streamId, status, extra = {}) {
  const s = streams.get(streamId);
  if (!s) return;
  const payload = JSON.stringify({ type: 'stream_status', status, streamId, ...extra });
  s.viewers.forEach((v) => {
    if (v.readyState === 1) v.send(payload);
  });
}

/** Initial watch UI: live (WS broadcaster), recent device frame, brief gap, or inactive. */
function initialWatchStatusForStream(s) {
  if (s.broadcaster && s.broadcaster.readyState === 1) return 'live';
  const last = s.deviceLastFrameAt || 0;
  if (!s.latestFrame || !last) return 'waiting';
  const elapsed = Date.now() - last;
  if (elapsed < DEVICE_WAIT_MS) return 'live';
  if (elapsed < DEVICE_INACTIVE_MS) return 'waiting';
  return 'inactive';
}

function scheduleDeviceInactivity(streamId) {
  const s = streams.get(streamId);
  if (!s || !deviceSourceActive(s)) return;

  clearDeviceInactivityTimers(s);

  s.deviceWaitTimer = setTimeout(() => {
    s.deviceWaitTimer = null;
    const cur = streams.get(streamId);
    if (!cur || !deviceSourceActive(cur)) return;
    if (Date.now() - cur.deviceLastFrameAt < DEVICE_WAIT_MS) return;
    notifyViewersStatus(streamId, 'waiting', { reason: 'device_stall' });
  }, DEVICE_WAIT_MS);

  s.deviceInactiveTimer = setTimeout(() => {
    s.deviceInactiveTimer = null;
    const cur = streams.get(streamId);
    if (!cur || !deviceSourceActive(cur)) return;
    if (Date.now() - cur.deviceLastFrameAt < DEVICE_INACTIVE_MS) return;

    if (cur.deviceBroadcastSessionId != null) {
      endSession(cur.deviceBroadcastSessionId, cur.viewers.size, cur.deviceFrameCount);
      cur.deviceBroadcastSessionId = null;
      cur.deviceFrameCount = 0;
    }
    setStreamActive(streamId, 0);
    notifyViewersStatus(streamId, 'inactive');
  }, DEVICE_INACTIVE_MS);
}

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
          const s = ensureStream(id);
          migrateStreamState(s);
          clearDeviceInactivityTimers(s);
          if (s.deviceBroadcastSessionId != null) {
            endSession(s.deviceBroadcastSessionId, s.viewers.size, s.deviceFrameCount);
            s.deviceBroadcastSessionId = null;
            s.deviceFrameCount = 0;
          }
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
          const s = ensureStream(id);
          migrateStreamState(s);
          s.viewers.add(ws);
          sessionId = startSession(id, 'watch').id;
          role = 'watch';
          streamId = id;
          authenticated = true;
          ws.send(JSON.stringify({ type: 'auth', ok: true, role: 'watch', streamId: id }));
          const status = initialWatchStatusForStream(s);
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
      clearDeviceInactivityTimers(s);
      s.viewers.forEach((v) => {
        if (v.readyState === 1) v.send(JSON.stringify({ type: 'stream_status', status: 'disconnected', streamId }));
      });
      if (s.viewers.size === 0) {
        clearDeviceInactivityTimers(s);
        streams.delete(streamId);
      }
    }
    if (role === 'watch') {
      s.viewers.delete(ws);
      if (sessionId) endSession(sessionId);
      if (s.viewers.size === 0 && !s.broadcaster) {
        clearDeviceInactivityTimers(s);
        streams.delete(streamId);
      }
    }
  });
});

// Device extension: HTTP frame ingest; inactivity timers + DB session for device-as-broadcaster
function injectFrame(streamId, buffer) {
  const id = String(streamId).trim().toLowerCase();
  if (!id) return;
  const s = ensureStream(id);
  migrateStreamState(s);
  s.latestFrame = buffer;

  if (!deviceSourceActive(s)) {
    s.viewers.forEach((v) => {
      if (v.readyState === 1) v.send(buffer, { binary: true });
    });
    return;
  }

  const now = Date.now();
  s.deviceLastFrameAt = now;

  const startingNewDeviceSegment = s.deviceBroadcastSessionId == null;
  if (startingNewDeviceSegment) {
    s.deviceBroadcastSessionId = startSession(id, 'broadcast').id;
    s.deviceFrameCount = 0;
    setStreamActive(id, 1);
  }
  s.deviceFrameCount++;
  if (s.deviceBroadcastSessionId && s.deviceFrameCount % 30 === 0) {
    updateSessionFrameCount(s.deviceBroadcastSessionId, s.deviceFrameCount);
  }
  if (startingNewDeviceSegment) {
    notifyViewersStatus(id, 'live');
  }
  scheduleDeviceInactivity(id);

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
