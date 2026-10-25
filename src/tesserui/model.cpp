#include "tesserui/model.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace tesserui {
namespace model {

namespace {

bool isNumeric(NodeType t) { return t == NodeType::Integer || t == NodeType::Number; }

JsonVariantConst ui(JsonObjectConst s, const char* key) { return s["ui"][key]; }
bool uiTrue(JsonObjectConst s, const char* key) {
    JsonVariantConst v = ui(s, key);
    return v.is<bool>() && v.as<bool>();
}
// A string hint, or null when absent or of another type.
const char* uiStr(JsonObjectConst s, const char* key) {
    JsonVariantConst v = ui(s, key);
    return v.is<const char*>() ? v.as<const char*>() : nullptr;
}
bool nonEmpty(const char* s) { return s && *s; }
const char* str(JsonObjectConst s, const char* key) {
    JsonVariantConst v = s[key];
    return v.is<const char*>() ? v.as<const char*>() : nullptr;
}
NodeType typeOf(JsonObjectConst s) {
    const char* t = str(s, "type");
    return t ? parseNodeType(t) : NodeType::Unknown;
}
// Nodes with a value: actions, events and files have none.
bool valued(JsonObjectConst s) {
    NodeType t = typeOf(s);
    return t != NodeType::Action && t != NodeType::Event && t != NodeType::File;
}

std::string_view trim(std::string_view s) {
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\n' || s.front() == '\r')) s.remove_prefix(1);
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\n' || s.back() == '\r')) s.remove_suffix(1);
    return s;
}

std::vector<std::string_view> split(std::string_view s, char sep) {
    std::vector<std::string_view> out;
    size_t start = 0;
    for (;;) {
        size_t i = s.find(sep, start);
        out.push_back(s.substr(start, i == std::string_view::npos ? std::string_view::npos : i - start));
        if (i == std::string_view::npos) return out;
        start = i + 1;
    }
}

std::vector<std::string_view> segments(std::string_view path) {
    std::vector<std::string_view> out;
    for (std::string_view s : split(path, '/')) {
        if (!s.empty()) out.push_back(s);
    }
    return out;
}

std::string_view lastSegment(std::string_view path) {
    size_t i = path.rfind('/');
    return i == std::string_view::npos ? path : path.substr(i + 1);
}

bool isLower(char c) { return c >= 'a' && c <= 'z'; }
bool isUpper(char c) { return c >= 'A' && c <= 'Z'; }
bool isDigit(char c) { return c >= '0' && c <= '9'; }

// Custom element names: lowercase, starting with a letter, with a hyphen.
bool isElement(JsonVariantConst w) {
    if (!w.is<const char*>()) return false;
    const char* s = w.as<const char*>();
    if (!isLower(*s)) return false;
    bool hyphen = false;
    for (const char* p = s + 1; *p; p++) {
        char c = *p;
        if (c == '-') {
            hyphen = true;
        } else if (!isLower(c) && !isDigit(c) && c != '.' && c != '_') {
            return false;
        }
    }
    return hyphen;
}

struct Widgets {
    const char* name;
    Widget widget;
};
const Widgets kWidgets[] = {
    {"readout", Widget::Readout},   {"toggle", Widget::Toggle},     {"checkbox", Widget::Checkbox},
    {"led", Widget::Led},           {"slider", Widget::Slider},     {"knob", Widget::Knob},
    {"number", Widget::Number},     {"stepper", Widget::Stepper},   {"bar", Widget::Bar},
    {"gauge", Widget::Gauge},       {"chart", Widget::Chart},       {"segmented", Widget::Segmented},
    {"select", Widget::Select},     {"radio", Widget::Radio},       {"text", Widget::Text},
    {"password", Widget::Password}, {"textarea", Widget::Textarea}, {"color", Widget::Color},
    {"flags", Widget::Flags},       {"timezone", Widget::Timezone}, {"button", Widget::Button},
    {"hold", Widget::Hold},         {"json", Widget::Json},         {"events", Widget::Events},
    {"log", Widget::Log},           {"table", Widget::Table},       {"list", Widget::List},
    {"file", Widget::File},         {"link", Widget::Link},         {"element", Widget::Element},
};

bool parseWidget(const char* s, Widget& out) {
    if (!s) return false;
    for (const Widgets& w : kWidgets) {
        if (strcmp(w.name, s) == 0) {
            out = w.widget;
            return true;
        }
    }
    return false;
}

// The inputs of widget inference: a value's schema, or an action's
// argument's (which has no enum of its own).
struct Infer {
    NodeType type = NodeType::Unknown;
    bool editable = false;
    bool hasRange = false;
    // An integer's range has at most 1000 steps: an amount a slider fits,
    // not a DMX universe. Decimal numbers are amounts.
    bool fewSteps = true;
    bool hasEnum = false;
    bool optionsHint = false;  // a non-empty ui.options
    const char* hint = nullptr;
    const std::vector<Option>* options = nullptr;
};

bool fits(Widget w, const Infer& in) {
    NodeType type = in.type;
    switch (w) {
        case Widget::Toggle:
        case Widget::Checkbox:
            return type == NodeType::Boolean && in.editable;
        case Widget::Led:
            return type == NodeType::Boolean;
        case Widget::Slider:
        case Widget::Knob:
            return isNumeric(type) && in.editable && in.hasRange;
        case Widget::Number:
        case Widget::Stepper:
            return isNumeric(type) && in.editable;
        case Widget::Readout:
            return true;
        case Widget::Bar:
        case Widget::Gauge:
            return isNumeric(type) && in.hasRange;
        case Widget::Chart:
            return isNumeric(type);
        case Widget::Select:
        case Widget::Segmented:
        case Widget::Radio:
            return type == NodeType::String && (in.hasEnum || in.optionsHint) && in.editable;
        case Widget::Text:
        case Widget::Password:
        case Widget::Textarea:
        case Widget::Timezone:
            return type == NodeType::String && !in.hasEnum && in.editable;
        case Widget::Color:
            return (type == NodeType::String || type == NodeType::Integer) && in.editable;
        case Widget::Flags:
            return type == NodeType::Integer;
        default:
            return false;
    }
}

// Tier 0, overridden by ui.widget when it fits (tier 1).
Widget inferWidget(const Infer& in) {
    Widget hinted;
    if (nonEmpty(in.hint) && parseWidget(in.hint, hinted) && fits(hinted, in)) return hinted;
    switch (in.type) {
        case NodeType::Boolean:
            return in.editable ? Widget::Toggle : Widget::Led;
        case NodeType::Integer:
        case NodeType::Number:
            if (!in.editable) return Widget::Readout;
            return in.hasRange && in.fewSteps ? Widget::Slider : Widget::Number;
        case NodeType::String: {
            if (!in.editable) return Widget::Readout;
            if (in.optionsHint && !in.hasEnum) return Widget::Select;
            if (in.hasEnum) {
                bool shortLabels = true;
                size_t n = in.options ? in.options->size() : 0;
                if (in.options) {
                    for (const Option& o : *in.options) {
                        if (o.label.size() > 10) shortLabels = false;
                    }
                }
                return n <= 4 && shortLabels ? Widget::Segmented : Widget::Select;
            }
            return Widget::Text;
        }
        default:
            return Widget::Readout;
    }
}

// An enum's options, else a keyed list's fixed extras (ui.optionsExtra)
// when ui.options names one. False: no options.
bool optionsOf(JsonObjectConst s, std::vector<Option>& out) {
    out.clear();
    JsonArrayConst values = s["enum"];
    if (values.isNull()) {
        if (!nonEmpty(uiStr(s, "options"))) return false;
        if (const char* extra = uiStr(s, "optionsExtra")) {
            for (std::string_view v : split(extra, ',')) {
                std::string t(trim(v));
                out.push_back({t, t});
            }
        }
        return true;
    }
    std::vector<std::string_view> labels;
    if (const char* l = uiStr(s, "labels")) labels = split(l, ',');
    size_t i = 0;
    for (JsonVariantConst v : values) {
        Option o;
        o.value = v.as<const char*>() ? v.as<const char*>() : "";
        std::string_view label = i < labels.size() ? trim(labels[i]) : std::string_view();
        o.label = label.empty() ? o.value : std::string(label);
        out.push_back(std::move(o));
        i++;
    }
    return true;
}

// What a table cell can edit.
bool tableCell(Widget w) {
    switch (w) {
        case Widget::Text:
        case Widget::Password:
        case Widget::Number:
        case Widget::Slider:
        case Widget::Select:
        case Widget::Segmented:
        case Widget::Toggle:
        case Widget::Readout:
        case Widget::Led:
            return true;
        default:
            return false;
    }
}

// The state of one build: the node's root, for absolute condition paths.
struct Builder {
    std::string root = "/";
    Access inherited = Access::None;  // what the ancestors of what is built require

    void base(Item& item, std::string_view name, std::string_view path, JsonObjectConst s, std::string_view parent) {
        item.name = std::string(name);
        item.path = std::string(path);
        const char* label = str(s, "label");
        item.label = label ? std::string(label) : humanize(name);
        item.advanced = uiTrue(s, "advanced");
        item.hidden = uiTrue(s, "hidden");
        Access need = higher(inherited, s["access"].is<const char*>() ? parseAccess(s["access"].as<const char*>()) : Access::None);
        if (need > Access::Public) item.access = need;
        if (const char* icon = uiStr(s, "icon")) item.icon = icon;
        if (const char* vis = uiStr(s, "visibleWhen")) {
            if (*vis) item.visibleWhen = parseConditions(vis, parent, root);
        }
        if (const char* en = uiStr(s, "enabledWhen")) {
            if (*en) item.enabledWhen = parseConditions(en, parent, root);
        }
    }

    void number(Item& leaf, JsonObjectConst s) {
        if (!isNumeric(leaf.type)) return;
        JsonVariantConst step = s["step"];
        if (step.is<double>()) {
            leaf.hasStep = true;
            leaf.step = step.as<double>();
        } else if (leaf.type == NodeType::Integer) {
            leaf.hasStep = true;
            leaf.step = 1;
        }
        JsonVariantConst precision = ui(s, "precision");
        double stepValue = step.is<double>() ? step.as<double>() : 0;
        if (precision.is<double>()) {
            leaf.precision = static_cast<int8_t>(precision.as<int>());
        } else if (stepValue != 0) {
            leaf.precision = static_cast<int8_t>(decimalsOf(stepValue));
        } else if (leaf.type == NodeType::Integer) {
            leaf.precision = 0;
        }
        if (const char* format = uiStr(s, "format")) {
            if (*format) leaf.format = format;
        }
    }

    void choices(Item& leaf, JsonObjectConst s, std::string_view parent) {
        leaf.hasOptions = optionsOf(s, leaf.options);
        const char* from = uiStr(s, "options");
        if (nonEmpty(from) && s["enum"].isNull() && leaf.type == NodeType::String) {
            leaf.optionsFrom = resolvePath(from, parent, root);
            if (const char* by = uiStr(s, "optionsValue")) {
                if (*by) leaf.optionsValue = by;
            }
        }
    }

    Infer inference(JsonObjectConst s, NodeType type, bool editable, const std::vector<Option>* options) {
        Infer in;
        in.type = type;
        in.editable = editable;
        in.hasRange = s["min"].is<double>() && s["max"].is<double>();
        double step = s["step"].is<double>() ? s["step"].as<double>() : 1;
        if (in.hasRange && type == NodeType::Integer && step > 0) {
            in.fewSteps = (s["max"].as<double>() - s["min"].as<double>()) / step <= 1000;
        }
        in.hasEnum = !s["enum"].isNull();
        in.optionsHint = nonEmpty(uiStr(s, "options"));
        in.hint = uiStr(s, "widget");
        in.options = options;
        return in;
    }

    void action(Item& leaf, JsonObjectConst s, std::string_view parent) {
        leaf.deferred = s["deferred"].as<bool>();
        if (const char* returns = str(s, "returns")) leaf.returns = returns;
        if (const char* style = uiStr(s, "style")) {
            if (*style) leaf.style = style;
        }
        leaf.submit = uiTrue(s, "submit");
        if (const char* auth = uiStr(s, "auth")) leaf.auth = auth;
        const char* arg = str(s, "arg");
        const char* hint = uiStr(s, "widget");
        leaf.widget = Widget::Button;
        // Deferred actions taking tesser::Call& alone report an untyped
        // argument: they're buttons.
        if (!nonEmpty(arg) || (leaf.deferred && strcmp(arg, "any") == 0)) return;
        leaf.type = parseNodeType(arg);
        JsonVariantConst value = ui(s, "value");
        if (!value.isNull()) {
            serializeJson(value, leaf.value);
            return;
        }
        if (leaf.type == NodeType::Object) {
            leaf.editable = true;
            JsonObjectConst params = s["params"];
            if (!params.isNull()) fields(params, "", leaf.params);
            return;
        }
        if (hint && strcmp(hint, "hold") == 0 && leaf.type == NodeType::Boolean) {
            leaf.widget = Widget::Hold;
            JsonVariantConst k = ui(s, "keepalive");
            leaf.keepalive = k.is<double>() ? k.as<uint32_t>() : 300;
            return;
        }
        if (leaf.type == NodeType::Any) {
            leaf.hasField = true;
            leaf.field = Widget::Json;
            leaf.advanced = true;
            return;
        }
        leaf.editable = true;
        // The argument's schema: the action's range and hints, without its
        // enum; a "button" hint means the button itself.
        Infer in = inference(s, leaf.type, true, nullptr);
        in.hasEnum = false;
        in.hint = hint && strcmp(hint, "button") == 0 ? nullptr : hint;
        leaf.hasField = true;
        leaf.field = inferWidget(in);
        number(leaf, s);
        choices(leaf, s, parent);
    }

    // The values of an object argument, nested objects flattened into paths
    // relative to the argument.
    void fields(JsonObjectConst params, std::string_view prefix, std::vector<Item>& out) {
        for (JsonPairConst kv : params["children"].as<JsonObjectConst>()) {
            JsonObjectConst c = kv.value();
            std::string rel = prefix.empty() ? std::string(kv.key().c_str()) : std::string(prefix) + "/" + kv.key().c_str();
            if (typeOf(c) == NodeType::Object) {
                fields(c, rel, out);
            } else if (valued(c) && !uiTrue(c, "hidden")) {
                out.push_back(leaf(kv.key().c_str(), rel, c, ""));
            }
        }
    }

    // The leaves of a list element, flattened (paths relative to it).
    void columns(JsonObjectConst items, std::string_view prefix, std::vector<Item>& out) {
        if (typeOf(items) != NodeType::Object) {
            out.push_back(leaf("value", "", items, ""));
            return;
        }
        for (JsonPairConst kv : items["children"].as<JsonObjectConst>()) {
            JsonObjectConst c = kv.value();
            std::string rel = prefix.empty() ? std::string(kv.key().c_str()) : std::string(prefix) + "/" + kv.key().c_str();
            if (typeOf(c) == NodeType::Object) {
                columns(c, rel, out);
            } else if (valued(c) && !uiTrue(c, "hidden")) {
                out.push_back(leaf(kv.key().c_str(), rel, c, ""));
            }
        }
    }

    Item leaf(std::string_view name, std::string_view path, JsonObjectConst s, std::string_view parent) {
        Item leaf;
        base(leaf, name, path, s, parent);
        leaf.kind = ItemKind::Leaf;
        leaf.widget = Widget::Readout;
        leaf.schemaType = typeOf(s);
        leaf.type = leaf.schemaType;
        if (s["min"].is<double>()) {
            leaf.hasMin = true;
            leaf.min = s["min"].as<double>();
        }
        if (s["max"].is<double>()) {
            leaf.hasMax = true;
            leaf.max = s["max"].as<double>();
        }
        if (const char* unit = str(s, "unit")) leaf.unit = unit;
        if (const char* confirm = uiStr(s, "confirm")) leaf.confirm = confirm;
        if (const char* placeholder = uiStr(s, "placeholder")) leaf.placeholder = placeholder;
        leaf.maxLength = s["maxLength"].as<uint32_t>();
        bool readonly = uiTrue(s, "readonly");
        bool writable = s["writable"].as<bool>();

        // A custom element takes any node, objects included, as it is.
        if (isElement(ui(s, "widget"))) {
            leaf.widget = Widget::Element;
            leaf.element = uiStr(s, "widget");
            leaf.editable = (writable || leaf.schemaType == NodeType::Action) && !readonly;
            const char* arg = str(s, "arg");
            if (leaf.schemaType == NodeType::Action && nonEmpty(arg)) leaf.type = parseNodeType(arg);
            number(leaf, s);
            if (!s["enum"].isNull()) leaf.hasOptions = optionsOf(s, leaf.options);
            return leaf;
        }
        switch (leaf.schemaType) {
            case NodeType::Action:
                action(leaf, s, parent);
                return leaf;
            case NodeType::Event: {
                const char* w = uiStr(s, "widget");
                leaf.widget = w && strcmp(w, "log") == 0 ? Widget::Log : Widget::Events;
                JsonVariantConst toast = ui(s, "toast");
                if (toast.is<bool>()) {
                    if (toast.as<bool>()) leaf.toast = Toast::Info;
                } else if (const char* kind = toast.as<const char*>()) {
                    for (Toast t : {Toast::Info, Toast::Ok, Toast::Warn, Toast::Error}) {
                        if (strcmp(kind, toString(t)) == 0) leaf.toast = t;
                    }
                }
                return leaf;
            }
            case NodeType::List: {
                leaf.editable = writable && !readonly;
                JsonObjectConst items = s["items"];
                std::vector<Item> cols;
                if (!items.isNull()) columns(items, "", cols);
                bool actions = false, files = false;
                for (JsonPairConst kv : items["children"].as<JsonObjectConst>()) {
                    JsonObjectConst c = kv.value();
                    if (typeOf(c) == NodeType::Action) actions = true;
                    if (typeOf(c) == NodeType::File && !uiTrue(c, "hidden")) files = true;
                }
                // A few short fields fit a table; anything more is one line per
                // element that opens into the element's own controls.
                bool compact = !actions && !files && cols.size() <= 3;
                for (const Item& c : cols) {
                    if (c.path.find('/') != std::string::npos || !c.visibleWhen.empty() || !c.optionsFrom.empty() ||
                        !tableCell(c.widget)) {
                        compact = false;
                    }
                }
                const char* w = uiStr(s, "widget");
                bool asList = (w && strcmp(w, "list") == 0) || (!compact && !(w && strcmp(w, "table") == 0));
                leaf.widget = asList ? Widget::List : Widget::Table;
                leaf.maxSize = s["maxSize"].as<uint32_t>();
                leaf.hasColumns = true;
                leaf.columns = std::move(cols);
                if (const char* key = str(s, "key")) leaf.key = key;
                // An indexed list's moved rows would leave their unwritten fields
                // behind at their index: only keyed lists move.
                if (leaf.editable && !leaf.key.empty() && uiTrue(s, "reorder")) leaf.reorder = true;
                return leaf;
            }
            case NodeType::Array: {
                leaf.editable = writable;
                JsonObjectConst items = s["items"];
                NodeType itemType = items.isNull() || items["type"].isNull() ? NodeType::Number : typeOf(items);
                leaf.maxSize = s["maxSize"].as<uint32_t>();
                leaf.fixed = s["fixed"].as<bool>();
                if (leaf.editable && uiTrue(s, "reorder")) leaf.reorder = true;
                {
                    // One column: the items' type (numbers by default), writable
                    // as the array is.
                    JsonDocument column;
                    if (!items.isNull()) column.set(items);
                    if (column["type"].isNull()) column["type"] = "number";
                    column["writable"] = writable;
                    leaf.hasColumns = true;
                    leaf.columns.push_back(this->leaf("value", "", column.as<JsonObjectConst>(), ""));
                }
                const char* w = uiStr(s, "widget");
                leaf.widget = w && strcmp(w, "chart") == 0 && isNumeric(itemType) ? Widget::Chart : Widget::Table;
                if (leaf.widget == Widget::Chart) {
                    // Its axis and formatting are the items'.
                    leaf.type = itemType;
                    if (items["min"].is<double>()) {
                        leaf.hasMin = true;
                        leaf.min = items["min"].as<double>();
                    }
                    if (items["max"].is<double>()) {
                        leaf.hasMax = true;
                        leaf.max = items["max"].as<double>();
                    }
                    if (const char* unit = str(items, "unit")) leaf.unit = unit;
                    number(leaf, items);
                }
                return leaf;
            }
            case NodeType::Custom:
                leaf.widget = Widget::Json;
                leaf.editable = writable;
                return leaf;
            case NodeType::File:
                leaf.widget = Widget::File;
                leaf.editable = writable;
                leaf.maxSize = s["maxSize"].as<uint32_t>();
                return leaf;
            case NodeType::Remote:
                return leaf;  // links are built by sections
            default:
                break;
        }
        leaf.editable = writable && !readonly;
        if (s["secret"].as<bool>()) leaf.secret = true;
        // A read-only value styled as a warning: a callout.
        const char* style = uiStr(s, "style");
        if (!leaf.editable && style && strcmp(style, "warning") == 0) leaf.style = "warning";
        std::vector<Option> options;
        optionsOf(s, options);
        if (leaf.secret && leaf.editable && leaf.type == NodeType::String) {
            leaf.widget = Widget::Password;
        } else {
            leaf.widget = inferWidget(inference(s, leaf.type, leaf.editable, &options));
        }
        number(leaf, s);
        choices(leaf, s, parent);
        JsonVariantConst keepalive = ui(s, "keepalive");
        if (keepalive.is<double>() && keepalive.as<double>() != 0 && leaf.editable &&
            (isNumeric(leaf.type) || leaf.type == NodeType::Boolean)) {
            leaf.keepalive = keepalive.as<uint32_t>();
        }
        if (leaf.widget == Widget::Chart) {
            JsonVariantConst h = ui(s, "history");
            leaf.history = h.is<double>() ? h.as<uint32_t>() : 60;
        }
        if (leaf.widget == Widget::Flags) {
            if (const char* l = uiStr(s, "labels")) {
                for (std::string_view x : split(l, ',')) {
                    if (!trim(x).empty()) leaf.flagLabels.emplace_back(trim(x));
                }
            }
        }
        return leaf;
    }

    Item link(std::string_view name, std::string_view path, JsonObjectConst s, std::string_view parent) {
        Item l;
        base(l, name, path, s, parent);
        l.kind = ItemKind::Link;
        l.widget = Widget::Link;
        l.schemaType = typeOf(s);
        l.remote = l.schemaType == NodeType::Remote;
        l.online = !(s["online"].is<bool>() && !s["online"].as<bool>());
        if (l.remote && !str(s, "label")) l.label = std::string(name);
        return l;
    }

    // `skipEntries`: leave out the children that are menu entries.
    Item section(std::string_view name, std::string_view path, JsonObjectConst s, uint8_t level, std::string_view parent,
                 std::vector<Item>& promoted, bool skipEntries = false) {
        Item sec;
        base(sec, name, path, s, parent);
        sec.kind = ItemKind::Section;
        sec.schemaType = NodeType::Object;
        sec.level = level;
        sec.lazy = s["children"].isNull();
        sec.tabs = uiTrue(s, "tabs");
        sec.inlined = uiTrue(s, "inline");
        sec.collapsed = uiTrue(s, "collapsed");
        sec.form = uiTrue(s, "form");
        Access above = inherited;
        if (s["access"].is<const char*>()) inherited = higher(inherited, parseAccess(s["access"].as<const char*>()));
        for (JsonPairConst kv : s["children"].as<JsonObjectConst>()) {
            JsonObjectConst c = kv.value();
            if (skipEntries && isEntry(c)) continue;
            std::string childPath = joinPath(path, kv.key().c_str());
            NodeType t = typeOf(c);
            Item item;
            if (t == NodeType::Object && isElement(ui(c, "widget")) && !uiTrue(c, "page")) {
                item = leaf(kv.key().c_str(), childPath, c, path);
            } else if (t == NodeType::Remote || (t == NodeType::Object && uiTrue(c, "page"))) {
                item = link(kv.key().c_str(), childPath, c, path);
            } else if (t == NodeType::Object) {
                if (uiTrue(c, "card") && level >= 1) {
                    // Nested below a card: its own card instead.
                    Item card = section(kv.key().c_str(), childPath, c, 1, path, promoted);
                    promoted.push_back(std::move(card));
                    continue;
                }
                item = section(kv.key().c_str(), childPath, c, static_cast<uint8_t>(level + 1), path, promoted);
            } else {
                item = leaf(kv.key().c_str(), childPath, c, path);
            }
            (item.advanced ? sec.advancedItems : sec.items).push_back(std::move(item));
        }
        inherited = above;
        if (sec.form) {
            Item* submit = nullptr;
            for (Item& i : sec.items) {
                if (i.kind == ItemKind::Leaf && i.isAction()) {
                    if (i.submit) {
                        submit = &i;
                        break;
                    }
                    if (!submit) submit = &i;
                }
            }
            if (submit) submit->submit = true;
        }
        return sec;
    }
};

bool isEntryNode(JsonObjectConst s);

// Object levels below `s` that its schema expands (-1: unlimited, for a
// custom element). `skipEntries`: without the children that are menu entries.
int depthOf(JsonObjectConst s, bool skipEntries = false) {
    NodeType t = typeOf(s);
    if (t == NodeType::Object && isElement(ui(s, "widget"))) return -1;
    if ((t == NodeType::List || t == NodeType::Array) && !s["items"].isNull()) return depthOf(s["items"]);
    if (t != NodeType::Object || s["children"].isNull()) return 0;
    int d = 0;
    for (JsonPairConst kv : s["children"].as<JsonObjectConst>()) {
        if (skipEntries && isEntryNode(kv.value())) continue;
        int c = depthOf(kv.value());
        if (c < 0) return -1;
        if (c > d) d = c;
    }
    return d + 1;
}

bool shown(JsonObjectConst s) { return !uiTrue(s, "hidden"); }

bool isEntryNode(JsonObjectConst s) {
    NodeType t = typeOf(s);
    return (t == NodeType::Object || t == NodeType::Remote) && shown(s);
}

Access accessOf(JsonObjectConst s) {
    return s["access"].is<const char*>() ? parseAccess(s["access"].as<const char*>()) : Access::None;
}

MenuEntry entry(std::string_view name, std::string_view path, JsonObjectConst s, bool sub, Access above) {
    MenuEntry e;
    e.access = above;
    NodeType t = typeOf(s);
    const char* label = str(s, "label");
    e.label = label ? std::string(label) : t == NodeType::Remote ? std::string(name) : humanize(name);
    e.path = std::string(path);
    if (const char* icon = uiStr(s, "icon")) e.icon = icon;
    if (t == NodeType::Remote) {
        e.remote = true;
        e.online = !(s["online"].is<bool>() && !s["online"].as<bool>());
    }
    // An object that is a page of its own (/sys) or holds remote nodes
    // (/peers) lists its objects, lists and nodes, one level deep.
    if (sub) return e;
    bool anyRemote = false, any = false;
    for (JsonPairConst kv : s["children"].as<JsonObjectConst>()) {
        JsonObjectConst c = kv.value();
        if (isEntry(c) || (typeOf(c) == NodeType::List && shown(c))) {
            any = true;
            if (typeOf(c) == NodeType::Remote) anyRemote = true;
        }
    }
    if (any && (uiTrue(s, "page") || anyRemote)) {
        for (JsonPairConst kv : s["children"].as<JsonObjectConst>()) {
            JsonObjectConst c = kv.value();
            if (isEntry(c) || (typeOf(c) == NodeType::List && shown(c))) {
                e.children.push_back(entry(kv.key().c_str(), joinPath(path, kv.key().c_str()), c, true, higher(above, accessOf(s))));
            }
        }
    }
    return e;
}

bool truthyJson(const std::string& json) {
    return !json.empty() && json != "0" && json != "false" && json != "\"\"" && json != "null";
}

std::string fixed(double v, int decimals) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%.*f", decimals, v);
    return buf;
}

// The shortest text that reads back as `v` (JavaScript's String(v) for
// ordinary magnitudes).
std::string shortest(double v) {
    if (v == 0) return "0";
    char buf[40];
    for (int p = 1; p <= 17; p++) {
        snprintf(buf, sizeof(buf), "%.*g", p, v);
        if (strtod(buf, nullptr) == v) break;
    }
    // Exponents as JavaScript writes them for small numbers stay; plain
    // decimals are what readouts meet.
    return buf;
}

}  // namespace

const char* toString(Access a) {
    switch (a) {
        case Access::Public: return "public";
        case Access::User: return "user";
        case Access::Admin: return "admin";
        default: return "";
    }
}

Access parseAccess(std::string_view s) {
    if (s == "public") return Access::Public;
    if (s == "user") return Access::User;
    if (s == "admin") return Access::Admin;
    return Access::None;
}

const char* toString(Toast t) {
    switch (t) {
        case Toast::Info: return "info";
        case Toast::Ok: return "ok";
        case Toast::Warn: return "warn";
        case Toast::Error: return "error";
        default: return "";
    }
}

Item buildLeaf(std::string_view name, std::string_view path, JsonObjectConst schema, std::string_view parent,
               std::string_view root, Access above) {
    Builder b;
    b.root = std::string(root);
    b.inherited = above;
    return b.leaf(name, path, schema, parent);
}

const char* toString(Widget w) {
    for (const Widgets& x : kWidgets) {
        if (x.widget == w) return x.name;
    }
    return "readout";
}

const char* toString(NodeType t) {
    switch (t) {
        case NodeType::Object: return "object";
        case NodeType::Boolean: return "boolean";
        case NodeType::Integer: return "integer";
        case NodeType::Number: return "number";
        case NodeType::String: return "string";
        case NodeType::Action: return "action";
        case NodeType::Event: return "event";
        case NodeType::Custom: return "custom";
        case NodeType::List: return "list";
        case NodeType::Array: return "array";
        case NodeType::File: return "file";
        case NodeType::Remote: return "remote";
        case NodeType::Any: return "any";
        default: return "";
    }
}

NodeType parseNodeType(std::string_view s) {
    for (uint8_t i = static_cast<uint8_t>(NodeType::Object); i <= static_cast<uint8_t>(NodeType::Any); i++) {
        NodeType t = static_cast<NodeType>(i);
        if (s == toString(t)) return t;
    }
    return NodeType::Unknown;
}

std::string joinPath(std::string_view base, std::string_view name) {
    std::string out(base == "/" ? "" : base);
    out += '/';
    out += name;
    return out;
}

std::string parentPath(std::string_view path) {
    size_t i = path.rfind('/');
    return i == 0 || i == std::string_view::npos ? std::string("/") : std::string(path.substr(0, i));
}

bool isUnder(std::string_view path, std::string_view base) {
    if (base == "/" || path == base) return true;
    return path.size() > base.size() && path.substr(0, base.size()) == base && path[base.size()] == '/';
}

std::string resolvePath(std::string_view path, std::string_view base, std::string_view root) {
    std::vector<std::string_view> out = segments(!path.empty() && path[0] == '/' ? root : base);
    for (std::string_view s : segments(path)) {
        if (s == "..") {
            if (!out.empty()) out.pop_back();
        } else if (s != ".") {
            out.push_back(s);
        }
    }
    std::string p = "/";
    for (std::string_view s : out) p = joinPath(p, s);
    return p;
}

std::vector<Condition> parseConditions(std::string_view text, std::string_view base, std::string_view root) {
    std::vector<Condition> out;
    for (std::string_view part : split(text, '&')) {
        part = trim(part);
        size_t i = 0;
        while (i < part.size() && part[i] != '!' && part[i] != '=' && part[i] != ' ' && part[i] != '\t') i++;
        if (i == 0) continue;
        std::string_view path = part.substr(0, i);
        std::string_view rest = trim(part.substr(i));
        Condition c;
        if (rest.size() >= 2 && rest[0] == '!' && rest[1] == '=') {
            c.equal = false;
            rest.remove_prefix(2);
        } else if (!rest.empty() && rest[0] == '=') {
            rest.remove_prefix(1);
        } else {
            continue;
        }
        c.path = resolvePath(path, base, root);
        c.literal = std::string(trim(rest));
        out.push_back(std::move(c));
    }
    return out;
}

bool holds(const Condition& c, JsonVariantConst value) {
    if (value.isUnbound()) return false;
    std::string json;
    serializeJson(value, json);
    bool match = json == c.literal || (value.is<const char*>() && c.literal == value.as<const char*>());
    return match == c.equal;
}

bool isEntry(JsonObjectConst s) { return isEntryNode(s); }

bool hasOwnItems(JsonObjectConst s) {
    for (JsonPairConst kv : s["children"].as<JsonObjectConst>()) {
        JsonObjectConst c = kv.value();
        if (!isEntry(c) && shown(c) && typeOf(c) != NodeType::Custom) return true;
    }
    return false;
}

JsonObjectConst schemaAt(JsonObjectConst root, std::string_view path) {
    JsonObjectConst s = root;
    for (std::string_view name : segments(path)) {
        s = s["children"][std::string(name)];
        if (s.isNull()) break;
    }
    return s;
}

Page buildPage(JsonObjectConst s, std::string_view path, std::string_view root, bool menu, Access above) {
    Builder b;
    b.root = std::string(root);
    b.inherited = above;
    Page page;
    page.path = std::string(path);
    std::string_view last = lastSegment(path);
    if (const char* label = str(s, "label")) {
        page.label = label;
    } else if (path == "/") {
        page.label = "Device";
    } else {
        page.label = root == path ? std::string(last) : humanize(last);
    }
    page.depth = depthOf(s, menu);

    NodeType t = typeOf(s);
    // A page drawn by a custom element, or a list's: one card, under the
    // page's title.
    if (isElement(ui(s, "widget")) || t == NodeType::List || t == NodeType::Array) {
        Item leaf = b.leaf(last.empty() ? std::string_view("root") : last, path, s, parentPath(path));
        leaf.label.clear();
        Item card;
        card.kind = ItemKind::Section;
        card.schemaType = NodeType::Object;
        card.path = std::string(path);
        card.level = 1;
        card.items.push_back(std::move(leaf));
        page.cards.push_back(std::move(card));
        return page;
    }
    std::vector<Item> promoted;
    // A form, tabs or an inline group stays one card, as on its parent's page.
    if (path != root && (uiTrue(s, "form") || uiTrue(s, "tabs") || uiTrue(s, "inline"))) {
        Item card = b.section(last, path, s, 1, parentPath(path), promoted);
        card.label.clear();
        card.icon.clear();
        page.cards.push_back(std::move(card));
        for (Item& p : promoted) page.cards.push_back(std::move(p));
        return page;
    }
    // Values directly under the page form a first, untitled card; each child
    // object is a card (advanced ones start collapsed); remote nodes get a
    // card of their own.
    Item top = b.section("", path, s, 0, path, promoted, menu);
    top.tabs = top.inlined = top.form = false;
    Item first;
    first.kind = ItemKind::Section;
    first.schemaType = NodeType::Object;
    first.path = top.path;
    first.level = 1;
    first.advanced = top.advanced;
    first.hidden = top.hidden;
    first.access = top.access;
    first.visibleWhen = top.visibleWhen;
    first.enabledWhen = top.enabledWhen;
    first.lazy = top.lazy;
    first.collapsed = top.collapsed;
    Item nodes = first;
    nodes.label = "Nodes";

    std::vector<Item> all;
    for (Item& i : top.items) all.push_back(std::move(i));
    for (Item& i : top.advancedItems) all.push_back(std::move(i));
    for (Item& item : all) {
        if (item.kind == ItemKind::Section) {
            if (item.advanced) item.collapsed = true;
            std::string at = item.path;
            page.cards.push_back(std::move(item));
            // Cards promoted with ui.card follow the card they come from.
            for (const Item& p : promoted) {
                if (isUnder(p.path, at)) page.cards.push_back(p);
            }
        } else if (item.kind == ItemKind::Link && item.remote) {
            nodes.items.push_back(std::move(item));
        } else if (item.kind == ItemKind::Leaf && (item.widget == Widget::List || item.widget == Widget::Table) &&
                   !item.advanced) {
            // A list is a card of its own, titled by it.
            Item card = first;
            card.items.clear();
            card.advancedItems.clear();
            card.path = item.path;
            card.label = item.label;
            item.label.clear();
            card.items.push_back(std::move(item));
            page.cards.push_back(std::move(card));
        } else if (item.kind == ItemKind::Leaf && item.widget == Widget::Button && !truthyJson(item.value) &&
                   !item.advanced && !item.hidden && item.visibleWhen.empty()) {
            page.actions.push_back(std::move(item));
        } else {
            (item.advanced ? first.advancedItems : first.items).push_back(std::move(item));
        }
    }
    auto anyShown = [](const std::vector<Item>& items) {
        for (const Item& i : items) {
            if (!i.hidden) return true;
        }
        return false;
    };
    // Hidden values are read, never shown. Only advanced values left: a
    // collapsed card of them, last.
    if (!anyShown(first.items) && !first.advancedItems.empty()) {
        Item adv = first;
        adv.label = "Advanced";
        adv.collapsed = true;
        adv.items = std::move(adv.advancedItems);
        adv.advancedItems.clear();
        page.cards.push_back(std::move(adv));
    } else if (anyShown(first.items) || anyShown(first.advancedItems)) {
        page.cards.insert(page.cards.begin(), std::move(first));
    }
    if (!nodes.items.empty()) page.cards.push_back(std::move(nodes));

    // Subscribe to everything shown except mirrored remote nodes, whose
    // copies would come along, and sub-pages, which subscribe themselves.
    size_t valuedChildren = 0;
    std::vector<std::string> read;
    for (JsonPairConst kv : s["children"].as<JsonObjectConst>()) {
        JsonObjectConst c = kv.value();
        if (!valued(c)) continue;
        valuedChildren++;
        NodeType ct = typeOf(c);
        if (ct == NodeType::Remote && c["mirror"].as<bool>()) continue;
        if (ct == NodeType::Object && uiTrue(c, "page")) continue;
        if (menu && isEntry(c)) continue;
        read.push_back(kv.key().c_str());
    }
    if (read.size() < valuedChildren) {
        page.hasKeys = true;
        for (size_t i = 0; i < read.size(); i++) {
            if (i) page.keys += ',';
            page.keys += read[i];
        }
    }
    return page;
}

std::vector<MenuEntry> buildMenu(JsonObjectConst s, std::string_view home) {
    std::vector<MenuEntry> out;
    if (hasOwnItems(s)) {
        MenuEntry status;
        status.label = "Status";
        status.icon = "home";
        status.path = std::string(home);
        status.access = accessOf(s);
        out.push_back(std::move(status));
    }
    // ui.group gathers entries under a heading, where its first one would be.
    std::vector<std::pair<std::string, size_t>> groups;
    for (JsonPairConst kv : s["children"].as<JsonObjectConst>()) {
        JsonObjectConst c = kv.value();
        if (!isEntry(c)) continue;
        MenuEntry e = entry(kv.key().c_str(), joinPath(home, kv.key().c_str()), c, false, accessOf(s));
        const char* group = uiStr(c, "group");
        if (!nonEmpty(group)) {
            out.push_back(std::move(e));
            continue;
        }
        size_t at = out.size();
        bool found = false;
        for (auto& g : groups) {
            if (g.first == group) {
                at = g.second;
                found = true;
            }
        }
        if (!found) {
            MenuEntry heading;
            heading.label = group;
            out.push_back(std::move(heading));
            groups.emplace_back(group, at);
        }
        out[at].children.push_back(std::move(e));
    }
    return out;
}

// ---- Formatting -------------------------------------------------------

std::string humanize(std::string_view name) {
    // "aB" -> "a B"
    std::string a;
    for (size_t i = 0; i < name.size(); i++) {
        char c = name[i];
        a += c;
        if ((isLower(c) || isDigit(c)) && i + 1 < name.size() && isUpper(name[i + 1])) {
            a += ' ';
            a += name[++i];
        }
    }
    // "HTTPPort" -> "HTTP Port": a run of capitals before a capitalized word.
    std::string b;
    for (size_t i = 0; i < a.size();) {
        if (!isUpper(a[i])) {
            b += a[i++];
            continue;
        }
        size_t j = i;
        while (j < a.size() && isUpper(a[j])) j++;
        if (j - i >= 2 && j < a.size() && isLower(a[j])) {
            b.append(a, i, j - 1 - i);
            b += ' ';
            b.append(a, j - 1, 2);
            i = j + 1;
        } else {
            b.append(a, i, j - i);
            i = j;
        }
    }
    // Words: all-caps ones stay (acronyms), others are lowercased.
    std::string out;
    size_t i = 0;
    while (i < b.size()) {
        while (i < b.size() && (b[i] == ' ' || b[i] == '\t' || b[i] == '_' || b[i] == '.' || b[i] == '-')) i++;
        size_t j = i;
        while (j < b.size() && !(b[j] == ' ' || b[j] == '\t' || b[j] == '_' || b[j] == '.' || b[j] == '-')) j++;
        if (j == i) break;
        std::string w = b.substr(i, j - i);
        bool caps = true;
        for (char c : w) {
            if (isLower(c)) caps = false;
        }
        if (!(w.size() > 1 && caps)) {
            for (char& c : w) {
                if (isUpper(c)) c = static_cast<char>(c - 'A' + 'a');
            }
        }
        if (!out.empty()) out += ' ';
        out += w;
        i = j;
    }
    if (!out.empty() && isLower(out[0])) out[0] = static_cast<char>(out[0] - 'a' + 'A');
    return out;
}

int decimalsOf(double step) {
    if (step == 0) return 0;
    // Within float precision: ArduinoJson may keep a parsed number as a
    // float (0.01 reads back as 0.0099999998).
    double a = fabs(step);
    for (int p = 0; p < 12; p++) {
        if (fabs(strtod(fixed(a, p).c_str(), nullptr) - a) <= a * 1e-6) return p;
    }
    return 12;
}

std::string formatBytes(int64_t n) {
    char buf[32];
    int64_t a = n < 0 ? -n : n;
    if (a < 1024) {
        snprintf(buf, sizeof(buf), "%lld B", static_cast<long long>(n));
    } else if (a < 1048576) {
        snprintf(buf, sizeof(buf), "%.1f KB", static_cast<double>(n) / 1024);
    } else {
        snprintf(buf, sizeof(buf), "%.2f MB", static_cast<double>(n) / 1048576);
    }
    return buf;
}

std::string formatDuration(int64_t n) {
    static const struct {
        int64_t seconds;
        const char* name;
    } units[] = {{86400, "d"}, {3600, "h"}, {60, "min"}, {1, "s"}};
    int64_t a = n < 0 ? -n : n;
    int i = 0;
    while (i < 4 && a < units[i].seconds) i++;
    char buf[48];
    if (i >= 3) {
        snprintf(buf, sizeof(buf), "%lld s", static_cast<long long>(n));
        return buf;
    }
    int64_t whole = n / units[i].seconds;
    int64_t rest = (n % units[i].seconds) / units[i + 1].seconds;
    if (rest) {
        snprintf(buf, sizeof(buf), "%lld %s %lld %s", static_cast<long long>(whole), units[i].name,
                 static_cast<long long>(rest), units[i + 1].name);
    } else {
        snprintf(buf, sizeof(buf), "%lld %s", static_cast<long long>(whole), units[i].name);
    }
    return buf;
}

std::string printfValue(std::string_view format, JsonVariantConst v) {
    std::string out;
    double n = v.as<double>();
    for (size_t i = 0; i < format.size(); i++) {
        char c = format[i];
        if (c != '%' || i + 1 >= format.size()) {
            out += c;
            continue;
        }
        size_t j = i + 1;
        int precision = -1;
        if (format[j] == '.') {
            size_t k = j + 1;
            int p = 0;
            bool digits = false;
            while (k < format.size() && isDigit(format[k])) {
                p = p * 10 + (format[k] - '0');
                k++;
                digits = true;
            }
            if (!digits) {
                out += c;
                continue;
            }
            precision = p;
            j = k;
        }
        if (j >= format.size()) {
            out += c;
            continue;
        }
        char conv = format[j];
        char buf[64];
        switch (conv) {
            case '%':
                if (precision >= 0) {
                    out += c;
                    continue;
                }
                out += '%';
                break;
            case 'd':
            case 'i':
                if (v.is<int64_t>()) {
                    snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v.as<int64_t>()));
                } else if (v.is<uint64_t>()) {
                    snprintf(buf, sizeof(buf), "%llu", static_cast<unsigned long long>(v.as<uint64_t>()));
                } else {
                    snprintf(buf, sizeof(buf), "%.0f", trunc(n));
                }
                out += buf;
                break;
            case 'u':
                if (v.is<uint64_t>()) {
                    snprintf(buf, sizeof(buf), "%llu", static_cast<unsigned long long>(v.as<uint64_t>()));
                } else {
                    snprintf(buf, sizeof(buf), "%u", static_cast<unsigned>(static_cast<uint32_t>(static_cast<int64_t>(trunc(n)))));
                }
                out += buf;
                break;
            case 'f':
                out += fixed(n, precision < 0 ? 6 : precision);
                break;
            case 'e':
                snprintf(buf, sizeof(buf), "%.*e", precision < 0 ? 6 : precision, n);
                out += buf;
                break;
            case 'g':
                snprintf(buf, sizeof(buf), "%.*g", precision <= 0 ? 6 : precision, n);
                out += shortest(strtod(buf, nullptr));
                break;
            case 's':
                if (v.is<const char*>()) {
                    out += v.as<const char*>();
                } else {
                    std::string json;
                    serializeJson(v, json);
                    out += json;
                }
                break;
            default:
                out.append(format.substr(i, j - i + 1));
                break;
        }
        i = j;
    }
    return out;
}

std::string formatNumber(double v, const Item& leaf) {
    std::string text;
    if (leaf.precision >= 0) {
        text = fixed(v, leaf.precision);
    } else if (v == floor(v) && fabs(v) < 1e15) {
        text = fixed(v, 0);
    } else {
        // Up to 3 decimals, trailing zeros dropped.
        text = fixed(v, 3);
        while (!text.empty() && text.back() == '0') text.pop_back();
        if (!text.empty() && text.back() == '.') text.pop_back();
        if (text == "-0") text = "0";
    }
    return leaf.unit.empty() ? text : text + " " + leaf.unit;
}

std::string formatValue(JsonVariantConst v, const Item& leaf) {
    if (v.isUnbound()) return "\xE2\x80\x93";  // –
    if (v.isNull()) return "null";
    if (!leaf.format.empty()) return printfValue(leaf.format, v);
    bool integer = v.is<int64_t>() || v.is<uint64_t>();
    if (integer && (leaf.unit == "B" || leaf.unit == "s")) {
        int64_t n = v.as<int64_t>();
        return leaf.unit == "B" ? formatBytes(n) : formatDuration(n);
    }
    std::string text;
    if (integer && leaf.precision <= 0) {
        char buf[32];
        if (v.is<int64_t>()) {
            snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v.as<int64_t>()));
        } else {
            snprintf(buf, sizeof(buf), "%llu", static_cast<unsigned long long>(v.as<uint64_t>()));
        }
        text = buf;
    } else if (v.is<double>()) {
        Item plain = leaf;
        plain.unit.clear();
        text = formatNumber(v.as<double>(), plain);
    } else if (v.is<bool>()) {
        text = v.as<bool>() ? "true" : "false";
    } else if (v.is<const char*>()) {
        text = v.as<const char*>();
    } else {
        serializeJson(v, text);
    }
    return leaf.unit.empty() ? text : text + " " + leaf.unit;
}

}  // namespace model
}  // namespace tesserui
