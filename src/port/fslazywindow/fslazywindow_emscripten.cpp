/* ////////////////////////////////////////////////////////////

File Name: fslazywindow_emscripten.cpp

Emscripten main-loop driver for the fslazywindow framework, written for the
ysflight-web project.  The polling main loop of the desktop driver is mapped
onto emscripten_set_main_loop (requestAnimationFrame).

Copyright (c) 2026 ysflight-web contributors.
Follows the same BSD-style license as fslazywindow itself.

//////////////////////////////////////////////////////////// */

#include <emscripten.h>

#include <fssimplewindow.h>
#include <fslazywindow.h>

#include "graphics/common/fsvr.h"

static bool busy=false;  // To prevent re-entry

// ----------------------------------------------------------------------------
// Background-tab operation.
//
// requestAnimationFrame stops and page timers are throttled to >=1s while the
// tab is hidden, which would freeze the simulation (and drop multiplayer
// sessions).  Worker messages are not throttled, so a tiny Worker posts a
// message every ~16ms and the main thread runs Interval() from it whenever
// the page is hidden.  Drawing is skipped while invisible.

static void NotifyTerminated(void);

extern "C" void EMSCRIPTEN_KEEPALIVE YsfwBackgroundTick(void)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();
	if(nullptr==appPtr || 0==FsCheckWindowOpen() || true==appPtr->MustTerminate() || true==busy)
	{
		return;
	}
	FsPollDevice();
	busy=true;
	appPtr->Interval();
	busy=false;
	// A hidden tab still simulates; if the flight ended there (-autoexit set
	// the terminate flag inside Interval), hand over to the shell now — the
	// rAF loop is parked while hidden and would only notice on re-focus.
	if(true==appPtr->MustTerminate())
	{
		appPtr->BeforeTerminate();
		emscripten_cancel_main_loop();
		NotifyTerminated();
	}
}

EM_JS(void,YsfwInstallBackgroundTicker,(),
{
	if(Module.ysfwBgWorker)
	{
		return;
	}
	var src='setInterval(function(){postMessage(0);},16);';
	var url=URL.createObjectURL(new Blob([src],{type:'application/javascript'}));
	Module.ysfwBgWorker=new Worker(url);
	Module.ysfwBgTicks=0;
	Module.ysfwBgWorker.onmessage=function()
	{
		if(document.hidden)
		{
			++Module.ysfwBgTicks;
			_YsfwBackgroundTick();
		}
	};
});

static void IntervalCallBack(void *)
{
	if(true!=busy)
	{
		auto appPtr=FsLazyWindowApplicationBase::GetApplication();
		if(nullptr!=appPtr)
		{
			busy=true;
			appPtr->Interval();
			busy=false;
		}
	}
}

static void NeedRedrawCallBack(void *)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();
	if(nullptr!=appPtr)
	{
		appPtr->Draw();
	}
}

static bool UserWantToCloseProgram(void *)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();
	if(nullptr!=appPtr)
	{
		if(true==appPtr->UserWantToCloseProgram())
		{
			appPtr->BeforeTerminate();
			return true;
		}
	}
	return false;
}

// CPU cost per tick (Interval+Draw, ms), exponential moving average.
// Read from JS via YsfwGetTickMs() -- the instrument for measuring the
// engine's main-thread cost independent of vsync/rAF pacing.
static double tickMsAvg=0.0;

extern "C" double EMSCRIPTEN_KEEPALIVE YsfwGetTickMs(void)
{
	return tickMsAvg;
}

// Tell the web shell the moment the engine decides to terminate.  With
// -autoexit (which the shell adds to every flight deep link) this fires on
// "flight over, back to menu": the shell navigates away IMMEDIATELY instead of
// ever presenting the engine's 2D menu (docs/web-shell.md, instant handover).
// Idempotent; also covers File>Exit and fatal window-close paths.
static void NotifyTerminated(void)
{
	EM_ASM({
		if(!globalThis.ysfwTerminated)
		{
			globalThis.ysfwTerminated=true;
			try { window.dispatchEvent(new Event('ysfw-terminated')); } catch(e) {}
		}
	});
}

static void MainLoopTick(void)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();

	if(0==FsCheckWindowOpen() || true==appPtr->MustTerminate())
	{
		appPtr->BeforeTerminate();
		emscripten_cancel_main_loop();
		NotifyTerminated();
		return;
	}

	const double t0=emscripten_get_now();

	FsPollDevice();

	busy=true;
	appPtr->Interval();
	busy=false;

	// Terminate decided DURING this tick (typically -autoexit observing the
	// return to menu inside Interval): bail out before the Draw below would
	// present a single menu frame.  The canvas keeps the last flight frame.
	if(true==appPtr->MustTerminate())
	{
		appPtr->BeforeTerminate();
		emscripten_cancel_main_loop();
		NotifyTerminated();
		return;
	}

	// Phase split for FsVrPerfDataPointer()[0]/[1] (see fsvr.h): the
	// simulation/interval half vs. the draw half of the tick, same EMA
	// (alpha=0.05) as tickMsAvg below. Always-on (negligible next to the
	// work it measures); the VR web layer prints it under ?vrperf=1.
	const double tAfterInterval=emscripten_get_now();
	FsVrPerfAccumulate(0,tAfterInterval-t0);

	if(0!=FsCheckWindowExposure() || true==appPtr->NeedRedraw())
	{
		appPtr->Draw();
	}

	const double tickMs=emscripten_get_now()-t0;
	tickMsAvg=(0.0==tickMsAvg ? tickMs : tickMsAvg*0.95+tickMs*0.05);
	FsVrPerfAccumulate(1,emscripten_get_now()-tAfterInterval);
}

// ----------------------------------------------------------------------------
// External drive (WebXR).
//
// While an immersive session runs, frames must be produced from
// XRSession.requestAnimationFrame -- the window rAF loop is paused (on
// standalone headsets it stops firing anyway).  The WebXR glue
// (platform_emscripten/fswebxr.cpp) calls these from JS.

extern "C" void EMSCRIPTEN_KEEPALIVE YsfwExternalTick(void)
{
	if(true!=busy)
	{
		MainLoopTick();
	}
}

extern "C" void EMSCRIPTEN_KEEPALIVE YsfwSetExternalDrive(int externalDrive)
{
	if(0!=externalDrive)
	{
		emscripten_pause_main_loop();
	}
	else
	{
		emscripten_resume_main_loop();
	}
}

int main(int ac,char *av[])
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();

	appPtr->BeforeEverything(ac,av);

	FsOpenWindowOption owo;
	owo.useDoubleBuffer=true;
	appPtr->GetOpenWindowOption(owo);

	FsOpenWindow(owo);
	appPtr->Initialize(ac,av);

	// Memo: Don't register call backs before Initialize.
	//       Some of the call-back functions may be accidentally fired from inside FsOpenWindow.
	FsRegisterIntervalCallBack(IntervalCallBack,nullptr);
	FsRegisterOnPaintCallBack(NeedRedrawCallBack,nullptr);
	FsRegisterCloseWindowCallBack(UserWantToCloseProgram,nullptr);

	YsfwInstallBackgroundTicker();

	// 0 fps -> requestAnimationFrame.  simulate_infinite_loop unwinds out of main
	// without running destructors, keeping the runtime alive.
	emscripten_set_main_loop(MainLoopTick,0,1);

	return 0;
}
