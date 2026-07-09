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
    throttle), and the face buttons/triggers fire synthetic KeyboardEvents
    on the default key bindings (fire gun, gear, spoiler/brake, flaps).

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
			keys:{}
		}
	};
	Module.ysfwVr=vr;

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
		var W=1024,H=1024;

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

			var triggerPressed=entry.trigger>GRAB_THRESHOLD;
			if(triggerPressed && !vr.ctl.rightTrigger)
			{
				vrHapticPulse(rawSrc);
			}
			vrKeyEdge('Space',triggerPressed); // Default fire-gun key (FSBTF_FIREWEAPON).
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
			processControllerPlain({
				hand:hand,
				pos:gpose.transform.position,
				quat:gpose.transform.orientation,
				squeeze:squeeze,
				trigger:trigger,
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
							var mvLayer=binding.createProjectionLayer({textureType:'texture-array',scaleFactor:scale,depthFormat:GLctx.DEPTH24_STENCIL8});
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
							console.log('[vr] multiview projection layer (single-pass stereo), scale='+scale+' foveation='+foveation);
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
	//         squeeze:0..1, trigger:0..1, buttons:{a:bool,b:bool}}
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
});
// clang-format on

void YsfwSetUpWebXR(void)
{
	YsfwInstallWebXR();
}
