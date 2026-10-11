// A node over Bluetooth LE (docs/DESIGN.md section 9.7): open the launcher
// (https://leokeba.github.io/TesserUI/) in Chrome on a phone or a laptop,
// choose Bluetooth, then this board. No Wi-Fi, no UI assets: the launcher
// brings the interface, and the board only serves its tree over TesserAPI's
// BleTransport (the Nordic UART Service).
//
// Anyone in range can connect. Like an HTTP client without a token, a
// Bluetooth client is not authenticated: it gets the public access level,
// and an authorizer (Api::authorize()) decides what it may change.
#include <TesserAPI.h>
#include <tesser/transports/ble_transport.h>

#ifndef LED_BUILTIN
#define LED_BUILTIN 2  // most ESP32 devkits
#endif

tesser::Api api;
tesser::BleTransport ble(api);

struct Lamp {
    bool on = false;
    int brightness = 128;
} lamp;

void setup() {
    static char name[24];  // the tree keeps the label's pointer
    snprintf(name, sizeof(name), "tesser-%04x", static_cast<unsigned>(ESP.getEfuseMac() >> 32) & 0xffff);

    api.label(name);
    auto& l = api.object("lamp").label("Lamp").ui("icon", "bulb");
    l.value("on", lamp.on);
    l.value("brightness", lamp.brightness).range(0, 255).step(5);
    l.action("toggle", [] { lamp.on = !lamp.on; });
    auto& s = api.object("sensors").label("Sensors");
    s.value("temperature", [] { return temperatureRead(); }).unit("°C").ui("precision", 1).watch();
    s.value("uptime", [] { return millis() / 1000; }).unit("s").watch();
    s.value("heap", [] { return ESP.getFreeHeap(); }).unit("B");

    ble.begin(name);  // the name the browser's chooser shows
    api.startTask();  // change notifications
}

void loop() {
    ble.poll();  // requests from the browser, handled here
    analogWrite(LED_BUILTIN, lamp.on ? lamp.brightness : 0);
    delay(5);
}
