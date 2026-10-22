#include "tesserui/web_page.h"

#include <string.h>

namespace tesserui {

namespace {

// TesserUI's icon, a tesseract in the accent colour.
const char kIcon[] =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path "
    "d='M1 1h14v14H1zm4 4v6h6V5zl-4-4m14 0-4 4m0 6 4 4m-14 0 4-4' fill='none' stroke='%232f5bd3' "
    "stroke-width='2'/></svg>";

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

void appendString(std::string& out, const char* s) {
    out += '"';
    appendJs(out, s ? s : "");
    out += '"';
}

void appendObject(std::string& out, const char* key, const Pairs& pairs) {
    if (pairs.empty()) return;
    out += ',';
    out += key;
    out += ":{";
    for (size_t i = 0; i < pairs.size(); i++) {
        if (i) out += ',';
        appendString(out, pairs[i].first);
        out += ':';
        appendString(out, pairs[i].second);
    }
    out += '}';
}

}  // namespace

std::string renderPage(const PageOptions& o) {
    // The API base without its trailing slashes, as HttpServer uses it.
    std::string api = o.api ? o.api : "";
    while (!api.empty() && api.back() == '/') api.pop_back();
    const char* script = o.script ? o.script : "/ui.js";

    std::string out;
    out.reserve(520 + strlen(script) * 3);
    out += "<!doctype html><html><head><meta charset=\"utf-8\">"
           "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
           "<title>";
    appendHtml(out, o.title ? o.title : "TesserUI");
    out += "</title><link rel=\"icon\" href=\"";
    if (o.icon) {
        appendHtml(out, o.icon);
    } else {
        out += kIcon;  // as it is: no '"' or '&' in it
    }
    out += "\"><script>window.TESSER={api:\"";
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
        out += ",minVersion:";
        appendString(out, o.minVersion);
    }
    if (o.title) {
        out += ",title:";
        appendString(out, o.title);
    }
    if (!o.scripts.empty()) {
        out += ",scripts:[";
        for (size_t i = 0; i < o.scripts.size(); i++) {
            if (i) out += ',';
            appendString(out, o.scripts[i]);
        }
        out += ']';
    }
    appendObject(out, "theme", o.theme);
    appendObject(out, "strings", o.strings);
    out += "}</script></head><body><script src=\"";
    appendHtml(out, script);
    out += '"';
    if (o.integrity) {
        out += " integrity=\"";
        appendHtml(out, o.integrity);
        out += "\" crossorigin=\"anonymous\"";
    }
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
