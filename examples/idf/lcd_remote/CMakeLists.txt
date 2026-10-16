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
# The board's drivers, from ../components: cyd (the two-port cheap yellow
# display, touch) by default, or tdisplay (LilyGO T-Display, two buttons):
#   idf.py -DBOARD=tdisplay -B build-tdisplay build
if(NOT BOARD)
    set(BOARD cyd)
endif()
set(BOARD "${BOARD}" CACHE STRING "The board: cyd or tdisplay" FORCE)
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/../components/${BOARD}/board.h")
    message(FATAL_ERROR "BOARD=${BOARD}: no such board in ../components (cyd, tdisplay)")
endif()
set(EXTRA_COMPONENT_DIRS "${TESSERUI_PATH}" "${TESSERAPI_PATH}" "${NOWTP_PATH}" "${CMAKE_CURRENT_LIST_DIR}/../components/${BOARD}")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(tesserui_lcd_remote)
