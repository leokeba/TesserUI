// A self-hosted web UI: the node serves the TesserUI bundle (about 40 KB of
// flash) next to its API, and the interface is built from the schema and its
// hints, without UI code. Set WIFI_SSID / WIFI_PASSWORD, flash, then open
// http://<ip>/ in a browser.
//   curl http://<ip>/api/                       the values
//   curl "http://<ip>/api/?view=schema"         what the interface is built from
#include <TesserAPI.h>
#include <TesserUI.h>
#include <WiFi.h>

#ifndef WIFI_SSID
#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"
#endif

#ifndef LED_BUILTIN
#define LED_BUILTIN 2  // most ESP32 devkits
#endif

tesser::Api api;
tesser::HttpServer http(api);
tesserui::WebUi web;

enum class Mode { Steady, Breathe, Blink };

struct Lamp {
    bool on = true;
    int brightness = 128;
    Mode mode = Mode::Steady;
    char name[16] = "Desk lamp";
} lamp;

void setup() {
    Serial.begin(115200);

    api.label("Lamp");
    auto& l = api.object("lamp").label("Lamp").ui("icon", "bulb");
    l.value("on", lamp.on);
    l.value("brightness", lamp.brightness).range(0, 255).step(5);
    l.value("mode", lamp.mode, {"steady", "breathe", "blink"});
    l.value("name", lamp.name).ui("placeholder", "Lamp name");
    l.action("toggle", [] { lamp.on = !lamp.on; });

    auto& sys = api.object("system").label("System").ui("collapsed");
    sys.value("uptime", [] { return millis() / 1000; }).unit("s");
    sys.value("heap", [] { return ESP.getFreeHeap(); }).unit("B");
    sys.value("rssi", [] { return WiFi.RSSI(); }).unit("dBm").ui("widget", "chart");
    sys.action("restart", [] { ESP.restart(); }).ui("confirm", "Restart the lamp?").ui("style", "danger");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    while (WiFi.status() != WL_CONNECTED) delay(200);
    Serial.printf("http://%s/\n", WiFi.localIP().toString().c_str());

    http.enableWebSocket("/ws");
    http.begin(80, "/api");
    web.serve(http.handle(), "/api", "/ws");  // GET / and GET /ui.js
    api.startTask();                          // live values for the interface
}

void loop() {
    uint32_t t = millis();
    int duty = lamp.brightness;
    if (lamp.mode == Mode::Breathe) {
        uint32_t ramp = t % 2000 < 1000 ? t % 1000 : 1000 - t % 1000;
        duty = static_cast<int>(static_cast<uint32_t>(duty) * ramp / 1000);
    }
    if (lamp.mode == Mode::Blink && t % 1000 < 500) duty = 0;
    analogWrite(LED_BUILTIN, lamp.on ? duty : 0);
    delay(10);
}
