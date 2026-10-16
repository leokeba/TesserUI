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
    // with lv_indev_set_group(), or let input() do it.
    lv_group_t* group() {
        useGroup_ = true;
        return group_;
    }
    // Buttons or an encoder instead of touch (an LV_INDEV_TYPE_ENCODER or
    // KEYPAD): the UI moves it between its groups (the page, a question,
    // the keyboard). Call it before begin().
    void input(lv_indev_t* indev) {
        indev_ = indev;
        useGroup_ = true;
        if (indev) lv_indev_set_group(indev, group_);
    }
    // What a back button does: leaves editing, closes a question or the
    // keyboard, else goes back a page.
    void escape();
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
        // A list's or an array's element: its page follows the list, since
        // subscriptions below a list are refused.
        std::string list;      // the list's path; empty: not an element
        std::string keyField;  // keyed lists: the field naming elements
        std::string id;        // the element's key, or its index
        bool scalar = false;   // an array's element: one value
        std::string title;

        static Route to(std::string path, std::string root, bool menu = false, bool status = false) {
            Route r;
            r.path = std::move(path);
            r.root = std::move(root);
            r.menu = menu;
            r.status = status;
            return r;
        }
    };
    // A form, or an action's object argument: controls that edit a draft,
    // sent as one patch (section 7.4).
    struct Draft {
        std::string path;     // the form's object, or the action
        std::string submit;   // the form's submit action (empty: none)
        bool action = false;  // an action's argument
        const model::Item* item = nullptr;  // the form's section, or the action
        lv_obj_t* reset = nullptr;
        lv_obj_t* apply = nullptr;
        lv_obj_t* result = nullptr;
        bool busy = false;
    };
    struct EventInfo {
        std::string path;
        model::Toast toast = model::Toast::None;
        std::string label;
    };
    struct RowRef;
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
    void setValues(JsonVariantConst body);

    // Rendering
    lv_obj_t* card(const model::Item& section);
    void items(lv_obj_t* parent, const std::vector<model::Item>& list);
    void advanced(lv_obj_t* parent, const std::vector<model::Item>& list);
    void leaf(lv_obj_t* parent, const model::Item& item);
    void link(lv_obj_t* parent, const model::Item& item, const Route& target);
    void dot(lv_obj_t* parent, bool online);
    void action(lv_obj_t* parent, const model::Item& item);
    void form(lv_obj_t* parent, const model::Item& section);
    void params(lv_obj_t* parent, const model::Item& action);
    void list(lv_obj_t* parent, const model::Item& item);
    void rows(Bound& b, JsonVariantConst value);
    void removeFooter();
    void webOnly(lv_obj_t* parent, const std::string& text);
    lv_obj_t* control(Bound& b, lv_obj_t* parent, model::Widget w);
    Bound& bind(const model::Item& item, lv_obj_t* row);
    lv_obj_t* row(lv_obj_t* parent, bool column);
    lv_obj_t* label(lv_obj_t* parent, const std::string& text, bool grow);
    void focusable(lv_obj_t* obj);
    void outline(lv_obj_t* obj);
    void focusFirst();
    void modal(lv_obj_t* const* objs, size_t n, bool editing);
    void endModal();
    static void onSliderKey(lv_event_t* e);
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
    // A value from a control: written, or kept in its draft.
    void commit(Bound& b, const std::string& json);
    void draftChanged(size_t draft);
    void submitDraft(size_t draft);
    void resetDraft(size_t draft);
    // A write nothing on screen waits for (a list's row switch, a list
    // replaced); the reply's value goes into the page's values.
    void send(const std::string& path, const std::string& json, const std::string& what,
              std::function<void()> done = nullptr);
    void addElement(Bound& list, const std::string& key);
    void removeElement();
    JsonVariantConst elementOf(JsonVariantConst list) const;
    void ask(const std::string& question, std::function<void()> yes);
    void ensureEvents();
    void eventNotified(const std::string& path, JsonVariantConst body);
    std::string nodeRoot() const;
    void call(Bound& b, const std::string& arg);
    void confirmThen(Bound& b, const std::string& arg);
    void textDone(Bound& b, bool ok);
    std::string controlJson(Bound& b);
    void toast(const std::string& text, bool error);
    void toast(const std::string& text, model::Toast kind);
    void error(const std::string& what, Status s, JsonVariantConst body);
    void connection(bool ok);

    // Keyboard
    void keyboard(Bound& b, lv_obj_t* textarea, bool numeric);
    void hideKeyboard();

    static void onEvent(lv_event_t* e);
    static void onRow(lv_event_t* e);
    void rowEvent(RowRef& r, lv_event_t* e);
    static void onShow(void* user);
    static void onChrome(lv_event_t* e);
    void event(Bound& b, lv_event_t* e);

    tesser::ApiClient& client_;
    lv_display_t* display_;
    const lv_font_t* font_ = nullptr;
    lv_group_t* group_ = nullptr;
    bool useGroup_ = false;
    lv_indev_t* indev_ = nullptr;
    lv_group_t* modal_ = nullptr;      // a question's or the keyboard's buttons, while shown
    lv_obj_t* firstFocus_ = nullptr;   // focused when the page is drawn
    lv_obj_t* typingArea_ = nullptr;   // the field the keyboard types into
    // Sizes, smaller on small screens (a 135-pixel side).
    struct Metrics {
        bool compact = false;
        int32_t header = 36, row = 32, entry = 40, listRow = 36, pad = 6, cardPad = 8, button = 32, fieldPad = 6,
                chart = 70, segmented = 38;
    } m_;
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
    std::vector<Draft> drafts_;
    size_t drafting_ = 0;                  // while drawing a draft's controls: its index + 1
    const model::Item* skip_ = nullptr;    // while drawing a form: its submit action, drawn last
    JsonDocument listValue_;               // an element page's list
    JsonDocument elementSchema_;           // and its element's schema
    bool listEditable_ = false;
    std::function<void()> confirmed_;      // the question's yes
    // Events (section 7.8): one subscription per node, for toasts.
    std::string eventsPath_;
    std::vector<EventInfo> eventInfo_;
    bool online_ = true;
};

}  // namespace tesserui

#endif
