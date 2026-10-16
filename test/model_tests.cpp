// The LVGL renderer's model (src/tesserui/model.h) against the golden models
// of fixtures/ (docs/DESIGN.md section 11): what the web renderer's model
// gives for each fixture, less the fields this one doesn't keep.
#include <stdio.h>

#include <string>

#include <ArduinoJson.h>

#include "check.h"
#include "tesserui/model.h"

using namespace tesserui::model;

namespace {

std::string readFile(const std::string& path) {
    std::string out;
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return out;
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
    fclose(f);
    return out;
}

std::string fixturePath(const char* name) { return std::string(TESSERUI_FIXTURES_DIR) + "/" + name; }

void conditions(JsonObject o, const char* key, const std::vector<Condition>& conds) {
    if (conds.empty()) return;
    JsonArray a = o[key].to<JsonArray>();
    for (const Condition& c : conds) {
        JsonObject x = a.add<JsonObject>();
        x["path"] = c.path;
        x["equal"] = c.equal;
        x["literal"] = c.literal;
    }
}

void write(JsonObject o, const Item& i);

void items(JsonObject o, const char* key, const std::vector<Item>& list) {
    JsonArray a = o[key].to<JsonArray>();
    for (const Item& i : list) write(a.add<JsonObject>(), i);
}

// The model as model.ts writes it, under its keys and presence rules.
void write(JsonObject o, const Item& i) {
    o["name"] = i.name;
    o["path"] = i.path;
    o["label"] = i.label;
    o["advanced"] = i.advanced;
    o["hidden"] = i.hidden;
    if (!i.icon.empty()) o["icon"] = i.icon;
    conditions(o, "visibleWhen", i.visibleWhen);
    conditions(o, "enabledWhen", i.enabledWhen);
    switch (i.kind) {
        case ItemKind::Section:
            o["kind"] = "section";
            o["level"] = i.level;
            items(o, "items", i.items);
            items(o, "advancedItems", i.advancedItems);
            o["lazy"] = i.lazy;
            o["tabs"] = i.tabs;
            o["inline"] = i.inlined;
            o["collapsed"] = i.collapsed;
            o["form"] = i.form;
            return;
        case ItemKind::Link:
            o["kind"] = "link";
            o["remote"] = i.remote;
            o["online"] = i.online;
            return;
        case ItemKind::Leaf:
            break;
    }
    o["kind"] = "leaf";
    o["widget"] = i.widget == Widget::Element ? i.element.c_str() : toString(i.widget);
    o["type"] = toString(i.type);
    o["editable"] = i.editable;
    if (i.hasMin) o["min"] = i.min;
    if (i.hasMax) o["max"] = i.max;
    if (i.hasStep) o["step"] = i.step;
    if (i.precision >= 0) o["precision"] = i.precision;
    if (i.maxLength) o["maxLength"] = i.maxLength;
    if (!i.unit.empty()) o["unit"] = i.unit;
    if (!i.format.empty()) o["format"] = i.format;
    if (!i.placeholder.empty()) o["placeholder"] = i.placeholder;
    if (!i.confirm.empty()) o["confirm"] = i.confirm;
    if (!i.style.empty()) o["style"] = i.style;
    if (!i.returns.empty()) o["returns"] = i.returns;
    if (!i.value.empty()) {
        JsonDocument v;
        deserializeJson(v, i.value);
        o["value"] = v.as<JsonVariantConst>();
    }
    if (i.hasOptions) {
        JsonArray a = o["options"].to<JsonArray>();
        for (const Option& opt : i.options) {
            JsonObject x = a.add<JsonObject>();
            x["value"] = opt.value;
            x["label"] = opt.label;
        }
    }
    if (i.secret) o["secret"] = true;
    if (i.keepalive) o["keepalive"] = i.keepalive;
    if (i.hasField) o["field"] = toString(i.field);
    if (i.isAction() && i.widget != Widget::Element) {
        o["deferred"] = i.deferred;
        o["submit"] = i.submit;
    }
}

void write(JsonObject o, const Page& p) {
    o["path"] = p.path;
    o["label"] = p.label;
    JsonArray cards = o["cards"].to<JsonArray>();
    for (const Item& c : p.cards) write(cards.add<JsonObject>(), c);
    JsonArray actions = o["actions"].to<JsonArray>();
    for (const Item& a : p.actions) write(actions.add<JsonObject>(), a);
    if (p.depth < 0) {
        o["depth"] = nullptr;
    } else {
        o["depth"] = p.depth;
    }
    if (p.hasKeys) o["keys"] = p.keys;
}

void write(JsonArray a, const std::vector<MenuEntry>& entries) {
    for (const MenuEntry& e : entries) {
        JsonObject o = a.add<JsonObject>();
        o["label"] = e.label;
        if (!e.icon.empty()) o["icon"] = e.icon;
        if (!e.path.empty()) o["href"] = "#" + e.path;
        if (e.remote) o["online"] = e.online;
        if (!e.children.empty()) write(o["children"].to<JsonArray>(), e.children);
    }
}

// Fields of the web model this one doesn't keep: help text (hidden on small
// screens, section 4), widgets it doesn't draw yet, access levels.
const char* const kDropped[] = {"description", "script",   "history", "toast",    "maxSize",     "columns",
                                "optionsFrom", "optionsValue", "fixed", "reorder", "access",      "readable",
                                "contentType", "lines",    "params",  "schemaHash"};

void project(JsonVariant v) {
    if (v.is<JsonObject>()) {
        JsonObject o = v.as<JsonObject>();
        for (const char* k : kDropped) o.remove(k);
        for (JsonPair kv : o) project(kv.value());
    } else if (v.is<JsonArray>()) {
        for (JsonVariant x : v.as<JsonArray>()) project(x);
    }
}

// View pages aren't in this model yet (section 8).
void dropViews(JsonArray menu) {
    for (size_t i = menu.size(); i-- > 0;) {
        const char* href = menu[i]["href"];
        if (href && (strstr(href, "#/v/") || strstr(href, "/_ui/"))) menu.remove(i);
    }
}

// Deep equality, object keys in any order; `why` says where they differ.
bool same(JsonVariantConst a, JsonVariantConst b, const std::string& at, std::string& why) {
    if (a.is<JsonObjectConst>() && b.is<JsonObjectConst>()) {
        JsonObjectConst x = a, y = b;
        for (JsonPairConst kv : x) {
            if (!y[kv.key()].isUnbound()) continue;
            why = at + "." + kv.key().c_str() + ": only in ours";
            return false;
        }
        for (JsonPairConst kv : y) {
            std::string sub = at + "." + kv.key().c_str();
            if (x[kv.key()].isUnbound()) {
                why = sub + ": only in the golden model";
                return false;
            }
            if (!same(x[kv.key()], kv.value(), sub, why)) return false;
        }
        return true;
    }
    if (a.is<JsonArrayConst>() && b.is<JsonArrayConst>()) {
        JsonArrayConst x = a, y = b;
        if (x.size() != y.size()) {
            why = at + ": " + std::to_string(x.size()) + " elements, golden " + std::to_string(y.size());
            return false;
        }
        for (size_t i = 0; i < x.size(); i++) {
            std::string sub = at + "[" + std::to_string(i) + "]";
            if (x[i]["path"].is<const char*>()) sub += "(" + std::string(x[i]["path"].as<const char*>()) + ")";
            if (!same(x[i], y[i], sub, why)) return false;
        }
        return true;
    }
    bool equal;
    if (a.is<double>() && b.is<double>()) {
        equal = a.as<double>() == b.as<double>();
    } else {
        std::string sa, sb;
        serializeJson(a, sa);
        serializeJson(b, sb);
        equal = sa == sb;
    }
    if (!equal) {
        std::string sa, sb;
        serializeJson(a, sa);
        serializeJson(b, sb);
        why = at + ": " + sa + ", golden " + sb;
    }
    return equal;
}

void golden(const char* name) {
    JsonDocument fixture, expected;
    DeserializationError err = deserializeJson(fixture, readFile(fixturePath((std::string(name) + ".json").c_str())),
                                               DeserializationOption::NestingLimit(64));
    if (err) check::fail(__FILE__, __LINE__, std::string(name) + ".json: " + err.c_str());
    err = deserializeJson(expected, readFile(fixturePath((std::string(name) + ".model.json").c_str())),
                          DeserializationOption::NestingLimit(64));
    if (err) check::fail(__FILE__, __LINE__, std::string(name) + ".model.json: " + err.c_str());
    JsonObjectConst schema = fixture["schema"];
    project(expected.as<JsonVariant>());
    // Views (section 8) aren't in this model yet.
    expected.remove("views");
    dropViews(expected["menu"]);

    JsonDocument ours;
    write(ours["page"].to<JsonObject>(), buildPage(schema, "/"));
    std::vector<MenuEntry> menu = buildMenu(schema, "/");
    write(ours["menu"].to<JsonArray>(), menu);
    JsonObject pages = ours["pages"].to<JsonObject>();
    for (JsonPairConst kv : expected["pages"].as<JsonObjectConst>()) {
        std::string path = kv.key().c_str();
        JsonObjectConst s = path == "/" ? schema : schemaAt(schema, path);
        write(pages[path].to<JsonObject>(), buildPage(s, path, "/", path == "/"));
    }
    std::string why;
    if (!same(ours.as<JsonVariantConst>(), expected.as<JsonVariantConst>(), "", why)) {
        check::fail(__FILE__, __LINE__, std::string(name) + why);
    }
}

}  // namespace

TEST(model_golden_testfw) { golden("testfw"); }
TEST(model_golden_demo) { golden("demo"); }
TEST(model_golden_motors) { golden("motors"); }

TEST(model_humanize) {
    CHECK_EQ(humanize("brightnessMax"), "Brightness max");
    CHECK_EQ(humanize("pid_kp"), "Pid kp");
    CHECK_EQ(humanize("uptimeMs"), "Uptime ms");
    CHECK_EQ(humanize("HTTPPort"), "HTTP port");
    CHECK_EQ(humanize("ch1"), "Ch1");
    CHECK_EQ(humanize("tesser-f37c"), "Tesser f37c");
    CHECK_EQ(humanize(""), "");
}

TEST(model_decimals) {
    CHECK_EQ(decimalsOf(0.01), 2);
    CHECK_EQ(decimalsOf(5), 0);
    CHECK_EQ(decimalsOf(1e-7), 7);
    CHECK_EQ(decimalsOf(0.25), 2);
}

TEST(model_format) {
    JsonDocument d;
    deserializeJson(d, R"({"i":42,"f":12.5,"g":0.123456,"two":2.0,"big":18446744073709551615,"b":1536,"s":3725,"n":-1})");
    Item percent;
    percent.type = NodeType::Integer;
    percent.unit = "%";
    CHECK_EQ(formatValue(d["i"], percent), "42 %");
    Item celsius;
    celsius.type = NodeType::Number;
    celsius.unit = "\xC2\xB0" "C";
    celsius.precision = 1;
    CHECK_EQ(formatValue(d["f"], celsius), "12.5 \xC2\xB0" "C");
    Item plain;
    plain.type = NodeType::Number;
    CHECK_EQ(formatValue(d["g"], plain), "0.123");
    CHECK_EQ(formatValue(d["two"], plain), "2");
    CHECK_EQ(formatValue(d["missing"], plain), "\xE2\x80\x93");
    CHECK_EQ(formatValue(d["big"], plain), "18446744073709551615");
    Item bytes;
    bytes.unit = "B";
    CHECK_EQ(formatValue(d["b"], bytes), "1.5 KB");
    Item seconds;
    seconds.unit = "s";
    CHECK_EQ(formatValue(d["s"], seconds), "1 h 2 min");
    CHECK_EQ(formatDuration(59), "59 s");
    CHECK_EQ(formatDuration(90061), "1 d 1 h");
    CHECK_EQ(formatBytes(2031616), "1.94 MB");
}

TEST(model_printf) {
    JsonDocument d;
    deserializeJson(d, R"({"p":1013.4,"d":41.9,"e":12345,"s":"hi","u":-1,"g":0.5})");
    CHECK_EQ(printfValue("%.0f hPa", d["p"]), "1013 hPa");
    CHECK_EQ(printfValue("%d%%", d["d"]), "41%");
    CHECK_EQ(printfValue("%.2e", d["e"]), "1.23e+04");
    CHECK_EQ(printfValue("%s!", d["s"]), "hi!");
    CHECK_EQ(printfValue("%u", d["u"]), "4294967295");
    CHECK_EQ(printfValue("%g", d["g"]), "0.5");
}

TEST(model_conditions) {
    CHECK_EQ(resolvePath("mode", "/config", "/"), "/config/mode");
    CHECK_EQ(resolvePath("../config/enabled", "/lamp", "/"), "/config/enabled");
    CHECK_EQ(resolvePath("../dhcp", "/config/network/deep", "/"), "/config/network/dhcp");
    CHECK_EQ(resolvePath("/config/mode", "/a/b", "/"), "/config/mode");
    CHECK_EQ(resolvePath("/config/mode", "/peers/p/a", "/peers/p"), "/peers/p/config/mode");

    JsonDocument d;
    deserializeJson(d, R"({"mode":"manual","enabled":true,"n":3,"x":null})");
    auto all = [&](const char* text) {
        for (const Condition& c : parseConditions(text, "/", "/")) {
            if (!holds(c, d[c.path.substr(1)])) return false;
        }
        return true;
    };
    CHECK(all("mode=manual"));
    CHECK(all("mode=\"manual\""));
    CHECK(!all("mode!=manual"));
    CHECK(all("enabled=true&n=3"));
    CHECK(!all("enabled=true&n!=3"));
    CHECK(all("/x=null"));
    CHECK(!all("missing=1"));
    CHECK(!all("missing!=1"));
}
