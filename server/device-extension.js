/**
 * Device extension: HTTP API for microcontrollers (Arduino, Raspberry Pi, ESP32-CAM, etc.)
 * to register streams and push video frames without using WebSockets.
 * Does not modify any existing behavior; only adds new routes and uses injectFrame to
 * feed frames into the same stream state as WebSocket broadcasters.
 */

import express from 'express';
import {
  getStream,
  createStream,
  hashPassword,
  verifyPassword,
} from './db.js';

/**
 * Mount device API routes on the existing Express app.
 * @param {import('express').Express} app - Express app
 * @param {(streamId: string, buffer: Buffer) => void} injectFrame - Called to push a frame into a stream (same as WS broadcast)
 */
export function installDeviceExtension(app, injectFrame) {
  const router = express.Router();

  // Parse as raw buffer only when not JSON (so /register gets JSON, /frame gets binary)
  router.use(express.raw({ limit: '5mb', type: (req) => req.headers['content-type'] !== 'application/json' }));
  router.use(express.json({ limit: '1kb' }));

  /**
   * POST /api/device/register
   * Body: { streamId: string, password: string }
   * Pre-creates a stream so the device can use it later. Optional; first frame POST also creates the stream.
   */
  router.post('/register', async (req, res) => {
    if (!req.body || typeof req.body.streamId !== 'string' || typeof req.body.password !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Send JSON body with streamId and password',
      });
    }
    const id = String(req.body.streamId).trim().toLowerCase();
    const password = req.body.password;
    if (!id || id.length > 64) {
      return res.status(400).json({ ok: false, error: 'Invalid stream ID' });
    }

    try {
      const existing = getStream(id);
      if (existing) {
        const valid = await verifyPassword(password, existing.password_hash);
        if (!valid) {
          return res.status(401).json({ ok: false, error: 'Invalid password for this stream' });
        }
        return res.json({ ok: true, streamId: id, message: 'Stream already exists' });
      }
      const passwordHash = await hashPassword(password);
      createStream(id, passwordHash);
      return res.json({ ok: true, streamId: id, message: 'Stream registered' });
    } catch (err) {
      console.error('Device register error:', err.message);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  /**
   * POST /api/device/stream/:streamId/frame
   * Body: raw binary (e.g. JPEG frame).
   * Auth: X-Stream-Password header (or Authorization: Bearer <password>).
   * Creates stream in DB on first use if it doesn't exist. Injects frame to all viewers.
   */
  router.post('/stream/:streamId/frame', async (req, res) => {
    const streamId = String(req.params.streamId || '').trim().toLowerCase();
    if (!streamId || streamId.length > 64) {
      return res.status(400).json({ ok: false, error: 'Invalid stream ID' });
    }

    const password =
      req.headers['x-stream-password'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);
    if (!password) {
      return res.status(401).json({ ok: false, error: 'Missing X-Stream-Password or Authorization: Bearer <password>' });
    }

    const body = req.body;
    if (!body || !Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ ok: false, error: 'Send raw binary body (e.g. JPEG frame)' });
    }

    try {
      let row = getStream(streamId);
      if (!row) {
        const passwordHash = await hashPassword(password);
        createStream(streamId, passwordHash);
        row = getStream(streamId);
      } else {
        const valid = await verifyPassword(password, row.password_hash);
        if (!valid) {
          return res.status(401).json({ ok: false, error: 'Invalid password' });
        }
      }

      injectFrame(streamId, body);
      return res.status(204).end();
    } catch (err) {
      console.error('Device frame error:', err.message);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  /**
   * GET /api/device/info
   * Returns API version and usage hints (no auth).
   */
  router.get('/info', (req, res) => {
    res.json({
      api: 'device',
      version: '1.0',
      endpoints: {
        'POST /api/device/register': 'Body: { streamId, password }. Pre-register a stream.',
        'POST /api/device/stream/:streamId/frame': 'Body: raw binary (JPEG). Header: X-Stream-Password or Authorization: Bearer <password>.',
      },
      watch: 'Use existing WebSocket watch with the same streamId and password to view the stream.',
    });
  });

  app.use('/api/device', router);
}
