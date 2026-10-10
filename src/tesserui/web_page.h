#pragma once

// The HTML page WebUi serves at "/" (docs/DESIGN.md sections 9.4 and 9.6).
// Platform-independent, so it is host-tested.

#include <string>

namespace tesserui {

struct PageOptions {
    const char* api = "/api";          // API base path (TesserAPI's HttpServer basePath)
    const char* ws = "/ws";            // WebSocket path; null: no WebSocket
    const char* minVersion = nullptr;  // oldest bundle the node accepts; null: any
    const char* script = "/ui.js";     // the bundle's URL
    // Stub page (section 9.6): if the script fails to load, the body is
    // replaced with an explanation and a link to the raw API.
    bool fallback = false;
};

// About 300 bytes:
//   <!doctype html><html><head>...<script>window.TESSER={api:"/api",ws:"/ws",minVersion:"0.1.0"}</script>
//   </head><body><script src="/ui.js"></script></body></html>
std::string renderPage(const PageOptions& options);

}  // namespace tesserui
