// A self-hosted web UI with ESP-IDF: the node serves the TesserUI bundle next
// to its API. Set the Wi-Fi network with `idf.py menuconfig` (Example
// Connection Configuration), flash, then open http://<ip>/ in a browser.
//   curl http://<ip>/api/
//   curl "http://<ip>/api/?view=schema"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "protocol_examples_common.h"

#include "TesserAPI.h"
#include "TesserUI.h"

namespace {

enum class Mode { Steady, Breathe, Blink };

struct Led {
    bool on = true;
    int brightness = 128;
    Mode mode = Mode::Steady;
} led;

char deviceName[32] = "led-01";

tesser::Api api;
tesser::HttpServer http(api);
tesserui::WebUi web;

}  // namespace

static void startApi() {
    api.label("LED");
    auto& l = api.object("led").label("LED").ui("icon", "bulb");
    l.value("on", led.on);
    l.value("brightness", led.brightness).range(0, 255).step(5).doc("PWM duty");
    l.value("mode", led.mode, {"steady", "breathe", "blink"});
    l.action("toggle", [] { led.on = !led.on; });

    auto& sys = api.object("system").label("System").ui("collapsed");
    sys.value("name", deviceName).ui("placeholder", "Device name");
    sys.value("uptime", [] { return static_cast<uint32_t>(esp_timer_get_time() / 1000000); }).unit("s");
    sys.value("freeHeap", [] { return esp_get_free_heap_size(); }).unit("B").ui("widget", "chart");
    sys.action("restart", [] { esp_restart(); }).ui("confirm", "Restart the device?").ui("style", "danger");

    // A view page: the controls that matter, first.
    tesserui::Views views(api);
    auto& home = views.page("home", "Home");
    home.row().widget("toggle", "/led/on", "On").widget("readout", "/led/brightness", "Brightness");
    home.card("LED").node("/led");

    http.enableWebSocket("/ws");
    ESP_ERROR_CHECK(http.begin(80, "/api"));
    web.minVersion("0.1.0");
    ESP_ERROR_CHECK(web.serve(http.handle(), "/api", "/ws"));  // GET / and GET /ui.js
    api.startTask();                                           // live values for the interface
}

extern "C" void app_main() {
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(example_connect());
    startApi();
}
