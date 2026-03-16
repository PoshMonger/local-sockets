"""
PlatformIO extra script: load .env from project root and inject WIFI/SERVER
as build defines so main.cpp doesn't hardcode secrets.
Reads sockets-2.0/.env (one level up from esp32-broadcaster).
"""
import os
import re

Import("env")

def load_dotenv(path):
    out = {}
    if not os.path.isfile(path):
        return out
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
            if m:
                key, val = m.group(1), m.group(2).strip()
                if val.startswith('"') and val.endswith('"'):
                    val = val[1:-1].replace('\\"', '"')
                elif val.startswith("'") and val.endswith("'"):
                    val = val[1:-1]
                out[key] = val
    return out

# .env at project root (sockets-2.0/.env)
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env_path = os.path.join(project_root, "..", ".env")
env_path = os.path.normpath(env_path)
vars = load_dotenv(env_path)

wifi_ssid = vars.get("WIFI_NAME", "YOUR_WIFI_SSID")
wifi_pass = vars.get("WIFI_PASSWORD", "YOUR_WIFI_PASSWORD")
server_ip = vars.get("SERVER_IP", "192.168.1.1")
server_port = vars.get("SERVER_PORT", "3080")
server_url = "http://%s:%s" % (server_ip, server_port)

# Use StringifyMacro so values are properly quoted for the C preprocessor
env.Append(
    CPPDEFINES=[
        ("WIFI_SSID", env.StringifyMacro(wifi_ssid)),
        ("WIFI_PASSWORD", env.StringifyMacro(wifi_pass)),
        ("SERVER_URL", env.StringifyMacro(server_url)),
    ]
)
