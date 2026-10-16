// LilyGO TTGO T-Display: an ESP32 (D0WDQ6, 4 or 16 MB of flash, no PSRAM),
// a 1.14" 135x240 IPS panel (ST7789V) on SPI, a backlight on GPIO 4, and two
// buttons, on GPIO 0 and GPIO 35, which drive the UI as an encoder:
//
//   GPIO 35, short press: the next control (editing: more)
//   GPIO 35, held:        the previous one, repeating (editing: less)
//   GPIO 0,  short press: press the control, or edit it (a slider, a list)
//   GPIO 0,  held:        back (backPressed()): leave editing, close, go back
//
// The same interface as ../cyd/board.h, so lcd_remote builds for either.
#pragma once

#include <stdint.h>

#include <lvgl.h>

namespace board {

// Landscape (240x135) and portrait (135x240), and each turned half round.
enum class Orientation : uint8_t { Landscape, Portrait, LandscapeFlipped, PortraitFlipped };

// Starts the panel, the backlight and the buttons, and creates the LVGL
// display and the buttons' input device. Call lv_init() first.
lv_display_t* begin(Orientation orientation = Orientation::Landscape);

// Turns the screen; the UI lays itself out again. From the LVGL task.
void orientation(Orientation o);

// 0 to 100 %.
void backlight(uint8_t percent);

// No RGB LED or light sensor on this board.
inline void led(uint8_t, uint8_t, uint8_t) {}
inline uint8_t light() { return 0; }

// The buttons, as an LV_INDEV_TYPE_ENCODER: for LvglUi::input().
lv_indev_t* buttons();
// Whether the back gesture (GPIO 0 held) happened since the last call.
bool backPressed();

}  // namespace board
