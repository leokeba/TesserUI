#include "lcd_host.h"

#include <stdio.h>
#include <string.h>

namespace lcd {

namespace {

uint32_t crcTable[256];

uint32_t crc32(const uint8_t* p, size_t n, uint32_t crc = 0) {
    if (!crcTable[1]) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            crcTable[i] = c;
        }
    }
    crc = ~crc;
    for (size_t i = 0; i < n; i++) crc = crcTable[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
    return ~crc;
}

void put32(std::vector<uint8_t>& out, uint32_t v) {
    for (int s = 24; s >= 0; s -= 8) out.push_back(static_cast<uint8_t>(v >> s));
}

void chunk(std::vector<uint8_t>& out, const char* type, const std::vector<uint8_t>& data) {
    put32(out, static_cast<uint32_t>(data.size()));
    std::vector<uint8_t> body(type, type + 4);
    body.insert(body.end(), data.begin(), data.end());
    out.insert(out.end(), body.begin(), body.end());
    put32(out, crc32(body.data(), body.size()));
}

lv_obj_t* findLabel(lv_obj_t* obj, const char* text) {
    if (lv_obj_is_hidden(obj)) return nullptr;
    if (lv_obj_check_type(obj, &lv_label_class) && strcmp(lv_label_get_text(obj), text) == 0) return obj;
    uint32_t n = lv_obj_get_child_count(obj);
    for (uint32_t i = 0; i < n; i++) {
        if (lv_obj_t* found = findLabel(lv_obj_get_child(obj, static_cast<int32_t>(i)), text)) return found;
    }
    return nullptr;
}

}  // namespace

bool writePng(const std::string& path, const uint16_t* pixels, int32_t width, int32_t height) {
    // Rows of RGB8, each after its filter byte (none).
    std::vector<uint8_t> raw;
    raw.reserve(static_cast<size_t>(height) * (static_cast<size_t>(width) * 3 + 1));
    for (int32_t y = 0; y < height; y++) {
        raw.push_back(0);
        for (int32_t x = 0; x < width; x++) {
            uint16_t p = pixels[static_cast<size_t>(y) * static_cast<size_t>(width) + static_cast<size_t>(x)];
            raw.push_back(static_cast<uint8_t>(((p >> 11) & 0x1F) * 255 / 31));
            raw.push_back(static_cast<uint8_t>(((p >> 5) & 0x3F) * 255 / 63));
            raw.push_back(static_cast<uint8_t>((p & 0x1F) * 255 / 31));
        }
    }
    // A zlib stream of stored deflate blocks.
    std::vector<uint8_t> z = {0x78, 0x01};
    for (size_t at = 0; at < raw.size() || raw.empty();) {
        size_t n = raw.size() - at > 65535 ? 65535 : raw.size() - at;
        bool last = at + n == raw.size();
        z.push_back(last ? 1 : 0);
        z.push_back(static_cast<uint8_t>(n & 0xFF));
        z.push_back(static_cast<uint8_t>(n >> 8));
        z.push_back(static_cast<uint8_t>(~n & 0xFF));
        z.push_back(static_cast<uint8_t>((~n >> 8) & 0xFF));
        z.insert(z.end(), raw.begin() + static_cast<long>(at), raw.begin() + static_cast<long>(at + n));
        at += n;
        if (last) break;
    }
    uint32_t a = 1, b = 0;
    for (uint8_t c : raw) {
        a = (a + c) % 65521;
        b = (b + a) % 65521;
    }
    put32(z, (b << 16) | a);

    std::vector<uint8_t> png = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
    std::vector<uint8_t> ihdr;
    put32(ihdr, static_cast<uint32_t>(width));
    put32(ihdr, static_cast<uint32_t>(height));
    ihdr.insert(ihdr.end(), {8, 2, 0, 0, 0});  // 8-bit RGB
    chunk(png, "IHDR", ihdr);
    chunk(png, "IDAT", z);
    chunk(png, "IEND", {});
    FILE* f = fopen(path.c_str(), "wb");
    if (!f) return false;
    bool ok = fwrite(png.data(), 1, png.size(), f) == png.size();
    fclose(f);
    return ok;
}

Screen::Screen(int32_t width, int32_t height) : pixels_(static_cast<size_t>(width) * static_cast<size_t>(height)) {
    if (!lv_is_initialized()) lv_init();
    display_ = lv_display_create(width, height);
    lv_display_set_color_format(display_, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display_, pixels_.data(), nullptr, static_cast<uint32_t>(pixels_.size() * 2),
                           LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(display_, flush);
    lv_display_set_default(display_);
    pointer_ = lv_indev_create();
    lv_indev_set_type(pointer_, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(pointer_, read);
    lv_indev_set_user_data(pointer_, this);
    lv_indev_set_display(pointer_, display_);
}

Screen::~Screen() {
    lv_indev_delete(pointer_);
    lv_display_delete(display_);
}

void Screen::flush(lv_display_t* d, const lv_area_t*, uint8_t*) { lv_display_flush_ready(d); }

void Screen::read(lv_indev_t* indev, lv_indev_data_t* data) {
    Screen* s = static_cast<Screen*>(lv_indev_get_user_data(indev));
    data->point.x = s->x_;
    data->point.y = s->y_;
    data->state = s->pressed_ ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

void Screen::run(uint32_t ms, const std::function<void()>& each) {
    for (uint32_t t = 0; t < ms; t += 5) {
        if (each) each();
        lv_tick_inc(5);
        lv_timer_handler();
    }
    if (each) each();
}

lv_obj_t* Screen::label(const char* text) const {
    if (lv_obj_t* l = findLabel(lv_display_get_screen_active(display_), text)) return l;
    return findLabel(lv_display_get_layer_top(display_), text);
}

lv_obj_t* Screen::label(const char* text, lv_obj_t* within) { return within ? findLabel(within, text) : nullptr; }

lv_obj_t* Screen::control(const char* text) const {
    lv_obj_t* l = label(text);
    if (!l) return nullptr;
    lv_obj_t* row = lv_obj_get_parent(l);
    lv_obj_t* last = lv_obj_get_child(row, static_cast<int32_t>(lv_obj_get_child_count(row)) - 1);
    // A row ending with text (the label, or a value beside it) is the top
    // line of a two-line row: the control is the line below.
    if (lv_obj_check_type(last, &lv_label_class)) {
        lv_obj_t* outer = lv_obj_get_parent(row);
        if (outer && lv_obj_get_child_count(outer) > 1) return lv_obj_get_child(outer, 1);
    }
    return last;
}

void Screen::press(int32_t x, int32_t y) {
    x_ = x;
    y_ = y;
    pressed_ = true;
}

void Screen::release() { pressed_ = false; }

void Screen::tap(lv_obj_t* obj, const std::function<void()>& each, float fx, float fy) {
    lv_obj_scroll_to_view_recursive(obj, LV_ANIM_OFF);
    lv_obj_update_layout(obj);
    lv_area_t a;
    lv_obj_get_coords(obj, &a);
    press(a.x1 + static_cast<int32_t>(static_cast<float>(a.x2 - a.x1) * fx),
          a.y1 + static_cast<int32_t>(static_cast<float>(a.y2 - a.y1) * fy));
    run(100, each);
    release();
    run(100, each);
}

bool Screen::png(const std::string& path) {
    lv_obj_invalidate(lv_display_get_screen_active(display_));
    lv_refr_now(display_);
    return writePng(path, pixels_.data(), lv_display_get_horizontal_resolution(display_),
                    lv_display_get_vertical_resolution(display_));
}

}  // namespace lcd
