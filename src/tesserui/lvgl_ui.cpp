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
constexpr int32_t kHeaderHeight = 36;

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
        case Widget::Chart:
            // A value's history: its current value. An array: not here yet.
            if (item.schemaType == NodeType::Array) return Draw::WebOnly;
            w = Widget::Readout;
            return Draw::Control;
        case Widget::Json:
        case Widget::Events:
        case Widget::Log:
            return Draw::Hidden;
        case Widget::Color:
        case Widget::Flags:
        case Widget::Table:
        case Widget::List:
        case Widget::File:
            return Draw::WebOnly;
        default:
            return Draw::Control;
    }
}

bool twoLines(Widget w) {
    return w == Widget::Slider || w == Widget::Bar || w == Widget::Segmented || w == Widget::Text ||
           w == Widget::Password || w == Widget::Textarea;
}

bool anyShown(const std::vector<Item>& items) {
    for (const Item& i : items) {
        if (!i.hidden) return true;
    }
    return false;
}

}  // namespace

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
    std::string dropdownText;      // a value that isn't among the options
    lv_timer_t* hold = nullptr;
    Widget fieldWidget = Widget::Readout;  // an action's argument input
    std::string openPath, openRoot;  // links and menu entries
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
    if (retryTimer_) lv_timer_delete(retryTimer_);
    if (pollTimer_) lv_timer_delete(pollTimer_);
    for (auto& b : bound_) {
        if (b->hold) lv_timer_delete(b->hold);
    }
    if (screen_) lv_obj_clean(screen_);
    if (toast_) lv_obj_delete(toast_);
    if (msgbox_) lv_msgbox_close(msgbox_);
    lv_group_delete(group_);
}

// ---- Chrome ----------------------------------------------------------------

void LvglUi::chrome() {
    if (!font_) font_ = LV_FONT_DEFAULT;
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
    lv_obj_set_size(header_, LV_PCT(100), kHeaderHeight);
    lv_obj_set_flex_flow(header_, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(header_, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_hor(header_, 4, 0);
    lv_obj_set_style_pad_ver(header_, 0, 0);
    lv_obj_set_style_pad_column(header_, 6, 0);
    lv_obj_set_style_radius(header_, 0, 0);
    lv_obj_set_style_border_width(header_, 0, 0);
    lv_obj_set_scrollable(header_, false);

    backButton_ = lv_button_create(header_);
    lv_obj_set_size(backButton_, 40, 28);
    lv_obj_t* arrow = lv_label_create(backButton_);
    lv_label_set_text(arrow, LV_SYMBOL_LEFT);
    lv_obj_center(arrow);
    lv_obj_add_event_cb(backButton_, onChrome, LV_EVENT_CLICKED, this);
    lv_obj_set_hidden(backButton_, true);

    title_ = lv_label_create(header_);
    lv_obj_set_flex_grow(title_, 1);
    lv_label_set_long_mode(title_, LV_LABEL_LONG_MODE_DOTS);
#if LV_FONT_MONTSERRAT_16
    lv_obj_set_style_text_font(title_, &lv_font_montserrat_16, 0);
#endif
    lv_label_set_text(title_, "");

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
    lv_obj_set_style_pad_all(content_, 6, 0);
    lv_obj_set_style_pad_row(content_, 6, 0);
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

void LvglUi::onChrome(lv_event_t* e) {
    LvglUi* ui = static_cast<LvglUi*>(lv_event_get_user_data(e));
    lv_obj_t* target = lv_event_get_target_obj(e);
    if (target == ui->backButton_) {
        ui->back();
    } else if (target == ui->retry_) {
        ui->requestShow();
    }
}

void LvglUi::setTitle(const std::string& title) {
    lv_label_set_text(title_, title.c_str());
    bool canGoBack = !route_.empty() && (menuShown_ || route_.size() > 1);
    lv_obj_set_hidden(backButton_, !(canGoBack));
}

void LvglUi::message(const char* textToShow, bool retry) {
    lv_obj_t* l = lv_label_create(content_);
    lv_obj_set_width(l, LV_PCT(100));
    lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_pad_top(l, 40, 0);
    lv_label_set_text(l, textToShow);
    retry_ = nullptr;
    if (retry) {
        retry_ = lv_button_create(content_);
        lv_obj_align(retry_, LV_ALIGN_CENTER, 0, 0);
        lv_obj_t* t = lv_label_create(retry_);
        lv_label_set_text(t, "Retry");
        lv_obj_add_event_cb(retry_, onChrome, LV_EVENT_CLICKED, this);
    }
}

void LvglUi::toast(const std::string& t, bool isError) {
    if (!toast_) return;
    lv_label_set_text(toastLabel_, t.c_str());
    lv_obj_set_style_bg_color(toast_, isError ? lv_palette_darken(LV_PALETTE_RED, 2) : lv_palette_darken(LV_PALETTE_GREY, 3), 0);
    lv_obj_set_hidden(toast_, false);
    toastUntil_ = lv_tick_get() + 3000;
}

void LvglUi::error(const std::string& what, Status s, JsonVariantConst body) {
    if (s == Status::Timeout) connection(false);
    const char* msg = body["message"];
    std::string t = what.empty() ? std::string() : what + ": ";
    t += msg ? msg : tesser::toString(s);
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

void LvglUi::loadRoot() {
    clearPage();
    setTitle("");
    message("Loading...", false);
    loading_ = true;
    tesser::Query q;
    q.view = tesser::View::Schema;
    q.depth = 2;  // the menu: the root's children, and theirs for sub-entries
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    bool sent = client_.get(
        root_,
        [this, alive, gen](Status s, JsonVariantConst body) {
            if (alive.expired() || gen != gen_) return;
            loading_ = false;
            if (s != Status::Ok) {
                if (s == Status::Timeout) connection(false);
                clearPage();
                message("The node doesn't answer.", true);
                return;
            }
            connection(true);
            JsonObjectConst schema = body;
            const char* label = schema["label"];
            rootLabel_ = label ? label : "Device";
            menu_ = model::buildMenu(schema, root_);
            rootLoaded_ = true;
            route_.clear();
            size_t entries = 0;
            for (const model::MenuEntry& e : menu_) entries += e.path.empty() ? e.children.size() : 1;
            // A single entry is the start page itself.
            menuShown_ = entries > 1;
            if (!menuShown_) {
                std::string start = root_;
                if (entries == 1) start = menu_[0].path.empty() ? menu_[0].children[0].path : menu_[0].path;
                route_.push_back({start, ""});
            }
            show();
        },
        q);
    if (!sent) {
        loading_ = false;
        clearPage();
        message("Couldn't send to the node.", true);
    }
}

void LvglUi::open(std::string_view path, std::string_view root) {
    route_.push_back({std::string(path), std::string(root)});
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
    }
    for (auto& b : bound_) {
        if (b->hold) lv_timer_delete(b->hold);
    }
    if (content_) {
        lv_obj_clean(content_);
        lv_obj_scroll_to_y(content_, 0, LV_ANIM_OFF);
    }
    lv_group_remove_all_objs(group_);
    retry_ = nullptr;
    bound_.clear();
    page_ = model::Page();
    values_.clear();
    hasValues_ = false;
    loading_ = false;
}

void LvglUi::showMenu() {
    clearPage();
    setTitle(rootLabel_);
    for (const model::MenuEntry& top : menu_) {
        auto entry = [this](lv_obj_t* parent, const model::MenuEntry& e, bool sub) {
            lv_obj_t* b = lv_button_create(parent);
            lv_obj_set_size(b, LV_PCT(100), 40);
            lv_obj_set_flex_flow(b, LV_FLEX_FLOW_ROW);
            lv_obj_set_flex_align(b, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
            lv_obj_set_style_pad_left(b, sub ? 24 : 10, 0);
            lv_obj_set_style_pad_column(b, 8, 0);
            // Rows of a list rather than call-to-action buttons.
            lv_obj_set_style_bg_color(b, lv_color_hex(sub ? 0x24272b : 0x2c3036), 0);
            lv_obj_set_style_bg_color(b, lv_color_hex(0x3b4048), LV_STATE_PRESSED);
            lv_obj_set_style_shadow_width(b, 0, 0);
            label(b, e.label, true);
            if (e.remote) {
                lv_obj_t* d = lv_obj_create(b);
                lv_obj_set_size(d, 10, 10);
                lv_obj_set_style_radius(d, LV_RADIUS_CIRCLE, 0);
                lv_obj_set_style_border_width(d, 0, 0);
                lv_obj_set_style_bg_color(d, e.online ? lv_palette_main(LV_PALETTE_GREEN) : lv_palette_main(LV_PALETTE_GREY), 0);
            }
            lv_obj_t* chevron = lv_label_create(b);
            lv_label_set_text(chevron, LV_SYMBOL_RIGHT);
            lv_obj_set_style_text_color(chevron, lv_palette_main(LV_PALETTE_BLUE), 0);
            auto bound = std::make_unique<Bound>();
            bound->ui = this;
            bound->index = bound_.size();
            bound->widget = Widget::Link;
            bound->control = b;
            bound->openPath = e.path;
            bound->openRoot = e.remote ? e.path : std::string();
            lv_obj_add_event_cb(b, onEvent, LV_EVENT_CLICKED, bound.get());
            lv_group_add_obj(group_, b);
            bound_.push_back(std::move(bound));
        };
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
}

void LvglUi::showPage() {
    clearPage();
    Route r = route_.back();
    std::string_view last = r.path;
    size_t slash = last.rfind('/');
    if (slash != std::string_view::npos) last = last.substr(slash + 1);
    setTitle(last.empty() ? rootLabel_ : model::humanize(last));
    message("Loading...", false);
    loading_ = true;
    tesser::Query q;
    q.view = tesser::View::Schema;
    q.depth = 3;  // section 7.2
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    bool sent = client_.get(
        r.path,
        [this, alive, gen, r](Status s, JsonVariantConst reply) {
            if (alive.expired() || gen != gen_) return;
            lv_obj_clean(content_);
            if (s != Status::Ok) {
                loading_ = false;
                if (s == Status::Timeout) connection(false);
                const char* msg = reply["message"];
                std::string t = "Couldn't read the page: ";
                t += msg ? msg : tesser::toString(s);
                message(t.c_str(), true);
                return;
            }
            connection(true);
            std::string root = r.root.empty() ? root_ : r.root;
            bool menu = r.path == root_ && menuShown_;
            page_ = model::buildPage(reply, r.path, root, menu);
            if (r.path == root_ && menuShown_) {
                setTitle("Status");
            } else if (r.path == root_) {
                setTitle(rootLabel_);
            } else {
                setTitle(page_.label);
            }
            for (const Item& a : page_.actions) action(content_, a);
            for (const Item& c : page_.cards) {
                if (c.hidden) continue;
                if (c.form) {
                    webOnly(card(c), c.label.empty() ? page_.label : c.label);
                    continue;
                }
                lv_obj_t* body = card(c);
                Bound& b = bind(c, lv_obj_get_parent(body) == content_ ? body : lv_obj_get_parent(body));
                b.section = true;
                bool hasItems = anyShown(c.items);
                items(body, c.items);
                if (hasItems) {
                    advanced(body, c.advancedItems);
                } else {
                    items(body, c.advancedItems);
                }
            }
            if (page_.cards.empty() && page_.actions.empty()) message("Nothing to show here.", false);
            subscribe();
        },
        q);
    if (!sent) {
        loading_ = false;
        lv_obj_clean(content_);
        message("Couldn't send to the node.", true);
    }
}

// ---- Data --------------------------------------------------------------------

void LvglUi::subscribe() {
    tesser::Query q;
    q.depth = page_.depth < 0 ? tesser::Query::kUnlimited : page_.depth;
    if (page_.hasKeys) q.keys = page_.keys;
    q.interval = kThrottleMs;
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    std::string path = page_.path;
    subscribed_ = path;
    bool sent = client_.subscribe(
        path,
        [this, alive, gen](Status s, JsonVariantConst body) {
            if (alive.expired() || gen != gen_) return;
            loading_ = false;
            if (s == Status::Ok) {
                connection(true);
                values_.set(body);
                hasValues_ = true;
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
    std::weak_ptr<int> alive = alive_;
    uint32_t gen = gen_;
    polling_ = client_.get(
        page_.path,
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
            values_.set(body);
            hasValues_ = true;
            syncAll();
        },
        q);
}

void LvglUi::unsubscribe() {
    if (!subscribed_.empty()) client_.unsubscribe(subscribed_);
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
    if (!op || !path || strcmp(op, "change") != 0 || !hasValues_) return;
    if (envelope["overflow"].as<bool>()) {
        // Notifications were lost: read the page again.
        poll();
        return;
    }
    apply(path, envelope["body"]);
    syncAll();
}

// A merge patch at `path` (section 7.3), into the page's values.
void LvglUi::apply(std::string_view path, JsonVariantConst body) {
    const std::string& at = page_.path;
    if (model::isUnder(path, at)) {
        std::vector<std::string_view> rel = segmentsOf(path.substr(at == "/" ? 0 : at.size()));
        if (rel.empty()) {
            if (body.is<JsonObjectConst>()) {
                JsonObject root = values_.is<JsonObject>() ? values_.as<JsonObject>() : values_.to<JsonObject>();
                merge(root, body.as<JsonObjectConst>());
            } else {
                values_.set(body);
            }
            return;
        }
        JsonObject node = values_.is<JsonObject>() ? values_.as<JsonObject>() : values_.to<JsonObject>();
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
            JsonObject root = values_.is<JsonObject>() ? values_.as<JsonObject>() : values_.to<JsonObject>();
            merge(root, sub.as<JsonObjectConst>());
        } else {
            values_.set(sub);
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
        // A path outside the page isn't read (yet): the test passes.
        if (!model::isUnder(c.path, page_.path)) continue;
        if (!model::holds(c, valueAt(c.path))) return false;
    }
    return true;
}

void LvglUi::conditions(Bound& b) {
    if (!b.item || !b.row) return;
    if (!b.item->visibleWhen.empty()) {
        lv_obj_set_hidden(b.row, !(holds(b.item->visibleWhen)));
    }
    if (!b.item->enabledWhen.empty()) {
        bool on = holds(b.item->enabledWhen);
        for (lv_obj_t* o : {b.control, b.button, b.minus, b.plus}) {
            if (!o) continue;
            if (on) {
                lv_obj_remove_state(o, LV_STATE_DISABLED);
            } else {
                lv_obj_add_state(o, LV_STATE_DISABLED);
            }
        }
    }
}

void LvglUi::syncAll() {
    for (auto& b : bound_) {
        sync(*b);
        conditions(*b);
    }
}

void LvglUi::sync(Bound& b) {
    if (!b.item || b.section || b.forAction || b.pending > 0 || typing_ == &b || (!b.control && !b.value)) return;
    if (b.item->isAction() || b.widget == Widget::Link) return;
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
            lv_label_set_text(b.value, model::formatValue(v, item).c_str());
            break;
        case Widget::Bar:
            lv_bar_set_value(b.control, static_cast<int32_t>(lround(v.as<double>() * b.scale)), LV_ANIM_OFF);
            lv_label_set_text(b.value, model::formatValue(v, item).c_str());
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
            for (size_t i = 0; s && i < item.options.size(); i++) {
                if (item.options[i].value == s) {
                    lv_dropdown_set_selected(b.control, static_cast<uint32_t>(i));
                    found = true;
                }
            }
            // A value that isn't among the options (a keyed list's key) is
            // shown as it is.
            b.dropdownText = found ? std::string() : text(v);
            lv_dropdown_set_text(b.control, found ? nullptr : b.dropdownText.c_str());
            break;
        }
        case Widget::Text:
        case Widget::Password:
        case Widget::Textarea:
            if (item.secret) break;  // never read back (section 4)
            lv_textarea_set_text(b.control, text(v).c_str());
            break;
        default: {
            // A readout: enums by their labels.
            std::string t = model::formatValue(v, item);
            const char* s = v.as<const char*>();
            for (size_t i = 0; s && i < item.options.size(); i++) {
                if (item.options[i].value == s) t = item.options[i].label;
            }
            lv_label_set_text(b.value, t.c_str());
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
    if (!column) lv_obj_set_style_min_height(r, 32, 0);
    lv_obj_set_scrollable(r, false);
    return r;
}

lv_obj_t* LvglUi::label(lv_obj_t* parent, const std::string& t, bool grow) {
    lv_obj_t* l = lv_label_create(parent);
    lv_label_set_text(l, t.c_str());
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
    lv_label_set_text(l, caption.c_str());
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
            lv_label_set_text(hl, now.c_str());
        },
        LV_EVENT_CLICKED, body);
    return body;
}

lv_obj_t* LvglUi::card(const Item& section) {
    lv_obj_t* c = lv_obj_create(content_);
    lv_obj_set_size(c, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(c, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(c, 8, 0);
    lv_obj_set_style_pad_row(c, 4, 0);
    lv_obj_set_scrollable(c, false);
    if (section.label.empty()) return c;
    if (section.collapsed) return collapsible(c, section.label, false);
    lv_obj_t* t = label(c, section.label, false);
#if LV_FONT_MONTSERRAT_16
    lv_obj_set_style_text_font(t, &lv_font_montserrat_16, 0);
#endif
    return c;
}

void LvglUi::items(lv_obj_t* parent, const std::vector<Item>& list) {
    for (const Item& item : list) {
        if (item.hidden) continue;
        switch (item.kind) {
            case ItemKind::Leaf:
                leaf(parent, item);
                break;
            case ItemKind::Link:
                link(parent, item, item.remote ? std::string_view(item.path) : std::string_view(route_.back().root));
                break;
            case ItemKind::Section: {
                // Collapsible groups, tabs and what the schema's depth cut
                // become pages of their own (section 6.4).
                // Forms send one patch on submit, from a draft (section 7.4):
                // not here yet.
                if (item.form) {
                    webOnly(parent, item.label);
                    break;
                }
                if (item.lazy || item.tabs || item.level >= 3) {
                    link(parent, item, route_.back().root);
                    break;
                }
                lv_obj_t* sub = row(parent, true);
                lv_obj_set_style_pad_top(sub, 4, 0);
                Bound& b = bind(item, sub);
                b.section = true;
                lv_obj_t* h = label(sub, item.label, false);
                lv_obj_set_style_text_opa(h, LV_OPA_80, 0);
                lv_obj_set_style_text_color(h, lv_palette_lighten(LV_PALETTE_BLUE, 2), 0);
                if (anyShown(item.items)) {
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

void LvglUi::link(lv_obj_t* parent, const Item& item, std::string_view root) {
    lv_obj_t* r = row(parent, false);
    lv_obj_set_clickable(r, true);
    label(r, item.label, true);
    if (item.remote) {
        lv_obj_t* d = lv_obj_create(r);
        lv_obj_set_size(d, 10, 10);
        lv_obj_set_style_radius(d, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_width(d, 0, 0);
        lv_obj_set_style_bg_color(d, item.online ? lv_palette_main(LV_PALETTE_GREEN) : lv_palette_main(LV_PALETTE_GREY), 0);
    }
    lv_obj_t* chevron = lv_label_create(r);
    lv_label_set_text(chevron, LV_SYMBOL_RIGHT);
    Bound& b = bind(item, r);
    b.widget = Widget::Link;
    b.control = r;
    b.openPath = item.path;
    b.openRoot = std::string(root);
    lv_obj_add_event_cb(r, onEvent, LV_EVENT_CLICKED, &b);
    lv_group_add_obj(group_, r);
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
    bound_.push_back(std::move(b));
    return *bound_.back();
}

void LvglUi::leaf(lv_obj_t* parent, const Item& item) {
    if (item.isAction()) {
        action(parent, item);
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
    if (w == Widget::Slider || w == Widget::Bar || w == Widget::Readout) {
        b.value = lv_label_create(top);
        lv_label_set_text(b.value, "\xE2\x80\x93");  // – until the value comes
        if (item.style == "warning") lv_obj_set_style_text_color(b.value, lv_palette_main(LV_PALETTE_AMBER), 0);
    }
    if (w == Widget::Readout) {
        b.widget = w;
        return;
    }
    control(b, column ? r : top, w);
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
            lv_obj_set_size(b.minus, 32, 32);
            lv_obj_t* m = lv_label_create(b.minus);
            lv_label_set_text(m, LV_SYMBOL_MINUS);
            lv_obj_center(m);
            c = lv_textarea_create(box);
            lv_textarea_set_one_line(c, true);
            lv_textarea_set_accepted_chars(c, "0123456789.-");
            lv_textarea_set_max_length(c, 16);
            lv_obj_set_width(c, 76);
            lv_obj_set_style_pad_ver(c, 6, 0);
            if (!item.unit.empty()) label(box, item.unit, false);
            b.plus = lv_button_create(box);
            lv_obj_set_size(b.plus, 32, 32);
            lv_obj_t* p = lv_label_create(b.plus);
            lv_label_set_text(p, LV_SYMBOL_PLUS);
            lv_obj_center(p);
            for (lv_obj_t* o : {b.minus, b.plus}) on(o, {LV_EVENT_CLICKED, LV_EVENT_LONG_PRESSED_REPEAT});
            on(c, {LV_EVENT_CLICKED, LV_EVENT_READY, LV_EVENT_CANCEL});
            break;
        }
        case Widget::Segmented: {
            c = lv_buttonmatrix_create(parent);
            b.map.clear();
            for (const model::Option& o : item.options) b.map.push_back(o.label.c_str());
            b.map.push_back("");
            lv_buttonmatrix_set_map(c, b.map.data());
            lv_buttonmatrix_set_button_ctrl_all(c, LV_BUTTONMATRIX_CTRL_CHECKABLE);
            lv_buttonmatrix_set_one_checked(c, true);
            lv_obj_set_size(c, LV_PCT(100), 38);
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
            lv_dropdown_set_options(c, options.c_str());
            lv_obj_set_width(c, b.forAction ? LV_PCT(55) : 140);
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
            lv_obj_set_style_pad_ver(c, 6, 0);
            if (item.maxLength) lv_textarea_set_max_length(c, item.maxLength);
            if (w == Widget::Password || item.secret) {
                lv_textarea_set_password_mode(c, true);
                lv_textarea_set_placeholder_text(c, "\xE2\x80\xA2\xE2\x80\xA2\xE2\x80\xA2\xE2\x80\xA2\xE2\x80\xA2\xE2\x80\xA2");
            } else if (!item.placeholder.empty()) {
                lv_textarea_set_placeholder_text(c, item.placeholder.c_str());
            }
            on(c, {LV_EVENT_CLICKED, LV_EVENT_READY, LV_EVENT_CANCEL});
            break;
        default:
            break;
    }
    b.control = c;
    if (c) lv_group_add_obj(group_, c);
    return c;
}

void LvglUi::action(lv_obj_t* parent, const Item& item) {
    // Object arguments need their fields (not here yet); raw JSON ones are
    // hidden on LCD (section 4).
    if (item.type == NodeType::Object && item.value.empty()) {
        webOnly(parent, item.label);
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
                lv_label_set_text(b.value, "");
            }
            control(b, r, field);
            line = row(r, false);
        } else {
            line = row(r, false);
            control(b, line, field);
        }
        if (field == Widget::Slider && item.hasMin) {
            lv_slider_set_value(b.control, static_cast<int32_t>(lround(item.min * b.scale)), LV_ANIM_OFF);
            lv_label_set_text(b.value, model::formatNumber(item.min, item).c_str());
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
    lv_label_set_text(t, item.label.c_str());
    lv_obj_center(t);
    if (item.widget == Widget::Hold) {
        for (lv_event_code_t code : {LV_EVENT_PRESSED, LV_EVENT_RELEASED, LV_EVENT_PRESS_LOST}) {
            lv_obj_add_event_cb(b.button, onEvent, code, &b);
        }
    } else {
        lv_obj_add_event_cb(b.button, onEvent, LV_EVENT_CLICKED, &b);
    }
    lv_group_add_obj(group_, b.button);
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
            if (i >= item.options.size()) return std::string();
            return jsonString(item.options[i].value);
        }
        case Widget::Text:
        case Widget::Password:
        case Widget::Textarea:
            return jsonString(lv_textarea_get_text(b.control));
        default:
            return std::string();
    }
}

void LvglUi::event(Bound& b, lv_event_t* e) {
    lv_event_code_t code = lv_event_get_code(e);
    lv_obj_t* target = lv_event_get_target_obj(e);
    if (b.widget == Widget::Link) {
        open(b.openPath, b.openRoot);  // clears the page: nothing below may touch `b`
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
    Widget w = b.forAction ? b.fieldWidget : b.widget;
    switch (w) {
        case Widget::Slider: {
            double v = snap(item, lv_slider_get_value(b.control) / b.scale);
            if (b.value) lv_label_set_text(b.value, model::formatNumber(v, item).c_str());
            if (b.forAction) return;
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
                if (!b.forAction) write(b, numberJson(item, v));
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
                if (!json.empty()) write(b, json);
            }
            return;
    }
}

void LvglUi::textDone(Bound& b, bool ok) {
    hideKeyboard();
    lv_obj_remove_state(b.control, LV_STATE_FOCUSED);
    if (b.forAction) return;
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
    typing_ = nullptr;
    if (!keyboard_) return;
    lv_keyboard_set_textarea(keyboard_, nullptr);
    lv_obj_set_hidden(keyboard_, true);
    if (content_) lv_obj_set_style_pad_bottom(content_, 6, 0);
}

// ---- Writes and calls ----------------------------------------------------------

void LvglUi::write(Bound& b, const std::string& json) {
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
    confirmIndex_ = b.index;
    confirmArg_ = arg;
    confirmGen_ = gen_;
    msgbox_ = lv_msgbox_create(nullptr);
    lv_msgbox_add_text(msgbox_, b.item->confirm.c_str());
    lv_obj_t* cancel = lv_msgbox_add_footer_button(msgbox_, "Cancel");
    confirmOk_ = lv_msgbox_add_footer_button(msgbox_, "OK");
    auto onAnswer = [](lv_event_t* e) {
        LvglUi* ui = static_cast<LvglUi*>(lv_event_get_user_data(e));
        bool yes = lv_event_get_target_obj(e) == ui->confirmOk_;
        lv_msgbox_close(ui->msgbox_);
        ui->msgbox_ = nullptr;
        if (yes && ui->confirmGen_ == ui->gen_ && ui->confirmIndex_ < ui->bound_.size()) {
            ui->call(*ui->bound_[ui->confirmIndex_], ui->confirmArg_);
        }
    };
    lv_obj_add_event_cb(cancel, onAnswer, LV_EVENT_CLICKED, this);
    lv_obj_add_event_cb(confirmOk_, onAnswer, LV_EVENT_CLICKED, this);
}

void LvglUi::call(Bound& b, const std::string& arg) {
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
        if (!hold && !body.isNull() && !body.isUnbound()) {
            // A reply other than null is shown by the button.
            std::string t = std::string(LV_SYMBOL_OK " ") + text(body);
            lv_label_set_text(bb.result, t.c_str());
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

void LvglUi::loop() {
    client_.process();
    uint32_t now = lv_tick_get();
    for (auto& b : bound_) {
        if (b->dirty && now - b->lastSent >= kThrottleMs) {
            b->dirty = false;
            std::string json = controlJson(*b);
            if (!json.empty() && json != b->sent) write(*b, json);
        }
    }
    if (toast_ && toastUntil_ && static_cast<int32_t>(now - toastUntil_) >= 0) {
        lv_obj_set_hidden(toast_, true);
        toastUntil_ = 0;
    }
}

}  // namespace tesserui

#endif
