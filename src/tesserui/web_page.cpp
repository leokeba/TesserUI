#include "tesserui/web_page.h"

#include <string.h>

namespace tesserui {

namespace {

// TesserUI's icon, a tesseract in the accent colour.
const char kIcon[] =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path "
    "d='M1 1h14v14H1zm4 4v6h6V5zl-4-4m14 0-4 4m0 6 4 4m-14 0 4-4' fill='none' stroke='%232f5bd3' "
    "stroke-width='2'/></svg>";

// The escapes of a context: the replacement of each character that needs
// one, or null.
using Escape = const char* (*)(char c);

// A JavaScript string literal's content; "<" is escaped so the text can't
// close the script element.
const char* jsEscape(char c) {
    switch (c) {
        case '"': return "\\\"";
        case '\\': return "\\\\";
        case '<': return "\\u003c";
        case '\n': return "\\n";
        default: return nullptr;
    }
}

// Text or an attribute value in HTML.
const char* htmlEscape(char c) {
    switch (c) {
        case '&': return "&amp;";
        case '<': return "&lt;";
        case '>': return "&gt;";
        case '"': return "&quot;";
        default: return nullptr;
    }
}

// HTML escaped as an attribute value: the stub's fallback is HTML kept in
// a data attribute.
const char* htmlTwiceEscape(char c) {
    switch (c) {
        case '&': return "&amp;amp;";
        case '<': return "&amp;lt;";
        case '>': return "&amp;gt;";
        case '"': return "&amp;quot;";
        default: return nullptr;
    }
}

struct Out {
    PageSink sink;
    void* context;

    void raw(const char* s, size_t n) {
        if (n) sink(context, s, n);
    }
    void raw(const char* s) { raw(s, strlen(s)); }
    // `n` characters of `s`, the runs between escapes as they are.
    void escaped(const char* s, size_t n, Escape escape) {
        size_t run = 0;
        for (size_t i = 0; i < n; i++) {
            const char* e = escape(s[i]);
            if (!e) continue;
            raw(s + run, i - run);
            raw(e);
            run = i + 1;
        }
        raw(s + run, n - run);
    }
    void js(const char* s, size_t n) { escaped(s, n, jsEscape); }
    void js(const char* s) { js(s, strlen(s)); }
    void html(const char* s) { escaped(s, strlen(s), htmlEscape); }
    void string(const char* s) {
        raw("\"");
        js(s ? s : "");
        raw("\"");
    }
    void object(const char* key, const Pairs& pairs) {
        if (pairs.empty()) return;
        raw(",");
        raw(key);
        raw(":{");
        for (size_t i = 0; i < pairs.size(); i++) {
            if (i) raw(",");
            string(pairs[i].first);
            raw(":");
            string(pairs[i].second);
        }
        raw("}");
    }
};

}  // namespace

void renderPage(const PageOptions& o, PageSink sink, void* context) {
    Out out{sink, context};
    // The API base without its trailing slashes, as HttpServer uses it.
    const char* api = o.api ? o.api : "";
    size_t apiLen = strlen(api);
    while (apiLen > 0 && api[apiLen - 1] == '/') apiLen--;
    const char* script = o.script ? o.script : "/ui.js";

    out.raw("<!doctype html><html><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<title>");
    out.html(o.title ? o.title : "TesserUI");
    out.raw("</title><link rel=\"icon\" href=\"");
    if (o.icon) {
        out.html(o.icon);
    } else {
        out.raw(kIcon);  // as it is: no '"' or '&' in it
    }
    out.raw("\"><script>window.TESSER={api:\"");
    out.js(api, apiLen);
    out.raw("\",ws:");
    if (o.ws) {
        out.string(o.ws);
    } else {
        out.raw("null");
    }
    if (o.minVersion) {
        out.raw(",minVersion:");
        out.string(o.minVersion);
    }
    if (o.title) {
        out.raw(",title:");
        out.string(o.title);
    }
    if (!o.scripts.empty()) {
        out.raw(",scripts:[");
        for (size_t i = 0; i < o.scripts.size(); i++) {
            if (i) out.raw(",");
            out.string(o.scripts[i]);
        }
        out.raw("]");
    }
    out.object("theme", o.theme);
    out.object("strings", o.strings);
    out.raw("}</script></head><body><script src=\"");
    out.html(script);
    out.raw("\"");
    if (o.integrity) {
        out.raw(" integrity=\"");
        out.html(o.integrity);
        out.raw("\" crossorigin=\"anonymous\"");
    }
    if (o.fallback) {
        // HTML escaped once more as the attribute's value: its markup
        // written so, its text twice.
        out.raw(" data-fallback=\"The interface could not be loaded from ");
        out.escaped(script, strlen(script), htmlTwiceEscape);
        out.raw(": no internet access? Raw API: &lt;a href=&quot;");
        out.escaped(api, apiLen, htmlTwiceEscape);
        out.raw("/&quot;&gt;");
        out.escaped(api, apiLen, htmlTwiceEscape);
        out.raw("/&lt;/a&gt;\" onerror=\"document.body.innerHTML=this.dataset.fallback\"");
    }
    out.raw("></script></body></html>");
}

std::string renderPage(const PageOptions& o) {
    std::string page;
    page.reserve(520 + (o.script ? strlen(o.script) * 3 : 0));
    renderPage(
        o, [](void* context, const char* data, size_t size) { static_cast<std::string*>(context)->append(data, size); },
        &page);
    return page;
}

}  // namespace tesserui
