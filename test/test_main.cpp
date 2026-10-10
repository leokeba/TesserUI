// Host test runner: ./tesserui_tests [filter]
#include <string>

#include "TesserAPI.h"
#include "check.h"
#include "tesserui/views.h"
#include "tesserui/web_page.h"

namespace {

using tesser::Api;
using tesser::Status;

struct Resp {
    Status status;
    std::string body;
};

// A request through the real request handler, as transports issue it.
Resp request(Api& api, tesser::Op op, const char* path, const char* body = nullptr,
             tesser::Query q = tesser::Query()) {
    JsonDocument doc;
    tesser::Request req;
    req.op = op;
    req.path = path;
    req.query = q;
    if (body) {
        if (deserializeJson(doc, body)) return {Status::Internal, std::string("test body is not JSON: ") + body};
        req.body = doc.as<JsonVariantConst>();
    }
    tesser::StringReply reply;
    api.handle(req, reply);
    if (!reply.begun || !reply.ended) return {Status::Internal, "reply not completed"};
    return {reply.status, reply.body};
}

Resp get(Api& api, const char* path, tesser::Query q = tesser::Query()) {
    return request(api, tesser::Op::Get, path, nullptr, q);
}

std::string ui(Api& api) {
    Resp r = get(api, "/_ui");
    CHECK(r.status == Status::Ok);
    return r.body;
}

std::string written(const tesserui::Views& views) {
    std::string out;
    tesser::StringSink sink(out);
    tesser::JsonWriter w(sink);
    views.write(w);
    return out;
}

}  // namespace

// ---- Views ---------------------------------------------------------------

TEST(views_empty) {
    Api api;
    tesserui::Views views(api);
    CHECK_EQ(ui(api), "{\"pages\":[]}");
}

// The example of docs/DESIGN.md section 8, byte for byte.
TEST(views_design_example) {
    Api api;
    tesserui::Views views(api);
    auto& field = views.page("field", "Field");
    field.each("/peers", "$/heliostat/status");
    field.row().widget("gauge", "/sensors/wind").widget("readout", "/sensors/sun/elevation");
    field.card("Calibration").node("/calib");
    CHECK_EQ(ui(api),
             "{\"pages\":[{\"id\":\"field\",\"label\":\"Field\",\"items\":["
             "{\"each\":\"/peers\",\"item\":{\"node\":\"$/heliostat/status\"}},"
             "{\"row\":[{\"widget\":\"gauge\",\"path\":\"/sensors/wind\"},"
             "{\"widget\":\"readout\",\"path\":\"/sensors/sun/elevation\"}]},"
             "{\"card\":\"Calibration\",\"items\":[{\"node\":\"/calib\"}]}]}]}");
}

TEST(views_every_item_kind) {
    Api api;
    tesserui::Views views(api);
    auto& p = views.page("all", "All");
    p.node("/lamp");
    p.widget("gauge", "/lamp/power", "Power");
    p.widget("readout", "/lamp/level");
    p.text("Plain text, **bold** is the only markup.");
    p.each("/peers", "$/lamp/on");
    p.row().node("/a").node("/b");
    p.card("Card").text("inside");
    CHECK_EQ(ui(api),
             "{\"pages\":[{\"id\":\"all\",\"label\":\"All\",\"items\":["
             "{\"node\":\"/lamp\"},"
             "{\"widget\":\"gauge\",\"path\":\"/lamp/power\",\"label\":\"Power\"},"
             "{\"widget\":\"readout\",\"path\":\"/lamp/level\"},"
             "{\"text\":\"Plain text, **bold** is the only markup.\"},"
             "{\"each\":\"/peers\",\"item\":{\"node\":\"$/lamp/on\"}},"
             "{\"row\":[{\"node\":\"/a\"},{\"node\":\"/b\"}]},"
             "{\"card\":\"Card\",\"items\":[{\"text\":\"inside\"}]}]}]}");
    CHECK_EQ(p.size(), size_t(7));
}

TEST(views_hint_types) {
    Api api;
    tesserui::Views views(api);
    auto& p = views.page("p", "P");
    p.widget("gauge", "/sensors/wind", "Wind")
        .hint("max", 30)
        .hint("unit", "m/s")
        .hint("precision", 1.5)
        .hint("advanced", true)
        .hint("readonly", false)
        .hint("small", 0.1f)
        .hint("big", 4000000000u)
        .hint("neg", -2);
    CHECK_EQ(ui(api),
             "{\"pages\":[{\"id\":\"p\",\"label\":\"P\",\"items\":["
             "{\"widget\":\"gauge\",\"path\":\"/sensors/wind\",\"label\":\"Wind\",\"max\":30,\"unit\":\"m/s\","
             "\"precision\":1.5,\"advanced\":true,\"readonly\":false,\"small\":0.100000001490116,"
             "\"big\":4000000000,\"neg\":-2}]}]}");
}

TEST(views_hint_replaces_key) {
    Api api;
    tesserui::Views views(api);
    auto& p = views.page("p");
    p.node("/x").hint("widget", "bar").hint("max", 10).hint("widget", 3).hint("max", "ten");
    CHECK_EQ(ui(api), "{\"pages\":[{\"id\":\"p\",\"items\":[{\"node\":\"/x\",\"widget\":3,\"max\":\"ten\"}]}]}");
}

TEST(views_hint_applies_to_last_item) {
    Api api;
    tesserui::Views views(api);
    auto& p = views.page("p");
    p.hint("ignored", 1);  // no item yet
    p.node("/a").node("/b").hint("label", "B");
    p.row().node("/c").hint("in", true);
    p.hint("on", "row");  // the row is the page's last item
    p.card("K").node("/d");
    p.hint("collapsed", true);
    p.each("/peers", "$/lamp/on").hint("widget", "led").hint("label", "Lamp");
    CHECK_EQ(ui(api),
             "{\"pages\":[{\"id\":\"p\",\"items\":["
             "{\"node\":\"/a\"},{\"node\":\"/b\",\"label\":\"B\"},"
             "{\"row\":[{\"node\":\"/c\",\"in\":true}],\"on\":\"row\"},"
             "{\"card\":\"K\",\"items\":[{\"node\":\"/d\"}],\"collapsed\":true},"
             "{\"each\":\"/peers\",\"item\":{\"node\":\"$/lamp/on\",\"widget\":\"led\",\"label\":\"Lamp\"}}]}]}");
}

TEST(views_nesting) {
    Api api;
    tesserui::Views views(api);
    auto& p = views.page("deep", "Deep");
    auto& card = p.card("Outer");
    auto& row = card.row();
    row.card("Left").node("/l").row().widget("led", "/on").widget("readout", "/t");
    row.card("Right").text("r");
    card.node("/after");
    CHECK_EQ(ui(api),
             "{\"pages\":[{\"id\":\"deep\",\"label\":\"Deep\",\"items\":["
             "{\"card\":\"Outer\",\"items\":["
             "{\"row\":["
             "{\"card\":\"Left\",\"items\":[{\"node\":\"/l\"},"
             "{\"row\":[{\"widget\":\"led\",\"path\":\"/on\"},{\"widget\":\"readout\",\"path\":\"/t\"}]}]},"
             "{\"card\":\"Right\",\"items\":[{\"text\":\"r\"}]}]},"
             "{\"node\":\"/after\"}]}]}]}");
}

TEST(views_several_pages) {
    Api api;
    tesserui::Views views(api);
    auto& a = views.page("a", "A");
    auto& b = views.page("b", "B");
    CHECK(&views.page("a", "ignored") == &a);
    CHECK_EQ(a.id(), "a");
    CHECK_EQ(b.label(), "B");
    b.node("/b");
    a.node("/a");
    CHECK_EQ(ui(api),
             "{\"pages\":[{\"id\":\"a\",\"label\":\"A\",\"items\":[{\"node\":\"/a\"}]},"
             "{\"id\":\"b\",\"label\":\"B\",\"items\":[{\"node\":\"/b\"}]}]}");
}

TEST(views_null_strings) {
    Api api;
    tesserui::Views views(api);
    auto& p = views.page("p");
    p.node(nullptr).hint("s", static_cast<const char*>(nullptr));
    p.card(nullptr).text(nullptr);
    CHECK_EQ(ui(api),
             "{\"pages\":[{\"id\":\"p\",\"items\":[{\"node\":null,\"s\":null},"
             "{\"card\":\"\",\"items\":[{\"text\":null}]}]}]}");
}

TEST(views_text_is_escaped) {
    Api api;
    tesserui::Views views(api);
    views.page("p").text("say \"hi\"\n\\ 25 °C");
    CHECK_EQ(ui(api), "{\"pages\":[{\"id\":\"p\",\"items\":[{\"text\":\"say \\\"hi\\\"\\n\\\\ 25 °C\"}]}]}");
}

// References handed out stay valid while more items are added (ASan checks).
TEST(views_references_are_stable) {
    Api api;
    tesserui::Views views(api);
    auto& p = views.page("p");
    auto& first = p.card("first");
    auto& r = p.row();
    for (int i = 0; i < 100; i++) {
        p.node("/x");
        views.page(i % 2 ? "q" : "s").node("/y");
        r.node("/z");
    }
    first.node("/late");
    r.hint("last", true);
    CHECK_EQ(p.size(), size_t(102));
    CHECK_EQ(r.size(), size_t(100));
    std::string body = ui(api);
    CHECK(body.find("{\"card\":\"first\",\"items\":[{\"node\":\"/late\"}]}") != std::string::npos);
    CHECK(body.find("{\"node\":\"/z\",\"last\":true}]}") != std::string::npos);
}

// The declaration is shared with /_ui, so a Views may be a local of setup().
TEST(views_outlived_by_node) {
    Api api;
    tesserui::Page* page = nullptr;
    {
        tesserui::Views views(api);
        page = &views.page("p", "P");
        page->node("/a");
    }
    page->node("/b");
    CHECK_EQ(ui(api), "{\"pages\":[{\"id\":\"p\",\"label\":\"P\",\"items\":[{\"node\":\"/a\"},{\"node\":\"/b\"}]}]}");
}

TEST(views_write_matches_get) {
    Api api;
    tesserui::Views views(api);
    views.page("p", "P").row().widget("gauge", "/g").hint("max", 5);
    CHECK_EQ(written(views), ui(api));
}

TEST(views_node_metadata_in_schema) {
    Api api;
    api.value("x", "1");
    tesserui::Views views(api);
    CHECK(&views.node() == api.child("_ui"));
    tesser::Query q;
    q.view = tesser::View::Schema;
    Resp r = get(api, "/", q);
    CHECK(r.status == Status::Ok);
    CHECK_EQ(r.body,
             "{\"type\":\"object\",\"children\":{\"x\":{\"type\":\"string\"},"
             "\"_ui\":{\"type\":\"custom\",\"label\":\"Views\",\"ui\":{\"hidden\":true}}}}");
    r = get(api, "/_ui", q);
    CHECK_EQ(r.body, "{\"type\":\"custom\",\"label\":\"Views\",\"ui\":{\"hidden\":true}}");
}

TEST(views_on_a_sub_object) {
    Api api;
    auto& o = api.object("dash");
    tesserui::Views views(o);
    views.page("p").node("/x");
    CHECK_EQ(get(api, "/dash/_ui").body, "{\"pages\":[{\"id\":\"p\",\"items\":[{\"node\":\"/x\"}]}]}");
}

TEST(views_read_only) {
    Api api;
    tesserui::Views views(api);
    Resp r = request(api, tesser::Op::Set, "/_ui", "{\"pages\":[]}");
    CHECK(r.status == Status::ReadOnly);
}

TEST(views_one_per_api) {
    Api api;
    tesserui::Views views(api);
    int before = tesser::declarationErrors();
    tesserui::Views again(api);
    CHECK_EQ(tesser::declarationErrors(), before + 1);
    views.page("p");
    CHECK_EQ(ui(api), "{\"pages\":[{\"id\":\"p\",\"items\":[]}]}");
}

// The whole round trip as a browser over WebSocket or a serial line sees it.
TEST(views_over_line_transport) {
    Api api;
    tesserui::Views views(api);
    views.page("p", "P").widget("led", "/on");
    std::string out;
    tesser::LineTransport line(api, [&out](const char* data, size_t len) { out.append(data, len); });
    const char req[] = "{\"id\":7,\"op\":\"get\",\"path\":\"/_ui\"}\n";
    line.feed(req, sizeof(req) - 1);
    CHECK_EQ(out,
             "{\"id\":7,\"status\":\"ok\",\"body\":{\"pages\":[{\"id\":\"p\",\"label\":\"P\",\"items\":["
             "{\"widget\":\"led\",\"path\":\"/on\"}]}]}}\n");
}

// ---- Page served at "/" --------------------------------------------------

TEST(page_self_hosted) {
    tesserui::PageOptions o;
    o.minVersion = "0.1.0";
    CHECK_EQ(tesserui::renderPage(o),
             "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" "
             "content=\"width=device-width,initial-scale=1\"><title>TesserUI</title><link rel=\"icon\" href=\"data:,\"><script>"
             "window.TESSER={api:\"/api\",ws:\"/ws\",minVersion:\"0.1.0\"}</script></head><body>"
             "<script src=\"/ui.js\"></script></body></html>");
}

TEST(page_without_websocket_or_min_version) {
    tesserui::PageOptions o;
    o.api = "/rest/";
    o.ws = nullptr;
    std::string page = tesserui::renderPage(o);
    CHECK(page.find("<script>window.TESSER={api:\"/rest\",ws:null}</script>") != std::string::npos);
    CHECK(page.size() < 300);
}

TEST(page_stub) {
    tesserui::PageOptions o;
    o.script = "https://cdn.jsdelivr.net/npm/tesserui@0.1.0/dist/ui.js";
    o.fallback = true;
    CHECK_EQ(tesserui::renderPage(o),
             "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" "
             "content=\"width=device-width,initial-scale=1\"><title>TesserUI</title><link rel=\"icon\" href=\"data:,\"><script>"
             "window.TESSER={api:\"/api\",ws:\"/ws\"}</script></head><body>"
             "<script src=\"https://cdn.jsdelivr.net/npm/tesserui@0.1.0/dist/ui.js\" data-fallback=\""
             "The interface could not be loaded from https://cdn.jsdelivr.net/npm/tesserui@0.1.0/dist/ui.js: "
             "no internet access? Raw API: &lt;a href=&quot;/api/&quot;&gt;/api/&lt;/a&gt;\" "
             "onerror=\"document.body.innerHTML=this.dataset.fallback\"></script></body></html>");
}

TEST(page_escapes) {
    tesserui::PageOptions o;
    o.api = "/a\"</script>";
    o.script = "http://h/ui.js?a=1&b=\"2\"";
    o.fallback = true;
    std::string page = tesserui::renderPage(o);
    CHECK(page.find("api:\"/a\\\"\\u003c/script>\"") != std::string::npos);
    CHECK(page.find("src=\"http://h/ui.js?a=1&amp;b=&quot;2&quot;\"") != std::string::npos);
    // Escaped twice inside the fallback: text, then attribute.
    CHECK(page.find("loaded from http://h/ui.js?a=1&amp;amp;b=&amp;quot;2&amp;quot;:") != std::string::npos);
    CHECK_EQ(page.find("</script>\""), std::string::npos);
}

TEST(page_options) {
    tesserui::PageOptions o;
    o.title = "Héliostat <3>";
    o.script = "/ui/ui.js";
    o.scripts = {"/ext/sun-dial.js", "https://cdn.example/x.js"};
    o.theme = {{"accent", "#d97706"}, {"radius", "4px"}};
    o.strings = {{"Advanced", "Avancé"}, {"Run \"it\"", "Lancer"}};
    std::string page = tesserui::renderPage(o);
    CHECK(page.find("<title>Héliostat &lt;3&gt;</title>") != std::string::npos);
    CHECK(page.find("window.TESSER={api:\"/api\",ws:\"/ws\",title:\"Héliostat \\u003c3>\","
                    "scripts:[\"/ext/sun-dial.js\",\"https://cdn.example/x.js\"],"
                    "theme:{\"accent\":\"#d97706\",\"radius\":\"4px\"},"
                    "strings:{\"Advanced\":\"Avancé\",\"Run \\\"it\\\"\":\"Lancer\"}}</script>") != std::string::npos);
    CHECK(page.find("<script src=\"/ui/ui.js\">") != std::string::npos);
}

int main(int argc, char** argv) { return check::run(argc > 1 ? argv[1] : nullptr) ? 1 : 0; }
