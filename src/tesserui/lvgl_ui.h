// The LVGL renderer (docs/DESIGN.md section 10): a node's UI on a
// touchscreen, driving the node it runs on (tesser::LocalClient) or another
// one (tesser::PeerClient). Built only when LVGL is in the build.
//
//   tesser::LocalClient client(api);
//   tesserui::LvglUi ui(client, display);   // an lv_display_t* the application set up
//   ui.begin("/");
//   for (;;) { ui.loop(); lv_timer_handler(); vTaskDelay(pdMS_TO_TICKS(5)); }
//
// Every LVGL call and every ApiClient callback runs in the task that calls
// loop(), so nothing is locked. The UI takes the client's notification
// handler (ApiClient::onNotification).
#pragma once

#if __has_include(<lvgl.h>)

#include <stdint.h>

#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include <ArduinoJson.h>
#include <lvgl.h>

#include "tesser/client.h"
#include "tesserui/model.h"

namespace tesserui {

class LvglUi {
public:
    LvglUi(tesser::ApiClient& client, lv_display_t* display);
    ~LvglUi();
    LvglUi(const LvglUi&) = delete;
    LvglUi& operator=(const LvglUi&) = delete;

    // Reads the node's schema at `root` and shows its menu (section 6.4).
    void begin(std::string_view root = "/");
    // client.process(), then the UI's own work (throttled writes). Call it
    // before lv_timer_handler(), from the same task.
    void loop();

    // Each page's focusable controls, for an encoder or a keypad: attach it
    // with lv_indev_set_group().
    lv_group_t* group() const { return group_; }
    // The font of every text, for units beyond ASCII and degrees (µ, Ω).
    // Call it before begin().
    void font(const lv_font_t* font) { font_ = font; }

    // Opens the page at `path`, inside the node at `root` (empty: this
    // node's): what tapping an entry does. Back returns to where it was.
    void open(std::string_view path, std::string_view root = "");
    void back();
    // The open page's path; empty for the menu.
    const std::string& current() const { return route_.empty() ? empty_ : route_.back().path; }
    // Whether a schema read or the page's first values are still awaited.
    bool loading() const { return loading_; }

private:
    struct Route {
        std::string path;
        std::string root;     // the node's path; empty: this node's (begin())
        bool menu = false;    // the node's menu, not a page
        bool status = false;  // the node's own values only (its menu's Status)
    };
    using SchemaHandler = std::function<void(tesser::Status, JsonVariantConst)>;
    struct Bound;
    using Status = tesser::Status;

    void chrome();
    void loadRoot();
    // Shows the route's top (the menu when it is empty) from the next
    // timer pass: taps that navigate delete the control they come from.
    void requestShow();
    void show();
    void showMenu();
    void showNodeMenu();
    void showPage();
    void clearPage();
    void clearContent();
    void drawMenu(const std::vector<model::MenuEntry>& menu, const std::string& home, const std::string& root);
    void refreshMenu();
    void schema(const std::string& path, int depth, SchemaHandler done);
    void failed(const char* what, tesser::Status s, JsonVariantConst body);
    static size_t entries(const std::vector<model::MenuEntry>& menu);
    static std::string only(const std::vector<model::MenuEntry>& menu, const std::string& home);
    static bool same(const std::vector<model::MenuEntry>& a, const std::vector<model::MenuEntry>& b);
    void message(const char* text, bool retry);
    void setTitle(const std::string& title);
    void subscribe();
    void poll();
    void unsubscribe();
    void onNotification(JsonObjectConst envelope);
    void apply(std::string_view path, JsonVariantConst body);

    // Rendering
    lv_obj_t* card(const model::Item& section);
    void items(lv_obj_t* parent, const std::vector<model::Item>& list);
    void advanced(lv_obj_t* parent, const std::vector<model::Item>& list);
    void leaf(lv_obj_t* parent, const model::Item& item);
    void link(lv_obj_t* parent, const model::Item& item, const Route& target);
    void dot(lv_obj_t* parent, bool online);
    void action(lv_obj_t* parent, const model::Item& item);
    void webOnly(lv_obj_t* parent, const std::string& text);
    lv_obj_t* control(Bound& b, lv_obj_t* parent, model::Widget w);
    Bound& bind(const model::Item& item, lv_obj_t* row);
    lv_obj_t* row(lv_obj_t* parent, bool column);
    lv_obj_t* label(lv_obj_t* parent, const std::string& text, bool grow);
    lv_obj_t* collapsible(lv_obj_t* parent, const std::string& title, bool open);

    // Values
    JsonVariantConst valueAt(std::string_view path) const;
    void setValueAt(std::string_view path, JsonVariantConst value);
    void syncAll();
    void sync(Bound& b);
    void conditions(Bound& b);
    bool holds(const std::vector<model::Condition>& conds) const;

    // Writes and calls
    void write(Bound& b, const std::string& json);
    void call(Bound& b, const std::string& arg);
    void confirmThen(Bound& b, const std::string& arg);
    void textDone(Bound& b, bool ok);
    std::string controlJson(Bound& b);
    void toast(const std::string& text, bool error);
    void error(const std::string& what, Status s, JsonVariantConst body);
    void connection(bool ok);

    // Keyboard
    void keyboard(Bound& b, lv_obj_t* textarea, bool numeric);
    void hideKeyboard();

    static void onEvent(lv_event_t* e);
    static void onShow(void* user);
    static void onChrome(lv_event_t* e);
    void event(Bound& b, lv_event_t* e);

    tesser::ApiClient& client_;
    lv_display_t* display_;
    const lv_font_t* font_ = nullptr;
    lv_group_t* group_ = nullptr;
    std::shared_ptr<int> alive_;

    // Chrome
    lv_obj_t* screen_ = nullptr;
    lv_obj_t* header_ = nullptr;
    lv_obj_t* backButton_ = nullptr;
    lv_obj_t* title_ = nullptr;
    lv_obj_t* dot_ = nullptr;
    lv_obj_t* content_ = nullptr;
    lv_obj_t* keyboard_ = nullptr;
    lv_obj_t* retry_ = nullptr;
    lv_obj_t* toast_ = nullptr;
    lv_obj_t* toastLabel_ = nullptr;
    uint32_t toastUntil_ = 0;
    lv_obj_t* msgbox_ = nullptr;  // a confirmation (ui.confirm)
    lv_obj_t* confirmOk_ = nullptr;
    size_t confirmIndex_ = 0;
    std::string confirmArg_;
    uint32_t confirmGen_ = 0;
    bool showPending_ = false;
    Bound* typing_ = nullptr;  // the field the keyboard edits
    lv_timer_t* retryTimer_ = nullptr;
    lv_timer_t* pollTimer_ = nullptr;

    // The node
    std::string root_ = "/";
    std::string rootLabel_;
    bool rootLoaded_ = false;
    std::vector<model::MenuEntry> menu_;
    bool menuShown_ = false;  // the menu is the start screen (more than one entry)
    std::vector<Route> route_;
    std::string empty_;

    // The open page (section 10.2: one at a time)
    uint32_t gen_ = 0;  // bumped on every page change: late replies are dropped
    bool loading_ = false;
    model::Page page_;
    JsonDocument values_;
    bool hasValues_ = false;
    std::string subscribed_;  // the path subscribed to, if any
    bool polling_ = false;    // a poll's read is in flight
    bool watching_ = false;   // the subscription is the menu's, for nodes coming and going
    bool refreshing_ = false;
    lv_timer_t* menuTimer_ = nullptr;
    std::vector<std::unique_ptr<Bound>> bound_;
    bool online_ = true;
};

}  // namespace tesserui

#endif
