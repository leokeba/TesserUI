#include "board.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_adc/adc_oneshot.h"
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

// Display: SPI2 (HSPI)
constexpr gpio_num_t kTftSclk = GPIO_NUM_14;
constexpr gpio_num_t kTftMosi = GPIO_NUM_13;
constexpr gpio_num_t kTftMiso = GPIO_NUM_12;
constexpr gpio_num_t kTftCs = GPIO_NUM_15;
constexpr gpio_num_t kTftDc = GPIO_NUM_2;
constexpr gpio_num_t kBacklight = GPIO_NUM_21;
// Touch: SPI3 (VSPI)
constexpr gpio_num_t kTouchClk = GPIO_NUM_25;
constexpr gpio_num_t kTouchMosi = GPIO_NUM_32;
constexpr gpio_num_t kTouchMiso = GPIO_NUM_39;
constexpr gpio_num_t kTouchCs = GPIO_NUM_33;
// RGB LED, active low
constexpr gpio_num_t kLed[3] = {GPIO_NUM_4, GPIO_NUM_16, GPIO_NUM_17};
// Light sensor: GPIO 34, ADC1 channel 6
constexpr adc_channel_t kLightChannel = ADC_CHANNEL_6;

constexpr int32_t kWidth = 320;
constexpr int32_t kHeight = 240;
constexpr int32_t kBufferLines = 24;  // 1/10 of the screen per buffer (section 10.2)

// Touch calibration (landscape, as the panel is set up below): the
// controller's raw Y follows the screen's x and its raw X the screen's y,
// both reversed. Measured on one board at the corners.
constexpr int32_t kRawYLeft = 3860, kRawYRight = 230;
constexpr int32_t kRawXTop = 3808, kRawXBottom = 495;
constexpr int kMinPressure = 120;

const char* kTag = "board";

esp_lcd_panel_handle_t panel = nullptr;
lv_display_t* lvDisplay = nullptr;
Orientation current = Orientation::Landscape;
spi_device_handle_t touch = nullptr;
adc_oneshot_unit_handle_t adc = nullptr;

Stats counters;

bool flushed(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void* ctx) {
    counters.flushed++;
    lv_display_flush_ready(static_cast<lv_display_t*>(ctx));
    return false;
}

void flush(lv_display_t* display, const lv_area_t* area, uint8_t* pixels) {
    counters.flushes++;
    // The colour format is big-endian RGB565 already: the bytes go as they are.
    esp_lcd_panel_draw_bitmap(panel, area->x1, area->y1, area->x2 + 1, area->y2 + 1, pixels);
    (void)display;  // flushed() reports the end of the transfer
}

int xpt2046(uint8_t command) {
    spi_transaction_t t = {};
    uint8_t tx[3] = {command, 0, 0};
    uint8_t rx[3] = {};
    t.length = 24;
    t.tx_buffer = tx;
    t.rx_buffer = rx;
    spi_device_polling_transmit(touch, &t);
    return ((rx[1] << 8) | rx[2]) >> 3;
}

int32_t map(int32_t v, int32_t from0, int32_t from1, int32_t to) {
    int32_t out = (v - from0) * to / (from1 - from0);
    return out < 0 ? 0 : out >= to ? to - 1 : out;
}

void readTouch(lv_indev_t*, lv_indev_data_t* data) {
    static int32_t lastX = 0, lastY = 0;
    data->state = LV_INDEV_STATE_RELEASED;
    // The pressure, on every read: these commands keep the ADC powered,
    // which disables the controller's PENIRQ line (GPIO 36).
    if (xpt2046(0xB1) >= kMinPressure) {
        // The first conversion after a press is noisy: average the next ones.
        xpt2046(0xD1);
        int32_t rx = 0, ry = 0;
        for (int i = 0; i < 4; i++) {
            rx += xpt2046(0xD1);
            ry += xpt2046(0x91);
        }
        rx /= 4;
        ry /= 4;
        // Lifted during the reading: keep the last point.
        if (xpt2046(0xB1) >= kMinPressure) {
            // Calibrated in landscape, then turned as the panel is (see
            // orientation()).
            int32_t lx = map(ry, kRawYLeft, kRawYRight, kWidth);
            int32_t ly = map(rx, kRawXTop, kRawXBottom, kHeight);
            switch (current) {
                case Orientation::Landscape:
                    lastX = lx;
                    lastY = ly;
                    break;
                case Orientation::LandscapeFlipped:
                    lastX = kWidth - 1 - lx;
                    lastY = kHeight - 1 - ly;
                    break;
                case Orientation::Portrait:
                    lastX = ly;
                    lastY = kWidth - 1 - lx;
                    break;
                case Orientation::PortraitFlipped:
                    lastX = kHeight - 1 - ly;
                    lastY = lx;
                    break;
            }
            data->state = LV_INDEV_STATE_PRESSED;
            counters.touches++;
            counters.x = lastX;
            counters.y = lastY;
        }
    }
    data->point.x = lastX;
    data->point.y = lastY;
}

uint32_t ticks() { return static_cast<uint32_t>(esp_timer_get_time() / 1000); }

void pwm(ledc_channel_t channel, gpio_num_t pin, bool invert) {
    ledc_channel_config_t c = {};
    c.gpio_num = pin;
    c.speed_mode = LEDC_LOW_SPEED_MODE;
    c.channel = channel;
    c.timer_sel = LEDC_TIMER_0;
    c.duty = 0;
    c.flags.output_invert = invert ? 1 : 0;
    ESP_ERROR_CHECK(ledc_channel_config(&c));
}

void duty(ledc_channel_t channel, uint32_t value) {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, channel, value);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, channel);
}

}  // namespace

void orientation(Orientation o) {
    current = o;
    // The panel is 240x320: landscape exchanges rows and columns. Rows are
    // flipped on this board (measured), and each half turn flips both.
    switch (o) {
        case Orientation::Landscape:
            esp_lcd_panel_swap_xy(panel, true);
            esp_lcd_panel_mirror(panel, false, true);
            break;
        case Orientation::LandscapeFlipped:
            esp_lcd_panel_swap_xy(panel, true);
            esp_lcd_panel_mirror(panel, true, false);
            break;
        case Orientation::Portrait:
            esp_lcd_panel_swap_xy(panel, false);
            esp_lcd_panel_mirror(panel, false, false);
            break;
        case Orientation::PortraitFlipped:
            esp_lcd_panel_swap_xy(panel, false);
            esp_lcd_panel_mirror(panel, true, true);
            break;
    }
    bool portrait = o == Orientation::Portrait || o == Orientation::PortraitFlipped;
    if (!lvDisplay) return;
    lv_display_set_resolution(lvDisplay, portrait ? kHeight : kWidth, portrait ? kWidth : kHeight);
    // A half turn keeps the resolution, so LVGL wouldn't redraw: the panel
    // would show the last frame flipped.
    lv_obj_invalidate(lv_display_get_screen_active(lvDisplay));
    lv_obj_invalidate(lv_display_get_layer_top(lvDisplay));
}

lv_display_t* begin(Orientation o) {
    // Backlight and LED: 8-bit PWM at 5 kHz.
    ledc_timer_config_t timer = {};
    timer.speed_mode = LEDC_LOW_SPEED_MODE;
    timer.duty_resolution = LEDC_TIMER_8_BIT;
    timer.timer_num = LEDC_TIMER_0;
    timer.freq_hz = 5000;
    timer.clk_cfg = LEDC_AUTO_CLK;
    ESP_ERROR_CHECK(ledc_timer_config(&timer));
    pwm(LEDC_CHANNEL_0, kBacklight, false);
    for (int i = 0; i < 3; i++) pwm(static_cast<ledc_channel_t>(LEDC_CHANNEL_1 + i), kLed[i], true);

    adc_oneshot_unit_init_cfg_t unit = {};
    unit.unit_id = ADC_UNIT_1;
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit, &adc));
    adc_oneshot_chan_cfg_t chan = {};
    chan.atten = ADC_ATTEN_DB_0;  // the sensor's divider only moves the pin a little: the finest range
    chan.bitwidth = ADC_BITWIDTH_12;
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc, kLightChannel, &chan));

    // Panel
    spi_bus_config_t bus = {};
    bus.sclk_io_num = kTftSclk;
    bus.mosi_io_num = kTftMosi;
    bus.miso_io_num = kTftMiso;
    bus.quadwp_io_num = -1;
    bus.quadhd_io_num = -1;
    bus.max_transfer_sz = kWidth * kBufferLines * 2;
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

    lv_display_t* display = lv_display_create(kWidth, kHeight);
    esp_lcd_panel_io_handle_t io = nullptr;
    esp_lcd_panel_io_spi_config_t ioc = {};
    ioc.dc_gpio_num = kTftDc;
    ioc.cs_gpio_num = kTftCs;
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
    pc.reset_gpio_num = GPIO_NUM_NC;  // tied to EN
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 2, 0)
    pc.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
#else
    pc.rgb_endian = LCD_RGB_ENDIAN_RGB;  // ESP-IDF 5.1's name
#endif
    pc.bits_per_pixel = 16;
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &pc, &panel));
    esp_lcd_panel_reset(panel);
    esp_lcd_panel_init(panel);
    orientation(o);
    esp_lcd_panel_disp_on_off(panel, true);

    size_t bytes = static_cast<size_t>(kWidth) * kBufferLines * 2;
    void* buf1 = heap_caps_malloc(bytes, MALLOC_CAP_DMA);
    void* buf2 = heap_caps_malloc(bytes, MALLOC_CAP_DMA);
    if (!buf1 || !buf2) ESP_LOGE(kTag, "no memory for the draw buffers");
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565_SWAPPED);
    lv_display_set_buffers(display, buf1, buf2, static_cast<uint32_t>(bytes), LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(display, flush);
    lvDisplay = display;
    orientation(o);  // LVGL's resolution
    lv_tick_set_cb(ticks);
    backlight(80);

    // Touch
    spi_bus_config_t tbus = {};
    tbus.sclk_io_num = kTouchClk;
    tbus.mosi_io_num = kTouchMosi;
    tbus.miso_io_num = kTouchMiso;
    tbus.quadwp_io_num = -1;
    tbus.quadhd_io_num = -1;
    ESP_ERROR_CHECK(spi_bus_initialize(SPI3_HOST, &tbus, SPI_DMA_DISABLED));
    spi_device_interface_config_t tdev = {};
    tdev.clock_speed_hz = 1000 * 1000;
    tdev.mode = 0;
    tdev.spics_io_num = kTouchCs;
    tdev.queue_size = 1;
    ESP_ERROR_CHECK(spi_bus_add_device(SPI3_HOST, &tdev, &touch));
    lv_indev_t* pointer = lv_indev_create();
    lv_indev_set_type(pointer, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(pointer, readTouch);
    lv_indev_set_display(pointer, display);
    return display;
}

void backlight(uint8_t percent) { duty(LEDC_CHANNEL_0, percent >= 100 ? 255 : percent * 255u / 100u); }

void led(uint8_t r, uint8_t g, uint8_t b) {
    duty(LEDC_CHANNEL_1, r);
    duty(LEDC_CHANNEL_2, g);
    duty(LEDC_CHANNEL_3, b);
}

const Stats& stats() { return counters; }

int lightRaw() {
    int raw = 0;
    if (adc_oneshot_read(adc, kLightChannel, &raw) != ESP_OK) return -1;
    return raw;
}

uint8_t light() {
    // The sensor pulls the pin down in light: 0 in a lit room, a few hundred
    // counts covered, and noisy. An average of 32 readings, 800 counts dark.
    int sum = 0;
    for (int i = 0; i < 32; i++) {
        int raw = lightRaw();
        sum += raw < 0 ? 0 : raw;
    }
    int percent = 100 - sum / 32 * 100 / 800;
    return static_cast<uint8_t>(percent < 0 ? 0 : percent > 100 ? 100 : percent);
}

}  // namespace board
