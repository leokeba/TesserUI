#include "tesserui/lvgl_ui.h"

#if __has_include(<lvgl.h>)

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace tesserui {

using model::Item;
using model::ItemKind;
using model::NodeType;
using model::Widget;

namespace {

constexpr uint32_t kThrottleMs = 100;  // sliders: one write per 100 ms while dragging (section 7.4)
constexpr uint32_t kRetryMs = 5000;
constexpr uint32_t kPollMs = 1000;

std::string jsonString(std::string_view s) {
    JsonDocument d;
    d.set(s);
    std::string out;
    serializeJson(d, out);
    return out;
}

std::string numberJson(const Item& item, double v) {
    char buf[40];
    if (item.type == NodeType::Integer) {
        snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(llround(v)));
        return buf;
    }
    snprintf(buf, sizeof(buf), "%.*f", item.precision >= 0 ? item.precision : 6, v);
    std::string s = buf;
    if (s.find('.') != std::string::npos) {
        while (s.back() == '0') s.pop_back();
        if (s.back() == '.') s.pop_back();
    }
    if (s == "-0") s = "0";
    return s;
}

// What a reply or a value reads as on screen: strings as they are.
std::string text(JsonVariantConst v) {
    if (v.is<const char*>()) return v.as<const char*>();
    std::string out;
    serializeJson(v, out);
    return out;
}

// Slider and bar positions are integers: value units times this.
double scaleFor(const Item& i) {
    if (i.type == NodeType::Integer) return 1;
    double s = pow(10, i.precision >= 0 ? i.precision : 2);
    double m = fmax(fabs(i.min), fabs(i.max));
    while (s > 1 && m * s > 1e9) s /= 10;
    return s;
}

double stepFor(const Item& i) {
    if (i.hasStep && i.step > 0) return i.step;
    if (i.type == NodeType::Integer) return 1;
    return i.precision >= 0 ? pow(10, -i.precision) : 1;
}

double clampTo(const Item& i, double v) {
    if (i.hasMin && v < i.min) v = i.min;
    if (i.hasMax && v > i.max) v = i.max;
    return v;
}

double snap(const Item& i, double v) {
    if (i.hasStep && i.step > 0) {
        double base = i.hasMin ? i.min : 0;
        v = base + round((v - base) / i.step) * i.step;
    }
    return clampTo(i, v);
}

std::vector<std::string_view> segmentsOf(std::string_view path) {
    std::vector<std::string_view> out;
    size_t start = 0;
    while (start <= path.size()) {
        size_t i = path.find('/', start);
        if (i == std::string_view::npos) i = path.size();
        if (i > start) out.push_back(path.substr(start, i - start));
        start = i + 1;
    }
    return out;
}

bool hasNull(JsonVariantConst v) {
    if (v.isNull()) return true;
    if (v.is<JsonObjectConst>()) {
        for (JsonPairConst kv : v.as<JsonObjectConst>()) {
            if (hasNull(kv.value())) return true;
        }
    }
    return false;
}

void merge(JsonObject dst, JsonObjectConst patch) {
    for (JsonPairConst kv : patch) {
        JsonVariantConst v = kv.value();
        if (v.is<JsonObjectConst>()) {
            JsonObject child = dst[kv.key()].is<JsonObject>() ? dst[kv.key()].as<JsonObject>() : dst[kv.key()].to<JsonObject>();
            merge(child, v.as<JsonObjectConst>());
        } else {
            dst[kv.key()] = v;
        }
    }
}

// How a semantic widget is drawn here (section 10.3), the nearest one when
// it has no LVGL equivalent (section 5).
enum class Draw : uint8_t { Control, WebOnly, Hidden };

Draw drawn(const Item& item, Widget& w) {
    w = item.widget;
    switch (item.widget) {
        case Widget::Element: {
            // A custom element is its tier 0 widget.
            NodeType t = item.type;
            bool range = item.hasMin && item.hasMax;
            if (item.isAction()) {
                w = Widget::Button;
            } else if (t == NodeType::Boolean) {
                w = item.editable ? Widget::Toggle : Widget::Led;
            } else if (t == NodeType::Integer || t == NodeType::Number) {
                w = !item.editable ? Widget::Readout : range ? Widget::Slider : Widget::Number;
            } else if (t == NodeType::String) {
                w = !item.editable ? Widget::Readout : item.hasOptions ? Widget::Select : Widget::Text;
            } else {
                return Draw::WebOnly;
            }
            return Draw::Control;
        }
        case Widget::Knob:
            w = Widget::Slider;
            return Draw::Control;
        case Widget::Gauge:
            w = Widget::Bar;
            return Draw::Control;
        case Widget::Stepper:
            w = Widget::Number;
            return Draw::Control;
        case Widget::Radio:
            w = Widget::Select;
            return Draw::Control;
        case Widget::Timezone:
            w = Widget::Text;
            return Draw::Control;
        case Widget::Json:
        case Widget::Events:
        case Widget::Log:
            return Draw::Hidden;
        case Widget::File:
            return Draw::WebOnly;
        default:
            return Draw::Control;
    }
}

bool twoLines(Widget w) {
    return w == Widget::Slider || w == Widget::Bar || w == Widget::Segmented || w == Widget::Text ||
           w == Widget::Password || w == Widget::Textarea || w == Widget::Chart || w == Widget::Flags ||
           w == Widget::Color;
}

// "#rrggbb", or 0xRRGGBB as an integer.
void colorOf(JsonVariantConst v, uint8_t rgb[3]) {
    uint32_t c = 0;
    if (v.is<const char*>()) {
        const char* t = v.as<const char*>();
        if (t[0] == '#' && strlen(t) == 7) c = static_cast<uint32_t>(strtoul(t + 1, nullptr, 16));
    } else {
        c = v.as<uint32_t>();
    }
    rgb[0] = static_cast<uint8_t>(c >> 16);
    rgb[1] = static_cast<uint8_t>(c >> 8);
    rgb[2] = static_cast<uint8_t>(c);
}

// An element's fields a client may write back: not read-only, not secret
// (those it couldn't read). What keeps an indexed list's moved elements.
void writableCopy(JsonVariantConst value, JsonObjectConst schema, JsonObject out) {
    for (JsonPairConst kv : schema["children"].as<JsonObjectConst>()) {
        JsonObjectConst c = kv.value();
        JsonVariantConst v = value[kv.key()];
        if (v.isUnbound()) continue;
        const char* type = c["type"];
        if (type && strcmp(type, "object") == 0) {
            writableCopy(v, c, out[kv.key()].to<JsonObject>());
        } else if (c["writable"].as<bool>() && !c["secret"].as<bool>()) {
            out[kv.key()] = v;
        }
    }
}

// The value at `rel` (a column's path, "" for the element itself) in an element.
JsonVariantConst at(JsonVariantConst v, std::string_view rel) {
    for (std::string_view s : segmentsOf(rel)) v = v[std::string(s)];
    return v;
}

bool anyShown(const std::vector<Item>& items) {
    for (const Item& i : items) {
        if (!i.hidden) return true;
    }
    return false;
}

}  // namespace

// A list's row: what tapping it, or its switch, does.
struct LvglUi::RowRef {
    enum Kind : uint8_t { Open, Switch, Add };
    LvglUi* ui = nullptr;
    size_t list = 0;  // the list's Bound
    Kind kind = Open;
    std::string id;    // the element's key or index
    std::string path;  // a switch's
    std::string title;
    lv_obj_t* field = nullptr;  // a keyed list's new key
};

// A control bound to a path: a value's, an action's, or a link to open.
struct LvglUi::Bound {
    LvglUi* ui = nullptr;
    size_t index = 0;
    const Item* item = nullptr;  // null for menu entries
    Widget widget = Widget::Readout;
    bool section = false;    // a section's container, for its conditions
    bool forAction = false;  // the control is an action's argument, not a value
    lv_obj_t* row = nullptr;
    lv_obj_t* control = nullptr;
    lv_obj_t* value = nullptr;   // the value's text beside a slider or a bar, or a readout
    lv_obj_t* button = nullptr;  // an action's button
    lv_obj_t* result = nullptr;  // an action's reply
    lv_obj_t* minus = nullptr;
    lv_obj_t* plus = nullptr;
    int pending = 0;
    uint32_t lastSent = 0;
    bool dirty = false;
    std::string sent;   // the last value written
    std::string shown;  // the value's JSON as last shown
    double scale = 1;
    std::vector<const char*> map;  // a button matrix's labels
    std::vector<std::string> mapText;
    std::string dropdownText;      // a value that isn't among the options
    lv_timer_t* hold = nullptr;
    Widget fieldWidget = Widget::Readout;  // an action's argument input
    Route target;  // links and menu entries: where they go
    size_t draft = 0;        // a draft's field: the draft's index + 1
    bool edited = false;     // changed in its draft, not sent yet
    size_t draftApply = 0;   // a draft's apply or reset button
    size_t draftReset = 0;
    lv_chart_series_t* series = nullptr;
    std::vector<double> samples;  // a chart's, for its range
    lv_obj_t* swatch = nullptr;   // a colour's
    std::vector<std::unique_ptr<RowRef>> rows;  // a list's
    std::vector<model::Option> choices;  // a select's, with a keyed list's keys (ui.options)
    bool hasChoices = false;
    bool stalled = false;     // a keep-alive refused: not again until an edit
    uint32_t lastKeep = 0;
    lv_obj_t* zero = nullptr;  // a kept-alive number's way back to 0
};

LvglUi::LvglUi(tesser::ApiClient& client, lv_display_t* display)
    : client_(client), display_(display), alive_(std::make_shared<int>(0)) {
    group_ = lv_group_create();
    std::weak_ptr<int> alive = alive_;
    client_.onNotification([this, alive](JsonObjectConst envelope) {
        if (alive.expired()) return;
        onNotification(envelope);
    });
}

LvglUi::~LvglUi() {
    alive_.reset();
    if (showPending_) lv_async_call_cancel(onShow, this);
    client_.onNotification(nullptr);
    if (!subscribed_.empty()) client_.unsubscribe(subscribed_);
    if (!eventsPath_.empty() && eventsPath_ != subscribed_) client_.unsubscribe(eventsPath_);
    if (retryTimer_) lv_timer_delete(retryTimer_);
    if (pollTimer_) lv_timer_delete(pollTimer_);
    for (auto& b : bound_) {
        if (b->hold) lv_timer_delete(b->hold);
    }
    if (screen_) lv_obj_clean(screen_);
    if (toast_) lv_obj_delete(toast_);
    if (msgbox_) lv_msgbox_close(msgbox_);
    if (modal_) lv_group_delete(modal_);
    lv_group_delete(group_);
}

// ---- Chrome ----------------------------------------------------------------

void LvglUi::chrome() {
    if (!font_) font_ = LV_FONT_DEFAULT;
    int32_t shortSide = lv_display_get_horizontal_resolution(display_);
    if (lv_display_get_vertical_resolution(display_) < shortSide) shortSide = lv_display_get_vertical_resolution(display_);
    if (shortSide < 200) {
        // A 135x240 screen: everything tighter.
        m_.compact = true;
        m_.header = 24;
        m_.row = 24;
        m_.entry = 28;
        m_.listRow = 26;
        m_.pad = 3;
        m_.cardPad = 4;
        m_.button = 24;
        m_.fieldPad = 2;
        m_.chart = 40;
        m_.segmented = 28;
    }
    lv_theme_t* theme = lv_theme_default_init(display_, lv_palette_main(LV_PALETTE_BLUE), lv_palette_main(LV_PALETTE_ORANGE),
                                              true, font_);
    lv_display_set_theme(display_, theme);
    screen_ = lv_display_get_screen_active(display_);
    lv_obj_clean(screen_);
    lv_obj_set_style_text_font(screen_, font_, 0);
    lv_obj_set_flex_flow(screen_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(screen_, 0, 0);
    lv_obj_set_style_pad_row(screen_, 0, 0);
    lv_obj_set_scrollable(screen_, false);

    header_ = lv_obj_create(screen_);
    lv_obj_set_size(header_, LV_PCT(100), m_.header);
    lv_obj_set_flex_flow(header_, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(header_, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_hor(header_, 4, 0);
    lv_obj_set_style_pad_ver(header_, 0, 0);
    lv_obj_set_style_pad_column(header_, 6, 0);
    lv_obj_set_style_radius(header_, 0, 0);
    lv_obj_set_style_border_width(header_, 0, 0);
    lv_obj_set_scrollable(header_, false);

    backButton_ = lv_button_create(header_);
    lv_obj_set_size(backButton_, m_.compact ? 30 : 40, m_.header - 8);
    lv_obj_t* arrow = lv_label_create(backButton_);
    setLabel(arrow, LV_SYMBOL_LEFT);
    lv_obj_center(arrow);
    lv_obj_add_event_cb(backButton_, onChrome, LV_EVENT_CLICKED, this);
    lv_obj_set_hidden(backButton_, true);

    title_ = lv_label_create(header_);
    lv_obj_set_flex_grow(title_, 1);
    lv_label_set_long_mode(title_, LV_LABEL_LONG_MODE_DOTS);
#if LV_FONT_MONTSERRAT_16
    if (!m_.compact) lv_obj_set_style_text_font(title_, &lv_font_montserrat_16, 0);
#endif
    setLabel(title_, "");

    signIn_ = lv_button_create(header_);
    lv_obj_set_height(signIn_, m_.header - 8);
    lv_obj_set_style_pad_hor(signIn_, m_.compact ? 4 : 8, 0);
    lv_obj_set_style_pad_ver(signIn_, 0, 0);
    lv_obj_t* si = lv_label_create(signIn_);
    lv_obj_center(si);
    lv_obj_add_event_cb(signIn_, onChrome, LV_EVENT_CLICKED, this);
    lv_obj_set_hidden(signIn_, true);

    dot_ = lv_obj_create(header_);
    lv_obj_set_size(dot_, 10, 10);
    lv_obj_set_style_radius(dot_, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(dot_, 0, 0);
    lv_obj_set_style_margin_right(dot_, 4, 0);
    connection(true);

    content_ = lv_obj_create(screen_);
    lv_obj_set_width(content_, LV_PCT(100));
    lv_obj_set_flex_grow(content_, 1);
    lv_obj_set_flex_flow(content_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(content_, m_.pad, 0);
    lv_obj_set_style_pad_row(content_, m_.pad, 0);
    lv_obj_set_style_radius(content_, 0, 0);
    lv_obj_set_style_border_width(content_, 0, 0);
    lv_obj_set_scroll_dir(content_, LV_DIR_VER);

    keyboard_ = lv_keyboard_create(screen_);
    lv_obj_set_ignore_layout(keyboard_, true);
    lv_obj_set_hidden(keyboard_, true);
    lv_obj_set_size(keyboard_, LV_PCT(100), LV_PCT(50));
    lv_obj_align(keyboard_, LV_ALIGN_BOTTOM_MID, 0, 0);

    toast_ = lv_obj_create(lv_display_get_layer_top(display_));
    lv_obj_set_size(toast_, LV_PCT(90), LV_SIZE_CONTENT);
    lv_obj_align(toast_, LV_ALIGN_BOTTOM_MID, 0, -8);
    lv_obj_set_style_pad_all(toast_, 8, 0);
    lv_obj_set_scrollable(toast_, false);
    lv_obj_set_clickable(toast_, false);
    toastLabel_ = lv_label_create(toast_);
    lv_obj_set_width(toastLabel_, LV_PCT(100));
    lv_label_set_long_mode(toastLabel_, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_hidden(toast_, true);
}

// Text in the UI's font: characters it has no glyph for become their ASCII
// look-alikes (a minus sign, dashes, curly quotes, accented letters), so a
// device's "Jog −" doesn't show a box. A font that has them keeps them.
std::string LvglUi::fit(std::string_view t) const {
    bool ascii = true;
    for (char c : t) {
        if (static_cast<uint8_t>(c) >= 0x80) ascii = false;
    }
    if (ascii || !font_) return std::string(t);
    std::string out;
    for (size_t i = 0; i < t.size();) {
        uint8_t c = static_cast<uint8_t>(t[i]);
        size_t n = c < 0x80 ? 1 : c >> 5 == 6 ? 2 : c >> 4 == 14 ? 3 : c >> 3 == 30 ? 4 : 1;
        if (i + n > t.size()) n = 1;
        uint32_t cp = n == 1 ? c : n == 2 ? c & 0x1F : n == 3 ? c & 0x0F : c & 0x07;
        for (size_t k = 1; k < n; k++) cp = (cp << 6) | (static_cast<uint8_t>(t[i + k]) & 0x3F);
        lv_font_glyph_dsc_t dsc;
        if (n == 1 || lv_font_get_glyph_dsc(font_, &dsc, cp, 0)) {
            out.append(t.substr(i, n));
        } else {
            out += lookalike(cp, t.substr(i, n));
        }
        i += n;
    }
    return out;
}

std::string LvglUi::lookalike(uint32_t cp, std::string_view original) {
    switch (cp) {
        case 0x2212: case 0x2010: case 0x2011: case 0x2012: case 0x2013: case 0x2014: case 0x2015: return "-";
        case 0x2018: case 0x2019: case 0x201A: case 0x2032: return "'";
        case 0x201C: case 0x201D: case 0x201E: case 0x2033: return "\"";
        case 0x2026: return "...";
        case 0x00A0: case 0x202F: case 0x2009: return " ";
        case 0x00D7: return "x";
        case 0x00F7: return "/";
        case 0x2264: return "<=";
        case 0x2265: return ">=";
        case 0x2260: return "!=";
        case 0x00B1: return "+/-";
        case 0x2192: return "->";
        case 0x2190: return "<-";
        case 0x00B5: case 0x03BC: return "u";
        case 0x03A9: case 0x2126: return "Ohm";
        case 0x00B2: return "2";
        case 0x00B3: return "3";
        case 0x00B7: case 0x2022: return "*";
        case 0x00AB: return "<<";
        case 0x00BB: return ">>";
        case 0x00E6: return "ae";
        case 0x0153: return "oe";
        case 0x00DF: return "ss";
        default: break;
    }
    // Latin letters with accents: the letter.
    static const char* const latin1 = "AAAAAAACEEEEIIIIDNOOOOOxOUUUUYTsaaaaaaaceeeeiiiidnooooo/ouuuuyty";
    if (cp >= 0xC0 && cp <= 0xFF) return std::string(1, latin1[cp - 0xC0]);
    return std::string(original);  // nothing better: the font's placeholder
}

void LvglUi::setLabel(lv_obj_t* label, const char* text) {
    std::string t = fit(text ? text : "");
    lv_label_set_text(label, t.c_str());
}

// Into the page's group, once an encoder or a keypad uses it (group()): on
// a touchscreen alone, the group's focus would show a cursor in a field.
void LvglUi::focusable(lv_obj_t* obj) {
    if (!useGroup_) return;
    lv_group_add_obj(group_, obj);
    lv_obj_set_scroll_on_focus(obj, true);
    outline(obj);
    if (!firstFocus_) firstFocus_ = obj;
}

// Where the focus is, always: the theme outlines only what keys focused,
// not what the UI focuses itself (a page's first control).
void LvglUi::outline(lv_obj_t* obj) {
    lv_obj_set_style_outline_width(obj, 2, LV_STATE_FOCUSED);
    lv_obj_set_style_outline_color(obj, lv_palette_lighten(LV_PALETTE_ORANGE, 1), LV_STATE_FOCUSED);
    lv_obj_set_style_outline_pad(obj, 1, LV_STATE_FOCUSED);
}

// The page's first control, rather than the back button.
void LvglUi::focusFirst() {
    if (useGroup_ && firstFocus_) lv_group_focus_obj(firstFocus_);
}

// A question's or the keyboard's controls, alone in the input's group
// until endModal(): the page behind can't take the focus.
void LvglUi::modal(lv_obj_t* const* objs, size_t n, bool editing) {
    if (!indev_) return;
    if (!modal_) modal_ = lv_group_create();
    lv_group_remove_all_objs(modal_);
    for (size_t i = 0; i < n; i++) {
        lv_group_add_obj(modal_, objs[i]);
        outline(objs[i]);
    }
    if (n) lv_group_focus_obj(objs[0]);
    lv_group_set_editing(modal_, editing);
    lv_indev_set_group(indev_, modal_);
}

void LvglUi::endModal() {
    if (!indev_) return;
    if (modal_) lv_group_remove_all_objs(modal_);
    lv_indev_set_group(indev_, group_);
}

void LvglUi::escape() {
    if (msgbox_) {
        lv_msgbox_close(msgbox_);
        msgbox_ = nullptr;
        confirmed_ = nullptr;
        endModal();
        return;
    }
    if (typing_ && typingArea_) {
        lv_obj_send_event(typingArea_, LV_EVENT_CANCEL, nullptr);  // as the keyboard's cancel key
        hideKeyboard();
        return;
    }
    if (useGroup_ && lv_group_get_editing(group_)) {
        lv_obj_t* f = lv_group_get_focused(group_);
        if (f && lv_obj_check_type(f, &lv_dropdown_class) && lv_dropdown_is_open(f)) lv_dropdown_close(f);
        lv_group_set_editing(group_, false);
        return;
    }
    back();
}

// Encoder clicks move a slider by a twentieth of its range (or its step,
// when larger): one unit, its precision's, would take hundreds of clicks.
void LvglUi::onSliderKey(lv_event_t* e) {
    uint32_t key = lv_event_get_key(e);
    int dir = key == LV_KEY_RIGHT || key == LV_KEY_UP ? 1 : key == LV_KEY_LEFT || key == LV_KEY_DOWN ? -1 : 0;
    if (!dir) return;
    lv_obj_t* sl = lv_event_get_target_obj(e);
    Bound* b = static_cast<Bound*>(lv_event_get_user_data(e));
    int32_t lo = lv_slider_get_min_value(sl), hi = lv_slider_get_max_value(sl);
    int32_t step = (hi - lo) / 20;
    if (b->widget == Widget::Slider && b->item) {
        int32_t own = static_cast<int32_t>(lround(stepFor(*b->item) * b->scale));
        if (own > step) step = own;
    }
    if (step < 1) step = 1;
    int32_t v = lv_slider_get_value(sl) + dir * step;
    lv_slider_set_value(sl, v < lo ? lo : v > hi ? hi : v, LV_ANIM_OFF);
    lv_event_stop_processing(e);
    lv_obj_send_event(sl, LV_EVENT_VALUE_CHANGED, nullptr);
}

void LvglUi::onChrome(lv_event_t* e) {
    LvglUi* ui = static_cast<LvglUi*>(lv_event_get_user_data(e));
    lv_obj_t* target = lv_event_get_target_obj(e);
    if (target == ui->backButton_) {
        ui->back();
    } else if (target == ui->retry_) {
        ui->requestShow();
    } else if (target == ui->signIn_) {
        // The login action's fields and its button (TesserKIT hides it).
        NodeAuth* a = ui->authOf(ui->nodeRoot());
        if (!a || a->login.empty()) return;
        std::string root = ui->nodeRoot() == ui->root_ ? std::string() : ui->nodeRoot();
        Route r = Route::to(a->login, root);
        r.signIn = true;
        r.title = "Sign in";
        ui->route_.push_back(std::move(r));
        ui->requestShow();
    }
}

void LvglUi::setTitle(const std::string& title) {
    setLabel(title_, title.c_str());
    bool canGoBack = !route_.empty() && (menuShown_ || route_.size() > 1);
    if (useGroup_) {
        outline(backButton_);
        if (canGoBack) {
            lv_group_add_obj(group_, backButton_);
        } else {
            lv_group_remove_obj(backButton_);
        }
    }
    lv_obj_set_hidden(backButton_, !(canGoBack));
}

void LvglUi::message(const char* textToShow, bool retry) {
    lv_obj_t* l = lv_label_create(content_);
    lv_obj_set_width(l, LV_PCT(100));
    lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_pad_top(l, 40, 0);
    setLabel(l, textToShow);
    retry_ = nullptr;
    if (retry) {
        retry_ = lv_button_create(content_);
        lv_obj_align(retry_, LV_ALIGN_CENTER, 0, 0);
        lv_obj_t* t = lv_label_create(retry_);
        setLabel(t, "Retry");
        lv_obj_add_event_cb(retry_, onChrome, LV_EVENT_CLICKED, this);
        focusable(retry_);
        focusFirst();
    }
}

void LvglUi::toast(const std::string& t, bool isError) {
    if (!toast_) return;
    setLabel(toastLabel_, t.c_str());
    lv_obj_set_style_bg_color(toast_, isError ? lv_palette_darken(LV_PALETTE_RED, 2) : lv_palette_darken(LV_PALETTE_GREY, 3), 0);
    lv_obj_set_hidden(toast_, false);
    toastUntil_ = lv_tick_get() + 3000;
}

void LvglUi::toast(const std::string& t, model::Toast kind) {
    toast(t, kind == model::Toast::Error);
    lv_color_t c = kind == model::Toast::Ok     ? lv_palette_darken(LV_PALETTE_GREEN, 2)
                   : kind == model::Toast::Warn ? lv_palette_darken(LV_PALETTE_AMBER, 3)
                   : kind == model::Toast::Error ? lv_palette_darken(LV_PALETTE_RED, 2)
                                                 : lv_palette_darken(LV_PALETTE_GREY, 3);
    lv_obj_set_style_bg_color(toast_, c, 0);
}

void LvglUi::error(const std::string& what, Status s, JsonVariantConst body) {
    if (s == Status::Timeout) connection(false);
    const char* msg = body["message"];
    std::string t = what.empty() ? std::string() : what + ": ";
    t += msg ? msg : tesser::toString(s);
    NodeAuth* a = authOf(nodeRoot());
    if (s == Status::Unauthorized && a && !a->login.empty()) t += " (sign in)";
    toast(t, true);
}

void LvglUi::connection(bool ok) {
    online_ = ok;
    lv_obj_set_style_bg_color(dot_, ok ? lv_palette_main(LV_PALETTE_GREEN) : lv_palette_main(LV_PALETTE_RED), 0);
}

// ---- Navigation ------------------------------------------------------------

void LvglUi::begin(std::string_view root) {
    root_ = std::string(root.empty() ? "/" : root);
    chrome();
    loadRoot();
}

// A schema read that asks for less when the reply wouldn't fit: over NowTP
// replies are capped at 16 KB, and a node short of memory refuses a large
// one (section 7.2).
void LvglUi::schema(const std::string& path, int depth, SchemaHandler done) {
    tesser::Query q;
    q.view = tesser::View::Schema;
    q.depth = depth;
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    bool sent = client_.get(
        path,
        [this, alive, gen, path, depth, done](Status s, JsonVariantConst body) {
            if (alive.expired() || gen != gen_) return;
            const char* reason = body["reason"];
            bool smaller = s == Status::TooLarge || (s == Status::Busy && reason && strcmp(reason, "low_memory") == 0);
            if (smaller && depth > 1) {
                schema(path, depth - 1, done);
                return;
            }
            if (s == Status::Timeout) {
                connection(false);
            } else if (s == Status::Ok) {
                connection(true);
            }
            done(s, body);
        },
        q);
    if (!sent) done(Status::Internal, JsonVariantConst());
}

void LvglUi::failed(const char* what, Status s, JsonVariantConst body) {
    loading_ = false;
    lv_obj_clean(content_);
    const char* msg = body["message"];
    std::string t = what;
    t += msg ? msg : s == Status::Timeout ? "no answer" : tesser::toString(s);
    message(t.c_str(), true);
}

void LvglUi::loadRoot() {
    clearPage();
    setTitle("");
    message("Loading...", false);
    loading_ = true;
    // The menu: the root's children, and theirs for sub-entries.
    schema(root_, 2, [this](Status s, JsonVariantConst body) {
        loading_ = false;
        if (s != Status::Ok) {
            failed("The node doesn't answer: ", s, body);
            return;
        }
        JsonObjectConst sch = body;
        const char* label = sch["label"];
        rootLabel_ = label ? label : "Device";
        menu_ = model::buildMenu(sch, root_);
        rootLoaded_ = true;
        route_.clear();
        // A single entry is the start page itself.
        menuShown_ = entries(menu_) > 1;
        if (!menuShown_) route_.push_back(Route::to(only(menu_, root_), ""));
        show();
    });
}

size_t LvglUi::entries(const std::vector<model::MenuEntry>& menu) {
    size_t n = 0;
    for (const model::MenuEntry& e : menu) n += e.path.empty() ? e.children.size() : 1;
    return n;
}

// The page a menu of at most one entry stands for.
std::string LvglUi::only(const std::vector<model::MenuEntry>& menu, const std::string& home) {
    if (menu.empty()) return home;
    if (!menu[0].path.empty()) return menu[0].path;
    return menu[0].children.empty() ? home : menu[0].children[0].path;
}

void LvglUi::open(std::string_view path, std::string_view root) {
    Route r = Route::to(std::string(path), std::string(root));
    // A remote node's root: its own menu.
    if (!r.root.empty() && r.path == r.root && r.root != root_) r.menu = true;
    route_.push_back(std::move(r));
    requestShow();
}

void LvglUi::back() {
    size_t floor = menuShown_ ? 0 : 1;
    if (route_.size() <= floor) return;
    route_.pop_back();
    requestShow();
}

void LvglUi::onShow(void* user) {
    LvglUi* ui = static_cast<LvglUi*>(user);
    ui->showPending_ = false;
    if (ui->rootLoaded_) {
        ui->show();
    } else {
        ui->loadRoot();
    }
}

void LvglUi::requestShow() {
    if (showPending_) return;
    showPending_ = lv_async_call(onShow, this) == LV_RESULT_OK;
}

void LvglUi::show() {
    if (route_.empty()) {
        showMenu();
    } else if (route_.back().menu) {
        showNodeMenu();
    } else {
        showPage();
    }
}

void LvglUi::clearPage() {
    unsubscribe();
    gen_++;
    hideKeyboard();
    if (msgbox_) {
        lv_msgbox_close(msgbox_);
        msgbox_ = nullptr;
        endModal();
    }
    if (menuTimer_) lv_timer_delete(menuTimer_);
    menuTimer_ = nullptr;
    watching_ = false;
    clearContent();
    if (content_) lv_obj_scroll_to_y(content_, 0, LV_ANIM_OFF);
    page_ = model::Page();
    values_.clear();
    hasValues_ = false;
    loading_ = false;
    drafts_.clear();
    drafting_ = 0;
    watch_.path.clear();
    watch_.values.clear();
    watch_.has = false;
    stubPath_.clear();
    if (offline_) setOffline(false);
    skip_ = nullptr;
    listValue_.clear();
    elementSchema_.clear();
    listEditable_ = false;
}

void LvglUi::clearContent() {
    for (auto& b : bound_) {
        if (b->hold) lv_timer_delete(b->hold);
    }
    if (content_) lv_obj_clean(content_);
    lv_group_remove_all_objs(group_);
    firstFocus_ = nullptr;
    retry_ = nullptr;
    bound_.clear();
}

void LvglUi::drawMenu(const std::vector<model::MenuEntry>& menu, const std::string& home, const std::string& root) {
    auto entry = [this, &home, &root](lv_obj_t* parent, const model::MenuEntry& e, bool sub) {
        lv_obj_t* b = lv_button_create(parent);
        lv_obj_set_size(b, LV_PCT(100), m_.entry);
        lv_obj_set_flex_flow(b, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(b, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_set_style_pad_left(b, sub ? 24 : 10, 0);
        lv_obj_set_style_pad_column(b, 8, 0);
        // Rows of a list rather than call-to-action buttons.
        lv_obj_set_style_bg_color(b, lv_color_hex(sub ? 0x24272b : 0x2c3036), 0);
        lv_obj_set_style_bg_color(b, lv_color_hex(0x3b4048), LV_STATE_PRESSED);
        lv_obj_set_style_shadow_width(b, 0, 0);
        label(b, e.label, true);
        if (e.remote) dot(b, e.online);
        lv_obj_t* chevron = lv_label_create(b);
        setLabel(chevron, LV_SYMBOL_RIGHT);
        lv_obj_set_style_text_color(chevron, lv_palette_main(LV_PALETTE_BLUE), 0);
        auto bound = std::make_unique<Bound>();
        bound->ui = this;
        bound->index = bound_.size();
        bound->widget = Widget::Link;
        bound->control = b;
        if (e.path == home) {
            bound->target = Route::to(e.path, root, false, true);  // Status: the node's own values
        } else if (e.remote) {
            bound->target = Route::to(e.path, e.path, true);
        } else {
            bound->target = Route::to(e.path, root);
        }
        if (!e.remote) bound->target.above = e.access;
        lv_obj_add_event_cb(b, onEvent, LV_EVENT_CLICKED, bound.get());
        focusable(b);
        bound_.push_back(std::move(bound));
    };
    for (const model::MenuEntry& top : menu) {
        if (top.path.empty()) {
            // A ui.group heading.
            lv_obj_t* h = label(content_, top.label, false);
            lv_obj_set_style_text_opa(h, LV_OPA_70, 0);
            for (const model::MenuEntry& c : top.children) entry(content_, c, false);
            continue;
        }
        entry(content_, top, false);
        for (const model::MenuEntry& c : top.children) entry(content_, c, true);
    }
    if (menu.empty()) message("Nothing to show here.", false);
    focusFirst();
}

void LvglUi::showMenu() {
    clearPage();
    ensureEvents();
    ensureAuth();
    setTitle(rootLabel_);
    drawMenu(menu_, root_, "");
    // Live: nodes come and go under a gateway. A stub's change is a null in
    // a notification of its parent (section 7.3): read the menu again then.
    tesser::Query q;
    q.depth = 2;
    q.interval = 1000;
    q.events = false;  // the events subscription's
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    subscribed_ = root_;
    watching_ = true;
    bool sent = client_.subscribe(
        root_,
        [this, alive, gen](Status s, JsonVariantConst) {
            if (alive.expired() || gen != gen_ || s == Status::Ok) return;
            // No subscription: read it every 10 s instead.
            subscribed_.clear();
            menuTimer_ = lv_timer_create(
                [](lv_timer_t* t) { static_cast<LvglUi*>(lv_timer_get_user_data(t))->refreshMenu(); }, 10000, this);
        },
        q);
    if (!sent) subscribed_.clear();
    refreshMenu();  // what changed since it was read
}

void LvglUi::refreshMenu() {
    if (refreshing_) return;
    refreshing_ = true;
    tesser::Query q;
    q.view = tesser::View::Schema;
    q.depth = 2;
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    bool sent = client_.get(
        root_,
        [this, alive, gen](Status s, JsonVariantConst body) {
            if (alive.expired()) return;
            refreshing_ = false;
            if (s != Status::Ok) return;
            std::vector<model::MenuEntry> fresh = model::buildMenu(body, root_);
            const char* label = body["label"];
            rootLabel_ = label ? label : "Device";
            if (!same(fresh, menu_)) {
                menu_ = std::move(fresh);
                if (gen == gen_ && route_.empty()) {
                    // Drawn again where it was scrolled to.
                    int32_t y = lv_obj_get_scroll_y(content_);
                    clearContent();
                    drawMenu(menu_, root_, "");
                    lv_obj_update_layout(content_);
                    lv_obj_scroll_to_y(content_, y, LV_ANIM_OFF);
                }
            }
            if (gen == gen_ && route_.empty()) setTitle(rootLabel_);
        },
        q);
    if (!sent) refreshing_ = false;
}

bool LvglUi::same(const std::vector<model::MenuEntry>& a, const std::vector<model::MenuEntry>& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); i++) {
        if (a[i].label != b[i].label || a[i].path != b[i].path || a[i].online != b[i].online ||
            a[i].remote != b[i].remote || !same(a[i].children, b[i].children)) {
            return false;
        }
    }
    return true;
}

// A remote node's menu: its own entries, read through the gateway.
void LvglUi::showNodeMenu() {
    clearPage();
    ensureEvents();
    ensureAuth();
    Route r = route_.back();
    std::string_view name = r.path;
    name = name.substr(name.rfind('/') + 1);
    setTitle(std::string(name));
    message("Loading...", false);
    loading_ = true;
    schema(r.path, 2, [this, r](Status s, JsonVariantConst body) {
        if (s != Status::Ok) {
            failed("The node doesn't answer: ", s, body);
            return;
        }
        loading_ = false;
        std::vector<model::MenuEntry> menu = model::buildMenu(body, r.path);
        if (entries(menu) <= 1) {
            // One entry: the node's page itself, in the menu's place.
            route_.back() = Route::to(only(menu, r.path), r.path);
            show();
            return;
        }
        const char* label = body["label"];
        if (label) setTitle(label);
        lv_obj_clean(content_);
        drawMenu(menu, r.path, r.path);
    });
}

void LvglUi::showPage() {
    clearPage();
    ensureEvents();
    ensureAuth();
    Route r = route_.back();
    std::string_view last = r.path;
    size_t slash = last.rfind('/');
    if (slash != std::string_view::npos) last = last.substr(slash + 1);
    setTitle(!r.title.empty() ? r.title : last.empty() ? rootLabel_ : model::humanize(last));
    message("Loading...", false);
    loading_ = true;
    // An element's page is built from its list's schema: the element's is
    // its items.
    schema(r.list.empty() ? r.path : r.list, 3, [this, r](Status s, JsonVariantConst reply) {
        if (s != Status::Ok) {
            failed("Couldn't read the page: ", s, reply);
            return;
        }
        lv_obj_clean(content_);
        std::string root = r.root.empty() ? root_ : r.root;
        if (r.signIn) {
            // One card: the login action, its argument's fields.
            page_ = model::Page();
            page_.path = model::parentPath(r.path);
            page_.label = r.title;
            Item card;
            card.kind = ItemKind::Section;
            card.schemaType = NodeType::Object;
            card.path = page_.path;
            card.level = 1;
            Item login = model::buildLeaf(r.path.substr(r.path.rfind('/') + 1), r.path, reply, page_.path, root, r.above);
            login.hidden = false;
            login.advanced = false;
            card.items.push_back(std::move(login));
            page_.cards.push_back(std::move(card));
            setTitle(r.title);
            lv_obj_t* body = this->card(page_.cards[0]);
            items(body, page_.cards[0].items);
            focusFirst();
            loading_ = false;
            return;
        }
        if (!r.list.empty()) {
            JsonObjectConst items = reply["items"];
            if (items.isNull()) {
                failed("Couldn't read the element: ", Status::NotFound, JsonVariantConst());
                return;
            }
            elementSchema_.set(items);
            listEditable_ = reply["writable"].as<bool>() && !reply["fixed"].as<bool>();
            if (r.scalar) {
                // An array's element: one value, of the items' type.
                JsonDocument column;
                column.set(items);
                if (column["type"].isNull()) column["type"] = "number";
                column["writable"] = reply["writable"].as<bool>();
                page_ = model::Page();
                page_.path = r.path;
                Item card;
                card.kind = ItemKind::Section;
                card.schemaType = NodeType::Object;
                card.path = r.path;
                card.level = 1;
                Item value = model::buildLeaf("value", r.path, column.as<JsonObjectConst>(), r.list, root, r.above);
                value.label = "Value";
                card.items.push_back(std::move(value));
                page_.cards.push_back(std::move(card));
            } else {
                page_ = model::buildPage(items, r.path, root, false, r.above);
            }
            page_.label = r.title;
        } else {
            page_ = model::buildPage(reply, r.path, root, r.status, r.above);
        }
        if (r.status) {
            setTitle("Status");
        } else if (!r.title.empty()) {
            setTitle(r.title);
        } else if (r.path == root_) {
            setTitle(rootLabel_);
        } else {
            setTitle(page_.label);
        }
        for (const Item& a : page_.actions) action(content_, a);
        for (const Item& c : page_.cards) {
            if (c.hidden) continue;
            lv_obj_t* body = card(c);
            Bound& b = bind(c, lv_obj_get_parent(body) == content_ ? body : lv_obj_get_parent(body));
            b.section = true;
            if (c.form) {
                form(body, c);
                continue;
            }
            bool hasItems = anyShown(c.items);
            items(body, c.items);
            if (hasItems) {
                advanced(body, c.advancedItems);
            } else {
                items(body, c.advancedItems);
            }
        }
        if (!r.list.empty() && listEditable_) removeFooter();
        if (page_.cards.empty() && page_.actions.empty()) message("Nothing to show here.", false);
        focusFirst();
        subscribe();
        for (auto& b : bound_) {
            if (b->widget == Widget::Select && b->item && !b->item->optionsFrom.empty()) loadChoices(*b);
        }
        watchConditions();
        watchNode();
    });
}

// The node the open screen belongs to: this one, or a peer behind it.
std::string LvglUi::nodeRoot() const {
    if (route_.empty() || route_.back().root.empty()) return root_;
    return route_.back().root;
}

// Events anywhere in the node, for the toasts of those with ui.toast
// (section 7.8): events only, no snapshot, kept across its pages.
void LvglUi::ensureEvents() {
    std::string wanted = nodeRoot();
    if (eventsPath_ == wanted) return;
    if (!eventsPath_.empty()) client_.unsubscribe(eventsPath_);
    eventsPath_ = wanted;
    tesser::Query q;
    q.changes = false;
    q.snapshot = false;
    q.interval = 60000;  // firmware that predates `changes`: one change a minute
    std::weak_ptr<int> alive = alive_;
    std::string path = wanted;
    bool sent = client_.subscribe(path, [this, alive, path](Status s, JsonVariantConst) {
        if (alive.expired() || s == Status::Ok) return;
        if (eventsPath_ == path) eventsPath_.clear();  // no toasts from this node; asked again on the next screen
    }, q);
    if (!sent) eventsPath_.clear();
}

void LvglUi::eventNotified(const std::string& path, JsonVariantConst body) {
    std::string payload = body.isNull() || body.isUnbound() ? std::string() : text(body);
    auto show = [this, payload](const EventInfo& info) {
        if (info.toast == model::Toast::None) return;
        toast(payload.empty() ? info.label : info.label + ": " + payload, info.toast);
    };
    for (const EventInfo& info : eventInfo_) {
        if (info.path == path) {
            show(info);
            return;
        }
    }
    // Its schema first: whether it toasts, and its label.
    tesser::Query q;
    q.view = tesser::View::Schema;
    q.depth = 0;
    std::weak_ptr<int> alive = alive_;
    client_.get(path, [this, alive, path, show](Status s, JsonVariantConst schema) {
        if (alive.expired() || s != Status::Ok) return;
        Item leaf = model::buildLeaf(path.substr(path.rfind('/') + 1), path, schema, model::parentPath(path));
        EventInfo info{path, leaf.toast, leaf.label};
        if (eventInfo_.size() >= 24) eventInfo_.erase(eventInfo_.begin());
        eventInfo_.push_back(info);
        show(info);
    }, q);
}

// ---- Data --------------------------------------------------------------------

void LvglUi::subscribe() {
    tesser::Query q;
    q.depth = page_.depth < 0 ? tesser::Query::kUnlimited : page_.depth;
    if (page_.hasKeys) q.keys = page_.keys;
    q.interval = kThrottleMs;
    q.events = false;  // the events subscription's
    const std::string& list = route_.empty() ? empty_ : route_.back().list;
    if (!list.empty()) {
        // An element: its list, whole (subscriptions below a list are refused).
        q.depth = tesser::Query::kUnlimited;
        q.keys = std::string_view();
    }
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    std::string path = list.empty() ? page_.path : list;
    subscribed_ = path;
    bool sent = client_.subscribe(
        path,
        [this, alive, gen](Status s, JsonVariantConst body) {
            if (alive.expired() || gen != gen_) return;
            loading_ = false;
            if (s == Status::Ok) {
                connection(true);
                setValues(body);
                syncAll();
                return;
            }
            subscribed_.clear();
            if (s == Status::Busy || s == Status::NotAllowed) {
                // No subscription to be had: read the page once a second.
                poll();
                pollTimer_ = lv_timer_create(
                    [](lv_timer_t* t) { static_cast<LvglUi*>(lv_timer_get_user_data(t))->poll(); }, kPollMs, this);
                return;
            }
            if (s == Status::Timeout) connection(false);
            retryTimer_ = lv_timer_create(
                [](lv_timer_t* t) {
                    LvglUi* ui = static_cast<LvglUi*>(lv_timer_get_user_data(t));
                    lv_timer_delete(t);
                    ui->retryTimer_ = nullptr;
                    ui->subscribe();
                },
                kRetryMs, this);
        },
        q);
    if (!sent) subscribed_.clear();
}

void LvglUi::poll() {
    if (polling_) return;  // one read at a time
    tesser::Query q;
    q.depth = page_.depth < 0 ? tesser::Query::kUnlimited : page_.depth;
    if (page_.hasKeys) q.keys = page_.keys;
    const std::string& list = route_.empty() ? empty_ : route_.back().list;
    if (!list.empty()) {
        q.depth = tesser::Query::kUnlimited;
        q.keys = std::string_view();
    }
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    polling_ = client_.get(
        list.empty() ? page_.path : list,
        [this, alive, gen](Status s, JsonVariantConst body) {
            if (alive.expired()) return;
            if (gen != gen_) return;
            polling_ = false;
            loading_ = false;
            if (s != Status::Ok) {
                if (s == Status::Timeout) connection(false);
                return;
            }
            connection(true);
            setValues(body);
            syncAll();
        },
        q);
}

// What a subscription's snapshot or a read brought: the page's values, or
// for an element's page, its list's.
void LvglUi::setValues(JsonVariantConst body) {
    if (!route_.empty() && !route_.back().list.empty()) {
        listValue_.set(body);
        values_.set(elementOf(listValue_.as<JsonVariantConst>()));
    } else {
        values_.set(body);
    }
    hasValues_ = true;
}

JsonVariantConst LvglUi::elementOf(JsonVariantConst list) const {
    const Route& r = route_.back();
    if (r.keyField.empty()) return list[static_cast<size_t>(strtoul(r.id.c_str(), nullptr, 10))];
    for (JsonVariantConst e : list.as<JsonArrayConst>()) {
        const char* k = e[r.keyField];
        if (k && r.id == k) return e;
    }
    return JsonVariantConst();
}

void LvglUi::unsubscribe() {
    // Each unsubscribes every subscription at its path, the events' too.
    for (const std::string* p : {&subscribed_, &watch_.path, &stubPath_}) {
        if (p->empty()) continue;
        client_.unsubscribe(*p);
        if (*p == eventsPath_) eventsPath_.clear();
    }
    watch_.path.clear();
    stubPath_.clear();
    subscribed_.clear();
    if (pollTimer_) lv_timer_delete(pollTimer_);
    pollTimer_ = nullptr;
    if (retryTimer_) lv_timer_delete(retryTimer_);
    retryTimer_ = nullptr;
    polling_ = false;
}

void LvglUi::onNotification(JsonObjectConst envelope) {
    const char* op = envelope["op"];
    const char* path = envelope["path"];
    if (!op || !path) return;
    if (strcmp(op, "event") == 0) {
        eventNotified(path, envelope["body"]);
        return;
    }
    if (strcmp(op, "change") != 0) return;
    if (watching_) {
        // The menu: a stub changed (a null), or notifications were lost.
        if (envelope["overflow"].as<bool>() || hasNull(envelope["body"])) {
            if (!menuTimer_) {
                menuTimer_ = lv_timer_create(
                    [](lv_timer_t* t) {
                        LvglUi* ui = static_cast<LvglUi*>(lv_timer_get_user_data(t));
                        lv_timer_delete(t);
                        ui->menuTimer_ = nullptr;
                        ui->refreshMenu();
                    },
                    300, this);  // a few mounts at once: one read
            }
        }
        return;
    }
    if (!stubPath_.empty() && model::isUnder(stubPath_, path) && hasNull(envelope["body"])) readStub();
    if (!watch_.path.empty() && watch_.has && (model::isUnder(path, watch_.path) || model::isUnder(watch_.path, path))) {
        applyTo(watch_.values, watch_.path, path, envelope["body"]);
        for (auto& b : bound_) conditions(*b);
    }
    if (!hasValues_) return;
    if (envelope["overflow"].as<bool>()) {
        // Notifications were lost: read the page again.
        poll();
        return;
    }
    const std::string& list = route_.empty() ? empty_ : route_.back().list;
    if (!list.empty()) {
        // The list, whole, or a patch of an ancestor holding it.
        if (!model::isUnder(list, path)) return;
        JsonVariantConst v = envelope["body"];
        for (std::string_view seg : segmentsOf(std::string_view(list).substr(std::string_view(path) == "/" ? 0 : strlen(path)))) {
            v = v[std::string(seg)];
        }
        if (v.isUnbound()) return;
        setValues(v);
        syncAll();
        return;
    }
    apply(path, envelope["body"]);
    syncAll();
}

// A merge patch at `path` (section 7.3), into the page's values.
void LvglUi::apply(std::string_view path, JsonVariantConst body) { applyTo(values_, page_.path, path, body); }

// The same into `doc`, the values below `at`.
void LvglUi::applyTo(JsonDocument& doc, const std::string& at, std::string_view path, JsonVariantConst body) {
    if (model::isUnder(path, at)) {
        std::vector<std::string_view> rel = segmentsOf(path.substr(at == "/" ? 0 : at.size()));
        if (rel.empty()) {
            if (body.is<JsonObjectConst>()) {
                JsonObject root = doc.is<JsonObject>() ? doc.as<JsonObject>() : doc.to<JsonObject>();
                merge(root, body.as<JsonObjectConst>());
            } else {
                doc.set(body);
            }
            return;
        }
        JsonObject node = doc.is<JsonObject>() ? doc.as<JsonObject>() : doc.to<JsonObject>();
        for (size_t i = 0; i + 1 < rel.size(); i++) {
            std::string key(rel[i]);
            node = node[key].is<JsonObject>() ? node[key].as<JsonObject>() : node[key].to<JsonObject>();
        }
        std::string key(rel.back());
        if (body.is<JsonObjectConst>()) {
            JsonObject child = node[key].is<JsonObject>() ? node[key].as<JsonObject>() : node[key].to<JsonObject>();
            merge(child, body.as<JsonObjectConst>());
        } else {
            node[key] = body;
        }
    } else if (model::isUnder(at, path)) {
        // A notification for an ancestor: the page's part of it.
        JsonVariantConst sub = body;
        for (std::string_view s : segmentsOf(std::string_view(at).substr(path == "/" ? 0 : path.size()))) {
            sub = sub[std::string(s)];
        }
        if (sub.isUnbound()) return;
        if (sub.is<JsonObjectConst>()) {
            JsonObject root = doc.is<JsonObject>() ? doc.as<JsonObject>() : doc.to<JsonObject>();
            merge(root, sub.as<JsonObjectConst>());
        } else {
            doc.set(sub);
        }
    }
}

JsonVariantConst LvglUi::valueAt(std::string_view path) const {
    const std::string& at = page_.path;
    if (!hasValues_ || !model::isUnder(path, at)) return JsonVariantConst();
    JsonVariantConst v = values_.as<JsonVariantConst>();
    for (std::string_view s : segmentsOf(path.substr(at == "/" ? 0 : at.size()))) {
        v = v[std::string(s)];
        if (v.isUnbound()) break;
    }
    return v;
}

void LvglUi::setValueAt(std::string_view path, JsonVariantConst value) {
    if (!hasValues_ || !model::isUnder(path, page_.path)) return;
    apply(path, JsonVariantConst());
    // Replace rather than merge: the reply is the whole value read back.
    const std::string& at = page_.path;
    std::vector<std::string_view> rel = segmentsOf(path.substr(at == "/" ? 0 : at.size()));
    if (rel.empty()) {
        values_.set(value);
        return;
    }
    JsonObject node = values_.is<JsonObject>() ? values_.as<JsonObject>() : values_.to<JsonObject>();
    for (size_t i = 0; i + 1 < rel.size(); i++) {
        std::string key(rel[i]);
        node = node[key].is<JsonObject>() ? node[key].as<JsonObject>() : node[key].to<JsonObject>();
    }
    node[std::string(rel.back())] = value;
}

bool LvglUi::holds(const std::vector<model::Condition>& conds) const {
    for (const model::Condition& c : conds) {
        JsonVariantConst v;
        if (model::isUnder(c.path, page_.path)) {
            v = valueAt(c.path);
        } else if (watch_.has && model::isUnder(c.path, watch_.path)) {
            v = watch_.values.as<JsonVariantConst>();
            for (std::string_view seg : segmentsOf(std::string_view(c.path).substr(watch_.path == "/" ? 0 : watch_.path.size()))) {
                v = v[std::string(seg)];
            }
        } else {
            continue;  // not read (yet, or a list's): the test passes
        }
        if (!model::holds(c, v)) return false;
    }
    return true;
}

void LvglUi::conditions(Bound& b) {
    if (!b.item || !b.row) return;
    if (!b.item->visibleWhen.empty()) {
        lv_obj_set_hidden(b.row, !(holds(b.item->visibleWhen)));
    }
    // Enabled: by its conditions, the client's level, the node online, and
    // for a call, not while it is in flight.
    bool on = (b.item->enabledWhen.empty() || holds(b.item->enabledWhen)) && allowed(*b.item) && !offline_;
    if (b.item->isAction() && b.pending > 0 && b.item->widget != Widget::Hold) on = false;
    auto set = [on](lv_obj_t* o) {
        if (on) {
            lv_obj_remove_state(o, LV_STATE_DISABLED);
        } else {
            lv_obj_add_state(o, LV_STATE_DISABLED);
        }
    };
    for (lv_obj_t* o : {b.control, b.button, b.minus, b.plus, b.zero}) {
        if (!o || b.widget == Widget::Link || b.section) continue;
        if (b.widget == Widget::Flags || b.widget == Widget::Color || b.widget == Widget::List || b.widget == Widget::Table) {
            // Their controls are inside.
            uint32_t n = lv_obj_get_child_count(o);
            for (uint32_t i = 0; i < n; i++) {
                lv_obj_t* c = lv_obj_get_child(o, static_cast<int32_t>(i));
                set(c);
                if (b.widget == Widget::Color) set(lv_obj_get_child(c, 1));
            }
            continue;
        }
        set(o);
    }
}

void LvglUi::syncAll() {
    for (auto& b : bound_) {
        sync(*b);
        conditions(*b);
    }
}

void LvglUi::sync(Bound& b) {
    if (!b.item || b.section || b.forAction || b.pending > 0 || b.edited || typing_ == &b || (!b.control && !b.value)) return;
    if (b.item->isAction() || b.widget == Widget::Link) return;
    // An action argument's fields have no value to follow.
    if (b.draft && drafts_[b.draft - 1].action) return;
    JsonVariantConst v = valueAt(b.item->path);
    if (v.isUnbound()) return;
    std::string json;
    serializeJson(v, json);
    if (json == b.shown) return;
    const Item& item = *b.item;
    switch (b.widget) {
        case Widget::Toggle:
        case Widget::Checkbox:
            if (v.as<bool>()) {
                lv_obj_add_state(b.control, LV_STATE_CHECKED);
            } else {
                lv_obj_remove_state(b.control, LV_STATE_CHECKED);
            }
            break;
        case Widget::Led:
            if (v.as<bool>()) {
                lv_led_on(b.control);
            } else {
                lv_led_off(b.control);
            }
            break;
        case Widget::Slider:
            if (lv_slider_is_dragged(b.control)) return;  // the finger wins until it lifts
            lv_slider_set_value(b.control, static_cast<int32_t>(lround(v.as<double>() * b.scale)), LV_ANIM_OFF);
            setLabel(b.value, model::formatValue(v, item).c_str());
            break;
        case Widget::Bar:
            lv_bar_set_value(b.control, static_cast<int32_t>(lround(v.as<double>() * b.scale)), LV_ANIM_OFF);
            setLabel(b.value, model::formatValue(v, item).c_str());
            break;
        case Widget::Number: {
            Item plain = item;
            plain.unit.clear();
            lv_textarea_set_text(b.control, model::formatValue(v, plain).c_str());
            break;
        }
        case Widget::Segmented: {
            lv_buttonmatrix_clear_button_ctrl_all(b.control, LV_BUTTONMATRIX_CTRL_CHECKED);
            const char* s = v.as<const char*>();
            for (size_t i = 0; s && i < item.options.size(); i++) {
                if (item.options[i].value == s) {
                    lv_buttonmatrix_set_button_ctrl(b.control, static_cast<uint32_t>(i), LV_BUTTONMATRIX_CTRL_CHECKED);
                }
            }
            break;
        }
        case Widget::Select: {
            const char* s = v.as<const char*>();
            bool found = false;
            const std::vector<model::Option>& options = b.hasChoices ? b.choices : item.options;
            for (size_t i = 0; s && i < options.size(); i++) {
                if (options[i].value == s) {
                    lv_dropdown_set_selected(b.control, static_cast<uint32_t>(i));
                    found = true;
                }
            }
            // A value that isn't among the options (a keyed list's key) is
            // shown as it is.
            b.dropdownText = found ? std::string() : text(v);
            if (!found) b.dropdownText = fit(b.dropdownText);
            lv_dropdown_set_text(b.control, found ? nullptr : b.dropdownText.c_str());
            break;
        }
        case Widget::Text:
        case Widget::Password:
        case Widget::Textarea:
            if (item.secret) break;  // never read back (section 4)
            lv_textarea_set_text(b.control, text(v).c_str());
            break;
        case Widget::List:
        case Widget::Table:
            rows(b, v);
            break;
        case Widget::Chart: {
            if (item.schemaType == NodeType::Array) {
                // The array, plotted by index.
                JsonArrayConst a = v.as<JsonArrayConst>();
                uint32_t n = static_cast<uint32_t>(a.size() < 2 ? 2 : a.size());
                lv_chart_set_point_count(b.control, n);
                b.samples.clear();
                for (JsonVariantConst x : a) b.samples.push_back(x.as<double>());
                for (uint32_t i = 0; i < b.samples.size(); i++) {
                    lv_chart_set_series_value_by_id(b.control, b.series, i, static_cast<int32_t>(lround(b.samples[i] * b.scale)));
                }
            } else {
                // A value's history, kept while it is watched (section 7.7).
                b.samples.push_back(v.as<double>());
                if (b.samples.size() > lv_chart_get_point_count(b.control)) b.samples.erase(b.samples.begin());
                lv_chart_set_next_value(b.control, b.series, static_cast<int32_t>(lround(v.as<double>() * b.scale)));
                setLabel(b.value, model::formatValue(v, item).c_str());
            }
            double lo = item.hasMin ? item.min : 0, hi = item.hasMax ? item.max : 0;
            if (!(item.hasMin && item.hasMax) && !b.samples.empty()) {
                lo = hi = b.samples[0];
                for (double x : b.samples) {
                    lo = fmin(lo, x);
                    hi = fmax(hi, x);
                }
                double pad = hi > lo ? (hi - lo) * 0.1 : (fabs(hi) > 0 ? fabs(hi) * 0.1 : 1);
                lo -= pad;
                hi += pad;
            }
            lv_chart_set_axis_range(b.control, LV_CHART_AXIS_PRIMARY_Y, static_cast<int32_t>(floor(lo * b.scale)),
                                    static_cast<int32_t>(ceil(hi * b.scale)));
            lv_chart_refresh(b.control);
            break;
        }
        case Widget::Flags: {
            uint32_t bits = v.as<uint32_t>();
            uint32_t n = lv_obj_get_child_count(b.control);
            for (uint32_t i = 0; i < n; i++) {
                lv_obj_t* box = lv_obj_get_child(b.control, static_cast<int32_t>(i));
                if (bits & (1u << i)) {
                    lv_obj_add_state(box, LV_STATE_CHECKED);
                } else {
                    lv_obj_remove_state(box, LV_STATE_CHECKED);
                }
            }
            break;
        }
        case Widget::Color: {
            for (uint32_t i = 0; i < 3; i++) {
                if (lv_slider_is_dragged(lv_obj_get_child(lv_obj_get_child(b.control, static_cast<int32_t>(i)), 1))) return;
            }
            uint8_t rgb[3];
            colorOf(v, rgb);
            for (uint32_t i = 0; i < 3; i++) {
                lv_slider_set_value(lv_obj_get_child(lv_obj_get_child(b.control, static_cast<int32_t>(i)), 1), rgb[i], LV_ANIM_OFF);
            }
            lv_obj_set_style_bg_color(b.swatch, lv_color_make(rgb[0], rgb[1], rgb[2]), 0);
            break;
        }
        default: {
            // A readout: enums by their labels.
            std::string t = model::formatValue(v, item);
            const char* s = v.as<const char*>();
            for (size_t i = 0; s && i < item.options.size(); i++) {
                if (item.options[i].value == s) t = item.options[i].label;
            }
            setLabel(b.value, t.c_str());
            break;
        }
    }
    b.shown = json;
}

// ---- Rendering ---------------------------------------------------------------

lv_obj_t* LvglUi::row(lv_obj_t* parent, bool column) {
    lv_obj_t* r = lv_obj_create(parent);
    lv_obj_remove_style_all(r);
    lv_obj_set_size(r, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(r, column ? LV_FLEX_FLOW_COLUMN : LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(r, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(r, 4, 0);
    lv_obj_set_style_pad_column(r, 6, 0);
    if (!column) lv_obj_set_style_min_height(r, m_.row, 0);
    lv_obj_set_scrollable(r, false);
    return r;
}

lv_obj_t* LvglUi::label(lv_obj_t* parent, const std::string& t, bool grow) {
    lv_obj_t* l = lv_label_create(parent);
    setLabel(l, t.c_str());
    if (grow) {
        lv_obj_set_flex_grow(l, 1);
        lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_WRAP);
    }
    return l;
}

// A heading that opens and closes the body under it.
lv_obj_t* LvglUi::collapsible(lv_obj_t* parent, const std::string& t, bool open) {
    lv_obj_t* head = row(parent, false);
    lv_obj_set_clickable(head, true);
    lv_obj_t* l = lv_label_create(head);
    std::string caption = std::string(open ? LV_SYMBOL_DOWN " " : LV_SYMBOL_RIGHT " ") + t;
    setLabel(l, caption.c_str());
    lv_obj_set_style_text_opa(l, LV_OPA_80, 0);
    lv_obj_t* body = row(parent, true);
    if (!open) lv_obj_set_hidden(body, true);
    lv_obj_add_event_cb(
        head,
        [](lv_event_t* e) {
            lv_obj_t* h = lv_event_get_target_obj(e);
            lv_obj_t* b = static_cast<lv_obj_t*>(lv_event_get_user_data(e));
            bool opening = lv_obj_is_hidden(b);
            lv_obj_set_hidden(b, !(opening));
            lv_obj_t* hl = lv_obj_get_child(h, 0);
            std::string now = lv_label_get_text(hl);
            // The symbol is the first 3 bytes (one private-use code point).
            now = std::string(opening ? LV_SYMBOL_DOWN : LV_SYMBOL_RIGHT) + now.substr(3);
            lv_label_set_text(hl, now.c_str());  // fitted when it was made
        },
        LV_EVENT_CLICKED, body);
    return body;
}

lv_obj_t* LvglUi::card(const Item& section) {
    lv_obj_t* c = lv_obj_create(content_);
    lv_obj_set_size(c, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(c, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(c, m_.cardPad, 0);
    lv_obj_set_style_pad_row(c, m_.compact ? 2 : 4, 0);
    lv_obj_set_scrollable(c, false);
    if (section.label.empty()) return c;
    if (section.collapsed) return collapsible(c, section.label, false);
    lv_obj_t* t = label(c, section.label, false);
#if LV_FONT_MONTSERRAT_16
    if (!m_.compact) lv_obj_set_style_text_font(t, &lv_font_montserrat_16, 0);
#endif
    return c;
}

void LvglUi::items(lv_obj_t* parent, const std::vector<Item>& list) {
    for (const Item& item : list) {
        if (item.hidden || &item == skip_) continue;
        switch (item.kind) {
            case ItemKind::Leaf:
                leaf(parent, item);
                break;
            case ItemKind::Link:
                if (item.remote) {
                    link(parent, item, Route::to(item.path, item.path, true));  // the peer's menu
                } else {
                    Route to = Route::to(item.path, route_.back().root);
                    to.above = item.access;
                    link(parent, item, to);
                }
                break;
            case ItemKind::Section: {
                // Collapsible groups, tabs and what the schema's depth cut
                // become pages of their own (section 6.4).
                if (item.lazy || item.tabs || item.level >= 3) {
                    Route to = Route::to(item.path, route_.back().root);
                    to.above = item.access;
                    link(parent, item, to);
                    break;
                }
                lv_obj_t* sub = row(parent, true);
                lv_obj_set_style_pad_top(sub, 4, 0);
                Bound& b = bind(item, sub);
                b.section = true;
                lv_obj_t* h = label(sub, item.label, false);
                lv_obj_set_style_text_opa(h, LV_OPA_80, 0);
                lv_obj_set_style_text_color(h, lv_palette_lighten(LV_PALETTE_BLUE, 2), 0);
                if (item.form) {
                    form(sub, item);
                } else if (anyShown(item.items)) {
                    items(sub, item.items);
                    advanced(sub, item.advancedItems);
                } else {
                    items(sub, item.advancedItems);
                }
                break;
            }
        }
    }
}

void LvglUi::advanced(lv_obj_t* parent, const std::vector<Item>& list) {
    if (!anyShown(list)) return;
    items(collapsible(parent, "Advanced", false), list);
}

void LvglUi::dot(lv_obj_t* parent, bool online) {
    lv_obj_t* d = lv_obj_create(parent);
    lv_obj_set_size(d, 10, 10);
    lv_obj_set_style_radius(d, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(d, 0, 0);
    lv_obj_set_style_bg_color(d, online ? lv_palette_main(LV_PALETTE_GREEN) : lv_palette_main(LV_PALETTE_GREY), 0);
}

void LvglUi::link(lv_obj_t* parent, const Item& item, const Route& target) {
    lv_obj_t* r = row(parent, false);
    lv_obj_set_clickable(r, true);
    label(r, item.label, true);
    if (item.remote) dot(r, item.online);
    lv_obj_t* chevron = lv_label_create(r);
    setLabel(chevron, LV_SYMBOL_RIGHT);
    Bound& b = bind(item, r);
    b.widget = Widget::Link;
    b.control = r;
    b.target = target;
    lv_obj_add_event_cb(r, onEvent, LV_EVENT_CLICKED, &b);
    focusable(r);
}

// What this renderer doesn't draw yet: its label, and a note.
void LvglUi::webOnly(lv_obj_t* parent, const std::string& text) {
    lv_obj_t* r = row(parent, false);
    label(r, text, true);
    lv_obj_t* note = label(r, "web only", false);
    lv_obj_set_style_text_opa(note, LV_OPA_50, 0);
}

LvglUi::Bound& LvglUi::bind(const Item& item, lv_obj_t* r) {
    auto b = std::make_unique<Bound>();
    b->ui = this;
    b->index = bound_.size();
    b->item = &item;
    b->row = r;
    b->draft = drafting_;
    bound_.push_back(std::move(b));
    return *bound_.back();
}

void LvglUi::leaf(lv_obj_t* parent, const Item& item) {
    if (item.isAction()) {
        action(parent, item);
        return;
    }
    if (item.widget == Widget::List || item.widget == Widget::Table) {
        list(parent, item);
        return;
    }
    Widget w;
    Draw d = drawn(item, w);
    if (d == Draw::Hidden) return;
    if (d == Draw::WebOnly) {
        webOnly(parent, item.label);
        return;
    }
    bool column = twoLines(w);
    lv_obj_t* r = row(parent, column);
    lv_obj_t* top = column ? row(r, false) : r;
    label(top, item.label, true);
    Bound& b = bind(item, r);
    if (w == Widget::Color) {
        b.swatch = lv_obj_create(top);
        lv_obj_set_size(b.swatch, 36, 20);
        lv_obj_set_style_radius(b.swatch, 4, 0);
        lv_obj_set_style_border_width(b.swatch, 1, 0);
        lv_obj_set_style_bg_color(b.swatch, lv_color_black(), 0);
    }
    if (w == Widget::Slider || w == Widget::Bar || w == Widget::Readout || (w == Widget::Chart && item.schemaType != NodeType::Array)) {
        b.value = lv_label_create(top);
        setLabel(b.value, "\xE2\x80\x93");  // – until the value comes
        if (item.style == "warning") lv_obj_set_style_text_color(b.value, lv_palette_main(LV_PALETTE_AMBER), 0);
    }
    if (w == Widget::Readout) {
        b.widget = w;
        return;
    }
    control(b, column ? r : top, w);
    // A kept-alive number gets a way back to 0: dragging to exactly 0 is hard.
    if (item.keepalive && item.editable && item.type != NodeType::Boolean && !b.draft) {
        b.zero = lv_button_create(top);
        lv_obj_set_size(b.zero, m_.button, m_.button);
        lv_obj_t* z = lv_label_create(b.zero);
        lv_label_set_text(z, "0");
        lv_obj_center(z);
        lv_obj_add_event_cb(b.zero, onEvent, LV_EVENT_CLICKED, &b);
        focusable(b.zero);
    }
}

lv_obj_t* LvglUi::control(Bound& b, lv_obj_t* parent, Widget w) {
    const Item& item = *b.item;
    b.widget = w;
    lv_obj_t* c = nullptr;
    auto on = [&](lv_obj_t* o, std::initializer_list<lv_event_code_t> codes) {
        for (lv_event_code_t code : codes) lv_obj_add_event_cb(o, onEvent, code, &b);
    };
    switch (w) {
        case Widget::Toggle:
            c = lv_switch_create(parent);
            on(c, {LV_EVENT_VALUE_CHANGED});
            break;
        case Widget::Checkbox:
            c = lv_checkbox_create(parent);
            lv_checkbox_set_text(c, "");
            on(c, {LV_EVENT_VALUE_CHANGED});
            break;
        case Widget::Led:
            c = lv_led_create(parent);
            lv_obj_set_size(c, 14, 14);
            lv_led_set_color(c, lv_palette_main(LV_PALETTE_GREEN));
            lv_led_off(c);
            break;
        case Widget::Slider:
            c = lv_slider_create(parent);
            lv_obj_set_width(c, LV_PCT(92));
            lv_obj_set_style_margin_hor(c, 10, 0);
            lv_obj_set_style_margin_ver(c, 6, 0);
            b.scale = scaleFor(item);
            lv_slider_set_range(c, static_cast<int32_t>(lround(item.min * b.scale)),
                                static_cast<int32_t>(lround(item.max * b.scale)));
            on(c, {LV_EVENT_VALUE_CHANGED, LV_EVENT_RELEASED});
            lv_obj_add_event_cb(c, onSliderKey, static_cast<lv_event_code_t>(LV_EVENT_KEY | LV_EVENT_PREPROCESS), &b);
            break;
        case Widget::Bar:
            c = lv_bar_create(parent);
            lv_obj_set_size(c, LV_PCT(100), 10);
            b.scale = scaleFor(item);
            lv_bar_set_range(c, static_cast<int32_t>(lround(item.min * b.scale)), static_cast<int32_t>(lround(item.max * b.scale)));
            break;
        case Widget::Number: {
            lv_obj_t* box = row(parent, false);
            lv_obj_set_width(box, LV_SIZE_CONTENT);
            lv_obj_set_style_pad_column(box, 4, 0);
            b.minus = lv_button_create(box);
            lv_obj_set_size(b.minus, m_.button, m_.button);
            lv_obj_t* m = lv_label_create(b.minus);
            setLabel(m, LV_SYMBOL_MINUS);
            lv_obj_center(m);
            c = lv_textarea_create(box);
            lv_textarea_set_one_line(c, true);
            lv_textarea_set_accepted_chars(c, "0123456789.-");
            lv_textarea_set_max_length(c, 16);
            lv_obj_set_width(c, m_.compact ? 60 : 76);
            lv_obj_set_style_pad_ver(c, m_.fieldPad, 0);
            if (!item.unit.empty()) label(box, item.unit, false);
            b.plus = lv_button_create(box);
            lv_obj_set_size(b.plus, m_.button, m_.button);
            lv_obj_t* p = lv_label_create(b.plus);
            setLabel(p, LV_SYMBOL_PLUS);
            lv_obj_center(p);
            for (lv_obj_t* o : {b.minus, b.plus}) on(o, {LV_EVENT_CLICKED, LV_EVENT_LONG_PRESSED_REPEAT});
            on(c, {LV_EVENT_CLICKED, LV_EVENT_FOCUSED, LV_EVENT_READY, LV_EVENT_CANCEL});
            break;
        }
        case Widget::Segmented: {
            c = lv_buttonmatrix_create(parent);
            b.map.clear();
            b.mapText.clear();
            for (const model::Option& o : item.options) b.mapText.push_back(fit(o.label));
            for (const std::string& t : b.mapText) b.map.push_back(t.c_str());
            b.map.push_back("");
            lv_buttonmatrix_set_map(c, b.map.data());
            lv_buttonmatrix_set_button_ctrl_all(c, LV_BUTTONMATRIX_CTRL_CHECKABLE);
            lv_buttonmatrix_set_one_checked(c, true);
            lv_obj_set_size(c, LV_PCT(100), m_.segmented);
            lv_obj_set_style_pad_all(c, 3, 0);
            on(c, {LV_EVENT_VALUE_CHANGED});
            break;
        }
        case Widget::Select: {
            c = lv_dropdown_create(parent);
            std::string options;
            for (const model::Option& o : item.options) {
                if (!options.empty()) options += '\n';
                options += o.label;
            }
            lv_dropdown_set_options(c, fit(options).c_str());
            lv_obj_set_width(c, b.forAction ? LV_PCT(55) : m_.compact ? 110 : 140);
            on(c, {LV_EVENT_VALUE_CHANGED});
            break;
        }
        case Widget::Text:
        case Widget::Password:
        case Widget::Textarea:
            c = lv_textarea_create(parent);
            lv_obj_set_width(c, b.forAction ? LV_PCT(60) : LV_PCT(100));
            if (w == Widget::Textarea && !b.forAction) {
                lv_obj_set_height(c, 64);
            } else {
                lv_textarea_set_one_line(c, true);
            }
            lv_obj_set_style_pad_ver(c, m_.fieldPad, 0);
            if (item.maxLength) lv_textarea_set_max_length(c, item.maxLength);
            if (w == Widget::Password || item.secret) {
                lv_textarea_set_password_mode(c, true);
                lv_textarea_set_placeholder_text(c, "\xE2\x80\xA2\xE2\x80\xA2\xE2\x80\xA2\xE2\x80\xA2\xE2\x80\xA2\xE2\x80\xA2");
            } else if (!item.placeholder.empty()) {
                lv_textarea_set_placeholder_text(c, fit(item.placeholder).c_str());
            }
            on(c, {LV_EVENT_CLICKED, LV_EVENT_FOCUSED, LV_EVENT_READY, LV_EVENT_CANCEL});
            break;
        case Widget::Chart: {
            c = lv_chart_create(parent);
            lv_obj_set_size(c, LV_PCT(100), m_.chart);
            lv_chart_set_type(c, LV_CHART_TYPE_LINE);
            lv_chart_set_div_line_count(c, 3, 0);
            lv_obj_set_style_size(c, 0, 0, LV_PART_INDICATOR);  // no point markers
            uint32_t n = item.history ? item.history : 60;
            lv_chart_set_point_count(c, n < 10 ? 10 : n > 120 ? 120 : n);
            b.scale = scaleFor(item);
            b.series = lv_chart_add_series(c, lv_palette_main(LV_PALETTE_BLUE), LV_CHART_AXIS_PRIMARY_Y);
            lv_chart_set_all_values(c, b.series, LV_CHART_POINT_NONE);
            break;
        }
        case Widget::Flags: {
            c = row(parent, false);
            lv_obj_set_flex_flow(c, LV_FLEX_FLOW_ROW_WRAP);
            lv_obj_set_style_pad_column(c, 10, 0);
            size_t n = item.flagLabels.size();
            for (size_t i = 0; i < n; i++) {
                lv_obj_t* box = lv_checkbox_create(c);
                lv_checkbox_set_text(box, fit(item.flagLabels[i]).c_str());
                if (!item.editable) lv_obj_add_state(box, LV_STATE_DISABLED);
                on(box, {LV_EVENT_VALUE_CHANGED});
                focusable(box);
            }
            break;
        }
        case Widget::Color: {
            c = row(parent, true);
            static const char* const names[3] = {"R", "G", "B"};
            for (int i = 0; i < 3; i++) {
                lv_obj_t* line = row(c, false);
                lv_obj_set_style_min_height(line, 24, 0);
                label(line, names[i], false);
                lv_obj_t* sl = lv_slider_create(line);
                lv_obj_set_flex_grow(sl, 1);
                lv_obj_set_style_margin_right(sl, 10, 0);
                lv_slider_set_range(sl, 0, 255);
                on(sl, {LV_EVENT_VALUE_CHANGED, LV_EVENT_RELEASED});
                lv_obj_add_event_cb(sl, onSliderKey, static_cast<lv_event_code_t>(LV_EVENT_KEY | LV_EVENT_PREPROCESS), &b);
                focusable(sl);
            }
            break;
        }
        default:
            break;
    }
    b.control = c;
    if (c && w != Widget::Flags && w != Widget::Color) focusable(c);
    return c;
}

void LvglUi::action(lv_obj_t* parent, const Item& item) {
    // An object argument: its fields, then the button (section 4). Raw JSON
    // ones are hidden on LCD.
    if (item.type == NodeType::Object && item.value.empty()) {
        params(parent, item);
        return;
    }
    if (item.hasField && item.field == Widget::Json) return;
    Widget field = Widget::Readout;
    bool hasField = false;
    if (item.hasField) {
        Item probe = item;
        probe.widget = item.field;
        Draw d = drawn(probe, field);
        if (d != Draw::Control || field == Widget::Readout || field == Widget::Led || field == Widget::Bar) {
            webOnly(parent, item.label);
            return;
        }
        hasField = true;
    }
    lv_obj_t* r = row(parent, true);
    Bound& b = bind(item, r);
    b.widget = item.widget;
    lv_obj_t* line = r;
    if (hasField) {
        // The argument's input, then the button.
        b.forAction = true;
        bool own = twoLines(field) && field != Widget::Text && field != Widget::Password;
        if (own) {
            lv_obj_t* top = row(r, false);
            label(top, item.label, true);
            if (field == Widget::Slider) {
                b.value = lv_label_create(top);
                setLabel(b.value, "");
            }
            control(b, r, field);
            line = row(r, false);
        } else {
            line = row(r, false);
            control(b, line, field);
        }
        if (field == Widget::Slider && item.hasMin) {
            lv_slider_set_value(b.control, static_cast<int32_t>(lround(item.min * b.scale)), LV_ANIM_OFF);
            setLabel(b.value, model::formatNumber(item.min, item).c_str());
        } else if (field == Widget::Number) {
            lv_textarea_set_text(b.control, model::formatNumber(clampTo(item, 0), Item()).c_str());
        }
        b.widget = item.widget;  // events of the field come with the action's widget
        b.fieldWidget = field;
    } else {
        line = row(r, false);
    }
    b.button = lv_button_create(line);
    if (hasField) {
        lv_obj_set_flex_grow(b.button, 1);
    } else {
        lv_obj_set_width(b.button, LV_PCT(100));
    }
    if (item.style == "danger") lv_obj_set_style_bg_color(b.button, lv_palette_main(LV_PALETTE_RED), 0);
    lv_obj_t* t = lv_label_create(b.button);
    setLabel(t, item.label.c_str());
    lv_obj_center(t);
    if (item.widget == Widget::Hold) {
        for (lv_event_code_t code : {LV_EVENT_PRESSED, LV_EVENT_RELEASED, LV_EVENT_PRESS_LOST}) {
            lv_obj_add_event_cb(b.button, onEvent, code, &b);
        }
    } else {
        lv_obj_add_event_cb(b.button, onEvent, LV_EVENT_CLICKED, &b);
    }
    focusable(b.button);
    b.result = lv_label_create(r);
    lv_obj_set_width(b.result, LV_PCT(100));
    lv_label_set_long_mode(b.result, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_opa(b.result, LV_OPA_80, 0);
    lv_obj_set_hidden(b.result, true);
}

// ---- Events ------------------------------------------------------------------

void LvglUi::onEvent(lv_event_t* e) {
    Bound* b = static_cast<Bound*>(lv_event_get_user_data(e));
    b->ui->event(*b, e);
}

std::string LvglUi::controlJson(Bound& b) {
    const Item& item = *b.item;
    Widget w = b.forAction ? b.fieldWidget : b.widget;
    switch (w) {
        case Widget::Toggle:
        case Widget::Checkbox:
            return lv_obj_has_state(b.control, LV_STATE_CHECKED) ? "true" : "false";
        case Widget::Slider: {
            double v = snap(item, lv_slider_get_value(b.control) / b.scale);
            return numberJson(item, v);
        }
        case Widget::Number: {
            const char* t = lv_textarea_get_text(b.control);
            char* end = nullptr;
            double v = strtod(t, &end);
            if (end == t) return std::string();
            return numberJson(item, clampTo(item, v));
        }
        case Widget::Segmented: {
            uint32_t i = lv_buttonmatrix_get_selected_button(b.control);
            if (i >= item.options.size()) return std::string();
            return jsonString(item.options[i].value);
        }
        case Widget::Select: {
            uint32_t i = lv_dropdown_get_selected(b.control);
            const std::vector<model::Option>& options = b.hasChoices ? b.choices : item.options;
            if (i >= options.size()) return std::string();
            return jsonString(options[i].value);
        }
        case Widget::Text:
        case Widget::Password:
        case Widget::Textarea:
            return jsonString(lv_textarea_get_text(b.control));
        case Widget::Flags: {
            uint32_t bits = 0;
            uint32_t n = lv_obj_get_child_count(b.control);
            for (uint32_t i = 0; i < n; i++) {
                if (lv_obj_has_state(lv_obj_get_child(b.control, static_cast<int32_t>(i)), LV_STATE_CHECKED)) bits |= 1u << i;
            }
            return std::to_string(bits);
        }
        case Widget::Color: {
            uint32_t c = 0;
            for (int i = 0; i < 3; i++) {
                c = (c << 8) | static_cast<uint32_t>(lv_slider_get_value(lv_obj_get_child(lv_obj_get_child(b.control, i), 1)));
            }
            if (item.type == NodeType::Integer) return std::to_string(c);
            char hex[8];
            snprintf(hex, sizeof(hex), "#%06x", static_cast<unsigned>(c));
            return jsonString(hex);
        }
        default:
            return std::string();
    }
}

void LvglUi::event(Bound& b, lv_event_t* e) {
    lv_event_code_t code = lv_event_get_code(e);
    lv_obj_t* target = lv_event_get_target_obj(e);
    if (code == LV_EVENT_FOCUSED) {
        // An encoder's press puts a field in edit mode (and focuses it
        // again) rather than clicking it: the keyboard then.
        if (!useGroup_ || !lv_group_get_editing(group_) || lv_group_get_focused(group_) != target || typing_) return;
        code = LV_EVENT_CLICKED;
    }
    if (b.widget == Widget::Link) {
        route_.push_back(b.target);
        requestShow();
        return;
    }
    if (b.draftApply) {
        submitDraft(b.draftApply - 1);
        return;
    }
    if (b.draftReset) {
        resetDraft(b.draftReset - 1);
        return;
    }
    const Item& item = *b.item;
    if (target == b.button) {
        if (item.widget == Widget::Hold) {
            if (code == LV_EVENT_PRESSED) {
                call(b, "true");
                if (!b.hold) {
                    b.hold = lv_timer_create(
                        [](lv_timer_t* t) {
                            Bound* hb = static_cast<Bound*>(lv_timer_get_user_data(t));
                            hb->ui->client_.set(hb->item->path, "true");
                        },
                        item.keepalive ? item.keepalive : 300, &b);
                }
            } else {
                if (b.hold) lv_timer_delete(b.hold);
                b.hold = nullptr;
                call(b, "false");
            }
            return;
        }
        std::string arg = "null";
        if (!item.value.empty()) {
            arg = item.value;
        } else if (b.forAction) {
            arg = controlJson(b);
            if (arg.empty()) {
                toast(item.label + ": enter a value first", true);
                return;
            }
        }
        confirmThen(b, arg);
        return;
    }
    if (target == b.zero && b.zero) {
        if (b.widget == Widget::Slider) {
            lv_slider_set_value(b.control, static_cast<int32_t>(lround(clampTo(item, 0) * b.scale)), LV_ANIM_OFF);
        } else if (b.widget == Widget::Number) {
            lv_textarea_set_text(b.control, "0");
        }
        commit(b, numberJson(item, clampTo(item, 0)));
        return;
    }
    Widget w = b.forAction ? b.fieldWidget : b.widget;
    switch (w) {
        case Widget::Slider:
        case Widget::Color: {
            if (w == Widget::Slider) {
                double v = snap(item, lv_slider_get_value(b.control) / b.scale);
                if (b.value) setLabel(b.value, model::formatNumber(v, item).c_str());
            } else {
                uint8_t rgb[3];
                for (int i = 0; i < 3; i++) {
                    rgb[i] = static_cast<uint8_t>(lv_slider_get_value(lv_obj_get_child(lv_obj_get_child(b.control, i), 1)));
                }
                lv_obj_set_style_bg_color(b.swatch, lv_color_make(rgb[0], rgb[1], rgb[2]), 0);
            }
            if (b.forAction) return;
            if (b.draft) {
                commit(b, controlJson(b));
                return;
            }
            uint32_t now = lv_tick_get();
            if (code == LV_EVENT_RELEASED) {
                b.dirty = false;
                std::string json = controlJson(b);
                if (json != b.sent || b.shown != json) write(b, json);
            } else if (now - b.lastSent >= kThrottleMs) {
                std::string json = controlJson(b);
                if (json != b.sent) write(b, json);
            } else {
                b.dirty = true;  // sent from loop() when the throttle allows
            }
            return;
        }
        case Widget::Number: {
            if (target == b.minus || target == b.plus) {
                const char* t = lv_textarea_get_text(b.control);
                double v = strtod(t, nullptr);
                v = clampTo(item, v + (target == b.plus ? 1 : -1) * stepFor(item));
                Item plain = item;
                plain.unit.clear();
                lv_textarea_set_text(b.control, model::formatNumber(v, plain).c_str());
                if (!b.forAction) commit(b, numberJson(item, v));
                return;
            }
            if (code == LV_EVENT_CLICKED) {
                keyboard(b, b.control, true);
            } else {
                textDone(b, code == LV_EVENT_READY);
            }
            return;
        }
        case Widget::Text:
        case Widget::Password:
        case Widget::Textarea:
            if (code == LV_EVENT_CLICKED) {
                keyboard(b, b.control, false);
            } else {
                textDone(b, code == LV_EVENT_READY);
            }
            return;
        default:
            if (code == LV_EVENT_VALUE_CHANGED && !b.forAction) {
                std::string json = controlJson(b);
                if (!json.empty()) commit(b, json);
            }
            return;
    }
}

void LvglUi::commit(Bound& b, const std::string& json) {
    if (json.empty()) return;
    if (b.draft) {
        b.edited = true;
        b.dirty = false;
        draftChanged(b.draft - 1);
        return;
    }
    write(b, json);
}

void LvglUi::textDone(Bound& b, bool ok) {
    hideKeyboard();
    lv_obj_remove_state(b.control, LV_STATE_FOCUSED);
    if (b.forAction) return;
    if (b.draft) {
        if (ok) {
            commit(b, controlJson(b));
        } else if (!b.edited) {
            b.shown.clear();
            sync(b);
        }
        return;
    }
    if (!ok) {
        // Cancelled: the value again.
        b.shown.clear();
        if (b.item->secret) lv_textarea_set_text(b.control, "");
        sync(b);
        return;
    }
    std::string json = controlJson(b);
    if (json.empty()) {
        b.shown.clear();
        sync(b);
        return;
    }
    write(b, json);
    if (b.item->secret) lv_textarea_set_text(b.control, "");
}

void LvglUi::keyboard(Bound& b, lv_obj_t* textarea, bool numeric) {
    typing_ = &b;
    typingArea_ = textarea;
    lv_obj_t* keys = keyboard_;
    modal(&keys, 1, true);  // the encoder types on the keyboard
    lv_keyboard_set_textarea(keyboard_, textarea);
    lv_keyboard_set_mode(keyboard_, numeric ? LV_KEYBOARD_MODE_NUMBER : LV_KEYBOARD_MODE_TEXT_LOWER);
    lv_obj_set_hidden(keyboard_, false);
    lv_obj_move_foreground(keyboard_);
    // Room for the field above the keyboard.
    int32_t h = lv_display_get_vertical_resolution(display_);
    lv_obj_set_style_pad_bottom(content_, h / 2, 0);
    lv_obj_update_layout(content_);
    lv_obj_scroll_to_view_recursive(textarea, LV_ANIM_OFF);
}

void LvglUi::hideKeyboard() {
    bool was = typing_ != nullptr;
    typing_ = nullptr;
    typingArea_ = nullptr;
    if (!keyboard_) return;
    if (was) {
        endModal();
        if (useGroup_) lv_group_set_editing(group_, false);  // the field is done
    }
    lv_keyboard_set_textarea(keyboard_, nullptr);
    lv_obj_set_hidden(keyboard_, true);
    if (content_) lv_obj_set_style_pad_bottom(content_, m_.pad, 0);
}

// ---- Writes and calls ----------------------------------------------------------

bool LvglUi::offlineRefused(const std::string& what) {
    if (!offline_) return false;
    toast(what + ": the node is offline", true);
    return true;
}

void LvglUi::write(Bound& b, const std::string& json) {
    if (offlineRefused(b.item->label)) {
        b.shown.clear();
        sync(b);
        return;
    }
    b.stalled = false;  // an edit: keep-alives again
    b.pending++;
    b.sent = json;
    b.lastSent = lv_tick_get();
    b.dirty = false;
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    size_t index = b.index;
    std::string path = b.item->path;
    bool sent = client_.set(path, json, [this, alive, gen, index, path](Status s, JsonVariantConst body) {
        if (alive.expired() || gen != gen_) return;
        Bound& bb = *bound_[index];
        bb.pending--;
        if (s == Status::Ok) {
            connection(true);
            // The reply is the value read back (section 7.4).
            if (bb.pending == 0) setValueAt(path, body);
            // A keyed element renamed: its page is at its new key now.
            Route& r = route_.back();
            if (!r.keyField.empty() && path == r.path + "/" + r.keyField && body.is<const char*>()) {
                r.id = body.as<const char*>();
                r.path = r.list + "/" + r.id;
                r.title = r.id;
                requestShow();
                return;
            }
        } else {
            error(bb.item->label, s, body);
        }
        if (bb.pending == 0) {
            bb.shown.clear();  // show the confirmed value, or restore it
            sync(bb);
            conditions(bb);
            for (auto& other : bound_) conditions(*other);
        }
    });
    if (!sent) {
        b.pending--;
        toast(b.item->label + ": not sent", true);
        b.shown.clear();
        sync(b);
    }
}

void LvglUi::confirmThen(Bound& b, const std::string& arg) {
    if (b.item->confirm.empty()) {
        call(b, arg);
        return;
    }
    size_t index = b.index;
    ask(b.item->confirm, [this, index, arg] { call(*bound_[index], arg); });
}

// A question (ui.confirm) with Cancel and OK; `yes` runs on OK, on the same
// page only.
void LvglUi::ask(const std::string& question, std::function<void()> yes) {
    confirmed_ = std::move(yes);
    confirmGen_ = gen_;
    msgbox_ = lv_msgbox_create(nullptr);
    lv_msgbox_add_text(msgbox_, fit(question).c_str());
    lv_obj_t* cancel = lv_msgbox_add_footer_button(msgbox_, "Cancel");
    confirmOk_ = lv_msgbox_add_footer_button(msgbox_, "OK");
    lv_obj_t* answers[2] = {cancel, confirmOk_};
    modal(answers, 2, false);
    auto onAnswer = [](lv_event_t* e) {
        LvglUi* ui = static_cast<LvglUi*>(lv_event_get_user_data(e));
        bool ok = lv_event_get_target_obj(e) == ui->confirmOk_;
        lv_msgbox_close(ui->msgbox_);
        ui->msgbox_ = nullptr;
        ui->endModal();
        std::function<void()> then = std::move(ui->confirmed_);
        ui->confirmed_ = nullptr;
        if (ok && then && ui->confirmGen_ == ui->gen_) then();
    };
    lv_obj_add_event_cb(cancel, onAnswer, LV_EVENT_CLICKED, this);
    lv_obj_add_event_cb(confirmOk_, onAnswer, LV_EVENT_CLICKED, this);
}

void LvglUi::call(Bound& b, const std::string& arg) {
    if (offlineRefused(b.item->label)) return;
    bool hold = b.item->widget == Widget::Hold;
    if (!hold) {
        if (b.pending > 0) return;
        b.pending++;
        lv_obj_add_state(b.button, LV_STATE_DISABLED);  // while the call is in flight
        lv_obj_set_hidden(b.result, true);
    }
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    size_t index = b.index;
    bool sent = client_.set(b.item->path, arg, [this, alive, gen, index, hold](Status s, JsonVariantConst body) {
        if (alive.expired() || gen != gen_) return;
        Bound& bb = *bound_[index];
        if (!hold) {
            bb.pending--;
            lv_obj_remove_state(bb.button, LV_STATE_DISABLED);
            conditions(bb);
        }
        if (s != Status::Ok) {
            error(bb.item->label, s, body);
            return;
        }
        connection(true);
        if (bb.item->auth == "login") {
            signedIn(*bb.item, body);
            return;
        }
        if (!hold && !body.isNull() && !body.isUnbound()) {
            // A reply other than null is shown by the button.
            std::string t = std::string(LV_SYMBOL_OK " ") + text(body);
            setLabel(bb.result, t.c_str());
            lv_obj_set_hidden(bb.result, false);
        }
    });
    if (!sent) {
        if (!hold) {
            b.pending--;
            lv_obj_remove_state(b.button, LV_STATE_DISABLED);
        }
        toast(b.item->label + ": not sent", true);
    }
}

// ---- Drafts: forms and object arguments -------------------------------------

// A form (ui.form): its controls edit a draft; Apply sends one patch to the
// object, the edited values and the submit action (section 7.4); Reset
// discards the draft.
void LvglUi::form(lv_obj_t* parent, const Item& sec) {
    size_t d = drafts_.size();
    Draft dr;
    dr.path = sec.path;
    dr.item = &sec;
    const Item* submit = nullptr;
    for (const Item& i : sec.items) {
        if (i.kind == ItemKind::Leaf && i.isAction() && i.submit) {
            submit = &i;
            break;
        }
    }
    if (submit) dr.submit = submit->name;
    drafts_.push_back(dr);
    size_t savedDraft = drafting_;
    const Item* savedSkip = skip_;
    drafting_ = d + 1;
    skip_ = submit;  // its button is the form's
    if (anyShown(sec.items)) {
        items(parent, sec.items);
        advanced(parent, sec.advancedItems);
    } else {
        items(parent, sec.advancedItems);
    }
    drafting_ = savedDraft;
    skip_ = savedSkip;

    lv_obj_t* line = row(parent, false);
    Bound& reset = bind(sec, nullptr);
    reset.section = true;
    reset.draft = 0;
    reset.draftReset = d + 1;
    lv_obj_t* rb = lv_button_create(line);
    lv_obj_t* rl = lv_label_create(rb);
    setLabel(rl, "Reset");
    lv_obj_add_state(rb, LV_STATE_DISABLED);  // until something is edited
    lv_obj_add_event_cb(rb, onEvent, LV_EVENT_CLICKED, &reset);
    Bound& apply = bind(submit ? *submit : sec, nullptr);
    apply.section = true;
    apply.draft = 0;
    apply.draftApply = d + 1;
    lv_obj_t* ab = lv_button_create(line);
    lv_obj_set_flex_grow(ab, 1);
    if (submit && submit->style == "danger") lv_obj_set_style_bg_color(ab, lv_palette_main(LV_PALETTE_RED), 0);
    lv_obj_t* al = lv_label_create(ab);
    setLabel(al, submit ? submit->label.c_str() : "Apply");
    lv_obj_center(al);
    lv_obj_add_event_cb(ab, onEvent, LV_EVENT_CLICKED, &apply);
    focusable(rb);
    focusable(ab);
    drafts_[d].reset = rb;
    drafts_[d].apply = ab;
}

// An action taking an object: one input per field, then the button.
// Untouched fields are left out, so the device uses its defaults.
void LvglUi::params(lv_obj_t* parent, const Item& act) {
    lv_obj_t* r = row(parent, true);
    size_t d = drafts_.size();
    Draft dr;
    dr.path = act.path;
    dr.action = true;
    dr.item = &act;
    drafts_.push_back(dr);
    size_t saved = drafting_;
    drafting_ = d + 1;
    size_t first = bound_.size();
    for (const Item& p : act.params) {
        if (!p.hidden) leaf(r, p);
    }
    drafting_ = saved;
    // Inputs start at the field's lowest value, else 0.
    for (size_t i = first; i < bound_.size(); i++) {
        Bound& f = *bound_[i];
        if (!f.item || !f.control) continue;
        double start = clampTo(*f.item, f.item->hasMin ? f.item->min : 0);
        if (f.widget == Widget::Number) {
            Item plain = *f.item;
            plain.unit.clear();
            lv_textarea_set_text(f.control, model::formatNumber(start, plain).c_str());
        } else if (f.widget == Widget::Slider) {
            lv_slider_set_value(f.control, static_cast<int32_t>(lround(start * f.scale)), LV_ANIM_OFF);
            if (f.value) setLabel(f.value, model::formatNumber(start, *f.item).c_str());
        }
    }
    Bound& b = bind(act, nullptr);
    b.section = true;
    b.draft = 0;
    b.draftApply = d + 1;
    b.button = lv_button_create(r);
    lv_obj_set_width(b.button, LV_PCT(100));
    if (act.style == "danger") lv_obj_set_style_bg_color(b.button, lv_palette_main(LV_PALETTE_RED), 0);
    lv_obj_t* t = lv_label_create(b.button);
    setLabel(t, act.label.c_str());
    lv_obj_center(t);
    lv_obj_add_event_cb(b.button, onEvent, LV_EVENT_CLICKED, &b);
    focusable(b.button);
    b.result = lv_label_create(r);
    lv_obj_set_width(b.result, LV_PCT(100));
    lv_label_set_long_mode(b.result, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_opa(b.result, LV_OPA_80, 0);
    lv_obj_set_hidden(b.result, true);
    drafts_[d].apply = b.button;
    drafts_[d].result = b.result;
}

void LvglUi::draftChanged(size_t d) {
    Draft& dr = drafts_[d];
    if (!dr.reset) return;
    bool any = false;
    for (auto& b : bound_) {
        if (b->draft == d + 1 && b->edited) any = true;
    }
    if (any) {
        lv_obj_remove_state(dr.reset, LV_STATE_DISABLED);
    } else {
        lv_obj_add_state(dr.reset, LV_STATE_DISABLED);
    }
}

void LvglUi::resetDraft(size_t d) {
    for (auto& b : bound_) {
        if (b->draft != d + 1 || !b->edited) continue;
        b->edited = false;
        b->shown.clear();
        sync(*b);
    }
    draftChanged(d);
}

void LvglUi::submitDraft(size_t d) {
    Draft& dr = drafts_[d];
    if (dr.busy || offlineRefused(dr.item->label)) return;
    JsonDocument patch;
    JsonObject root = patch.to<JsonObject>();
    for (auto& bp : bound_) {
        Bound& b = *bp;
        if (b.draft != d + 1 || !b.edited || !b.item) continue;
        std::string json = controlJson(b);
        JsonDocument v;
        if (json.empty() || deserializeJson(v, json)) continue;
        // Paths relative to the form's object, or to the argument.
        std::string rel = dr.action ? b.item->path : b.item->path.substr(dr.path == "/" ? 1 : dr.path.size() + 1);
        std::vector<std::string_view> segs = segmentsOf(rel);
        if (segs.empty()) continue;
        JsonObject node = root;
        for (size_t i = 0; i + 1 < segs.size(); i++) {
            std::string k(segs[i]);
            node = node[k].is<JsonObject>() ? node[k].as<JsonObject>() : node[k].to<JsonObject>();
        }
        node[std::string(segs.back())] = v.as<JsonVariantConst>();
    }
    // The submit action runs after the values (TesserAPI section 6.3).
    if (!dr.submit.empty()) root[dr.submit] = nullptr;
    std::string body;
    serializeJson(patch, body);
    std::string question;
    if (dr.action) {
        question = dr.item->confirm;
    } else {
        for (const Item& i : dr.item->items) {
            if (i.name == dr.submit && i.isAction()) question = i.confirm;
        }
    }
    auto go = [this, d, body] {
        Draft& g = drafts_[d];
        g.busy = true;
        lv_obj_add_state(g.apply, LV_STATE_DISABLED);
        if (g.result) lv_obj_set_hidden(g.result, true);
        std::weak_ptr<int> alive = alive_;
        uint32_t gen = gen_;
        bool sent = client_.set(g.path, body, [this, alive, gen, d](Status s, JsonVariantConst reply) {
            if (alive.expired() || gen != gen_) return;
            Draft& r = drafts_[d];
            r.busy = false;
            lv_obj_remove_state(r.apply, LV_STATE_DISABLED);
            if (s != Status::Ok) {
                error(r.item->label, s, reply);  // the draft stays
                return;
            }
            connection(true);
            if (r.action && r.item->auth == "login") {
                signedIn(*r.item, reply);
                return;
            }
            if (r.action) {
                if (!reply.isNull() && !reply.isUnbound() && r.result) {
                    std::string t = std::string(LV_SYMBOL_OK " ") + text(reply);
                    setLabel(r.result, t.c_str());
                    lv_obj_set_hidden(r.result, false);
                }
                return;
            }
            // Applied: the draft goes, the device's values show.
            if (reply.is<JsonObjectConst>() && hasValues_) apply(r.path, reply);
            for (auto& b : bound_) {
                if (b->draft == d + 1) {
                    b->edited = false;
                    b->shown.clear();
                }
            }
            syncAll();
            draftChanged(d);
        });
        if (!sent) {
            g.busy = false;
            lv_obj_remove_state(g.apply, LV_STATE_DISABLED);
            toast(g.item->label + ": not sent", true);
        }
    };
    if (question.empty()) {
        go();
    } else {
        ask(question, go);
    }
}

// ---- Lists, tables and arrays ------------------------------------------------

// One line per element (section 10.3): its name, a value, its first
// writable switch; tapping it opens the element as a page. Keyed lists add
// by key, others at the end.
void LvglUi::list(lv_obj_t* parent, const Item& item) {
    lv_obj_t* box = row(parent, true);
    if (!item.label.empty()) {
        lv_obj_t* h = label(box, item.label, false);
        lv_obj_set_style_text_opa(h, LV_OPA_80, 0);
    }
    Bound& b = bind(item, box);
    b.widget = item.widget;
    b.control = row(box, true);
    lv_obj_set_style_pad_row(b.control, 0, 0);
}

void LvglUi::rows(Bound& b, JsonVariantConst v) {
    const Item& item = *b.item;
    lv_obj_clean(b.control);
    b.rows.clear();
    JsonArrayConst a = v.as<JsonArrayConst>();
    bool array = item.schemaType == NodeType::Array;
    const Item* nameCol = nullptr;
    const Item* sumCol = nullptr;
    const Item* switchCol = nullptr;
    if (!array) {
        for (const Item& c : item.columns) {
            if (!switchCol && c.type == NodeType::Boolean && c.editable && item.editable) switchCol = &c;
            if (!item.key.empty() && c.path == item.key) nameCol = &c;
        }
        for (const Item& c : item.columns) {
            if (!nameCol && &c != switchCol && c.type != NodeType::Boolean && !c.secret) nameCol = &c;
        }
        for (const Item& c : item.columns) {
            if (!sumCol && &c != nameCol && &c != switchCol && !c.secret) sumCol = &c;
        }
    }
    auto shown = [](JsonVariantConst x, const Item& col) {
        std::string t = model::formatValue(x, col);
        const char* s = x.as<const char*>();
        for (const model::Option& o : col.options) {
            if (s && o.value == s) t = o.label;
        }
        return t;
    };
    size_t i = 0;
    for (JsonVariantConst e : a) {
        std::string id = std::to_string(i);
        if (!item.key.empty() && e[item.key].is<const char*>()) id = e[item.key].as<const char*>();
        std::string name, summary;
        if (array) {
            name = std::to_string(i + 1);
            if (!item.columns.empty()) summary = shown(e, item.columns[0]);
        } else {
            name = nameCol ? shown(at(e, nameCol->path), *nameCol) : "#" + std::to_string(i + 1);
            if (sumCol) summary = shown(at(e, sumCol->path), *sumCol);
        }
        lv_obj_t* r = row(b.control, false);
        lv_obj_set_style_min_height(r, m_.listRow, 0);
        lv_obj_set_style_border_side(r, LV_BORDER_SIDE_BOTTOM, 0);
        lv_obj_set_style_border_width(r, 1, 0);
        lv_obj_set_style_border_color(r, lv_palette_main(LV_PALETTE_GREY), 0);
        lv_obj_set_style_border_opa(r, LV_OPA_30, 0);
        lv_obj_set_clickable(r, true);
        label(r, name, true);
        if (!summary.empty()) {
            lv_obj_t* sl = label(r, summary, false);
            lv_obj_set_style_text_opa(sl, LV_OPA_70, 0);
        }
        auto ref = [&](RowRef::Kind kind) {
            auto rr = std::make_unique<RowRef>();
            rr->ui = this;
            rr->list = b.index;
            rr->kind = kind;
            rr->id = id;
            rr->title = name;
            b.rows.push_back(std::move(rr));
            return b.rows.back().get();
        };
        if (switchCol) {
            lv_obj_t* sw = lv_switch_create(r);
            if (at(e, switchCol->path).as<bool>()) lv_obj_add_state(sw, LV_STATE_CHECKED);
            RowRef* rr = ref(RowRef::Switch);
            rr->path = item.path + "/" + id + "/" + switchCol->path;
            lv_obj_add_event_cb(sw, onRow, LV_EVENT_VALUE_CHANGED, rr);
        }
        lv_obj_t* chevron = lv_label_create(r);
        setLabel(chevron, LV_SYMBOL_RIGHT);
        lv_obj_add_event_cb(r, onRow, LV_EVENT_CLICKED, ref(RowRef::Open));
        focusable(r);
        i++;
    }
    if (a.size() == 0) {
        lv_obj_t* none = label(b.control, "None", false);
        lv_obj_set_style_text_opa(none, LV_OPA_50, 0);
    }
    bool canAdd = item.editable && !item.fixed && (!item.maxSize || a.size() < item.maxSize);
    if (!canAdd) return;
    lv_obj_t* r = row(b.control, false);
    lv_obj_set_style_pad_top(r, 4, 0);
    auto rr = std::make_unique<RowRef>();
    rr->ui = this;
    rr->list = b.index;
    rr->kind = RowRef::Add;
    RowRef* add = rr.get();
    b.rows.push_back(std::move(rr));
    if (!item.key.empty()) {
        // A keyed list's new element: its key first (section 4).
        add->field = lv_textarea_create(r);
        lv_textarea_set_one_line(add->field, true);
        lv_obj_set_flex_grow(add->field, 1);
        lv_obj_set_style_pad_ver(add->field, m_.fieldPad, 0);
        std::string placeholder = "New " + model::humanize(item.key);
        lv_textarea_set_placeholder_text(add->field, fit(placeholder).c_str());
        for (lv_event_code_t code : {LV_EVENT_CLICKED, LV_EVENT_FOCUSED, LV_EVENT_READY, LV_EVENT_CANCEL}) {
            lv_obj_add_event_cb(add->field, onRow, code, add);
        }
    }
    lv_obj_t* plus = lv_button_create(r);
    if (item.key.empty()) lv_obj_set_width(plus, LV_PCT(100));
    lv_obj_t* pl = lv_label_create(plus);
    setLabel(pl, item.key.empty() ? LV_SYMBOL_PLUS " Add" : LV_SYMBOL_PLUS);
    lv_obj_center(pl);
    lv_obj_add_event_cb(plus, onRow, LV_EVENT_CLICKED, add);
    focusable(plus);
}

void LvglUi::onRow(lv_event_t* e) {
    RowRef* r = static_cast<RowRef*>(lv_event_get_user_data(e));
    r->ui->rowEvent(*r, e);
}

void LvglUi::rowEvent(RowRef& r, lv_event_t* e) {
    Bound& b = *bound_[r.list];
    const Item& item = *b.item;
    lv_event_code_t code = lv_event_get_code(e);
    lv_obj_t* target = lv_event_get_target_obj(e);
    switch (r.kind) {
        case RowRef::Switch:
            send(r.path, lv_obj_has_state(target, LV_STATE_CHECKED) ? "true" : "false", item.label);
            return;
        case RowRef::Open: {
            Route next = Route::to(item.path + "/" + r.id, route_.back().root);
            next.list = item.path;
            next.keyField = item.key;
            next.id = r.id;
            next.scalar = item.schemaType == NodeType::Array;
            next.above = item.access;
            next.title = item.schemaType == NodeType::Array ? (item.label.empty() ? page_.label : item.label) + " " + r.title : r.title;
            route_.push_back(std::move(next));
            requestShow();
            return;
        }
        case RowRef::Add:
            if (target == r.field) {
                if (code == LV_EVENT_FOCUSED) {
                    if (!useGroup_ || !lv_group_get_editing(group_) || typing_) return;
                    code = LV_EVENT_CLICKED;  // an encoder's press: edit mode
                }
                if (code == LV_EVENT_CLICKED) {
                    keyboard(b, r.field, false);  // the rows aren't redrawn while it is open
                    return;
                }
                std::string key = lv_textarea_get_text(r.field);
                hideKeyboard();
                if (code == LV_EVENT_READY && !key.empty()) addElement(b, key);
                return;
            }
            if (r.field) {
                std::string key = lv_textarea_get_text(r.field);
                if (key.empty()) {
                    toast("Name the new element first", true);
                    return;
                }
                hideKeyboard();
                addElement(b, key);
            } else {
                addElement(b, "");
            }
            return;
    }
}

// Lists are written whole (TesserAPI section 4.4): a keyed list's items are
// matched by key, so its keys alone keep the elements; an indexed list's
// items are patches, so {} keeps one as it is.
void LvglUi::addElement(Bound& b, const std::string& key) {
    const Item& item = *b.item;
    JsonArrayConst a = valueAt(item.path).as<JsonArrayConst>();
    JsonDocument out;
    JsonArray arr = out.to<JsonArray>();
    if (item.schemaType == NodeType::Array) {
        for (JsonVariantConst e : a) arr.add(e);
        const Item* col = item.columns.empty() ? nullptr : &item.columns[0];
        if (col && col->type == NodeType::String) {
            arr.add("");
        } else if (col && col->type == NodeType::Boolean) {
            arr.add(false);
        } else {
            double v = col && col->hasMin ? col->min : 0;
            if (col && col->hasMax && v > col->max) v = col->max;
            JsonDocument n;
            deserializeJson(n, numberJson(col ? *col : item, v));
            arr.add(n.as<JsonVariantConst>());
        }
    } else if (!item.key.empty()) {
        for (JsonVariantConst e : a) {
            const char* k = e[item.key];
            if (k && key == k) {
                toast(key + " already exists", true);
                return;
            }
            arr.add<JsonObject>()[item.key] = e[item.key];
        }
        arr.add<JsonObject>()[item.key] = key;
    } else {
        for (size_t i = 0; i <= a.size(); i++) arr.add<JsonObject>();
    }
    std::string json;
    serializeJson(out, json);
    send(item.path, json, item.label);
}

void LvglUi::removeFooter() {
    lv_obj_t* r = row(content_, false);
    lv_obj_t* btn = lv_button_create(r);
    lv_obj_set_width(btn, LV_PCT(100));
    lv_obj_set_style_bg_color(btn, lv_palette_main(LV_PALETTE_RED), 0);
    lv_obj_t* t = lv_label_create(btn);
    setLabel(t, LV_SYMBOL_TRASH " Remove");
    lv_obj_center(t);
    lv_obj_add_event_cb(
        btn,
        [](lv_event_t* e) {
            LvglUi* ui = static_cast<LvglUi*>(lv_event_get_user_data(e));
            ui->ask("Remove " + ui->route_.back().title + "?", [ui] { ui->removeElement(); });
        },
        LV_EVENT_CLICKED, this);
    focusable(btn);
}

void LvglUi::removeElement() {
    const Route& r = route_.back();
    JsonArrayConst a = listValue_.as<JsonArrayConst>();
    JsonDocument out;
    JsonArray arr = out.to<JsonArray>();
    size_t index = static_cast<size_t>(strtoul(r.id.c_str(), nullptr, 10));
    size_t i = 0;
    for (JsonVariantConst e : a) {
        if (r.scalar) {
            if (i != index) arr.add(e);
        } else if (!r.keyField.empty()) {
            const char* k = e[r.keyField];
            if (!(k && r.id == k)) arr.add<JsonObject>()[r.keyField] = e[r.keyField];
        } else if (i < index) {
            arr.add<JsonObject>();  // kept as it is
        } else if (i > index) {
            // Moved down one: its fields, those a client can write.
            writableCopy(e, elementSchema_.as<JsonObjectConst>(), arr.add<JsonObject>());
        }
        i++;
    }
    std::string json;
    serializeJson(out, json);
    send(r.list, json, r.title, [this] { back(); });
}

void LvglUi::send(const std::string& path, const std::string& json, const std::string& what, std::function<void()> done) {
    if (offlineRefused(what)) return;
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    bool sent = client_.set(path, json, [this, alive, gen, path, what, done](Status s, JsonVariantConst body) {
        if (alive.expired() || gen != gen_) return;
        if (s != Status::Ok) {
            error(what, s, body);
            // Lists drawn again from the values the device has.
            for (auto& b : bound_) {
                if (b->widget == Widget::List || b->widget == Widget::Table) b->shown.clear();
            }
            syncAll();
            return;
        }
        connection(true);
        // A whole list replaced: the reply is the list read back.
        for (auto& b : bound_) {
            if ((b->widget == Widget::List || b->widget == Widget::Table) && b->item && b->item->path == path) {
                setValueAt(path, body);
                b->shown.clear();
                sync(*b);
            }
        }
        if (done) done();
    });
    if (!sent) toast(what + ": not sent", true);
}

// ---- Access levels and signing in (section 7.4) ------------------------------

LvglUi::NodeAuth* LvglUi::authOf(const std::string& root) {
    for (NodeAuth& a : auth_) {
        if (a.root == root) return &a;
    }
    return nullptr;
}

bool LvglUi::allowed(const Item& item) const {
    std::string root = nodeRoot();
    for (const NodeAuth& a : auth_) {
        if (a.root != root) continue;
        // Unknown level: nothing disabled; the node's refusals still apply.
        if (a.level == model::Access::None || item.access == model::Access::None) return true;
        return item.access <= a.level;
    }
    return true;
}

// The node's login and whoami actions, from its schema (the root's,
// a level deeper than the menu's), then its level for this client.
void LvglUi::ensureAuth() {
    std::string root = nodeRoot();
    NodeAuth* a = authOf(root);
    if (!a) {
        auth_.push_back(NodeAuth());
        a = &auth_.back();
        a->root = root;
    }
    updateSignIn();
    if (a->asked) return;
    a->asked = true;
    discoverAuth(root, 3);
}

void LvglUi::discoverAuth(const std::string& root, int depth) {
    tesser::Query q;
    q.view = tesser::View::Schema;
    q.depth = depth;
    std::weak_ptr<int> alive = alive_;
    client_.get(root, [this, alive, root, depth](Status s, JsonVariantConst body) {
        if (alive.expired()) return;
        const char* reason = body["reason"];
        if ((s == Status::TooLarge || (s == Status::Busy && reason && strcmp(reason, "low_memory") == 0)) && depth > 1) {
            discoverAuth(root, depth - 1);
            return;
        }
        NodeAuth* a = authOf(root);
        if (!a) return;
        if (s != Status::Ok) {
            a->asked = false;  // tried again on the next screen
            return;
        }
        std::function<void(JsonObjectConst, const std::string&)> walk = [&](JsonObjectConst o, const std::string& at) {
            for (JsonPairConst kv : o["children"].as<JsonObjectConst>()) {
                JsonObjectConst c = kv.value();
                std::string p = model::joinPath(at, kv.key().c_str());
                const char* type = c["type"];
                const char* auth = c["ui"]["auth"];
                if (type && strcmp(type, "object") == 0) {
                    walk(c, p);
                } else if (type && strcmp(type, "action") == 0 && auth) {
                    if (strcmp(auth, "login") == 0) a->login = p;
                    if (strcmp(auth, "whoami") == 0) a->whoami = p;
                }
            }
        };
        walk(body.as<JsonObjectConst>(), root);
        updateSignIn();
        askLevel(root);
    }, q);
}

void LvglUi::askLevel(const std::string& root) {
    NodeAuth* a = authOf(root);
    if (!a || a->whoami.empty()) return;
    std::weak_ptr<int> alive = alive_;
    client_.set(a->whoami, "null", [this, alive, root](Status s, JsonVariantConst body) {
        if (alive.expired() || s != Status::Ok) return;
        NodeAuth* n = authOf(root);
        if (!n) return;
        // A level, or {"access": level}.
        const char* level = body.is<const char*>() ? body.as<const char*>() : body["access"].as<const char*>();
        n->level = level ? model::parseAccess(level) : model::Access::None;
        updateSignIn();
        for (auto& b : bound_) conditions(*b);
    });
}

// The header's button: "Sign in", or the level once known above public.
void LvglUi::updateSignIn() {
    if (!signIn_) return;
    NodeAuth* a = authOf(nodeRoot());
    bool show = a && !a->login.empty();
    lv_obj_set_hidden(signIn_, !show);
    if (useGroup_) {
        if (show) {
            lv_group_add_obj(group_, signIn_);
            outline(signIn_);
        } else {
            lv_group_remove_obj(signIn_);
        }
    }
    if (!show) return;
    bool in = a->level == model::Access::User || a->level == model::Access::Admin;
    setLabel(lv_obj_get_child(signIn_, 0), in ? model::toString(a->level) : "Sign in");
}

// A login action's reply: the token, as a string or {"token", "access"}.
void LvglUi::signedIn(const Item& action, JsonVariantConst reply) {
    std::string root = nodeRoot();
    NodeAuth* a = authOf(root);
    const char* token = reply.is<const char*>() ? reply.as<const char*>() : reply["token"].as<const char*>();
    if (!token || !*token) {
        toast(action.label + ": no token in the reply", true);
        return;
    }
    if (onSignIn_) onSignIn_(root, a ? a->device : std::string(), token);
    const char* level = reply["access"];
    if (a && level) a->level = model::parseAccess(level);
    toast("Signed in", model::Toast::Ok);
    // What the node shows depends on the level: read it again, from where
    // the user was.
    if (a) askLevel(root);
    if (!route_.empty() && route_.back().signIn) route_.pop_back();
    if (root == root_) refreshMenu();
    requestShow();
}

// ---- What else the page depends on ----------------------------------------------

// A select whose choices are a keyed list's keys, or an object's children
// (the nodes under /peers), after its fixed ones (ui.optionsExtra).
void LvglUi::loadChoices(Bound& b) {
    std::string from = b.item->optionsFrom;
    size_t index = b.index;
    uint32_t gen = gen_;
    std::weak_ptr<int> alive = alive_;
    tesser::Query q;
    q.view = tesser::View::Schema;
    q.depth = 1;
    client_.get(from, [this, alive, gen, index, from](Status s, JsonVariantConst schema) {
        if (alive.expired() || gen != gen_ || s != Status::Ok) return;
        auto done = [this, index](std::vector<model::Option> found) {
            Bound& bb = *bound_[index];
            bb.choices = bb.item->options;
            for (model::Option& o : found) bb.choices.push_back(std::move(o));
            bb.hasChoices = true;
            std::string options;
            for (const model::Option& o : bb.choices) {
                if (!options.empty()) options += '\n';
                options += o.label;
            }
            lv_dropdown_set_options(bb.control, fit(options).c_str());
            bb.shown.clear();
            sync(bb);
        };
        const char* type = schema["type"];
        const char* key = schema["key"];
        if (type && strcmp(type, "list") == 0 && key) {
            std::string k = key;
            client_.get(from, [this, gen, done, k](Status st, JsonVariantConst list) {
                if (gen != gen_ || st != Status::Ok) return;
                std::vector<model::Option> found;
                for (JsonVariantConst e : list.as<JsonArrayConst>()) {
                    const char* v = e[k];
                    if (v) found.push_back({v, v});
                }
                done(std::move(found));
            });
            return;
        }
        const Item& item = *bound_[index]->item;
        std::vector<model::Option> found;
        for (JsonPairConst kv : schema["children"].as<JsonObjectConst>()) {
            JsonObjectConst c = kv.value();
            std::string value = kv.key().c_str();
            if (!item.optionsValue.empty()) {
                // A field of the child's schema: a remote node's "id".
                const char* v = c[item.optionsValue];
                if (!v) continue;
                value = v;
            }
            std::string label = kv.key().c_str();
            if (c["online"].is<bool>() && !c["online"].as<bool>()) label += " (offline)";
            found.push_back({value, label});
        }
        done(std::move(found));
    }, q);
}

// Conditions on values outside the page: one subscription at their common
// ancestor, with its children on the way as keys.
void LvglUi::watchConditions() {
    std::vector<std::string> paths;
    for (auto& b : bound_) {
        if (!b->item) continue;
        for (const auto* conds : {&b->item->visibleWhen, &b->item->enabledWhen}) {
            for (const model::Condition& c : *conds) {
                if (!model::isUnder(c.path, page_.path)) paths.push_back(c.path);
            }
        }
    }
    if (paths.empty()) return;
    std::vector<std::string_view> common = segmentsOf(paths[0]);
    common.pop_back();  // the parent of a value, at least
    for (const std::string& p : paths) {
        std::vector<std::string_view> segs = segmentsOf(p);
        size_t n = 0;
        while (n < common.size() && n + 1 < segs.size() && common[n] == segs[n]) n++;
        common.resize(n);
    }
    std::string at = "/";
    for (std::string_view seg : common) at = model::joinPath(at, seg);
    std::string keys;
    int depth = 0;
    for (const std::string& p : paths) {
        std::vector<std::string_view> segs = segmentsOf(p);
        std::string first(segs[common.size()]);
        if (("," + keys + ",").find("," + first + ",") == std::string::npos) keys += (keys.empty() ? "" : ",") + first;
        int d = static_cast<int>(segs.size() - common.size());  // a value directly below: 1
        if (d > depth) depth = d;
    }
    tesser::Query q;
    q.keys = keys;
    q.depth = depth;
    q.events = false;
    q.interval = kThrottleMs;
    watch_.path = at;
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    bool sent = client_.subscribe(at, [this, alive, gen](Status s, JsonVariantConst body) {
        if (alive.expired() || gen != gen_) return;
        if (s != Status::Ok) {
            watch_.path.clear();  // such conditions pass, as before
            return;
        }
        watch_.values.set(body);
        watch_.has = true;
        for (auto& b : bound_) conditions(*b);
    }, q);
    if (!sent) watch_.path.clear();
}

// A remote node's online state (section 7.6): its stub, below its parent
// (/peers). A null for it in a notification: read the stub again.
void LvglUi::watchNode() {
    std::string root = nodeRoot();
    if (root == root_) return;
    std::string parent = model::parentPath(root);
    std::string name = root.substr(root.rfind('/') + 1);
    tesser::Query q;
    q.keys = name;
    q.depth = 1;
    q.events = false;
    q.interval = 1000;
    stubPath_ = parent;
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    bool sent = client_.subscribe(parent, [this, alive, gen](Status s, JsonVariantConst) {
        if (alive.expired() || gen != gen_ || s == Status::Ok) return;
        stubPath_.clear();
    }, q);
    if (!sent) stubPath_.clear();
    readStub();
}

void LvglUi::readStub() {
    std::string root = nodeRoot();
    if (root == root_) return;
    std::string parent = model::parentPath(root);
    std::string name = root.substr(root.rfind('/') + 1);
    tesser::Query q;
    q.view = tesser::View::Schema;
    q.depth = 1;
    q.keys = name;
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    client_.get(parent, [this, alive, gen, root, name](Status s, JsonVariantConst body) {
        if (alive.expired() || gen != gen_ || s != Status::Ok) return;
        JsonObjectConst stub = body["children"][name];
        if (stub.isNull()) return;
        if (NodeAuth* a = authOf(root)) {
            if (const char* id = stub["id"]) a->device = id;
        }
        bool online = !(stub["online"].is<bool>() && !stub["online"].as<bool>());
        setOffline(!online);
    }, q);
}

void LvglUi::setOffline(bool offline) {
    if (offline == offline_) return;
    offline_ = offline;
    // Dimmed, its controls disabled and its writes refused, until back.
    if (content_) lv_obj_set_style_opa(content_, offline ? LV_OPA_50 : LV_OPA_COVER, 0);
    if (dot_) {
        lv_obj_set_style_bg_color(dot_, offline ? lv_palette_main(LV_PALETTE_GREY)
                                                : online_ ? lv_palette_main(LV_PALETTE_GREEN) : lv_palette_main(LV_PALETTE_RED), 0);
    }
    if (offline) {
        toast("The node is offline", model::Toast::Warn);
    } else if (hasValues_) {
        poll();  // what it is now
    }
    for (auto& b : bound_) conditions(*b);
}

// Keep-alives (section 7.4): a value other than 0 or false with ui.keepalive
// is re-sent every `keepalive` ms while shown, connected and enabled, so a
// device's dead-man timer keeps it; a refusal stops it until the next edit.
void LvglUi::keepAlive(uint32_t now) {
    if (offline_ || !online_) return;
    for (auto& bp : bound_) {
        Bound& b = *bp;
        if (!b.item || !b.item->keepalive || b.stalled || b.pending > 0 || b.draft || b.forAction || !b.control) continue;
        if (b.item->isAction() || now - b.lastKeep < b.item->keepalive) continue;
        if (lv_obj_has_state(b.control, LV_STATE_DISABLED) || typing_ == &b) continue;
        bool shown = true;
        for (lv_obj_t* o = b.control; o; o = lv_obj_get_parent(o)) {
            if (lv_obj_is_hidden(o)) shown = false;  // a closed group, a hidden row
        }
        if (!shown) continue;
        std::string json = controlJson(b);  // the value on screen
        if (json.empty() || json == "false" || strtod(json.c_str(), nullptr) == 0) continue;
        b.lastKeep = now;
        std::weak_ptr<int> alive = alive_;
        uint32_t gen = gen_;
        size_t index = b.index;
        client_.set(b.item->path, json, [this, alive, gen, index](Status s, JsonVariantConst) {
            if (alive.expired() || gen != gen_ || s == Status::Ok) return;
            bound_[index]->stalled = true;
        });
    }
}

void LvglUi::loop() {
    client_.process();
    uint32_t now = lv_tick_get();
    for (auto& b : bound_) {
        if (b->dirty && now - b->lastSent >= kThrottleMs) {
            b->dirty = false;
            std::string json = controlJson(*b);
            if (!json.empty() && json != b->sent) commit(*b, json);
        }
    }
    keepAlive(now);
    if (toast_ && toastUntil_ && static_cast<int32_t>(now - toastUntil_) >= 0) {
        lv_obj_set_hidden(toast_, true);
        toastUntil_ = 0;
    }
}

}  // namespace tesserui

#endif
