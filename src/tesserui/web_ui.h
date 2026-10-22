#pragma once

// Serves the web renderer from the node (docs/DESIGN.md sections 9.4 and
// 9.6), on esp_http_server: ESP-IDF, and Arduino-ESP32 3.x, which ships it.
#if defined(ESP_PLATFORM)

#include <string>
#include <vector>

#include "esp_http_server.h"
#include "tesserui/web_page.h"

namespace tesserui {

// Self-hosted:
//   tesser::HttpServer http(api);
//   http.enableWebSocket("/ws");
//   http.begin(80, "/api");
//   tesserui::WebUi web;
//   web.serve(http.handle());      // GET /, /ui.js and /ui/* on the same server
//
// Stub, with the bundle loaded from elsewhere: a version on the launcher's
// site, checked against its hash (both from its versions.json, DESIGN.md §9.6):
//   web.integrity("sha384-...")
//      .serveStub(http.handle(), "https://leokeba.github.io/TesserUI/v0.1.20/ui.js");
//
// Options, all before serve() (strings must outlive the WebUi):
//   web.basePath("/ui/")                         // the UI at /ui/ and /ui/ui.js, leaving / to the app
//      .title("Heliostat 3")
//      .icon("/icon.svg")                        // the favicon, instead of TesserUI's
//      .theme("accent", "#d97706")               // CSS variables (DESIGN.md §9.2)
//      .text("Advanced", "Avancé")               // the interface's text (§9.10)
//      .script("/ext/sun-dial.js")               // custom elements (§9.8)...
//      .asset("/ext/sun-dial.js", kSunDial, sizeof(kSunDial) - 1, "text/javascript");  // ...served from flash
//
// The server must use httpd_uri_match_wildcard (HttpServer::begin() does) and
// serve the API under a non-empty base path, or the API's "/*" shadows "/".
// HttpServer::begin() allows 10 handlers: the API takes up to 6, serve() 3,
// serveStub() 1, each asset 1.
class WebUi {
public:
    WebUi() = default;
    ~WebUi() { end(); }
    WebUi(const WebUi&) = delete;
    WebUi& operator=(const WebUi&) = delete;

    // The oldest bundle version this node accepts, reported to the bundle in
    // the page.
    WebUi& minVersion(const char* version) {
        pageOptions_.minVersion = version;
        return *this;
    }
    // A stub's bundle, pinned to a version: its Subresource Integrity hash
    // ("sha384-..."). The browser then fetches it with CORS, and refuses it
    // (the stub's explanation shows) if it differs. Not for a UI host's
    // /ui.js, which changes with its firmware and sends no CORS headers.
    WebUi& integrity(const char* sri) {
        pageOptions_.integrity = sri;
        return *this;
    }
    // Where the page is served: "/" (default) or a path ending with "/", the
    // bundle next to it.
    WebUi& basePath(const char* path) {
        base_ = path;
        return *this;
    }
    // The page title until the bundle shows the device's label.
    WebUi& title(const char* title) {
        pageOptions_.title = title;
        return *this;
    }
    // The favicon's URL (an asset, a data: URL); default: TesserUI's.
    WebUi& icon(const char* url) {
        pageOptions_.icon = url;
        return *this;
    }
    // A module script defining custom elements, loaded before any is drawn.
    WebUi& script(const char* url) {
        pageOptions_.scripts.push_back(url);
        return *this;
    }
    // A CSS variable of the interface, without "--" ("accent", "radius"...).
    WebUi& theme(const char* variable, const char* value) {
        pageOptions_.theme.emplace_back(variable, value);
        return *this;
    }
    // The interface's own text, by its English text.
    WebUi& text(const char* english, const char* translation) {
        pageOptions_.strings.emplace_back(english, translation);
        return *this;
    }
    // A file served from flash at `uri` (a custom element's script, an
    // icon...), gzipped or not. One handler slot each.
    WebUi& asset(const char* uri, const void* data, size_t size, const char* contentType, bool gzipped = false) {
        assets_.push_back(Asset{this, uri, static_cast<const char*>(data), size, contentType, gzipped});
        return *this;
    }

    // Registers GET <base> (the page), GET <base>ui.js (the gzipped bundle
    // compiled into the firmware) and GET <base>ui/* (the chunks it loads
    // when a page draws a widget few pages use), and the assets. `apiPath` is HttpServer's
    // base path and `wsPath` its WebSocket path, or null without one.
    esp_err_t serve(httpd_handle_t server, const char* apiPath = "/api", const char* wsPath = "/ws");
    // Registers GET <base> and the assets: a page that loads the bundle from
    // `scriptUrl` (a version on the launcher's site or a CDN, see
    // integrity(), or a UI host's /ui.js), and
    // explains itself with a link to the raw API when that fails.
    esp_err_t serveStub(httpd_handle_t server, const char* scriptUrl, const char* apiPath = "/api",
                        const char* wsPath = "/ws");
    // Unregisters the handlers.
    void end();

    // The page served at the base path, once serving.
    const std::string& page() const { return page_; }

private:
    struct Asset {
        WebUi* ui;
        const char* uri;
        const char* data;
        size_t size;
        const char* type;
        bool gzipped;
    };

    static esp_err_t onPage(httpd_req_t* req);
    static esp_err_t onScript(httpd_req_t* req);
    static esp_err_t onChunk(httpd_req_t* req);
    static esp_err_t onAsset(httpd_req_t* req);
    esp_err_t start(httpd_handle_t server, bool script);

    httpd_handle_t server_ = nullptr;
    bool script_ = false;
    const char* base_ = "/";
    std::string pageUri_;
    std::string scriptUri_;
    std::string chunkUri_;
    PageOptions pageOptions_;
    std::vector<Asset> assets_;
    size_t registered_ = 0;  // assets registered
    std::string page_;
};

}  // namespace tesserui

#endif
