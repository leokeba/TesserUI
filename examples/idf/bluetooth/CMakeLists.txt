cmake_minimum_required(VERSION 3.16)
# TesserAPI is found through TESSERAPI_PATH, by default a checkout next to
# this repository (../TesserAPI from its root).
get_filename_component(TESSERUI_PATH "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
if(DEFINED ENV{TESSERAPI_PATH})
    get_filename_component(TESSERAPI_PATH "$ENV{TESSERAPI_PATH}" ABSOLUTE)
else()
    get_filename_component(TESSERAPI_PATH "${TESSERUI_PATH}/../TesserAPI" ABSOLUTE)
endif()
if(NOT EXISTS "${TESSERAPI_PATH}/CMakeLists.txt")
    message(FATAL_ERROR "TesserAPI not found at ${TESSERAPI_PATH}: clone https://github.com/leokeba/TesserAPI "
                        "there, or set TESSERAPI_PATH")
endif()
set(EXTRA_COMPONENT_DIRS "${TESSERAPI_PATH}")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(tesserui_bluetooth)
