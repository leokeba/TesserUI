// A node over classic Bluetooth serial (SPP; docs/DESIGN.md section 9.7):
// pair the board with a phone or a computer, then open the launcher
// (https://leokeba.github.io/TesserUI/) in Chrome, choose USB, and pick it
// among the ports: Chrome lists paired Bluetooth serial devices with them,
// and on Android they are the only serial ports it can open. The lines are
// the serial transport's, so nothing in TesserAPI is specific to Bluetooth.
//
// ESP32 only (the C3 and S3 have Bluetooth LE alone: see the Bluetooth
// example). Bluedroid makes the sketch about 1.7 MB: use a larger app
// partition (Huge APP).
//
// Pairing is the link's only protection: like a USB cable, the line counts as
// authenticated, unless lines().setAuthenticated(false).
#include <BluetoothSerial.h>
#include <TesserAPI.h>

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

BluetoothSerial bt;
tesser::Api api;
tesser::StreamTransport btApi(api, bt);

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

    bt.begin(name);   // the name to pair with
    api.startTask();  // change notifications
}

void loop() {
    btApi.poll();  // requests from the browser, handled here
    analogWrite(LED_BUILTIN, lamp.on ? lamp.brightness : 0);
    delay(5);
}
