# ESP-IDF component when built by idf.py, host library + tests otherwise.
set(TESSERUI_CORE_SRCS
    src/tesserui/model.cpp
    src/tesserui/views.cpp
    src/tesserui/web_page.cpp)

if(ESP_PLATFORM)
    # TesserAPI is a hard dependency. Its component name depends on how it was
    # added: "TesserAPI" (the repository's directory, via EXTRA_COMPONENT_DIRS),
    # "tesserapi" or "<namespace>__tesserapi" (component manager). Requirements
    # are resolved before the component list is known, so it is found here and
    # linked below rather than listed in REQUIRES.
    idf_build_get_property(TESSERUI_BUILD_COMPONENTS BUILD_COMPONENTS)
    set(TESSERUI_TESSERAPI "")
    foreach(c ${TESSERUI_BUILD_COMPONENTS})
        string(TOLOWER "${c}" c_lower)
        if(c_lower MATCHES "(^|__)tesserapi$")
            set(TESSERUI_TESSERAPI ${c})
        endif()
    endforeach()
    if(NOT TESSERUI_TESSERAPI AND NOT CMAKE_BUILD_EARLY_EXPANSION)
        message(FATAL_ERROR "TesserUI needs TesserAPI (https://github.com/leokeba/TesserAPI): add it to "
                            "EXTRA_COMPONENT_DIRS or as a component manager dependency.")
    endif()
    # LvglUi is built when LVGL is part of the build ("lvgl", or
    # "lvgl__lvgl" from the component manager), found like TesserAPI.
    set(TESSERUI_LVGL_COMPONENT "")
    foreach(c ${TESSERUI_BUILD_COMPONENTS})
        string(TOLOWER "${c}" c_lower)
        if(c_lower MATCHES "(^|__)lvgl$")
            set(TESSERUI_LVGL_COMPONENT ${c})
        endif()
    endforeach()
    idf_component_register(
        SRCS ${TESSERUI_CORE_SRCS} src/tesserui/web_ui.cpp src/tesserui/lvgl_ui.cpp
        INCLUDE_DIRS "src"
        REQUIRES esp_http_server)
    # Public: TesserUI's headers include TesserAPI's (and LVGL's).
    idf_component_get_property(TESSERUI_TESSERAPI_LIB ${TESSERUI_TESSERAPI} COMPONENT_LIB)
    target_link_libraries(${COMPONENT_LIB} PUBLIC ${TESSERUI_TESSERAPI_LIB})
    if(TESSERUI_LVGL_COMPONENT)
        idf_component_get_property(TESSERUI_LVGL_LIB ${TESSERUI_LVGL_COMPONENT} COMPONENT_LIB)
        target_link_libraries(${COMPONENT_LIB} PUBLIC ${TESSERUI_LVGL_LIB})
    endif()
    return()
endif()

cmake_minimum_required(VERSION 3.16)
project(tesserui CXX)

option(TESSERUI_BUILD_TESTS "Build host-side tests and the fixture generator" ON)
option(TESSERUI_SANITIZE "Build tests with ASan/UBSan" ON)
option(TESSERUI_LVGL "Build the LVGL renderer's tests and simulator (fetches LVGL)" ON)
set(TESSERAPI_DIR "" CACHE PATH "TesserAPI source tree (default: ../TesserAPI if present, else fetched from GitHub)")

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# TesserAPI, for tesser_core (and ArduinoJson through it).
# A parent project that already added it (TesserMotion, TesserKIT) keeps its own.
if(NOT TARGET tesser_core)
    set(TESSER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    if(NOT TESSERAPI_DIR AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../TesserAPI/CMakeLists.txt")
        get_filename_component(TESSERAPI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../TesserAPI" ABSOLUTE)
        set(TESSERAPI_DIR "${TESSERAPI_DIR}" CACHE PATH "" FORCE)
    endif()
    if(TESSERAPI_DIR)
        message(STATUS "TesserAPI: ${TESSERAPI_DIR}")
        add_subdirectory("${TESSERAPI_DIR}" "${CMAKE_BINARY_DIR}/tesserapi")
    else()
        message(STATUS "TesserAPI: fetching https://github.com/leokeba/TesserAPI.git")
        include(FetchContent)
        FetchContent_Declare(tesserapi
            GIT_REPOSITORY https://github.com/leokeba/TesserAPI.git
            GIT_TAG main
            GIT_SHALLOW ON)
        FetchContent_MakeAvailable(tesserapi)
    endif()
endif()

set(TESSERUI_WARNINGS -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Werror -fno-exceptions -fno-rtti)

add_library(tesserui_core ${TESSERUI_CORE_SRCS})
target_include_directories(tesserui_core PUBLIC src)
target_link_libraries(tesserui_core PUBLIC tesser_core)
set_target_properties(tesserui_core PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON CXX_EXTENSIONS OFF)
target_compile_options(tesserui_core PRIVATE ${TESSERUI_WARNINGS})

if(TESSERUI_BUILD_TESTS)
    enable_testing()
    add_executable(tesserui_tests test/test_main.cpp test/model_tests.cpp)
    target_compile_definitions(tesserui_tests PRIVATE TESSERUI_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures")
    add_executable(tesserui_fixtures test/fixtures_main.cpp test/trees.cpp)
    # A live demo node on stdin/stdout, for renderer tests (not run by ctest).
    add_executable(tesserui_demo test/demo_main.cpp test/trees.cpp)
    foreach(t tesserui_tests tesserui_fixtures tesserui_demo)
        target_link_libraries(${t} PRIVATE tesserui_core)
        target_include_directories(${t} PRIVATE test)
        set_target_properties(${t} PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
        target_compile_options(${t} PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
    endforeach()
    if(TESSERUI_SANITIZE)
        # tesser_core too, so the whole binary is instrumented alike.
        foreach(t tesser_core tesserui_core tesserui_tests tesserui_fixtures tesserui_demo)
            target_compile_options(${t} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer -g)
            target_link_options(${t} PRIVATE -fsanitize=address,undefined)
        endforeach()
    endif()
    add_test(NAME tesserui_tests COMMAND tesserui_tests)

    # The LVGL renderer: its tests on a screen in memory, and tesserui_lcd, the
    # demo tree in a window (SDL2, when found) or as screenshots.
    if(TESSERUI_LVGL)
        include(FetchContent)
        set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_SOURCE_DIR}/test/lvgl/lv_conf.h" CACHE PATH "" FORCE)
        set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
        set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(CONFIG_LV_USE_THORVG OFF CACHE BOOL "" FORCE)
        set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
        set(LV_BUILD_INSTALL OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(lvgl
            GIT_REPOSITORY https://github.com/lvgl/lvgl.git
            GIT_TAG v9.6.0
            GIT_SHALLOW ON)
        FetchContent_MakeAvailable(lvgl)
        # LVGL's headers are a dependency's: no warnings from them.
        get_target_property(TESSERUI_LVGL_INCLUDES lvgl INTERFACE_INCLUDE_DIRECTORIES)
        set_target_properties(lvgl PROPERTIES INTERFACE_SYSTEM_INCLUDE_DIRECTORIES "${TESSERUI_LVGL_INCLUDES}")
        find_package(SDL2 CONFIG QUIET)
        if(SDL2_FOUND)
            message(STATUS "SDL2 found: tesserui_lcd opens a window")
            target_compile_definitions(lvgl PUBLIC TESSERUI_SDL=1)
            target_link_libraries(lvgl PUBLIC SDL2::SDL2)
        endif()

        add_library(tesserui_lvgl src/tesserui/lvgl_ui.cpp)
        target_link_libraries(tesserui_lvgl PUBLIC tesserui_core lvgl)
        set_target_properties(tesserui_lvgl PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON CXX_EXTENSIONS OFF)
        target_compile_options(tesserui_lvgl PRIVATE ${TESSERUI_WARNINGS})

        add_executable(tesserui_lcd_tests test/lcd_tests.cpp test/lcd_host.cpp test/trees.cpp)
        add_executable(tesserui_lcd test/lcd_main.cpp test/lcd_host.cpp test/trees.cpp)
        foreach(t tesserui_lcd_tests tesserui_lcd)
            target_link_libraries(${t} PRIVATE tesserui_lvgl)
            target_include_directories(${t} PRIVATE test)
            set_target_properties(${t} PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
            target_compile_options(${t} PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
        endforeach()
        if(TESSERUI_SANITIZE)
            foreach(t lvgl tesserui_lvgl tesserui_lcd_tests tesserui_lcd)
                target_compile_options(${t} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer -g)
                target_link_options(${t} PRIVATE -fsanitize=address,undefined)
            endforeach()
        endif()
        add_test(NAME tesserui_lcd_tests COMMAND tesserui_lcd_tests)
    endif()
    # Checks that the generator runs cleanly; the committed fixtures are
    # regenerated with `./build/tesserui_fixtures fixtures`.
    add_test(NAME tesserui_fixtures COMMAND tesserui_fixtures ${CMAKE_CURRENT_BINARY_DIR}/fixtures)
endif()
