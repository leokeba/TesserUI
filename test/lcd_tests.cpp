// The LVGL renderer against real TesserAPI trees: taps on the host screen,
// checked against the device's values, and the device's changes, checked on
// screen (docs/DESIGN.md section 11).
//
//   ./tesserui_lcd_tests [filter]
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "TesserAPI.h"
#include "check.h"
#include "lcd_host.h"
#include "tesserui/lvgl_ui.h"
#include "trees.h"

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

TEST(lcd_turns_to_portrait) {
    Rig r;
    r.open("/lamp");
    r.screen.resize(240, 320);
    r.screen.run(100, r.each);
    lv_obj_t* sw = r.screen.control("On");
    CHECK(sw != nullptr);
    if (!sw) return;
    lv_area_t a;
    lv_obj_get_coords(sw, &a);
    CHECK(a.x2 < 240);  // laid out again at the new width
    r.screen.tap(sw, r.each);
    CHECK(r.node.on);
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

// ---- More widgets: forms, arguments, lists, flags, colours, toasts --------

namespace {

struct Spot {
    std::string name = "here";
    int x = 0;
};
void describe(tesser::Object& o, Spot& s) {
    o.value("name", s.name);
    o.value("x", s.x).range(0, 10);
}

struct Source {
    std::string name;
    double az = 0;
    bool on = false;
};
void describe(tesser::Object& o, Source& s) {
    o.value("name", s.name);
    o.value("az", s.az).range(0, 360);
    o.value("on", s.on);
}

struct Slot {
    int hour = 0;
    bool enabled = false;
    int runs = 0;
};
void describe(tesser::Object& o, Slot& s) {
    o.value("hour", s.hour).range(0, 23);
    o.value("enabled", s.enabled);
    o.value("runs", s.runs).readOnly();
}

struct Rich {
    tesser::Api api;
    double az = 10, el = 20;
    int goes = 0;
    std::vector<Spot> spots;
    std::vector<Source> sources{{"Sun", 120, true}, {"Moon", 200, false}};
    std::vector<Slot> slots{{7, true, 3}, {19, false, 0}, {22, true, 1}};
    std::vector<int> gains{10, 40};
    int days = 0x05;
    std::string color = "#102030";
    tesser::EventNode* alarm = nullptr;

    Rich() {
        auto& t = api.object("target").label("Target").ui("form");
        t.value("az", az).range(0, 360);
        t.value("el", el).range(0, 90);
        t.action("go", [this] { goes++; }).label("Go");
        auto& m = api.object("misc").label("Misc");
        m.action("add", [this](const Spot& s) { spots.push_back(s); }).label("Add spot");
        m.value("days", days).ui("widget", "flags").ui("labels", "Mon,Tue,Wed");
        m.value("color", color).ui("widget", "color");
        alarm = &m.event("alarm").label("Alarm").ui("toast", "warn");
        auto& l = api.object("lists").label("Lists");
        l.list("sources", sources).maxSize(4).key("name");
        l.list("slots", slots).maxSize(4);
        l.array("gains", gains).range(0, 100).maxSize(4);
    }
};

struct RichRig {
    Rich node;
    tesser::LocalClient client{node.api};
    lcd::Screen screen;
    tesserui::LvglUi ui{client, screen.display()};
    std::function<void()> each = [this] {
        node.api.poll(lv_tick_get());
        ui.loop();
    };
    RichRig() {
        ui.begin("/");
        screen.run(200, each);
    }
    void open(const char* path) {
        ui.open(path);
        screen.run(300, each);
    }
    void tap(const char* text) {
        lv_obj_t* l = screen.label(text);
        CHECK(l != nullptr);
        if (!l) printf("  no label \"%s\"\n", text);
        if (l) screen.tap(l, each);
        screen.run(300, each);
    }
    // Types into a field as the keyboard would, then its check key.
    void type(lv_obj_t* ta, const char* text) {
        screen.tap(ta, each);
        lv_textarea_set_text(ta, text);
        lv_obj_send_event(ta, LV_EVENT_READY, nullptr);
        screen.run(300, each);
    }
};

lv_obj_t* textareaOf(lv_obj_t* c) {
    if (!c) return nullptr;
    if (lv_obj_check_type(c, &lv_textarea_class)) return c;
    uint32_t n = lv_obj_get_child_count(c);
    for (uint32_t i = 0; i < n; i++) {
        if (lv_obj_t* t = textareaOf(lv_obj_get_child(c, static_cast<int32_t>(i)))) return t;
    }
    return nullptr;
}

}  // namespace

TEST(lcd_form_sends_one_patch) {
    RichRig r;
    r.open("/target");
    lv_obj_t* az = textareaOf(r.screen.control("Az"));
    // Az has a range: a slider. Edit it through its slider instead.
    lv_obj_t* l = r.screen.label("Az");
    lv_obj_t* slider = l ? lv_obj_get_child(lv_obj_get_parent(lv_obj_get_parent(l)), 1) : nullptr;
    CHECK(slider && lv_obj_check_type(slider, &lv_slider_class));
    (void)az;
    if (!slider) return;
    r.screen.tap(slider, r.each, 0.5f, 0.5f);
    r.screen.run(300, r.each);
    CHECK_EQ(r.node.az, 10.0);  // a draft: nothing sent yet
    CHECK_EQ(r.node.goes, 0);
    r.tap("Go");
    CHECK(r.node.az > 150 && r.node.az < 210);
    CHECK_EQ(r.node.el, 20.0);  // untouched: left out
    CHECK_EQ(r.node.goes, 1);
}

TEST(lcd_form_reset_discards) {
    RichRig r;
    r.open("/target");
    lv_obj_t* l = r.screen.label("El");
    lv_obj_t* slider = l ? lv_obj_get_child(lv_obj_get_parent(lv_obj_get_parent(l)), 1) : nullptr;
    if (!slider) {
        CHECK(slider != nullptr);
        return;
    }
    r.screen.tap(slider, r.each, 0.9f, 0.5f);
    r.screen.run(200, r.each);
    r.tap("Reset");
    CHECK_EQ(lv_slider_get_value(slider), 2000);  // el in hundredths: the device's value again
    r.tap("Go");
    CHECK_EQ(r.node.el, 20.0);
    CHECK_EQ(r.node.goes, 1);
}

TEST(lcd_object_argument) {
    RichRig r;
    r.open("/misc");
    lv_obj_t* name = r.screen.control("Name");
    CHECK(name && lv_obj_check_type(name, &lv_textarea_class));
    if (!name) return;
    r.type(name, "there");
    r.tap("Add spot");
    CHECK_EQ(r.node.spots.size(), static_cast<size_t>(1));
    if (r.node.spots.empty()) return;
    CHECK_EQ(r.node.spots[0].name, "there");
    CHECK_EQ(r.node.spots[0].x, 0);  // untouched: the device's default
}

TEST(lcd_flags_and_color) {
    RichRig r;
    r.open("/misc");
    lv_obj_t* flags = r.screen.control("Days");
    CHECK(flags && lv_obj_get_child_count(flags) == 3);
    if (!flags) return;
    CHECK(lv_obj_has_state(lv_obj_get_child(flags, 0), LV_STATE_CHECKED));
    CHECK(!lv_obj_has_state(lv_obj_get_child(flags, 1), LV_STATE_CHECKED));
    r.screen.tap(lv_obj_get_child(flags, 1), r.each);
    CHECK_EQ(r.node.days, 0x07);
    r.node.color = "#ff0000";
    r.node.api.changed("/misc/color");
    r.screen.run(300, r.each);
    // The colour's three sliders, under its swatch.
    lv_obj_t* rLabel = r.screen.label("R");
    lv_obj_t* rgb = rLabel ? lv_obj_get_parent(lv_obj_get_parent(rLabel)) : nullptr;
    CHECK(rgb != nullptr);
    if (!rgb) return;
    lv_obj_t* red = lv_obj_get_child(lv_obj_get_child(rgb, 0), 1);
    CHECK_EQ(lv_slider_get_value(red), 255);
    lv_obj_t* blue = lv_obj_get_child(lv_obj_get_child(rgb, 2), 1);
    r.screen.tap(blue, r.each, 0.999f, 0.5f);
    r.screen.run(300, r.each);
    // Blue near its top (a tap's precision), red and green kept.
    CHECK_EQ(r.node.color.substr(0, 5), "#ff00");
    CHECK(strtol(r.node.color.c_str() + 5, nullptr, 16) > 0xf0);
}

TEST(lcd_event_toasts) {
    RichRig r;
    r.open("/lists");  // anywhere in the node
    r.node.alarm->emit(std::string("door open"));
    r.screen.run(300, r.each);
    CHECK(r.screen.label("Alarm: door open") != nullptr);
}

TEST(lcd_keyed_list) {
    RichRig r;
    r.open("/lists");
    CHECK(r.screen.label("Sun") != nullptr);
    CHECK(r.screen.label("Moon") != nullptr);
    // Its switch: the first writable boolean, written in place.
    lv_obj_t* sun = r.screen.label("Sun");
    lv_obj_t* sw = sun ? lv_obj_get_child(lv_obj_get_parent(sun), 2) : nullptr;
    CHECK(sw && lv_obj_check_type(sw, &lv_switch_class));
    if (sw) r.screen.tap(sw, r.each);
    r.screen.run(300, r.each);
    CHECK(!r.node.sources[0].on);
    // Added by key.
    lv_obj_t* field = nullptr;
    for (lv_obj_t* o = r.screen.label("Moon"); o; o = nullptr) {
        lv_obj_t* rows = lv_obj_get_parent(lv_obj_get_parent(o));
        field = textareaOf(lv_obj_get_child(rows, -1));
    }
    CHECK(field != nullptr);
    if (field) r.type(field, "Star");
    CHECK_EQ(r.node.sources.size(), static_cast<size_t>(3));
    if (r.node.sources.size() == 3) {
        CHECK_EQ(r.node.sources[2].name, "Star");
        CHECK_EQ(r.node.sources[0].az, 120.0);  // the others kept whole
    }
    // An element's page: its fields, written through it by key.
    r.tap("Moon");
    CHECK_EQ(r.ui.current(), "/lists/sources/Moon");
    lv_obj_t* name = r.screen.control("Name");
    CHECK(name && lv_obj_check_type(name, &lv_textarea_class));
    if (name) CHECK_EQ(std::string(lv_textarea_get_text(name)), "Moon");
    // Removed from its page.
    r.tap(LV_SYMBOL_TRASH " Remove");
    r.tap("OK");
    CHECK_EQ(r.node.sources.size(), static_cast<size_t>(2));
    if (r.node.sources.size() == 2) CHECK_EQ(r.node.sources[1].name, "Star");
    CHECK_EQ(r.ui.current(), "/lists");
}

TEST(lcd_indexed_list) {
    RichRig r;
    r.open("/lists");
    r.tap("19");  // no key: by index, named by its first field (hour)
    CHECK_EQ(r.ui.current(), "/lists/slots/1");
    lv_obj_t* runs = r.screen.label("Runs");
    CHECK(runs != nullptr);  // a read-only field: a readout
    r.tap(LV_SYMBOL_TRASH " Remove");
    r.tap("OK");
    CHECK_EQ(r.node.slots.size(), static_cast<size_t>(2));
    if (r.node.slots.size() == 2) {
        CHECK_EQ(r.node.slots[0].hour, 7);
        CHECK_EQ(r.node.slots[1].hour, 22);  // moved down, its fields written
    }
}

TEST(lcd_array) {
    RichRig r;
    r.open("/lists");
    lv_obj_t* card = lv_obj_get_parent(r.screen.label("Gains"));
    lv_obj_t* add = lcd::Screen::label(LV_SYMBOL_PLUS " Add", card);
    CHECK(add != nullptr);
    if (!add) return;
    r.screen.tap(add, r.each);
    r.screen.run(300, r.each);
    CHECK_EQ(r.node.gains.size(), static_cast<size_t>(3));
    if (r.node.gains.size() == 3) CHECK_EQ(r.node.gains[2], 0);  // the range's lowest
    card = lv_obj_get_parent(r.screen.label("Gains"));
    lv_obj_t* second = lcd::Screen::label("2", card);
    CHECK(second != nullptr);
    if (second) r.screen.tap(second, r.each);
    r.screen.run(300, r.each);
    CHECK_EQ(r.ui.current(), "/lists/gains/1");
    lv_obj_t* l = r.screen.label("Value");
    lv_obj_t* slider = l ? lv_obj_get_child(lv_obj_get_parent(lv_obj_get_parent(l)), 1) : nullptr;
    CHECK(slider && lv_obj_check_type(slider, &lv_slider_class));
    if (slider) {
        r.screen.tap(slider, r.each, 0.999f, 0.5f);
        r.screen.run(300, r.each);
    }
    if (r.node.gains.size() > 1) CHECK(r.node.gains[1] > 95);  // near the top: a tap's precision
}

// ---- Two buttons: an encoder (the T-Display) -------------------------------

namespace {

// The small node on a 240x135 screen, driven by an encoder.
struct Buttons {
    Node node;
    tesser::LocalClient client{node.api};
    lcd::Screen screen{240, 135};
    tesserui::LvglUi ui{client, screen.display()};
    std::function<void()> each = [this] {
        node.api.poll(lv_tick_get());
        ui.loop();
    };
    Buttons() {
        ui.input(screen.encoder());
        ui.begin("/");
        screen.run(300, each);
    }
    lv_obj_t* focused() { return lv_group_get_focused(ui.group()); }
    // Turns until the focus is on `obj` (at most 30 steps).
    bool focus(lv_obj_t* obj) {
        for (int i = 0; i < 30 && focused() != obj; i++) screen.turn(1, each);
        return focused() == obj;
    }
};

}  // namespace

TEST(lcd_encoder_navigates) {
    Buttons b;
    CHECK(b.ui.current().empty());
    // The first entry is focused; the next one is More.
    lv_obj_t* lamp = b.screen.label("Lamp");
    CHECK(lamp && b.focused() == lv_obj_get_parent(lamp));
    b.screen.push(b.each);
    b.screen.run(300, b.each);
    CHECK_EQ(b.ui.current(), "/lamp");
    // The page's first control, not the back button.
    lv_obj_t* press = b.screen.label("Press");
    CHECK(press && b.focused() == lv_obj_get_parent(press));
    b.screen.push(b.each);
    CHECK_EQ(b.node.presses, 1);
    b.ui.escape();
    b.screen.run(300, b.each);
    CHECK(b.ui.current().empty());
}

TEST(lcd_encoder_edits_a_slider) {
    Buttons b;
    b.ui.open("/lamp");
    b.screen.run(300, b.each);
    lv_obj_t* l = b.screen.label("Level");
    lv_obj_t* slider = l ? lv_obj_get_child(lv_obj_get_parent(lv_obj_get_parent(l)), 1) : nullptr;
    CHECK(slider && b.focus(slider));
    if (!slider) return;
    b.screen.push(b.each);  // edit
    CHECK(lv_group_get_editing(b.ui.group()));
    b.screen.turn(2, b.each);  // two twentieths of 0..100
    b.screen.run(300, b.each);
    CHECK_EQ(b.node.level, 20);
    b.ui.escape();  // leaves editing, stays on the page
    b.screen.run(100, b.each);
    CHECK(!lv_group_get_editing(b.ui.group()));
    CHECK_EQ(b.ui.current(), "/lamp");
}

TEST(lcd_encoder_answers_a_question) {
    Buttons b;
    b.ui.open("/lamp");
    b.screen.run(300, b.each);
    lv_obj_t* reset = b.screen.label("Reset");
    CHECK(reset && b.focus(lv_obj_get_parent(reset)));
    if (!reset) return;
    b.screen.push(b.each);
    CHECK(b.screen.label("Reset the lamp?") != nullptr);
    // Cancel first; the page behind can't take the focus.
    b.screen.turn(1, b.each);
    b.screen.turn(1, b.each);
    b.screen.turn(1, b.each);
    b.screen.push(b.each);  // OK, three turns round two buttons
    CHECK_EQ(b.node.resets, 1);
    CHECK(b.screen.label("Reset the lamp?") == nullptr);
}

TEST(lcd_encoder_types_with_the_keyboard) {
    Buttons b;
    b.ui.open("/lamp");
    b.screen.run(300, b.each);
    lv_obj_t* name = b.screen.control("Name");
    CHECK(name && b.focus(name));
    if (!name) return;
    b.screen.push(b.each);  // opens the keyboard, which takes the encoder
    lv_obj_t* kb = lv_obj_get_child(lv_display_get_screen_active(b.screen.display()), -1);
    CHECK(kb && lv_obj_check_type(kb, &lv_keyboard_class) && !lv_obj_is_hidden(kb));
    b.ui.escape();  // cancel: the value again
    b.screen.run(100, b.each);
    CHECK(kb && lv_obj_is_hidden(kb));
    CHECK_EQ(std::string(lv_textarea_get_text(name)), "lamp");
    b.ui.escape();
    b.screen.run(300, b.each);
    CHECK(b.ui.current().empty());
}

// ---- Peers behind a gateway (the remote controller) -----------------------

namespace {

// The demo tree: a gateway with peers behind an in-memory NowTP link.
struct Gateway {
    trees::Demo demo;
    tesser::LocalClient client{demo.api};
    lcd::Screen screen;
    tesserui::LvglUi ui{client, screen.display()};
    std::function<void()> each = [this] {
        uint32_t now = lv_tick_get();
        demo.pump(now);
        demo.api.poll(now);
        ui.loop();
    };

    Gateway() {
        ui.begin("/");
        screen.run(300, each);
    }
    void tap(const char* text) {
        lv_obj_t* l = screen.label(text);
        CHECK(l != nullptr);
        if (!l) return;
        screen.tap(l, each);
        screen.run(400, each);
    }
    // A menu entry's online dot: green or grey.
    bool online(const char* text) {
        lv_obj_t* l = screen.label(text);
        if (!l) return false;
        lv_obj_t* d = lv_obj_get_child(lv_obj_get_parent(l), 1);
        lv_color_t c = lv_obj_get_style_bg_color(d, LV_PART_MAIN);
        return lv_color_eq(c, lv_palette_main(LV_PALETTE_GREEN));
    }
};

}  // namespace

TEST(lcd_peers_in_the_menu) {
    Gateway g;
    CHECK(g.screen.label("Nodes") != nullptr);
    CHECK(g.screen.label("porch-lamp") != nullptr);
    CHECK(g.online("porch-lamp"));
    CHECK(!g.online("kitchen-lamp"));
}

TEST(lcd_peer_opens_on_its_menu) {
    Gateway g;
    g.tap("porch-lamp");
    CHECK_EQ(g.ui.current(), "/peers/porch-lamp");
    CHECK(g.screen.label("Porch lamp") != nullptr);  // its label, as the title
    CHECK(g.screen.label("Sensors") != nullptr);
    g.tap("Lamp");
    CHECK_EQ(g.ui.current(), "/peers/porch-lamp/lamp");
    if (getenv("LCD_SHOT")) g.screen.png(getenv("LCD_SHOT"));
    lv_obj_t* sw = g.screen.control("On");
    CHECK(sw && lv_obj_check_type(sw, &lv_switch_class));
    if (!sw) return;
    CHECK(lv_obj_has_state(sw, LV_STATE_CHECKED));
    g.screen.tap(sw, g.each);
    g.screen.run(400, g.each);
    CHECK(!g.demo.porch.on);  // written over the link
    // And the other way: the peer's own change, forwarded.
    g.demo.porch.on = true;
    g.screen.run(600, g.each);
    CHECK(lv_obj_has_state(sw, LV_STATE_CHECKED));
    g.ui.back();
    g.screen.run(300, g.each);
    CHECK_EQ(g.ui.current(), "/peers/porch-lamp");
    g.ui.back();
    g.screen.run(300, g.each);
    CHECK(g.ui.current().empty());
}

TEST(lcd_menu_follows_peers) {
    Gateway g;
    CHECK(!g.online("kitchen-lamp"));
    g.demo.hear("kitchen-lamp", true);
    g.screen.run(1500, g.each);
    CHECK(g.online("kitchen-lamp"));
    CHECK(g.screen.label("garden") == nullptr);
    g.demo.hear("garden", true);
    g.screen.run(1500, g.each);
    CHECK(g.screen.label("garden") != nullptr);
    g.demo.hear("garden", false);
    g.screen.run(1500, g.each);
    CHECK(!g.online("garden"));
}

int main(int argc, char** argv) { return check::run(argc > 1 ? argv[1] : nullptr) ? 1 : 0; }
