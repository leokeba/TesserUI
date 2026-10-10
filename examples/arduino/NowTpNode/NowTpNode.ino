// The smallest TesserUI node (docs/DESIGN.md section 2): NowTP only, no
// Wi-Fi connection, no HTTP and no UI assets. Its tree and hint literals are
// all it stores; a UI host (UiHost) mounts it and renders its interface.
//
// Channel: ESP-NOW nodes only hear each other on the same Wi-Fi channel, and
// a UI host in station mode uses its router's. Set NOWTP_CHANNEL to that
// channel (the host prints it at boot).
#include <NowTP.h>
#include <TesserAPI.h>

#ifndef NOWTP_CHANNEL
#define NOWTP_CHANNEL 6
#endif

#ifndef LED_BUILTIN
#define LED_BUILTIN 2  // most ESP32 devkits
#endif

tesser::Api api;
nowtp::EspNowTransport radio;
tesser::NowTpTransport nowApi(&api, radio);

struct Lamp {
    bool on = false;
    int brightness = 128;
} lamp;

float temperature() { return temperatureRead(); }  // the chip's own sensor

void setup() {
    Serial.begin(115200);

    char name[24];
    snprintf(name, sizeof(name), "lamp-%04x", static_cast<unsigned>(ESP.getEfuseMac() >> 32) & 0xffff);

    api.label("Lamp");
    auto& l = api.object("lamp").label("Lamp").ui("icon", "bulb");
    l.value("on", lamp.on);
    l.value("brightness", lamp.brightness).range(0, 255).step(5);
    l.action("toggle", [] { lamp.on = !lamp.on; });
    auto& s = api.object("sensors").label("Sensors");
    s.value("temperature", [] { return temperature(); }).unit("°C").ui("precision", 1).watch();
    s.value("uptime", [] { return millis() / 1000; }).unit("s");

    nowtp::EspNowConfig cfg;
    cfg.radio.channel = NOWTP_CHANNEL;  // no access point: this node picks the channel
    cfg.enableDiscovery = true;
    cfg.discovery.name = name;  // the host mounts it as /peers/<name>
    radio.begin(cfg);
    nowApi.begin();
    nowApi.advertise();  // once the tree is complete
    api.startTask();     // change notifications for the host's subscriptions
    Serial.printf("%s on channel %d\n", name, NOWTP_CHANNEL);
}

void loop() {
    analogWrite(LED_BUILTIN, lamp.on ? lamp.brightness : 0);
    delay(20);
}
