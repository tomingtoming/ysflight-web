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

extern "C" int EMSCRIPTEN_KEEPALIVE YsfwVrConsumeSimDrawnFrames(void)
{
	return FsVrConsumeSimDrawnFrames();
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
		testMode:false
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
			}
		}
		else
		{
			var layer=session.renderState.baseLayer;
			if(pose)
			{
				writeEyeData(pose,layer);
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
					_YsfwVrSetPresenting(0);
					_YsfwVrSetMultiview(0);
					_YsfwSetExternalDrive(0);
					if(Module.onVrEnd)
					{
						Module.onVrEnd();
					}
				});

				_YsfwVrSetMultiview(vr.mvLayer ? 1 : 0);
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
});
// clang-format on

void YsfwSetUpWebXR(void)
{
	YsfwInstallWebXR();
}
