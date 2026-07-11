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
  - Four on-device-tested control refinements (SaccFlight-style), all
    implemented in processControllerPlain/deflectionFromDeltaQ below:
      - Recenter: holding right A for >=1s re-offsets the reference space
        from the CURRENT head pose (position fully, orientation by YAW ONLY
        so gravity/horizon stay true) instead of firing the gear tap; a
        quick press+release (<400ms) still fires gear as before (see
        vrRecenter/A_RECENTER_MS/A_TAP_MAX_MS).
      - Sticky grab: double-squeezing either grip within 250ms latches a
        persistent grab that keeps tracking the stick/throttle without
        holding the grip physically; the next full squeeze-release ends it
        (see updateSticky).
      - Rudder deadzone + optional expo: wrist-roll-into-rudder bleed is
        filtered by a small deadzone on the yaw axis only (remapped so full
        deflection still reaches +-1), plus an optional exponent curve on
        all three stick axes -- both tunable via Module.ysfwVrOptions
        (yawDeadzoneDeg, stickExpo; see applyDeadzone/applyExpo).
      - Afterburner detent: shoving the grabbed throttle past its 1.0 stop
        (>=~3cm of extra travel at a deliberate speed) taps the engine's
        default afterburner key (Tab, FSBTF_AFTERBURNER -- a toggle); pulling
        the lever back below ~0.95 taps it again to disengage.
  - Each hand also gets a small help-placard XRQuadLayer (layers path only,
    same best-effort try/catch discipline as the dial quads): a static
    controller diagram with callout labels for what every input does,
    positioned ~12cm above that hand's grip pose and re-billboarded toward
    the headset (yaw only) every frame (see updateHelpLayers/
    updateHelpTransform). Auto-shows on session start for 12s, then hides;
    a thumbstick click (xr-standard buttons[3]) on either hand toggles both
    placards at any time (see showHelp/toggleHelp/updateHelpAutoHide). Kill
    switch: Module.ysfwVrOptions.help===false (?vrhelp=0).
  - GUI-in-VR: the engine's 2D dialog machinery (autopilot/radio-comm menus,
    replay/continue dialogs) still opens and grabs input in VR even though
    ordinary 2D drawing is skipped -- e.g. the left dial's AP tap
    (Backspace) opened an invisible, un-closeable autopilot menu. The
    OWNER hand's selection-guide (drawGuiDialGuide, driven by
    computeGuiMenuLayout reading the engine's real option labels -- fsvr.h's
    FsVrGuiMenuPointer, written every VR frame by
    FsSimulation::SimComputeVrGuiState regardless of the composite below) is
    SELF-SUFFICIENT to operate any in-flight dialog that fits its 6 slots and
    is hotkey-driven (guiMenu.drivable), which covers the autopilot family
    plus the radio-comm/ATC/approach menus (see fsvr.h's apMenu doc comment
    for the exact list) -- so the on-quad rendering of the dialog itself is
    now OPT-IN, default OFF (see guiPanelWanted/Module.ysfwVrOptions.guiPanel,
    ?vrpanel=1). setupGui/teardownGui allocate a second off-screen two-layer
    multiview framebuffer (640x360x2, see fsvr.h's FsVrGuiDataPointer --
    shrunk from an earlier 1024x640 so the SAME absolute-pixel dialog layout
    covers a bigger fraction of the texture, ~1.6x bigger on the composited
    quad) that the engine (FsSimulation::SimDrawVrGui) renders whichever
    dialog is currently open into every frame, composited onto a second,
    GUI-anchored quad (closer/lower than the HUD glass) -- see
    guiDialogState/vr.readGuiData. Absolute kill switch:
    Module.ysfwVrOptions.gui===false. The panel is force-enabled anyway
    (maybeForceGuiPanel) the instant the guide itself finds a dialog it
    cannot fully drive -- more real options than its 6 slots (radio-comm
    menus can have 7+), or not hotkey-driven at all
    (replay/continue/stationary/vehicle-change/chat -- mouse-only) -- so
    nothing becomes unreachable, it just costs the composite only when
    actually needed.

    Ownership: the dialog is driven ENTIRELY by whichever hand's dial tap
    plausibly opened it (vr.ctl.guiOwner, set the instant
    guiDialogState().visible transitions false->true, from
    vr.ctl.lastDialTapHand -- see processControllerPlain's doc comment;
    defaults to 'left', where the AP tap lives, if that is stale/unknown).
    While a dialog is open, processControllerPlain reroutes ONLY the owner
    hand's 4 stick sectors + A/B to the dialog's own hotkeys (Digit1..5/
    Digit0, see GUI_DIAL) when guiMenu.drivable, or to a generic
    Escape/cancel tap otherwise (GUI_ESCAPE_ACTION); the owner hand's
    thumbstick click is repurposed as a truthful cancel/Escape binding (the
    one input left spare once 4 sectors + trigger + A + B are spoken for).
    The OTHER hand is completely untouched -- its dial, trigger, A/B/X/Y all
    keep their normal flight-control meaning, exactly as if no dialog were
    open, so the pilot never loses that hand's functions to a dialog they
    didn't open. Discoverability: the owner hand's quad is FORCED visible for
    as long as a dialog stays open (regardless of thumbstick engagement) and
    switches to a dialog-guide face -- sectors numbered 1..4 (+A=5/B=0, or
    X=5/Y=0 on the left hand, in the centre) labelled with the dialog's REAL
    option text when drivable, or a uniform "ESC" face (with a "see panel"
    hint once the panel is forced) otherwise -- see
    drawGuiDialGuide/rdial.guiMode/rdial.guiMenu (ldial.* symmetrically);
    falls back to the normal dial the instant the dialog closes. Grip-stick
    (aileron/elevator/rudder) and the throttle grip are NEVER affected, on
    EITHER hand: the plane keeps flying regardless of any open dialog. See
    the doc comment on GUI_DIAL for why this stops at a 4-hotkey stick
    mapping rather than the generic Tab-focus/Arrow-key/Enter scheme a first
    read of the engine might suggest -- most in-flight dialogs (the autopilot
    family included) do not actually route keyboard input through that
    generic path.

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

// Forwards to the engine's VR in-flight-GUI-dialog composite state block
// (fsvr.h, 8 floats): the JS runtime writes [enable,fbo,texArray,texW,texH]
// here when single-pass stereo engages (see setupGui below); the engine
// (FsSimulation::SimDrawVrGui) writes [5] dialogVisible and [6] apMenu back
// every frame -- see fsvr.h's doc comment on FsVrGuiDataPointer for the full
// layout. This is what makes a modal in-flight dialog (autopilot menu,
// radio-comm menus, replay/continue dialogs, ...) visible and operable in
// VR: without it, SimDrawGuiDialog's whole call is skipped while
// FsVrIsActive, so a dialog opened mid-flight (e.g. Backspace ->
// FSBTF_OPENAUTOPILOTMENU) was invisible and left the pilot stuck.
extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrGuiDataPointer(void)
{
	return FsVrGuiDataPointer();
}

// Forwards to the engine's VR in-flight-GUI MENU block (fsvr.h): the ordered
// option-label list of whichever modal in-flight dialog is currently open,
// written every VR frame by FsSimulation::SimComputeVrGuiState independent of
// whether the quad composite above is even allocated. The right dial's
// selection-guide (drawGuiDialGuide/computeGuiMenuLayout below) reads this
// instead of hand-transcribed captions, so it can never show a dialog option
// that does not actually exist.
extern "C" const char * EMSCRIPTEN_KEEPALIVE YsfwVrGuiMenuPointer(void)
{
	return FsVrGuiMenuPointer();
}
extern "C" int EMSCRIPTEN_KEEPALIVE YsfwVrGuiMenuLength(void)
{
	return FsVrGuiMenuLength();
}
extern "C" int EMSCRIPTEN_KEEPALIVE YsfwVrGuiMenuVersion(void)
{
	return FsVrGuiMenuVersion();
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
		// The un-offset 'local' space captured once at session start.
		// vrRecenter() always re-offsets FROM this (not from the current
		// vr.refSpace), so repeated recenters don't accumulate drift.
		baseRefSpace:null,
		// Last real XR viewer pose (plain {position,orientation}, copied out
		// of the XRPose's read-only DOMPointReadOnly members each frame in
		// onXRFrame) -- vrRecenter needs a pose to offset from but only runs
		// from the right A button handler, which has no frame object of its
		// own.
		lastViewerPose:null,
		// Bumped on every vrRecenter() call, even when the guard above
		// aborts it (no real session yet) -- lets headless tests confirm
		// the long-hold path actually ran the handler.
		recenterAttempts:0,
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
		// In-flight-dialog quad composite (fsvr.h FsVrGuiDataPointer): same
		// shape as hud above (vr.gui, set once setupGui allocates it), but
		// default OFF -- guiForced latches true the first time the guide
		// (computeGuiMenuLayout/maybeForceGuiPanel) finds a dialog it cannot
		// fully drive on its own, for the rest of the session (see
		// guiPanelWanted, teardownGui resets it).
		guiForced:false,
		// Head-locked function-dial quad layers (lazily created, layers path
		// only). viewerSpace: the session's 'viewer' reference space the
		// quads are anchored to. dialRes[hand]: undefined = not yet
		// attempted, false = attempted and unavailable (no quad-layer
		// support), object = {canvas,ctx,quad,inLayers} once created.
		viewerSpace:null,
		dialRes:{right:undefined,left:undefined},
		// Per-hand controller help placards: same lazy-resource shape as
		// dialRes (undefined = not yet attempted, false = unavailable, object
		// = {canvas,ctx,quad,inLayers,drawn} once created), but anchored to
		// vr.refSpace (not viewerSpace) and repositioned every frame from the
		// hand's own grip pose rather than being head-locked (see
		// updateHelpLayers/updateHelpTransform below). help: the plain,
		// headless-testable visibility/toggle state (see showHelp/toggleHelp/
		// updateHelpAutoHide, scripts/smoke-vrctl.mjs Group 11).
		helpRes:{right:undefined,left:undefined},
		help:{visible:false,shownAt:0,stickPrev:{right:false,left:false}},
		lastRawSrc:{right:null,left:null},
		hapticPrev:null,
		// Hand-controller state (virtual stick + throttle + button latches).
		// See fsvr.h / FsVrControlDataPointer for the 16-float block this
		// feeds, and updateControllers/processControllerPlain below.
		ctl:{
			// sticky: double-squeeze latch state, shared shape for both
			// hands (see updateSticky). latched: a persistent grab is
			// active without the physical grip held. disengageArmed: while
			// latched, a fresh physical press has been seen and the next
			// release should end the latch. prevPhys: the grip's raw
			// (pre-latch) squeeze-pressed state, to detect edges
			// independent of the effective (physical-OR-latched) value.
			// lastReleaseAt: timestamp of the last physical release, to
			// detect a second press within the double-squeeze window.
			stick:{grabbed:false,q0:null,sticky:{latched:false,disengageArmed:false,prevPhys:false,lastReleaseAt:0}},
			thr:{grabbed:false,p0:null,fwd0:null,base:0,value:0,ever:false,
				sticky:{latched:false,disengageArmed:false,prevPhys:false,lastReleaseAt:0},
				// Afterburner detent (left/throttle hand only): abEngaged
				// mirrors the engine's ctlAb toggle so the detent taps Tab
				// exactly once per crossing; lastPushM/lastT are the
				// previous frame's forward-push distance/timestamp, used to
				// derive a m/s "shove speed" for the engage gate.
				abEngaged:false,lastPushM:0,lastT:0},
			rightTrigger:false,
			// Which hand drives an open in-flight-GUI dialog ('left'|
			// 'right'), and the bookkeeping used to pick it -- see
			// processControllerPlain's guiOwner doc comment. guiWasVisible:
			// previous-call dialogVisible, to detect the false->true
			// transition that (re)assigns guiOwner. lastDialTapHand/
			// lastDialTapAt: which hand's dial most recently dispatched a
			// REAL (non-dialog) tap/hold, and when -- attributed to
			// whichever hand's press plausibly opened the dialog.
			guiOwner:'left',
			guiWasVisible:false,
			lastDialTapHand:null,
			lastDialTapAt:0,
			// Right A button: press/hold/release state for the tap-vs-
			// recenter decision (see A_TAP_MAX_MS/A_RECENTER_MS).
			aBtn:{pressed:false,pressAt:0,recentered:false},
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
			},
			// Last known grip pose per hand, plain-copied out of this frame's
			// XRPose each frame in updateControllers (real XR path only --
			// null whenever that hand had no pose this frame, e.g. out of
			// tracking). Consumed by updateHelpLayers to reposition the help
			// placard quads; a null entry means "skip this hand's transform
			// update this frame" per the feature spec.
			gripPose:{right:null,left:null}
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

	// GUI-dialog stick mapping (see SimDrawVrGui's doc comment / fsvr.h's
	// FsVrGuiDataPointer): while a modal in-flight dialog is open (guiData[5]
	// dialogVisible), this REPLACES RIGHT_DIAL/LEFT_DIAL for the OWNER hand's
	// thumbstick 4 sectors (see vr.ctl.guiOwner / processControllerPlain's
	// rActive/lActive -- whichever hand's dial tap plausibly opened the
	// dialog), so that hand's trigger sector-tap dispatches the dialog's own
	// direct hotkeys instead of its normal flight functions. The OTHER hand
	// never consults this table at all -- see the class doc comment's
	// "Ownership" paragraph. Digit1..4 only: this table is only consulted
	// when computeGuiMenuLayout says the menu is "drivable" (see
	// processControllerPlain) -- the engine reports apMenu (the open dialog
	// is one of the hotkey-driven in-flight dialogs: the autopilot family
	// plus radio-comm/ATC/approach menus, see fsvr.h's apMenu doc comment for
	// the full list) AND has at least one real option. Those dialogs'
	// ProcessRawKeyInput (fsguiinfltdlg.cpp) all consume
	// Digit1..Digit9/Digit0/Escape directly and POSITIONALLY (the Nth option
	// added is the Nth digit, regardless of what FsGuiDialogItem::fsKey the
	// button itself carries -- see fsvr.h's FsVrGuiMenuPointer doc comment),
	// independent of the generic FsGuiDialog Tab-focus/mouse-click machinery
	// that the remaining, mouse-only in-flight dialogs rely on instead (see
	// updateControllers' doc comment below for why this table stops at 4:
	// Digit5/Digit0 are reached through the owner hand's A/B buttons
	// instead, freeing the 4-sector stick for the first 4 options of
	// whichever dialog is actually open). The .label fields below are just
	// internal, descriptive fallback text (the AP menu's own options,
	// historically the only dialog wired up here) -- NOT what is drawn
	// in-headset any more; the actual on-canvas guide (drawGuiDialGuide)
	// reads the CURRENT dialog's real option text from the owner hand's
	// dial.guiMenu (computeGuiMenuLayout), so it stays correct for whichever
	// of the drivable dialogs is open.
	var GUI_DIAL={
		up:   {label:'1', code:'Digit1', mode:'tap'},
		right:{label:'2', code:'Digit2', mode:'tap'},
		down: {label:'3', code:'Digit3', mode:'tap'},
		left: {label:'4', code:'Digit4', mode:'tap'}
	};
	// Generic "close/cancel" action for any OTHER in-flight dialog
	// (dialogVisible but not apMenu -- radio-comm menus, replay/continue
	// dialogs, etc.): every in-flight dialog in the engine either consumes
	// Escape directly (FsGuiInFlightDialog::ProcessRawKeyInput overrides in
	// fsguiinfltdlg.cpp all treat it as "close this dialog") or has a
	// Cancel-labelled button bound to FSKEY_ESC that the generic
	// FsGuiDialog::KeyIn's fsKey match clicks -- so Escape is the one input
	// confirmed safe to fire at ANY open dialog, unlike Tab/Arrow keys/Enter
	// (see the investigation notes in fsvr.h's FsVrGuiDataPointer comment).
	// Also what the owner hand's thumbstick-click cancel binding dispatches
	// (see processControllerPlain's rActive/lActive stick-click branch),
	// regardless of drivable/apMenu.
	var GUI_ESCAPE_ACTION={label:'Cancel', code:'Escape', mode:'tap'};

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

	// ---- VR in-flight-GUI-dialog composite resources ---------------------
	// Same shape as setupHud/teardownHud above, driven by
	// _YsfwVrGuiDataPointer() (fsvr.h's FsVrGuiDataPointer) instead of the HUD
	// block. The engine renders whatever modal in-flight dialog is currently
	// open (autopilot menu, radio-comm menus, replay/continue dialogs, ...)
	// into this off-screen framebuffer and composites it onto a second,
	// GUI-anchored quad -- see SimDrawVrGui / FsVrDrawGuiQuad. Kill switch:
	// Module.ysfwVrOptions.gui===false (?vrgui=0 in web/index.html) leaves
	// the whole feature off (enable stays 0, no GL objects created).
	// 640x360 (16:9): small enough that the FsGuiDialog family's small,
	// window-size-independent absolute-pixel layouts (see SimDrawVrGui's doc
	// comment) cover a much bigger FRACTION of the texture than the previous
	// 1024x640 did, while still (checked against the autopilot menu, the
	// widest in-flight dialog that matters for GUI_DIAL's hotkey guide --
	// see scripts/smoke-vrgui.mjs) fitting inside it uncropped. Composited
	// onto the SAME physical quad size (FsVrDrawGuiQuad, fssimulation.cpp),
	// this makes the dialog appear roughly 1024/640 = 1.6x bigger to the
	// pilot without touching the quad's world-space placement.
	// Whether the in-flight-dialog quad should actually be allocated/composited
	// this session. Module.ysfwVrOptions.gui===false is the absolute kill
	// switch (unchanged). Otherwise the quad is OPT-IN, default OFF: the right
	// dial's selection guide (drawGuiDialGuide) reads the engine's real option
	// labels (fsvr.h's FsVrGuiMenuPointer) and is enough on its own to operate
	// any dialog that fits its 6 slots and is hotkey-driven (see
	// computeGuiMenuLayout's "drivable" flag) -- most of the time, the quad's
	// GPU/composite cost buys nothing. Two ways to get it anyway:
	// Module.ysfwVrOptions.guiPanel===true (?vrpanel=1 in web/index.html,
	// explicit opt-in), or vr.guiForced (set by maybeForceGuiPanel once the
	// guide itself determines the CURRENT dialog does not fit the dial --
	// more real options than it has slots, or not hotkey-driven at all --
	// see processControllerPlain).
	function guiPanelWanted()
	{
		var opts=Module.ysfwVrOptions||{};
		if(false===opts.gui)
		{
			return false;
		}
		return true===opts.guiPanel || true===vr.guiForced;
	}
	// Called from the guide-layout logic (processControllerPlain) the first
	// time the currently-open dialog turns out not to fit the dial guide
	// alone. Latches for the rest of the session (teardownGui resets it) --
	// once a menu has needed the panel, simplest and safest to just leave it
	// available rather than tearing it down and reallocating every time the
	// dialog type changes.
	function maybeForceGuiPanel()
	{
		if(vr.guiForced)
		{
			return;
		}
		vr.guiForced=true;
		setupGui();
	}
	function setupGui()
	{
		if(!guiPanelWanted())
		{
			return;
		}
		if(vr.gui)
		{
			return;
		}
		var ext=vr.mvExt||GLctx.getExtension('OCULUS_multiview')||GLctx.getExtension('OVR_multiview2');
		if(!ext)
		{
			return;
		}
		var W=640,H=360;

		var prevActive=GLctx.getParameter(GLctx.ACTIVE_TEXTURE);
		GLctx.activeTexture(GLctx.TEXTURE15);
		var tex=GLctx.createTexture();
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,tex);
		GLctx.texStorage3D(GLctx.TEXTURE_2D_ARRAY,1,GLctx.RGBA8,W,H,2);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_MIN_FILTER,GLctx.LINEAR);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_MAG_FILTER,GLctx.LINEAR);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_WRAP_S,GLctx.CLAMP_TO_EDGE);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_WRAP_T,GLctx.CLAMP_TO_EDGE);
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,null);
		GLctx.activeTexture(prevActive);

		var fb=GLctx.createFramebuffer();
		var prevFb=GLctx.getParameter(GLctx.FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,fb);
		ext.framebufferTextureMultiviewOVR(GLctx.FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,tex,0,0,2);
		var st=GLctx.checkFramebufferStatus(GLctx.FRAMEBUFFER);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,prevFb);
		if(st!==GLctx.FRAMEBUFFER_COMPLETE)
		{
			console.warn('[vr] GUI framebuffer incomplete 0x'+st.toString(16)+' -- GUI disabled');
			GLctx.deleteFramebuffer(fb);
			GLctx.deleteTexture(tex);
			return;
		}

		var fbId=GL.getNewId(GL.framebuffers);
		GL.framebuffers[fbId]=fb;
		fb.name=fbId;
		var texId=GL.getNewId(GL.textures);
		GL.textures[texId]=tex;
		tex.name=texId;

		var p=_YsfwVrGuiDataPointer()>>2;
		HEAPF32[p+0]=1;     // enable
		HEAPF32[p+1]=fbId;  // guiFbo
		HEAPF32[p+2]=texId; // guiTexArray
		HEAPF32[p+3]=W;
		HEAPF32[p+4]=H;
		HEAPF32[p+5]=0; HEAPF32[p+6]=0; HEAPF32[p+7]=0;

		vr.gui={fb:fb,tex:tex,fbId:fbId,texId:texId,w:W,h:H};
		console.log('[vr] GUI composite '+W+'x'+H+'x2 (fbId='+fbId+' texId='+texId+')');
	}

	function teardownGui()
	{
		var p=_YsfwVrGuiDataPointer()>>2;
		for(var i=0; i<8; ++i)
		{
			HEAPF32[p+i]=0;
		}
		vr.guiForced=false; // Next session starts back at the default (off).
		if(!vr.gui)
		{
			return;
		}
		try{ GLctx.deleteFramebuffer(vr.gui.fb); }catch(e){}
		try{ GLctx.deleteTexture(vr.gui.tex); }catch(e){}
		GL.framebuffers[vr.gui.fbId]=null;
		GL.textures[vr.gui.texId]=null;
		vr.gui=null;
	}

	// Reads back [dialogVisible,apMenu] from the GUI state block -- cheap,
	// polled once per controller-update frame (see processControllerPlain)
	// to decide whether hand-controller input should route to the dialog
	// instead of its normal flight-control meaning. Correct and up to date
	// EVEN WHEN the quad above was never allocated (guiPanelWanted()===false):
	// the engine (FsSimulation::SimComputeVrGuiState) writes [5]/[6] every VR
	// frame unconditionally -- see fsvr.h's FsVrGuiDataPointer doc comment.
	function guiDialogState()
	{
		var p=_YsfwVrGuiDataPointer()>>2;
		return {visible:0!==HEAPF32[p+5],apMenu:0!==HEAPF32[p+6]};
	}

	// ---- GUI-dialog MENU: read the engine's real option-label list --------
	// (fsvr.h's FsVrGuiMenuPointer, written every VR frame by
	// FsSimulation::SimComputeVrGuiState/SimSerializeVrGuiMenu). Cached by
	// version so repeated reads within the same unchanged menu are free --
	// mirrors the aircraft-state block's change-driven redraw idiom.
	var guiMenuCache={version:-1,items:[]};
	function readGuiMenu()
	{
		var ver=_YsfwVrGuiMenuVersion();
		if(ver===guiMenuCache.version)
		{
			return guiMenuCache.items;
		}
		var items=[];
		var len=_YsfwVrGuiMenuLength();
		if(0<len)
		{
			var text=UTF8ToString(_YsfwVrGuiMenuPointer(),len);
			var lines=text.split('\n');
			for(var i=0; i<lines.length; ++i)
			{
				if(0<lines[i].length)
				{
					items.push(lines[i]);
				}
			}
		}
		guiMenuCache.version=ver;
		guiMenuCache.items=items;
		return items;
	}
	// Extracts the leading hotkey token every FsGuiInFlightDialog option
	// label carries by convention (e.g. "1...Circle", "2:Hover",
	// "ESC:Cancel", "ESC: (Don't request approach.)" -- see
	// fsguiinfltdlg.cpp's Make() functions). This, not
	// FsGuiDialogItem::fsKey, is the reliable source: several dialogs
	// register buttons with fsKey==FSKEY_NULL and dispatch the real hotkey
	// positionally in a hand-written ProcessRawKeyInput switch instead (see
	// fsvr.h's FsVrGuiMenuPointer doc comment). Returns {hotkey,text}:
	// hotkey is '0'..'9', 'ESC', or null (no recognized prefix, e.g. a
	// "<<Prev"/"Next>>" page button); text has the prefix and its punctuation
	// stripped.
	function parseMenuLabel(label)
	{
		var m=/^\s*(ESC|[0-9])\s*[:.]+\s*/.exec(label);
		if(m)
		{
			return {hotkey:m[1],text:label.slice(m[0].length)};
		}
		return {hotkey:null,text:label};
	}
	// How many of the dial's fixed slots (4 sectors + right-A + right-B) a
	// menu can use.
	var GUI_DIAL_CAPACITY=6;
	// Turns the engine's raw option-label list into what the dial guide can
	// actually show: the non-cancel options (up to GUI_DIAL_CAPACITY of
	// them), the cancel line separately, an overflow flag when there were
	// MORE real options than that, and "drivable" -- whether GUI_DIAL's
	// fixed Digit1../Digit0 dispatch (below) is trustworthy to promise via a
	// numbered face at all, which requires BOTH that the engine says this
	// dialog accepts direct positional hotkeys (hotkeyMenu, fsvr.h's apMenu)
	// AND that there is at least one real option to show. Overflow does NOT
	// affect drivable/dispatch: sectors 1-4 and A(5)/B(0) still fire the
	// exact same real actions whether or not a 7th+ option exists out of the
	// dial's reach -- overflow only means the guide must ALSO point at the
	// on-quad panel (forced on, see maybeForceGuiPanel) for the rest.
	function computeGuiMenuLayout(hotkeyMenu)
	{
		var raw=readGuiMenu();
		var options=[],cancel=null;
		for(var i=0; i<raw.length; ++i)
		{
			var parsed=parseMenuLabel(raw[i]);
			if('ESC'===parsed.hotkey && null===cancel)
			{
				cancel=parsed;
			}
			else
			{
				options.push(parsed);
			}
		}
		return {
			options:options.slice(0,GUI_DIAL_CAPACITY),
			cancel:cancel,
			overflow:GUI_DIAL_CAPACITY<options.length,
			drivable:(true===hotkeyMenu && 0<options.length)
		};
	}
	function clipGuideText(text,maxLen)
	{
		maxLen=maxLen||9;
		if(!text)
		{
			return '';
		}
		return (maxLen<text.length) ? (text.slice(0,maxLen-1)+'…') : text;
	}

	// ---- VR controller -> flight-control state block --------------------
	// Writes into the 16-float block at _YsfwVrControlDataPointer() (see
	// fsvr.h for the layout).  All the actual per-controller logic lives in
	// processControllerPlain, driven by a plain {hand,pos,quat,squeeze,
	// trigger,buttons} shape so the real XR path (updateControllers) and the
	// headless test hook (vr.pokeControllerFrame) share one implementation.

	var MAX_ANGLE=Math.PI/4;   // 45 degrees: full stick deflection.
	var THROTTLE_SENS=6;       // 1/6 m (~17cm) forward push = full 0..1 range.
	var GRAB_THRESHOLD=0.75;   // xr-standard squeeze value = "pressed" (grip only).
	// Trigger press-edge threshold: intentionally LOWER than GRAB_THRESHOLD.
	// On-device testing found a fast, deliberate trigger pull can land its
	// whole press-and-release inside the ~one-XR-frame gap this app polls
	// gamepad.buttons[0].value at (the engine ticks are CPU-bound, not
	// vsync-locked -- see the class doc comment's "CPU-bound" notes) -- a
	// 0.75 gate is a genuinely deep pull, and a quick "select Brake, pull
	// trigger" motion could sample a value that rose past 0.5 but not past
	// 0.75 before falling back, reading as no press at all. Applies to EVERY
	// trigger press-edge comparison (dial tap/hold dispatch, hold release,
	// GUI-dialog routing) -- grip squeeze (the stick/throttle grab gesture)
	// keeps the deeper GRAB_THRESHOLD since an accidental shallow squeeze
	// there would unintentionally grab the flight controls.
	var TRIGGER_THRESHOLD=0.5;

	// Right-A button (recenter/gear) timing (see processControllerPlain).
	var A_TAP_MAX_MS=400;      // release at or before this -> gear tap.
	var A_RECENTER_MS=1000;    // held at least this long -> recenter fires.

	// Sticky-grab double-squeeze window (see updateSticky), both hands.
	var STICKY_DOUBLE_MS=250;

	// Afterburner detent (left/throttle hand, see processControllerPlain).
	var AB_OVERSHOOT_M=0.03;      // virtual travel past the 1.0 stop to engage.
	var AB_SHOVE_SPEED_MPS=0.15;  // minimum forward push speed to count as a shove.
	var AB_DISENGAGE_VALUE=0.95;  // pulling back below this disengages.

	// Rudder deadzone + stick expo defaults (Module.ysfwVrOptions overrides,
	// see vrOpt/deflectionFromDeltaQ): ?vryawdz=/?vrexpo= in web/index.html.
	var DEFAULT_YAW_DEADZONE_DEG=6;
	var DEFAULT_STICK_EXPO=1.0;

	function clamp(v,lo,hi){ return v<lo ? lo : (v>hi ? hi : v); }

	// Reads a VR option, falling back to def when Module.ysfwVrOptions is
	// absent or doesn't set that key.  Read fresh (not cached) each call:
	// Module.ysfwVrOptions is assigned once by web/index.html before
	// Module.ysfwVr.enter() but this glue's closure runs earlier, at
	// YsfwSetUpWebXR/module-init time.
	function vrOpt(name,def)
	{
		var o=Module.ysfwVrOptions||{};
		return (undefined!==o[name] ? o[name] : def);
	}

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
	// Deadzone on an angle already normalized to a max-deflection radius:
	// |angle|<=dzRad reads as exactly 0; beyond it, the remaining range is
	// remapped to 0..1 so the axis still reaches full deflection at
	// maxAngleRad (linear remap, not just a clamp-and-shift).
	function applyDeadzone(angleRad,dzRad,maxAngleRad)
	{
		var mag=Math.abs(angleRad);
		if(mag<=dzRad)
		{
			return 0;
		}
		var remapped=(mag-dzRad)/(maxAngleRad-dzRad);
		return clamp((angleRad<0 ? -remapped : remapped),-1,1);
	}
	// Exponent response curve, sign-preserving (expo=1 is a no-op passthrough,
	// the default -- see DEFAULT_STICK_EXPO/?vrexpo=).
	function applyExpo(x,expo)
	{
		if(1===expo)
		{
			return x; // Common case, and avoids a Math.pow(x,1) precision detour.
		}
		return (x<0 ? -1 : 1)*Math.pow(Math.abs(x),expo);
	}

	function deflectionFromDeltaQ(dq)
	{
		var f=rotateVecByQuat({x:0,y:0,z:-1},dq);
		var r=rotateVecByQuat({x:1,y:0,z:0},dq);
		var pitch=Math.asin(clamp(f.y,-1,1));
		var yaw=Math.atan2(-f.x,-f.z);
		var roll=Math.asin(clamp(r.y,-1,1));

		// Rudder-only deadzone: on-device testing found rolling the wrist
		// (an aileron gesture) bleeds a little yaw into the rudder axis.
		// Pitch/roll are unaffected.
		var dzRad=vrOpt('yawDeadzoneDeg',DEFAULT_YAW_DEADZONE_DEG)*Math.PI/180;
		var rudder=applyDeadzone(yaw,dzRad,MAX_ANGLE);

		var expo=vrOpt('stickExpo',DEFAULT_STICK_EXPO);
		return {
			elevator:applyExpo(clamp(pitch/MAX_ANGLE,-1,1),expo),
			rudder:applyExpo(rudder,expo),
			aileron:applyExpo(clamp(-roll/MAX_ANGLE,-1,1),expo)
		};
	}

	// Yaw-only component of a full orientation quaternion, for the recenter
	// feature (vrRecenter): recentering should zero out the pilot's heading
	// and position but must NOT bake in whatever incidental head pitch/roll
	// existed at the moment of the button press, or the horizon would tilt.
	// Same pitch/roll-immune convention as deflectionFromDeltaQ's yaw
	// (rotate local forward, read its heading in the XZ plane), reassembled
	// as a pure yaw-about-world-Y quaternion. Exposed as vr.yawOnlyQuatFromOrientation
	// (a pure function, no XR/session state) so headless tests can check the
	// math without a live WebXR session.
	function yawOnlyQuatFromOrientation(o)
	{
		var f=rotateVecByQuat({x:0,y:0,z:-1},o);
		var yaw=Math.atan2(-f.x,-f.z);
		var half=yaw/2;
		return {x:0,y:Math.sin(half),z:0,w:Math.cos(half)};
	}

	// Re-offsets vr.refSpace from the CURRENT head pose so the head reads
	// ~identity afterward: position fully offset, orientation offset by YAW
	// ONLY (see yawOnlyQuatFromOrientation) so gravity/pitch/roll stay real.
	// Always re-offsets from vr.baseRefSpace (the space captured once at
	// session start), never from the current vr.refSpace, so repeated
	// recenters don't accumulate error. No-op (but still counted, see
	// vr.recenterAttempts) without a real session/pose -- the headless test
	// path has neither.
	function vrRecenter()
	{
		++vr.recenterAttempts;
		if(!vr.baseRefSpace || !vr.lastViewerPose || 'undefined'===typeof XRRigidTransform)
		{
			return;
		}
		var pos=vr.lastViewerPose.position;
		var oriYaw=yawOnlyQuatFromOrientation(vr.lastViewerPose.orientation);
		try
		{
			vr.refSpace=vr.baseRefSpace.getOffsetReferenceSpace(new XRRigidTransform(
				{x:pos.x,y:pos.y,z:pos.z},{x:oriYaw.x,y:oriYaw.y,z:oriYaw.z,w:oriYaw.w}));
		}
		catch(e)
		{
			console.warn('[vr] recenter failed: '+(e&&e.message?e.message:e));
			return;
		}
		vrHapticPulse(vr.lastRawSrc.right);
		setTimeout(function(){ vrHapticPulse(vr.lastRawSrc.right); },120);
	}

	// Shared double-squeeze sticky-grab latch (SaccFlight convention),
	// driven once per hand per frame from processControllerPlain with that
	// hand's PHYSICAL squeeze state (entry.squeeze>GRAB_THRESHOLD) -- the
	// caller ORs the returned latch into its own effective-grabbed value, so
	// grab-begin/release (q0/p0 capture, spring-to-neutral) stays exactly
	// the single existing code path in each hand's branch.
	//   - Not latched: a physical press within STICKY_DOUBLE_MS of the
	//     previous physical release engages the latch (two-pulse haptic).
	//   - Latched: the NEXT full physical press+release cycle disengages it
	//     (one-pulse haptic) -- not a second double-squeeze.
	function updateSticky(sticky,physPressed,rawSrc)
	{
		var now=(typeof performance!=='undefined' ? performance.now() : Date.now());
		var pressEdge=physPressed && !sticky.prevPhys;
		var releaseEdge=!physPressed && sticky.prevPhys;
		if(!sticky.latched)
		{
			if(pressEdge)
			{
				if(0<sticky.lastReleaseAt && (now-sticky.lastReleaseAt)<=STICKY_DOUBLE_MS)
				{
					sticky.latched=true;
					sticky.disengageArmed=false;
					vrHapticPulse(rawSrc);
					setTimeout(function(){ vrHapticPulse(rawSrc); },80);
				}
			}
			else if(releaseEdge)
			{
				sticky.lastReleaseAt=now;
			}
		}
		else
		{
			if(pressEdge)
			{
				sticky.disengageArmed=true;
			}
			else if(releaseEdge && sticky.disengageArmed)
			{
				sticky.latched=false;
				sticky.disengageArmed=false;
				sticky.lastReleaseAt=now;
				vrHapticPulse(rawSrc);
			}
		}
		sticky.prevPhys=physPressed;
		return sticky.latched;
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
	var DIAL_SELECT_THRESHOLD=0.5;  // magnitude to (re)pick a sector.
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

	// ---- Per-hand help placards: visibility/toggle state -----------------
	// Kept as plain, headless-testable state (vr.help) independent of the
	// quad-layer visuals -- scripts/smoke-vrctl.mjs pokes this directly (see
	// Group 11) without needing a live XR session. Kill switch:
	// Module.ysfwVrOptions.help===false (?vrhelp=0 in web/index.html) skips
	// both the auto-show and the quad-layer creation (updateHelpLayers).
	var HELP_AUTO_HIDE_MS=12000;   // auto-shown placards hide after this long.
	function helpEnabled()
	{
		var opts=Module.ysfwVrOptions||{};
		return false!==opts.help;
	}
	function showHelp()
	{
		vr.help.visible=true;
		vr.help.shownAt=(typeof performance!=='undefined' ? performance.now() : Date.now());
	}
	// Thumbstick-click (xr-standard buttons[3]) press edge on EITHER hand
	// toggles both placards. A manual show (toggling back on) disarms the
	// auto-hide timer (shownAt=0) -- only the initial auto-show times out on
	// its own; once the pilot has explicitly asked to see it again it stays
	// up until toggled off.
	function toggleHelp(rawSrc)
	{
		vr.help.visible=!vr.help.visible;
		if(vr.help.visible)
		{
			vr.help.shownAt=0;
		}
		vrHapticPulse(rawSrc);
	}
	function updateHelpAutoHide()
	{
		if(!vr.help.visible || 0===vr.help.shownAt)
		{
			return;
		}
		var now=(typeof performance!=='undefined' ? performance.now() : Date.now());
		if(now-vr.help.shownAt>=HELP_AUTO_HIDE_MS)
		{
			vr.help.visible=false;
		}
	}

	// How long a dial tap (the one that actually opened a dialog) stays
	// "fresh" for guiOwner attribution (see the transition-detection block
	// below) -- generous enough to cover the one real XR frame of engine
	// tick latency between the tap and the dialog reporting visible, without
	// letting a stale tap from long before falsely claim ownership of an
	// unrelated dialog that pops open later (e.g. opened from a real
	// keyboard in desktop VR).
	var OWNER_RECENCY_MS=1500;

	// The shared per-controller update.  entry is the plain data shape;
	// viewerQuat is the headset orientation this frame ({x,y,z,w}, used only
	// by the left/throttle hand); rawSrc is the real XRInputSource if this
	// call came from live XR input (haptics only -- null from the test hook).
	function processControllerPlain(entry,viewerQuat,rawSrc)
	{
		var ptr=_YsfwVrControlDataPointer()>>2;
		var physGrabbed=entry.squeeze>GRAB_THRESHOLD;
		// While a modal in-flight dialog is open (see SimDrawVrGui / fsvr.h's
		// FsVrGuiDataPointer), ONE hand's dial/trigger/A-B inputs are
		// rerouted to operate that dialog instead of their normal
		// flight-control meaning -- the OTHER hand is completely unaffected,
		// fully normal, exactly as if no dialog were open. Grip stick
		// (aileron/elevator/rudder) and the throttle grip are NEVER
		// rerouted, on EITHER hand, dialog or no dialog (see the
		// 'right'/'left' branches below: st.grabbed/th.grabbed handling
		// never looks at guiState) -- the plane always keeps flying.
		//
		// Which hand is "the" hand: vr.ctl.guiOwner, set the instant
		// guiDialogState().visible transitions from false to true (see
		// vr.ctl.guiWasVisible below), to whichever hand's dial most
		// recently dispatched a REAL (non-dialog) tap/hold -- i.e. the hand
		// whose dial press plausibly just opened this dialog (AP lives on
		// the left dial's Backspace tap, so this is 'left' in the common
		// case; see vr.ctl.lastDialTapHand, updated only while no dialog is
		// open, further down in each hand's own dial-trigger block). Falls
		// back to 'left' (where AP lives) if that last tap is stale/unknown
		// (OWNER_RECENCY_MS) -- e.g. a desktop-VR pilot opening a dialog
		// from a real keyboard, with no dial tap to attribute it to.
		var guiState=guiDialogState();
		if(guiState.visible && !vr.ctl.guiWasVisible)
		{
			var nowOwner=(typeof performance!=='undefined' ? performance.now() : Date.now());
			var tapRecent=(null!==vr.ctl.lastDialTapHand && (nowOwner-vr.ctl.lastDialTapAt)<=OWNER_RECENCY_MS);
			vr.ctl.guiOwner=(tapRecent ? vr.ctl.lastDialTapHand : 'left');
		}
		vr.ctl.guiWasVisible=guiState.visible;
		// Per-hand "is this dialog actually rerouting THIS hand's inputs
		// right now" flag -- everywhere below that used to just test
		// guiState.visible now tests this instead, so the non-owner hand's
		// branch falls through to its normal, undisturbed behaviour even
		// while a dialog is open on the other hand.
		var rActive=(guiState.visible && 'right'===vr.ctl.guiOwner);
		var lActive=(guiState.visible && 'left'===vr.ctl.guiOwner);

		if('right'===entry.hand)
		{
			var st=vr.ctl.stick;
			// Effective grab = physically squeezing OR sticky-latched (see
			// updateSticky); grab-begin/release (q0 capture, spring-to-
			// neutral) below is unchanged and fires exactly once, whichever
			// condition made it rise/fall.
			var stickyOn=updateSticky(st.sticky,physGrabbed,rawSrc);
			var grabbed=physGrabbed||stickyOn;
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
			// Sector-selection bookkeeping (haptic-on-change, visibility/fade
			// timer) runs unconditionally -- it is harmless bystander state
			// when the OTHER hand owns an open dialog, and this is also the
			// exact stick geometry the GUI_DIAL mapping below reuses.
			updateDialStick(rdial,entry.thumb,rawSrc);

			// Dialog-guide takeover: ONLY while this hand is the dialog's
			// owner (rActive -- see vr.ctl.guiOwner above) does this dial
			// stop being the flight-control radial menu and become the
			// dialog's own selection guide instead (drawn by
			// drawGuiDialGuide, see updateDialLayers) -- forced VISIBLE
			// regardless of thumbstick engagement, because the whole point
			// is to tell the pilot how to get OUT of a dialog they may have
			// opened by accident, without requiring them to already be
			// flicking the stick. When the OTHER hand owns the dialog (or
			// none is open), rActive is false and this dial is left
			// completely alone -- normal RIGHT_DIAL face, normal
			// thumbstick-engagement visibility rule, exactly as if no
			// dialog existed. guiMenu (computeGuiMenuLayout) reads the
			// engine's REAL option-label list (fsvr.h's FsVrGuiMenuPointer)
			// and is exposed on rdial.guiMenu for the guide to draw from and
			// for inspection/tests, so the guide can never promise a mapping
			// that either doesn't exist or the router doesn't actually
			// implement: guiMode is 'ap' when guiMenu.drivable (GUI_DIAL's
			// Digit1..4/A=5/B=0 hotkeys are live AND there is at least one
			// real option to label them with), 'generic' otherwise (only the
			// Escape reroutes are trustworthy).
			var guiMenu=(rActive ? computeGuiMenuLayout(guiState.apMenu) : null);
			rdial.guiMenu=guiMenu;
			rdial.guiMode=(!guiMenu ? null : (guiMenu.drivable ? 'ap' : 'generic'));
			if(rActive)
			{
				rdial.visible=true;
				// The dial's 6 slots cannot reach every option (radio-comm
				// menus can have 7+, see FsGuiRadioCommCommandDialog), and
				// some in-flight dialogs are not hotkey-driven at all
				// (replay/continue/stationary/vehicle-change/chat -- mouse-
				// only). Either way, force the on-quad panel on so the full
				// dialog stays readable/reachable (a real physical keyboard,
				// if the pilot has one in desktop VR, still reaches any
				// option via FsInkey() regardless of what the dial can
				// dispatch) -- see guiPanelWanted's doc comment.
				if(guiMenu && (!guiMenu.drivable || guiMenu.overflow))
				{
					maybeForceGuiPanel();
				}
			}

			var triggerPressed=entry.trigger>TRIGGER_THRESHOLD;
			var triggerEdgeUp=triggerPressed && !vr.ctl.rightTrigger;
			if(triggerEdgeUp)
			{
				vrHapticPulse(rawSrc);
				// snapshot: dial flicks mid-press don't retarget it.
				if(rActive)
				{
					rdial.engaged=(guiState.apMenu ? GUI_DIAL[rdial.sel] : GUI_ESCAPE_ACTION);
				}
				else
				{
					rdial.engaged=RIGHT_DIAL[rdial.sel];
					// Remember this hand as the most recent REAL dial tap --
					// only while no dialog is already open (see guiOwner's
					// doc comment above): this is what lets a future dialog
					// opened by this same tap attribute itself to this hand.
					if(!guiState.visible)
					{
						vr.ctl.lastDialTapHand='right';
						vr.ctl.lastDialTapAt=(typeof performance!=='undefined' ? performance.now() : Date.now());
					}
				}
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

			// Right A: quick press+release (<A_TAP_MAX_MS) taps the gear key,
			// same as before; holding it >=A_RECENTER_MS instead recenters
			// the view (once per hold) and suppresses the gear tap on the
			// eventual release. A hold released in between (neither quick
			// nor long enough) intentionally does nothing. While THIS hand
			// owns an open dialog (rActive), the short tap's target key is
			// rerouted instead: Digit5 (the AP menu's 5th option, "Fly
			// Heading Bug", out of stick-sector reach -- see GUI_DIAL's doc
			// comment) when apMenu, else Escape (generic close). Recenter is
			// left enabled either way -- it is a view-only action, not a
			// flight or dialog control.
			var aPressed=!!(entry.buttons && entry.buttons.a);
			var aBtn=vr.ctl.aBtn;
			var aNow=(typeof performance!=='undefined' ? performance.now() : Date.now());
			if(aPressed && !aBtn.pressed)
			{
				aBtn.pressAt=aNow;
				aBtn.recentered=false;
			}
			if(aPressed && !aBtn.recentered && (aNow-aBtn.pressAt)>=A_RECENTER_MS)
			{
				vrRecenter();
				aBtn.recentered=true;
			}
			if(!aPressed && aBtn.pressed && !aBtn.recentered && (aNow-aBtn.pressAt)<A_TAP_MAX_MS)
			{
				if(!rActive)
				{
					vrKeyTap('KeyG'); // Default landing-gear key: a real tap, not a hold.
				}
				else
				{
					vrHapticPulse(rawSrc);
					vrKeyTap(guiState.apMenu ? 'Digit5' : 'Escape');
				}
			}
			aBtn.pressed=aPressed;

			// Right B: normally a held spoiler/air-brake key; while THIS hand
			// owns an open dialog, rerouted to Digit0 (the AP menu's
			// "Disengage" option) when apMenu, else Escape (generic close)
			// -- dispatched as a tap on the press edge, not held, since
			// neither target is a holdable key.
			var bPressed=!!(entry.buttons && entry.buttons.b);
			if(!rActive)
			{
				vrKeyEdge('KeyB',bPressed); // Default spoiler/air-brake key.
			}
			else
			{
				vrKeyEdge('KeyB',false); // Release it if it was held from before the dialog opened.
				if(bPressed && !vr.ctl.rightB)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap(guiState.apMenu ? 'Digit0' : 'Escape');
				}
			}
			vr.ctl.rightB=bPressed;

			// Thumbstick click (xr-standard buttons[3]): normally toggles the
			// help placards on the press edge, either hand (see toggleHelp).
			// While THIS hand owns an open dialog, it is repurposed instead
			// as the dialog's truthful cancel/Escape binding -- the ONE
			// input the owner hand has spare after the 4 sectors + trigger +
			// A + B are spoken for by GUI_DIAL's 6 positional slots, so a
			// pilot can always back out of a dialog without touching the
			// other (fully normal) hand at all. See drawGuiDialGuide's
			// on-quad label for this.
			var rStickBtn=!!(entry.buttons && entry.buttons.stick);
			if(rActive)
			{
				if(rStickBtn && !vr.help.stickPrev.right)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap('Escape');
				}
			}
			else if(rStickBtn && !vr.help.stickPrev.right)
			{
				toggleHelp(rawSrc);
			}
			vr.help.stickPrev.right=rStickBtn;
		}
		else if('left'===entry.hand)
		{
			var th=vr.ctl.thr;
			// Same effective-grab pattern as the stick (see above): physical
			// squeeze OR sticky latch, grab-begin/release unchanged.
			var thStickyOn=updateSticky(th.sticky,physGrabbed,rawSrc);
			var grabbed=physGrabbed||thStickyOn;
			if(grabbed && !th.grabbed)
			{
				th.p0=entry.pos;
				var vq=viewerQuat||{x:0,y:0,z:0,w:1};
				var fwd=rotateVecByQuat({x:0,y:0,z:-1},vq);
				fwd.y=0;
				var flen=vecLen(fwd);
				th.fwd0=(1e-4<flen) ? {x:fwd.x/flen,y:0,z:fwd.z/flen} : {x:0,y:0,z:-1};
				th.base=th.value; // Latch the current value as this grab's baseline.
				// Fresh grab: reset the afterburner shove-speed tracker so a
				// stale previous position/timestamp from a past grab can't
				// read as a huge fake shove on this grab's first frame.
				th.lastPushM=0;
				th.lastT=0;
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
				var pushM=vecDot(d,th.fwd0);
				var raw=th.base+pushM*THROTTLE_SENS;
				var value=clamp(raw,0,1);
				HEAPF32[ptr+4]=1;
				HEAPF32[ptr+5]=value;
				HEAPF32[ptr+6]=1;
				th.value=value;
				th.ever=true;

				// Afterburner detent: shoving the lever past its 1.0 stop by
				// AB_OVERSHOOT_M at a deliberate (non-drift) speed engages
				// it; pulling back below AB_DISENGAGE_VALUE disengages.
				// FSBTF_AFTERBURNER (default key Tab, fscontrol.cpp) is a
				// toggle in the engine, so each transition is one key TAP,
				// matched by the abEngaged flag so it fires exactly once per
				// crossing (see fscontrol.cpp: ctlAb=!ctlAb on FSBTF_AFTERBURNER).
				var abNow=(typeof performance!=='undefined' ? performance.now() : Date.now());
				var dtS=(0<th.lastT) ? (abNow-th.lastT)/1000 : 0;
				var shoveSpeed=(0<dtS) ? (pushM-th.lastPushM)/dtS : 0;
				th.lastPushM=pushM;
				th.lastT=abNow;
				var overshootM=(raw-1.0)/THROTTLE_SENS;
				if(!th.abEngaged)
				{
					if(1<=value && AB_OVERSHOOT_M<=overshootM && AB_SHOVE_SPEED_MPS<=shoveSpeed)
					{
						th.abEngaged=true;
						vrKeyTap('Tab');
						vrHapticPulse(rawSrc);
						setTimeout(function(){ vrHapticPulse(rawSrc); },80);
					}
				}
				else if(value<AB_DISENGAGE_VALUE)
				{
					th.abEngaged=false;
					vrKeyTap('Tab');
					vrHapticPulse(rawSrc);
					setTimeout(function(){ vrHapticPulse(rawSrc); },80);
				}
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

			// Left X/Y (buttons.a/.b): normally held flap-down/flap-up keys;
			// while THIS hand owns an open dialog (lActive), rerouted to the
			// same truthful extra hotkeys the right A/B give when it is the
			// owner -- Digit5/Digit0 when apMenu, else a generic Escape.
			// When the RIGHT hand owns the dialog instead (or none is open),
			// lActive is false and these fall straight through to their
			// normal flap behaviour, undisturbed.
			var xPressed=!!(entry.buttons && entry.buttons.a);
			if(!lActive)
			{
				vrKeyEdge('KeyF',xPressed); // Default flaps-down key.
			}
			else
			{
				vrKeyEdge('KeyF',false);
				if(xPressed && !vr.ctl.leftX)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap(guiState.apMenu ? 'Digit5' : 'Escape');
				}
			}
			vr.ctl.leftX=xPressed;

			var yPressed=!!(entry.buttons && entry.buttons.b);
			if(!lActive)
			{
				vrKeyEdge('KeyR',yPressed); // Default flaps-up key.
			}
			else
			{
				vrKeyEdge('KeyR',false);
				if(yPressed && !vr.ctl.leftY)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap(guiState.apMenu ? 'Digit0' : 'Escape');
				}
			}
			vr.ctl.leftY=yPressed;

			// Left trigger: dial-selected function (see LEFT_DIAL) when this
			// hand is NOT the dialog owner (including no dialog at all) --
			// fully normal, sticky-sector semantics as always. When lActive,
			// this becomes the dialog's own confirm input instead, exactly
			// mirroring the right dial's GUI_DIAL routing (see rActive's
			// branch above) so the dialog is drivable from WHICHEVER hand
			// opened it.
			var ldial=vr.ctl.dial.left;
			updateDialStick(ldial,entry.thumb,rawSrc);
			// Dialog-guide takeover on the left dial, symmetric to the right
			// dial's rActive branch above: only while lActive, this dial
			// becomes the dialog's selection guide (forced visible,
			// drawGuiDialGuide instead of the normal LEFT_DIAL face). When
			// the RIGHT hand owns the dialog instead, lActive is false and
			// this dial is left completely alone -- normal face, normal
			// thumbstick-engagement visibility, exactly as if no dialog
			// existed (matches the brief: "the other hand fully reverts to
			// its normal functions").
			var guiMenuL=(lActive ? computeGuiMenuLayout(guiState.apMenu) : null);
			ldial.guiMenu=guiMenuL;
			ldial.guiMode=(!guiMenuL ? null : (guiMenuL.drivable ? 'ap' : 'generic'));
			if(lActive)
			{
				ldial.visible=true;
				if(guiMenuL && (!guiMenuL.drivable || guiMenuL.overflow))
				{
					maybeForceGuiPanel();
				}
			}
			var ltriggerPressed=entry.trigger>TRIGGER_THRESHOLD;
			var ltriggerEdgeUp=ltriggerPressed && !vr.ctl.leftTrigger;
			if(ltriggerEdgeUp)
			{
				vrHapticPulse(rawSrc);
				if(lActive)
				{
					ldial.engaged=(guiState.apMenu ? GUI_DIAL[ldial.sel] : GUI_ESCAPE_ACTION);
				}
				else
				{
					ldial.engaged=LEFT_DIAL[ldial.sel];
					// See the right dial's identical bookkeeping above:
					// only while no dialog is already open, so a future
					// dialog this very tap opens can attribute itself here.
					if(!guiState.visible)
					{
						vr.ctl.lastDialTapHand='left';
						vr.ctl.lastDialTapAt=(typeof performance!=='undefined' ? performance.now() : Date.now());
					}
				}
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

			// Thumbstick click: same toggle-vs-cancel split as the right
			// hand above -- while THIS hand owns an open dialog, it is the
			// truthful cancel/Escape binding instead of the help toggle.
			var lStickBtn=!!(entry.buttons && entry.buttons.stick);
			if(lActive)
			{
				if(lStickBtn && !vr.help.stickPrev.left)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap('Escape');
				}
			}
			else if(lStickBtn && !vr.help.stickPrev.left)
			{
				toggleHelp(rawSrc);
			}
			vr.help.stickPrev.left=lStickBtn;
		}
	}

	// Real XR path: adapt each live XRInputSource + this frame's grip pose
	// into the plain shape and run it through processControllerPlain.  Only
	// called when a valid viewer pose exists this frame (see onXRFrame).
	function updateControllers(frame,pose)
	{
		var viewerQuat=pose.transform.orientation;
		// Reset both hands' grip pose before the loop: a hand with no source
		// (or no pose) this frame leaves its entry null, telling
		// updateHelpLayers to skip that hand's placard transform update
		// rather than snapping it to a stale position.
		vr.ctl.gripPose.right=null;
		vr.ctl.gripPose.left=null;
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
			vr.lastRawSrc[hand]=src; // For state-change haptics (updateStateHaptics).
			var gp=src.gamepad;
			var squeeze=(gp.buttons[1] ? gp.buttons[1].value : 0);
			var trigger=(gp.buttons[0] ? gp.buttons[0].value : 0);
			// xr-standard mapping: axes[2],axes[3] = thumbstick x,y (axes[0],[1]
			// are the touchpad, if present). Default to 0 if the gamepad
			// exposes fewer axes than that (some controllers/emulators don't).
			var thumb=[gp.axes[2]||0,gp.axes[3]||0];
			var gpos=gpose.transform.position,gori=gpose.transform.orientation;
			// Plain copy for the help-placard billboard transform
			// (updateHelpLayers, called right after this loop each frame) --
			// same "copy the read-only DOMPoint fields out" pattern as
			// vr.lastViewerPose in onXRFrame.
			vr.ctl.gripPose[hand]={pos:{x:gpos.x,y:gpos.y,z:gpos.z},quat:{x:gori.x,y:gori.y,z:gori.z,w:gori.w}};
			processControllerPlain({
				hand:hand,
				pos:gpos,
				quat:gori,
				squeeze:squeeze,
				trigger:trigger,
				thumb:thumb,
				buttons:{
					a:!!(gp.buttons[4] && gp.buttons[4].pressed),
					b:!!(gp.buttons[5] && gp.buttons[5].pressed),
					// xr-standard buttons[3] = thumbstick click (help toggle).
					stick:!!(gp.buttons[3] && gp.buttons[3].pressed)
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
	// ---- GUI-dialog guide (drawn on whichever hand OWNS the open dialog --
	// see vr.ctl.guiOwner / processControllerPlain's rActive/lActive -- in
	// place of that hand's normal RIGHT_DIAL/LEFT_DIAL face whenever its
	// guiMode is set) --------------------------------------------------------
	// Every label drawn here comes from that hand's dial.guiMenu
	// (computeGuiMenuLayout, itself built from the engine's real option-label
	// list -- fsvr.h's FsVrGuiMenuPointer), and the mode itself (guiMode) is
	// derived from the SAME guiMenu.drivable flag the routing in
	// processControllerPlain keys off of, so the guide can never show a
	// mapping that either doesn't exist or the router doesn't implement:
	//   'ap'      -- guiMenu.drivable: the open dialog accepts direct
	//                positional hotkeys (fsvr.h's apMenu -- the autopilot
	//                family, radio-comm/ATC/approach menus, see
	//                FsSimulation::SimComputeVrGuiState) AND has at least one
	//                real option. The owner hand's 4 stick sectors dispatch
	//                GUI_DIAL's Digit1..4 against guiMenu.options[0..3]; the
	//                two options out of the 4-sector stick's reach (see
	//                GUI_DIAL's doc comment) are on the owner hand's A button
	//                (Digit5, options[4]) and B button (Digit0, options[5])
	//                -- shown in the centre (labelled A/B on the right hand,
	//                X/Y on the left, matching each hand's real Touch
	//                controller silkscreen). If the dialog has MORE real
	//                options than the dial's 6 slots (guiMenu.overflow --
	//                e.g. the wingman-command radio-comm menu has 7), the
	//                second centre line becomes a pointer at the on-quad
	//                panel (forced on, see maybeForceGuiPanel) instead of the
	//                cancel-binding reminder, since both don't fit -- the
	//                cancel binding (the owner hand's thumbstick click,
	//                unconditional on rActive/lActive) still works either
	//                way, it is just not re-stated on-canvas that frame.
	//   'generic' -- !guiMenu.drivable: either the open dialog is not
	//                hotkey-driven at all (replay/continue/stationary/
	//                vehicle-change/chat dialogs -- mouse-only), or (rare)
	//                the engine reported apMenu but zero parseable options.
	//                ALL of the owner hand's 4 sectors, A, and B dispatch the
	//                exact same GUI_ESCAPE_ACTION tap (see rdial/ldial's
	//                engaged ternary above) -- so every sector is labelled
	//                identically instead of implying 4 distinct functions
	//                that don't exist. The on-quad panel is forced on here
	//                too, so the dialog's real content (however many options
	//                it has) is still readable even though the dial can't
	//                drive it.
	// The OTHER (non-owner) hand never reaches this function at all -- its
	// guiMode stays null and it keeps drawing its own normal dial face, see
	// drawDial below.
	var GUI_GUIDE_SECTOR_NUM={up:'1',right:'2',down:'3',left:'4'};
	var GUI_GUIDE_SECTORS=['up','right','down','left'];
	function drawGuiDialGuide(ctx,guiMode,hand)
	{
		var w=256,h=256,cx=128,cy=128,rOuter=110;
		var menu=vr.ctl.dial[hand].guiMenu; // {options,cancel,overflow,drivable} or null/stale -- see computeGuiMenuLayout.
		var options=(menu && menu.options) || [];
		// Real Touch-controller face-button labels: A/B on the right
		// controller, X/Y on the left -- the abstraction in
		// processControllerPlain calls both hands' pair "a"/"b" internally,
		// but the guide should tell the truth about which physical buttons
		// the pilot's OWNER hand actually has.
		var btnLabel1=('right'===hand ? 'A' : 'X'), btnLabel2=('right'===hand ? 'B' : 'Y');
		ctx.fillStyle='rgba(10,14,20,0.55)';
		ctx.beginPath();
		ctx.arc(cx,cy,rOuter,0,2*Math.PI);
		ctx.fill();
		for(var i=0; i<GUI_GUIDE_SECTORS.length; ++i)
		{
			var dir=GUI_GUIDE_SECTORS[i];
			var centerRad=DIAL_SECTOR_CANVAS_DEG[dir]*Math.PI/180;
			var a0=centerRad-Math.PI/4, a1=centerRad+Math.PI/4;
			ctx.beginPath();
			ctx.moveTo(cx,cy);
			ctx.arc(cx,cy,rOuter,a0,a1);
			ctx.closePath();
			// Blue for a live, drivable hotkey menu, amber/red for the
			// generic mode where every sector is just "cancel" -- a
			// different hue makes the "this isn't the usual dial" state
			// obvious at a glance, before reading any text.
			ctx.fillStyle=('ap'===guiMode) ? 'rgba(77,163,255,0.55)' : 'rgba(214,96,64,0.55)';
			ctx.fill();
			ctx.strokeStyle='rgba(230,237,243,0.6)';
			ctx.lineWidth=2;
			ctx.stroke();
			var labelR=rOuter*0.62;
			var lx=cx+Math.cos(centerRad)*labelR, ly=cy+Math.sin(centerRad)*labelR;
			ctx.textAlign='center';
			ctx.fillStyle='#fff';
			if('ap'===guiMode)
			{
				var opt=options[i];
				if(opt)
				{
					ctx.font='bold 28px sans-serif';
					ctx.textBaseline='middle';
					ctx.fillText(GUI_GUIDE_SECTOR_NUM[dir],lx,ly-10);
					ctx.font='bold 12px sans-serif';
					ctx.fillText(clipGuideText(opt.text),lx,ly+12);
				}
				// No option at this position (e.g. a 2-option dialog like
				// the "spread/tighten formation" radio-comm menu leaves
				// down/left empty) -- draw nothing rather than imply a
				// function that does not exist.
			}
			else
			{
				ctx.font='bold 20px sans-serif';
				ctx.textBaseline='middle';
				ctx.fillText('ESC',lx,ly);
			}
		}
		ctx.beginPath();
		ctx.arc(cx,cy,30,0,2*Math.PI);
		ctx.fillStyle='rgba(20,26,34,0.9)';
		ctx.fill();
		ctx.strokeStyle='rgba(230,237,243,0.6)';
		ctx.lineWidth=2;
		ctx.stroke();
		ctx.textAlign='center';
		if('ap'===guiMode)
		{
			ctx.fillStyle='#fff';
			ctx.font='bold 13px sans-serif';
			ctx.textBaseline='middle';
			ctx.fillText(btnLabel1+'=5 '+btnLabel2+'=0',cx,cy-8);
			ctx.fillStyle='rgba(255,224,130,0.95)';
			ctx.font='bold 11px sans-serif';
			// Cancel is now this SAME hand's thumbstick click (see
			// processControllerPlain's rActive/lActive stick-click branch) --
			// no more cross-hand escape, so label it as a self-contained
			// binding rather than pointing at the other controller.
			ctx.fillText((menu && menu.overflow) ? '他はパネル参照' : '取消:スティック',cx,cy+9);
		}
		else
		{
			ctx.fillStyle='#fff';
			ctx.font='bold 15px sans-serif';
			ctx.textBaseline='middle';
			ctx.fillText('ESC',cx,cy-7);
			ctx.fillStyle='rgba(255,224,130,0.95)';
			ctx.font='bold 10px sans-serif';
			ctx.fillText(0<options.length ? 'パネル参照('+options.length+')' : '全入力=ESC',cx,cy+9);
		}
	}
	function drawDial(ctx,hand,sel,state,guiMode)
	{
		var w=256,h=256,cx=128,cy=128,rOuter=110;
		ctx.clearRect(0,0,w,h);
		// guiMode is only ever non-null for whichever hand currently OWNS an
		// open dialog (see processControllerPlain's rActive/lActive) -- so
		// this check no longer needs to (and must not) hardcode 'right'.
		if(guiMode)
		{
			drawGuiDialGuide(ctx,guiMode,hand);
			return;
		}
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
	// A short haptic click on the hand whose dial owns a state the moment
	// that state actually changes (gear/brake/weapon = right, flap = left):
	// tap a dial function, feel the aircraft respond.  States are bucketed so
	// a gear in transit clicks at departure and arrival, not continuously,
	// and flap clicks once per 10% notch.  The first valid frame only
	// initializes (no pulse); invalid state (no player plane) resets.
	function stateHapticBuckets(s)
	{
		return {
			gear:(s.gear<=0.01 ? 0 : (s.gear>=0.99 ? 2 : 1)),
			brake:(s.brake>=0.5 ? 1 : 0),
			flap:Math.round(s.flap*10),
			wpn:Math.round(s.wpnType)
		};
	}
	function updateStateHaptics(state)
	{
		if(!state || !state.valid)
		{
			vr.hapticPrev=null;
			return;
		}
		var cur=stateHapticBuckets(state);
		var prev=vr.hapticPrev;
		vr.hapticPrev=cur;
		if(!prev)
		{
			return; // First valid frame: initialize silently.
		}
		if(prev.gear!==cur.gear || prev.brake!==cur.brake || prev.wpn!==cur.wpn)
		{
			vrHapticPulse(vr.lastRawSrc.right);
		}
		if(prev.flap!==cur.flap)
		{
			vrHapticPulse(vr.lastRawSrc.left);
		}
	}
	function updateDialLayers(frame)
	{
		var state=readAircraftStateSnapshot();
		updateStateHaptics(state);
		if(!vr.mvBinding)
		{
			return; // No layers support: dial visuals unavailable, haptics above still ran.
		}
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
				res.drawnGuiMode=null;
				layersChanged=true;
			}
			// Owner-hand guide: guiMode (see processControllerPlain's
			// rActive/lActive) picks the dialog-guide face over the normal
			// RIGHT_DIAL/LEFT_DIAL one on WHICHEVER hand currently owns an
			// open dialog (vr.ctl.guiOwner) -- null on the other hand, which
			// keeps drawing its own normal face.
			var guiMode=dial.guiMode||null;
			// Redraw when the sticky sector selection changes, the live
			// aircraft state (gear/brake/flap/weapon) changes -- e.g. the
			// gear finishing its travel must update the dial even though
			// dial.sel hasn't moved -- OR the guiMode changes (a dialog
			// just opened/closed/switched between apMenu and generic).
			if(res.drawnSel!==dial.sel || res.drawnStateSig!==stateSig || res.drawnGuiMode!==guiMode)
			{
				try
				{
					drawDial(res.ctx,hand,dial.sel,state,guiMode);
					var sub=vr.mvBinding.getSubImage(res.quad,frame);
					uploadCanvasToSubImage(res.canvas,sub);
					res.drawnSel=dial.sel;
					res.drawnStateSig=stateSig;
					res.drawnGuiMode=guiMode;
				}
				catch(e){} // Leave res.drawn* unset so the next frame retries.
			}
		}
		if(layersChanged)
		{
			syncRenderStateLayers();
		}
	}

	// Rebuilds session.renderState.layers from scratch out of every quad
	// currently marked inLayers (dial + help placards, both hands) plus the
	// projection layer first/background.  Dial and help visuals are updated
	// from separate functions (updateDialLayers/updateHelpLayers) that can
	// each change independently, so neither may build the array from just
	// its own state -- doing so would silently drop the other's quad the
	// next time only one of them changes (the array is not additive across
	// calls, WebXR replaces the whole list each updateRenderState).
	function syncRenderStateLayers()
	{
		var layers=[vr.mvLayer];
		if(vr.dialRes.right && vr.dialRes.right.inLayers){ layers.push(vr.dialRes.right.quad); }
		if(vr.dialRes.left && vr.dialRes.left.inLayers){ layers.push(vr.dialRes.left.quad); }
		if(vr.helpRes.right && vr.helpRes.right.inLayers){ layers.push(vr.helpRes.right.quad); }
		if(vr.helpRes.left && vr.helpRes.left.inLayers){ layers.push(vr.helpRes.left.quad); }
		try{ vr.session.updateRenderState({layers:layers}); }catch(e){}
	}

	// ---- Help placards: per-hand controller diagram, grip-following -------
	// Layers-path only (vr.mvBinding), same best-effort try/catch discipline
	// as the dial quads above: any failure here leaves the toggle/visibility
	// state (vr.help, updated from processControllerPlain) fully working,
	// just without the in-headset visual.
	//
	// Content is static per hand (drawn once into res.canvas and never
	// redrawn -- there is no live game state to reflect, unlike the dial),
	// so all the per-frame work is just repositioning the quad to follow
	// that hand's grip pose.
	var HELP_CANVAS_SIZE=384;
	var HELP_QUAD_SIZE=0.14;      // metres, both width and height.
	var HELP_UP_OFFSET=0.12;      // metres above the grip pose.
	var HELP_ROWS={
		right:[
			{cx:80, cy:92,  label:'スティック',label2:'ダイヤル選択'},
			{cx:64, cy:132, label:'A',        label2:'ギア(長押し:リセンター)'},
			{cx:96, cy:132, label:'B',        label2:'ブレーキ'},
			{cx:80, cy:206, label:'トリガー',  label2:'選択機能(既定:Gun)・GO'},
			{cx:80, cy:252, label:'グリップ',  label2:'操縦桿(手首で操舵)'}
		],
		left:[
			{cx:80, cy:92,  label:'スティック',label2:'ダイヤル選択'},
			{cx:64, cy:132, label:'X',        label2:'フラップ下げ'},
			{cx:96, cy:132, label:'Y',        label2:'フラップ上げ'},
			{cx:80, cy:206, label:'トリガー',  label2:'左ダイヤル機能'},
			{cx:80, cy:252, label:'グリップ',  label2:'スロットル(押込み過ぎでAB)'}
		]
	};
	var HELP_FOOTER='グリップ2度握り = 保持(離しても効いたまま)';
	function roundRectPath(ctx,x,y,w,h,r)
	{
		ctx.beginPath();
		if(ctx.roundRect)
		{
			ctx.roundRect(x,y,w,h,r);
		}
		else
		{
			// Fallback for a 2D context without roundRect (older browsers) --
			// not expected on a Quest browser, but cheap to cover.
			ctx.moveTo(x+r,y);
			ctx.arcTo(x+w,y,x+w,y+h,r);
			ctx.arcTo(x+w,y+h,x,y+h,r);
			ctx.arcTo(x,y+h,x,y,r);
			ctx.arcTo(x,y,x+w,y,r);
			ctx.closePath();
		}
	}
	// Stylized Touch-controller silhouette (ring + body + thumbstick + two
	// face buttons + trigger + grip wedges) -- deliberately not mirrored
	// between hands (both callout sets, HELP_ROWS above, point at the same
	// simple shapes; only the labels differ).
	function drawControllerGlyph(ctx)
	{
		ctx.lineWidth=3;
		ctx.strokeStyle='rgba(230,237,243,0.85)';
		// Tracking ring (top).
		ctx.beginPath();
		ctx.ellipse(80,58,46,20,0,0,2*Math.PI);
		ctx.stroke();
		// Body/handle.
		ctx.fillStyle='rgba(60,72,90,0.55)';
		ctx.beginPath();
		ctx.ellipse(80,165,40,85,0,0,2*Math.PI);
		ctx.fill();
		ctx.stroke();
		// Thumbstick.
		ctx.fillStyle='rgba(77,163,255,0.85)';
		ctx.beginPath();
		ctx.arc(80,92,15,0,2*Math.PI);
		ctx.fill();
		ctx.stroke();
		// Face buttons.
		ctx.fillStyle='rgba(143,163,187,0.55)';
		ctx.beginPath(); ctx.arc(64,132,11,0,2*Math.PI); ctx.fill(); ctx.stroke();
		ctx.beginPath(); ctx.arc(96,132,11,0,2*Math.PI); ctx.fill(); ctx.stroke();
		// Trigger (front, index finger).
		ctx.fillStyle='rgba(255,224,130,0.85)';
		ctx.beginPath();
		ctx.moveTo(58,190); ctx.lineTo(102,190); ctx.lineTo(92,214); ctx.lineTo(68,214);
		ctx.closePath();
		ctx.fill(); ctx.stroke();
		// Grip (side, squeeze).
		ctx.fillStyle='rgba(255,224,130,0.55)';
		ctx.beginPath();
		ctx.moveTo(48,228); ctx.lineTo(112,228); ctx.lineTo(104,268); ctx.lineTo(56,268);
		ctx.closePath();
		ctx.fill(); ctx.stroke();
	}
	// Drawn once per hand at resource-creation time (see ensureHelpResources)
	// -- the content is static, matching the dial's dark-translucent-panel /
	// white-and-blue-accent visual language (drawDial above) but laid out as
	// a controller diagram with leader-line callouts instead of a radial menu.
	function drawHelpCanvas(ctx,hand)
	{
		var w=HELP_CANVAS_SIZE,h=HELP_CANVAS_SIZE;
		ctx.clearRect(0,0,w,h);
		ctx.fillStyle='rgba(10,14,20,0.6)';
		roundRectPath(ctx,4,4,w-8,h-8,16);
		ctx.fill();
		ctx.strokeStyle='rgba(230,237,243,0.35)';
		ctx.lineWidth=2;
		ctx.stroke();

		ctx.textAlign='center';
		ctx.textBaseline='middle';
		ctx.fillStyle='rgba(77,163,255,0.95)';
		ctx.font='bold 22px sans-serif';
		ctx.fillText('right'===hand ? 'R' : 'L',w/2,26);

		drawControllerGlyph(ctx);

		var rows=HELP_ROWS[hand];
		var textX=150,rowH=58,rowY0=78;
		ctx.textAlign='left';
		for(var i=0; i<rows.length; ++i)
		{
			var row=rows[i];
			var rowY=rowY0+i*rowH;
			ctx.strokeStyle='rgba(230,237,243,0.5)';
			ctx.lineWidth=2;
			ctx.beginPath();
			ctx.moveTo(row.cx,row.cy);
			ctx.lineTo(textX-10,rowY);
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(row.cx,row.cy,3,0,2*Math.PI);
			ctx.fillStyle='rgba(230,237,243,0.9)';
			ctx.fill();

			ctx.fillStyle='#fff';
			ctx.font='bold 19px sans-serif';
			ctx.fillText(row.label,textX,rowY-9);
			ctx.fillStyle='rgba(210,220,230,0.9)';
			ctx.font='14px sans-serif';
			ctx.fillText(row.label2,textX,rowY+11);
		}

		ctx.textAlign='center';
		ctx.fillStyle='rgba(255,224,130,0.9)';
		ctx.font='bold 13px sans-serif';
		ctx.fillText(HELP_FOOTER,w/2,h-16);
	}
	function ensureHelpResources(hand)
	{
		if(undefined!==vr.helpRes[hand])
		{
			return vr.helpRes[hand]; // cached: an object, or false (unavailable).
		}
		var res=false;
		try
		{
			if(vr.mvBinding && vr.refSpace)
			{
				var canvas=document.createElement('canvas');
				canvas.width=HELP_CANVAS_SIZE;
				canvas.height=HELP_CANVAS_SIZE;
				var quad=vr.mvBinding.createQuadLayer({
					// vr.refSpace, NOT viewerSpace: the placard follows the
					// controller's grip pose every frame (see
					// updateHelpTransform), so it must live in the same space
					// that pose is expressed in.
					space:vr.refSpace,
					viewPixelWidth:HELP_CANVAS_SIZE,
					viewPixelHeight:HELP_CANVAS_SIZE,
					layout:'mono',
					width:HELP_QUAD_SIZE,
					height:HELP_QUAD_SIZE,
					// Placeholder transform; overwritten every frame once a
					// grip pose exists (updateHelpTransform). Origin is a
					// harmless default for the one frame before that.
					transform:new XRRigidTransform({x:0,y:0,z:0})
				});
				try
				{
					if('blendTextureSourceAlpha' in quad)
					{
						quad.blendTextureSourceAlpha=true;
					}
				}catch(e){}
				res={canvas:canvas,ctx:canvas.getContext('2d'),quad:quad,inLayers:false,drawn:false};
			}
		}
		catch(e)
		{
			console.warn('[vr] help quad layer unavailable ('+hand+'): '+(e&&e.message?e.message:e));
			res=false;
		}
		vr.helpRes[hand]=res;
		return res;
	}
	// Billboards the placard to face the viewer, yaw-only (stays upright):
	// rotates the quad's local +Z axis (its front face, per the same
	// identity-orientation convention the head-locked dial quads rely on --
	// see ensureDialResources's transform) to point from the placard's
	// position toward the viewer's, in the horizontal plane only. Reuses the
	// yawOnlyQuatFromOrientation derivation (see its doc comment): a pure
	// yaw-about-world-Y quaternion is (0,sin(theta/2),0,cos(theta/2)); here
	// theta is derived directly from the horizontal direction-to-viewer
	// vector instead of from an orientation quaternion's forward vector.
	function updateHelpTransform(res,gripPose,viewerPos)
	{
		var px=gripPose.pos.x,py=gripPose.pos.y+HELP_UP_OFFSET,pz=gripPose.pos.z;
		var dx=viewerPos.x-px,dz=viewerPos.z-pz;
		var len=Math.sqrt(dx*dx+dz*dz);
		var yawQ={x:0,y:0,z:0,w:1};
		if(1e-4<len)
		{
			var theta=Math.atan2(dx/len,dz/len);
			var half=theta/2;
			yawQ={x:0,y:Math.sin(half),z:0,w:Math.cos(half)};
		}
		try
		{
			res.quad.transform=new XRRigidTransform({x:px,y:py,z:pz},yawQ);
		}
		catch(e){}
	}
	// Per-frame help-placard maintenance, the help counterpart of
	// updateDialLayers above: create resources lazily, draw once (content is
	// static), keep inLayers/session.renderState.layers in sync with
	// vr.help.visible, and reposition each visible hand's quad from its grip
	// pose every frame (skipping a hand with no pose this frame, see
	// vr.ctl.gripPose's doc comment in the initial vr.ctl object literal).
	function updateHelpLayers(frame)
	{
		if(!vr.mvBinding || !helpEnabled())
		{
			return; // No layers support, or the ?vrhelp=0 kill switch.
		}
		var hands=['right','left'],layersChanged=false;
		for(var i=0; i<hands.length; ++i)
		{
			var hand=hands[i];
			var res=vr.helpRes[hand];
			if(!vr.help.visible)
			{
				if(res && res.inLayers)
				{
					res.inLayers=false;
					layersChanged=true;
				}
				continue;
			}
			res=ensureHelpResources(hand);
			if(!res)
			{
				continue; // No quad-layer support: toggle state still works, just no visual.
			}
			if(!res.inLayers)
			{
				res.inLayers=true;
				layersChanged=true;
			}
			if(!res.drawn)
			{
				try
				{
					drawHelpCanvas(res.ctx,hand);
					var sub=vr.mvBinding.getSubImage(res.quad,frame);
					uploadCanvasToSubImage(res.canvas,sub);
					res.drawn=true;
				}
				catch(e){} // Leave res.drawn false so the next frame retries.
			}
			var gp=vr.ctl.gripPose[hand];
			if(gp && vr.lastViewerPose)
			{
				updateHelpTransform(res,gp,vr.lastViewerPose.position);
			}
			// else: no pose for this hand this frame -- leave the quad's
			// transform exactly where it last was rather than snapping it
			// somewhere wrong.
		}
		if(layersChanged)
		{
			syncRenderStateLayers();
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

		// Help-placard auto-hide: wall-clock timer, independent of pose/
		// layers support, so it still runs every real XR frame regardless of
		// which path below is taken.
		updateHelpAutoHide();

		var pose=frame.getViewerPose(vr.refSpace);
		if(pose)
		{
			// Buffer a plain-object copy for vrRecenter (driven from the right
			// A button handler, which has no frame/pose of its own): the
			// XRPose's transform members are read-only DOMPointReadOnly
			// instances tied to this frame, so copy the fields out rather
			// than keep a reference.
			var vp=pose.transform.position,vo=pose.transform.orientation;
			vr.lastViewerPose={
				position:{x:vp.x,y:vp.y,z:vp.z},
				orientation:{x:vo.x,y:vo.y,z:vo.z,w:vo.w}
			};
		}
		if(vr.mvLayer)
		{
			if(pose)
			{
				writeEyeDataMv(pose);
				updateControllers(frame,pose);
				updateDialLayers(frame);
				updateHelpLayers(frame);
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
				// The un-offset space vrRecenter always re-offsets FROM (see
				// its doc comment) -- captured once, here, at session start.
				vr.baseRefSpace=refSpace;
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
					vr.baseRefSpace=null;
					vr.lastViewerPose=null;
					vr.xrFb=null;
					vr.mvExt=null;
					vr.mvBinding=null;
					vr.mvLayer=null;
					vr.lastRawSrc={right:null,left:null};
					vr.hapticPrev=null;
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
					vr.ctl.stick={grabbed:false,q0:null,sticky:{latched:false,disengageArmed:false,prevPhys:false,lastReleaseAt:0}};
					vr.ctl.thr={grabbed:false,p0:null,fwd0:null,base:0,value:0,ever:false,
						sticky:{latched:false,disengageArmed:false,prevPhys:false,lastReleaseAt:0},
						abEngaged:false,lastPushM:0,lastT:0};
					vr.ctl.rightTrigger=false;
					vr.ctl.guiOwner='left';
					vr.ctl.guiWasVisible=false;
					vr.ctl.lastDialTapHand=null;
					vr.ctl.lastDialTapAt=0;
					vr.ctl.aBtn={pressed:false,pressAt:0,recentered:false};
					vr.ctl.rightB=false;
					vr.ctl.leftX=false;
					vr.ctl.leftY=false;
					vr.ctl.leftTrigger=false;
					vr.ctl.dial.right={sel:'up',engaged:null,visible:false,hideAt:0};
					vr.ctl.dial.left={sel:'up',engaged:null,visible:false,hideAt:0};
					vr.ctl.gripPose={right:null,left:null};
					vr.viewerSpace=null;
					vr.dialRes={right:undefined,left:undefined};
					vr.helpRes={right:undefined,left:undefined};
					vr.help={visible:false,shownAt:0,stickPrev:{right:false,left:false}};

					teardownHud();
					teardownGui();
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
					setupGui();
				}
				_YsfwVrSetPresenting(1);
				_YsfwSetExternalDrive(1);
				vr.simSilentFrames=0;
				// Auto-show both help placards at session start (see
				// showHelp/updateHelpAutoHide); ?vrhelp=0 kill switch skips it.
				if(helpEnabled())
				{
					showHelp();
				}
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
	//         buttons:{a:bool,b:bool,stick:bool (optional, thumbstick click --
	//         help-placard toggle, see toggleHelp)}}
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

	// Headless test hooks for the recenter feature (scripts/smoke-vrctl.mjs):
	// yawOnlyQuatFromOrientation is a pure function (no session/refSpace
	// needed) so the yaw-extraction math can be checked directly; recenter
	// lets a test invoke the same handler the right-A long-hold path calls
	// (it is a no-op without a real baseRefSpace/lastViewerPose, but still
	// bumps vr.recenterAttempts -- see vrRecenter's doc comment).
	vr.yawOnlyQuatFromOrientation=function(q)
	{
		var r=yawOnlyQuatFromOrientation({x:q[0],y:q[1],z:q[2],w:q[3]});
		return [r.x,r.y,r.z,r.w];
	};
	vr.recenter=vrRecenter;

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
		setupGui();
		_YsfwVrSetPresenting(1);
		// Headless stand-in for a real session start (see vr.enter): also
		// auto-shows the help placards, so scripts/smoke-vrctl.mjs can drive
		// and assert the toggle state (vr.help) without a live XR session --
		// see Group 11.
		if(helpEnabled())
		{
			showHelp();
		}
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

	// Headless test hooks for the VR in-flight-GUI composite
	// (scripts/smoke-vrgui.mjs). readGuiData exposes the 8-float GUI state
	// block (see fsvr.h's FsVrGuiDataPointer); readGuiLayerStats mirrors
	// readHudLayerStats above (mean luminance + mean alpha of a given layer
	// of the GUI texture array).
	vr.readGuiData=function()
	{
		var p=_YsfwVrGuiDataPointer()>>2;
		var out=[];
		for(var i=0; i<8; ++i)
		{
			out.push(HEAPF32[p+i]);
		}
		return out;
	};
	vr.readGuiLayerStats=function(layer)
	{
		if(!vr.gui)
		{
			return { lum:0, alpha:0 };
		}
		var w=vr.gui.w,h=vr.gui.h;
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.gui.tex,0,layer);
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

	// dumpGuiLayer: same as dumpHudLayer above, but for the in-flight-GUI
	// composite texture (vr.gui) instead of the HUD one -- debug/headless-
	// probe helper for checking what the engine actually drew into the GUI
	// texture (e.g. whether the autopilot menu clips against its edges at
	// the current texWidth/texHeight, see setupGui's sizing comment).
	vr.dumpGuiLayer=function(layer)
	{
		if(!vr.gui) { return null; }
		var w=vr.gui.w,h=vr.gui.h;
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.gui.tex,0,layer);
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

	// dumpDialLayer: headless-probe helper for scripts/smoke-vrgui.mjs, so a
	// human (or a diff against a golden image) can eyeball what the right
	// dial's selection-guide face (drawGuiDialGuide) actually renders,
	// without needing a real WebXR session/quad-layer (ensureDialResources
	// requires vr.mvBinding/vr.viewerSpace, neither of which exist in the
	// headless test harness -- see updateDialLayers). Draws through the
	// EXACT SAME drawDial/drawGuiDialGuide the real per-hand quad uses, onto
	// a throwaway 2D canvas, using whatever vr.ctl.dial[hand] state
	// processControllerPlain/pokeControllerFrame already computed -- so this
	// is a readback of the real guide, not a reimplementation of it.
	vr.dumpDialLayer=function(hand)
	{
		try
		{
			hand=hand||'right';
			var canvas=document.createElement('canvas');
			canvas.width=256;
			canvas.height=256;
			var ctx=canvas.getContext('2d');
			var dial=vr.ctl.dial[hand];
			var state=readAircraftStateSnapshot();
			// Owner-hand guide (see updateDialLayers's identical comment):
			// guiMode is set on whichever hand's dial currently owns an open
			// dialog, null on the other -- no longer hardcoded to 'right'.
			var guiMode=dial.guiMode||null;
			drawDial(ctx,hand,dial.sel,state,guiMode);
			return canvas.toDataURL('image/png');
		}
		catch(e)
		{
			return null;
		}
	};
});
// clang-format on

void YsfwSetUpWebXR(void)
{
	YsfwInstallWebXR();
}
