# YSFLIGHT platform layer for Emscripten (ysflight-web).
# fsplatform with mouse-as-joystick support plus an OpenAL-based sound
# implementation.

set(TARGET_NAME ysflight_platform_emscripten)

add_library(${TARGET_NAME}
	fsplatform_emscripten.cpp
	${CMAKE_SOURCE_DIR}/sounddll/yswavfile/yswavfile.cpp
	fsairsound_emscripten.cpp
)

target_include_directories(${TARGET_NAME} PRIVATE
	${CMAKE_SOURCE_DIR}
	${CMAKE_SOURCE_DIR}/platform/common
	${CMAKE_SOURCE_DIR}/sounddll
	${CMAKE_SOURCE_DIR}/sounddll/yswavfile
	${CMAKE_SOURCE_DIR}/voicedll
)

target_link_libraries(${TARGET_NAME}
	geblkernel
	geblgl
	ysclass
	ysscenery_dnm
	ysflight_common
	ysflight_core
	fssimplewindow
)
