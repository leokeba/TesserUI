// A NowTP gateway on USB (docs/DESIGN.md section 9.7): plug this board into
// a laptop, open the launcher (https://leokeba.github.io/TesserUI/), choose
// USB and its port. The board mounts the TesserAPI nodes it hears over
// ESP-NOW under /peers, so every node around it gets a page, with live
// values, through the one serial line: a field tool that needs no Wi-Fi
// network, no HTTP server and no UI assets on any board.
//
// Channel: ESP-NOW nodes only hear each other on the same channel. Set
// NOWTP_CHANNEL to the nodes' channel (NowTpNode's, or the router's when
// they are UI hosts or Wi-Fi nodes).
//
// The serial port carries the envelopes: the launcher skips log lines, but
// a log line written in the middle of a reply would break it, so keep the
// log level low (Arduino's default "None" or "Error").
#include <NowTP.h>
#include <TesserAPI.h>
#include <TesserUI.h>

#ifndef NOWTP_CHANNEL
#define NOWTP_CHANNEL 6
#endif

tesser::Api api;
tesser::StreamTransport serialApi(api, Serial);
nowtp::EspNowTransport radio;
tesser::NowTpTransport nowApi(&api, radio);

void setup() {
    Serial.begin(115200);

    api.label("USB gateway");
    auto& sys = api.object("system").label("Gateway").ui("collapsed");
    sys.value("uptime", [] { return millis() / 1000; }).unit("s");
    sys.value("heap", [] { return ESP.getFreeHeap(); }).unit("B");
    sys.value("channel", [] { return NOWTP_CHANNEL; });
    // Discovered nodes are mounted here as they are found, and shown offline
    // when lost.
    auto& peers = api.object("peers").label("Nodes");

    // A dashboard over every node, as on a UI host: "$" stands for
    // /peers/<name>. Paths match NowTpNode's tree.
    tesserui::Views views(api);
    auto& field = views.page("field", "Field");
    field.text("Every node around the gateway, live. Open one from **Nodes** for all its controls.");
    field.each("/peers", "$/lamp/on").hint("label", "Lamp");
    field.each("/peers", "$/sensors/temperature");

    nowtp::EspNowConfig cfg;
    cfg.radio.channel = NOWTP_CHANNEL;  // no access point: the gateway picks the channel
    cfg.enableDiscovery = true;
    cfg.discovery.name = "usb-gateway";
    radio.begin(cfg);
    radio.onPeerEvent([](nowtp::PeerEvent e, const nowtp::PeerInfo& p) { nowApi.peerEvent(e, p); });
    nowApi.mountPeers(peers);
    nowApi.begin();
    api.startTask();  // change notifications, forwarded replies
}

void loop() {
    serialApi.poll();  // requests from the browser, handled here
    delay(2);
}
