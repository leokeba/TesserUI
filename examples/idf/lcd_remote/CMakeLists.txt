cmake_minimum_required(VERSION 3.16)
# TesserUI is this repository; TesserAPI and NowTP are found through
# TESSERAPI_PATH and NOWTP_PATH, by default checkouts next to it.
get_filename_component(TESSERUI_PATH "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
if(DEFINED ENV{TESSERAPI_PATH})
    get_filename_component(TESSERAPI_PATH "$ENV{TESSERAPI_PATH}" ABSOLUTE)
else()
    get_filename_component(TESSERAPI_PATH "${TESSERUI_PATH}/../TesserAPI" ABSOLUTE)
endif()
if(DEFINED ENV{NOWTP_PATH})
    get_filename_component(NOWTP_PATH "$ENV{NOWTP_PATH}" ABSOLUTE)
else()
    get_filename_component(NOWTP_PATH "${TESSERUI_PATH}/../NowTP" ABSOLUTE)
endif()
foreach(p TESSERAPI_PATH NOWTP_PATH)
    if(NOT EXISTS "${${p}}/CMakeLists.txt")
        message(FATAL_ERROR "${p}: nothing at ${${p}}: clone TesserAPI and NowTP from https://github.com/leokeba "
                            "next to this repository, or set ${p}")
    endif()
endforeach()
# ../components: the board's drivers, shared with lcd_local.
set(EXTRA_COMPONENT_DIRS "${TESSERUI_PATH}" "${TESSERAPI_PATH}" "${NOWTP_PATH}" "${CMAKE_CURRENT_LIST_DIR}/../components")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(tesserui_lcd_remote)
