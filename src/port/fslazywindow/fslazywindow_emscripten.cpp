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

static bool busy=false;  // To prevent re-entry

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

static void MainLoopTick(void)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();

	if(0==FsCheckWindowOpen() || true==appPtr->MustTerminate())
	{
		appPtr->BeforeTerminate();
		emscripten_cancel_main_loop();
		return;
	}

	FsPollDevice();

	busy=true;
	appPtr->Interval();
	busy=false;

	if(0!=FsCheckWindowExposure() || true==appPtr->NeedRedraw())
	{
		appPtr->Draw();
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

	// 0 fps -> requestAnimationFrame.  simulate_infinite_loop unwinds out of main
	// without running destructors, keeping the runtime alive.
	emscripten_set_main_loop(MainLoopTick,0,1);

	return 0;
}
