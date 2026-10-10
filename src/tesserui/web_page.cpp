#include "tesserui/web_page.h"

#include <string.h>

namespace tesserui {

namespace {

// A JavaScript string literal's content; "<" is escaped so the text can't
// close the script element.
void appendJs(std::string& out, const char* s) {
    for (; *s; s++) {
        switch (*s) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '<': out += "\\u003c"; break;
            case '\n': out += "\\n"; break;
            default: out += *s;
        }
    }
}

// Text or an attribute value in HTML.
void appendHtml(std::string& out, const char* s) {
    for (; *s; s++) {
        switch (*s) {
            case '&': out += "&amp;"; break;
            case '<': out += "&lt;"; break;
            case '>': out += "&gt;"; break;
            case '"': out += "&quot;"; break;
            default: out += *s;
        }
    }
}

}  // namespace

std::string renderPage(const PageOptions& o) {
    // The API base without its trailing slashes, as HttpServer uses it.
    std::string api = o.api ? o.api : "";
    while (!api.empty() && api.back() == '/') api.pop_back();
    const char* script = o.script ? o.script : "/ui.js";

    std::string out;
    out.reserve(320 + strlen(script) * 3);
    out += "<!doctype html><html><head><meta charset=\"utf-8\">"
           "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
           "<title>TesserUI</title><link rel=\"icon\" href=\"data:,\"><script>window.TESSER={api:\"";
    appendJs(out, api.c_str());
    out += "\",ws:";
    if (o.ws) {
        out += '"';
        appendJs(out, o.ws);
        out += '"';
    } else {
        out += "null";
    }
    if (o.minVersion) {
        out += ",minVersion:\"";
        appendJs(out, o.minVersion);
        out += '"';
    }
    out += "}</script></head><body><script src=\"";
    appendHtml(out, script);
    out += '"';
    if (o.fallback) {
        // The fallback is HTML kept in a data attribute, so it is escaped
        // twice: once as HTML, once as an attribute value.
        std::string link = api + "/";
        std::string html = "The interface could not be loaded from ";
        appendHtml(html, script);
        html += ": no internet access? Raw API: <a href=\"";
        appendHtml(html, link.c_str());
        html += "\">";
        appendHtml(html, link.c_str());
        html += "</a>";
        out += " data-fallback=\"";
        appendHtml(out, html.c_str());
        out += "\" onerror=\"document.body.innerHTML=this.dataset.fallback\"";
    }
    out += "></script></body></html>";
    return out;
}

}  // namespace tesserui
