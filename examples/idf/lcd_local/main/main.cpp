// A node with a touchscreen UI and no UI code (docs/DESIGN.md section 10):
// the board's own hardware (its RGB LED, backlight and light sensor) as a
// TesserAPI tree, rendered by TesserUI's LVGL renderer through a
// LocalClient. Made for the "cheap yellow display" with two USB ports
// (board.h); another board needs its own board.cpp.
//
// The console's UART carries API envelopes too: the same tree from the
// launcher's USB way (https://leokeba.github.io/TesserUI/), or a script.
// Changes made there show on the screen, and the other way round.
#include <math.h>

#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "TesserAPI.h"
#include "TesserUI.h"
#include "board.h"

namespace {

enum class Color { White, Red, Green, Blue, Amber };

struct Led {
    bool on = true;
    int brightness = 40;
    Color color = Color::Amber;
    bool breathe = false;
};

tesser::Api api;
tesser::UartTransport serialApi(api, UART_NUM_0);
Led led;
int backlight = 80;
int blinks = 0;  // left to show, twice per blink

uint32_t now() { return static_cast<uint32_t>(esp_timer_get_time() / 1000); }

void showLed(uint32_t ms) {
    static const uint8_t rgb[][3] = {{255, 255, 255}, {255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 120, 0}};
    float level = led.on ? static_cast<float>(led.brightness) / 100.0f : 0.0f;
    if (led.on && led.breathe) level *= 0.5f + 0.5f * sinf(static_cast<float>(ms) * 0.003f);
    if (blinks > 0) level = (blinks % 2) ? 1.0f : 0.0f;
    const uint8_t* c = rgb[static_cast<int>(led.color)];
    board::led(static_cast<uint8_t>(c[0] * level), static_cast<uint8_t>(c[1] * level), static_cast<uint8_t>(c[2] * level));
}

void buildTree() {
    api.label("Yellow display");

    auto& l = api.object("led").label("LED").ui("icon", "bulb");
    l.value("on", led.on);
    l.value("brightness", led.brightness).range(0, 100).step(5).unit("%");
    l.value("color", led.color, {"white", "red", "green", "blue", "amber"});
    l.value("breathe", led.breathe).label("Breathe");
    l.action("blink", [] { blinks = 6; }).label("Blink");

    auto& d = api.object("display").label("Display");
    d.value("backlight", [] { return backlight; },
            [](int v) {
                backlight = v;
                board::backlight(static_cast<uint8_t>(v));
            })
        .range(10, 100)
        .step(5)
        .unit("%");

    auto& s = api.object("sensors").label("Sensors");
    s.value("light", [] { return static_cast<int>(board::light()); }).unit("%").watch();
    s.value("uptime", [] { return static_cast<uint32_t>(esp_timer_get_time() / 1000000); }).unit("s").watch();

    auto& sys = api.object("system").label("System").ui("advanced");
    sys.value("heap", [] { return esp_get_free_heap_size(); }).unit("B").watch();
    sys.value("minHeap", [] { return esp_get_minimum_free_heap_size(); }).unit("B").label("Lowest heap").watch();
    auto& drv = sys.object("drivers").label("Drivers");
    drv.value("flushes", [] { return board::stats().flushes; }).watch();
    drv.value("flushed", [] { return board::stats().flushed; }).watch();
    drv.value("touches", [] { return board::stats().touches; }).watch();
    drv.value("x", [] { return board::stats().x; }).watch();
    drv.value("y", [] { return board::stats().y; }).watch();
    drv.value("lightRaw", [] { return board::lightRaw(); }).label("Light (raw)").watch();
    sys.action("restart", [] { esp_restart(); }).ui("confirm", "Restart the board?").ui("style", "danger");
}

}  // namespace

extern "C" void app_main() {
    buildTree();
    lv_init();
    lv_display_t* display = board::begin();
    board::backlight(static_cast<uint8_t>(backlight));

    tesser::LocalClient client(api);
    tesserui::LvglUi ui(client, display);
    ui.begin("/");
    ESP_ERROR_CHECK(serialApi.begin());  // requests over the console, in its own task

    uint32_t lastBlink = 0;
    for (;;) {
        uint32_t ms = now();
        if (blinks > 0 && ms - lastBlink >= 150) {
            lastBlink = ms;
            blinks--;
        }
        showLed(ms);
        api.poll(ms);  // change notifications and watched values
        ui.loop();
        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(5) ? pdMS_TO_TICKS(5) : 1);  // at least a tick: the idle task must run
    }
}
