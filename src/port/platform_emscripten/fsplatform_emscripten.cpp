/* ////////////////////////////////////////////////////////////

File Name: fsplatform_emscripten.cpp

Platform-dependent functions for the Emscripten (WebAssembly) port of
YSFLIGHT (ysflight-web project).  Based on platform/android/fsplatform.cpp,
with the mouse-as-joystick emulation carried over from the GLX platform
(platform/linux/fsglx.cpp) so that the mouse can be assigned to elevator
and aileron in the browser.

Copyright (c) 2026 ysflight-web contributors.
Follows the same BSD-style license as YSFLIGHT itself.

//////////////////////////////////////////////////////////// */

#include <ysclass.h>
#include <fssimplewindow.h>

#include <fsdef.h>
#include <fsconsole.h>

#include <fswindow.h>
#include <fsopengl.h>
#include <fscontrol.h>

#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>

////////////////////////////////////////////////////////////

YSRESULT FsTaskBarAddIcon(void)
{
	return YSERR;
}

YSRESULT FsTaskBarDeleteIcon(void)
{
	return YSERR;
}

void FsBeforeOpenWindow(const class FsOption &,const class FsFlightConfig &)
{
	fsConsole.useStdout=YSTRUE;
}

void FsAfterOpenWindow(const class FsOption &,const class FsFlightConfig &)
{
}

void FsSetTopMostWindow(YSBOOL)
{
}

void FsSetFullScreen(int /*wid*/,int /*hei*/,int /*bpp*/)
{
}

void FsSetNormalWindow(void)
{
}

void FsSetOnPaintCallback(class FsOnPaintCallback *)
{
}

void FsHidePartOfScreenForSharewareMessage(void)
{
}

void FsMessageBox(const char msg[],const char /*title*/[])
{
	printf("%s\n",msg);
}

YSBOOL FsYesNoDialog(const char msg[],const char /*title*/[])
{
	printf("%s\n",msg);
	return YSFALSE;
}

////////////////////////////////////////////////////////////
// Joystick: no physical joystick support yet (Gamepad API planned),
// but the mouse can be used as a virtual stick (FsMouseJoyId).

int FsGetNumYsJoyReader(void)
{
	return 0;
}

class YsJoyReader *FsGetYsJoyReaderArray(void)
{
	return nullptr;
}

YSBOOL FsIsJoystickAxisAvailable(int joyId,int joyAxs)
{
	if(joyId==FsMouseJoyId)
	{
		if(joyAxs==0 || joyAxs==1)
		{
			return YSTRUE;
		}
	}
	return YSFALSE;
}

YSRESULT FsPollJoystick(FsJoystick &joy,int joyId)
{
	int i;
	for(i=0; i<FsMaxNumJoyAxis; i++)
	{
		joy.axs[i]=-1.0;
	}
	for(i=0; i<FsMaxNumJoyTrig; i++)
	{
		joy.trg[i]=YSFALSE;
	}
	joy.pov=YSFALSE;
	joy.povAngle=0.0;

	if(joyId==FsMouseJoyId)
	{
		int wid,hei,mx,my;
		YSBOOL lb,mb,rb;
		FsMouse(lb,mb,rb,mx,my);
		FsGetWindowSize(wid,hei);
		const int cx=wid/2;
		const int cy=hei/2;
		const int denom=YsSmaller(wid,hei);
		joy.axs[0]=YsBound(0.5+(double)(mx-cx)/(double)denom,0.0,1.0);
		joy.axs[1]=YsBound(0.5+(double)(my-cy)/(double)denom,0.0,1.0);
		joy.trg[0]=lb;
		joy.trg[1]=rb;
		joy.trg[2]=mb;
		return YSOK;
	}

	return YSERR;
}
