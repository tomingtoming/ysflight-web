/* ////////////////////////////////////////////////////////////

File Name: fswebxr.cpp

WebXR (immersive VR) glue for ysflight-web.

The engine side is graphics/common/fsvr.{h,cpp}: a small dependency-free
state block that the GL2 back-end reads to override the viewport, the
projection, and the view matrix per eye.  This file is the WebXR runtime
that owns the session and fills that state every frame:

  - Module.ysfwVr.enter() requests an immersive-vr session, makes the
    existing WebGL context XR-compatible, and switches the engine into
    VR mode (FsVrSetActive + the main-window split, so the scene is
    drawn once per eye).
  - While the session runs, the browser drives the engine from
    XRSession.requestAnimationFrame (the window rAF loop is paused);
    each XR frame writes the per-eye tangents / view matrices /
    viewports and calls one engine tick with the XR framebuffer bound.
    glBindFramebuffer(GL_FRAMEBUFFER,0) calls inside the engine (e.g.
    after the shadow-map pass) are redirected to the XR framebuffer for
    the lifetime of the session.
  - The 2D menus are not presented in VR, so the session auto-ends when
    the simulation stops drawing (FsVrConsumeSimDrawnFrames stays 0).
  - Each XR frame also drives the hand controllers into the engine's VR
    control-state block (fsvr.h / FsVrControlDataPointer): the right grip
    is a virtual stick (grab + wrist deflection -> aileron/elevator/rudder),
    the left grip is a virtual throttle lever (grab + forward push ->
    throttle), and the face buttons fire synthetic KeyboardEvents on the
    default key bindings (gear, spoiler/brake, flaps).
  - Each hand's trigger is a SaccFlight-style radial "function dial":
    pushing that hand's thumbstick past a deadzone picks one of 4 sectors
    (up/right/down/left), the pick sticks after the stick recentres, and
    the trigger then dispatches whichever function is currently selected
    (see RIGHT_DIAL/LEFT_DIAL below). While a session uses the WebXR
    layers path (single-pass stereo, see YsfwVrSetMultiview above), each
    hand also gets a small head-locked XRQuadLayer showing the dial so the
    selection is visible in-headset; without layers the dial still works,
    it is just invisible.
  - The dial quads also show LIVE aircraft state (fsvr.h /
    FsVrAircraftStateDataPointer), not just static labels: the right dial's
    Gear/Brake sectors show the current UP/DOWN (or transitional %) and
    ON/OFF, its centre shows the selected weapon short-name + remaining
    count; the left dial's Flap+/Flap- sectors and centre show the current
    flap %. The canvas is only redrawn when the sticky sector selection OR
    this state changes (see updateDialLayers/aircraftStateSig below), not
    every frame.

Copyright (c) 2026 ysflight-web contributors.
Follows the same BSD-style license as the rest of the port layer.

//////////////////////////////////////////////////////////// */

#include <emscripten.h>

#include <fssimplewindow.h>

#include "graphics/common/fsvr.h"
#include "platform/common/fswindow.h"

// Defined in fslazywindow_emscripten.cpp; called from JS only.
extern "C" void YsfwExternalTick(void);
extern "C" void YsfwSetExternalDrive(int externalDrive);

extern "C" void EMSCRIPTEN_KEEPALIVE YsfwVrSetPresenting(int presenting)
{
	FsVrSetActive(presenting);
	FsSetActiveSplitWindow(0);
	FsPushOnPaintEvent();
}

// Single-pass stereo (OVR_multiview2) mode switch.  The shared ysgl
// renderers must be recompiled with the per-view projection array
// (layout(num_views=2), projection[gl_ViewID_OVR]) when entering, and back
// to the mono form when leaving -- a multiview program may only draw into a
// multiview framebuffer and vice versa.
extern "C" void YsGLSLSetCompileNumViews(int nViews);   // ysgl (ysglslutil.h)
extern void FsReinitializeOpenGL(void);                 // engine gl2.0 back-end

extern "C" void EMSCRIPTEN_KEEPALIVE YsfwVrSetMultiview(int multiview)
{
	if((0!=multiview)==(0!=FsVrIsMultiview()))
	{
		return;
	}
	YsGLSLSetCompileNumViews(0!=multiview ? 2 : 0);
	FsReinitializeOpenGL();
	FsVrSetMultiview(0!=multiview ? 1 : 0);
}

extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrEyeDataPointer(int eye)
{
	return FsVrEyeDataPointer(eye);
}

// Forwards to the engine's VR controller-state block (fsvr.h): the JS
// controller runtime below writes aileron/elevator/rudder/throttle here
// every XR frame; FsFlightControl::ApplyVrControlOverride reads it while
// FsVrIsActive.
extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrControlDataPointer(void)
{
	return FsVrControlDataPointer();
}

extern "C" int EMSCRIPTEN_KEEPALIVE YsfwVrConsumeSimDrawnFrames(void)
{
	return FsVrConsumeSimDrawnFrames();
}

// Forwards to the engine's VR HUD composite state block (fsvr.h, 8 floats):
// the JS runtime writes [enable,fbo,texArray,texW,texH] here when single-pass
// stereo engages; SimDrawAllScreen reads it to render the flat HUD into the
// off-screen two-layer multiview framebuffer and composite it onto a quad.
extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrHudDataPointer(void)
{
	return FsVrHudDataPointer();
}

// Forwards to the engine's VR aircraft-state block (fsvr.h, 8 floats): the
// engine writes gear/brake/flap/selected-weapon state here once per sim frame
// while VR is active; the dial-rendering code below (drawDial /
// updateDialLayers) reads it to show live state on the radial function-dial
// quads before the pilot presses anything.
extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrAircraftStateDataPointer(void)
{
	return FsVrAircraftStateDataPointer();
}

// clang-format off
EM_JS(void,YsfwInstallWebXR,(),
{
	if(Module.ysfwVr)
	{
		return;
	}

	var vr={
		supported:false,
		session:null,
		refSpace:null,
		xrFb:null,
		origBind:null,
		simSilentFrames:0,
		// single-pass stereo (OVR_multiview2 / WebXR layers)
		mvExt:null,
		mvBinding:null,
		mvLayer:null,
		mvFb:null,
		mvDepth:null,
		mvDepthSize:null,
		testMode:false,
		// VR HUD composite (fsvr.h FsVrHudDataPointer): an off-screen two-layer
		// multiview framebuffer the engine renders the flat HUD into, plus the
		// emscripten GL-table ids so the C++ side can bind them by integer name.
		hud:null,
		// Head-locked function-dial quad layers (lazily created, layers path
		// only). viewerSpace: the session's 'viewer' reference space the
		// quads are anchored to. dialRes[hand]: undefined = not yet
		// attempted, false = attempted and unavailable (no quad-layer
		// support), object = {canvas,ctx,quad,inLayers} once created.
		viewerSpace:null,
		dialRes:{right:undefined,left:undefined},
		// Hand-controller state (virtual stick + throttle + button latches).
		// See fsvr.h / FsVrControlDataPointer for the 16-float block this
		// feeds, and updateControllers/processControllerPlain below.
		ctl:{
			stick:{grabbed:false,q0:null},
			thr:{grabbed:false,p0:null,fwd0:null,base:0,value:0,ever:false},
			rightTrigger:false,
			rightA:false,
			rightB:false,
			leftX:false,
			leftY:false,
			leftTrigger:false,
			keys:{},
			// Radial function-dial state per hand (see RIGHT_DIAL/LEFT_DIAL).
			// sel: sticky selected sector ('up'|'right'|'down'|'left').
			// engaged: the function snapshot captured at the trigger's press
			//   edge (see processControllerPlain) -- kept for the whole press
			//   so a mid-press dial flick can't retarget an already-firing
			//   trigger. visible/hideAt drive the quad layer's on/off fade.
			dial:{
				right:{sel:'up',engaged:null,visible:false,hideAt:0},
				left:{sel:'up',engaged:null,visible:false,hideAt:0}
			}
		}
	};
	Module.ysfwVr=vr;

	// ---- Radial function-dial tables (SaccFlightAndVehicles-style) ------
	// One function per sector per hand.  keyCode is the DOM KeyboardEvent
	// code dispatched (see fssimplewindow_emscripten.cpp's keyCodeMapping
	// for the code->FSKEY table); mode 'hold' mirrors the trigger's raw
	// press/release (key held as long as the trigger is), mode 'tap' fires
	// one keydown+keyup pulse on the trigger's press edge only. Every key
	// below is cross-checked against FsControlAssignment::SetDefaultKeyAssign
	// (upstream/YSFLIGHT/src/core/fscontrol.cpp) -- see the per-entry notes.
	var RIGHT_DIAL={
		// FSBTF_FIREWEAPON (Space): a level-sensed virtual button in the
		// engine (fscontrol.cpp's "implemented through virtual buttons of
		// FsAirplaneProperty" switch) -- fires while held, so 'hold'.
		up:   {label:'Gun',    code:'Space', mode:'hold'},
		// FSBTF_SELECTWEAPON (Digit2): cycles the selected weapon
		// (FsGroundProperty::CycleWeaponOfChoiceByUser / ctlCycleWeaponButtonExt)
		// on the press edge -- a 'tap', not a hold, and matches the touch UI's
		// own weapon-select button (web/index.html's tap('Digit2')).
		right:{label:'武器切替',code:'Digit2',mode:'tap'},
		// FSBTF_LANDINGGEAR (KeyG): fscontrol.cpp toggles
		// ctlGear=(ctlGear<0.5?1.0:0.0) on each press -- a toggle, so 'tap'
		// (one edge per trigger pull, not a sustained hold).
		down: {label:'Gear',   code:'KeyG',  mode:'tap'},
		// FSBTF_SPOILERBRAKE (KeyB): same toggle pattern as gear
		// (ctlSpoiler=(ctlSpoiler<0.5?1.0:0.0) in fscontrol.cpp) -- 'tap',
		// not 'hold', despite the name "brake" suggesting a held button.
		left: {label:'Brake',  code:'KeyB',  mode:'tap'}
	};
	var LEFT_DIAL={
		// FSBTF_FLAPUP (KeyR): steps one flap position per press -- 'tap'.
		up:   {label:'Flap+',  code:'KeyR', mode:'tap'},
		// FSBTF_FLAPDOWN (KeyF): steps one flap position per press -- 'tap'.
		down: {label:'Flap-',  code:'KeyF', mode:'tap'},
		// No default key targets FSBTF_SMOKE itself (SetDefaultKeyAssign
		// binds only FSKEY_P -> FSBTF_CYCLESMOKESELECTOR); that cycle
		// function advances the smoke-generator channel on the press edge
		// (FsAirplaneProperty::CycleSmokeSelector, called from
		// IsCycleSmokeSelectorButtonJustPressed) -- an edge action, so
		// 'tap' here (deviates from the brief's "hold" guess: there is no
		// holdable smoke key in the shipped defaults).
		right:{label:'Smoke',  code:'KeyP', mode:'tap'},
		// Free slot: FSBTF_OPENAUTOPILOTMENU (Backspace) opens the
		// autopilot dialog -- a deliberately calm, occasional action (the
		// tablet touch UI already treats it as a tap), which fits the left
		// hand well since that hand's grip already owns the continuous
		// throttle control and its trigger is otherwise idle.
		left: {label:'AP',     code:'Backspace',mode:'tap'}
	};

	if(!navigator.xr || !navigator.xr.isSessionSupported)
	{
		return;
	}
	navigator.xr.isSessionSupported('immersive-vr').then(function(ok)
	{
		vr.supported=ok;
		if(ok && Module.onVrAvailable)
		{
			Module.onVrAvailable();
		}
	}).catch(function(){});

	function installFbRedirect()
	{
		// Redirect default-framebuffer binds to the XR framebuffer while a
		// session (or the headless test mode) is live.
		if(!vr.origBind)
		{
			vr.origBind=GLctx.bindFramebuffer;
			GLctx.bindFramebuffer=function(target,fb)
			{
				if(null===fb && (vr.session||vr.testMode) && vr.xrFb)
				{
					fb=vr.xrFb;
				}
				vr.origBind.call(GLctx,target,fb);
			};
		}
	}

	// ---- VR HUD composite resources -------------------------------------
	// Allocate the off-screen two-layer multiview HUD framebuffer + RGBA8
	// texture array (1024x1024x2) and publish them, by emscripten GL-table
	// integer id, into the engine's HUD state block (fsvr.h).  The engine
	// renders the flat HUD into layer-both once per frame and composites the
	// array onto a cockpit quad.  Kill switch: Module.ysfwVrOptions.hud===false
	// leaves the whole feature off (enable stays 0, no GL objects created).
	function setupHud()
	{
		var opts=Module.ysfwVrOptions||{};
		if(false===opts.hud)
		{
			return;
		}
		if(vr.hud)
		{
			return;
		}
		var ext=vr.mvExt||GLctx.getExtension('OCULUS_multiview')||GLctx.getExtension('OVR_multiview2');
		if(!ext)
		{
			return;
		}
		// 768 wide: the engine draws HUD lines/glyphs ~1 texel wide, so the
		// TEXEL size sets BOTH the on-screen line thickness AND the symbology
		// size (1024 alpha-collapsed on the headset, 512 was oversized).
		// 16:9, not square: the engine lays the HUD out for the aspect it is
		// given, and side/bottom elements (bank indicator, compass rose)
		// assume a wide screen -- a square texture clips them at the edges.
		// The engine sizes the glass quad from these dimensions.
		var W=768,H=432;

		var prevActive=GLctx.getParameter(GLctx.ACTIVE_TEXTURE);
		GLctx.activeTexture(GLctx.TEXTURE15);
		var tex=GLctx.createTexture();
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,tex);
		GLctx.texStorage3D(GLctx.TEXTURE_2D_ARRAY,1,GLctx.RGBA8,W,H,2);
		// levels=1: must pick a non-mipmapping filter or the texture is
		// mip-incomplete and samples as black.
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_MIN_FILTER,GLctx.LINEAR);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_MAG_FILTER,GLctx.LINEAR);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_WRAP_S,GLctx.CLAMP_TO_EDGE);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_WRAP_T,GLctx.CLAMP_TO_EDGE);
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,null);
		GLctx.activeTexture(prevActive);

		var fb=GLctx.createFramebuffer();
		var prevFb=GLctx.getParameter(GLctx.FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,fb);
		// No depth attachment: the HUD is 2D painter's-order (FsSet2DDrawing uses
		// glDepthFunc(ALWAYS)/glDepthMask(FALSE)); no depth buffer is needed.
		ext.framebufferTextureMultiviewOVR(GLctx.FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,tex,0,0,2);
		var st=GLctx.checkFramebufferStatus(GLctx.FRAMEBUFFER);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,prevFb);
		if(st!==GLctx.FRAMEBUFFER_COMPLETE)
		{
			console.warn('[vr] HUD framebuffer incomplete 0x'+st.toString(16)+' -- HUD disabled');
			GLctx.deleteFramebuffer(fb);
			GLctx.deleteTexture(tex);
			return;
		}

		// Register the JS objects into emscripten's GL tables so the C++ side
		// can reference them by the integer ids it stores as GLuint.
		var fbId=GL.getNewId(GL.framebuffers);
		GL.framebuffers[fbId]=fb;
		fb.name=fbId;
		var texId=GL.getNewId(GL.textures);
		GL.textures[texId]=tex;
		tex.name=texId;

		var p=_YsfwVrHudDataPointer()>>2;
		HEAPF32[p+0]=1;     // enable
		HEAPF32[p+1]=fbId;  // hudFbo
		HEAPF32[p+2]=texId; // hudTexArray
		HEAPF32[p+3]=W;
		HEAPF32[p+4]=H;
		HEAPF32[p+5]=0; HEAPF32[p+6]=0; HEAPF32[p+7]=0;

		vr.hud={fb:fb,tex:tex,fbId:fbId,texId:texId,w:W,h:H};
		console.log('[vr] HUD composite '+W+'x'+H+'x2 (fbId='+fbId+' texId='+texId+')');
	}

	function teardownHud()
	{
		var p=_YsfwVrHudDataPointer()>>2;
		for(var i=0; i<8; ++i)
		{
			HEAPF32[p+i]=0;
		}
		if(!vr.hud)
		{
			return;
		}
		try{ GLctx.deleteFramebuffer(vr.hud.fb); }catch(e){}
		try{ GLctx.deleteTexture(vr.hud.tex); }catch(e){}
		GL.framebuffers[vr.hud.fbId]=null;
		GL.textures[vr.hud.texId]=null;
		vr.hud=null;
	}

	// ---- VR controller -> flight-control state block --------------------
	// Writes into the 16-float block at _YsfwVrControlDataPointer() (see
	// fsvr.h for the layout).  All the actual per-controller logic lives in
	// processControllerPlain, driven by a plain {hand,pos,quat,squeeze,
	// trigger,buttons} shape so the real XR path (updateControllers) and the
	// headless test hook (vr.pokeControllerFrame) share one implementation.

	var MAX_ANGLE=Math.PI/4;   // 45 degrees: full stick deflection.
	var THROTTLE_SENS=6;       // 1/6 m (~17cm) forward push = full 0..1 range.
	var GRAB_THRESHOLD=0.75;   // xr-standard squeeze/trigger value = "pressed".

	function clamp(v,lo,hi){ return v<lo ? lo : (v>hi ? hi : v); }

	// Minimal quaternion math, no external libs, unit quaternions only.
	function quatMultiply(a,b)
	{
		return {
			x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
			y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
			z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,
			w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z
		};
	}
	function quatConjugate(q)
	{
		// Unit quaternion: conjugate == inverse.
		return {x:-q.x,y:-q.y,z:-q.z,w:q.w};
	}
	function rotateVecByQuat(v,q)
	{
		var vq={x:v.x,y:v.y,z:v.z,w:0};
		var t=quatMultiply(quatMultiply(q,vq),quatConjugate(q));
		return {x:t.x,y:t.y,z:t.z};
	}
	function vecSub(a,b){ return {x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}; }
	function vecDot(a,b){ return a.x*b.x+a.y*b.y+a.z*b.z; }
	function vecLen(v){ return Math.sqrt(v.x*v.x+v.y*v.y+v.z*v.z); }

	// Decompose the grip rotation since grab-begin (deltaQ = q*conjugate(q0))
	// into pitch/yaw/roll deflection.  Deflections are expected well under
	// 45 degrees, so gimbal order is not a practical concern.  Reference
	// vectors: f=(0,0,-1) forward, r=(1,0,0) right; rotate both by deltaQ:
	//   pitch = asin(f'.y)          -- forward tilting up/down
	//   yaw   = atan2(-f'.x,-f'.z)  -- forward swinging left/right
	//   roll  = asin(r'.y)          -- right-hand-reference tilting up/down
	// Sign conventions, matching fsvr.h (aileron+ = roll right, elevator+ =
	// nose up, rudder+ = nose left):
	//   elevator=+pitch: the controller's front tilting upward (f'.y>0) is
	//     the wrist pitching back -- nose up -- direct, no flip.
	//   rudder=+yaw: the front swinging to the user's left (f'.x<0) is
	//     yawing left -- direct, no flip.
	//   aileron=-roll: a positive rotation about the local forward (roll)
	//     axis swings the right-reference vector UP (r'.y>0), which is the
	//     wrist rolling LEFT as the user sees it looking down their own arm
	//     (that rotation is counter-clockwise from the user's viewpoint) --
	//     so the sign is flipped here to make "wrist rolls right" (r'.y<0)
	//     read as positive aileron.
	function deflectionFromDeltaQ(dq)
	{
		var f=rotateVecByQuat({x:0,y:0,z:-1},dq);
		var r=rotateVecByQuat({x:1,y:0,z:0},dq);
		var pitch=Math.asin(clamp(f.y,-1,1));
		var yaw=Math.atan2(-f.x,-f.z);
		var roll=Math.asin(clamp(r.y,-1,1));
		return {
			elevator:clamp(pitch/MAX_ANGLE,-1,1),
			rudder:clamp(yaw/MAX_ANGLE,-1,1),
			aileron:clamp(-roll/MAX_ANGLE,-1,1)
		};
	}

	// Synthetic-key dispatch, matching the on-screen touch controls in
	// web/index.html exactly: a plain KeyboardEvent on window, keyed by
	// e.code, firing only on press/release edges (not every frame).
	function vrKeyEdge(code,pressed)
	{
		if(!code || !!vr.ctl.keys[code]===!!pressed)
		{
			return;
		}
		vr.ctl.keys[code]=!!pressed;
		window.dispatchEvent(new KeyboardEvent(pressed ? 'keydown' : 'keyup',{code:code,bubbles:true}));
	}
	function vrReleaseAllKeys()
	{
		for(var code in vr.ctl.keys)
		{
			vrKeyEdge(code,false);
		}
	}
	function vrHapticPulse(rawSrc)
	{
		try
		{
			var act=rawSrc && rawSrc.gamepad && rawSrc.gamepad.hapticActuators && rawSrc.gamepad.hapticActuators[0];
			if(act)
			{
				act.pulse(0.25,50);
			}
		}
		catch(e){}
	}
	// One-shot key pulse for 'tap' dial functions: a real keyboard tap is a
	// keydown immediately followed by a keyup, independent of how long the VR
	// trigger stays physically pulled (mirrors web/index.html's own tap()).
	// Dispatched directly (not through vrKeyEdge's vr.ctl.keys de-dupe) since
	// that map tracks sustained "is this code currently held" state, which a
	// tap does not participate in.
	function vrKeyTap(code)
	{
		if(!code)
		{
			return;
		}
		window.dispatchEvent(new KeyboardEvent('keydown',{code:code,bubbles:true}));
		setTimeout(function()
		{
			window.dispatchEvent(new KeyboardEvent('keyup',{code:code,bubbles:true}));
		},60);
	}

	// ---- Radial dial: thumbstick -> sticky sector selection --------------
	// thumb is [x,y] off the xr-standard "xr-standard" gamepad mapping's
	// thumbstick axes (gamepad.axes[2],[3] -- see updateControllers). Per the
	// WebXR gamepads-module / MDN: for that mapping, +y is BACKWARD (stick
	// pulled toward the user), so "pushing the stick away" (the intuitive
	// "up" sector) is y NEGATIVE. Flip to upY=-y once here so the rest of
	// this function reads in plain screen terms (up=away, down=toward,
	// matching a top-down view of the stick).
	var DIAL_SELECT_THRESHOLD=0.6;  // magnitude to (re)pick a sector.
	var DIAL_VISIBLE_THRESHOLD=0.3; // magnitude to fade the dial layer in.
	var DIAL_HIDE_DELAY_MS=1200;    // time after re-centring before it hides.
	function updateDialStick(dial,thumb,rawSrc)
	{
		var x=(thumb ? thumb[0] : 0)||0;
		var upY=(thumb ? -thumb[1] : 0)||0;
		var mag=Math.sqrt(x*x+upY*upY);
		var now=(typeof performance!=='undefined' ? performance.now() : Date.now());
		if(DIAL_SELECT_THRESHOLD<mag)
		{
			// Canvas/atan2 convention: 0deg=up (x=0,upY=1), 90deg=right,
			// +-180deg=down, -90deg=left.
			var deg=Math.atan2(x,upY)*180/Math.PI;
			var sector=(-45<=deg && deg<45) ? 'up' : (45<=deg && deg<135) ? 'right' : (-135<=deg && deg<-45) ? 'left' : 'down';
			if(sector!==dial.sel)
			{
				dial.sel=sector;
				vrHapticPulse(rawSrc);
			}
		}
		if(DIAL_VISIBLE_THRESHOLD<mag)
		{
			dial.visible=true;
			dial.hideAt=now+DIAL_HIDE_DELAY_MS;
		}
		else if(dial.visible && now>=dial.hideAt)
		{
			dial.visible=false;
		}
	}

	// The shared per-controller update.  entry is the plain data shape;
	// viewerQuat is the headset orientation this frame ({x,y,z,w}, used only
	// by the left/throttle hand); rawSrc is the real XRInputSource if this
	// call came from live XR input (haptics only -- null from the test hook).
	function processControllerPlain(entry,viewerQuat,rawSrc)
	{
		var ptr=_YsfwVrControlDataPointer()>>2;
		var grabbed=entry.squeeze>GRAB_THRESHOLD;

		if('right'===entry.hand)
		{
			var st=vr.ctl.stick;
			if(grabbed && !st.grabbed)
			{
				st.q0=entry.quat;
				vrHapticPulse(rawSrc);
			}
			else if(!grabbed && st.grabbed)
			{
				// Self-centering: release springs the virtual stick back to
				// neutral, like a real spring-loaded stick.
				HEAPF32[ptr+0]=0;
				HEAPF32[ptr+1]=0;
				HEAPF32[ptr+2]=0;
				HEAPF32[ptr+3]=0;
				vrHapticPulse(rawSrc);
			}
			st.grabbed=grabbed;
			if(grabbed && st.q0)
			{
				var dq=quatMultiply(entry.quat,quatConjugate(st.q0));
				var defl=deflectionFromDeltaQ(dq);
				HEAPF32[ptr+0]=1;
				HEAPF32[ptr+1]=defl.aileron;
				HEAPF32[ptr+2]=defl.elevator;
				HEAPF32[ptr+3]=defl.rudder;
			}

			var rdial=vr.ctl.dial.right;
			updateDialStick(rdial,entry.thumb,rawSrc);
			var triggerPressed=entry.trigger>GRAB_THRESHOLD;
			var triggerEdgeUp=triggerPressed && !vr.ctl.rightTrigger;
			if(triggerEdgeUp)
			{
				vrHapticPulse(rawSrc);
				rdial.engaged=RIGHT_DIAL[rdial.sel]; // snapshot: dial flicks mid-press don't retarget it.
			}
			if(rdial.engaged)
			{
				if('hold'===rdial.engaged.mode)
				{
					vrKeyEdge(rdial.engaged.code,triggerPressed);
				}
				else if(triggerEdgeUp)
				{
					vrKeyTap(rdial.engaged.code);
				}
				if(!triggerPressed)
				{
					rdial.engaged=null;
				}
			}
			vr.ctl.rightTrigger=triggerPressed;

			var aPressed=!!(entry.buttons && entry.buttons.a);
			vrKeyEdge('KeyG',aPressed); // Default landing-gear key.
			vr.ctl.rightA=aPressed;

			var bPressed=!!(entry.buttons && entry.buttons.b);
			vrKeyEdge('KeyB',bPressed); // Default spoiler/air-brake key.
			vr.ctl.rightB=bPressed;
		}
		else if('left'===entry.hand)
		{
			var th=vr.ctl.thr;
			if(grabbed && !th.grabbed)
			{
				th.p0=entry.pos;
				var vq=viewerQuat||{x:0,y:0,z:0,w:1};
				var fwd=rotateVecByQuat({x:0,y:0,z:-1},vq);
				fwd.y=0;
				var flen=vecLen(fwd);
				th.fwd0=(1e-4<flen) ? {x:fwd.x/flen,y:0,z:fwd.z/flen} : {x:0,y:0,z:-1};
				th.base=th.value; // Latch the current value as this grab's baseline.
				vrHapticPulse(rawSrc);
			}
			else if(!grabbed && th.grabbed)
			{
				vrHapticPulse(rawSrc);
			}
			th.grabbed=grabbed;
			if(grabbed && th.p0)
			{
				var d=vecSub(entry.pos,th.p0);
				var value=clamp(th.base+vecDot(d,th.fwd0)*THROTTLE_SENS,0,1);
				HEAPF32[ptr+4]=1;
				HEAPF32[ptr+5]=value;
				HEAPF32[ptr+6]=1;
				th.value=value;
				th.ever=true;
			}
			else
			{
				HEAPF32[ptr+4]=0;
				// [5] (throttle) is intentionally left as-is: a real lever
				// stays where it was left after release.  [6] stays 1 once
				// ever grabbed (see fsvr.h).
				if(th.ever)
				{
					HEAPF32[ptr+6]=1;
				}
			}

			var xPressed=!!(entry.buttons && entry.buttons.a);
			vrKeyEdge('KeyF',xPressed); // Default flaps-down key.
			vr.ctl.leftX=xPressed;

			var yPressed=!!(entry.buttons && entry.buttons.b);
			vrKeyEdge('KeyR',yPressed); // Default flaps-up key.
			vr.ctl.leftY=yPressed;

			// Left trigger: dial-selected function (see LEFT_DIAL). New
			// behaviour -- the left trigger was previously unused (the grip
			// already owns the throttle lever), so this is purely additive.
			var ldial=vr.ctl.dial.left;
			updateDialStick(ldial,entry.thumb,rawSrc);
			var ltriggerPressed=entry.trigger>GRAB_THRESHOLD;
			var ltriggerEdgeUp=ltriggerPressed && !vr.ctl.leftTrigger;
			if(ltriggerEdgeUp)
			{
				vrHapticPulse(rawSrc);
				ldial.engaged=LEFT_DIAL[ldial.sel];
			}
			if(ldial.engaged)
			{
				if('hold'===ldial.engaged.mode)
				{
					vrKeyEdge(ldial.engaged.code,ltriggerPressed);
				}
				else if(ltriggerEdgeUp)
				{
					vrKeyTap(ldial.engaged.code);
				}
				if(!ltriggerPressed)
				{
					ldial.engaged=null;
				}
			}
			vr.ctl.leftTrigger=ltriggerPressed;
		}
	}

	// Real XR path: adapt each live XRInputSource + this frame's grip pose
	// into the plain shape and run it through processControllerPlain.  Only
	// called when a valid viewer pose exists this frame (see onXRFrame).
	function updateControllers(frame,pose)
	{
		var viewerQuat=pose.transform.orientation;
		var sources=frame.session.inputSources;
		for(var i=0; i<sources.length; ++i)
		{
			var src=sources[i];
			if(!src.gripSpace || !src.gamepad)
			{
				continue;
			}
			var hand=src.handedness;
			if('left'!==hand && 'right'!==hand)
			{
				continue;
			}
			var gpose=frame.getPose(src.gripSpace,vr.refSpace);
			if(!gpose)
			{
				continue; // No pose this frame for this source: skip it.
			}
			var gp=src.gamepad;
			var squeeze=(gp.buttons[1] ? gp.buttons[1].value : 0);
			var trigger=(gp.buttons[0] ? gp.buttons[0].value : 0);
			// xr-standard mapping: axes[2],axes[3] = thumbstick x,y (axes[0],[1]
			// are the touchpad, if present). Default to 0 if the gamepad
			// exposes fewer axes than that (some controllers/emulators don't).
			var thumb=[gp.axes[2]||0,gp.axes[3]||0];
			processControllerPlain({
				hand:hand,
				pos:gpose.transform.position,
				quat:gpose.transform.orientation,
				squeeze:squeeze,
				trigger:trigger,
				thumb:thumb,
				buttons:{
					a:!!(gp.buttons[4] && gp.buttons[4].pressed),
					b:!!(gp.buttons[5] && gp.buttons[5].pressed)
				}
			},viewerQuat,src);
		}
	}

	function writeEyeData(pose,layer)
	{
		for(var i=0; i<pose.views.length; ++i)
		{
			var view=pose.views[i];
			var eye=('right'===view.eye ? 1 : 0);
			var vp=layer.getViewport(view);
			var ptr=_YsfwVrEyeDataPointer(eye)>>2;
			var m=view.projectionMatrix;
			// Half-FOV tangents from the projection matrix (all positive).
			HEAPF32[ptr+0]=(1-m[8])/m[0];  // left
			HEAPF32[ptr+1]=(1+m[8])/m[0];  // right
			HEAPF32[ptr+2]=(1+m[9])/m[5];  // up
			HEAPF32[ptr+3]=(1-m[9])/m[5];  // down
			HEAPF32.set(view.transform.inverse.matrix,ptr+4);
			HEAPF32[ptr+20]=vp.x;
			HEAPF32[ptr+21]=vp.y;
			HEAPF32[ptr+22]=vp.width;
			HEAPF32[ptr+23]=vp.height;
		}
	}

	function writeEyeDataMv(pose)
	{
		var vp=null;
		for(var i=0; i<pose.views.length; ++i)
		{
			var view=pose.views[i];
			var eye=('right'===view.eye ? 1 : 0);
			var sub=vr.mvBinding.getViewSubImage(vr.mvLayer,view);
			vp=sub.viewport;
			var ptr=_YsfwVrEyeDataPointer(eye)>>2;
			var m=view.projectionMatrix;
			HEAPF32[ptr+0]=(1-m[8])/m[0];
			HEAPF32[ptr+1]=(1+m[8])/m[0];
			HEAPF32[ptr+2]=(1+m[9])/m[5];
			HEAPF32[ptr+3]=(1-m[9])/m[5];
			HEAPF32.set(view.transform.inverse.matrix,ptr+4);
			// texture-array layers: every view renders to the full sub-image
			// viewport of its own layer.
			HEAPF32[ptr+20]=vp.x;
			HEAPF32[ptr+21]=vp.y;
			HEAPF32[ptr+22]=vp.width;
			HEAPF32[ptr+23]=vp.height;
		}
		// (Re)attach the sub-image textures: the color texture cycles through
		// the runtime's swapchain, so this must happen every frame.
		var sub0=vr.mvBinding.getViewSubImage(vr.mvLayer,pose.views[0]);
		if(!vr.mvFb)
		{
			vr.mvFb=GLctx.createFramebuffer();
		}
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,vr.mvFb);
		vr.mvExt.framebufferTextureMultiviewOVR(GLctx.FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,sub0.colorTexture,0,0,2);
		var depthTex=sub0.depthStencilTexture;
		if(!depthTex)
		{
			// The runtime supplied no depth: keep an own depth texture array.
			var w=sub0.viewport.width,h=sub0.viewport.height;
			if(!vr.mvDepth || vr.mvDepthSize[0]!==w || vr.mvDepthSize[1]!==h)
			{
				if(vr.mvDepth)
				{
					GLctx.deleteTexture(vr.mvDepth);
				}
				vr.mvDepth=GLctx.createTexture();
				GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,vr.mvDepth);
				GLctx.texStorage3D(GLctx.TEXTURE_2D_ARRAY,1,GLctx.DEPTH24_STENCIL8,w,h,2);
				vr.mvDepthSize=[w,h];
			}
			depthTex=vr.mvDepth;
			vr.mvExt.framebufferTextureMultiviewOVR(GLctx.FRAMEBUFFER,GLctx.DEPTH_STENCIL_ATTACHMENT,depthTex,0,0,2);
		}
		else
		{
			vr.mvExt.framebufferTextureMultiviewOVR(GLctx.FRAMEBUFFER,GLctx.DEPTH_STENCIL_ATTACHMENT,depthTex,0,0,2);
		}
		vr.xrFb=vr.mvFb;
	}

	// ---- Radial dial visuals: head-locked XRQuadLayer per hand -----------
	// Layers-path only (vr.mvBinding). Best-effort: any failure here leaves
	// the dial logic (selection + trigger routing, above) fully working,
	// just without the in-headset visual -- every step is try/catch-guarded
	// and callers treat "no resource" as "draw nothing this frame".
	var DIAL_LABELS={
		right:{up:RIGHT_DIAL.up.label,right:RIGHT_DIAL.right.label,down:RIGHT_DIAL.down.label,left:RIGHT_DIAL.left.label},
		left: {up:LEFT_DIAL.up.label, right:LEFT_DIAL.right.label, down:LEFT_DIAL.down.label, left:LEFT_DIAL.left.label}
	};
	// Canvas-space angle (0deg=east/+x, 90deg=south/+y, clockwise, matching
	// CanvasRenderingContext2D.arc's convention) for each sector's wedge
	// centre -- "up" is drawn at the top of the texture (-90deg).
	var DIAL_SECTOR_CANVAS_DEG={up:-90,right:0,down:90,left:180};

	// Weapon short-name map for the right dial's centre readout (fsdef.h's
	// FSWEAPON_* enum -- see FsVrAircraftStateDataPointer's doc comment in
	// fsvr.h for the full mapping this mirrors). Anything not in this table
	// (including FSWEAPON_NULL=127, no weapon selected) reads as 'WPN'.
	var WEAPON_LABELS={
		0:'GUN',    // FSWEAPON_GUN
		1:'AAM-S',  // FSWEAPON_AIM9    (short-range AAM)
		2:'AGM',    // FSWEAPON_AGM65
		3:'BOMB',   // FSWEAPON_BOMB
		4:'RKT',    // FSWEAPON_ROCKET
		5:'FLR',    // FSWEAPON_FLARE
		6:'AAM-M',  // FSWEAPON_AIM120  (medium-range AAM)
		7:'BOMB',   // FSWEAPON_BOMB250
		8:'SMK',    // FSWEAPON_SMOKE
		9:'BOMB',   // FSWEAPON_BOMB500HD
		10:'AAM-S', // FSWEAPON_AIM9X
		11:'FLR',   // FSWEAPON_FLAREPOD
		12:'FUEL'   // FSWEAPON_FUELTANK
	};
	function weaponLabel(wpnType)
	{
		var t=Math.round(wpnType);
		return WEAPON_LABELS.hasOwnProperty(t) ? WEAPON_LABELS[t] : 'WPN';
	}
	function fmtPct(v){ return Math.round(clamp(v,0,1)*100)+'%'; }

	// Per-sector live-state line drawn under a sector's label (null = none).
	// Right dial: Gear (down) shows UP/DOWN or a transitional %; Brake (left)
	// shows ON/OFF (KeyB toggles ctlBrake+ctlSpoiler together, see fsvr.h).
	// Left dial: Flap+/Flap- (up/down) both show the current flap %, so
	// either sector tells the pilot where the flaps already are.
	function dialSectorStateLine(hand,dir,state)
	{
		if(!state || !state.valid)
		{
			return null;
		}
		if('right'===hand)
		{
			if('down'===dir)
			{
				if(state.gear<=0.02){ return 'UP'; }
				if(state.gear>=0.98){ return 'DOWN'; }
				return fmtPct(state.gear);
			}
			if('left'===dir)
			{
				return state.brake>=0.5 ? 'ON' : 'OFF';
			}
		}
		else if('up'===dir || 'down'===dir)
		{
			return fmtPct(state.flap);
		}
		return null;
	}
	// Centre readout: right dial shows the selected weapon + remaining count
	// (replaces the plain dot); left dial shows the flap % (replaces it too).
	// Returns null (draw the plain dot) when there is no valid player state.
	function dialCenterText(hand,state)
	{
		if(!state || !state.valid)
		{
			return null;
		}
		if('right'===hand)
		{
			return weaponLabel(state.wpnType)+' '+Math.max(0,Math.round(state.wpnCount));
		}
		return 'FLP '+fmtPct(state.flap);
	}
	function drawDial(ctx,hand,sel,state)
	{
		var w=256,h=256,cx=128,cy=128,rOuter=110;
		ctx.clearRect(0,0,w,h);
		ctx.fillStyle='rgba(10,14,20,0.55)';
		ctx.beginPath();
		ctx.arc(cx,cy,rOuter,0,2*Math.PI);
		ctx.fill();
		var sectors=['up','right','down','left'];
		for(var i=0; i<sectors.length; ++i)
		{
			var dir=sectors[i];
			var centerRad=DIAL_SECTOR_CANVAS_DEG[dir]*Math.PI/180;
			var a0=centerRad-Math.PI/4, a1=centerRad+Math.PI/4;
			ctx.beginPath();
			ctx.moveTo(cx,cy);
			ctx.arc(cx,cy,rOuter,a0,a1);
			ctx.closePath();
			ctx.fillStyle=(dir===sel) ? 'rgba(77,163,255,0.85)' : 'rgba(143,163,187,0.28)';
			ctx.fill();
			ctx.strokeStyle='rgba(230,237,243,0.6)';
			ctx.lineWidth=2;
			ctx.stroke();
			var labelR=rOuter*0.62;
			var lx=cx+Math.cos(centerRad)*labelR, ly=cy+Math.sin(centerRad)*labelR;
			ctx.textAlign='center';
			var stateLine=dialSectorStateLine(hand,dir,state);
			if(stateLine)
			{
				// Smaller label + a highlighted state line beneath it -- both
				// still fit inside the wedge at 256px.
				ctx.fillStyle='#fff';
				ctx.font='bold 17px sans-serif';
				ctx.textBaseline='middle';
				ctx.fillText(DIAL_LABELS[hand][dir],lx,ly-9);
				ctx.fillStyle='rgba(255,224,130,0.95)';
				ctx.font='bold 15px sans-serif';
				ctx.fillText(stateLine,lx,ly+10);
			}
			else
			{
				ctx.fillStyle='#fff';
				ctx.font='bold 22px sans-serif';
				ctx.textBaseline='middle';
				ctx.fillText(DIAL_LABELS[hand][dir],lx,ly);
			}
		}
		var centerText=dialCenterText(hand,state);
		if(centerText)
		{
			ctx.beginPath();
			ctx.arc(cx,cy,22,0,2*Math.PI);
			ctx.fillStyle='rgba(20,26,34,0.88)';
			ctx.fill();
			ctx.strokeStyle='rgba(230,237,243,0.6)';
			ctx.lineWidth=2;
			ctx.stroke();
			ctx.fillStyle='#fff';
			ctx.font='bold 13px sans-serif';
			ctx.textAlign='center';
			ctx.textBaseline='middle';
			ctx.fillText(centerText,cx,cy);
		}
		else
		{
			ctx.beginPath();
			ctx.arc(cx,cy,14,0,2*Math.PI);
			ctx.fillStyle='rgba(230,237,243,0.85)';
			ctx.fill();
		}
	}
	function ensureDialResources(hand)
	{
		if(undefined!==vr.dialRes[hand])
		{
			return vr.dialRes[hand]; // cached: an object, or false (unavailable).
		}
		var res=false;
		try
		{
			if(vr.mvBinding && vr.viewerSpace)
			{
				var canvas=document.createElement('canvas');
				canvas.width=256;
				canvas.height=256;
				var quad=vr.mvBinding.createQuadLayer({
					space:vr.viewerSpace,
					viewPixelWidth:256,
					viewPixelHeight:256,
					layout:'mono',
					width:0.12,
					height:0.12,
					transform:new XRRigidTransform({x:('right'===hand ? 0.18 : -0.18),y:-0.18,z:-0.8})
				});
				try
				{
					if('blendTextureSourceAlpha' in quad)
					{
						quad.blendTextureSourceAlpha=true;
					}
				}catch(e){}
				res={canvas:canvas,ctx:canvas.getContext('2d'),quad:quad,inLayers:false};
			}
		}
		catch(e)
		{
			console.warn('[vr] dial quad layer unavailable ('+hand+'): '+(e&&e.message?e.message:e));
			res=false;
		}
		vr.dialRes[hand]=res;
		return res;
	}
	function uploadCanvasToSubImage(canvas,sub)
	{
		// Save/restore every bit of GL state this touches: the engine renders
		// right after this call and must not see a changed active texture
		// unit, binding, or unpack flags.
		var prevActive=GLctx.getParameter(GLctx.ACTIVE_TEXTURE);
		var prevTex=GLctx.getParameter(GLctx.TEXTURE_BINDING_2D);
		var prevFlipY=GLctx.getParameter(GLctx.UNPACK_FLIP_Y_WEBGL);
		var prevPremult=GLctx.getParameter(GLctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
		GLctx.activeTexture(GLctx.TEXTURE0);
		GLctx.bindTexture(GLctx.TEXTURE_2D,sub.colorTexture);
		// FLIP_Y: canvas rows run top-down but the layer texture's origin is
		// bottom-left, so an unflipped upload shows the dial upside-down in
		// the headset.
		GLctx.pixelStorei(GLctx.UNPACK_FLIP_Y_WEBGL,true);
		GLctx.pixelStorei(GLctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
		GLctx.texSubImage2D(GLctx.TEXTURE_2D,0,0,0,GLctx.RGBA,GLctx.UNSIGNED_BYTE,canvas);
		GLctx.pixelStorei(GLctx.UNPACK_FLIP_Y_WEBGL,prevFlipY);
		GLctx.pixelStorei(GLctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL,prevPremult);
		GLctx.bindTexture(GLctx.TEXTURE_2D,prevTex);
		GLctx.activeTexture(prevActive);
	}
	// Per-frame dial-layer maintenance: create resources lazily, redraw the
	// canvas only when the visible selection changed, upload only when the
	// canvas changed, and keep session.renderState.layers in sync with which
	// quads are currently visible (projection layer always first/background).
	// Reads the 8-float aircraft-state block (fsvr.h) once per call. Cheap:
	// called at most once per XR frame, from updateDialLayers below.
	function readAircraftStateSnapshot()
	{
		try
		{
			var p=_YsfwVrAircraftStateDataPointer()>>2;
			return {
				valid:HEAPF32[p+0]>=0.5,
				gear:HEAPF32[p+1],
				brake:HEAPF32[p+2],
				flap:HEAPF32[p+3],
				wpnType:HEAPF32[p+4],
				wpnCount:HEAPF32[p+5]
			};
		}
		catch(e)
		{
			return {valid:false,gear:0,brake:0,flap:0,wpnType:-1,wpnCount:0};
		}
	}
	// Quantized signature used to decide whether a hand's canvas needs a
	// redraw: gear/flap rounded to whole percent so float jitter well under
	// one displayed digit doesn't force a redraw every frame, while genuine
	// movement (gear transit, flap steps) still updates promptly.
	function aircraftStateSig(s)
	{
		if(!s || !s.valid)
		{
			return 'invalid';
		}
		return [Math.round(s.gear*100),(s.brake>=0.5?1:0),Math.round(s.flap*100),Math.round(s.wpnType),Math.round(s.wpnCount)].join(',');
	}
	function updateDialLayers(frame)
	{
		if(!vr.mvBinding)
		{
			return;
		}
		var state=readAircraftStateSnapshot();
		var stateSig=aircraftStateSig(state);
		var hands=['right','left'],layersChanged=false;
		for(var i=0; i<hands.length; ++i)
		{
			var hand=hands[i];
			var dial=vr.ctl.dial[hand];
			var res=vr.dialRes[hand];
			if(!dial.visible)
			{
				if(res && res.inLayers)
				{
					res.inLayers=false;
					layersChanged=true;
				}
				continue;
			}
			res=ensureDialResources(hand);
			if(!res)
			{
				continue; // No quad-layer support: dial logic still ran above, just no visual.
			}
			if(!res.inLayers)
			{
				res.inLayers=true;
				res.drawnSel=null; // Force a redraw+upload on (re)appearance.
				res.drawnStateSig=null;
				layersChanged=true;
			}
			// Redraw when the sticky sector selection changes OR the live
			// aircraft state (gear/brake/flap/weapon) changes -- e.g. the
			// gear finishing its travel must update the dial even though
			// dial.sel hasn't moved.
			if(res.drawnSel!==dial.sel || res.drawnStateSig!==stateSig)
			{
				try
				{
					drawDial(res.ctx,hand,dial.sel,state);
					var sub=vr.mvBinding.getSubImage(res.quad,frame);
					uploadCanvasToSubImage(res.canvas,sub);
					res.drawnSel=dial.sel;
					res.drawnStateSig=stateSig;
				}
				catch(e){} // Leave res.drawnSel/drawnStateSig unset so the next frame retries.
			}
		}
		if(layersChanged)
		{
			var layers=[vr.mvLayer];
			if(vr.dialRes.right && vr.dialRes.right.inLayers){ layers.push(vr.dialRes.right.quad); }
			if(vr.dialRes.left && vr.dialRes.left.inLayers){ layers.push(vr.dialRes.left.quad); }
			try{ vr.session.updateRenderState({layers:layers}); }catch(e){}
		}
	}

	function onXRFrame(t,frame)
	{
		var session=vr.session;
		if(!session)
		{
			return;
		}
		session.requestAnimationFrame(onXRFrame);

		// Frame-rate statistics: the primary instrument for perf work on a
		// headset, where devtools are awkward.  Rolling 2s console log plus a
		// session summary (vr.stats, shown by the shell after exit).
		var st=vr.stats;
		if(0===st.frames)
		{
			st.t0=t;
			st.tWindow=t;
			st.framesWindow=0;
		}
		++st.frames;
		++st.framesWindow;
		st.t1=t;
		if(2000<=t-st.tWindow)
		{
			st.fps=1000*st.framesWindow/(t-st.tWindow);
			console.log('[vr] '+st.fps.toFixed(1)+' fps');
			st.tWindow=t;
			st.framesWindow=0;
		}

		// The engine may be suspended mid-frame (ASYNCIFY lazy-pack fetch);
		// re-entering would corrupt the unwound stack.  Skip the frame.
		if(typeof Asyncify!=='undefined' && 0!==Asyncify.state)
		{
			return;
		}

		var pose=frame.getViewerPose(vr.refSpace);
		if(vr.mvLayer)
		{
			if(pose)
			{
				writeEyeDataMv(pose);
				updateControllers(frame,pose);
				updateDialLayers(frame);
			}
		}
		else
		{
			var layer=session.renderState.baseLayer;
			if(pose)
			{
				writeEyeData(pose,layer);
				updateControllers(frame,pose);
			}
			vr.xrFb=layer.framebuffer;
		}
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,vr.xrFb);
		_YsfwExternalTick();

		// The 2D menus are not presented in VR: end the session when the
		// simulation stops drawing (~1.5s of silence).
		if(0<_YsfwVrConsumeSimDrawnFrames())
		{
			vr.simSilentFrames=0;
		}
		else if(100<++vr.simSilentFrames)
		{
			session.end().catch(function(){});
		}
	}

	vr.enter=function()
	{
		if(!vr.supported || vr.session)
		{
			return Promise.reject(new Error('VR not available'));
		}
		// Perf knobs, overridable from the shell (Module.ysfwVrOptions, wired
		// to ?vrscale= etc. in web/index.html):
		//   scale     XRWebGLLayer framebufferScaleFactor (fill-rate lever)
		//   foveation Quest fixed foveation 0..1 (1 = strongest periphery cut)
		//   frameRate preferred XR refresh rate (72 needs 13.9ms, 90 needs 11.1ms)
		//   antialias MSAA on the XR framebuffer (default off; expensive on mobile)
		// Default the XR framebuffer to 0.7x per axis (~half the pixels).  A
		// standalone Quest's native XR framebuffer is ~2k x 2.2k per eye; at
		// full scale the single-threaded engine drawing that twice per frame
		// blew the headset browser's per-tab memory budget (renderer killed =
		// white page + crash mark, reproducing on every subsequent flight
		// start).  0.7 keeps it well under the ceiling and roughly halves
		// fill-rate too.  ?vrscale=1.0 opts back into full resolution.
		var opts=Module.ysfwVrOptions||{};
		var scale=(0<opts.scale ? opts.scale : 0.7);
		// Single-pass stereo made the frame CPU-bound (GPU headroom), so the
		// multiview projection layer defaults to native resolution -- the 0.7
		// default predates multiview (two-pass fill-rate + tab-memory OOM).
		// ?vrscale= still overrides both paths.
		var mvScale=(0<opts.scale ? opts.scale : 1.0);
		var foveation=(undefined!==opts.foveation ? opts.foveation : 1.0);
		var frameRate=(0<opts.frameRate ? opts.frameRate : 72);
		var antialias=(undefined!==opts.antialias ? !!opts.antialias : false);
		vr.stats={frames:0,framesWindow:0,t0:0,t1:0,tWindow:0,fps:0};
		var wantMultiview=(undefined!==opts.multiview ? !!opts.multiview : true);
		return navigator.xr.requestSession('immersive-vr',{requiredFeatures:['local'],optionalFeatures:['layers']}).then(function(session)
		{
			vr.session=session;
			return GLctx.makeXRCompatible().then(function()
			{
				// Single-pass stereo when the whole chain is available:
				// WebXR layers (XRWebGLBinding + texture-array projection
				// layer) and OVR_multiview2.  Falls back to the classic
				// two-pass XRWebGLLayer path otherwise (?vrmv=0 forces it).
				vr.mvExt=null; vr.mvBinding=null; vr.mvLayer=null;
				if(wantMultiview && 'undefined'!==typeof XRWebGLBinding)
				{
					try
					{
						var mvExt=GLctx.getExtension('OCULUS_multiview')||GLctx.getExtension('OVR_multiview2');
						if(mvExt)
						{
							var binding=new XRWebGLBinding(session,GLctx);
							var mvLayer=binding.createProjectionLayer({textureType:'texture-array',scaleFactor:mvScale,depthFormat:GLctx.DEPTH24_STENCIL8});
							try
							{
								if('fixedFoveation' in mvLayer)
								{
									mvLayer.fixedFoveation=foveation;
								}
							}catch(e){}
							session.updateRenderState({layers:[mvLayer],depthNear:0.5,depthFar:40000.0});
							vr.mvExt=mvExt;
							vr.mvBinding=binding;
							vr.mvLayer=mvLayer;
							console.log('[vr] multiview projection layer (single-pass stereo), scale='+mvScale+' foveation='+foveation);
						}
					}
					catch(e)
					{
						console.warn('[vr] multiview unavailable, falling back to two-pass: '+(e&&e.message?e.message:e));
						vr.mvExt=null; vr.mvBinding=null; vr.mvLayer=null;
					}
				}
				if(!vr.mvLayer)
				{
					var layer=new XRWebGLLayer(session,GLctx,{framebufferScaleFactor:scale,antialias:antialias});
					try
					{
						if('fixedFoveation' in layer)
						{
							layer.fixedFoveation=foveation;
						}
					}catch(e){}
					session.updateRenderState({baseLayer:layer,depthNear:0.5,depthFar:40000.0});
				}
				try
				{
					// Prefer the highest supported rate not above the request.
					if(session.frameRates && session.updateTargetFrameRate)
					{
						var best=0;
						session.frameRates.forEach(function(r){ if(r<=frameRate && best<r){ best=r; } });
						if(0===best)
						{
							session.frameRates.forEach(function(r){ if(0===best || r<best){ best=r; } });
						}
						if(0<best)
						{
							session.updateTargetFrameRate(best).catch(function(){});
						}
					}
				}catch(e){}
				if(!vr.mvLayer)
				{
					console.log('[vr] layer '+session.renderState.baseLayer.framebufferWidth+'x'+session.renderState.baseLayer.framebufferHeight+
					            ' scale='+scale+' foveation='+foveation+' aa='+antialias);
				}
				return session.requestReferenceSpace('local');
			}).then(function(refSpace)
			{
				vr.refSpace=refSpace;
				// Head-locked space for the dial quad layers (see
				// ensureDialResources); requested once up front rather than
				// lazily since 'viewer' is always available on an
				// immersive-vr session and a rejected promise here should
				// only skip the dial visuals, not the whole session.
				return session.requestReferenceSpace('viewer').then(function(viewerSpace)
				{
					vr.viewerSpace=viewerSpace;
				}).catch(function(e)
				{
					console.warn('[vr] viewer reference space unavailable, dial layers disabled: '+(e&&e.message?e.message:e));
					vr.viewerSpace=null;
				});
			}).then(function()
			{
				installFbRedirect();

				session.addEventListener('end',function()
				{
					var st=vr.stats;
					if(st && 100<st.t1-st.t0)
					{
						st.seconds=(st.t1-st.t0)/1000;
						st.avgFps=(st.frames-1)/st.seconds;
						// Engine CPU time per tick (EMA).  If this is close to the
						// frame period (1000/fps), the frame is CPU-bound -- a
						// resolution-independent read that survives thermal drift,
						// unlike comparing fps across separate (differently-heated)
						// runs.
						st.cpuMs=(Module._YsfwGetTickMs ? Module._YsfwGetTickMs() : 0);
						console.log('[vr] session avg '+st.avgFps.toFixed(1)+' fps, '+
						            st.cpuMs.toFixed(0)+'ms CPU/frame (period '+(1000/st.avgFps).toFixed(0)+'ms), over '+st.seconds.toFixed(1)+'s');
					}
					vr.session=null;
					vr.refSpace=null;
					vr.xrFb=null;
					vr.mvExt=null;
					vr.mvBinding=null;
					vr.mvLayer=null;
					vr.mvFb=null;
					if(vr.mvDepth)
					{
						try{ GLctx.deleteTexture(vr.mvDepth); }catch(e){}
						vr.mvDepth=null;
						vr.mvDepthSize=null;
					}
					vr.simSilentFrames=0;

					// Controller state: zero the whole 16-float block for
					// cleanliness (FsVrIsActive is 0 from here on, so the
					// engine ignores it regardless) and reset the JS-side
					// grab/latch state, releasing any synthetic keys still
					// held down.
					var ctlPtr=_YsfwVrControlDataPointer()>>2;
					for(var zi=0; zi<16; ++zi)
					{
						HEAPF32[ctlPtr+zi]=0;
					}
					vrReleaseAllKeys();
					vr.ctl.stick={grabbed:false,q0:null};
					vr.ctl.thr={grabbed:false,p0:null,fwd0:null,base:0,value:0,ever:false};
					vr.ctl.rightTrigger=false;
					vr.ctl.rightA=false;
					vr.ctl.rightB=false;
					vr.ctl.leftX=false;
					vr.ctl.leftY=false;
					vr.ctl.leftTrigger=false;
					vr.ctl.dial.right={sel:'up',engaged:null,visible:false,hideAt:0};
					vr.ctl.dial.left={sel:'up',engaged:null,visible:false,hideAt:0};
					vr.viewerSpace=null;
					vr.dialRes={right:undefined,left:undefined};

					teardownHud();
					_YsfwVrSetPresenting(0);
					_YsfwVrSetMultiview(0);
					_YsfwSetExternalDrive(0);
					if(Module.onVrEnd)
					{
						Module.onVrEnd();
					}
				});

				_YsfwVrSetMultiview(vr.mvLayer ? 1 : 0);
				if(vr.mvLayer)
				{
					setupHud();
				}
				_YsfwVrSetPresenting(1);
				_YsfwSetExternalDrive(1);
				vr.simSilentFrames=0;
				session.requestAnimationFrame(onXRFrame);
				if(Module.onVrStart)
				{
					Module.onVrStart();
				}
			});
		}).catch(function(err)
		{
			var session=vr.session;
			vr.session=null;
			if(session)
			{
				try{ session.end().catch(function(){}); }catch(e){}
			}
			throw err;
		});
	};

	vr.exit=function()
	{
		if(vr.session)
		{
			vr.session.end().catch(function(){});
		}
	};

	// Debug/test hook: write raw eye data (up to 24 floats, see fsvr.h for
	// the layout) from the hosting page, which has no HEAPF32 access.
	// scripts/smoke-vr.mjs uses this to exercise the stereo path headless.
	vr.pokeEye=function(eye,floats)
	{
		HEAPF32.set(floats,_YsfwVrEyeDataPointer(eye)>>2);
	};
	vr.setPresenting=function(presenting)
	{
		_YsfwVrSetPresenting(presenting ? 1 : 0);
	};

	// Headless test hook for the controller path: scripts/smoke-vrctl.mjs
	// drives this without a live XR session (call vr.setPresenting(true)
	// first so FsVrIsActive is true and the engine trusts the block).
	//   list: array of {hand:'left'|'right', pos:[x,y,z], quat:[x,y,z,w],
	//         squeeze:0..1, trigger:0..1, thumb:[x,y] (optional, dial stick),
	//         buttons:{a:bool,b:bool}}
	//   viewerQuat: optional [x,y,z,w] headset orientation (default identity,
	//         forward -Z).
	// Goes through the exact same processControllerPlain as the real XR path
	// (updateControllers) -- no duplicated control logic.
	vr.pokeControllerFrame=function(list,viewerQuat)
	{
		var vq=viewerQuat ? {x:viewerQuat[0],y:viewerQuat[1],z:viewerQuat[2],w:viewerQuat[3]} : {x:0,y:0,z:0,w:1};
		for(var i=0; i<list.length; ++i)
		{
			var e=list[i];
			processControllerPlain({
				hand:e.hand,
				pos:{x:e.pos[0],y:e.pos[1],z:e.pos[2]},
				quat:{x:e.quat[0],y:e.quat[1],z:e.quat[2],w:e.quat[3]},
				squeeze:(undefined!==e.squeeze ? e.squeeze : 0),
				trigger:(undefined!==e.trigger ? e.trigger : 0),
				thumb:e.thumb,
				buttons:e.buttons||{}
			},vq,null);
		}
	};
	// Debug/test hook: read the 16-float control block back as a plain array
	// (see fsvr.h for the layout).  The hosting page has no HEAPF32 access
	// (this build does not export it), so scripts/smoke-vrctl.mjs uses this
	// instead of reading the wasm heap directly -- the read-side counterpart
	// of pokeEye's write.
	vr.readControlBlock=function()
	{
		var ptr=_YsfwVrControlDataPointer()>>2;
		var out=[];
		for(var i=0; i<16; ++i)
		{
			out.push(HEAPF32[ptr+i]);
		}
		return out;
	};

	// Headless test hooks for single-pass stereo: render into an
	// OVR_multiview2 texture-array framebuffer without a headset, then read
	// per-layer luminance.  scripts/smoke-mv.mjs drives these together with
	// pokeEye (which must set full-size viewports on both eyes).
	vr.forceMultiview=function(w,h)
	{
		var ext=GLctx.getExtension('OCULUS_multiview')||GLctx.getExtension('OVR_multiview2');
		if(!ext)
		{
			return 'no multiview extension';
		}
		// Allocate on a high texture unit and restore, so the engine's
		// per-unit sampler state is not disturbed.
		var prevActive=GLctx.getParameter(GLctx.ACTIVE_TEXTURE);
		GLctx.activeTexture(GLctx.TEXTURE15);
		var color=GLctx.createTexture();
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,color);
		GLctx.texStorage3D(GLctx.TEXTURE_2D_ARRAY,1,GLctx.RGBA8,w,h,2);
		var depth=GLctx.createTexture();
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,depth);
		GLctx.texStorage3D(GLctx.TEXTURE_2D_ARRAY,1,GLctx.DEPTH24_STENCIL8,w,h,2);
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,null);
		GLctx.activeTexture(prevActive);
		var fb=GLctx.createFramebuffer();
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,fb);
		ext.framebufferTextureMultiviewOVR(GLctx.FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,color,0,0,2);
		ext.framebufferTextureMultiviewOVR(GLctx.FRAMEBUFFER,GLctx.DEPTH_STENCIL_ATTACHMENT,depth,0,0,2);
		var st=GLctx.checkFramebufferStatus(GLctx.FRAMEBUFFER);
		if(st!==GLctx.FRAMEBUFFER_COMPLETE)
		{
			return 'fb incomplete 0x'+st.toString(16);
		}
		vr.testColor=color;
		vr.testW=w;
		vr.testH=h;
		vr.testMode=true;
		vr.xrFb=fb;
		installFbRedirect();
		_YsfwVrSetMultiview(1);
		setupHud();
		_YsfwVrSetPresenting(1);
		return 'ok';
	};
	vr.readMultiviewStats=function(layer)
	{
		// Mean luminance of a layer of the test color texture-array.
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.testColor,0,layer);
		var w=0,h=0;
		// texStorage size is fixed by forceMultiview's caller; read a coarse grid.
		var att=GLctx.getFramebufferAttachmentParameter(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,GLctx.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
		w=vr.testW; h=vr.testH;
		var px=new Uint8Array(w*h*4);
		GLctx.readPixels(0,0,w,h,GLctx.RGBA,GLctx.UNSIGNED_BYTE,px);
		var sum=0;
		for(var i=0; i<px.length; i+=4)
		{
			sum+=0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
		}
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,prev);
		GLctx.deleteFramebuffer(rfb);
		return { lum:sum/(px.length/4) };
	};
	vr.diffMultiviewLayers=function()
	{
		// Mean per-pixel |layer0-layer1| -- nonzero proves per-view rendering.
		var w=vr.testW,h=vr.testH;
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		var a=new Uint8Array(w*h*4),b=new Uint8Array(w*h*4);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.testColor,0,0);
		GLctx.readPixels(0,0,w,h,GLctx.RGBA,GLctx.UNSIGNED_BYTE,a);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.testColor,0,1);
		GLctx.readPixels(0,0,w,h,GLctx.RGBA,GLctx.UNSIGNED_BYTE,b);
		var sum=0;
		for(var i=0; i<a.length; i+=4)
		{
			sum+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
		}
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,prev);
		GLctx.deleteFramebuffer(rfb);
		return { meanDiff:sum/(a.length/4)/3 };
	};

	// Headless test hooks for the VR HUD composite (scripts/smoke-vrhud.mjs).
	// readHudData exposes the 8-float HUD state block (see fsvr.h);
	// readHudLayerStats reads back a given layer of the HUD texture array and
	// reports mean luminance AND mean alpha -- nonzero alpha proves the HUD was
	// actually drawn into the texture (not just cleared transparent).
	vr.readHudData=function()
	{
		var p=_YsfwVrHudDataPointer()>>2;
		var out=[];
		for(var i=0; i<8; ++i)
		{
			out.push(HEAPF32[p+i]);
		}
		return out;
	};

	// Headless test hook for the dial's aircraft-state readouts
	// (scripts/smoke-vrdial.mjs): the 8-float block from fsvr.h
	// (FsVrAircraftStateDataPointer) as a plain array -- same pattern as
	// readHudData/readControlBlock above (the hosting page has no HEAPF32
	// access; this is the read-side counterpart from inside the module).
	vr.readAircraftState=function()
	{
		var p=_YsfwVrAircraftStateDataPointer()>>2;
		var out=[];
		for(var i=0; i<8; ++i)
		{
			out.push(HEAPF32[p+i]);
		}
		return out;
	};
	vr.readHudLayerStats=function(layer)
	{
		if(!vr.hud)
		{
			return { lum:0, alpha:0 };
		}
		var w=vr.hud.w,h=vr.hud.h;
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.hud.tex,0,layer);
		var px=new Uint8Array(w*h*4);
		GLctx.readPixels(0,0,w,h,GLctx.RGBA,GLctx.UNSIGNED_BYTE,px);
		var lum=0,alpha=0;
		for(var i=0; i<px.length; i+=4)
		{
			lum+=0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
			alpha+=px[i+3];
		}
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,prev);
		GLctx.deleteFramebuffer(rfb);
		return { lum:lum/(px.length/4), alpha:alpha/(px.length/4) };
	};

	// dumpHudLayer: reads back a full HUD texture-array layer as RGBA and
	// returns it as a data: URL PNG (base64) via an offscreen 2D canvas.
	// Debug/headless-probe helper for diagnosing HUD layout bugs -- this is
	// the ground truth of what the engine drew into the HUD texture, as
	// opposed to reasoning about coordinate math.  GL readPixels is
	// bottom-up (row 0 = bottom of the image); canvas ImageData is top-down,
	// so the rows are flipped before putImageData.
	vr.dumpHudLayer=function(layer)
	{
		if(!vr.hud) { return null; }
		var w=vr.hud.w,h=vr.hud.h;
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.hud.tex,0,layer);
		var px=new Uint8ClampedArray(w*h*4);
		GLctx.readPixels(0,0,w,h,GLctx.RGBA,GLctx.UNSIGNED_BYTE,px);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,prev);
		GLctx.deleteFramebuffer(rfb);

		var flipped=new Uint8ClampedArray(w*h*4);
		for(var y=0; y<h; ++y)
		{
			var srcRow=h-1-y;
			flipped.set(px.subarray(srcRow*w*4,(srcRow+1)*w*4),y*w*4);
		}

		var canvas=document.createElement('canvas');
		canvas.width=w;
		canvas.height=h;
		var ctx2d=canvas.getContext('2d');
		var imgData=ctx2d.createImageData(w,h);
		imgData.data.set(flipped);
		ctx2d.putImageData(imgData,0,0);
		return canvas.toDataURL('image/png');
	};
});
// clang-format on

void YsfwSetUpWebXR(void)
{
	YsfwInstallWebXR();
}
