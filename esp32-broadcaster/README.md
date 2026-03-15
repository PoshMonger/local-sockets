# ESP32-CAM broadcaster

Streams JPEG video from an **ESP32-CAM** to the [sockets-2.0](../) device API over HTTP.

## Quick start

1. **Install PlatformIO** in Cursor: Extensions → search “PlatformIO IDE” → Install → restart.
2. **Open this folder** in Cursor: `File → Open Folder` → select `esp32-broadcaster`.
3. **Edit** `src/main.cpp`: set `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_URL`, `STREAM_ID`, `STREAM_PASSWORD`.
4. **Upload**: PlatformIO sidebar → Project Tasks → **esp32cam** → **Upload**. Then open **Monitor** (115200 baud).
5. **Run the server** (from repo root: `npm run dev` or `node server/index.js`). Open the **Watch** page with the same stream ID and password.

Full steps and troubleshooting: [../docs/ESP32-SETUP.md](../docs/ESP32-SETUP.md).

## Requirements

- ESP32-CAM (e.g. AI-Thinker) or compatible board with camera
- USB‑serial adapter to flash the board
- Server reachable on your LAN (use your computer’s IP in `SERVER_URL`, not `localhost`)
