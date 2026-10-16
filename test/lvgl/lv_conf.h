// LVGL's configuration for the host build: the renderer's tests and the
// simulator (tesserui_lcd). Only what differs from LVGL's defaults; firmware
// sets its own through Kconfig (examples/idf/lcd_local/sdkconfig.defaults).
#ifndef LV_CONF_H
#define LV_CONF_H

#define LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565

// The C library's allocator, so that the sanitizers see LVGL's memory.
#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB

#define LV_USE_OS LV_OS_NONE
#define LV_USE_THORVG_INTERNAL 0

#define LV_FONT_MONTSERRAT_12 1
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1

#define LV_USE_LOG 1
#define LV_LOG_LEVEL LV_LOG_LEVEL_WARN
#define LV_LOG_PRINTF 1

// The simulator's window, when CMake found SDL2.
#ifdef TESSERUI_SDL
#define LV_USE_SDL 1
#define LV_SDL_INCLUDE_PATH <SDL.h>
#endif

#endif
