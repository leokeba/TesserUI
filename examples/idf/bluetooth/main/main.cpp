// A node over Bluetooth LE with ESP-IDF (docs/DESIGN.md section 9.7): open
// the launcher (https://leokeba.github.io/TesserUI/) in Chrome on a phone or
// a laptop, choose Bluetooth, then this board. No Wi-Fi and no UI assets:
// the board serves its tree over TesserAPI's BleTransport (NimBLE, the
// Nordic UART Service).
//
// Anyone in range can connect. Like an HTTP client without a token, a
// Bluetooth client is not authenticated: it gets the public access level,
// and an authorizer (Api::authorize()) decides what it may change.
#include <stdio.h>

#include "esp_mac.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs_flash.h"

#include "TesserAPI.h"
#include "tesser/transports/ble_transport.h"

namespace {

struct Lamp {
    bool on = false;
    int brightness = 128;
} lamp;

char name[24];  // the tree keeps the label's pointer

tesser::Api api;
tesser::BleTransport ble(api);

}  // namespace

extern "C" void app_main() {
    ESP_ERROR_CHECK(nvs_flash_init());  // NimBLE keeps its state there
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    snprintf(name, sizeof(name), "tesser-%02x%02x", mac[4], mac[5]);

    api.label(name);
    auto& l = api.object("lamp").label("Lamp").ui("icon", "bulb");
    l.value("on", lamp.on);
    l.value("brightness", lamp.brightness).range(0, 255).step(5);
    l.action("toggle", [] { lamp.on = !lamp.on; });
    auto& s = api.object("sensors").label("Sensors");
    s.value("uptime", [] { return static_cast<uint32_t>(esp_timer_get_time() / 1000000); }).unit("s").watch();
    s.value("heap", [] { return esp_get_free_heap_size(); }).unit("B").ui("widget", "chart");

    ESP_ERROR_CHECK(ble.begin(name));  // the name the browser's chooser shows
    api.startTask();                   // change notifications
    printf("%s advertising\n", name);
}
