#include "trees.h"

#include <string.h>

#include <math.h>

#include <chrono>

namespace trees {

uint32_t clockMs() {
    using namespace std::chrono;
    static const steady_clock::time_point start = steady_clock::now();
    return static_cast<uint32_t>(duration_cast<milliseconds>(steady_clock::now() - start).count()) + 1;
}

namespace {

// Addresses on the in-memory link (NowTP MACs).
const uint8_t kHostMac[6] = {0x24, 0x6f, 0x28, 0x00, 0x00, 0x01};
const uint8_t kHeliostatMac[6] = {0x24, 0x6f, 0x28, 0x01, 0x02, 0x03};
const uint8_t kKitchenMac[6] = {0x24, 0x6f, 0x28, 0x04, 0x05, 0x06};
const uint8_t kPorchMac[6] = {0x24, 0x6f, 0x28, 0x07, 0x08, 0x09};

tesser::PeerAddress mac(const uint8_t* bytes) { return tesser::PeerAddress::fromBytes(bytes, 6); }

// True once `due` (a clockMs() time) has passed.
bool reached(uint32_t now, uint32_t due) { return static_cast<int32_t>(now - due) >= 0; }

}  // namespace

// ---- motors ----------------------------------------------------------------

void Motor::setSpeed(double s) {
    direction = s < 0;
    double a = s < 0 ? -s : s;
    double d = a < 0.001 ? 0.0 : minVal + (1.0 - minVal) * pow(a, shape);
    duty = static_cast<int>(d * 100.0 + 0.5);
    speed = s;
}

void describe(tesser::Object& o, Motor& m) {
    auto& c = o.object("control");
    c.value("speed", [&m] { return m.speed; }, [&m](double v) { m.setSpeed(v); })
        .range(-1, 1)
        .step(0.01)
        .label("Speed")
        .watch();
    c.value("duty", [&m] { return m.duty; }, [&m](int d) { m.duty = d; })
        .range(0, 100)
        .unit("%")
        .label("Duty cycle")
        .watch();
    c.value("direction", [&m] { return m.direction; }, [&m](bool d) { m.direction = d; }).watch();
    auto& cfg = o.object("config").label("Settings").ui("collapsed").persist();
    cfg.value("invert", m.invert).label("Invert direction");
    cfg.value("shape", m.shape).range(0, 1).step(0.01);
    cfg.value("minVal", m.minVal).range(0, 1).step(0.01).label("Min value");
    o.action("stop", [&m] { m.setSpeed(0); }).ui("style", "danger").ui("icon", "stop");
}

Motors::Motors() {
    azimuth.setSpeed(0.3);
    api.label("Heliostat");
    api.mount("azimuth", azimuth).label("Azimuth motor");
    api.mount("elevation", elevation).label("Elevation motor");
    // A form: both targets are sent with "go" in one patch.
    auto& cal = api.object("calibration").label("Calibration").ui("form");
    cal.value("az", calib.az).range(0, 360).step(0.1).unit("°").label("Azimuth target");
    cal.value("el", calib.el).range(0, 90).step(0.1).unit("°").label("Elevation target");
    cal.action("go", [this] { calib.moving = true; }).label("Go").ui("style", "primary");
    // A file node, which the demo's gateway relays (TesserAPI §14): the log
    // spans two download chunks.
    for (int i = 0; i < 200; i++) log += "tracking: azimuth " + std::to_string(i) + "\n";
    api.object("diagnostics").label("Diagnostics").file("log")
        .text([this] { return log; },
              [this](std::string_view text, tesser::JsonWriter& reply) {
                  log.assign(text.data(), text.size());
                  reply.uinteger(log.size());
                  return tesser::Check::ok();
              })
        .contentType("text/plain")
        .label("Log");
}

// ---- porch lamp --------------------------------------------------------------

PorchLamp::PorchLamp() {
    api.label("Porch lamp");
    auto& l = api.object("lamp").label("Lamp").ui("icon", "bulb");
    l.value("on", on).watch();
    l.value("brightness", brightness).range(0, 255).step(5);
    l.action("toggle", [this] { on = !on; });
    auto& s = api.object("sensors");
    s.value("temperature", [this] { return temperature; }).unit("°C").ui("precision", 1).watch();
    // A view of its own, read through the gateway and shown in its tab
    // (DESIGN.md §6.5): its paths are the lamp's.
    tesserui::Views views(api);
    views.page("porch", "Porch").icon("eye").node("/lamp");
}

void PorchLamp::tick(uint32_t nowMs) {
    temperature = 14.0f + 2.0f * static_cast<float>(sin(nowMs / 30000.0));
}

// ---- demo ----------------------------------------------------------------------

void describe(tesser::Object& o, Slot& s) {
    o.value("hour", s.hour).range(0, 23);
    o.value("enabled", s.enabled);
    o.value("label", s.label);
    o.value("runs", s.runs).readOnly();
}

void describe(tesser::Object& o, Network& n) {
    o.value("ssid", n.ssid).label("Network");
    o.value("rssi", n.rssi).unit("dBm");
    o.action("join", [] {});  // actions still run in a read-only list
}

void describe(tesser::Object& o, Channel& c) {
    o.value("gain", c.gain).range(0, 2).step(0.1);
    o.value("mute", c.mute);
}

void describe(tesser::Object& o, Source& s) {
    o.value("name", s.name);
    o.value("azimuth", s.azimuth).range(0, 360).unit("°");
    o.value("elevation", s.elevation).range(0, 90).unit("°");
}

void describe(tesser::Object& o, Frame& f) {
    o.value("t", f.t).unit("ms");
    o.value("value", f.value).range(-90, 90).unit("°");
}

void describe(tesser::Object& o, Credentials& c) {
    o.value("name", c.name);
    o.value("password", c.password).secret();
}

Demo::Demo()
    : link(&api, tesser::TransportKind::NowTP,
           [this](const tesser::PeerAddress& to, const std::string& m, tesser::Delivery) {
               if (to == mac(kHeliostatMac)) {
                   heliostatLink.receive(mac(kHostMac), m.data(), m.size(), true);
               } else if (to == mac(kPorchMac)) {
                   porchLink.receive(mac(kHostMac), m.data(), m.size(), true);
               } else {
                   return false;  // kitchen-lamp: gone
               }
               return true;
           },
           &clockMs),
      heliostatLink(&heliostat.api, tesser::TransportKind::NowTP,
                    [this](const tesser::PeerAddress&, const std::string& m, tesser::Delivery) {
                        link.receive(mac(kHeliostatMac), m.data(), m.size(), true);
                        return true;
                    },
                    &clockMs),
      porchLink(&porch.api, tesser::TransportKind::NowTP,
                [this](const tesser::PeerAddress&, const std::string& m, tesser::Delivery) {
                    link.receive(mac(kPorchMac), m.data(), m.size(), true);
                    return true;
                },
                &clockMs) {
    api.label("TesserUI demo").ui("columns", 3);
    api.value("uptime", [this] { return uptime; }).unit("s").watch();
    api.value("online", online);

    auto& lamp = api.object("lamp").label("Lamp").ui("icon", "bulb");
    lamp.value("on", on).watch();
    lamp.value("brightness", brightness).range(0, 255).step(5).watch();
    lamp.value("color", color).ui("widget", "color");
    lamp.value("mode", mode, {"off", "auto", "manual"}).ui("labels", "Off,Automatic,Manual");
    lamp.value("effect", effect, {"none", "rainbow", "breathe", "strobe", "candle", "fire"});
    lamp.value("level", level);
    lamp.value("power", [this] { return on ? static_cast<float>(brightness) * 0.2f : 0.0f; })
        .range(0, 60)
        .unit("W")
        .ui("widget", "gauge")
        .watch();
    lamp.value("name", name).ui("placeholder", "Lamp name");
    lamp.action("toggle", [this] { on = !on; });
    lamp.action("preset", [this](int n) { brightness = n * 50; })
        .label("Preset 3")
        .ui("widget", "button")
        .ui("value", 3);

    auto& motor = api.object("motor").label("Motor");
    motor.value("speed", speed).range(-1, 1).step(0.01).ui("widget", "knob").watch();
    motor.value("duty", duty).range(0, 100).unit("%").ui("widget", "stepper");
    motor.value("position", [this] { return position; })
        .unit("°")
        .ui("widget", "chart")
        .ui("history", 30)
        .watch();
    motor.value("invert", invert).ui("widget", "checkbox");
    // Dead-man timers, as TesserMotion's: the jog and the manual drive stop
    // unless called or rewritten within a second (DESIGN.md §7.4). The UI
    // repeats the hold's true, and keeps the drive alive while it isn't 0.
    motor.action("jog", [this](bool down) {
        jogging = down;
        jogMs = lastMs_;
    }).ui("widget", "hold");
    motor.value("jogging", [this] { return jogging; }).watch();
    motor.value("drive", [this] { return drive; }, [this](double v) {
        drive = v;
        driveMs = lastMs_;
    }).range(-1, 1).step(0.01).ui("keepalive", 400).watch();
    motor.action("moveTo", [this](float deg) { target = deg; })
        .range(0, 360)
        .unit("°")
        .ui("confirm", "Move the mirror?");
    motor.action("stop", [this] {
             speed = 0;
             jogging = false;
             target = position;
         })
        .ui("style", "danger")
        .ui("icon", "stop");
    // Deferred: replied to by tick() once homing completes, 2 s later, as
    // real firmware would from a timer or another task.
    motor.action("home", [this](tesser::Call& call) {
        homing = call.defer();
        if (homing) homeDueMs = clockMs() + 2000;
    });
    motor.action("count", [this] { return ++count; }).ui("style", "quiet");
    // A moment with no place on screen: a toast wherever the user is.
    homed = &motor.event("homed").ui("toast", "ok").ui("hidden");
    auto& pid = motor.object("pid").ui("advanced");
    pid.value("kp", kp);
    pid.value("ki", ki);
    pid.value("kd", kd);

    auto& sensors = api.object("sensors");
    sensors.value("temperature", [this] { return temperature; }).unit("°C").ui("precision", 1).watch();
    sensors.value("humidity", [this] { return humidity; }).range(0, 100).unit("%").ui("widget", "bar").watch();
    sensors.value("pressure", [this] { return pressure; }).ui("format", "%.0f hPa").watch();
    sensors.value("status", [this] {
               return std::string(homeDueMs ? "homing" : target != position ? "moving" : "ok");
           })
        .watch();
    pressed = &sensors.event("pressed");
    sensors.custom(
        "raw", [this](tesser::JsonWriter& w) { w.raw(raw); },
        [this](JsonVariantConst v) {
            raw.clear();
            serializeJson(v, raw);
            return tesser::Status::Ok;
        });

    auto& settings = api.object("settings").label("Settings").ui("form").persist();
    settings.value("ssid", ssid);
    settings.value("password", password).secret();
    settings.value("notes", notes).ui("widget", "textarea");
    settings.action("apply", [] {}).ui("submit");

    auto& config = api.object("config");
    config.value("mode", configMode, {"auto", "manual"});
    config.value("manualSpeed", manualSpeed).range(0, 1).ui("visibleWhen", "mode=manual");
    config.value("enabled", enabled);
    config.value("threshold", threshold).ui("enabledWhen", "enabled=true");
    config.value("token", token).ui("hidden");
    config.value("readonlyLevel", readonlyLevel).ui("readonly");
    auto& network = config.object("network").ui("collapsed");
    network.value("dhcp", dhcp);
    network.value("ip", ip).ui("visibleWhen", "dhcp=false");
    network.value("staticWarning", [] { return std::string("Make sure no other device on the network uses this address."); })
        .label("Static address")
        .ui("style", "warning")
        .ui("visibleWhen", "dhcp=false");
    // A fourth level below the root page, for lazy schema fetches.
    network.object("deep").object("deeper").value("leaf", leaf);

    auto& offset = api.object("offset").ui("inline");
    offset.value("x", x);
    offset.value("y", y);
    offset.value("z", z);

    auto& channels = api.object("channels").ui("tabs");
    channels.mount("ch1", ch1);
    channels.mount("ch2", ch2);

    api.list("schedule", schedule).maxSize(8);
    // Filled by the device: no adding, removing or editing (TesserAPI a2b0002).
    api.list("networks", networks).readOnly().label("Networks nearby");

    auto& info = api.object("info").ui("page").label("Device info");
    info.value("version", "1.2.0");
    info.value("build", "2026-10-10 a1b2c3d");
    info.action("restart", [] {}).ui("confirm", "Restart the device?").ui("style", "danger");

    // Hints with no tier 0 equivalent: every explicit widget, a color as an
    // integer, confirm on a value, a string button value, a description,
    // compound conditions, and a nested object promoted to a card.
    auto& widgets = api.object("widgets").label("Widget overrides");
    widgets.value("switch", sw).ui("widget", "toggle");
    widgets.value("indicator", indicator).ui("widget", "led");
    widgets.value("linear", linear).range(0, 10).ui("widget", "slider");
    widgets.value("entry", entry).range(0, 1).step(0.001).ui("widget", "number");
    widgets.value("picker", picker, {"low", "mid", "high"}).ui("widget", "select");
    widgets.value("segments", segments, {"xs", "s", "m", "l", "xl"}).ui("widget", "segmented");
    widgets.value("choice", choice, {"red", "green", "blue"}).ui("widget", "radio");
    widgets.value("line", line).ui("widget", "text").doc("A description, shown as help text.");
    widgets.value("display", display).ui("widget", "readout");
    widgets.value("hue", hue).range(0, 0xffffff).ui("widget", "color");
    widgets.value("armed", armed).ui("confirm", "Really change it?");
    widgets.value("conditional", conditional).ui("visibleWhen", "/config/enabled=true&../config/mode!=auto");
    // A choice among a keyed list's current keys, and a fixed one.
    widgets.value("source", source).ui("options", "/sky/sources").ui("optionsExtra", "Sun");
    // A choice among the nodes under /peers, offline ones marked.
    widgets.value("node", node).ui("options", "/peers");
    // The same, storing the device's id (its MAC) rather than its name.
    widgets.value("nodeId", nodeId).ui("options", "/peers").ui("optionsValue", "id").label("Node id");
    widgets.action("go", [] {}).ui("style", "primary");
    widgets.action("scene", [this](std::string s) { scene = s; }).ui("widget", "button").ui("value", "sunset");
    widgets.object("pinned").ui("card").value("note", "A nested object shown as its own card.");

    // A custom element draws this object whole (DESIGN.md §9.8): the sun and
    // a target set by clicking the sky. The script is served by the node, or
    // by the host page (web/scripts/device.mjs serves examples/elements).
    auto& sky = api.object("sky").label("Sky").ui("widget", "x-sun-dial").ui("script", "/ext/sun-dial.js");
    sky.value("sunAz", [this] { return sunAz; }).unit("°").watch();
    sky.value("sunEl", [this] { return sunEl; }).unit("°").watch();
    sky.value("targetAz", targetAz).range(0, 360).unit("°").watch();
    sky.value("targetEl", targetEl).range(0, 90).unit("°").watch();
    // Keyed: /sky/sources/Tower, and rows matched by name on writes.
    sky.list("sources", sources).maxSize(8).key("name");
    // An object argument: one field per value of Source.
    sky.action("addSource", [this](const Source& s) { sources.push_back(s); }).label("Add source");

    // A keyframe sequence, drawn and edited by <x-keyframes>.
    auto& seq = api.object("sequence").label("Sequence").ui("widget", "x-keyframes").ui("script", "/ext/keyframes.js");
    seq.list("frames", frames).maxSize(16).label("Azimuth");
    seq.value("loop", loop);
    seq.value("running", [this] { return sequenceStartMs != 0; }).watch();
    seq.value("position", [this] { return sequencePosition; }).unit("ms").watch();
    seq.action("start", [this] { sequenceStartMs = clockMs(); });
    seq.action("stop", [this] { sequenceStartMs = 0; });
    seq.action("clear", [this] { frames.clear(); });

    // Scalar arrays: a calibration table drawn as a chart, an editable one,
    // and an order that means something, rows moved up and down.
    for (int i = 0; i < 16; i++) offsets[i] = static_cast<float>(2.0 * sin(i * 3.14159265358979 / 8.0));
    auto& tables = api.object("tables").label("Tables");
    tables.array("offsets", offsets).readOnly().unit("°").ui("widget", "chart").label("Encoder offsets");
    tables.array("gains", gains).range(0, 100).maxSize(6);
    tables.array("priority", priority).ui("reorder").label("Transport priority");

    // What TesserKIT's services declare: admin-only settings, secrets,
    // flags, a time zone, the browser's clock, sign-in.
    auto& system = api.object("system").label("System").writeAccess(tesser::Access::Admin);
    system.value("days", days).label("Timer days").ui("widget", "flags").ui("labels", "Mon,Tue,Wed,Thu,Fri,Sat,Sun");
    system.value("tz", tz).label("Time zone").ui("widget", "timezone");
    system.value("clockSet", [this] { return clockSetMs; }).unit("ms").label("Clock set to").watch();
    system.action("setClock", [this](int64_t ms) { clockSetMs = ms; }).label("Set from this device").ui("value", "$now");
    // A file node: over a line, downloaded and uploaded in chunks
    // (TesserAPI §10.1.1); the default backup spans two download chunks.
    backup = "{\"entries\":[";
    for (int i = 0; i < 400; i++) backup += (i ? ",\"entry " : "\"entry ") + std::to_string(i) + "\"";
    backup += "]}";
    system.file("backup")
        .text([this] { return backup; },
              [this](std::string_view text, tesser::JsonWriter& reply) {
                  backup.assign(text.data(), text.size());
                  reply.uinteger(backup.size());
                  return tesser::Check::ok();
              })
        .contentType("application/json")
        .label("Backup");
    // A typed deferred action: its argument, then a reply later.
    system.action("scan", [](std::string prefix, tesser::Call& call) {
        tesser::Pending p = call.defer();
        p.reply(std::string(prefix) + "-net");
    });
    // A log, like TesserKIT's /sys/log: one ESP-IDF line per event.
    log = &system.event("log").label("Log").ui("widget", "log").ui("lines", 200);
    // Public: a node requires its ancestors' levels, so sign-in can't live
    // below the admins' object.
    auto& auth = api.object("account").label("Account");
    auth.action("login", [](const Credentials& c, tesser::Call& call) {
            if (c.name != "admin" || c.password != "admin") return call.fail(tesser::Status::Unauthorized, "wrong name or password");
            call.replyWith([](tesser::JsonWriter& w) {
                w.beginObject();
                w.key("token");
                w.string("demo-token");
                w.key("access");
                w.string("admin");
                w.endObject();
            });
        })
        .ui("auth", "login");
    auth.action("whoami", [](tesser::Call& call) { call.reply(tesser::toString(call.client().level())); }).ui("auth", "whoami").ui("hidden");

    api.custom("blob", [](tesser::JsonWriter& w) { w.raw("{\"a\":1,\"b\":[1,2]}"); });

    // Discovered peers, as a UI host shows them: two live ones, advertising
    // their real schema hash, and one lost.
    auto& peers = api.object("peers").label("Nodes");
    link.mountPeers(peers);
    link.peerSeen(mac(kHeliostatMac), "heliostat-3", heliostat.api.schemaHash());
    link.peerSeen(mac(kKitchenMac), "kitchen-lamp", 0x99f0e1aa);
    link.peerSeen(mac(kPorchMac), "porch-lamp", porch.api.schemaHash());
    link.process();
    link.forgetPeer(mac(kKitchenMac));
    link.process();

    tesserui::Views views(api);
    auto& overview = views.page("overview", "Overview").icon("eye");
    overview.row().widget("gauge", "/lamp/power").widget("readout", "/sensors/temperature");
    overview.card("Motor").node("/motor");
    overview.card("Sequence").widget("x-keyframes", "/sequence");
    overview.hint("wide", true);  // the timeline wants the width
    overview.text("Live values from **every** node.");
    overview.each("/peers", "$/lamp/on");
    // A view whose only item is a custom element: a custom page.
    views.page("sky", "Sky").widget("x-sun-dial", "/sky");
    views.page("mirror", "Mirror").widget("x-sky", "/sky").hint("script", "/ext/sky.js");
}

void Demo::tick(uint32_t nowMs) {
    if (!startMs_) startMs_ = lastMs_ = lastPressMs_ = lastLogMs_ = nowMs;
    double dt = (nowMs - lastMs_) / 1000.0;
    double t = (nowMs - startMs_) / 1000.0;
    lastMs_ = nowMs;

    uptime = 3600 + (nowMs - startMs_) / 1000;
    // The sun crosses the sky in two minutes, east to west.
    double day = fmod(t / 120.0, 1.0);
    sunAz = 90.0 + 180.0 * day;
    sunEl = 60.0 * sin(3.14159265358979 * day);
    temperature = 21.5f + 1.5f * static_cast<float>(sin(t / 20.0));
    humidity = 48.25f + 6.0f * static_cast<float>(sin(t / 33.0));
    pressure = 1013.25f + 3.0f * static_cast<float>(sin(t / 61.0));

    if (jogging && nowMs - jogMs > 1000) jogging = false;
    if (drive != 0 && nowMs - driveMs > 1000) drive = 0;
    // The motor: toward the moveTo target at 90 °/s, else by jog (30 °/s)
    // and speed and drive (60 °/s at full). Values in [0, 360).
    if (target != position) {
        double step = 90.0 * dt;
        double d = target - position;
        if (d > step) {
            position += step;
        } else if (d < -step) {
            position -= step;
        } else {
            position = target;
        }
    } else {
        position += (jogging ? 30.0 : 0.0) * dt + (speed + drive) * 60.0 * dt;
        position = fmod(position, 360.0);
        if (position < 0) position += 360.0;
        target = position;
    }

    if (homeDueMs && reached(nowMs, homeDueMs)) {
        homeDueMs = 0;
        position = target = 0;
        speed = 0;
        homing.reply(position);
        homing = tesser::Pending();
        homed->emit(std::string("at 0°"));
    }

    if (sequenceStartMs) {
        uint32_t end = frames.empty() ? 0 : frames.back().t;
        uint32_t t = nowMs - sequenceStartMs;
        if (end && loop) t %= end;
        if (end && !loop && t >= end) {
            t = end;
            sequenceStartMs = 0;
        }
        sequencePosition = t;
    }

    if (reached(nowMs, lastPressMs_ + 5000)) {
        lastPressMs_ = nowMs;
        pressed->emit(++presses);
    }
    if (reached(nowMs, lastLogMs_ + 3000)) {
        lastLogMs_ = nowMs;
        static const char* const kLines[] = {"I demo: tick", "I wifi: connected to heliostat-net on channel 6 at -52 dBm, ip 192.168.1.50, gateway 192.168.1.1, dns 192.168.1.1", "W mqtt: can't resolve the broker's name", "I demo: tick",
                                             "E sensor: read timed out"};
        const char* text = kLines[logLines++ % 5];
        log->emit(std::string(1, text[0]) + " (" + std::to_string(nowMs - startMs_) + ") " + (text + 2));
    }

    porch.tick(nowMs);
}

void Demo::hear(const char* name, bool heard) {
    uint8_t bytes[6] = {0x24, 0x6f, 0x28, 0x0a, 0x00, 0x00};
    if (strcmp(name, "kitchen-lamp") == 0) {
        memcpy(bytes, kKitchenMac, 6);
    } else if (strcmp(name, "porch-lamp") == 0) {
        memcpy(bytes, kPorchMac, 6);
    } else {
        for (const char* c = name; *c; c++) bytes[5] = static_cast<uint8_t>(bytes[5] * 31 + *c);
    }
    if (heard) {
        link.peerSeen(mac(bytes), name, strcmp(name, "porch-lamp") == 0 ? porch.api.schemaHash() : 0x99f0e1aa);
    } else {
        link.forgetPeer(mac(bytes));
    }
    link.process();
}

void Demo::pump(uint32_t nowMs) {
    for (int i = 0; i < 16; i++) {
        bool any = link.process();
        any = heliostatLink.process() || any;
        any = porchLink.process() || any;
        if (!any) break;
    }
    heliostat.api.poll(nowMs);
    porch.api.poll(nowMs);
}

}  // namespace trees
