#include "tesserui/web_ui.h"

#if defined(ESP_PLATFORM)

#include <string.h>

#include "tesserui/bundle/tesserui_bundle.h"

namespace tesserui {

namespace {

constexpr size_t kChunk = 4096;

// True when the request's If-None-Match lists the bundle's ETag.
bool etagMatches(httpd_req_t* req) {
    char value[64];
    size_t len = httpd_req_get_hdr_value_len(req, "If-None-Match");
    if (len == 0 || len >= sizeof(value)) return false;
    if (httpd_req_get_hdr_value_str(req, "If-None-Match", value, sizeof(value)) != ESP_OK) return false;
    return strstr(value, bundle::kEtag) != nullptr || strcmp(value, "*") == 0;
}

// Straight from flash, in chunks.
esp_err_t sendChunks(httpd_req_t* req, const char* data, size_t left) {
    while (left > 0) {
        size_t n = left < kChunk ? left : kChunk;
        esp_err_t err = httpd_resp_send_chunk(req, data, static_cast<ssize_t>(n));
        if (err != ESP_OK) return err;
        data += n;
        left -= n;
    }
    return httpd_resp_send_chunk(req, nullptr, 0);
}

}  // namespace

esp_err_t WebUi::serve(httpd_handle_t server, const char* apiPath, const char* wsPath) {
    if (server_) return ESP_ERR_INVALID_STATE;
    pageUri_ = base_ && *base_ ? base_ : "/";
    if (pageUri_.back() != '/') pageUri_ += '/';
    scriptUri_ = pageUri_ + "ui.js";
    chunkUri_ = pageUri_ + "ui/*";
    PageOptions o = pageOptions_;
    o.api = apiPath;
    o.ws = wsPath;
    o.script = scriptUri_.c_str();
    page_ = renderPage(o);
    return start(server, true);
}

esp_err_t WebUi::serveStub(httpd_handle_t server, const char* scriptUrl, const char* apiPath, const char* wsPath) {
    if (server_) return ESP_ERR_INVALID_STATE;
    if (!scriptUrl) return ESP_ERR_INVALID_ARG;
    pageUri_ = base_ && *base_ ? base_ : "/";
    if (pageUri_.back() != '/') pageUri_ += '/';
    PageOptions o = pageOptions_;
    o.api = apiPath;
    o.ws = wsPath;
    o.script = scriptUrl;
    o.fallback = true;
    page_ = renderPage(o);
    return start(server, false);
}

esp_err_t WebUi::start(httpd_handle_t server, bool script) {
    if (!server) return ESP_ERR_INVALID_ARG;
    server_ = server;
    httpd_uri_t uri = {};
    uri.uri = pageUri_.c_str();
    uri.method = HTTP_GET;
    uri.handler = &WebUi::onPage;
    uri.user_ctx = this;
    esp_err_t err = httpd_register_uri_handler(server, &uri);
    if (err != ESP_OK) {
        server_ = nullptr;
        return err;
    }
    if (script) {
        uri.uri = scriptUri_.c_str();
        uri.handler = &WebUi::onScript;
        err = httpd_register_uri_handler(server, &uri);
        if (err != ESP_OK) {
            end();
            return err;
        }
        script_ = true;
        uri.uri = chunkUri_.c_str();
        uri.handler = &WebUi::onChunk;
        err = httpd_register_uri_handler(server, &uri);
        if (err != ESP_OK) {
            end();
            return err;
        }
    }
    // The vector doesn't grow while serving: asset pointers are stable.
    for (Asset& a : assets_) {
        uri.uri = a.uri;
        uri.handler = &WebUi::onAsset;
        uri.user_ctx = &a;
        err = httpd_register_uri_handler(server, &uri);
        if (err != ESP_OK) {
            end();
            return err;
        }
        registered_++;
    }
    return ESP_OK;
}

void WebUi::end() {
    if (!server_) return;
    httpd_unregister_uri_handler(server_, pageUri_.c_str(), HTTP_GET);
    if (script_) {
        httpd_unregister_uri_handler(server_, scriptUri_.c_str(), HTTP_GET);
        httpd_unregister_uri_handler(server_, chunkUri_.c_str(), HTTP_GET);
    }
    for (size_t i = 0; i < registered_; i++) httpd_unregister_uri_handler(server_, assets_[i].uri, HTTP_GET);
    server_ = nullptr;
    script_ = false;
    registered_ = 0;
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
    return sendChunks(req, reinterpret_cast<const char*>(bundle::kUiJsGz), bundle::kUiJsGzSize);
}

esp_err_t WebUi::onChunk(httpd_req_t* req) {
    // <base>ui/<name>: names carry their content's hash, and ui.js names the
    // ones it loads, so a chunk never changes and caches for good. import()
    // fetches it in CORS mode: a stub page on another node loads it too.
    auto* self = static_cast<WebUi*>(req->user_ctx);
    const char* name = req->uri + self->chunkUri_.size() - 1;
    size_t len = strcspn(name, "?#");
    for (const bundle::Chunk& c : bundle::kChunks) {
        if (strlen(c.name) != len || strncmp(c.name, name, len) != 0) continue;
        httpd_resp_set_type(req, "application/javascript");
        httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
        if (!c.data) {
            // Left out of this firmware (TESSERUI_NO_FILES_UI...): a module
            // that fails, which the page takes for a widget it can't draw,
            // where a 404 would have it reload. Not cached: an update may
            // bring it under the same name.
            httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
            return httpd_resp_sendstr(req, "throw Error(\"not in this firmware\")");
        }
        httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
        httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=31536000, immutable");
        return sendChunks(req, reinterpret_cast<const char*>(c.data), c.size);
    }
    return httpd_resp_send_404(req);
}

esp_err_t WebUi::onAsset(httpd_req_t* req) {
    auto* a = static_cast<Asset*>(req->user_ctx);
    httpd_resp_set_type(req, a->type ? a->type : "application/octet-stream");
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    if (a->gzipped) httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    return sendChunks(req, a->data, a->size);
}

}  // namespace tesserui

#endif
