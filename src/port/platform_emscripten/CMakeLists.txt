# YSFLIGHT platform layer for Emscripten (ysflight-web).
# fsplatform with mouse-as-joystick support plus an OpenAL-based sound
# implementation.

set(TARGET_NAME ysflight_platform_emscripten)

add_library(${TARGET_NAME}
	fsplatform_emscripten.cpp
	fswebxr.cpp
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

# ---------------------------------------------------------------------------
# Polygon Crest for the browser (ysgebl_web): CaptainYS' official 3D model
# editor as a SECOND wasm target.  Upstream already builds every editor
# library (geblgui & friends) under EMSCRIPTEN and skips only the per-platform
# main, which provides exactly three PolyCre* factory functions — supplied by
# the thin glue in ../ysgebl/.  FsLazyWindowApplicationBase::GetApplication()
# lives inside geblgui (fsgui3dmain.cpp), and the ysflight-web fslazywindow /
# fssimplewindow ports are app-agnostic, so no other bootstrapping is needed.
# ---------------------------------------------------------------------------
if(EMSCRIPTEN)
	# The public tree root, mirroring the lookup in the engine's src/CMakeLists.
	if(EXISTS ${CMAKE_SOURCE_DIR}/../public/src)
		set(YSGEBL_PUBLIC_ROOT ${CMAKE_SOURCE_DIR}/../public)
	else()
		set(YSGEBL_PUBLIC_ROOT ${CMAKE_SOURCE_DIR}/../../public)
	endif()

	add_executable(ysgebl_web
		${YSFLIGHT_WEB_PORT_DIR}/ysgebl/ysgebl_gui_extension_web.cpp
	)
	target_include_directories(ysgebl_web PRIVATE
		${YSGEBL_PUBLIC_ROOT}/src/ysgebl/src/gui
		${YSGEBL_PUBLIC_ROOT}/src/ysgebl/src/gui_foundation
	)
	target_link_libraries(ysgebl_web
		geblgui
		geblgui_foundation
		geblutil
		geblkernel
		geblgl_gl2
		geblgl
		fsgui3d_gl2
		fsguilib_gl2
		fsguifiledialog
		ysglcpp_gl2
		ysglcpp
		ysgl
		ysbitmap
		ysbitmapfont
		yssystemfont
		ysfontrenderer
		ysport
		ysclass
		fslazywindow
	)
	set_target_properties(ysgebl_web PROPERTIES SUFFIX ".js")
	target_link_options(ysgebl_web PRIVATE
		-sFULL_ES2=1
		-sASSERTIONS=1
		-sALLOW_MEMORY_GROWTH=1
		-sSTACK_SIZE=8388608
		-sFORCE_FILESYSTEM=1
		-sEXIT_RUNTIME=0
		-sENVIRONMENT=web
		-sEXPORTED_RUNTIME_METHODS=FS,IDBFS,UTF8ToString,stringToUTF8,ENV
		-sEXPORTED_FUNCTIONS=_main,_malloc,_free
		# No ASYNCIFY: the editor reads only VFS-resident files (no lazy packs).
		"SHELL:--preload-file ${YSGEBL_PUBLIC_ROOT}/src/ysgebl/runtime@/ysgebl"
		-lidbfs.js
	)
endif()
