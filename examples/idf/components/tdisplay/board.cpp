#include "board.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#if __has_include("esp_lcd_panel_st7789.h")
#include "esp_lcd_panel_st7789.h"
#else
#include "esp_lcd_panel_vendor.h"  // ESP-IDF 5.1: the ST7789 is declared here
#endif
#include "esp_log.h"
#include "esp_idf_version.h"
#include "esp_timer.h"

namespace board {

namespace {

constexpr gpio_num_t kMosi = GPIO_NUM_19;
constexpr gpio_num_t kSclk = GPIO_NUM_18;
constexpr gpio_num_t kCs = GPIO_NUM_5;
constexpr gpio_num_t kDc = GPIO_NUM_16;
constexpr gpio_num_t kRst = GPIO_NUM_23;
constexpr gpio_num_t kBacklight = GPIO_NUM_4;
constexpr gpio_num_t kNext = GPIO_NUM_35;   // external pull-up, low when pressed
constexpr gpio_num_t kEnter = GPIO_NUM_0;   // the boot button, low when pressed

constexpr int32_t kLong = 135;   // the panel's short side
constexpr int32_t kWide = 240;
constexpr int32_t kBufferLines = 24;

constexpr uint32_t kHoldMs = 500;     // a press this long is a hold
constexpr uint32_t kRepeatMs = 250;   // a held "next" goes back this often

const char* kTag = "board";

esp_lcd_panel_handle_t panel = nullptr;
lv_display_t* lvDisplay = nullptr;
lv_indev_t* encoder = nullptr;
volatile bool back = false;

bool flushed(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void* ctx) {
    lv_display_flush_ready(static_cast<lv_display_t*>(ctx));
    return false;
}

void flush(lv_display_t*, const lv_area_t* area, uint8_t* pixels) {
    // The colour format is big-endian RGB565 already.
    esp_lcd_panel_draw_bitmap(panel, area->x1, area->y1, area->x2 + 1, area->y2 + 1, pixels);
}

uint32_t ticks() { return static_cast<uint32_t>(esp_timer_get_time() / 1000); }

// Two buttons as an encoder: a short press of "next" turns it by one, a
// hold turns it back, repeating; a short press of "enter" is the encoder's
// press, given to LVGL as one pressed read then one released; a hold is
// back, which LVGL never sees.
struct Button {
    gpio_num_t pin;
    bool down = false;
    bool held = false;
    uint32_t since = 0;
    uint32_t repeated = 0;
};
Button next{kNext};
Button enter{kEnter};
int pulse = 0;  // the encoder's press: 1 pressed, then 2 released

void readButtons(lv_indev_t*, lv_indev_data_t* data) {
    uint32_t now = ticks();
    int diff = 0;
    bool n = gpio_get_level(next.pin) == 0;
    if (n && !next.down) {
        next = Button{kNext, true, false, now, now};
    } else if (n && now - next.since >= kHoldMs && now - next.repeated >= (next.held ? kRepeatMs : 0)) {
        diff -= 1;
        next.held = true;
        next.repeated = now;
    } else if (!n && next.down) {
        if (!next.held) diff += 1;
        next.down = false;
    }
    bool e = gpio_get_level(enter.pin) == 0;
    if (e && !enter.down) {
        enter = Button{kEnter, true, false, now, now};
    } else if (e && !enter.held && now - enter.since >= kHoldMs) {
        enter.held = true;
        back = true;
    } else if (!e && enter.down) {
        if (!enter.held && pulse == 0) pulse = 1;
        enter.down = false;
    }
    data->enc_diff = static_cast<int16_t>(diff);
    if (pulse == 1) {
        data->state = LV_INDEV_STATE_PRESSED;
        pulse = 2;
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
        pulse = 0;
    }
}

}  // namespace

void orientation(Orientation o) {
    // The panel's 135x240 window sits in the controller's 240x320 memory, at
    // an offset that depends on the scan direction (LilyGO's values).
    switch (o) {
        case Orientation::Landscape:
            esp_lcd_panel_swap_xy(panel, true);
            esp_lcd_panel_mirror(panel, true, false);
            esp_lcd_panel_set_gap(panel, 40, 53);
            break;
        case Orientation::LandscapeFlipped:
            esp_lcd_panel_swap_xy(panel, true);
            esp_lcd_panel_mirror(panel, false, true);
            esp_lcd_panel_set_gap(panel, 40, 52);
            break;
        case Orientation::Portrait:
            esp_lcd_panel_swap_xy(panel, false);
            esp_lcd_panel_mirror(panel, false, false);
            esp_lcd_panel_set_gap(panel, 52, 40);
            break;
        case Orientation::PortraitFlipped:
            esp_lcd_panel_swap_xy(panel, false);
            esp_lcd_panel_mirror(panel, true, true);
            esp_lcd_panel_set_gap(panel, 53, 40);
            break;
    }
    bool portrait = o == Orientation::Portrait || o == Orientation::PortraitFlipped;
    if (!lvDisplay) return;
    lv_display_set_resolution(lvDisplay, portrait ? kLong : kWide, portrait ? kWide : kLong);
    // A half turn keeps the resolution: redraw everything.
    lv_obj_invalidate(lv_display_get_screen_active(lvDisplay));
    lv_obj_invalidate(lv_display_get_layer_top(lvDisplay));
}

lv_display_t* begin(Orientation o) {
    ledc_timer_config_t timer = {};
    timer.speed_mode = LEDC_LOW_SPEED_MODE;
    timer.duty_resolution = LEDC_TIMER_8_BIT;
    timer.timer_num = LEDC_TIMER_0;
    timer.freq_hz = 5000;
    timer.clk_cfg = LEDC_AUTO_CLK;
    ESP_ERROR_CHECK(ledc_timer_config(&timer));
    ledc_channel_config_t bl = {};
    bl.gpio_num = kBacklight;
    bl.speed_mode = LEDC_LOW_SPEED_MODE;
    bl.channel = LEDC_CHANNEL_0;
    bl.timer_sel = LEDC_TIMER_0;
    ESP_ERROR_CHECK(ledc_channel_config(&bl));

    spi_bus_config_t bus = {};
    bus.sclk_io_num = kSclk;
    bus.mosi_io_num = kMosi;
    bus.miso_io_num = -1;
    bus.quadwp_io_num = -1;
    bus.quadhd_io_num = -1;
    bus.max_transfer_sz = kWide * kBufferLines * 2;
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

    lv_display_t* display = lv_display_create(kWide, kLong);
    esp_lcd_panel_io_handle_t io = nullptr;
    esp_lcd_panel_io_spi_config_t ioc = {};
    ioc.dc_gpio_num = kDc;
    ioc.cs_gpio_num = kCs;
    ioc.pclk_hz = 40 * 1000 * 1000;
    ioc.lcd_cmd_bits = 8;
    ioc.lcd_param_bits = 8;
    ioc.spi_mode = 0;
    ioc.trans_queue_depth = 4;
    ioc.on_color_trans_done = flushed;
    ioc.user_ctx = display;
    // The bus: its host number, which ESP-IDF 5.1 takes as a pointer-sized handle.
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &ioc, &io));
    esp_lcd_panel_dev_config_t pc = {};
    pc.reset_gpio_num = kRst;
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 2, 0)
    pc.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
#else
    pc.rgb_endian = LCD_RGB_ENDIAN_RGB;  // ESP-IDF 5.1's name
#endif
    pc.bits_per_pixel = 16;
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &pc, &panel));
    esp_lcd_panel_reset(panel);
    esp_lcd_panel_init(panel);
    esp_lcd_panel_invert_color(panel, true);  // an IPS panel: inverted, as LilyGO sets it
    orientation(o);
    esp_lcd_panel_disp_on_off(panel, true);

    size_t bytes = static_cast<size_t>(kWide) * kBufferLines * 2;
    void* buf1 = heap_caps_malloc(bytes, MALLOC_CAP_DMA);
    void* buf2 = heap_caps_malloc(bytes, MALLOC_CAP_DMA);
    if (!buf1 || !buf2) ESP_LOGE(kTag, "no memory for the draw buffers");
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565_SWAPPED);
    lv_display_set_buffers(display, buf1, buf2, static_cast<uint32_t>(bytes), LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(display, flush);
    lv_tick_set_cb(ticks);
    lvDisplay = display;
    orientation(o);
    backlight(80);

    gpio_config_t in = {};
    in.pin_bit_mask = (1ULL << kNext) | (1ULL << kEnter);
    in.mode = GPIO_MODE_INPUT;
    in.pull_up_en = GPIO_PULLUP_ENABLE;  // GPIO 35 has none: the board's resistor
    ESP_ERROR_CHECK(gpio_config(&in));
    encoder = lv_indev_create();
    lv_indev_set_type(encoder, LV_INDEV_TYPE_ENCODER);
    lv_indev_set_read_cb(encoder, readButtons);
    lv_indev_set_display(encoder, display);
    return display;
}

void backlight(uint8_t percent) {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, percent >= 100 ? 255 : percent * 255u / 100u);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

lv_indev_t* buttons() { return encoder; }

bool backPressed() {
    bool b = back;
    back = false;
    return b;
}

}  // namespace board
