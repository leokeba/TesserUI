#pragma once

// Serves the web renderer from the node (docs/DESIGN.md sections 9.4 and
// 9.6), on esp_http_server: ESP-IDF, and Arduino-ESP32 3.x, which ships it.
#if defined(ESP_PLATFORM)

#include <string>

#include "esp_http_server.h"

namespace tesserui {

// Self-hosted:
//   tesser::HttpServer http(api);
//   http.enableWebSocket("/ws");
//   http.begin(80, "/api");
//   tesserui::WebUi web;
//   web.serve(http.handle());      // GET / and GET /ui.js on the same server
//
// Stub, with the bundle loaded from elsewhere:
//   web.serveStub(http.handle(), "https://cdn.jsdelivr.net/npm/tesserui@0.1.0/dist/ui.js");
//
// The server must use httpd_uri_match_wildcard (HttpServer::begin() does) and
// serve the API under a non-empty base path, or the API's "/*" shadows "/".
class WebUi {
public:
    WebUi() = default;
    ~WebUi() { end(); }
    WebUi(const WebUi&) = delete;
    WebUi& operator=(const WebUi&) = delete;

    // The oldest bundle version this node accepts, reported to the bundle in
    // the page. Call before serve(). The string must outlive the WebUi.
    void minVersion(const char* version) { minVersion_ = version; }

    // Registers GET / (the page) and GET /ui.js (the gzipped bundle compiled
    // into the firmware): two URI handler slots. `apiPath` is HttpServer's
    // base path and `wsPath` its WebSocket path, or null without one.
    esp_err_t serve(httpd_handle_t server, const char* apiPath = "/api", const char* wsPath = "/ws");
    // Registers GET / only: a page that loads the bundle from `scriptUrl` (a
    // CDN pinned to a version, or a UI host's /ui.js), and explains itself
    // with a link to the raw API when that fails. One handler slot.
    esp_err_t serveStub(httpd_handle_t server, const char* scriptUrl, const char* apiPath = "/api",
                        const char* wsPath = "/ws");
    // Unregisters the handlers.
    void end();

    // The page served at "/", once serving.
    const std::string& page() const { return page_; }

private:
    static esp_err_t onPage(httpd_req_t* req);
    static esp_err_t onScript(httpd_req_t* req);
    esp_err_t start(httpd_handle_t server, bool script);

    httpd_handle_t server_ = nullptr;
    bool script_ = false;
    const char* minVersion_ = nullptr;
    std::string page_;
};

}  // namespace tesserui

#endif
