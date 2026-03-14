cmake_minimum_required(VERSION 3.15)
project(backtest_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

#Release flags for hot-loop performance
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(
  $<$<CONFIG:Release>:-O3>
  $<$<CONFIG:Release>:-march=native>
  $<$<CONFIG:Release>:-ffast-math>
)

#Locate Python + pybind11 
# Preferred: pybind11 installed via pip  (pip install pybind11)
find_package(pybind11 CONFIG REQUIRED)

#Extension module
pybind11_add_module(backtest_core backtest_core.cpp)

# ptional: strip the .so in Release to keep it lean
if(CMAKE_BUILD_TYPE STREQUAL "Release" AND UNIX AND NOT APPLE)
  target_link_options(backtest_core PRIVATE -s)
endif()

#Install alongside the Python sources 
install(TARGETS backtest_core DESTINATION .)