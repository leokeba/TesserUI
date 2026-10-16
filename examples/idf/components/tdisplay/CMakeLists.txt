# LilyGO TTGO T-Display (ESP32, 1.14" ST7789 135x240, two buttons): its panel,
# backlight and buttons, for the LCD examples (lcd_remote with -DBOARD=tdisplay).
if("${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}" VERSION_GREATER_EQUAL "5.3")
    set(BOARD_DRIVERS esp_driver_gpio esp_driver_spi esp_driver_ledc)
else()
    set(BOARD_DRIVERS driver)
endif()
idf_component_register(SRCS "board.cpp"
                       INCLUDE_DIRS "."
                       REQUIRES ${BOARD_DRIVERS} esp_lcd esp_timer)
