# ESP32 broadcaster – setup guide

This guide gets you from zero to streaming video from an **ESP32-CAM** (or compatible ESP32 with camera) into this project over HTTP.

---

## 1. Install PlatformIO in Cursor

1. **Open Extensions**  
   - `Cmd+Shift+X` (macOS) or `Ctrl+Shift+X` (Windows/Linux), or click the Extensions icon in the sidebar.

2. **Search and install**  
   - Search for **PlatformIO IDE**.  
   - Install the one by **PlatformIO** (green icon, usually the first result).

3. **Restart Cursor** when prompted so the extension can finish installing (Python, toolchains, etc.).

4. **Confirm**  
   - After restart, you should see the PlatformIO icon (alien/ant) in the left sidebar.  
   - The first time you open a PlatformIO project it may download the ESP32 platform and tools (this can take a few minutes).

---

## 2. What you need for hardware

- **ESP32-CAM** (e.g. AI-Thinker module) or any ESP32 board with a camera module (OV2640 typical).  
- **USB‑to‑serial adapter** (many ESP32-CAM boards don’t have a built-in USB chip; you need something like CP2102, CH340, or FTDI).  
- **Cable** to connect the adapter to the board.

---

## 3. Open the ESP32 broadcaster project

- In Cursor: **File → Open Folder** and choose the project folder:  
  **`sockets-2.0/esp32-broadcaster`**  
- PlatformIO will detect `platformio.ini` and load the project.  
- Wait for the “Indexing” / dependency resolution to finish (bottom status bar).

---

## 4. Configure WiFi and server

Edit **`esp32-broadcaster/src/config.h`** (or the place where credentials are defined in the project):

- **WIFI_SSID** – your WiFi name  
- **WIFI_PASSWORD** – your WiFi password  
- **SERVER_URL** – base URL of this streaming server, e.g. `http://192.168.1.100:3080` (use your machine’s LAN IP and the port the server runs on; avoid `localhost` from the ESP32)  
- **STREAM_ID** – stream identifier (lowercase, 1–64 chars), e.g. `esp32-cam-01`  
- **STREAM_PASSWORD** – password for that stream (same one viewers use on the Watch page)

---

## 5. Select the right board

- Click the **PlatformIO** icon in the sidebar.  
- Under **Project Tasks** → **esp32cam** (or your board env), use **Upload** to build and flash.  
- If your module is different (e.g. generic ESP32 dev board with separate camera), change the **default_envs** or the board in `platformio.ini` to match (e.g. `esp32dev` for a non-CAM ESP32; camera code may need adjustments).

---

## 6. Upload and run

1. Connect the ESP32-CAM to your computer via the USB‑serial adapter.  
2. In PlatformIO: **Project Tasks → esp32cam → Upload** (or the **Upload** button in the bottom status bar).  
3. If upload fails, try holding the **IO0** (or FLASH) button while plugging in or pressing Upload, then release after upload starts.  
4. Open **Serial Monitor** (plug icon or **Project Tasks → Monitor**), set baud rate to **115200**.  
5. The ESP32 will connect to WiFi and start POSTing JPEG frames to  
   `SERVER_URL/api/device/stream/<STREAM_ID>/frame` with the password in the `X-Stream-Password` header.

---

## 7. Watch the stream

- Start this project’s server (e.g. `npm run dev` or `node server/index.js`) on your machine.  
- Ensure the ESP32 can reach the server (same network; **SERVER_URL** must use the machine’s LAN IP, not `localhost`).  
- Open the **Watch** page in the app, enter the same **STREAM_ID** and **STREAM_PASSWORD**.  
- You should see the live video from the ESP32.

---

## 8. Troubleshooting

| Problem | What to try |
|--------|---------------------|
| PlatformIO not appearing | Restart Cursor after installing the extension; check Extensions for “PlatformIO IDE”. |
| Upload fails / wrong port | In PlatformIO: **Project Tasks → esp32cam → Upload**; or set `upload_port` in `platformio.ini` to your adapter’s port (e.g. `/dev/cu.usbserial-*` on macOS). |
| ESP32 doesn’t connect to WiFi | Check SSID/password in `config.h`; ensure 2.4 GHz WiFi (ESP32 doesn’t use 5 GHz). |
| No video on Watch page | Confirm server is running and reachable; SERVER_URL must be the computer’s IP (e.g. `http://192.168.1.100:3080`); check Serial Monitor for HTTP errors. |
| Camera init fails | Verify you’re using the correct board env (e.g. `esp32cam` for AI-Thinker); check wiring if using an external camera module. |

---

## API summary (for reference)

- **Register (optional):** `POST /api/device/register` with JSON `{ "streamId", "password" }`.  
- **Send frame:** `POST /api/device/stream/:streamId/frame` with header `X-Stream-Password: <password>`, `Content-Type: image/jpeg`, body = raw JPEG bytes.  
- Full details: **`docs/DEVICE-API.md`**.
