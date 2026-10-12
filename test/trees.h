// Trees shared by the fixture generator (tesserui_fixtures) and the live
// demo server (tesserui_demo), so the fixtures describe exactly what the demo
// serves. Built with the real TesserAPI. Host only.
//
// A freshly built tree holds fixed values, so the fixtures are reproducible;
// tick() animates it (the demo server calls it from its main loop).
#pragma once

#include <stdint.h>

#include <string>
#include <vector>

#include "TesserAPI.h"
#include "tesserui/views.h"

namespace trees {

// Milliseconds on a steady clock.
uint32_t clockMs();

// ---- motors: helionext's motors page, with no hand-written UI ------------
// open-heliostat (branch helionext): interface/src/routes/motors and
// src/DCMotorService.*: two DC motors, each with control and persisted
// settings, plus a stop button.

struct Motor {
    double speed = 0;
    int duty = 0;
    bool direction = false;
    bool invert = false;
    double shape = 1.0;
    double minVal = 0.15;

    void setSpeed(double s);
};

struct Calibration {
    double az = 180;
    double el = 45;
    bool moving = false;
};

struct Motors {
    tesser::Api api;
    Motor azimuth;
    Motor elevation;
    Calibration calib;
    std::string log;  // /diagnostics/log, a text file node: relayed when mounted as a peer

    Motors();
};

// ---- porch lamp: a small NowTP node, mounted by the demo as a peer --------

struct PorchLamp {
    tesser::Api api;
    bool on = true;
    int brightness = 200;
    float temperature = 14.0f;

    PorchLamp();
    void tick(uint32_t nowMs);
};

// ---- demo: every widget and hint of docs/DESIGN.md sections 4 and 5 -------

enum class LampMode { Off, Auto, Manual };
enum class Effect { None, Rainbow, Breathe, Strobe, Candle, Fire };
enum class Mode { Auto, Manual };
enum class Level { Low, Mid, High };
enum class Size { XS, S, M, L, XL };
enum class Color { Red, Green, Blue };

struct Slot {
    int hour = 0;
    bool enabled = false;
    std::string label;
    int runs = 0;  // read-only: a list element field the client must not write back
};

// A Wi-Fi scan's result: the device fills the list, clients only read it.
struct Network {
    std::string ssid;
    int rssi = 0;
};

struct Channel {
    double gain = 1.0;
    bool mute = false;
};

// A named direction (helionext's sources), also an object argument.
struct Source {
    std::string name = "New";
    double azimuth = 180;
    double elevation = 30;
};

// A keyframe of a sequence (helionext's axis sequencers).
struct Frame {
    uint32_t t = 0;  // ms
    double value = 0;
};

// The argument of the login action.
struct Credentials {
    std::string name;
    std::string password;
};

struct Demo {
    tesser::Api api;
    // Two live peers behind an in-memory link standing in for NowTP:
    // /peers/heliostat-3 (the motors tree) and /peers/porch-lamp. A third,
    // /peers/kitchen-lamp, was seen once and is lost: requests below it fail.
    Motors heliostat;
    PorchLamp porch;

    const bool online = true;
    uint32_t uptime = 3600;
    // lamp
    bool on = true;
    int brightness = 180;
    char color[8] = "#ffaa00";
    LampMode mode = LampMode::Auto;
    Effect effect = Effect::Breathe;
    int level = 3;
    char name[16] = "Desk lamp";
    // motor
    double speed = 0.25;
    int duty = 40;
    double position = 123.5;
    double target = 123.5;  // moveTo
    bool invert = false;
    bool jogging = false;
    uint32_t jogMs = 0;
    double drive = 0;
    uint32_t driveMs = 0;
    int count = 0;
    double kp = 1.2, ki = 0.05, kd = 0.01;
    tesser::Pending homing;
    uint32_t homeDueMs = 0;  // 0: not homing
    // sensors
    float temperature = 21.5f;
    float humidity = 48.25f;
    float pressure = 1013.25f;
    int presses = 0;
    tesser::EventNode* pressed = nullptr;
    tesser::EventNode* homed = nullptr;
    // settings
    std::string ssid = "heliostat-net";
    std::string password = "hunter2";
    std::string notes = "Installed on the roof.\nCheck the wiring yearly.";
    // config
    Mode configMode = Mode::Manual;
    double manualSpeed = 0.5;
    bool enabled = true;
    int threshold = 12;
    std::string token = "abc123";
    int readonlyLevel = 7;
    bool dhcp = false;
    std::string ip = "192.168.1.50";
    int leaf = 42;
    // offset, channels, schedule
    double x = 0.1, y = -0.2, z = 1.5;
    Channel ch1;
    Channel ch2{0.5, true};
    std::vector<Slot> schedule{{7, true, "Morning", 12}, {19, false, "Evening", 0}};
    std::vector<Network> networks{{"home", -48}, {"cafe", -71}};
    std::string raw = "{\"curve\":[0,10,40,100]}";
    // widgets: overrides reachable only through hints
    bool sw = true;
    bool indicator = false;
    int linear = 4;
    double entry = 0.125;
    Level picker = Level::Mid;
    Size segments = Size::M;
    Color choice = Color::Green;
    std::string line = "hello";
    int display = 99;
    uint32_t hue = 0x3366ff;
    bool armed = false;
    int conditional = 5;
    std::string source = "Tower";
    std::string scene = "none";
    // sky: drawn by custom elements (<x-sun-dial>, <x-sky>)
    double sunAz = 135, sunEl = 40;
    double targetAz = 180, targetEl = 45;
    std::vector<Source> sources{{"Tower", 200, 10}, {"Pool", 150, 5}};
    // system: TesserKIT-like settings, for admins
    int days = 0x1f;  // Monday to Friday
    std::string tz = "<+01>-1<+02>,M3.5.0,M10.5.0/3";
    int64_t clockSetMs = 0;
    std::string backup;  // /system/backup, a text file node
    // tables: scalar arrays
    float offsets[16] = {};
    std::vector<int> gains{10, 40, 80};
    // sequence: keyframes (<x-keyframes>)
    std::vector<Frame> frames{{0, 0}, {2000, 30}, {5000, -20}, {8000, 0}};
    bool loop = true;
    uint32_t sequenceStartMs = 0;  // 0: stopped
    uint32_t sequencePosition = 0;

    // The links, after the trees they serve (destroyed first).
    tesser::DatagramEndpoint link;           // this node's side
    tesser::DatagramEndpoint heliostatLink;  // the peers' sides
    tesser::DatagramEndpoint porchLink;

    Demo();
    // Animates the values; call it often (every 20 ms or so).
    void tick(uint32_t nowMs);
    // Moves messages between the links and polls the peers' APIs.
    void pump(uint32_t nowMs);

private:
    uint32_t startMs_ = 0;
    uint32_t lastMs_ = 0;
    uint32_t lastPressMs_ = 0;
};

}  // namespace trees
