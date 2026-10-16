// A 320x240 screen on the host for the LVGL renderer's tests and the
// simulator's screenshots: a display drawing into memory, a pointer the test
// moves, PNG output (docs/DESIGN.md section 11).
#pragma once

#include <stdint.h>

#include <functional>
#include <string>
#include <vector>

#include <lvgl.h>

namespace lcd {

class Screen {
public:
    explicit Screen(int32_t width = 320, int32_t height = 240);
    ~Screen();
    Screen(const Screen&) = delete;
    Screen& operator=(const Screen&) = delete;

    lv_display_t* display() const { return display_; }

    // Advances LVGL's clock by `ms` in steps of 5 ms, calling `each` (the
    // client's work: ui.loop()) before every timer pass.
    void run(uint32_t ms, const std::function<void()>& each = nullptr);

    // The first visible label showing `text`, in drawing order, or null.
    lv_obj_t* label(const char* text) const;
    // The same, among `within`'s descendants.
    static lv_obj_t* label(const char* text, lv_obj_t* within);
    // The control on the row of the label showing `text`: the row's last
    // child, or the line below for two-line rows.
    lv_obj_t* control(const char* text) const;
    // Taps the centre of `obj` (or a point in it, as fractions of its size).
    void tap(lv_obj_t* obj, const std::function<void()>& each = nullptr, float fx = 0.5f, float fy = 0.5f);
    void press(int32_t x, int32_t y);
    void release();

    // An encoder (LV_INDEV_TYPE_ENCODER), created on first use: what two
    // buttons give. turn(n) moves the focus (or edits), push() presses.
    lv_indev_t* encoder();
    void turn(int n, const std::function<void()>& each = nullptr);
    void push(const std::function<void()>& each = nullptr);

    // Turns the screen (same number of pixels): landscape to portrait.
    void resize(int32_t width, int32_t height);

    // Draws now and writes the screen as a PNG.
    bool png(const std::string& path);

private:
    static void flush(lv_display_t* d, const lv_area_t* area, uint8_t* px);
    static void read(lv_indev_t* indev, lv_indev_data_t* data);
    static void readEncoder(lv_indev_t* indev, lv_indev_data_t* data);
    lv_indev_t* encoder_ = nullptr;
    int diff_ = 0;
    bool encPressed_ = false;

    lv_display_t* display_ = nullptr;
    lv_indev_t* pointer_ = nullptr;
    std::vector<uint16_t> pixels_;
    int32_t x_ = 0, y_ = 0;
    bool pressed_ = false;
};

// RGB565 pixels as an uncompressed PNG.
bool writePng(const std::string& path, const uint16_t* pixels, int32_t width, int32_t height);

}  // namespace lcd
