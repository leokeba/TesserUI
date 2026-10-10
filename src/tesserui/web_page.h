#pragma once

// The HTML page WebUi serves at "/" (docs/DESIGN.md sections 9.4 and 9.6).
// Platform-independent, so it is host-tested.

#include <string>
#include <utility>
#include <vector>

namespace tesserui {

using Pairs = std::vector<std::pair<const char*, const char*>>;

struct PageOptions {
    const char* api = "/api";          // API base path (TesserAPI's HttpServer basePath)
    const char* ws = "/ws";            // WebSocket path; null: no WebSocket
    const char* minVersion = nullptr;  // oldest bundle the node accepts; null: any
    const char* script = "/ui.js";     // the bundle's URL
    const char* title = nullptr;       // the page title until the device's label is known
    // Module scripts defining custom elements (section 9.8).
    std::vector<const char*> scripts;
    // CSS variables, without "--": {"accent", "#d97706"} (section 9.2).
    Pairs theme;
    // The interface's text: {"Advanced", "Avancé"} (section 9.10).
    Pairs strings;
    // Stub page (section 9.6): if the script fails to load, the body is
    // replaced with an explanation and a link to the raw API.
    bool fallback = false;
};

// About 300 bytes:
//   <!doctype html><html><head>...<script>window.TESSER={api:"/api",ws:"/ws",minVersion:"0.1.0"}</script>
//   </head><body><script src="/ui.js"></script></body></html>
std::string renderPage(const PageOptions& options);

}  // namespace tesserui
