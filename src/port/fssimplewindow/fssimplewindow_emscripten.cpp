/* ////////////////////////////////////////////////////////////

File Name: fssimplewindow_emscripten.cpp

Emscripten (WebAssembly/WebGL) back-end for the fssimplewindow framework,
written for the ysflight-web project.  Modeled on the android and glx
back-ends of fssimplewindow.

Copyright (c) 2026 ysflight-web contributors.
Follows the same BSD-style license as fssimplewindow itself.

//////////////////////////////////////////////////////////// */

#include <emscripten.h>
#include <emscripten/html5.h>
#include <GLES2/gl2.h>

#include <chrono>
#include <string.h>
#include <stdio.h>
#include <unistd.h>

#include <fssimplewindow.h>

// ----------------------------------------------------------------------------
// State

#define NKEYBUF 256

static int keyBuffer[NKEYBUF];
static int nKeyBufUsed=0;
static int charBuffer[NKEYBUF];
static int nCharBufUsed=0;

class FsMouseEventLog
{
public:
	int eventType,lb,mb,rb,mx,my;
};

#define NEVTBUF 256
static int nMosBufUsed=0;
static FsMouseEventLog mosBuffer[NEVTBUF];
static FsMouseEventLog lastKnownMos={FSMOUSEEVENT_NONE,0,0,0,0,0};

static int nTouch=0;
static FsVec2i touchCache[NEVTBUF];

static char keyState[FSKEY_NUM_KEYCODE];

static int winWid=800,winHei=600;
static int windowOpen=0;
static int exposure=0;

static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE webglContext=0;

static const char *CANVAS_SELECTOR="#canvas";

// ----------------------------------------------------------------------------
// Key mapping: KeyboardEvent.code -> FSKEY

class FsKeyCodeMapping
{
public:
	const char *code;
	int fskey;
};

static const FsKeyCodeMapping keyCodeMapping[]=
{
	{"Space",FSKEY_SPACE},
	{"Digit0",FSKEY_0},{"Digit1",FSKEY_1},{"Digit2",FSKEY_2},{"Digit3",FSKEY_3},{"Digit4",FSKEY_4},
	{"Digit5",FSKEY_5},{"Digit6",FSKEY_6},{"Digit7",FSKEY_7},{"Digit8",FSKEY_8},{"Digit9",FSKEY_9},
	{"KeyA",FSKEY_A},{"KeyB",FSKEY_B},{"KeyC",FSKEY_C},{"KeyD",FSKEY_D},{"KeyE",FSKEY_E},
	{"KeyF",FSKEY_F},{"KeyG",FSKEY_G},{"KeyH",FSKEY_H},{"KeyI",FSKEY_I},{"KeyJ",FSKEY_J},
	{"KeyK",FSKEY_K},{"KeyL",FSKEY_L},{"KeyM",FSKEY_M},{"KeyN",FSKEY_N},{"KeyO",FSKEY_O},
	{"KeyP",FSKEY_P},{"KeyQ",FSKEY_Q},{"KeyR",FSKEY_R},{"KeyS",FSKEY_S},{"KeyT",FSKEY_T},
	{"KeyU",FSKEY_U},{"KeyV",FSKEY_V},{"KeyW",FSKEY_W},{"KeyX",FSKEY_X},{"KeyY",FSKEY_Y},
	{"KeyZ",FSKEY_Z},
	{"Escape",FSKEY_ESC},
	{"F1",FSKEY_F1},{"F2",FSKEY_F2},{"F3",FSKEY_F3},{"F4",FSKEY_F4},{"F5",FSKEY_F5},{"F6",FSKEY_F6},
	{"F7",FSKEY_F7},{"F8",FSKEY_F8},{"F9",FSKEY_F9},{"F10",FSKEY_F10},{"F11",FSKEY_F11},{"F12",FSKEY_F12},
	{"PrintScreen",FSKEY_PRINTSCRN},
	{"CapsLock",FSKEY_CAPSLOCK},
	{"ScrollLock",FSKEY_SCROLLLOCK},
	{"Pause",FSKEY_PAUSEBREAK},
	{"Backspace",FSKEY_BS},
	{"Tab",FSKEY_TAB},
	{"Enter",FSKEY_ENTER},
	{"ShiftLeft",FSKEY_SHIFT},{"ShiftRight",FSKEY_SHIFT},
	{"ControlLeft",FSKEY_CTRL},{"ControlRight",FSKEY_CTRL},
	{"AltLeft",FSKEY_ALT},{"AltRight",FSKEY_ALT},
	{"Insert",FSKEY_INS},
	{"Delete",FSKEY_DEL},
	{"Home",FSKEY_HOME},
	{"End",FSKEY_END},
	{"PageUp",FSKEY_PAGEUP},
	{"PageDown",FSKEY_PAGEDOWN},
	{"ArrowUp",FSKEY_UP},
	{"ArrowDown",FSKEY_DOWN},
	{"ArrowLeft",FSKEY_LEFT},
	{"ArrowRight",FSKEY_RIGHT},
	{"NumLock",FSKEY_NUMLOCK},
	{"Backquote",FSKEY_TILDA},
	{"Minus",FSKEY_MINUS},
	{"Equal",FSKEY_PLUS},
	{"BracketLeft",FSKEY_LBRACKET},
	{"BracketRight",FSKEY_RBRACKET},
	{"Backslash",FSKEY_BACKSLASH},
	{"Semicolon",FSKEY_SEMICOLON},
	{"Quote",FSKEY_SINGLEQUOTE},
	{"Comma",FSKEY_COMMA},
	{"Period",FSKEY_DOT},
	{"Slash",FSKEY_SLASH},
	{"Numpad0",FSKEY_TEN0},{"Numpad1",FSKEY_TEN1},{"Numpad2",FSKEY_TEN2},{"Numpad3",FSKEY_TEN3},
	{"Numpad4",FSKEY_TEN4},{"Numpad5",FSKEY_TEN5},{"Numpad6",FSKEY_TEN6},{"Numpad7",FSKEY_TEN7},
	{"Numpad8",FSKEY_TEN8},{"Numpad9",FSKEY_TEN9},
	{"NumpadDecimal",FSKEY_TENDOT},
	{"NumpadDivide",FSKEY_TENSLASH},
	{"NumpadMultiply",FSKEY_TENSTAR},
	{"NumpadSubtract",FSKEY_TENMINUS},
	{"NumpadAdd",FSKEY_TENPLUS},
	{"NumpadEnter",FSKEY_TENENTER},
	{"ContextMenu",FSKEY_CONTEXT},
	{"Convert",FSKEY_CONVERT},
	{"NonConvert",FSKEY_NONCONVERT},
	{"KanaMode",FSKEY_KANA},
	{"IntlRo",FSKEY_RO},
	{nullptr,FSKEY_NULL}
};

static int FsKeyCodeFromDomCode(const char code[])
{
	for(int i=0; nullptr!=keyCodeMapping[i].code; ++i)
	{
		if(0==strcmp(code,keyCodeMapping[i].code))
		{
			return keyCodeMapping[i].fskey;
		}
	}
	return FSKEY_NULL;
}

// ----------------------------------------------------------------------------
// Event queue helpers

static void PushMouseEvent(int evt,int lb,int mb,int rb,int mx,int my)
{
	if(nMosBufUsed<NEVTBUF)
	{
		mosBuffer[nMosBufUsed].eventType=evt;
		mosBuffer[nMosBufUsed].lb=lb;
		mosBuffer[nMosBufUsed].mb=mb;
		mosBuffer[nMosBufUsed].rb=rb;
		mosBuffer[nMosBufUsed].mx=mx;
		mosBuffer[nMosBufUsed].my=my;
		lastKnownMos=mosBuffer[nMosBufUsed];
		nMosBufUsed++;
	}
	else
	{
		lastKnownMos.eventType=evt;
		lastKnownMos.lb=lb;
		lastKnownMos.mb=mb;
		lastKnownMos.rb=rb;
		lastKnownMos.mx=mx;
		lastKnownMos.my=my;
	}
}

void FsPushKey(int fskey)
{
	if(nKeyBufUsed<NKEYBUF)
	{
		keyBuffer[nKeyBufUsed++]=fskey;
	}
}

void FsPushChar(int c)
{
	if(nCharBufUsed<NKEYBUF)
	{
		charBuffer[nCharBufUsed++]=c;
	}
}

// ---- VR text-input bridge (fswebxr.cpp) ------------------------------------
// While the bridge's hidden DOM <input> owns keyboard input (a text box is
// focused on the VR menu quad and the headset's system keyboard is up), the
// window-level callbacks below must stand down: skip the engine push AND
// return EM_FALSE so the browser keeps the default action -- soft keyboards
// deliver their text only through those defaults (the input events on the
// element), which the bridge forwards through FsPushTextEdit instead.
// Guarding here (not unregistering) keeps the flip per-keystroke cheap and
// re-entrant.
static int fsDomTextCapture=0;

extern "C" EMSCRIPTEN_KEEPALIVE void FsSetDomTextCapture(int active)
{
	fsDomTextCapture=(0!=active ? 1 : 0);
}

// One text-editing action from the bridge, mirrored onto the same
// FsPushKey/FsPushChar pair the flat keydown path produces for the physical
// key (so FsGuiTextBox sees no difference).  action: 0=plain character
// (chr), 1=backspace, 2=enter, 3=escape, 4=caret left, 5=caret right,
// 6=delete, 7=home, 8=end, 9=tab.  Numeric actions rather than DOM code
// strings keep the JS->wasm call free of string marshalling.
extern "C" EMSCRIPTEN_KEEPALIVE void FsPushTextEdit(int action,int chr)
{
	switch(action)
	{
	case 0:
		if(0!=chr)
		{
			FsPushChar(chr);
		}
		break;
	case 1:
		FsPushKey(FSKEY_BS);
		FsPushChar(0x08);
		break;
	case 2:
		FsPushKey(FSKEY_ENTER);
		FsPushChar('\n');
		break;
	case 3:
		FsPushKey(FSKEY_ESC);
		break;
	case 4:
		FsPushKey(FSKEY_LEFT);
		break;
	case 5:
		FsPushKey(FSKEY_RIGHT);
		break;
	case 6:
		FsPushKey(FSKEY_DEL);
		break;
	case 7:
		FsPushKey(FSKEY_HOME);
		break;
	case 8:
		FsPushKey(FSKEY_END);
		break;
	case 9:
		FsPushKey(FSKEY_TAB);
		break;
	}
}

// ----------------------------------------------------------------------------
// HTML5 event callbacks

static EM_BOOL FsKeyDownCallback(int,const EmscriptenKeyboardEvent *e,void *)
{
	if(0!=fsDomTextCapture)
	{
		// See fsDomTextCapture's doc comment: the VR text-input bridge's
		// hidden <input> owns this keystroke.
		return EM_FALSE;
	}
	const int fskey=FsKeyCodeFromDomCode(e->code);
	if(FSKEY_NULL!=fskey)
	{
		FsPushKey(fskey);
		keyState[fskey]=1;
		if(FSKEY_SHIFT==fskey)
		{
			keyState[(0==strcmp(e->code,"ShiftLeft")) ? FSKEY_LEFT_SHIFT : FSKEY_RIGHT_SHIFT]=1;
		}
		else if(FSKEY_CTRL==fskey)
		{
			keyState[(0==strcmp(e->code,"ControlLeft")) ? FSKEY_LEFT_CTRL : FSKEY_RIGHT_CTRL]=1;
		}
		else if(FSKEY_ALT==fskey)
		{
			keyState[(0==strcmp(e->code,"AltLeft")) ? FSKEY_LEFT_ALT : FSKEY_RIGHT_ALT]=1;
		}
	}

	// Character input: single-unit key values are characters.
	if(0!=e->key[0] && 0==e->key[1])
	{
		FsPushChar(e->key[0]);
	}
	else if(0==strcmp(e->key,"Enter"))
	{
		FsPushChar('\n');
	}
	else if(0==strcmp(e->key,"Backspace"))
	{
		FsPushChar(0x08);
	}

	// Let the browser keep refresh/devtools/paste-style shortcuts.
	if(0==strcmp(e->code,"F5") || 0==strcmp(e->code,"F12") ||
	   (0!=e->ctrlKey && (0==strcmp(e->code,"KeyV") || 0==strcmp(e->code,"KeyC") || 0==strcmp(e->code,"KeyX"))))
	{
		return EM_FALSE;
	}
	return EM_TRUE;
}

static EM_BOOL FsKeyUpCallback(int,const EmscriptenKeyboardEvent *e,void *)
{
	if(0!=fsDomTextCapture)
	{
		// Mirror FsKeyDownCallback's stand-down so keyState never latches a
		// key whose keydown the bridge consumed.
		return EM_FALSE;
	}
	const int fskey=FsKeyCodeFromDomCode(e->code);
	if(FSKEY_NULL!=fskey)
	{
		keyState[fskey]=0;
		if(FSKEY_SHIFT==fskey)
		{
			keyState[(0==strcmp(e->code,"ShiftLeft")) ? FSKEY_LEFT_SHIFT : FSKEY_RIGHT_SHIFT]=0;
		}
		else if(FSKEY_CTRL==fskey)
		{
			keyState[(0==strcmp(e->code,"ControlLeft")) ? FSKEY_LEFT_CTRL : FSKEY_RIGHT_CTRL]=0;
		}
		else if(FSKEY_ALT==fskey)
		{
			keyState[(0==strcmp(e->code,"AltLeft")) ? FSKEY_LEFT_ALT : FSKEY_RIGHT_ALT]=0;
		}
	}
	return EM_TRUE;
}

static EM_BOOL FsMouseCallback(int eventType,const EmscriptenMouseEvent *e,void *)
{
	const int mx=(int)e->targetX;
	const int my=(int)e->targetY;
	const int lb=(0!=(e->buttons&1)) ? 1 : 0;
	const int rb=(0!=(e->buttons&2)) ? 1 : 0;
	const int mb=(0!=(e->buttons&4)) ? 1 : 0;

	int fsEvent=FSMOUSEEVENT_NONE;
	switch(eventType)
	{
	case EMSCRIPTEN_EVENT_MOUSEDOWN:
		switch(e->button)
		{
		case 0: fsEvent=FSMOUSEEVENT_LBUTTONDOWN; break;
		case 1: fsEvent=FSMOUSEEVENT_MBUTTONDOWN; break;
		case 2: fsEvent=FSMOUSEEVENT_RBUTTONDOWN; break;
		}
		break;
	case EMSCRIPTEN_EVENT_MOUSEUP:
		switch(e->button)
		{
		case 0: fsEvent=FSMOUSEEVENT_LBUTTONUP; break;
		case 1: fsEvent=FSMOUSEEVENT_MBUTTONUP; break;
		case 2: fsEvent=FSMOUSEEVENT_RBUTTONUP; break;
		}
		break;
	case EMSCRIPTEN_EVENT_MOUSEMOVE:
		fsEvent=FSMOUSEEVENT_MOVE;
		break;
	}

	PushMouseEvent(fsEvent,lb,mb,rb,mx,my);
	return EM_TRUE;
}

static EM_BOOL FsWheelCallback(int,const EmscriptenWheelEvent *e,void *)
{
	if(e->deltaY<0)
	{
		FsPushKey(FSKEY_WHEELUP);
	}
	else if(0<e->deltaY)
	{
		FsPushKey(FSKEY_WHEELDOWN);
	}
	return EM_TRUE;
}

static EM_BOOL FsTouchCallback(int eventType,const EmscriptenTouchEvent *e,void *)
{
	int n=0;
	for(int i=0; i<e->numTouches && n<NEVTBUF; ++i)
	{
		if(e->touches[i].isChanged || true) // All current touches
		{
			touchCache[n].v[0]=(int)e->touches[i].targetX;
			touchCache[n].v[1]=(int)e->touches[i].targetY;
			++n;
		}
	}

	if(EMSCRIPTEN_EVENT_TOUCHEND==eventType || EMSCRIPTEN_EVENT_TOUCHCANCEL==eventType)
	{
		// Touches in the list are the ones that left the surface.
		n=0;
	}
	nTouch=n;

	// Single-touch mouse emulation.
	if(EMSCRIPTEN_EVENT_TOUCHSTART==eventType && 1==e->numTouches)
	{
		PushMouseEvent(FSMOUSEEVENT_LBUTTONDOWN,1,0,0,(int)e->touches[0].targetX,(int)e->touches[0].targetY);
	}
	else if((EMSCRIPTEN_EVENT_TOUCHEND==eventType || EMSCRIPTEN_EVENT_TOUCHCANCEL==eventType) && 0==n)
	{
		PushMouseEvent(FSMOUSEEVENT_LBUTTONUP,0,0,0,lastKnownMos.mx,lastKnownMos.my);
	}
	else if(EMSCRIPTEN_EVENT_TOUCHMOVE==eventType && 1<=e->numTouches)
	{
		PushMouseEvent(FSMOUSEEVENT_MOVE,1,0,0,(int)e->touches[0].targetX,(int)e->touches[0].targetY);
	}

	return EM_TRUE;
}

static void FsResizeCanvasToCssSize(void)
{
	double cssWid=0.0,cssHei=0.0;
	if(EMSCRIPTEN_RESULT_SUCCESS==emscripten_get_element_css_size(CANVAS_SELECTOR,&cssWid,&cssHei) &&
	   8.0<cssWid && 8.0<cssHei)
	{
		winWid=(int)cssWid;
		winHei=(int)cssHei;
		emscripten_set_canvas_element_size(CANVAS_SELECTOR,winWid,winHei);
	}
}

static EM_BOOL FsWindowResizeCallback(int,const EmscriptenUiEvent *,void *)
{
	FsResizeCanvasToCssSize();
	exposure=1;
	if(nullptr!=fsOnResizeCallBack)
	{
		(*fsOnResizeCallBack)(fsOnResizeCallBackParam,winWid,winHei);
	}
	return EM_FALSE;
}

// ----------------------------------------------------------------------------
// Window management

void FsOpenWindow(const FsOpenWindowOption &opt)
{
	if(0!=windowOpen)
	{
		return;
	}

	winWid=opt.wid;
	winHei=opt.hei;

	// If the canvas has a CSS-driven size (set by the hosting page), honor it.
	// Otherwise use the size requested by the application.
	double cssWid=0.0,cssHei=0.0;
	if(EMSCRIPTEN_RESULT_SUCCESS==emscripten_get_element_css_size(CANVAS_SELECTOR,&cssWid,&cssHei) &&
	   8.0<cssWid && 8.0<cssHei)
	{
		winWid=(int)cssWid;
		winHei=(int)cssHei;
	}
	emscripten_set_canvas_element_size(CANVAS_SELECTOR,winWid,winHei);

	if(nullptr==fsOpenGLContextCreationCallBack ||
	   true!=(*fsOpenGLContextCreationCallBack)(fsOpenGLContextCreationCallBackParam))
	{
		EmscriptenWebGLContextAttributes attr;
		emscripten_webgl_init_context_attributes(&attr);
		attr.alpha=false;
		attr.depth=true;
		attr.stencil=true;
		attr.antialias=true;
		// WebGL 2.0 context.  ysgl rewrites its shaders to GLSL ES 3.00 at
		// compile time on an ES3 context (see ysglslutil.c) so the shadow-map
		// depth texture samples correctly, and WebGL2 is the prerequisite for
		// single-pass stereo (OVR_multiview2) in VR.
		//
		// Exception: SwiftShader (headless-Chromium software rendering, i.e.
		// CI) crashes its GPU process on this app's WebGL2 command stream
		// (SEGV in the Subzero JIT, nondeterministic context loss during
		// boot); real GPUs are fine.  Sniff the renderer on a throwaway
		// canvas BEFORE choosing the version -- a canvas permanently commits
		// to its first context type, so this cannot be probed on the real
		// canvas.  WebGL1 keeps today's proven ES 1.00 path there.
		const int isSwiftShader=EM_ASM_INT({
			try{
				var cv=document.createElement('canvas');
				var gl=cv.getContext('webgl2')||cv.getContext('webgl');
				if(!gl) return 0;
				var ext=gl.getExtension('WEBGL_debug_renderer_info');
				var r=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
				var lose=gl.getExtension('WEBGL_lose_context');
				if(lose) lose.loseContext();
				return (r && r.indexOf('SwiftShader')>=0)?1:0;
			}catch(e){ return 0; }
		});
		if(0!=isSwiftShader)
		{
			printf("SwiftShader detected: using WebGL1 (this app's WebGL2 command stream crashes its GPU process)\n");
		}
		attr.majorVersion=(0!=isSwiftShader ? 1 : 2);
		attr.minorVersion=0;
		attr.enableExtensionsByDefault=true;
		attr.preserveDrawingBuffer=false;

		webglContext=emscripten_webgl_create_context(CANVAS_SELECTOR,&attr);
		if(webglContext<=0)
		{
			printf("Failed to create WebGL context (%d)\n",(int)webglContext);
			return;
		}
		emscripten_webgl_make_context_current(webglContext);
	}

	windowOpen=1;
	exposure=1;

	// Keyboard events on the whole window so the canvas doesn't need focus.
	emscripten_set_keydown_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW,nullptr,1,FsKeyDownCallback);
	emscripten_set_keyup_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW,nullptr,1,FsKeyUpCallback);

	emscripten_set_mousedown_callback(CANVAS_SELECTOR,nullptr,1,FsMouseCallback);
	emscripten_set_mouseup_callback(CANVAS_SELECTOR,nullptr,1,FsMouseCallback);
	emscripten_set_mousemove_callback(CANVAS_SELECTOR,nullptr,1,FsMouseCallback);
	emscripten_set_wheel_callback(CANVAS_SELECTOR,nullptr,1,FsWheelCallback);

	emscripten_set_touchstart_callback(CANVAS_SELECTOR,nullptr,1,FsTouchCallback);
	emscripten_set_touchend_callback(CANVAS_SELECTOR,nullptr,1,FsTouchCallback);
	emscripten_set_touchmove_callback(CANVAS_SELECTOR,nullptr,1,FsTouchCallback);
	emscripten_set_touchcancel_callback(CANVAS_SELECTOR,nullptr,1,FsTouchCallback);

	emscripten_set_resize_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW,nullptr,1,FsWindowResizeCallback);

	if(nullptr!=fsOpenGLInitializationCallBack)
	{
		(*fsOpenGLInitializationCallBack)(fsOpenGLInitializationCallBackParam);
	}
	if(nullptr!=fsAfterWindowCreationCallBack)
	{
		(*fsAfterWindowCreationCallBack)(fsAfterWindowCreationCallBackParam);
	}
}

int FsCheckWindowOpen(void)
{
	return windowOpen;
}

void FsCloseWindow(void)
{
	windowOpen=0;
}

void FsMaximizeWindow(void)
{
}
void FsUnmaximizeWindow(void)
{
}
void FsMakeFullScreen(void)
{
	emscripten_request_fullscreen(CANVAS_SELECTOR,1);
}
void FsResizeWindow(int,int)
{
	// Canvas size is owned by the hosting page.
}

// Optional window-size override.  The VR HUD off-screen pass (engine side)
// sets this so all pixel-space HUD placement is computed against the HUD
// texture instead of the real canvas.  Kept as a plain local so fssimplewindow
// stays dependency-free (tools that link it without the VR engine, e.g. the
// modeler, simply never call the setter).
static int fsWinSizeOverrideActive=0;
static int fsWinSizeOverrideW=0;
static int fsWinSizeOverrideH=0;

extern "C" void FsSetWindowSizeOverride(int active,int w,int h)
{
	fsWinSizeOverrideActive=(0!=active ? 1 : 0);
	fsWinSizeOverrideW=w;
	fsWinSizeOverrideH=h;
}

void FsGetWindowSize(int &wid,int &hei)
{
	if(0!=fsWinSizeOverrideActive)
	{
		wid=fsWinSizeOverrideW;
		hei=fsWinSizeOverrideH;
		return;
	}
	wid=winWid;
	hei=winHei;
}

void FsGetWindowPosition(int &x0,int &y0)
{
	x0=0;
	y0=0;
}

void FsSetWindowTitle(const char windowTitle[])
{
	emscripten_set_window_title(windowTitle);
}

void FsPushOnPaintEvent(void)
{
	exposure=1;
}

void FsPollDevice(void)
{
	if(nullptr!=fsPollDeviceHook)
	{
		(*fsPollDeviceHook)(fsPollDeviceHookParam);
	}
}

void FsSleep(int)
{
	// Cannot block the browser's main thread.
}

// ----------------------------------------------------------------------------
// Timers

static bool firstTime=true;
static double timeOrigin=0.0;
static double prevTime=0.0;

long long int FsSubSecondTimer(void)
{
	const double now=emscripten_get_now();
	if(true==firstTime)
	{
		firstTime=false;
		timeOrigin=now;
		prevTime=now;
	}
	return (long long int)(now-timeOrigin);
}

long long int FsPassedTime(void)
{
	const double now=emscripten_get_now();
	if(true==firstTime)
	{
		firstTime=false;
		timeOrigin=now;
		prevTime=now;
	}
	long long int passed=(long long int)(now-prevTime);
	prevTime=now;
	if(0==passed)
	{
		passed=1;
	}
	return passed;
}

// ----------------------------------------------------------------------------
// Mouse & keyboard state

void FsGetMouseState(int &lb,int &mb,int &rb,int &mx,int &my)
{
	lb=lastKnownMos.lb;
	mb=lastKnownMos.mb;
	rb=lastKnownMos.rb;
	mx=lastKnownMos.mx;
	my=lastKnownMos.my;
}

int FsGetMouseEvent(int &lb,int &mb,int &rb,int &mx,int &my)
{
	if(0<nMosBufUsed)
	{
		const int eventType=mosBuffer[0].eventType;
		lb=mosBuffer[0].lb;
		mb=mosBuffer[0].mb;
		rb=mosBuffer[0].rb;
		mx=mosBuffer[0].mx;
		my=mosBuffer[0].my;

		--nMosBufUsed;
		for(int i=0; i<nMosBufUsed; ++i)
		{
			mosBuffer[i]=mosBuffer[i+1];
		}
		return eventType;
	}
	else
	{
		FsGetMouseState(lb,mb,rb,mx,my);
		return FSMOUSEEVENT_NONE;
	}
}

void FsSetMousePosition(int,int)
{
	// Browsers do not allow warping the pointer.
}

void FsSwapBuffers(void)
{
	if(nullptr!=fsSwapBuffersHook &&
	   true==(*fsSwapBuffersHook)(fsSwapBuffersHookParam))
	{
		return;
	}
	// WebGL presents the frame when control returns to the browser.
}

int FsInkey(void)
{
	if(0<nKeyBufUsed)
	{
		const int keyCode=keyBuffer[0];
		--nKeyBufUsed;
		for(int i=0; i<nKeyBufUsed; ++i)
		{
			keyBuffer[i]=keyBuffer[i+1];
		}
		return keyCode;
	}
	return 0;
}

int FsInkeyChar(void)
{
	if(0<nCharBufUsed)
	{
		const int asciiCode=charBuffer[0];
		--nCharBufUsed;
		for(int i=0; i<nCharBufUsed; ++i)
		{
			charBuffer[i]=charBuffer[i+1];
		}
		return asciiCode;
	}
	return 0;
}

int FsGetKeyState(int fsKeyCode)
{
	if(0<=fsKeyCode && fsKeyCode<FSKEY_NUM_KEYCODE)
	{
		return keyState[fsKeyCode];
	}
	return 0;
}

int FsCheckWindowExposure(void)
{
	const int e=exposure;
	exposure=0;
	return e;
}

void FsShowMouseCursor(int showFlag)
{
	if(0!=showFlag)
	{
		emscripten_run_script("document.getElementById('canvas').style.cursor='default';");
	}
	else
	{
		emscripten_run_script("document.getElementById('canvas').style.cursor='none';");
	}
}

int FsIsMouseCursorVisible(void)
{
	return 1;
}

void FsChangeToProgramDir(void)
{
	chdir("/ysflight");
}

// ----------------------------------------------------------------------------
// Touch

int FsGetNumCurrentTouch(void)
{
	return nTouch;
}

const FsVec2i *FsGetCurrentTouch(void)
{
	return touchCache;
}

// ----------------------------------------------------------------------------
// IME / native text input (unavailable)

int FsEnableIME(void)
{
	return 0;
}

void FsDisableIME(void)
{
}

int FsIsNativeTextInputAvailable(void)
{
	return 0;
}

int FsOpenNativeTextInput(int,int,int,int)
{
	return 0;
}

void FsCloseNativeTextInput(void)
{
}

void FsSetNativeTextInputText(const wchar_t [])
{
}

int FsGetNativeTextInputTextLength(void)
{
	return 0;
}

void FsGetNativeTextInputText(wchar_t str[],int bufLen)
{
	if(0<bufLen)
	{
		str[0]=0;
	}
}

int FsGetNativeTextInputEvent(void)
{
	return FSNATIVETEXTEVENT_NONE;
}

extern "C" EMSCRIPTEN_KEEPALIVE void YsfwInjectMouseEvent(int eventType,int lb,int mb,int rb,int mx,int my)
{
	PushMouseEvent(eventType,lb,mb,rb,mx,my);
}
