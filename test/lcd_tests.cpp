// The LVGL renderer against real TesserAPI trees: taps on the host screen,
// checked against the device's values, and the device's changes, checked on
// screen (docs/DESIGN.md section 11).
//
//   ./tesserui_lcd_tests [filter]
#include <math.h>
#include <string.h>

#include <string>

#include "TesserAPI.h"
#include "check.h"
#include "lcd_host.h"
#include "tesserui/lvgl_ui.h"

namespace {

// A small node: one of each widget the renderer draws.
struct Node {
    tesser::Api api;
    bool on = false;
    bool ready = true;
    int level = 10;
    double gain = 0.5;
    int count = 3;
    int mode = 0;  // an enum through a string
    char name[9] = "lamp";  // maxLength 8
    int presses = 0;
    int resets = 0;

    Node() {
        auto& lamp = api.object("lamp");
        lamp.value("on", on);
        lamp.value("ready", ready).readOnly();
        lamp.value("level", level).range(0, 100).unit("%");
        lamp.value("gain", gain).range(0, 1).step(0.05);
        lamp.value("count", count);
        lamp.value("name", name);
        lamp.action("press", [this] { presses++; });
        lamp.action("reset", [this] { resets++; }).ui("confirm", "Reset the lamp?");
        auto& more = api.object("more");
        more.value("count", count);
    }
};

struct Rig {
    Node node;
    tesser::LocalClient client{node.api};
    lcd::Screen screen;
    tesserui::LvglUi ui{client, screen.display()};
    std::function<void()> each = [this] {
        node.api.poll(lv_tick_get());  // coalesced notifications go out here, on the screen's clock
        ui.loop();
    };

    Rig() {
        ui.begin("/");
        screen.run(200, each);
    }
    void open(const char* path) {
        ui.open(path);
        screen.run(300, each);
    }
    // The value shown on the label's own row (a readout, or a slider's).
    std::string text(const char* labelText) {
        lv_obj_t* l = screen.label(labelText);
        if (!l) return "(no label)";
        lv_obj_t* row = lv_obj_get_parent(l);
        lv_obj_t* v = lv_obj_get_child(row, static_cast<int32_t>(lv_obj_get_child_count(row)) - 1);
        if (v == l || !lv_obj_check_type(v, &lv_label_class)) return "(no value)";
        return lv_label_get_text(v);
    }
    // A value changed by the device, as another client would.
    void deviceSet(const char* path, const char* json) {
        tesser::LocalClient other(node.api);
        other.set(path, json);
        other.process();
        screen.run(300, each);
    }
};

}  // namespace

TEST(lcd_menu_lists_entries) {
    Rig r;
    CHECK(r.ui.current().empty());
    CHECK(r.screen.label("Lamp") != nullptr);
    CHECK(r.screen.label("More") != nullptr);
    r.screen.tap(r.screen.label("Lamp"), r.each);
    r.screen.run(300, r.each);
    CHECK_EQ(r.ui.current(), "/lamp");
    CHECK(r.screen.label("Level") != nullptr);
    r.ui.back();
    r.screen.run(100, r.each);
    CHECK(r.ui.current().empty());
}

TEST(lcd_toggle_writes) {
    Rig r;
    r.open("/lamp");
    lv_obj_t* sw = r.screen.control("On");
    CHECK(sw && lv_obj_check_type(sw, &lv_switch_class));
    if (!sw) return;
    r.screen.tap(sw, r.each);
    CHECK(r.node.on);
    CHECK(lv_obj_has_state(sw, LV_STATE_CHECKED));
    r.screen.tap(sw, r.each);
    CHECK(!r.node.on);
}

TEST(lcd_follows_the_device) {
    Rig r;
    r.open("/lamp");
    CHECK_EQ(r.text("Level"), "10 %");
    r.deviceSet("/lamp/level", "42");
    CHECK_EQ(r.text("Level"), "42 %");
    r.deviceSet("/lamp/on", "true");
    CHECK(lv_obj_has_state(r.screen.control("On"), LV_STATE_CHECKED));
    lv_obj_t* led = r.screen.control("Ready");
    CHECK(led && lv_obj_check_type(led, &lv_led_class) && lv_led_get_brightness(led) > 200);
}

TEST(lcd_slider_writes_where_it_is_tapped) {
    Rig r;
    r.open("/lamp");
    lv_obj_t* slider = nullptr;
    // The level's slider is the second line of its row.
    lv_obj_t* l = r.screen.label("Level");
    if (l) slider = lv_obj_get_child(lv_obj_get_parent(lv_obj_get_parent(l)), 1);
    CHECK(slider && lv_obj_check_type(slider, &lv_slider_class));
    if (!slider) return;
    r.screen.tap(slider, r.each, 0.75f, 0.5f);
    r.screen.run(300, r.each);
    CHECK(r.node.level > 60 && r.node.level < 90);
    CHECK_EQ(r.text("Level"), std::to_string(r.node.level) + " %");
}

TEST(lcd_number_steps) {
    Rig r;
    r.open("/lamp");
    lv_obj_t* ta = nullptr;
    lv_obj_t* l = r.screen.label("Count");
    if (l) ta = lv_obj_get_child(lv_obj_get_child(lv_obj_get_parent(l), 1), 1);
    CHECK(ta && lv_obj_check_type(ta, &lv_textarea_class));
    if (!ta) return;
    CHECK_EQ(std::string(lv_textarea_get_text(ta)), "3");
    lv_obj_t* plus = lv_obj_get_child(lv_obj_get_parent(ta), -1);
    r.screen.tap(plus, r.each);
    r.screen.tap(plus, r.each);
    CHECK_EQ(r.node.count, 5);
    CHECK_EQ(std::string(lv_textarea_get_text(ta)), "5");
}

TEST(lcd_button_calls) {
    Rig r;
    r.open("/lamp");
    r.screen.tap(r.screen.label("Press"), r.each);
    CHECK_EQ(r.node.presses, 1);
}

TEST(lcd_confirm_asks_first) {
    Rig r;
    r.open("/lamp");
    r.screen.tap(r.screen.label("Reset"), r.each);
    CHECK_EQ(r.node.resets, 0);
    CHECK(r.screen.label("Reset the lamp?") != nullptr);
    r.screen.tap(r.screen.label("Cancel"), r.each);
    CHECK_EQ(r.node.resets, 0);
    CHECK(r.screen.label("Reset the lamp?") == nullptr);
    r.screen.tap(r.screen.label("Reset"), r.each);
    r.screen.tap(r.screen.label("OK"), r.each);
    CHECK_EQ(r.node.resets, 1);
}

TEST(lcd_text_through_the_keyboard) {
    Rig r;
    r.open("/lamp");
    lv_obj_t* ta = r.screen.control("Name");
    CHECK(ta && lv_obj_check_type(ta, &lv_textarea_class));
    if (!ta) return;
    CHECK_EQ(std::string(lv_textarea_get_text(ta)), "lamp");
    r.screen.tap(ta, r.each);
    // The keyboard edits the field; its check key is READY.
    lv_textarea_set_text(ta, "porch");
    lv_obj_send_event(ta, LV_EVENT_READY, nullptr);
    r.screen.run(200, r.each);
    CHECK_EQ(std::string(r.node.name), "porch");
}

TEST(lcd_refused_write_restores) {
    Rig r;
    r.open("/lamp");
    lv_obj_t* ta = r.screen.control("Name");
    if (!ta) return;
    r.screen.tap(ta, r.each);
    lv_textarea_set_max_length(ta, 0);  // let it past the field's own limit
    lv_textarea_set_text(ta, "far too long");
    lv_obj_send_event(ta, LV_EVENT_READY, nullptr);
    r.screen.run(200, r.each);
    CHECK_EQ(std::string(r.node.name), "lamp");
    CHECK_EQ(std::string(lv_textarea_get_text(ta)), "lamp");
}

int main(int argc, char** argv) { return check::run(argc > 1 ? argv[1] : nullptr) ? 1 : 0; }
