// Schema -> UI model for the LVGL renderer (docs/DESIGN.md sections 4 to 6):
// widget inference, hints, layout and the menu. The web renderer's model
// (web/src/model) is the reference; the two share no code, only the golden
// models in fixtures/ (section 11), which the host tests compare this one
// against. Platform-independent: no LVGL here.
//
// A page is built from the schema JSON of its object and holds what the
// renderer needs once that JSON is freed (section 10.2).
#pragma once

#include <stdint.h>

#include <string>
#include <string_view>
#include <vector>

#include <ArduinoJson.h>

namespace tesserui {
namespace model {

// The semantic widgets of section 4 and section 5.1. Element: a custom
// element (section 9.8), whose name is Item::element.
enum class Widget : uint8_t {
    Readout,
    Toggle,
    Checkbox,
    Led,
    Slider,
    Knob,
    Number,
    Stepper,
    Bar,
    Gauge,
    Chart,
    Segmented,
    Select,
    Radio,
    Text,
    Password,
    Textarea,
    Color,
    Flags,
    Timezone,
    Button,
    Hold,
    Json,
    Events,
    Log,
    Table,
    List,
    File,
    Link,
    Element,
};

const char* toString(Widget w);

// A schema node's type, or an action's argument type (Any: raw JSON).
enum class NodeType : uint8_t {
    Unknown,
    Object,
    Boolean,
    Integer,
    Number,
    String,
    Action,
    Event,
    Custom,
    List,
    Array,
    File,
    Remote,
    Any,
};

const char* toString(NodeType t);
NodeType parseNodeType(std::string_view s);

struct Option {
    std::string value;
    std::string label;
};

// visibleWhen / enabledWhen (section 5.3): one test, all of which must hold.
struct Condition {
    std::string path;  // absolute
    bool equal = true;
    std::string literal;
};

std::vector<Condition> parseConditions(std::string_view text, std::string_view base, std::string_view root);
// `path` resolved against `base` (relative) or `root` (absolute).
std::string resolvePath(std::string_view path, std::string_view base, std::string_view root);
// Whether `value` (absent: null) passes the test: its JSON text equals the
// literal, or a string equals it unquoted. An absent value fails.
bool holds(const Condition& c, JsonVariantConst value);

enum class ItemKind : uint8_t { Leaf, Section, Link };

// One leaf, section or link: what section 10.2 calls a widget descriptor.
// Fields that don't apply to its kind stay at their defaults.
struct Item {
    ItemKind kind = ItemKind::Leaf;
    std::string name;
    std::string path;
    std::string label;
    std::string icon;
    bool advanced = false;
    bool hidden = false;
    std::vector<Condition> visibleWhen;
    std::vector<Condition> enabledWhen;

    // Leaves
    Widget widget = Widget::Readout;
    NodeType schemaType = NodeType::Unknown;  // the node's own type
    NodeType type = NodeType::Unknown;        // the value's, or an action's argument's
    bool editable = false;
    bool hasMin = false, hasMax = false, hasStep = false;
    double min = 0, max = 0, step = 0;
    int8_t precision = -1;  // -1: none
    uint32_t maxLength = 0;
    std::string unit;
    std::string format;
    std::string placeholder;
    std::string confirm;
    std::string style;
    std::string returns;
    std::string element;  // Widget::Element: its tag name
    std::string value;    // the fixed argument a button sends (JSON text), if any
    std::vector<Option> options;
    bool hasOptions = false;  // `options` applies, even empty
    std::string optionsFrom;  // ui.options: the keyed list whose keys are choices too
    bool secret = false;
    bool deferred = false;
    bool submit = false;
    bool hasField = false;  // typed actions: the argument's input
    Widget field = Widget::Readout;
    uint32_t keepalive = 0;

    // Sections
    uint8_t level = 0;  // 1: card, 2: sub-section, 3 and more: collapsible group
    std::vector<Item> items;
    std::vector<Item> advancedItems;
    bool lazy = false;
    bool tabs = false;
    bool inlined = false;
    bool collapsed = false;
    bool form = false;

    // Links
    bool remote = false;
    bool online = true;

    bool isAction() const { return schemaType == NodeType::Action; }
};

struct Page {
    std::string path;
    std::string label;
    std::vector<Item> cards;    // sections, level 1
    std::vector<Item> actions;  // buttons directly under the page
    // Subscription (section 7.3): `keys` when some children are left out.
    int depth = 0;  // -1: unlimited
    bool hasKeys = false;
    std::string keys;
};

struct MenuEntry {
    std::string label;
    std::string icon;
    std::string path;  // empty: a ui.group heading
    bool remote = false;
    bool online = true;
    std::vector<MenuEntry> children;
};

// The page at `path` (section 6.1), from its object's schema. `root` is the
// path of the node it belongs to ("/", or a remote node's path). `menu`: the
// page's objects and remote nodes are menu entries, not cards (section 6.3).
Page buildPage(JsonObjectConst schema, std::string_view path, std::string_view root = "/", bool menu = false);
// The menu of the node at `home` (section 6.3), without view pages.
std::vector<MenuEntry> buildMenu(JsonObjectConst schema, std::string_view home = "/");
// What becomes a menu entry rather than a card: objects and remote nodes.
bool isEntry(JsonObjectConst schema);
// Whether the start page has values, lists or actions of its own.
bool hasOwnItems(JsonObjectConst schema);

// The schema below `root` at `path` (relative to it), crossing nothing.
JsonObjectConst schemaAt(JsonObjectConst root, std::string_view path);

std::string joinPath(std::string_view base, std::string_view name);
std::string parentPath(std::string_view path);
bool isUnder(std::string_view path, std::string_view base);

// ---- Formatting (section 4) ----------------------------------------------

// brightnessMax -> "Brightness max", pid_kp -> "Pid kp", HTTPPort -> "HTTP port".
std::string humanize(std::string_view name);
// Decimals in the shortest text of `step` (0.25 -> 2, 1e-7 -> 7).
int decimalsOf(double step);
// A value as text: the leaf's `format`, else its precision, else integers as
// they are and numbers with up to 3 decimals; bytes and seconds scaled, the
// unit after. Absent: an en dash.
std::string formatValue(JsonVariantConst v, const Item& leaf);
std::string formatNumber(double v, const Item& leaf);
// 1536 -> "1.5 KB", 2031616 -> "1.94 MB".
std::string formatBytes(int64_t n);
// 59 -> "59 s", 3725 -> "1 h 2 min", 90061 -> "1 d 1 h".
std::string formatDuration(int64_t n);
// The printf subset of ui.format: %d %i %u %f %e %g %s %%, with a precision.
std::string printfValue(std::string_view format, JsonVariantConst v);

}  // namespace model
}  // namespace tesserui
