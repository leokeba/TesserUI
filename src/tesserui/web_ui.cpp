#include "tesserui/web_ui.h"

#if defined(ESP_PLATFORM)

#include <string.h>

#include "tesserui/bundle/tesserui_bundle.h"
#include "tesserui/web_page.h"

namespace tesserui {

namespace {

constexpr char kPageUri[] = "/";
constexpr char kScriptUri[] = "/ui.js";
constexpr size_t kChunk = 4096;

// True when the request's If-None-Match lists the bundle's ETag.
bool etagMatches(httpd_req_t* req) {
    char value[64];
    size_t len = httpd_req_get_hdr_value_len(req, "If-None-Match");
    if (len == 0 || len >= sizeof(value)) return false;
    if (httpd_req_get_hdr_value_str(req, "If-None-Match", value, sizeof(value)) != ESP_OK) return false;
    return strstr(value, bundle::kEtag) != nullptr || strcmp(value, "*") == 0;
}

}  // namespace

esp_err_t WebUi::serve(httpd_handle_t server, const char* apiPath, const char* wsPath) {
    if (server_) return ESP_ERR_INVALID_STATE;
    PageOptions o;
    o.api = apiPath;
    o.ws = wsPath;
    o.minVersion = minVersion_;
    page_ = renderPage(o);
    return start(server, true);
}

esp_err_t WebUi::serveStub(httpd_handle_t server, const char* scriptUrl, const char* apiPath, const char* wsPath) {
    if (server_) return ESP_ERR_INVALID_STATE;
    if (!scriptUrl) return ESP_ERR_INVALID_ARG;
    PageOptions o;
    o.api = apiPath;
    o.ws = wsPath;
    o.minVersion = minVersion_;
    o.script = scriptUrl;
    o.fallback = true;
    page_ = renderPage(o);
    return start(server, false);
}

esp_err_t WebUi::start(httpd_handle_t server, bool script) {
    if (!server) return ESP_ERR_INVALID_ARG;
    httpd_uri_t uri = {};
    uri.uri = kPageUri;
    uri.method = HTTP_GET;
    uri.handler = &WebUi::onPage;
    uri.user_ctx = this;
    esp_err_t err = httpd_register_uri_handler(server, &uri);
    if (err != ESP_OK) return err;
    if (script) {
        uri.uri = kScriptUri;
        uri.handler = &WebUi::onScript;
        err = httpd_register_uri_handler(server, &uri);
        if (err != ESP_OK) {
            httpd_unregister_uri_handler(server, kPageUri, HTTP_GET);
            return err;
        }
    }
    server_ = server;
    script_ = script;
    return ESP_OK;
}

void WebUi::end() {
    if (!server_) return;
    httpd_unregister_uri_handler(server_, kPageUri, HTTP_GET);
    if (script_) httpd_unregister_uri_handler(server_, kScriptUri, HTTP_GET);
    server_ = nullptr;
    script_ = false;
}

esp_err_t WebUi::onPage(httpd_req_t* req) {
    auto* self = static_cast<WebUi*>(req->user_ctx);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    return httpd_resp_send(req, self->page_.data(), static_cast<ssize_t>(self->page_.size()));
}

esp_err_t WebUi::onScript(httpd_req_t* req) {
    // Revalidated on every load (no-cache), answered with 304 while the
    // bundle is unchanged.
    httpd_resp_set_hdr(req, "ETag", bundle::kEtag);
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    if (etagMatches(req)) {
        httpd_resp_set_status(req, "304 Not Modified");
        return httpd_resp_send(req, nullptr, 0);
    }
    httpd_resp_set_type(req, "application/javascript");
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    // Straight from flash, in chunks.
    const char* data = reinterpret_cast<const char*>(bundle::kUiJsGz);
    size_t left = bundle::kUiJsGzSize;
    while (left > 0) {
        size_t n = left < kChunk ? left : kChunk;
        esp_err_t err = httpd_resp_send_chunk(req, data, static_cast<ssize_t>(n));
        if (err != ESP_OK) return err;
        data += n;
        left -= n;
    }
    return httpd_resp_send_chunk(req, nullptr, 0);
}

}  // namespace tesserui

#endif
