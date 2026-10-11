// A stub (docs/DESIGN.md section 9.6): a Wi-Fi node without the bundle
// serves a 300-byte page that loads the interface from a CDN, pinned to the
// TesserUI version it was built with. The page's origin is still the node,
// so API and WebSocket requests are same-origin, and an HTTP page may load an
// HTTPS script. Without internet access, the page says so and links to the
// raw API. Set WIFI_SSID / WIFI_PASSWORD, flash, then open http://<ip>/.
//
// To load the bundle from a UI host on the network instead:
//   web.serveStub(http.handle(), "http://192.168.1.10/ui.js");
#include <TesserAPI.h>
#include <TesserUI.h>
#include <WiFi.h>

#ifndef WIFI_SSID
#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"
#endif

tesser::Api api;
tesser::HttpServer http(api);
tesserui::WebUi web;

struct Fan {
    bool on = false;
    int speed = 50;
} fan;

void setup() {
    Serial.begin(115200);

    api.label("Fan");
    auto& f = api.object("fan").label("Fan");
    f.value("on", fan.on);
    f.value("speed", fan.speed).range(0, 100).step(10).unit("%").ui("widget", "knob");
    api.value("uptime", [] { return millis() / 1000; }).unit("s");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    while (WiFi.status() != WL_CONNECTED) delay(200);
    Serial.printf("http://%s/\n", WiFi.localIP().toString().c_str());

    http.enableWebSocket("/ws");
    http.enableCors("https://leokeba.github.io");  // the launcher, reaching it by address
    http.begin(80, "/api");
    // tesser-stub.local, and listed by the launcher's bridge (DESIGN.md §9.7).
    http.advertise("tesser-stub", "tesser-stub");
    // Pinned to this library's version: ".../tesserui@0.1.0/dist/ui.js".
    web.serveStub(http.handle(), "https://cdn.jsdelivr.net/npm/tesserui@" TESSERUI_VERSION "/dist/ui.js");
    api.startTask();
}

void loop() { delay(1000); }
