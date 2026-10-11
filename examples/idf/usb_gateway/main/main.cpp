// A NowTP gateway on USB with ESP-IDF (docs/DESIGN.md section 9.7): plug the
// board into a laptop, open the launcher (https://leokeba.github.io/TesserUI/),
// choose USB and its port. The board mounts the TesserAPI nodes it hears over
// ESP-NOW under /peers, so every node around it gets a page, with live values,
// through the console's UART: no Wi-Fi network, no HTTP server, no UI assets.
//
// Channel: ESP-NOW nodes only hear each other on the same channel. Set
// kChannel to the nodes' channel (the router's, for Wi-Fi nodes).
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs_flash.h"

#include "NowTP.h"
#include "TesserAPI.h"
#include "TesserUI.h"

namespace {

constexpr uint8_t kChannel = 6;

tesser::Api api;
tesser::UartTransport serialApi(api, UART_NUM_0);
nowtp::EspNowTransport radio;
tesser::NowTpTransport nowApi(&api, radio);

}  // namespace

extern "C" void app_main() {
    ESP_ERROR_CHECK(nvs_flash_init());

    api.label("USB gateway");
    auto& sys = api.object("system").label("Gateway").ui("collapsed");
    sys.value("uptime", [] { return static_cast<uint32_t>(esp_timer_get_time() / 1000000); }).unit("s");
    sys.value("heap", [] { return esp_get_free_heap_size(); }).unit("B");
    sys.value("channel", [] { return kChannel; });
    // Discovered nodes are mounted here as they are found, and shown offline
    // when lost.
    auto& peers = api.object("peers").label("Nodes");

    // A dashboard over every node: "$" stands for /peers/<name>.
    tesserui::Views views(api);
    auto& field = views.page("field", "Field");
    field.text("Every node around the gateway, live. Open one from **Nodes** for all its controls.");
    field.each("/peers", "$/lamp/on").hint("label", "Lamp");
    field.each("/peers", "$/sensors/temperature");

    nowtp::EspNowConfig cfg;
    cfg.radio.channel = kChannel;  // no access point: the gateway picks the channel
    cfg.enableDiscovery = true;
    cfg.discovery.name = "usb-gateway";
    radio.onPeerEvent([](nowtp::PeerEvent e, const nowtp::PeerInfo& p) { nowApi.peerEvent(e, p); });
    ESP_ERROR_CHECK(radio.begin(cfg) == nowtp::Status::Ok ? ESP_OK : ESP_FAIL);  // starts Wi-Fi itself
    nowApi.mountPeers(peers);
    nowApi.begin();
    api.startTask();                     // change notifications, forwarded replies
    ESP_ERROR_CHECK(serialApi.begin());  // requests from the browser, in its own task
}
