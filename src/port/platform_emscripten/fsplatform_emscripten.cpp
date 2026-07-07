/* ////////////////////////////////////////////////////////////

File Name: fsplatform_emscripten.cpp

Platform-dependent functions for the Emscripten (WebAssembly) port of
YSFLIGHT (ysflight-web project).  Based on platform/android/fsplatform.cpp,
with the mouse-as-joystick emulation carried over from the GLX platform
(platform/linux/fsglx.cpp), plus joystick support through the browser
Gamepad API (gamepads appear after the user presses a button on them,
as required by the Gamepad specification).

Copyright (c) 2026 ysflight-web contributors.
Follows the same BSD-style license as YSFLIGHT itself.

//////////////////////////////////////////////////////////// */

#include <emscripten/html5.h>

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

void YsfwSetUpWebXR(void);  // fswebxr.cpp

void FsAfterOpenWindow(const class FsOption &,const class FsFlightConfig &)
{
	// The WebGL context exists at this point; expose the WebXR entry points
	// (Module.ysfwVr) to the hosting page.
	YsfwSetUpWebXR();
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
// Joystick: browser Gamepad API (ids 0..FsMaxNumJoystick-2), plus the
// mouse as a virtual stick (FsMouseJoyId).  The YsJoyReader-based
// calibration UI is not used; gamepad axes arrive pre-normalized.

int FsGetNumYsJoyReader(void)
{
	return 0;
}

class YsJoyReader *FsGetYsJoyReaderArray(void)
{
	return nullptr;
}

static YSBOOL FsGamepadStatus(int joyId,EmscriptenGamepadEvent &state)
{
	if(joyId<0 || FsMouseJoyId<=joyId)
	{
		return YSFALSE;
	}
	if(EMSCRIPTEN_RESULT_SUCCESS!=emscripten_sample_gamepad_data())
	{
		return YSFALSE;
	}
	if(emscripten_get_num_gamepads()<=joyId)
	{
		return YSFALSE;
	}
	if(EMSCRIPTEN_RESULT_SUCCESS!=emscripten_get_gamepad_status(joyId,&state) ||
	   EM_TRUE!=state.connected)
	{
		return YSFALSE;
	}
	return YSTRUE;
}

YSBOOL FsIsJoystickAxisAvailable(int joyId,int joyAxs)
{
	if(joyId==FsMouseJoyId)
	{
		if(joyAxs==0 || joyAxs==1)
		{
			return YSTRUE;
		}
		return YSFALSE;
	}

	EmscriptenGamepadEvent state;
	if(YSTRUE==FsGamepadStatus(joyId,state) &&
	   0<=joyAxs && joyAxs<state.numAxes && joyAxs<FsMaxNumJoyAxis)
	{
		return YSTRUE;
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

	EmscriptenGamepadEvent state;
	if(YSTRUE==FsGamepadStatus(joyId,state))
	{
		for(i=0; i<FsMaxNumJoyAxis; i++)
		{
			if(i<state.numAxes)
			{
				joy.axs[i]=YsBound((1.0+state.axis[i])/2.0,0.0,1.0);
			}
			else
			{
				joy.axs[i]=0.0;
			}
		}

		for(i=0; i<FsMaxNumJoyTrig && i<state.numButtons; i++)
		{
			joy.trg[i]=(EM_TRUE==state.digitalButton[i] ? YSTRUE : YSFALSE);
		}

		// In the standard gamepad mapping the d-pad is buttons 12-15.
		// Expose it as a POV hat (0=up, clockwise, in radian).
		if(0==strcmp(state.mapping,"standard") && 16<=state.numButtons)
		{
			const bool up   =(EM_TRUE==state.digitalButton[12]);
			const bool down =(EM_TRUE==state.digitalButton[13]);
			const bool left =(EM_TRUE==state.digitalButton[14]);
			const bool right=(EM_TRUE==state.digitalButton[15]);
			int deg=-1;
			if(up && right)        { deg=45; }
			else if(down && right) { deg=135; }
			else if(down && left)  { deg=225; }
			else if(up && left)    { deg=315; }
			else if(up)            { deg=0; }
			else if(right)         { deg=90; }
			else if(down)          { deg=180; }
			else if(left)          { deg=270; }
			if(0<=deg)
			{
				joy.pov=YSTRUE;
				joy.povAngle=(double)deg*YsPi/180.0;
			}
		}

		return YSOK;
	}

	return YSERR;
}
