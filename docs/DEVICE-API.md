# Device API – Microcontroller video streaming

This extension lets **Arduino**, **Raspberry Pi**, **ESP32-CAM**, and other microcontrollers stream video into the app using **HTTP** (no WebSocket required). Streams use the same **streamID** and **password** as the web UI; viewers can watch via the existing Watch page or WebSocket client.

---

## Overview

- **You do on the device:** capture frames (e.g. JPEG from ESP32-CAM), then either:
  - **Option A:** Call the HTTP API to register a stream and POST each frame.
  - **Option B:** Use the existing **WebSocket** protocol (if your stack supports it) with `role: 'broadcast'` and send binary frames after auth.
- **This server provides:** REST endpoints to register a stream and ingest raw binary frames; frames are delivered to all viewers of that stream (same as WebSocket broadcast).

Base URL (relative to your server): `/api/device`

---

## Endpoints

### 1. Info (no auth)

```http
GET /api/device/info
```

Returns API version and endpoint summary. Use to check that the device extension is enabled.

---

### 2. Register a stream (optional)

```http
POST /api/device/register
Content-Type: application/json

{"streamId": "my-camera-01", "password": "your-secret"}
```

- **streamId:** lowercase, 1–64 chars (e.g. `my-camera-01`).
- **password:** used later to POST frames and for viewers to watch.

If the stream already exists, password must match. Response: `{"ok": true, "streamId": "my-camera-01", "message": "Stream registered"}` or `"Stream already exists"`.  
You can skip this and create the stream on first frame POST (see below).

---

### 3. Send a video frame

```http
POST /api/device/stream/:streamId/frame
Content-Type: image/jpeg
X-Stream-Password: your-secret

<raw binary body – e.g. JPEG bytes>
```

- **:streamId** – same as used in register (e.g. `my-camera-01`).
- **Auth:** send the stream password either as:
  - **Header:** `X-Stream-Password: your-secret`, or
  - **Header:** `Authorization: Bearer your-secret`
- **Body:** raw bytes of one frame (e.g. JPEG from ESP32-CAM). Max ~5 MB per request.

If the stream does not exist yet, it is created with the given password. Response: **204 No Content** on success.

### Performance (server)

The server **does not** run bcrypt password verification on **every** frame (that would limit you to a few frames per second). After a successful check, auth is cached per `(streamId + password)` for several hours (default **6 hours**, override with env `DEVICE_AUTH_CACHE_MS` in milliseconds).

### Device inactivity & sessions

While no WebSocket broadcaster is connected, HTTP frame timing drives status:

- **`DEVICE_WAIT_MS`** (default **5000**): no frame this long → watchers get `stream_status` `waiting` with `reason: device_stall` (momentary interruption).
- **`DEVICE_INACTIVE_MS`** (default **15000**): no frame this long → `is_active` is set **0** in the DB, the device **broadcast** `sessions` row is **ended**, watchers get `stream_status` **`inactive`**.

Each time frames resume after a full inactive period, a **new** broadcast session is started (same as a fresh device run). Env vars: `DEVICE_WAIT_MS`, `DEVICE_INACTIVE_MS`.

**Example (curl):**

```bash
# Create stream (optional)
curl -X POST http://localhost:3080/api/device/register \
  -H "Content-Type: application/json" \
  -d '{"streamId":"test-cam","password":"mypass"}'

# Send a JPEG frame
curl -X POST http://localhost:3080/api/device/stream/test-cam/frame \
  -H "Content-Type: image/jpeg" \
  -H "X-Stream-Password: mypass" \
  --data-binary @frame.jpg
```

---

## Watching the stream

- **Web:** Open the existing **Watch** page, enter the same **stream ID** and **password**.
- **Programmatic:** Connect via WebSocket, send auth `{ type: 'auth', streamId, password, role: 'watch' }`, then receive binary frames in the same way as for browser broadcast.

No changes are required on the watch side; device streams use the same pipeline as WebSocket broadcasters.

---

## Device-side integration notes

### ESP32-CAM (Arduino framework)

- Use **HTTPClient** or **WiFiClient** to POST each JPEG frame to `http://YOUR_SERVER/api/device/stream/YOUR_STREAM_ID/frame`.
- Set header `X-Stream-Password: YOUR_PASSWORD` and `Content-Type: image/jpeg`.
- Send `camera_fb_t->buf` (and length) as the body.
- Optionally call `/api/device/register` once at boot.

### Raspberry Pi (Python)

- Use `requests`:  
  `requests.post(url, data=jpeg_bytes, headers={'X-Stream-Password': pwd, 'Content-Type': 'image/jpeg'})`
- Or use `urllib.request` with a binary body and the same headers.

### Arduino (e.g. Ethernet / WiFi shield)

- Build HTTP manually or use a small HTTP client library.
- POST to `/api/device/stream/<streamId>/frame` with `X-Stream-Password` and raw JPEG body.

### WebSocket option (if your device supports it)

- Connect to `ws://YOUR_SERVER/` (or `wss://` if TLS).
- First message (JSON):  
  `{"type":"auth","streamId":"your-stream-id","password":"your-password","role":"broadcast"}`
- After receiving `{"type":"auth","ok":true,...}`, send each frame as **binary** (e.g. JPEG bytes).
- Same streamID/password and viewer behavior as the HTTP device API.

---

## Summary

| Your task (on device) | Server (this app) |
|----------------------|-------------------|
| Choose streamID + password | Same IDs used for watch/broadcast |
| Capture frames (e.g. JPEG) | — |
| POST frames to `/api/device/stream/:streamId/frame` with password in header | Delivers frames to all viewers of that stream |
| Or use WebSocket auth + binary frames | Same pipeline as browser broadcast |

No existing functionality is removed or changed; this is an additive extension for device streaming.
