// A UI host (docs/DESIGN.md section 9.5): one board with spare flash serves
// the web UI, runs a NowTP gateway and mounts the TesserAPI nodes around it
// under /peers. Flash NowTpNode on other boards, set WIFI_SSID /
// WIFI_PASSWORD here, then open http://<ip>/ : the host's own tree, a card
// of links to the nodes (each opens at #/peers/<name>, every request
// forwarded over ESP-NOW), and a "Field" page combining all of them.
//
// Wi-Fi channel: in station mode, ESP-NOW runs on the router's channel, so
// every node must use that channel (NowTpNode's NOWTP_CHANNEL). Without a
// router, run the host as a soft AP and give the nodes its channel.
//
// Partitions: the host is about 1.36 MB, past the default 1.25 MB app
// partition. Choose Tools > Partition Scheme > "Minimal SPIFFS (1.9MB APP
// with OTA)" (min_spiffs), or a larger one.
#include <NowTP.h>
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
nowtp::EspNowTransport radio;
tesser::NowTpTransport nowApi(&api, radio);

volatile bool peersChanged = false;
uint32_t peersChangedAt = 0;

void setup() {
    Serial.begin(115200);

    api.label("UI host");
    auto& sys = api.object("system").label("Host").ui("collapsed");
    sys.value("uptime", [] { return millis() / 1000; }).unit("s");
    sys.value("heap", [] { return ESP.getFreeHeap(); }).unit("B");
    sys.value("channel", [] { return WiFi.channel(); });
    // Discovered nodes are mounted here as they are found, and shown offline
    // when lost.
    auto& peers = api.object("peers").label("Nodes");

    // A dashboard page over every node: one row per mounted peer, with "$"
    // standing for /peers/<name>. Paths match NowTpNode's tree.
    tesserui::Views views(api);
    auto& field = views.page("field", "Field");
    field.text("Every node around the host, live. Open one from **Nodes** for all its controls.");
    field.each("/peers", "$/lamp/on").hint("label", "Lamp");
    field.each("/peers", "$/sensors/temperature");
    field.card("Host").widget("readout", "/system/heap", "Free heap");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    while (WiFi.status() != WL_CONNECTED) delay(200);
    Serial.printf("http://%s/  (channel %d)\n", WiFi.localIP().toString().c_str(), WiFi.channel());

    http.enableWebSocket("/ws");
    http.enableCors("https://leokeba.github.io");  // the launcher, reaching it by address
    http.begin(80, "/api");
    // ui-host.local, and listed by the launcher's bridge (DESIGN.md §9.7).
    http.advertise("ui-host", "ui-host");
    web.serve(http.handle());
    api.startTask();

    nowtp::EspNowConfig cfg;
    cfg.enableDiscovery = true;
    cfg.discovery.name = "ui-host";
    radio.begin(cfg);  // shares the router's channel
    radio.onPeerEvent([](nowtp::PeerEvent e, const nowtp::PeerInfo& p) {
        nowApi.peerEvent(e, p);
        if (e == nowtp::PeerEvent::Found) peersChanged = true;
    });
    nowApi.mountPeers(peers);
    nowApi.begin();
    nowApi.advertise();
}

void loop() {
    // Mounting a peer changes this node's schema, and so its advertised hash
    // (docs/DESIGN.md section 13): announce it again once mounts settle.
    if (peersChanged) {
        peersChanged = false;
        peersChangedAt = millis();
    }
    if (peersChangedAt && millis() - peersChangedAt > 1000) {
        peersChangedAt = 0;
        nowApi.advertise();
    }
    delay(50);
}
