/**
 * ESP32-CAM broadcaster for sockets-2.0 device API
 *
 * Connects to WiFi and POSTs JPEG frames to:
 *   POST /api/device/stream/:streamId/frame
 *   Header: X-Stream-Password, Content-Type: image/jpeg
 *   Body: raw JPEG bytes
 *
 * Configure in the section below, then build and upload with PlatformIO.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "esp_camera.h"

// ============ CONFIGURATION ============
// WIFI_SSID, WIFI_PASSWORD, SERVER_URL are injected from project root .env at build time
// (see scripts/load_env.py). Define fallbacks only if .env is missing.
#ifndef WIFI_SSID
#define WIFI_SSID       "YOUR_WIFI_SSID"
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"
#endif
#ifndef SERVER_URL
#define SERVER_URL      "http://192.168.1.1:3080"
#endif
#define STREAM_ID       "esp32-cam-01"               // lowercase, 1–64 chars
#define STREAM_PASSWORD "your-stream-password"

// How often to send a frame (ms). ~100–200 = 5–10 fps; 500 = 2 fps.
#define FRAME_INTERVAL_MS  150
// ===================================================

static bool cameraOk = false;
static unsigned long lastFrameTime = 0;

void setupWiFi() {
  Serial.println();
  Serial.print("Connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("WiFi connected");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

bool setupCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_SVGA;   // 800x600 – reduce if bandwidth is tight (e.g. FRAMESIZE_VGA)
  config.jpeg_quality = 12;             // 0–63, lower = better quality, larger
  config.fb_count = 1;

#if defined(CAMERA_MODEL_ESP32S3_EYE)
  // Espressif ESP32-S3-EYE / ESP32-S3 Sense
  config.pin_d0 = 11;
  config.pin_d1 = 9;
  config.pin_d2 = 8;
  config.pin_d3 = 10;
  config.pin_d4 = 12;
  config.pin_d5 = 18;
  config.pin_d6 = 17;
  config.pin_d7 = 16;
  config.pin_xclk = 15;
  config.pin_pclk = 13;
  config.pin_vsync = 6;
  config.pin_href = 7;
  config.pin_sccb_sda = 4;
  config.pin_sccb_scl = 5;
  config.pin_pwdn = -1;
  config.pin_reset = -1;
#elif defined(CAMERA_MODEL_XIAO_ESP32S3)
  // Seeed XIAO ESP32S3 Sense
  config.pin_d0 = 15;
  config.pin_d1 = 17;
  config.pin_d2 = 18;
  config.pin_d3 = 16;
  config.pin_d4 = 14;
  config.pin_d5 = 12;
  config.pin_d6 = 11;
  config.pin_d7 = 48;
  config.pin_xclk = 10;
  config.pin_pclk = 13;
  config.pin_vsync = 38;
  config.pin_href = 47;
  config.pin_sccb_sda = 40;
  config.pin_sccb_scl = 39;
  config.pin_pwdn = -1;
  config.pin_reset = -1;
#else
  // AI-Thinker ESP32-CAM (default)
  config.pin_d0 = 5;
  config.pin_d1 = 18;
  config.pin_d2 = 19;
  config.pin_d3 = 21;
  config.pin_d4 = 36;
  config.pin_d5 = 39;
  config.pin_d6 = 34;
  config.pin_d7 = 35;
  config.pin_xclk = 0;
  config.pin_pclk = 22;
  config.pin_vsync = 25;
  config.pin_href = 23;
  config.pin_sccb_sda = 26;
  config.pin_sccb_scl = 27;
  config.pin_pwdn = 32;
  config.pin_reset = -1;
#endif

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }
  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    s->set_hmirror(s, 0);
    s->set_vflip(s, 0);
  }
  Serial.println("Camera OK");
  return true;
}

void sendFrame(const uint8_t* buf, size_t len) {
  if (len == 0) return;

  String url = String(SERVER_URL) + "/api/device/stream/" + STREAM_ID + "/frame";
  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Stream-Password", STREAM_PASSWORD);
  int code = http.POST((uint8_t*)buf, len);
  if (code == 204 || code == 200) {
    Serial.printf("Frame sent %u bytes -> %d\n", (unsigned)len, code);
  } else {
    Serial.printf("Frame POST failed: %d %s\n", code, http.getString().c_str());
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32-CAM broadcaster for sockets-2.0");

  setupWiFi();
  cameraOk = setupCamera();
  if (!cameraOk) {
    Serial.println("Camera init failed; will not send frames.");
  }
  lastFrameTime = millis();
}

void loop() {
  if (!cameraOk) {
    delay(5000);
    return;
  }

  unsigned long now = millis();
  if (now - lastFrameTime < (unsigned long)FRAME_INTERVAL_MS) {
    delay(10);
    return;
  }
  lastFrameTime = now;

  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb || fb->len == 0) {
    Serial.println("Capture failed");
    if (fb) esp_camera_fb_return(fb);
    return;
  }

  sendFrame(fb->buf, fb->len);
  esp_camera_fb_return(fb);
}
