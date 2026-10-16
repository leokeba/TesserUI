# The "cheap yellow display" with two USB ports (ESP32-2432S028): its panel,
# touch, backlight, RGB LED and light sensor, for the LCD examples.
if("${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}" VERSION_GREATER_EQUAL "5.3")
    set(CYD_DRIVERS esp_driver_gpio esp_driver_spi esp_driver_ledc)
else()
    set(CYD_DRIVERS driver)
endif()
idf_component_register(SRCS "board.cpp"
                       INCLUDE_DIRS "."
                       REQUIRES ${CYD_DRIVERS} esp_lcd esp_adc esp_timer)
