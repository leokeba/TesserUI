// The "cheap yellow display" with two USB ports (ESP32-2432S028, USB-C and
// micro-USB): an ESP32 without PSRAM, a 320x240 ST7789 panel on one SPI bus
// and an XPT2046 resistive touch controller on another, a backlight on
// GPIO 21, an RGB LED (active low) and a light sensor.
//
// TesserUI receives an lv_display_t*: the drivers are the application's
// (docs/DESIGN.md section 2). These are this board's.
#pragma once

#include <stdint.h>

#include <lvgl.h>

namespace board {

// How the screen is held: landscape (320x240, the USB ports on the right
// as measured), portrait (240x320), and each turned half round.
enum class Orientation : uint8_t { Landscape, Portrait, LandscapeFlipped, PortraitFlipped };

// Starts the panel, the backlight and the touch controller, and creates
// the LVGL display and its pointer. Call lv_init() first.
lv_display_t* begin(Orientation orientation = Orientation::Landscape);

// Turns the screen: the panel's scan direction, LVGL's resolution (the UI
// lays itself out again) and the touch mapping. From the LVGL task.
void orientation(Orientation o);

// 0 to 100 %.
void backlight(uint8_t percent);
// Each channel 0 to 255.
void led(uint8_t r, uint8_t g, uint8_t b);
// Ambient light, 0 (dark) to 100 (bright).
uint8_t light();
// The light sensor's ADC reading (0 dB, 12 bits), or -1.
int lightRaw();

// What the drivers did, for checking a board: areas sent to the panel and
// sent through, touch readings and the last point.
struct Stats {
    uint32_t flushes = 0;
    uint32_t flushed = 0;
    uint32_t touches = 0;
    int32_t x = 0, y = 0;
};
const Stats& stats();

}  // namespace board
