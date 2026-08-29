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
    pushing that hand's thumbstick past a deadzone picks one of N evenly-
    spaced sectors (N=RIGHT_DIAL.length/LEFT_DIAL.length, 6 today, sector i
    centred at i*(360/N) degrees clockwise from up -- see updateDialStick),
    the pick sticks after the stick recentres, and the trigger then
    dispatches whichever function is currently selected (see RIGHT_DIAL/
    LEFT_DIAL below). While a session uses the WebXR layers path (single-
    pass stereo, see YsfwVrSetMultiview above), each hand also gets a small
    head-locked XRQuadLayer showing the dial so the selection is visible
    in-headset; without layers the dial still works, it is just invisible.
  - The dial quads use the same fully-transparent, radial-spoke-label
    visual language as the in-flight-GUI guide below (drawDial reuses
    drawSpokeSpan/fitSpokeLabel -- see drawGuiDialGuide's doc comment for
    the design rationale): a thin tick per sector (longer/amber + a small
    arrowhead for the selected one) and the function's label text running
    outward along that sector's spoke -- no wedge fill, no centre hub.
    LIVE aircraft state (fsvr.h / FsVrAircraftStateDataPointer) still
    shows on the face: gear UP/DOWN/%, brake ON/OFF, flap %, and the
    selected weapon + remaining count are drawn as a dimmer second span
    chained past the owning entry's label along its spoke, keyed off the
    entry's key code rather than the old fixed up/right/down/left slots
    (see dialEntryStateText) so the tables can be reordered freely. The
    canvas is only redrawn when the sticky sector selection OR this state
    changes (see updateDialLayers/aircraftStateSig below), not every
    frame.
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
    holding the LEFT hand's X button for >=A_RECENTER_MS (mirroring the
    right hand's A long-press recenter, see the four-refinements list
    below) toggles both placards at any time (see showHelp/toggleHelp/
    updateHelpAutoHide). A thumbstick click is deliberately NOT bound to
    anything -- physically jolting the stick to press it is awkward in VR
    (see processControllerPlain's per-hand doc comments). Kill switch:
    Module.ysfwVrOptions.help===false (?vrhelp=0).
  - GUI-in-VR: the engine's 2D dialog machinery (autopilot/radio-comm menus,
    replay/continue dialogs) still opens and grabs input in VR even though
    ordinary 2D drawing is skipped -- e.g. the left dial's AP tap
    (Backspace) opened an invisible, un-closeable autopilot menu. The
    OWNER hand's selection-guide (drawGuiDialGuide, driven by
    computeGuiMenuLayout reading the engine's real option labels -- fsvr.h's
    FsVrGuiMenuPointer, written every VR frame by
    FsSimulation::SimComputeVrGuiState regardless of the composite below) is
    SELF-SUFFICIENT to operate any in-flight dialog that fits its
    GUI_DIAL_CAPACITY (8) slots and is hotkey-driven (guiMenu.drivable), which
    covers the autopilot family plus the radio-comm/ATC/approach menus (see
    fsvr.h's apMenu doc comment for the exact list) -- so the on-quad
    rendering of the dialog itself is now OPT-IN, default OFF (see
    guiPanelWanted/Module.ysfwVrOptions.guiPanel, ?vrpanel=1). setupGui/
    teardownGui allocate a second off-screen two-layer multiview framebuffer
    (640x360x2, see fsvr.h's FsVrGuiDataPointer -- shrunk from an earlier
    1024x640 so the SAME absolute-pixel dialog layout covers a bigger
    fraction of the texture, ~1.6x bigger on the composited quad) that the
    engine (FsSimulation::SimDrawVrGui) renders whichever dialog is currently
    open into every frame, composited onto a second, GUI-anchored quad
    (closer/lower than the HUD glass) -- see guiDialogState/vr.readGuiData.
    Absolute kill switch: Module.ysfwVrOptions.gui===false. The panel is
    force-enabled anyway (maybeForceGuiPanel) the instant the guide itself
    finds a dialog it cannot fully drive -- more real options than
    GUI_DIAL_CAPACITY (radio-comm's wingman-command menu is exactly 8, right
    at the cap), or not hotkey-driven at all
    (replay/continue/stationary/vehicle-change/chat -- mouse-only) -- so
    nothing becomes unreachable, it just costs the composite only when
    actually needed.

    Ownership: the dialog is driven ENTIRELY by whichever hand's dial tap
    plausibly opened it (vr.ctl.guiOwner, set the instant
    guiDialogState().visible transitions false->true, from
    vr.ctl.lastDialTapHand -- see processControllerPlain's doc comment;
    defaults to 'left', where the AP tap lives, if that is stale/unknown).
    While a dialog is open, processControllerPlain reroutes the owner hand's
    stick sectors to the dialog's own hotkeys when guiMenu.drivable, or
    to a generic Escape/cancel tap otherwise (GUI_ESCAPE_ACTION); the owner
    hand's B (right) / Y (left) press is the truthful cancel/Escape
    binding. That is the WHOLE dialog grammar: sector pick + trigger
    confirm + B/Y cancel, nothing else. Like the normal RIGHT_DIAL/
    LEFT_DIAL (a fixed table, N=6 sectors today, see updateDialStick), the
    drivable guide dial is also N-WAY, but its N is DYNAMIC instead of
    fixed: it shows one sector PER REAL OPTION the open dialog reports
    (N=guiMenu.options.length, up to GUI_DIAL_CAPACITY=8), evenly dividing
    the circle starting at up (12 o'clock) and going clockwise, sector i
    dispatching guiMenu.options[i]'s OWN real hotkey (read positionally off
    the engine's label text via parseMenuLabel -- see guiDialEngagedFor/
    hotkeyCode below) -- NOT a fixed Digit1..4 table, so a 6- or 7-option
    menu (radio-comm's wingman-command dialog has 7 numbered commands plus
    an explicit "0...Don't send" option, 8 total) is fully dial-selectable
    without ever needing the on-quad panel.
    The owner hand's A (X on the left hand) is simply PARKED while the
    dialog is open: its normal flight tap (gear/flaps-down) is suppressed
    so a face-button fumble mid-dialog can't drop the gear, and it carries
    no dialog meaning either -- the N sectors already reach every real
    option, so a second fixed-digit path would only be a redundant grammar
    to memorize. The owner hand's B (Y on the left hand) instead fires a
    truthful cancel/Escape tap on its press edge (its normal held brake/
    flaps-up meaning is suppressed the same way) -- the ONE dialog-relevant
    binding the owner hand carries, replacing thumbstick-click (physically
    awkward to press in VR -- see processControllerPlain's per-hand doc
    comments; the stick-click button is simply unbound now, in every
    state). A's long-press recenter and X's long-press help-toggle both
    stay live regardless of dialog state -- view-only, dialog-irrelevant.
    The OTHER hand is completely untouched --
    its dial, trigger, A/B/X/Y all keep their normal flight-control meaning,
    exactly as if no dialog were open, so the pilot never loses that hand's
    functions to a dialog they didn't open. Discoverability: while a DRIVABLE
    dialog stays open the owner hand's quad is FORCED visible (regardless of
    thumbstick engagement) and switches to a dialog-guide face -- N sectors
    numbered 1..N labelled with the dialog's REAL option text. A
    non-drivable dialog's uniform "ESC" face (with a "see panel" hint once
    the panel is forced) instead follows the NORMAL engagement-based
    visibility rule (flick the stick to see it) -- see
    drawGuiDialGuide/rdial.guiMode/rdial.guiMenu (ldial.* symmetrically);
    falls back to the normal dial the instant the dialog closes. Grip-stick
    (aileron/elevator/rudder) and the throttle grip are NEVER affected, on
    EITHER hand: the plane keeps flying regardless of any open dialog. A
    haptic pulse fires on every sector change in guide mode too (the SAME
    updateDialStick pick the normal dial uses, just quantized to the
    dialog's own N wedges instead of the fixed table's N -- see its doc
    comment), standing in for the visual feedback a pilot not looking at
    the guide quad would otherwise miss.
    Forced visibility applies to the DRIVABLE face only: the uniform "ESC"
    face is engagement-gated like the normal dial (flick the stick to see
    it) -- non-drivable dialogs already force the on-quad panel for their
    content, and parking a 4-spoke ESC cluster in view for e.g. the whole
    parked-on-runway stationary dialog or a replay read as noise on
    device (2026-07 Quest feedback).
  - Perf placard: Module.ysfwVrOptions.perf (?vrperf=1) already printed a
    '[vrperf]' phase-breakdown console line every 5s, but reading the
    browser console while wearing a headset is impractical. The same
    numbers (engine tick/sim/draw + scene/HUD/GUI/reticle breakdown, JS-side
    ctl/dial/layers EMAs, rolling fps) are now ALSO redrawn onto a small
    head-locked XRQuadLayer (layers path only, same lazy-resource/
    try-catch discipline as the dial and help quads above -- see
    ensurePerfResources/drawPerfPlacard/updatePerfLayers), positioned below
    and centred relative to the two dial quads so it can never overlap
    them. Redrawn at most once a second (the numbers are themselves ~1s-ish
    EMAs, so redrawing every frame would just be needless GL upload for no
    visible benefit). At session end the same numbers are snapshotted into
    vr.stats.phases so web/index.html's post-session chip can show a phase
    line too, unconditionally (that snapshot costs nothing, unlike the
    console line/quad which stay opt-in behind ?vrperf=1).

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

// Forwards to the engine's VR hand-pose block (fsvr.h, 16 floats): the JS
// controller runtime below writes each hand's grip pose here, in VIEWER
// space, every XR frame (see updateControllers/writeHandPoseBlock);
// FsSimulation reads it (SimDrawAllScreen's multiview branch) to draw the
// engine's own stick/throttle DNM models glued to the pilot's hand while
// grabbed.
extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrHandPoseDataPointer(void)
{
	return FsVrHandPoseDataPointer();
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

// Forwards to the engine's VR multiview shadow-map render-target block
// (fsvr.h, 8 floats): the JS runtime writes [enable,mvFbo,readFbo,texW,texH]
// here when single-pass stereo engages (setupShadowFbo below); the gl2.0
// back-end's shadow-map path reads it to render each shadow cascade into the
// two-layer depth-array FBO (a multiview-compiled program cannot legally
// draw into the cascades' own single-layer FBOs) and blit layer 0 back out.
extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrShadowFboDataPointer(void)
{
	return FsVrShadowFboDataPointer();
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

// Forwards to the engine's VR phase-breakdown perf block (fsvr.h, 16
// floats): slots [2..5] (scene/HUD/GUI/reticle) are filled once per VR
// multiview frame by FsSimulation::SimDrawAllScreen; slots [0..1]
// (sim/draw) are filled once per tick by fslazywindow_emscripten.cpp's
// MainLoopTick. onXRFrame below reads this (plus its own JS-side EMAs) to
// print the '[vrperf]' console line -- see fsvr.h's FsVrPerfDataPointer doc
// comment for the full slot layout.
extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrPerfDataPointer(void)
{
	return FsVrPerfDataPointer();
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

// Forwards to the engine's VR main-menu state block (fsvr.h, 8 floats):
// the JS runtime writes [enable,fbo,tex,texW,texH] here when the WebXR layers
// session starts (setupMenu); the engine (DrawMenu in fsrunloop.cpp) reads
// [0] to know when the FBO is ready and writes [5] menuDrawn=1 each frame it
// rendered the menu into the FBO.
extern "C" float * EMSCRIPTEN_KEEPALIVE YsfwVrMenuDataPointer(void)
{
	return FsVrMenuDataPointer();
}

// TEST-ONLY: forwards to the engine's blackout/redout override block
// (fsvr.h's FsVrSetBlackoutOverride) so a headless test can exercise
// FsVrDrawFullScreenTint (SimDrawAllScreen's VR G-load tint) without a real
// high-G manoeuvre -- see vr.pokeBlackout below.
extern "C" void EMSCRIPTEN_KEEPALIVE YsfwVrSetBlackoutOverride(int active,float r,float g,float b,float alpha)
{
	FsVrSetBlackoutOverride(active,r,g,b,alpha);
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
		// Menu-quad idle counter (see updateMenuLayer's grace window).  Starts
		// huge so the quad cannot appear before the engine's first real menu
		// render of a session.
		menuIdleFrames:1e9,
		menuAnchor:null, // {pos:{x,y,z},quat:{x,y,z,w}} in vr.refSpace; null = not anchored yet
		// Frames spent in a state that is neither the main menu nor a flight.
		// Such 2D-only screens cannot be presented correctly in immersive VR;
		// on device their last projection texture otherwise freezes and follows
		// the head.  A short grace covers menu->flight transitions.
		unsupportedVrFrames:0,
		// Why the last session ended, when the JS side knows better than the
		// bare 'end' event.  null = normal end; 'menu-unsupported' = the
		// watchdog fired while the menu was up because the menu quad could
		// never be created (no WebXR layers support) -- index.html's onVrEnd
		// turns that into a user-facing toast.  Reset on every vr.enter().
		endReason:null,
		// single-pass stereo (OVR_multiview2 / WebXR layers)
		mvExt:null,
		mvBinding:null,
		mvLayer:null,
		mvFb:null,
		mvDepth:null,
		mvDepthSize:null,
		testMode:false,
		// JS-side EMA (alpha=0.05, same shape as the engine's fsvr.h
		// FsVrPerfDataPointer) of the per-frame cost of the JS-side VR
		// maintenance calls onXRFrame makes on the multiview path: ctl
		// (updateControllers), dial (updateDialLayers), layers (the help AND
		// perf placards' maintenance, updateHelpLayers+updatePerfLayers,
		// folded together since both are "extra quad-layer upkeep") -- see
		// accumJsPerf/onXRFrame below. Read by the '[vrperf]' console line,
		// the perf placard, and the post-session chip.
		jsPerf:{ctl:0,dial:0,layers:0},
		jsPerfWindow:0,
		// VR HUD composite (fsvr.h FsVrHudDataPointer): an off-screen two-layer
		// multiview framebuffer the engine renders the flat HUD into, plus the
		// emscripten GL-table ids so the C++ side can bind them by integer name.
		hud:null,
		// VR multiview shadow-map render target (fsvr.h
		// FsVrShadowFboDataPointer): the shared two-layer depth-array FBO the
		// engine's VR shadow pass renders each cascade into, plus a layer-0
		// read FBO it blits from -- see setupShadowFbo/teardownShadowFbo.
		shadowFbo:null,
		// In-flight-dialog quad composite (fsvr.h FsVrGuiDataPointer): same
		// shape as hud above (vr.gui, set once setupGui allocates it), but
		// default OFF -- guiForced latches true the first time the guide
		// (computeGuiMenuLayout/maybeForceGuiPanel) finds a dialog it cannot
		// fully drive on its own, for the rest of the session (see
		// guiPanelWanted, teardownGui resets it).
		guiForced:false,
		// Headless-test-only override for guiDialogState()/readGuiMenu()
		// below (see vr.pokeGuiMenu/vr.clearGuiOverride, scripts/
		// smoke-vrgui.mjs): null in every real session (both functions read
		// the native FsVrGuiDataPointer/FsVrGuiMenuPointer blocks exactly as
		// before). Exists because reaching a REAL >6-option in-flight dialog
		// headlessly (radio-comm's wingman-command menu needs a live AI
		// wingman in formation, non-trivial to script) would cost far more
		// than it proves about this file's OWN N-way sector-picking/mapping
		// math (updateDialStick/computeGuiMenuLayout/guiDialEngagedFor),
		// which is pure JS with no engine dependency once given a menu list
		// -- so the test fabricates one instead of the real dialog. The
		// 6-option autopilot menu (a real dialog, reachable the normal way)
		// still covers one genuine end-to-end N!=4 case.
		testGuiOverride:null,
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
		help:{visible:false,shownAt:0},
		// Head-locked perf placard (Module.ysfwVrOptions.perf, ?vrperf=1):
		// same lazy-resource shape as dialRes/helpRes above (undefined = not
		// yet attempted, false = unavailable, object =
		// {canvas,ctx,quad,inLayers,drawnAt} once created), but single (no
		// per-hand pair) and anchored to viewerSpace like the dial quads --
		// see ensurePerfResources/updatePerfLayers.
		perfRes:undefined,
		// Main-menu-in-VR quad layer resource (WebXR layers path only).
		// null = not yet allocated (or session ended).
		// object = {fb,tex,fbId,texId,w,h,quad,inLayers} once setupMenu
		// allocates the FBO + XRQuadLayer.
		menuRes:null,
		// Static equirect sky background for the menu (XREquirectLayer, layers
		// path only). Rendered between the projection layer and the menu quad
		// so it fills the black void while no 3D scene is drawing.
		// null = not allocated, false = unavailable (createEquirectLayer threw),
		// object = {layer,canvas,inLayers} once created.
		skyRes:null,
		// One transparent, full-menu cursor overlay quad.  Both hand cursors are
		// painted into this ONE texture in menu UV coordinates, so their visual
		// positions use exactly the same aspect/transform as the menu and cannot
		// drift toward a central square.  Keeping both hands in one layer also
		// avoids one cursor disappearing when a headset's composition-layer
		// budget is tight. null = unavailable/not allocated.
		cursorRes:null,
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
			// recenter decision (see A_TAP_MAX_MS/A_RECENTER_MS). owned
			// latches whether any moment of the CURRENT press overlapped
			// this hand owning an open dialog -- such a press must not fire
			// the quick-tap action on release (the dialog can close mid-
			// press, e.g. cancelled by B on this same hand, and the release
			// would otherwise leak a spurious gear tap).
			aBtn:{pressed:false,pressAt:0,recentered:false,owned:false},
			// Left X button: same press/hold/release bookkeeping shape as
			// aBtn (pressed/pressAt/helped/owned), but X only ever drives ONE
			// action now -- the long-press help toggle (see toggleHelp,
			// processControllerPlain's left-hand branch). helped mirrors
			// aBtn.recentered: fires toggleHelp at most once per hold. (X
			// used to also have a quick-tap view-toggle action, tracked in a
			// now-removed `outside` field -- that control moved to left Y,
			// see leftY/leftYSwallow below, since a bare tap is easier to
			// reach one-handed than a tap-vs-hold face button shared with
			// help.) owned/helped are otherwise unused by X today but kept
			// for structural symmetry with aBtn.
			xBtn:{pressed:false,pressAt:0,helped:false,owned:false},
			// Right B / left Y previous-press state: doubles as (1) the
			// dialog-owner cancel press-edge memory (see
			// processControllerPlain's rActive/lActive branches) and, for Y
			// only, (2) the press-edge memory for the outside-dialog
			// view-cycle tap (F1/F2, see the left-hand branch below) -- both
			// uses need "was this already pressed last frame" to fire
			// exactly once per physical press, so the fields are shared
			// rather than duplicated. The *Swallow flags latch a press that
			// overlapped dialog ownership (the cancel press itself, or a
			// view-cycle/air-brake press held from before the dialog
			// opened): a successful Escape closes the dialog out from under
			// the still-held button, and without the latch the very next
			// frame's non-owner path could fire the normal air-brake/
			// view-cycle action off the same still-held press. Swallowed
			// until physical release.
			rightB:false,
			rightBSwallow:false,
			leftY:false,
			leftYSwallow:false,
			leftTrigger:false,
			keys:{},
			// Radial function-dial state per hand (see RIGHT_DIAL/LEFT_DIAL).
			// sel: sticky selected sector INDEX (0..N-1, numeric, N=that
			//   hand's table length -- 6 today) for the NORMAL flight-
			//   function dial, using the SAME continuous-angle + hysteresis
			//   N-way pick as guiSel below (see updateDialStick) -- just
			//   quantized to the table's fixed N instead of a dialog's
			//   dynamic one. Also harmlessly updated (but never read for
			//   anything user-visible) while the generic/ESC GUI-guide face
			//   is showing, since that face's uniform "every sector = ESC"
			//   dispatch doesn't key off sel at all. guiSel: sticky selected
			//   sector INDEX (0..N-1, numeric) for the N-way GUI-guide dial
			//   ONLY, reset to 0 every time a dialog freshly opens (see
			//   processControllerPlain's guiOwner-assignment block) --
			//   entirely separate state from sel so the normal dial can never
			//   be left holding a stale numeric value once a dialog closes.
			// engaged: the function snapshot captured at the trigger's press
			//   edge (see processControllerPlain) -- kept for the whole press
			//   so a mid-press dial flick can't retarget an already-firing
			//   trigger. visible/hideAt drive the quad layer's on/off fade.
			// picking: true while the stick is deflected past
			//   DIAL_SELECT_THRESHOLD -- its rising edge marks the start of a
			//   FRESH gesture, at which the routed sel/guiSel field is
			//   cleared before the first pick so the previous gesture's
			//   sector cannot bias the new pick through the hysteresis band
			//   (see updateDialStick's stale-highlight fix comment).
			dial:{
				right:{sel:0,guiSel:0,engaged:null,visible:false,hideAt:0,picking:false},
				left:{sel:0,guiSel:0,engaged:null,visible:false,hideAt:0,picking:false}
			},
			// Last known grip pose per hand, plain-copied out of this frame's
			// XRPose each frame in updateControllers (real XR path only --
			// null whenever that hand had no pose this frame, e.g. out of
			// tracking). Consumed by updateHelpLayers to reposition the help
			// placard quads; a null entry means "skip this hand's transform
			// update this frame" per the feature spec.
			gripPose:{right:null,left:null},
			// Frozen HOTAS-prop console anchor per hand ({pos,quat} in the XR
			// REFERENCE space, or null while that hand is not grabbing):
			// captured on each grab's rising edge, held for the whole grab
			// (sticky latch included), cleared on release -- see
			// updateHandPropAnchor/handPropAnchorQuat.
			propAnchor:{right:null,left:null}
		}
	};
	Module.ysfwVr=vr;

	// ---- Radial function-dial tables (SaccFlightAndVehicles-style) ------
	// One function per sector per hand, ARRAYS now (not up/right/down/left
	// keyed objects): entry i sits at canvas/stick angle i*(360/N) degrees
	// clockwise from up (N=array length, 6 today for both hands -- the SAME
	// convention updateDialStick's N-way pick and drawDial's rendering both
	// use, and the SAME convention the GUI-guide dial already used for its
	// dynamic N -- see computeGuiMenuLayout/drawGuiDialGuide). keyCode is
	// the DOM KeyboardEvent code dispatched (see fssimplewindow_emscripten.
	// cpp's keyCodeMapping for the code->FSKEY table); mode 'hold' mirrors
	// the trigger's raw press/release (key held as long as the trigger is,
	// used for level-sensed virtual buttons), mode 'tap' fires one
	// keydown+keyup pulse on the trigger's press edge only (used for
	// toggles/cycles/edge actions). Every key below is cross-checked against
	// FsControlAssignment::SetDefaultKeyAssign (upstream/YSFLIGHT/src/core/
	// fscontrol.cpp) -- see the per-entry notes.
	var RIGHT_DIAL=[
		// [0] up (0deg). FSBTF_FIREWEAPON (Space): a level-sensed virtual
		// button in the engine (fscontrol.cpp's "implemented through virtual
		// buttons of FsAirplaneProperty" switch) -- fires while held, so
		// 'hold'.
		{label:'Gun',     code:'Space', mode:'hold'},
		// [1] 60deg. FSBTF_SELECTWEAPON (Digit2): cycles the selected weapon
		// (FsGroundProperty::CycleWeaponOfChoiceByUser / ctlCycleWeaponButtonExt)
		// on the press edge -- a 'tap', not a hold, and matches the touch UI's
		// own weapon-select button (web/index.html's tap('Digit2')).
		{label:'武器切替', code:'Digit2',mode:'tap'},
		// [2] 120deg. FSBTF_DISPENSEFLARE (Digit4): another level-sensed
		// virtual button (same fscontrol.cpp switch as FSBTF_FIREWEAPON
		// above) -- fires while held, so 'hold', same as Gun.
		{label:'フレア',   code:'Digit4',mode:'hold'},
		// [3] 180deg (down). FSBTF_LANDINGGEAR (KeyG): fscontrol.cpp toggles
		// ctlGear=(ctlGear<0.5?1.0:0.0) on each press -- a toggle, so 'tap'
		// (one edge per trigger pull, not a sustained hold).
		{label:'Gear',    code:'KeyG',  mode:'tap'},
		// [4] 240deg. FSBTF_SPOILERBRAKE (KeyB): same toggle pattern as gear
		// (ctlSpoiler=(ctlSpoiler<0.5?1.0:0.0) in fscontrol.cpp) -- 'tap',
		// not 'hold', despite the name "brake" suggesting a held button.
		{label:'Brake',   code:'KeyB',  mode:'tap'},
		// [5] 300deg. FSBTF_RADAR (Digit3): toggles the radar display on the
		// press edge (fscontrol.cpp's toggle-switch pattern, same shape as
		// gear/brake above) -- 'tap'.
		{label:'レーダー', code:'Digit3',mode:'tap'}
	];
	var LEFT_DIAL=[
		// [0] up (0deg). FSBTF_FLAPUP (KeyR): steps one flap position per
		// press -- 'tap'.
		{label:'Flap+',  code:'KeyR',     mode:'tap'},
		// [1] 60deg. No default key targets FSBTF_SMOKE itself
		// (SetDefaultKeyAssign binds only FSKEY_P -> FSBTF_CYCLESMOKESELECTOR);
		// that cycle function advances the smoke-generator channel on the
		// press edge (FsAirplaneProperty::CycleSmokeSelector, called from
		// IsCycleSmokeSelectorButtonJustPressed) -- an edge action, so 'tap'
		// here (deviates from an earlier "hold" guess: there is no holdable
		// smoke key in the shipped defaults).
		{label:'Smoke',  code:'KeyP',     mode:'tap'},
		// [2] 120deg. FSBTF_OPENRADIOCOMMMENU (Enter): opens the radio-comm
		// dialog on the press edge -- 'tap' (opens a dialog, same as AP
		// below; the existing GUI-guide machinery -- guiOwner/guiMenu/
		// drawGuiDialGuide -- takes over this hand automatically the instant
		// dialogVisible flips true, exactly as it does for AP).
		{label:'無線',    code:'Enter',    mode:'tap'},
		// [3] 180deg (down). FSBTF_FLAPDOWN (KeyF): steps one flap position
		// per press -- 'tap'.
		{label:'Flap-',  code:'KeyF',     mode:'tap'},
		// [4] 240deg. FSBTF_OPENAUTOPILOTMENU (Backspace) opens the
		// autopilot dialog -- a deliberately calm, occasional action (the
		// tablet touch UI already treats it as a tap), which fits the left
		// hand well since that hand's grip already owns the continuous
		// throttle control and its trigger is otherwise idle.
		{label:'AP',     code:'Backspace',mode:'tap'},
		// [5] ~257deg (N=7). FSBTF_AUTOTRIM (KeyT): a level-sensed virtual
		// button (same fscontrol.cpp switch as FIREWEAPON/DISPENSEFLARE) --
		// fires while held, so 'hold' (holding it trims continuously;
		// releasing stops).
		{label:'トリム',  code:'KeyT',     mode:'hold'},
		// [6] ~309deg (N=7). FSKEY_ESC: in-sim the engine closes any open
		// submenu on the first ESC and TERMINATES the flight (back to the
		// menu) on the second consecutive press (fssimulation.cpp's
		// escKeyCount>=2 -> SetTerminate) -- flat play's "press ESC twice
		// to leave". 'tap' so each trigger pull is one truthful ESC press:
		// select this sector, pull the trigger twice, and you are back on
		// the menu quad. Lives on the calm left hand next to the other
		// occasional actions (radio/AP), added because a VR pilot had no
		// way to leave a flight at all (2026-07 Quest feedback); dial
		// sector count is table-driven (updateDialStick/drawDial), so the
		// odd N=7 needs no other change. Labelled by what it DOES (leave
		// the flight), not the key it sends -- "ESC" alone read as
		// meaningless on device (second Quest report); the "×2" state hint
		// (dialEntryStateText) carries the press-twice grammar.
		{label:'終了',   code:'Escape',   mode:'tap'}
	];

	// GUI-dialog stick mapping (see SimDrawVrGui's doc comment / fsvr.h's
	// FsVrGuiDataPointer): while a modal in-flight dialog is open (guiData[5]
	// dialogVisible), this REPLACES RIGHT_DIAL/LEFT_DIAL for the OWNER hand's
	// thumbstick sectors (see vr.ctl.guiOwner / processControllerPlain's
	// rActive/lActive -- whichever hand's dial tap plausibly opened the
	// dialog), so that hand's trigger sector-tap dispatches the dialog's own
	// direct hotkeys instead of its normal flight functions. The OTHER hand
	// never consults any of this at all -- see the class doc comment's
	// "Ownership" paragraph. Only consulted when computeGuiMenuLayout says
	// the menu is "drivable" (see processControllerPlain) -- the engine
	// reports apMenu (the open dialog is one of the hotkey-driven in-flight
	// dialogs: the autopilot family plus radio-comm/ATC/approach menus, see
	// fsvr.h's apMenu doc comment for the full list) AND has at least one
	// real option. Those dialogs' ProcessRawKeyInput (fsguiinfltdlg.cpp) all
	// consume Digit1..Digit9/Digit0/Escape directly and POSITIONALLY (the Nth
	// option added is the Nth digit, regardless of what
	// FsGuiDialogItem::fsKey the button itself carries -- see fsvr.h's
	// FsVrGuiMenuPointer doc comment), independent of the generic
	// FsGuiDialog Tab-focus/mouse-click machinery that the remaining,
	// mouse-only in-flight dialogs rely on instead.
	//
	// Unlike RIGHT_DIAL/LEFT_DIAL (a fixed table, N=6 sectors today, the
	// SAME for every dialog/no-dialog state), there is no fixed GUI_DIAL
	// table any more: the dial guide is N-WAY with a DYNAMIC N, one sector
	// per REAL option the currently-open dialog reports
	// (guiMenu.options.length, up to GUI_DIAL_CAPACITY -- see
	// computeGuiMenuLayout), and sector i dispatches guiMenu.options[i]'s OWN
	// hotkey, read positionally off the engine's label text (parseMenuLabel
	// already extracted it into .hotkey) -- see hotkeyCode/
	// guiDialEngagedFor below. This is what lets a 6- or 7-option dialog
	// (the autopilot menu; radio-comm's wingman-command menu) be fully
	// dial-selectable without the on-quad panel, where an old fixed-4-sector
	// design would have needed the owner hand's A/B buttons to reach options
	// 5/6 (see GUI_DIAL_CAPACITY's doc comment) and forced the panel on
	// above that.
	// With every real option reachable by a sector, the owner hand's A
	// (X on the left hand) carries NO dialog meaning at all any more -- it
	// is parked while a dialog is open (see processControllerPlain); B (Y
	// on the left hand) is the dialog grammar's cancel input instead of its
	// normal brake/flaps-up meaning, keeping the dialog grammar to exactly
	// three inputs: sector pick, trigger confirm, B/Y cancel.
	//
	// hotkeyCode(opt,idx): the DOM KeyboardEvent code for one parsed option
	// (see parseMenuLabel) -- opt.hotkey ('1'..'9' or '0') when the engine's
	// own label prefix parsed cleanly, else a positional fallback (idx+1,
	// 1-based, wrapping 10->'0') for the rare item whose label has no
	// recognized digit prefix (a pagination "<<Prev"/"Next>>" button, kept in
	// options[] since it isn't the 'ESC' cancel entry) -- so the guide can
	// still offer a best-effort key rather than silently dropping that
	// sector's dispatch.
	function hotkeyCode(opt,idx)
	{
		var h=(opt && opt.hotkey) || String((idx+1)%10);
		return ('0'===h) ? 'Digit0' : ('Digit'+h);
	}
	// The dial-confirm action for the owner hand's currently-selected sector
	// (rdial.guiSel/ldial.guiSel, an N-way index -- see updateDialStick),
	// given that hand's current guiMenu (computeGuiMenuLayout). Mirrors the
	// old GUI_DIAL[dial.sel]/GUI_ESCAPE_ACTION ternary in shape (an
	// {label,code,mode:'tap'} action, or GUI_ESCAPE_ACTION), just reading the
	// engine's REAL per-option hotkey instead of a fixed table -- so it can
	// never promise a Digit code the currently-open dialog does not actually
	// have a button for. Falls back to GUI_ESCAPE_ACTION whenever the guide
	// isn't in drivable ('ap') mode at all, or (should not happen given
	// guiSel is always kept in [0,guiMenu.options.length) -- see
	// processControllerPlain's dialog-open reset and updateDialStick's modulo
	// pick -- but checked anyway, fail-safe) the selected index has no
	// backing option.
	function guiDialEngagedFor(guiMenu,sel)
	{
		if(!guiMenu || !guiMenu.drivable)
		{
			return GUI_ESCAPE_ACTION;
		}
		var opt=guiMenu.options[sel];
		if(!opt)
		{
			return GUI_ESCAPE_ACTION;
		}
		return {label:(opt.hotkey||String(sel+1)), code:hotkeyCode(opt,sel), mode:'tap'};
	}
	// Generic "close/cancel" action for any OTHER in-flight dialog
	// (dialogVisible but not apMenu -- radio-comm menus, replay/continue
	// dialogs, etc.): every in-flight dialog in the engine either consumes
	// Escape directly (FsGuiInFlightDialog::ProcessRawKeyInput overrides in
	// fsguiinfltdlg.cpp all treat it as "close this dialog") or has a
	// Cancel-labelled button bound to FSKEY_ESC that the generic
	// FsGuiDialog::KeyIn's fsKey match clicks -- so Escape is the one input
	// confirmed safe to fire at ANY open dialog, unlike Tab/Arrow keys/Enter
	// (see the investigation notes in fsvr.h's FsVrGuiDataPointer comment).
	// Also what the owner hand's B (right) / Y (left) press-edge cancel
	// binding dispatches (see processControllerPlain's rActive/lActive
	// branches), regardless of drivable/apMenu.
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

		// hudData[6] is the collimated gunsight-reticle enable (default on):
		// when set, the engine suppresses the baked-in flat-HUD crosshair and
		// instead draws a per-eye world-space reticle in the scene pass (see
		// SimDrawAllScreen / FsVrDrawReticle).  Module.ysfwVrOptions.reticle
		// ===false (?vrreticle=0) turns it off AND restores the baked crosshair.
		var reticle=(false===opts.reticle ? 0 : 1);
		var p=_YsfwVrHudDataPointer()>>2;
		HEAPF32[p+0]=1;     // enable
		HEAPF32[p+1]=fbId;  // hudFbo
		HEAPF32[p+2]=texId; // hudTexArray
		HEAPF32[p+3]=W;
		HEAPF32[p+4]=H;
		HEAPF32[p+5]=0; HEAPF32[p+6]=reticle; HEAPF32[p+7]=0;

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

	// ---- VR multiview shadow-map render target ----------------------------
	// Same allocate-and-publish shape as setupHud above, but a DEPTH-only
	// two-layer array (2048x2048x2 DEPTH_COMPONENT24 -- 2048 matches the
	// engine's cascade textures, FsCommonTexture::ReadyShadowMap; the depth
	// blit that moves layer 0 into each cascade requires equal rectangles),
	// plus a second, read-only FBO with that array's layer 0 attached
	// (framebufferTextureLayer) as the blit SOURCE.  WHY this exists at all:
	// multiview-compiled programs (num_views=2) cannot legally draw into the
	// cascades' own single-layer FBOs (OVR_multiview2 INVALID_OPERATION,
	// verified on ANGLE), so the engine's VR shadow pass renders into this
	// shared target and blits out -- see fsvr.h's FsVrShadowFboDataPointer
	// doc comment and FsSimulation::SimDrawShadowMap.  Kill switch:
	// Module.ysfwVrOptions.shadow===false leaves the block zero, which the
	// engine reads as "no target" and falls back to shadows-off (the pre-fix
	// behaviour, sampling disabled) rather than erroring.
	function setupShadowFbo()
	{
		var opts=Module.ysfwVrOptions||{};
		if(false===opts.shadow)
		{
			return;
		}
		if(vr.shadowFbo)
		{
			return;
		}
		var ext=vr.mvExt||GLctx.getExtension('OCULUS_multiview')||GLctx.getExtension('OVR_multiview2');
		if(!ext)
		{
			return;
		}
		var W=2048,H=2048;

		var prevActive=GLctx.getParameter(GLctx.ACTIVE_TEXTURE);
		GLctx.activeTexture(GLctx.TEXTURE15);
		var dep=GLctx.createTexture();
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,dep);
		GLctx.texStorage3D(GLctx.TEXTURE_2D_ARRAY,1,GLctx.DEPTH_COMPONENT24,W,H,2);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_MIN_FILTER,GLctx.NEAREST);
		GLctx.texParameteri(GLctx.TEXTURE_2D_ARRAY,GLctx.TEXTURE_MAG_FILTER,GLctx.NEAREST);
		GLctx.bindTexture(GLctx.TEXTURE_2D_ARRAY,null);
		GLctx.activeTexture(prevActive);

		var prevFb=GLctx.getParameter(GLctx.FRAMEBUFFER_BINDING);
		// Render target: both layers via the multiview attachment.  Depth-only
		// (no color): the shadow pass only needs depth, same as the engine's
		// own single-layer cascade FBOs (ystexturemanager_gl.cpp).
		var mvFb=GLctx.createFramebuffer();
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,mvFb);
		ext.framebufferTextureMultiviewOVR(GLctx.FRAMEBUFFER,GLctx.DEPTH_ATTACHMENT,dep,0,0,2);
		var stMv=GLctx.checkFramebufferStatus(GLctx.FRAMEBUFFER);
		// Blit source: layer 0 of the same array on a plain framebuffer.
		var readFb=GLctx.createFramebuffer();
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,readFb);
		GLctx.framebufferTextureLayer(GLctx.FRAMEBUFFER,GLctx.DEPTH_ATTACHMENT,dep,0,0);
		var stRead=GLctx.checkFramebufferStatus(GLctx.FRAMEBUFFER);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,prevFb);
		if(stMv!==GLctx.FRAMEBUFFER_COMPLETE || stRead!==GLctx.FRAMEBUFFER_COMPLETE)
		{
			console.warn('[vr] multiview shadow framebuffer incomplete (mv 0x'+stMv.toString(16)+', read 0x'+stRead.toString(16)+') -- VR shadows disabled');
			GLctx.deleteFramebuffer(mvFb);
			GLctx.deleteFramebuffer(readFb);
			GLctx.deleteTexture(dep);
			return;
		}

		var mvFbId=GL.getNewId(GL.framebuffers);
		GL.framebuffers[mvFbId]=mvFb;
		mvFb.name=mvFbId;
		var readFbId=GL.getNewId(GL.framebuffers);
		GL.framebuffers[readFbId]=readFb;
		readFb.name=readFbId;

		var p=_YsfwVrShadowFboDataPointer()>>2;
		HEAPF32[p+0]=1;        // enable
		HEAPF32[p+1]=mvFbId;   // two-layer multiview depth FBO (render target)
		HEAPF32[p+2]=readFbId; // layer-0 view (blit source)
		HEAPF32[p+3]=W;
		HEAPF32[p+4]=H;
		HEAPF32[p+5]=0; HEAPF32[p+6]=0; HEAPF32[p+7]=0;

		vr.shadowFbo={mvFb:mvFb,readFb:readFb,dep:dep,mvFbId:mvFbId,readFbId:readFbId,w:W,h:H};
		console.log('[vr] multiview shadow target '+W+'x'+H+'x2 (mvFbId='+mvFbId+' readFbId='+readFbId+')');
	}

	function teardownShadowFbo()
	{
		var p=_YsfwVrShadowFboDataPointer()>>2;
		for(var i=0; i<8; ++i)
		{
			HEAPF32[p+i]=0;
		}
		if(!vr.shadowFbo)
		{
			return;
		}
		try{ GLctx.deleteFramebuffer(vr.shadowFbo.mvFb); }catch(e){}
		try{ GLctx.deleteFramebuffer(vr.shadowFbo.readFb); }catch(e){}
		try{ GLctx.deleteTexture(vr.shadowFbo.dep); }catch(e){}
		GL.framebuffers[vr.shadowFbo.mvFbId]=null;
		GL.framebuffers[vr.shadowFbo.readFbId]=null;
		vr.shadowFbo=null;
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
	// widest in-flight dialog that matters for the dial guide's hotkey
	// dispatch -- see scripts/smoke-vrgui.mjs) fitting inside it uncropped.
	// Composited onto the SAME physical quad size (FsVrDrawGuiQuad, fssimulation.cpp),
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

	// ---- VR main-menu off-screen FBO + world-anchored quad layer ------------
	// Called at session start (setupMenu) and end (teardownMenu).  The menu FBO
	// is a plain mono RGBA 2D texture (not multiview) the engine renders the
	// 2D main menu into each tick; updateMenuLayer blits it into the XRQuadLayer
	// swapchain every frame the engine wrote to it (menuDrawn flag).
	// The quad is anchored in vr.refSpace (world-fixed) so it stays put when
	// the player's head moves (anchorMenuQuad; see also vrRecenter hook).
	var MENU_MAX_TEXTURE_PX=2048;
	var MENU_QUAD_WIDTH_M=1.6;
	// Quest's compositor displays an XRQuadLayer at TWICE its declared
	// width/height -- it treats them as half-extents, while the Layers spec
	// reads as full meters ("the width and height of the layer in meters",
	// position = quad center).  Measured on device 2026-07-31 with the
	// ?vrlayerscale A/B: declaring half the metric size made the aim rings
	// meet the rays across the whole board (they used to agree only at the
	// center and drift outward proportionally -- the half-vs-full signature).
	// Every RAY-COUPLED quad (menu, cursor overlay, beams, keyboard) declares
	// through quadDecl() so the app-side models stay in honest metric units.
	// Display-only quads whose size was TUNED BY EYE on device with the 2x in
	// effect (dials, help placards, perf, gui panel) keep their raw declared
	// numbers -- their approved look already bakes the factor in.
	// ?vrlayerscale multiplies on top for future on-device probes
	// (?vrlayerscale=2 reproduces the pre-fix drift for regression demos).
	var QUAD_DECL_FACTOR=0.5;
	function menuLayerScale()
	{
		var o=Module.ysfwVrOptions||{};
		var f=parseFloat(o.layerScale);
		return (isFinite(f)&&f>0) ? f : 1;
	}
	function quadDecl(m)
	{
		return m*QUAD_DECL_FACTOR*menuLayerScale();
	}
	function fitMenuTextureSize(srcW,srcH,maxPx)
	{
		srcW=Math.max(1,Math.round(srcW||1));
		srcH=Math.max(1,Math.round(srcH||1));
		maxPx=Math.max(1,Math.round(maxPx||MENU_MAX_TEXTURE_PX));
		// Scale both axes by ONE factor.  Clamping them independently turns a
		// high-DPI widescreen Quest canvas into an almost-square menu and makes
		// the ray/cursor appear confined to a central square.
		var scale=Math.min(1,maxPx/Math.max(srcW,srcH));
		return {w:Math.max(1,Math.round(srcW*scale)),h:Math.max(1,Math.round(srcH*scale))};
	}
	function menuQuadMetricSize(texW,texH)
	{
		var w=MENU_QUAD_WIDTH_M;
		return {w:w,h:w*Math.max(1,texH)/Math.max(1,texW)};
	}
	function setupMenu()
	{
		if(vr.menuRes)
		{
			return;
		}
		// In headless test mode (vr.testMode, forceMultiview) there is no real
		// XRWebGLBinding, but we still allocate the FBO so the engine can render
		// into it and the smoke test can read it back.
		var inTestMode=(vr.testMode && !vr.mvBinding);
		if(!inTestMode && (!vr.mvBinding||!vr.refSpace))
		{
			return;
		}

		var canvas=Module.canvas||document.getElementById('canvas');
		var fitted=fitMenuTextureSize(canvas ? canvas.width : 800,canvas ? canvas.height : 600,MENU_MAX_TEXTURE_PX);
		var W=fitted.w;
		var H=fitted.h;
		if(W<=0||H<=0)
		{
			return;
		}

		var prevActive=GLctx.getParameter(GLctx.ACTIVE_TEXTURE);
		GLctx.activeTexture(GLctx.TEXTURE14);
		var tex=GLctx.createTexture();
		GLctx.bindTexture(GLctx.TEXTURE_2D,tex);
		GLctx.texImage2D(GLctx.TEXTURE_2D,0,GLctx.RGBA,W,H,0,GLctx.RGBA,GLctx.UNSIGNED_BYTE,null);
		GLctx.texParameteri(GLctx.TEXTURE_2D,GLctx.TEXTURE_MIN_FILTER,GLctx.LINEAR);
		GLctx.texParameteri(GLctx.TEXTURE_2D,GLctx.TEXTURE_MAG_FILTER,GLctx.LINEAR);
		GLctx.texParameteri(GLctx.TEXTURE_2D,GLctx.TEXTURE_WRAP_S,GLctx.CLAMP_TO_EDGE);
		GLctx.texParameteri(GLctx.TEXTURE_2D,GLctx.TEXTURE_WRAP_T,GLctx.CLAMP_TO_EDGE);
		GLctx.bindTexture(GLctx.TEXTURE_2D,null);
		GLctx.activeTexture(prevActive);

		// Depth-stencil renderbuffer: the menu is mostly 2D, but the
		// aircraft-select dialog renders a real 3D aircraft preview into
		// this FBO.  With a color-only FBO the depth test is a no-op, so
		// later-drawn geometry always painted over nearer geometry --
		// under-wing stores showed through the wing (Quest report: "the
		// preview looks like its normals are flipped").  DEPTH24_STENCIL8
		// is the WebGL2 name; 0x84F9 is WebGL1's DEPTH_STENCIL for the
		// headless test path, whose context can be WebGL1 (SwiftShader).
		var depthRb=GLctx.createRenderbuffer();
		var prevRb=GLctx.getParameter(GLctx.RENDERBUFFER_BINDING);
		GLctx.bindRenderbuffer(GLctx.RENDERBUFFER,depthRb);
		GLctx.renderbufferStorage(GLctx.RENDERBUFFER,(GLctx.DEPTH24_STENCIL8||0x84F9),W,H);
		GLctx.bindRenderbuffer(GLctx.RENDERBUFFER,prevRb);

		var fb=GLctx.createFramebuffer();
		var prevFb=GLctx.getParameter(GLctx.FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,fb);
		GLctx.framebufferTexture2D(GLctx.FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,GLctx.TEXTURE_2D,tex,0);
		GLctx.framebufferRenderbuffer(GLctx.FRAMEBUFFER,GLctx.DEPTH_STENCIL_ATTACHMENT,GLctx.RENDERBUFFER,depthRb);
		var st=GLctx.checkFramebufferStatus(GLctx.FRAMEBUFFER);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,prevFb);
		if(st!==GLctx.FRAMEBUFFER_COMPLETE)
		{
			console.warn('[vr] menu FBO incomplete 0x'+st.toString(16));
			GLctx.deleteFramebuffer(fb);
			GLctx.deleteTexture(tex);
			GLctx.deleteRenderbuffer(depthRb);
			return;
		}

		var fbId=GL.getNewId(GL.framebuffers);
		GL.framebuffers[fbId]=fb; fb.name=fbId;
		var texId=GL.getNewId(GL.textures);
		GL.textures[texId]=tex; tex.name=texId;

		var quad=null;
		var quadSize=menuQuadMetricSize(W,H);
		if(!inTestMode)
		{
			try
			{
				quad=vr.mvBinding.createQuadLayer({
					space:vr.refSpace,
					viewPixelWidth:W,
					viewPixelHeight:H,
					layout:'mono',
					width:quadDecl(quadSize.w),
					height:quadDecl(quadSize.h)
				});
				// Placeholder; overwritten by anchorMenuQuad before the quad
				// ever enters the layers list.
				quad.transform=new XRRigidTransform({x:0,y:0,z:0},{x:0,y:0,z:0,w:1});
			}
			catch(e)
			{
				console.warn('[vr] menu quad layer failed: '+(e&&e.message?e.message:e));
				GLctx.deleteFramebuffer(fb); GLctx.deleteTexture(tex);
				GLctx.deleteRenderbuffer(depthRb);
				GL.framebuffers[fbId]=null; GL.textures[texId]=null;
				return;
			}
		}

		var p=_YsfwVrMenuDataPointer()>>2;
		HEAPF32[p+0]=1; HEAPF32[p+1]=fbId; HEAPF32[p+2]=texId;
		HEAPF32[p+3]=W; HEAPF32[p+4]=H;
		HEAPF32[p+5]=0; HEAPF32[p+6]=0; HEAPF32[p+7]=0;

		vr.menuRes={fb:fb,tex:tex,depthRb:depthRb,fbId:fbId,texId:texId,w:W,h:H,
			quadW:quadSize.w,quadH:quadSize.h,quad:quad,inLayers:false};
		console.log('[vr] menu '+W+'x'+H+' (fbId='+fbId+' texId='+texId+(inTestMode?' testMode':'')+')');
	}

	function teardownMenu()
	{
		var p=_YsfwVrMenuDataPointer()>>2;
		for(var i=0; i<8; ++i){ HEAPF32[p+i]=0; }
		if(!vr.menuRes)
		{
			return;
		}
		try{ GLctx.deleteFramebuffer(vr.menuRes.fb); }catch(e){}
		try{ GLctx.deleteTexture(vr.menuRes.tex); }catch(e){}
		try{ if(vr.menuRes.depthRb){ GLctx.deleteRenderbuffer(vr.menuRes.depthRb); } }catch(e){}
		try{ if(vr.menuRes.quad){ vr.menuRes.quad.destroy(); } }catch(e){}
		// The VR keyboard lives and dies with the menu boards.
		teardownKbd();
		GL.framebuffers[vr.menuRes.fbId]=null;
		GL.textures[vr.menuRes.texId]=null;
		vr.menuAnchor=null;
		vr.menuRes=null;
		vr.menuIdleFrames=1e9;
	}

	// Locks the menu quad to world space at the moment the menu becomes
	// visible (or re-anchors on vrRecenter while visible).
	// viewerPose: plain-object {position:{x,y,z},orientation:{x,y,z,w}} in
	// vr.refSpace (same shape as vr.lastViewerPose).
	// Places the quad 1.8 m ahead of the viewer's yaw-only forward direction,
	// 0.1 m below head height, facing the viewer.
	function anchorMenuQuad(viewerPose)
	{
		if(!viewerPose||!vr.menuRes||!vr.menuRes.quad)
		{
			return;
		}
		var pos=viewerPose.position;
		var yawQ=yawOnlyQuatFromOrientation(viewerPose.orientation);
		var fwd=rotateVecByQuat({x:0,y:0,z:-1},yawQ);
		var menuPos={x:pos.x+fwd.x*1.8,y:pos.y-0.1,z:pos.z+fwd.z*1.8};
		vr.menuAnchor={pos:menuPos,quat:yawQ};
		try
		{
			var menuTransform=new XRRigidTransform(menuPos,yawQ);
			vr.menuRes.quad.transform=menuTransform;
			// The cursor overlay has the exact same physical extent and transform
			// as the menu.  Layer ordering (cursor after menu) puts its transparent
			// pixels on top without a world-space offset/parallax error.
			if(vr.cursorRes && vr.cursorRes.quad)
			{
				vr.cursorRes.quad.transform=menuTransform;
			}
		}
		catch(e){}
	}

	// ---- Static equirect sky background for the VR menu --------------------
	// Procedurally generated pre-dawn sky on a 2048x1024 canvas using a seeded
	// PRNG (mulberry32 with a fixed seed) for star placement.  Uploaded to the
	// XREquirectLayer every presented frame following the "every-frame upload"
	// discipline the help placards established (see uploadCanvasToSubImage's
	// comment: compositor-side buffer loss requires freshness on every frame,
	// so upload-once is NOT safe even for static content).
	//
	// Layer order (back-to-front): the equirect sits between the projection
	// layer and the menu quad so it fills the black void the inactive 3D scene
	// leaves while the menu is showing.  Array order:
	//   [mvLayer (proj), ... dial/help/perf ..., equirect, menuQuad]
	//
	// Graceful degrade: createEquirectLayer may not exist on all WebXR
	// implementations; failure sets skyRes=false and the menu keeps working
	// on a black background.

	// Seeded PRNG: mulberry32 (simple, fast, deterministic).
	// See https://github.com/bryc/code/blob/master/jshash/PRNGs.md
	function mulberry32(seed)
	{
		return function()
		{
			seed=(seed+0x6D2B79F5)|0;
			var t=Math.imul(seed^(seed>>>15),1|seed);
			t=t+Math.imul(t^(t>>>7),61|t)^t;
			return ((t^(t>>>14))>>>0)/4294967296;
		};
	}

	function buildSkyCanvas()
	{
		var W=2048, H=1024;
		var canvas=document.createElement('canvas');
		canvas.width=W; canvas.height=H;
		var ctx=canvas.getContext('2d');
		if(!ctx){ return null; }

		// ---- Sky gradient (top -> horizon -> ground) -----------------------
		var grad=ctx.createLinearGradient(0,0,0,H);
		grad.addColorStop(0,   '#000005'); // zenith: almost black
		grad.addColorStop(0.35,'#050a1a'); // upper sky: deep navy
		grad.addColorStop(0.52,'#0c1830'); // mid sky
		grad.addColorStop(0.60,'#1a2a48'); // approaching horizon
		grad.addColorStop(0.65,'#2d3c5a'); // pre-dawn horizon glow
		grad.addColorStop(0.70,'#4a4a58'); // ground horizon
		grad.addColorStop(0.75,'#1a1a1e'); // near ground
		grad.addColorStop(1,   '#0a0a0c'); // nadir
		ctx.fillStyle=grad;
		ctx.fillRect(0,0,W,H);

		// ---- Subtle horizon glow -------------------------------------------
		var hGrad=ctx.createRadialGradient(W/2,H*0.65,0,W/2,H*0.65,W*0.45);
		hGrad.addColorStop(0,'rgba(100,120,160,0.18)');
		hGrad.addColorStop(0.4,'rgba(70,90,130,0.08)');
		hGrad.addColorStop(1,'rgba(0,0,0,0)');
		ctx.fillStyle=hGrad;
		ctx.fillRect(0,0,W,H);

		// ---- Stars (upper sky only, seeded PRNG) ---------------------------
		// Horizon is at y = H*0.65; stars only appear above that.
		var rng=mulberry32(0x42a7f91c); // fixed seed
		var starCount=1800;
		for(var i=0; i<starCount; ++i)
		{
			var sx=rng()*W;
			var sy=rng()*H*0.62; // confined to upper 62% (clear of horizon glow)
			var ssize=0.3+rng()*1.1;
			// Twinkle: slightly varied alpha so not all stars are the same brightness
			var salpha=0.35+rng()*0.65;
			ctx.beginPath();
			ctx.arc(sx,sy,ssize,0,Math.PI*2);
			// Mix of white-blue colours for realism
			var hue=Math.floor(rng()*40); // 0-40 range: white to slightly warm
			ctx.fillStyle='hsla('+hue+',20%,90%,'+salpha.toFixed(2)+')';
			ctx.fill();
		}

		return canvas;
	}

	function setupSky()
	{
		// skyRes===false means we already tried and failed (createEquirectLayer
		// not available); don't retry.
		if(vr.skyRes===false || vr.skyRes)
		{
			return;
		}
		if(!vr.mvBinding || !vr.refSpace)
		{
			return; // Not available in test mode.
		}

		var canvas=buildSkyCanvas();
		if(!canvas)
		{
			vr.skyRes=false;
			return;
		}

		var layer;
		try
		{
			layer=vr.mvBinding.createEquirectLayer({
				// WebXR Layers requires equirect/cube layers to use a
				// non-viewer XRReferenceSpace.  Quest rejects viewerSpace here,
				// which was why the intended pre-dawn background degraded to black.
				space:vr.refSpace,
				viewPixelWidth:2048,
				viewPixelHeight:1024,
				layout:'mono',
				isStatic:false // we upload each frame (see header comment)
			});
		}
		catch(e)
		{
			console.warn('[vr] equirect sky unavailable: '+(e&&e.message?e.message:e));
			vr.skyRes=false;
			return;
		}

		vr.skyRes={layer:layer,canvas:canvas,inLayers:false};
		console.log('[vr] equirect sky 2048x1024 allocated');
	}

	function teardownSky()
	{
		if(!vr.skyRes || vr.skyRes===false)
		{
			vr.skyRes=null;
			return;
		}
		try{ if(vr.skyRes.layer){ vr.skyRes.layer.destroy(); } }catch(e){}
		vr.skyRes=null;
	}

	// Upload the sky canvas to the equirect layer every presented frame.
	// Driven by the same menuVisible state as updateMenuLayer.
	// Returns true if vr.skyRes.inLayers changed (caller must rebuild the
	// layers list via syncRenderStateLayers -- updateMenuLayer owns that call
	// so this function never calls syncRenderStateLayers itself).
	function updateSkyLayer(frame,menuInLayers)
	{
		if(!vr.skyRes || vr.skyRes===false)
		{
			return false;
		}

		var layersChanged=false;
		if(menuInLayers)
		{
			if(!vr.skyRes.inLayers)
			{
				vr.skyRes.inLayers=true;
				layersChanged=true;
			}
			// Upload every presented frame (swapchain rotation means upload-once
			// is not safe -- same rationale as the dial/help-placard uploads).
			if(vr.skyRes.layer && vr.mvBinding)
			{
				try
				{
					var sub=vr.mvBinding.getSubImage(vr.skyRes.layer,frame);
					uploadCanvasToSubImage(vr.skyRes.canvas,sub);
				}
				catch(e){}
			}
		}
		else if(vr.skyRes.inLayers)
		{
			vr.skyRes.inLayers=false;
			layersChanged=true;
		}

		return layersChanged;
	}

	// ---- Menu ray cursor (transparent overlay matched to the menu quad) ------
	// The engine's hover highlight alone makes dialog lists and small buttons
	// guesswork on device.  Earlier revisions used one tiny world-positioned
	// quad per hand; on Quest the pointer rings then occupied a central square
	// even though hover reached the menu corners.  The hit math was right, but
	// the independently transformed visual layers were not.  Paint both rings
	// into one transparent quad with the menu's exact dimensions/transform,
	// using the SAME u/v values that feed mouse pixels.  Transfer it EVERY
	// presented frame -- non-presented swapchain buffers can otherwise freeze.
	var CURSOR_OVERLAY_MAX_PX=1024;
	var CURSOR_DIAMETER_M=0.025;
	function cursorOverlayPoint(u,v,w,h)
	{
		return {
			x:Math.max(0,Math.min(1,u))*Math.max(0,w-1),
			y:Math.max(0,Math.min(1,v))*Math.max(0,h-1)
		};
	}
	function drawCursorMark(ctx,x,y,hand,canvasW)
	{
		// Keep the ring's physical diameter stable as the overlay resolution
		// follows the menu aspect.  A 1024px-wide, 1.6m menu yields ~16px.
		var radius=Math.max(5,canvasW*CURSOR_DIAMETER_M/MENU_QUAD_WIDTH_M/2);
		// Dark contrast ring (outermost) so the cursor reads on light menus.
		ctx.beginPath();
		ctx.arc(x,y,radius+2,0,Math.PI*2);
		ctx.lineWidth=2;
		ctx.strokeStyle='rgba(0,0,0,0.6)';
		ctx.stroke();
		// Main white ring.
		ctx.beginPath();
		ctx.arc(x,y,radius,0,Math.PI*2);
		ctx.lineWidth=Math.max(2,radius*0.28);
		ctx.strokeStyle='rgba(255,255,255,0.95)';
		ctx.stroke();
		// Distinct centre dots make simultaneous left/right aim points easy to
		// tell apart: cyan = left, warm yellow = right.
		ctx.beginPath();
		ctx.arc(x,y,Math.max(2,radius*0.28),0,Math.PI*2);
		ctx.fillStyle=('left'===hand ? 'rgba(80,220,255,0.95)' : 'rgba(255,220,80,0.95)');
		ctx.fill();
	}

	function setupCursor()
	{
		if(vr.cursorRes || !vr.mvBinding || !vr.refSpace || !vr.menuRes)
		{
			return; // Layers path only (test mode / non-layers browsers skip).
		}
		var fitted=fitMenuTextureSize(vr.menuRes.w,vr.menuRes.h,CURSOR_OVERLAY_MAX_PX);
		var canvas=document.createElement('canvas');
		canvas.width=fitted.w;
		canvas.height=fitted.h;
		var ctx=canvas.getContext('2d');
		if(!ctx)
		{
			return;
		}
		try
		{
			var quad=vr.mvBinding.createQuadLayer({
				space:vr.refSpace,
				viewPixelWidth:fitted.w,
				viewPixelHeight:fitted.h,
				layout:'mono',
				width:quadDecl(vr.menuRes.quadW),
				height:quadDecl(vr.menuRes.quadH)
			});
			try
			{
				if('blendTextureSourceAlpha' in quad)
				{
					quad.blendTextureSourceAlpha=true;
				}
			}
			catch(e){}
			if(vr.menuAnchor)
			{
				quad.transform=new XRRigidTransform(vr.menuAnchor.pos,vr.menuAnchor.quat);
			}
			vr.cursorRes={quad:quad,canvas:canvas,ctx:ctx,inLayers:false};
		}
		catch(e)
		{
			console.warn('[vr] menu cursor overlay failed: '+(e&&e.message?e.message:e));
		}
	}

	function teardownCursor()
	{
		try{ if(vr.cursorRes&&vr.cursorRes.quad){ vr.cursorRes.quad.destroy(); } }catch(e){}
		vr.cursorRes=null;
	}

	// ---- Controller laser beams for the menu -----------------------------
	// One thin world-space quad per hand, from the controller's targetRay
	// origin to the menu plane (or a default length while the ray is off the
	// board), colour-matched to that hand's cursor ring dot (cyan=left,
	// warm yellow=right).  2026-07 Quest feedback: with only the hit ring
	// visible, "where I feel the ray points" and "where the hit lands" read
	// as disagreeing -- Quest users are trained on a VISIBLE system laser,
	// so draw one.  Layers path only, same best-effort try/catch discipline
	// as the cursor overlay; composited between the menu quad and the
	// cursor ring (the beam is physically in FRONT of the board, the ring
	// sits ON it).
	var BEAM_WIDTH_M=0.01;
	var BEAM_DEFAULT_LEN_M=3.0;
	var BEAM_MAX_LEN_M=6.0;
	// Rotation quaternion from an orthonormal right-handed basis given as
	// COLUMN vectors (the images of the canonical axes).  Standard
	// trace-branching matrix->quaternion conversion.
	function quatFromBasis(x,y,z)
	{
		var m00=x.x,m01=y.x,m02=z.x;
		var m10=x.y,m11=y.y,m12=z.y;
		var m20=x.z,m21=y.z,m22=z.z;
		var tr=m00+m11+m22,s;
		if(tr>0)
		{
			s=Math.sqrt(tr+1)*2;
			return {w:0.25*s,x:(m21-m12)/s,y:(m02-m20)/s,z:(m10-m01)/s};
		}
		if(m00>m11&&m00>m22)
		{
			s=Math.sqrt(1+m00-m11-m22)*2;
			return {w:(m21-m12)/s,x:0.25*s,y:(m01+m10)/s,z:(m02+m20)/s};
		}
		if(m11>m22)
		{
			s=Math.sqrt(1+m11-m00-m22)*2;
			return {w:(m02-m20)/s,x:(m01+m10)/s,y:0.25*s,z:(m12+m21)/s};
		}
		s=Math.sqrt(1+m22-m00-m11)*2;
		return {w:(m10-m01)/s,x:(m02+m20)/s,y:(m12+m21)/s,z:0.25*s};
	}
	// Pose for a beam quad: local +Y runs along the ray (texture top = far
	// end), +Z billboarded toward the head so the flat ribbon always faces
	// the viewer.  Pure math (no XR state) -- exposed as vr.beamPoseFor for
	// headless tests.  Returns {pos,quat} or null on degenerate input.
	function beamPoseFor(rayPos,rayDir,headPos,len)
	{
		var d=Math.sqrt(rayDir.x*rayDir.x+rayDir.y*rayDir.y+rayDir.z*rayDir.z);
		if(!(d>1e-6)||!(len>0))
		{
			return null;
		}
		var y={x:rayDir.x/d,y:rayDir.y/d,z:rayDir.z/d};
		var mid={x:rayPos.x+y.x*len/2,y:rayPos.y+y.y*len/2,z:rayPos.z+y.z*len/2};
		var th={x:headPos.x-mid.x,y:headPos.y-mid.y,z:headPos.z-mid.z};
		var xv={x:y.y*th.z-y.z*th.y,y:y.z*th.x-y.x*th.z,z:y.x*th.y-y.y*th.x};
		var xl=Math.sqrt(xv.x*xv.x+xv.y*xv.y+xv.z*xv.z);
		if(xl<1e-5)
		{
			// Ray passes (nearly) through the head: the ribbon is edge-on
			// anyway, any perpendicular keeps the math finite.
			xv={x:-y.z,y:0,z:y.x};
			xl=Math.sqrt(xv.x*xv.x+xv.z*xv.z);
			if(xl<1e-5)
			{
				xv={x:1,y:0,z:0};
				xl=1;
			}
		}
		xv={x:xv.x/xl,y:xv.y/xl,z:xv.z/xl};
		// z = x cross y: the toHead component perpendicular to the beam, so
		// it faces the viewer by construction.
		var zv={x:xv.y*y.z-xv.z*y.y,y:xv.z*y.x-xv.x*y.z,z:xv.x*y.y-xv.y*y.x};
		return {pos:mid,quat:quatFromBasis(xv,y,zv)};
	}
	// Redraws a beam's strip texture for the current lit fraction.  The quad
	// itself NEVER changes size (see setupBeams: fixed BEAM_MAX_LEN_M span) --
	// on-device testing showed per-frame XRQuadLayer width/height mutation is
	// not honoured by the compositor (the beam stayed at its creation length
	// and pierced the menu board past the cursor ring), so the variable
	// length lives entirely in the texture's alpha: the strip is lit from the
	// hand end (bottom, v=1) up to the hit fraction and transparent beyond,
	// with a small glow at the cut so the beam visibly LANDS on the ring.
	function drawBeamCanvas(res,hand,litFrac)
	{
		var canvas=res.canvas;
		var ctx=res.ctx;
		var W=canvas.width,H=canvas.height;
		litFrac=Math.max(0.02,Math.min(1,litFrac));
		var cutY=H*(1-litFrac); // canvas top = quad +Y = far end.
		var core=('left'===hand ? '80,220,255' : '255,220,80');
		ctx.clearRect(0,0,W,H);
		// Vertical run: soft tip glow at the cut, slightly brighter at the
		// hand end, transparent above the cut.
		var grad=ctx.createLinearGradient(0,cutY,0,H);
		grad.addColorStop(0,'rgba('+core+',0.9)');   // impact end
		grad.addColorStop(0.12,'rgba('+core+',0.5)');
		grad.addColorStop(0.9,'rgba('+core+',0.55)');
		grad.addColorStop(1,'rgba('+core+',0.65)');  // hand end
		ctx.fillStyle=grad;
		ctx.fillRect(0,cutY,W,H-cutY);
		// Soft horizontal edges so the ribbon reads as a beam, not a strip.
		var hg=ctx.createLinearGradient(0,0,W,0);
		hg.addColorStop(0,'rgba(0,0,0,0)');
		hg.addColorStop(0.35,'rgba(0,0,0,1)');
		hg.addColorStop(0.65,'rgba(0,0,0,1)');
		hg.addColorStop(1,'rgba(0,0,0,0)');
		ctx.globalCompositeOperation='destination-in';
		ctx.fillStyle=hg;
		ctx.fillRect(0,0,W,H);
		ctx.globalCompositeOperation='source-over';
	}
	function setupBeams()
	{
		if(vr.beamRes||!vr.mvBinding||!vr.refSpace)
		{
			return; // Layers path only, like the cursor overlay.
		}
		var res={};
		var hands=['right','left'];
		for(var i=0; i<hands.length; ++i)
		{
			var hand=hands[i];
			var canvas=document.createElement('canvas');
			canvas.width=8;
			canvas.height=256;
			var ctx=canvas.getContext('2d');
			if(!ctx)
			{
				return;
			}
			try
			{
				var quad=vr.mvBinding.createQuadLayer({
					space:vr.refSpace,
					viewPixelWidth:canvas.width,
					viewPixelHeight:canvas.height,
					layout:'mono',
					width:quadDecl(BEAM_WIDTH_M),
					// FIXED span, never mutated: the compositor does not
					// honour per-frame width/height writes (see
					// drawBeamCanvas's doc comment) -- the variable lit
					// length lives in the texture alpha instead.
					height:quadDecl(BEAM_MAX_LEN_M),
					transform:new XRRigidTransform({x:0,y:0,z:0})
				});
				try
				{
					if('blendTextureSourceAlpha' in quad)
					{
						quad.blendTextureSourceAlpha=true;
					}
				}
				catch(e){}
				res[hand]={quad:quad,canvas:canvas,ctx:ctx,inLayers:false};
			}
			catch(e)
			{
				console.warn('[vr] menu beam layer failed: '+(e&&e.message?e.message:e));
				return;
			}
		}
		vr.beamRes=res;
	}
	function teardownBeams()
	{
		if(vr.beamRes)
		{
			try{ if(vr.beamRes.right&&vr.beamRes.right.quad){ vr.beamRes.right.quad.destroy(); } }catch(e){}
			try{ if(vr.beamRes.left&&vr.beamRes.left.quad){ vr.beamRes.left.quad.destroy(); } }catch(e){}
		}
		vr.beamRes=null;
	}
	// Called once per onXRFrame.  Shows each hand's beam while the menu is
	// visible and that hand has a targetRay pose; hides both otherwise.
	// The beam ends ON the menu PLANE when the ray crosses it in front of
	// the pilot (even outside the quad's bounds -- a beam piercing the
	// board reads as broken), and falls back to a fixed length while
	// pointing elsewhere so the board is findable by sweeping.
	function updateMenuBeams(frame)
	{
		var res=vr.beamRes;
		if(!res)
		{
			return;
		}
		var layersChanged=false;
		var used={right:false,left:false};
		var menuVisible=!!(vr.menuRes&&vr.menuRes.inLayers&&vr.menuAnchor);
		if(menuVisible&&vr.refSpace&&vr.lastViewerPose&&vr.session&&vr.session.inputSources)
		{
			var aQi=quatConjugate(vr.menuAnchor.quat);
			var aP=vr.menuAnchor.pos;
			var sources=vr.session.inputSources;
			for(var i=0; i<sources.length; ++i)
			{
				var src=sources[i];
				var hand=src.handedness;
				if(!src.targetRaySpace||('right'!==hand&&'left'!==hand)||!res[hand]||used[hand])
				{
					continue;
				}
				var rayPose=frame.getPose(src.targetRaySpace,vr.refSpace);
				if(!rayPose)
				{
					continue;
				}
				var rp=rayPose.transform.position;
				var dir=rotateVecByQuat({x:0,y:0,z:-1},rayPose.transform.orientation);
				// Distance to the menu PLANE (same local-frame math as
				// intersectRayWithAnchoredQuad, without the bounds check).
				var len=BEAM_DEFAULT_LEN_M;
				var roL=rotateVecByQuat({x:rp.x-aP.x,y:rp.y-aP.y,z:rp.z-aP.z},aQi);
				var rdL=rotateVecByQuat(dir,aQi);
				if(roL.z>0&&rdL.z<-1e-6)
				{
					var t=-roL.z/rdL.z;
					if(t>0.02)
					{
						len=Math.min(t,BEAM_MAX_LEN_M);
					}
				}
				// The lectern keyboard floats 0.35 m in FRONT of the board
				// plane (anchorKbdQuad): when the ray lands ON its quad the
				// beam must stop there, not run through the keys to the
				// board plane behind (round-5 device report: the beam
				// overshooting what the hand points at reads as "the ray
				// doesn't land where I aim").  BOUNDED hit only -- the
				// tilted keyboard PLANE crosses the board region, so an
				// unbounded cut would truncate beams aimed at the board.
				if(vr.kbd&&vr.kbd.res&&vr.kbd.res.inLayers&&vr.kbd.anchor)
				{
					var ka=vr.kbd.anchor;
					var kQi=quatConjugate(ka.quat);
					var kroL=rotateVecByQuat({x:rp.x-ka.pos.x,y:rp.y-ka.pos.y,z:rp.z-ka.pos.z},kQi);
					var krdL=rotateVecByQuat(dir,kQi);
					if(kroL.z>0&&krdL.z<-1e-6)
					{
						var kt=-kroL.z/krdL.z;
						var khx=kroL.x+kt*krdL.x;
						var khy=kroL.y+kt*krdL.y;
						if(0.02<kt&&kt<len&&Math.abs(khx)<=ka.w/2&&Math.abs(khy)<=ka.h/2)
						{
							len=kt;
						}
					}
				}
				// The quad keeps its FIXED BEAM_MAX_LEN_M span along the ray;
				// only the texture's lit fraction encodes the length (see
				// drawBeamCanvas).
				var bp=beamPoseFor(rp,dir,vr.lastViewerPose.position,BEAM_MAX_LEN_M);
				if(!bp)
				{
					continue;
				}
				try
				{
					res[hand].quad.transform=new XRRigidTransform(bp.pos,bp.quat);
					drawBeamCanvas(res[hand],hand,len/BEAM_MAX_LEN_M);
					var sub=vr.mvBinding.getSubImage(res[hand].quad,frame);
					uploadCanvasToSubImage(res[hand].canvas,sub);
					used[hand]=true;
				}
				catch(e){}
			}
		}
		var hands=['right','left'];
		for(var hi=0; hi<hands.length; ++hi)
		{
			var h=hands[hi];
			if(res[h]&&res[h].inLayers!==used[h])
			{
				res[h].inLayers=used[h];
				layersChanged=true;
			}
		}
		if(layersChanged)
		{
			syncRenderStateLayers();
		}
	}

	// Called once per onXRFrame (after processMenuRayInput has refreshed
	// menuRayState).  Shows the cursor at the ray hit point while the menu is
	// visible and a controller ray is on the quad; hides it otherwise.
	function updateMenuCursor(frame)
	{
		var menuVisible=!!(vr.menuRes && vr.menuRes.inLayers);
		var layersChanged=false;
		var res=vr.cursorRes;
		if(!res)
		{
			return;
		}
		var hands=['right','left'];
		var show=menuVisible && (menuRayState.hands.right.wasHit||menuRayState.hands.left.wasHit);
		if(!show)
		{
			if(res.inLayers)
			{
				res.inLayers=false;
				layersChanged=true;
			}
		}
		else
		{
			res.ctx.clearRect(0,0,res.canvas.width,res.canvas.height);
			for(var hi=0; hi<hands.length; ++hi)
			{
				var hand=hands[hi];
				var ray=menuRayState.hands[hand];
				if(ray.wasHit)
				{
					var point=cursorOverlayPoint(ray.hitU,ray.hitV,res.canvas.width,res.canvas.height);
					drawCursorMark(res.ctx,point.x,point.y,hand,res.canvas.width);
				}
			}
			if(!res.inLayers)
			{
				res.inLayers=true;
				layersChanged=true;
			}
			try
			{
				var sub=vr.mvBinding.getSubImage(res.quad,frame);
				uploadCanvasToSubImage(res.canvas,sub);
			}
			catch(e){}
		}
		if(layersChanged)
		{
			syncRenderStateLayers();
		}
	}

	// Called once per onXRFrame after _YsfwExternalTick().  Checks whether the
	// engine wrote to the menu FBO this frame (menuDrawn flag), blits the
	// content into the XRQuadLayer's swapchain texture, and adds/removes the
	// quad from the session render-state layers list as needed.
	// Grace window before hiding the menu quad.  The menuDrawn flag is
	// per-engine-render; the engine now redraws the menu every VR frame
	// (fsrunloop.cpp NeedRedraw), but a transient skipped tick must not
	// blink the whole menu out -- the pre-fix on-device symptom was the quad
	// flickering in and out as the 2D redraw throttle gated menuDrawn.  The
	// menu FBO keeps the last rendered image, so during the grace window we
	// just keep compositing it (the copy still runs every presented frame,
	// per the swapchain-freshness discipline).  8 frames = ~110ms at 72Hz:
	// long enough to ride out a hiccup, short enough that the quad is gone
	// before the flight scene fades in after a menu->flight transition.
	// ---- VR keyboard quad (text input on the menu boards) ------------------
	// menuData[6] (see fsvr.h) reports that the menu frame the engine just
	// rendered contains a keyboard-focused text box (the aircraft-select
	// search box, the lobby user-name box, ...).  Round 1 of this feature
	// summoned the HEADSET's system keyboard by focusing a hidden DOM
	// <input> mid-session -- which crashed the Quest browser outright the
	// moment the lobby's player-name box was clicked (2026-07 device
	// report), so the DOM route is gone entirely.  Instead the port draws
	// its OWN keyboard: a world-anchored quad hanging just under the menu
	// board, typed on with the same controller ray + trigger the menu
	// itself uses (processKbdRayInput piggybacks on processMenuRayInput's
	// per-source loop conventions).  Keystrokes reach the engine through
	// FsPushTextEdit -- the same FsPushKey/FsPushChar pairs a physical
	// keyboard's window events produce, so FsGuiTextBox sees no difference;
	// a Bluetooth keyboard keeps working through the untouched window
	// handlers.  Draw/upload follows the dial quads' hard-won discipline:
	// canvas repaints are change-driven (hover/shift), the texture upload
	// runs every presented frame (see updateDialLayers' stale-face
	// post-mortem for why the upload must NOT sit behind the repaint gate).
	var KBD_CANVAS_W=576,KBD_CANVAS_H=240;
	var KBD_COLS=12,KBD_ROWS=5;
	var KBD_HIDE_GRACE=8; // frames; same transient-gap tolerance as the menu quad.
	// Grid layout: w in columns (default 1); ch types that character (shift
	// uppercases letters), act names a FsPushTextEdit action or the local
	// shift toggle.  ASCII-only by design -- engine text boxes are
	// byte-charset (user names, aircraft-name search).
	var KBD_LAYOUT=[
		[{ch:'1'},{ch:'2'},{ch:'3'},{ch:'4'},{ch:'5'},{ch:'6'},{ch:'7'},{ch:'8'},{ch:'9'},{ch:'0'},{ch:'-'},{act:'bs',label:'\u232b'}],
		[{ch:'q'},{ch:'w'},{ch:'e'},{ch:'r'},{ch:'t'},{ch:'y'},{ch:'u'},{ch:'i'},{ch:'o'},{ch:'p'},{ch:'_'},{ch:'.'}],
		[{ch:'a'},{ch:'s'},{ch:'d'},{ch:'f'},{ch:'g'},{ch:'h'},{ch:'j'},{ch:'k'},{ch:'l'},{act:'enter',label:'OK',w:3}],
		[{act:'shift',label:'\u21e7',w:2},{ch:'z'},{ch:'x'},{ch:'c'},{ch:'v'},{ch:'b'},{ch:'n'},{ch:'m'},{act:'left',label:'\u2190'},{act:'right',label:'\u2192'}],
		[{ch:' ',label:'space',w:12}]
	];
	function kbdState()
	{
		if(!vr.kbd)
		{
			vr.kbd={res:undefined,anchor:null,anchorFrom:null,idleFrames:1e9,shift:false,
				hover:{right:-1,left:-1},prevTrig:{right:false,left:false},
				cursor:{right:null,left:null},
				drawnKey:null,keys:null,stats:{chars:0,edits:0}};
		}
		return vr.kbd;
	}
	// Flattened key rects in canvas pixels, computed once: {x,y,w,h,def}.
	function kbdKeyRects()
	{
		var st=kbdState();
		if(st.keys)
		{
			return st.keys;
		}
		var cellW=KBD_CANVAS_W/KBD_COLS,cellH=KBD_CANVAS_H/KBD_ROWS;
		var keys=[];
		for(var r=0; r<KBD_LAYOUT.length; ++r)
		{
			var row=KBD_LAYOUT[r],c=0;
			for(var i=0; i<row.length; ++i)
			{
				var def=row[i],w=def.w||1;
				keys.push({x:c*cellW,y:r*cellH,w:w*cellW,h:cellH,def:def});
				c+=w;
			}
		}
		st.keys=keys;
		return keys;
	}
	// Canvas-pixel point -> key index, or -1.  Same y-down convention as
	// menuUvToPixel (quad UV v=0 is the canvas top row).
	function kbdHitKey(px,py)
	{
		var keys=kbdKeyRects();
		for(var i=0; i<keys.length; ++i)
		{
			var k=keys[i];
			if(k.x<=px&&px<k.x+k.w&&k.y<=py&&py<k.y+k.h)
			{
				return i;
			}
		}
		return -1;
	}
	function kbdKeyLabel(def,shift)
	{
		if(def.label)
		{
			return def.label;
		}
		var ch=def.ch||'';
		return (shift ? ch.toUpperCase() : ch);
	}
	function kbdDispatchKey(i)
	{
		var st=kbdState();
		var keys=kbdKeyRects();
		if(i<0||keys.length<=i)
		{
			return;
		}
		var def=keys[i].def;
		switch(def.act||'char')
		{
		case 'char':
			var ch=(st.shift ? (def.ch||'').toUpperCase() : (def.ch||''));
			if(ch)
			{
				_FsPushTextEdit(0,ch.charCodeAt(0));
				++st.stats.chars;
			}
			break;
		case 'bs':    _FsPushTextEdit(1,0); ++st.stats.edits; break;
		case 'enter': _FsPushTextEdit(2,0); ++st.stats.edits; break;
		case 'left':  _FsPushTextEdit(4,0); ++st.stats.edits; break;
		case 'right': _FsPushTextEdit(5,0); ++st.stats.edits; break;
		case 'shift': st.shift=!st.shift; break;
		}
	}
	function drawKbd(ctx)
	{
		var st=kbdState();
		var keys=kbdKeyRects();
		ctx.clearRect(0,0,KBD_CANVAS_W,KBD_CANVAS_H);
		ctx.fillStyle='rgba(10,16,20,0.92)';
		roundRectPath(ctx,0,0,KBD_CANVAS_W,KBD_CANVAS_H,10);
		ctx.fill();
		ctx.textAlign='center';
		ctx.textBaseline='middle';
		for(var i=0; i<keys.length; ++i)
		{
			var k=keys[i];
			var hovered=(i===st.hover.right||i===st.hover.left);
			var shiftOn=('shift'===k.def.act&&st.shift);
			roundRectPath(ctx,k.x+3,k.y+3,k.w-6,k.h-6,6);
			ctx.fillStyle=(hovered ? 'rgba(255,214,64,0.92)' : (shiftOn ? 'rgba(120,180,255,0.40)' : 'rgba(230,237,243,0.12)'));
			ctx.fill();
			ctx.fillStyle=(hovered ? '#20232a' : '#dff2e8');
			var label=kbdKeyLabel(k.def,st.shift);
			ctx.font=(1<label.length ? '16px' : '21px')+' system-ui,sans-serif';
			ctx.fillText(label,k.x+k.w/2,k.y+k.h/2+1);
		}
		// Aim cursors: a ring at each hand's exact ray hit, same affordance
		// as the menu board's cursor overlay -- the key highlight alone read
		// as "can't tell where I'm pointing" on device.
		var hands=['right','left'];
		for(var c2=0; c2<hands.length; ++c2)
		{
			var cur=st.cursor[hands[c2]];
			if(cur)
			{
				ctx.beginPath();
				ctx.arc(cur.x,cur.y,7,0,2*Math.PI);
				ctx.lineWidth=3;
				ctx.strokeStyle=('right'===hands[c2] ? 'rgba(255,214,64,0.95)' : 'rgba(102,204,255,0.95)');
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(cur.x,cur.y,1.5,0,2*Math.PI);
				ctx.fillStyle='#ffffff';
				ctx.fill();
			}
		}
	}
	function kbdQuadSize()
	{
		// Match the menu board's width so the pair reads as one console;
		// height follows the canvas aspect.
		var w=((vr.menuRes&&vr.menuRes.quadW) ? vr.menuRes.quadW : 1.2)*0.92;
		return {w:w,h:w*(KBD_CANVAS_H/KBD_CANVAS_W)};
	}
	function ensureKbdResources()
	{
		var st=kbdState();
		if(undefined!==st.res)
		{
			return st.res; // cached: an object, or false (unavailable).
		}
		var res=false;
		try
		{
			var canvas=document.createElement('canvas');
			canvas.width=KBD_CANVAS_W;
			canvas.height=KBD_CANVAS_H;
			var quad=null;
			if(vr.mvBinding&&vr.refSpace)
			{
				var sz=kbdQuadSize();
				quad=vr.mvBinding.createQuadLayer({
					space:vr.refSpace,
					viewPixelWidth:KBD_CANVAS_W,
					viewPixelHeight:KBD_CANVAS_H,
					layout:'mono',
					width:quadDecl(sz.w),
					height:quadDecl(sz.h)
				});
				try{ if('blendTextureSourceAlpha' in quad){ quad.blendTextureSourceAlpha=true; } }catch(e){}
			}
			else if(!vr.testMode)
			{
				st.res=false;
				return false; // No layers support and not in the headless harness.
			}
			res={canvas:canvas,ctx:canvas.getContext('2d'),quad:quad,inLayers:false};
		}
		catch(e)
		{
			console.warn('[vr] keyboard quad unavailable: '+(e&&e.message?e.message:e));
			res=false;
		}
		st.res=res;
		return res;
	}
	function anchorKbdQuad()
	{
		var st=kbdState();
		if(!st.res||!vr.menuAnchor||!vr.menuRes)
		{
			return;
		}
		if(st.anchorFrom===vr.menuAnchor)
		{
			return; // Still anchored to the current menu anchor (identity check:
			        // anchorMenuQuad replaces the object on every re-anchor).
		}
		var menuH=vr.menuRes.quadH||0.7;
		var sz=kbdQuadSize();
		// The menu anchor is yaw-only, so its local -Y is world down.  Hang
		// the keyboard under the board's bottom edge, pulled 0.35 m toward
		// the viewer and tilted back 30 deg like a lectern -- the coplanar
		// round-1 placement put a vertical slab low in the view, which read
		// as hard to aim at on device.  The ray hit-test uses this same
		// pose (st.anchor), so typing and visuals cannot drift.
		var fwd=rotateVecByQuat({x:0,y:0,z:1},vr.menuAnchor.quat); // local +Z = toward the viewer
		var tilt=quatMultiply(vr.menuAnchor.quat,quatFromAxisAngle({x:1,y:0,z:0},-30*Math.PI/180));
		var pos={
			x:vr.menuAnchor.pos.x+fwd.x*0.35,
			y:vr.menuAnchor.pos.y-(menuH/2+sz.h/2),
			z:vr.menuAnchor.pos.z+fwd.z*0.35
		};
		st.anchor={pos:pos,quat:tilt,w:sz.w,h:sz.h};
		st.anchorFrom=vr.menuAnchor;
		if(st.res.quad)
		{
			try{ st.res.quad.transform=new XRRigidTransform(pos,tilt); }catch(e){}
		}
	}
	// System-keyboard route: RETIRED after the round-5 device test.  The
	// ?vrkbd=sys experiment requested the dom-overlay session feature (the
	// supported precondition for summoning the Quest system keyboard -- DOM
	// focus withOUT it is what crashed the browser outright in round 1),
	// but the Quest Browser never granted it for this immersive-vr layers
	// session: session.domOverlayState stayed null and the port-drawn quad
	// took over every time (round-5 device report).  The quad keyboard
	// below is therefore THE text-input path, not a fallback.
	//
	// Per-frame keyboard maintenance, called from updateMenuLayer (so it
	// only runs in menu contexts).  Returns true when the layers list
	// changed so the caller folds it into its own syncRenderStateLayers.
	function updateKbdLayer(frame,menuVisible)
	{
		var st=kbdState();
		var p=_YsfwVrMenuDataPointer()>>2;
		if(menuVisible&&0!==HEAPF32[p+6])
		{
			st.idleFrames=0;
		}
		else
		{
			++st.idleFrames;
		}
		var visible=(st.idleFrames<=KBD_HIDE_GRACE);
		var res=(visible ? ensureKbdResources() : st.res);
		if(!res)
		{
			return false;
		}
		var layersChanged=false;
		if(visible&&!res.inLayers&&res.quad)
		{
			res.inLayers=true;
			st.drawnKey=null; // Force a repaint on (re)appearance.
			layersChanged=true;
		}
		else if(!visible&&res.inLayers)
		{
			res.inLayers=false;
			st.hover.right=-1;
			st.hover.left=-1;
			layersChanged=true;
		}
		if(visible)
		{
			anchorKbdQuad();
			// Quantize the cursor rings to 3px so aim feedback repaints
			// smoothly without repainting on sub-pixel jitter every frame.
			var cq=function(c){ return (c ? Math.round(c.x/3)+','+Math.round(c.y/3) : '-'); };
			var key=st.hover.right+'|'+st.hover.left+'|'+(st.shift?1:0)+'|'+cq(st.cursor.right)+'|'+cq(st.cursor.left);
			if(key!==st.drawnKey&&res.ctx)
			{
				try
				{
					drawKbd(res.ctx);
					st.drawnKey=key;
				}
				catch(e){}
			}
			// Upload every presented frame regardless of the repaint gate --
			// see updateDialLayers' stale-face post-mortem.
			if(res.quad&&res.inLayers&&frame)
			{
				try
				{
					var sub=vr.mvBinding.getSubImage(res.quad,frame);
					uploadCanvasToSubImage(res.canvas,sub);
				}
				catch(e){}
			}
		}
		return layersChanged;
	}
	// Ray hover + trigger typing, called unconditionally from
	// processMenuRayInput once the per-hand menu hits are known (a hand
	// pointing at the menu board cannot simultaneously type -- the board
	// wins that hand; since the lectern pose the two quads are no longer
	// coplanar, but the board hangs entirely above the keyboard so a ray
	// still lands on at most one of them).
	function processKbdRayInput(frame,menuHits)
	{
		var st=kbdState();
		var res=st.res;
		if(!res||!res.inLayers||!st.anchor)
		{
			st.hover.right=-1;
			st.hover.left=-1;
			st.cursor.right=null;
			st.cursor.left=null;
			return;
		}
		var sources=frame.session.inputSources;
		var seen={right:false,left:false};
		for(var i=0; i<sources.length; ++i)
		{
			var src=sources[i];
			if(!src.targetRaySpace)
			{
				continue;
			}
			var hand=src.handedness;
			if(hand!=='right'&&hand!=='left')
			{
				continue;
			}
			if(seen[hand])
			{
				continue;
			}
			seen[hand]=true;
			var hover=-1,trig=false,cursor=null;
			if(!menuHits[hand])
			{
				var rayPose=frame.getPose(src.targetRaySpace,vr.refSpace);
				if(rayPose)
				{
					var hit=intersectRayWithAnchoredQuad(
						rayPose.transform.position,rayPose.transform.orientation,
						st.anchor.pos,st.anchor.quat,st.anchor.w,st.anchor.h);
					if(hit)
					{
						var px=hit.u*KBD_CANVAS_W,py=hit.v*KBD_CANVAS_H;
						hover=kbdHitKey(px,py);
						cursor={x:px,y:py};
						var gp=src.gamepad;
						trig=!!(gp&&gp.buttons[0]&&gp.buttons[0].value>0.5);
					}
				}
			}
			st.hover[hand]=hover;
			st.cursor[hand]=cursor;
			if(trig&&!st.prevTrig[hand]&&0<=hover)
			{
				kbdDispatchKey(hover);
				vrHapticPulse(src);
			}
			st.prevTrig[hand]=trig;
		}
		// A controller that dropped out of inputSources (tracking loss,
		// sleep) never reaches the loop above: clear its remembered hover/
		// cursor so a stale highlight cannot survive (device symptom: a key
		// stuck yellow while neither beam pointed at the board).
		var allHands=['right','left'];
		for(var h3=0; h3<allHands.length; ++h3)
		{
			if(!seen[allHands[h3]])
			{
				st.hover[allHands[h3]]=-1;
				st.cursor[allHands[h3]]=null;
			}
		}
	}
	function teardownKbd()
	{
		if(!vr.kbd)
		{
			return;
		}
		var res=vr.kbd.res;
		if(res&&res.quad)
		{
			try{ res.quad.destroy(); }catch(e){}
		}
		vr.kbd=null;
	}

	var MENU_HIDE_GRACE=8;
	var UNSUPPORTED_VR_GRACE=45; // ~0.63s at 72Hz: enough for menu/flight transitions.
	function updateMenuLayer(frame)
	{
		if(!vr.menuRes)
		{
			// If the menu FBO failed but the sky layer exists, cover a non-flight
			// entry while the watchdog prepares to return to 2D.  This avoids
			// presenting a frozen, head-following projection texture even during
			// the short failure grace window.
			if(updateSkyLayer(frame,!globalThis.ysfwInFlight))
			{
				syncRenderStateLayers();
			}
			return;
		}
		var p=_YsfwVrMenuDataPointer()>>2;
		var menuDrawn=(0!==HEAPF32[p+5]);
		HEAPF32[p+5]=0;

		if(menuDrawn)
		{
			vr.menuIdleFrames=0;
		}
		else
		{
			++vr.menuIdleFrames;
		}
		// menuIdleFrames starts (and resets to) a huge value, so the quad can
		// only appear after the engine has actually rendered the menu once --
		// never as an uninitialized-FBO square at session start mid-flight.
		var menuVisible=(vr.menuIdleFrames<=MENU_HIDE_GRACE);

		var layersChanged=false;

		if(updateKbdLayer(frame,menuVisible))
		{
			layersChanged=true;
		}

		if(menuVisible)
		{
			// Anchor (or re-anchor after vrRecenter) the menu quad in world
			// space whenever it is visible without an anchor.  Rising edge
			// (first show) and post-recenter recovery both hit this path.
			if(!vr.menuAnchor)
			{
				anchorMenuQuad(vr.lastViewerPose);
			}
			if(!vr.menuRes.inLayers)
			{
				vr.menuRes.inLayers=true;
				layersChanged=true;
			}
			if(vr.menuRes.quad)
			{
				try
				{
					var sub=vr.mvBinding.getSubImage(vr.menuRes.quad,frame);
					// Honour the sub-image viewport (see
					// uploadCanvasToSubImage's identical fix): a packed
					// allocator hands this layer a rectangle INSIDE a shared
					// texture, and a copy pinned to (0,0) overwrites whichever
					// layer owns the corner -- the on-device "second phantom
					// menu quad" corruption.
					var mvp=(sub&&sub.viewport)?sub.viewport:null;
					var mdx=(mvp?mvp.x:0),mdy=(mvp?mvp.y:0);
					var mcw=(mvp?Math.min(vr.menuRes.w,mvp.width):vr.menuRes.w);
					var mch=(mvp?Math.min(vr.menuRes.h,mvp.height):vr.menuRes.h);
					if(mvp&&(mvp.x!==0||mvp.y!==0||mvp.width!==vr.menuRes.w||mvp.height!==vr.menuRes.h))
					{
						reportSubImageViewport(mvp,vr.menuRes.w,vr.menuRes.h);
					}
					var prevReadFb=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
					GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,vr.menuRes.fb);
					GLctx.bindTexture(GLctx.TEXTURE_2D,sub.colorTexture);
					GLctx.copyTexSubImage2D(GLctx.TEXTURE_2D,0,mdx,mdy,0,0,mcw,mch);
					GLctx.bindTexture(GLctx.TEXTURE_2D,null);
					GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,prevReadFb);
				}
				catch(e){}
			}
		}
		else if(vr.menuRes.inLayers)
		{
			vr.menuRes.inLayers=false;
			vr.menuAnchor=null; // Clear so next show re-anchors fresh.
			layersChanged=true;
		}

		// Sky equirect tracks menu visibility (grace window included).  It also
		// covers any non-flight/non-menu entry during the short auto-exit grace,
		// hiding the stale projection texture that otherwise follows the head.
		// drives its own inLayers and upload, returns true if inLayers changed
		// (we OR into layersChanged so the single syncRenderStateLayers call
		// below covers both).
		if(updateSkyLayer(frame,menuVisible||!globalThis.ysfwInFlight))
		{
			layersChanged=true;
		}

		if(layersChanged)
		{
			syncRenderStateLayers();
		}
	}

	// Reads back the mean RGBA of the menu FBO -- used by smoke-vrmenu.mjs to
	// prove the engine actually drew into it.  Uses the plain FRAMEBUFFER
	// target, NOT READ_FRAMEBUFFER: the CI runner's fallback context is
	// WebGL1 (no separate read/draw targets -- READ_FRAMEBUFFER is
	// INVALID_ENUM there), and on WebGL2 binding FRAMEBUFFER sets both, so
	// readPixels works either way.
	vr.readMenuStats=function()
	{
		if(!vr.menuRes)
		{
			return {alpha:0,lum:0};
		}
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,rfb);
		GLctx.framebufferTexture2D(GLctx.FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,GLctx.TEXTURE_2D,vr.menuRes.tex,0);
		var W=vr.menuRes.w, H=vr.menuRes.h;
		// sample a 16x16 grid to stay fast even at full canvas resolution
		var step=Math.max(1,Math.floor(Math.min(W,H)/16));
		var wS=Math.ceil(W/step), hS=Math.ceil(H/step);
		var px=new Uint8Array(wS*hS*4);
		GLctx.readPixels(0,0,wS,hS,GLctx.RGBA,GLctx.UNSIGNED_BYTE,px);
		GLctx.bindFramebuffer(GLctx.FRAMEBUFFER,prev);
		GLctx.deleteFramebuffer(rfb);
		var sumA=0, sumL=0;
		for(var i=0; i<px.length; i+=4)
		{
			sumA+=px[i+3];
			sumL+=0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
		}
		var n=px.length/4;
		return {alpha:sumA/n, lum:sumL/n};
	};

	vr.readMenuData=function()
	{
		var p=_YsfwVrMenuDataPointer()>>2;
		var out=[];
		for(var i=0; i<8; ++i){ out.push(HEAPF32[p+i]); }
		return out;
	};
	// Test-only write access (scripts/smoke-vrmenu.mjs's text-bridge group
	// fakes the engine's menuData[6] focus flag): page contexts cannot reach
	// HEAPF32 directly (not in EXPORTED_RUNTIME_METHODS).
	vr.pokeMenuData=function(i,v)
	{
		HEAPF32[(_YsfwVrMenuDataPointer()>>2)+i]=v;
	};

	// One visual cursor per hand plus one arbitrated engine-mouse owner.
	// hitU/hitV are the menu UV coordinates shared by cursor and mouse. Both hands
	// stay visible; whichever hand presses trigger takes mouse ownership, and
	// an in-progress drag keeps ownership until release/leave.  Deliberately
	// moving the other hand transfers hover ownership without requiring a click.
	function makeMenuRayHandState()
	{
		return {wasHit:false,hitU:0,hitV:0,prevTrig:false};
	}
	var menuRayState={activeHand:null,prevMx:-1,prevMy:-1,prevTrig:false,
		hands:{right:makeMenuRayHandState(),left:makeMenuRayHandState()}};
	function resetMenuRayState()
	{
		menuRayState.activeHand=null;
		menuRayState.prevMx=-1;
		menuRayState.prevMy=-1;
		menuRayState.prevTrig=false;
		menuRayState.hands={right:makeMenuRayHandState(),left:makeMenuRayHandState()};
	}
	function chooseMenuRayHand(hits,activeHand,mouseDown,previousTriggers,movedHands)
	{
		// Never let the other hand steal an active drag.
		if(mouseDown && activeHand && hits[activeHand])
		{
			return activeHand;
		}
		// A fresh trigger edge explicitly claims ownership.  Check the current
		// owner first only when both hands press on the same frame.
		var order=(activeHand==='left' ? ['left','right'] : ['right','left']);
		for(var i=0; i<order.length; ++i)
		{
			var hand=order[i];
			if(hits[hand] && hits[hand].trig && !previousTriggers[hand])
			{
				return hand;
			}
		}
		// When both rays remain on the menu, make the hand the pilot actually
		// moved own hover.  Ignore sub-threshold controller jitter; if both moved
		// together, retaining the current owner is the least surprising result.
		movedHands=movedHands||{};
		if(!!movedHands.right!==!!movedHands.left)
		{
			var moved=movedHands.right ? 'right' : 'left';
			if(hits[moved])
			{
				return moved;
			}
		}
		// Otherwise keep hover ownership stable while that ray remains on the
		// menu; if it left, fall back to whichever hand still hits.
		if(activeHand && hits[activeHand])
		{
			return activeHand;
		}
		return hits.right ? 'right' : (hits.left ? 'left' : null);
	}
	function menuUvToPixel(u,v,texW,texH)
	{
		return {
			x:Math.round(Math.max(0,Math.min(1,u))*Math.max(0,texW-1)),
			y:Math.round(Math.max(0,Math.min(1,v))*Math.max(0,texH-1))
		};
	}
	// Pure ray-vs-anchored-quad intersection (no XR/session state) so
	// headless tests can drive it -- same pattern as
	// vr.yawOnlyQuatFromOrientation.  Inputs: ray origin/orientation
	// ({x,y,z} / {x,y,z,w}) and the quad anchor pose, all in the SAME
	// (reference) space, plus the quad's metric size.  Returns null when
	// the ray misses, or {u,v,localX,localY} on the visible (+Z) face:
	// u/v in [0,1] with v=0 at the TOP edge (texture convention), localX/
	// localY in quad-local metres (for cursor placement).
	// Backface and behind-origin hits are rejected: the ray must originate
	// on the quad's +Z side and travel toward -Z.
	function intersectRayWithAnchoredQuad(rayPos,rayQuat,anchorPos,anchorQuat,quadW,quadH)
	{
		var aQuatInv=quatConjugate(anchorQuat);
		var roLocal=rotateVecByQuat(
			{x:rayPos.x-anchorPos.x,y:rayPos.y-anchorPos.y,z:rayPos.z-anchorPos.z},
			aQuatInv);
		var worldDir=rotateVecByQuat({x:0,y:0,z:-1},rayQuat);
		var rdLocal=rotateVecByQuat(worldDir,aQuatInv);
		// Visible face is local z=0 seen from +Z: require the origin in
		// front and the ray heading into the plane (backface exclusion).
		if(roLocal.z<=0 || rdLocal.z>=-1e-6)
		{
			return null;
		}
		var t=-roLocal.z/rdLocal.z;
		var hx=roLocal.x+t*rdLocal.x;
		var hy=roLocal.y+t*rdLocal.y;
		var u=(hx+quadW/2)/quadW;
		var v=(quadH/2-hy)/quadH; // top=0, bottom=1
		if(u<0||u>1||v<0||v>1)
		{
			return null;
		}
		return {u:u,v:v,localX:hx,localY:hy};
	}
	// Projects each controller's aim ray onto the menu quad (anchored in
	// vr.refSpace) and injects a mouse-move event + left-button edge into
	// the engine via YsfwInjectMouseEvent.  Only active while the menu quad
	// is being shown (menuVisible, checked at call site).
	//
	// Menu quad geometry (quad-LOCAL space; quad face in the XY plane):
	//   centre = (0, 0);  width = 1.6m;  height = 1.6*H/W
	//   visible face: the +Z side (viewer is at local +Z).
	//
	// The ray is fetched in vr.refSpace and intersected with the quad via
	// intersectRayWithAnchoredQuad (see above for the math), so the
	// intersection stays correct when the head moves independently of the
	// anchored quad.
	//
	// Per-hand wasHit / hitU / hitV feed both rings in the cursor overlay. The
	// engine still receives a single mouse stream, chosen by
	// chooseMenuRayHand (fresh trigger edges can claim it from either hand).
	function processMenuRayInput(frame)
	{
		if(!vr.menuRes||!vr.refSpace||!vr.menuAnchor)
		{
			return;
		}
		var p=_YsfwVrMenuDataPointer()>>2;
		var texW=HEAPF32[p+3];
		var texH=HEAPF32[p+4];
		if(texW<=0||texH<=0)
		{
			return;
		}

		var quadW=vr.menuRes.quadW||MENU_QUAD_WIDTH_M;
		var quadH=vr.menuRes.quadH||menuQuadMetricSize(texW,texH).h;

		var aPos=vr.menuAnchor.pos;
		var aQuat=vr.menuAnchor.quat;

		var sources=frame.session.inputSources;
		var hits={right:null,left:null};
		var movedHands={right:false,left:false};
		var hands=['right','left'];
		var previousHit={
			right:(menuRayState.hands.right.wasHit ? {u:menuRayState.hands.right.hitU,v:menuRayState.hands.right.hitV} : null),
			left:(menuRayState.hands.left.wasHit ? {u:menuRayState.hands.left.hitU,v:menuRayState.hands.left.hitV} : null)
		};
		for(var h0=0; h0<hands.length; ++h0)
		{
			menuRayState.hands[hands[h0]].wasHit=false;
		}
		for(var i=0; i<sources.length; ++i)
		{
			var src=sources[i];
			if(!src.targetRaySpace)
			{
				continue;
			}
			var hand=src.handedness;
			if(hand!=='right'&&hand!=='left')
			{
				// Best effort for controllers that omit handedness: assign the
				// first two sources deterministically so they still remain usable.
				hand=hits.right ? 'left' : 'right';
			}
			if(hits[hand])
			{
				continue;
			}
			// Ray in refSpace.
			var rayPose=frame.getPose(src.targetRaySpace,vr.refSpace);
			if(!rayPose)
			{
				continue;
			}
			var hit=intersectRayWithAnchoredQuad(
				rayPose.transform.position,rayPose.transform.orientation,
				aPos,aQuat,quadW,quadH);
			if(!hit)
			{
				continue;
			}
			// Trigger button = left mouse click.
			var gp=src.gamepad;
			var pixel=menuUvToPixel(hit.u,hit.v,texW,texH);
			var rec={
				mx:pixel.x,
				my:pixel.y,
				trig:!!(gp && gp.buttons[0] && gp.buttons[0].value>0.5),
				u:hit.u,v:hit.v
			};
			hits[hand]=rec;
			var old=previousHit[hand];
			movedHands[hand]=(!old || 0.002<Math.abs(hit.u-old.u)+Math.abs(hit.v-old.v));
			menuRayState.hands[hand].wasHit=true;
			menuRayState.hands[hand].hitU=hit.u;
			menuRayState.hands[hand].hitV=hit.v;
		}

		// If a dragging hand left the quad, release at its LAST valid pixel
		// before considering the other hand.  This prevents a stuck button and
		// avoids relocating the UP edge to the other cursor.
		if(menuRayState.prevTrig && menuRayState.activeHand && !hits[menuRayState.activeHand])
		{
			_YsfwInjectMouseEvent(3,0,0,0,menuRayState.prevMx,menuRayState.prevMy);
			menuRayState.prevTrig=false;
			menuRayState.activeHand=null;
		}

		// Feed the keyboard BEFORE the menu decides whether any hand owns
		// the mouse: this call used to sit at the TAIL of this function,
		// after an early return taken whenever NO hand was on the board --
		// which is exactly the normal typing posture (both rays down on the
		// lectern keys), so on device the keys never hovered, never
		// clicked, and a stale highlight could freeze (round-5 report:
		// "aim still broken").  Hands currently over the menu are excluded
		// inside (the board wins a hand that is on it).
		processKbdRayInput(frame,hits);

		var previousTriggers={
			right:menuRayState.hands.right.prevTrig,
			left:menuRayState.hands.left.prevTrig
		};
		var chosen=chooseMenuRayHand(hits,menuRayState.activeHand,menuRayState.prevTrig,previousTriggers,movedHands);
		if(!chosen)
		{
			// No controller hit the menu this frame.  Preserve the engine's last
			// hover coordinate (there is no mouse coordinate meaning "nowhere").
			if(menuRayState.activeHand)
			{
				_YsfwInjectMouseEvent(1,0,0,0,menuRayState.prevMx,menuRayState.prevMy);
			}
			menuRayState.activeHand=null;
			menuRayState.prevTrig=false;
			for(var h1=0; h1<hands.length; ++h1)
			{
				var hh1=hands[h1];
				menuRayState.hands[hh1].prevTrig=!!(hits[hh1]&&hits[hh1].trig);
			}
			return;
		}
		var selected=hits[chosen];
		menuRayState.activeHand=chosen;

		// Inject mouse move.
		if(selected.mx!==menuRayState.prevMx||selected.my!==menuRayState.prevMy||selected.trig!==menuRayState.prevTrig)
		{
			// eventType: 1=FSMOUSEEVENT_MOVE, 2=FSMOUSEEVENT_LBUTTONDOWN, 3=FSMOUSEEVENT_LBUTTONUP
			var lb=(selected.trig ? 1 : 0);
			var evtType;
			if(selected.trig&&!menuRayState.prevTrig)
			{
				evtType=2; // left button down
			}
			else if(!selected.trig&&menuRayState.prevTrig)
			{
				evtType=3; // left button up
			}
			else
			{
				evtType=1; // move
			}
			_YsfwInjectMouseEvent(evtType,lb,0,0,selected.mx,selected.my);
			menuRayState.prevMx=selected.mx;
			menuRayState.prevMy=selected.my;
			menuRayState.prevTrig=selected.trig;
		}
		for(var h2=0; h2<hands.length; ++h2)
		{
			var hh2=hands[h2];
			menuRayState.hands[hh2].prevTrig=!!(hits[hh2]&&hits[hh2].trig);
		}
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
		// Headless-test override (vr.testGuiOverride, see its doc comment on
		// the vr state block above) takes priority when set -- lets
		// scripts/smoke-vrgui.mjs fabricate a >6-option menu's
		// dialogVisible/apMenu without a live engine dialog, which would
		// otherwise stomp any direct write to the native block on the very
		// next real engine tick (FsSimulation::SimComputeVrGuiState runs
		// unconditionally and would see no C++ dialog open). Never set in a
		// real session.
		if(vr.testGuiOverride)
		{
			return {visible:!!vr.testGuiOverride.visible,apMenu:!!vr.testGuiOverride.apMenu};
		}
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
		// Headless-test override, see guiDialogState's identical check
		// above: returns the fabricated list directly, bypassing the
		// version-cache/native read entirely (cheap enough either way, and
		// only ever taken when a test has explicitly opted in).
		if(vr.testGuiOverride)
		{
			return vr.testGuiOverride.menu||[];
		}
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
	// How many sectors the N-way dial guide can show at once -- one per real
	// option, so this is also the max menu size the guide alone can fully
	// drive (see the class doc comment's GUI-in-VR section). 8 covers every
	// currently-known hotkey-driven in-flight dialog: the autopilot family
	// tops out at 6 real options, radio-comm's wingman-command menu (the
	// widest, see FsGuiRadioCommCommandDialog) at exactly 8 (7 numbered
	// commands plus an explicit "0...Don't send"); Digit1..Digit9/Digit0 give
	// headroom to 10 if a future dialog ever needs it, but a 256px quad
	// showing 8 short-text wedges is already tight (see drawGuiDialGuide) so
	// this stays at the honest, currently-sufficient 8 rather than the raw
	// keyboard ceiling.
	var GUI_DIAL_CAPACITY=8;
	// Turns the engine's raw option-label list into what the dial guide can
	// actually show: the non-cancel options (up to GUI_DIAL_CAPACITY of
	// them), the cancel line separately, an overflow flag when there were
	// MORE real options than that, and "drivable" -- whether the per-option
	// positional Digit dispatch (guiDialEngagedFor/hotkeyCode above) is
	// trustworthy to promise via a numbered face at all, which requires BOTH
	// that the engine says this dialog accepts direct positional hotkeys
	// (hotkeyMenu, fsvr.h's apMenu) AND that there is at least one real
	// option to show. Overflow does NOT affect drivable/dispatch: every
	// sector within GUI_DIAL_CAPACITY still fires the exact same real action
	// whether or not a 9th+ option exists out of the dial's reach --
	// overflow only means the guide must ALSO point at the on-quad panel
	// (forced on, see maybeForceGuiPanel) for the rest.
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
	function quatFromAxisAngle(axis,rad)
	{
		var s=Math.sin(rad/2);
		return {x:axis.x*s,y:axis.y*s,z:axis.z*s,w:Math.cos(rad/2)};
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

	// ---- VR hand-pose block (fsvr.h's FsVrHandPoseDataPointer) -----------
	// Re-bases a grip pose (position+orientation, both relative to the SAME
	// XR reference space the viewer pose is given in) onto the viewer's OWN
	// pose this frame: relPos/relQuat = inverse(viewerPose)*gripPose. Pure
	// re-basing, no coordinate-convention change (still x right, y up, -z
	// forward) -- see fsvr.h's doc comment for why the engine can consume
	// this directly (FsVisual::Draw's pos/att are already eye-relative).
	function gripPoseInViewerSpace(gripPos,gripQuat,viewerPos,viewerQuat)
	{
		var vqConj=quatConjugate(viewerQuat);
		var relPos=rotateVecByQuat(vecSub(gripPos,viewerPos),vqConj);
		var relQuat=quatMultiply(vqConj,gripQuat);
		return {pos:relPos,quat:relQuat};
	}

	// Writes one hand's slot of the hand-pose block: right=[0..7] (grabbed
	// at [7]), left=[8..15] ([15] left reserved -- the engine gates the
	// left/throttle hand on FsVrControlDataPointer[4] instead, see fsvr.h).
	function writeHandPoseBlock(hand,gripPos,gripQuat,viewerPos,viewerQuat,grabbed)
	{
		var rel=gripPoseInViewerSpace(gripPos,gripQuat,viewerPos,viewerQuat);
		var ptr=_YsfwVrHandPoseDataPointer()>>2;
		var base=('right'===hand ? 0 : 8);
		HEAPF32[ptr+base+0]=rel.pos.x;
		HEAPF32[ptr+base+1]=rel.pos.y;
		HEAPF32[ptr+base+2]=rel.pos.z;
		HEAPF32[ptr+base+3]=rel.quat.x;
		HEAPF32[ptr+base+4]=rel.quat.y;
		HEAPF32[ptr+base+5]=rel.quat.z;
		HEAPF32[ptr+base+6]=rel.quat.w;
		if('right'===hand)
		{
			HEAPF32[ptr+7]=(grabbed ? 1 : 0);
		}
	}

	// ---- Anchored HOTAS-prop console pose ---------------------------------
	// Device feedback on the first hand-prop revision: streaming the LIVE
	// grip pose into the hand-pose block made the whole console (base plate
	// included) follow every wobble of the hand -- "feels bad".  A real
	// stick/throttle console is bolted to the airframe: only its ARTICULATED
	// part moves.  The articulation already comes for free (the engine's
	// DrawJoystick/DrawThrottle animate the rod/lever from the LIVE
	// ctlAileron/ctlElevator/ctlThrottle, which this same VR grab drives), so
	// the whole fix is to freeze the CONSOLE pose at the grab point instead
	// of streaming the hand: on each grab's rising edge, capture the grip
	// position in the REFERENCE space (room-fixed == cockpit-fixed) and pair
	// it with a SYNTHETIC upright orientation (below); while the grab holds
	// (sticky latch included), re-base that frozen reference-space pose onto
	// each frame's viewer pose (the same inverse(viewer)*pose re-basing
	// gripPoseInViewerSpace always did) so the engine keeps consuming plain
	// viewer-space data with no change on its side.  Release clears the
	// anchor; a re-grab re-anchors at the new grab point.
	//
	// quatFromBasis: quaternion for the rotation matrix whose COLUMNS are the
	// given (orthonormal, right-handed) basis vectors -- i.e. q maps
	// (1,0,0)->ex, (0,1,0)->ey, (0,0,1)->ez.  Standard Shepperd's method
	// (largest-diagonal branch for numerical safety), plain JS, no libs.
	function quatFromBasis(ex,ey,ez)
	{
		var m00=ex.x,m01=ey.x,m02=ez.x;
		var m10=ex.y,m11=ey.y,m12=ez.y;
		var m20=ex.z,m21=ey.z,m22=ez.z;
		var t=m00+m11+m22,s;
		if(0<t)
		{
			s=Math.sqrt(t+1)*2;
			return {x:(m21-m12)/s,y:(m02-m20)/s,z:(m10-m01)/s,w:0.25*s};
		}
		if(m00>m11 && m00>m22)
		{
			s=Math.sqrt(1+m00-m11-m22)*2;
			return {x:0.25*s,y:(m01+m10)/s,z:(m02+m20)/s,w:(m21-m12)/s};
		}
		if(m11>m22)
		{
			s=Math.sqrt(1+m11-m00-m22)*2;
			return {x:(m01+m10)/s,y:0.25*s,z:(m12+m21)/s,w:(m02-m20)/s};
		}
		s=Math.sqrt(1+m22-m00-m11)*2;
		return {x:(m02+m20)/s,y:(m12+m21)/s,z:0.25*s,w:(m10-m01)/s};
	}

	// The synthetic anchor orientation: chosen so that after the ENGINE's
	// fixed grip-basis mapping (fssimulation.cpp's hand-prop block reads
	// fwd_model=q*(0,-1,0), up_model=q*(0,0,-1), then the WebXR->engine
	// z-negation), the console stands UPRIGHT and FACES the pilot:
	//   up_model  = reference-space up (0,1,0), and
	//   fwd_model = h, the horizontal unit vector from the grab point AWAY
	//               from the pilot's head at grab time (grip -Y points
	//               roughly away from the face in a natural hold, so this
	//               reproduces the pre-anchor facing).
	// Solving q*(0,-1,0)=h and q*(0,0,-1)=(0,1,0) gives the rotation matrix
	// columns ex=(-h.z,0,h.x), ey=(-h.x,0,-h.z), ez=(0,-1,0) (right-handed:
	// ey x ez == ex).  Degenerate case (grip on the head's vertical axis, no
	// horizontal offset): fall back to the viewer's own horizontal facing,
	// then to reference -Z.
	function handPropAnchorQuat(gripPos,viewerPos,viewerQuat)
	{
		var hx=gripPos.x-viewerPos.x,hz=gripPos.z-viewerPos.z;
		var len=Math.sqrt(hx*hx+hz*hz);
		if(len<1e-4)
		{
			var f=rotateVecByQuat({x:0,y:0,z:-1},viewerQuat);
			hx=f.x; hz=f.z;
			len=Math.sqrt(hx*hx+hz*hz);
			if(len<1e-4)
			{
				hx=0; hz=-1; len=1;
			}
		}
		hx/=len; hz/=len;
		return quatFromBasis({x:-hz,y:0,z:hx},{x:-hx,y:0,z:-hz},{x:0,y:-1,z:0});
	}

	// Per-frame anchor bookkeeping for one hand.  Returns the anchor to feed
	// writeHandPoseBlock while grabbed (a {pos,quat} in REFERENCE space), or
	// null while not grabbed (the caller then passes the live grip pose
	// through unchanged -- the block's pose slots keep their established
	// hold-last-value behaviour on release, and the engine's grabbed gates
	// hide the prop anyway).
	function updateHandPropAnchor(hand,gripPos,viewerPos,viewerQuat,grabbed)
	{
		if(!grabbed)
		{
			vr.ctl.propAnchor[hand]=null;
			return null;
		}
		var a=vr.ctl.propAnchor[hand];
		if(!a)
		{
			a={
				pos:{x:gripPos.x,y:gripPos.y,z:gripPos.z},
				quat:handPropAnchorQuat(gripPos,viewerPos,viewerQuat)
			};
			vr.ctl.propAnchor[hand]=a;
		}
		return a;
	}

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
		// Layers created with space:vr.refSpace keep a reference to the OLD
		// offset-space OBJECT -- the reassignment above does not follow.
		// Left stale, every world-anchored layer renders displaced by
		// exactly the recenter delta while ray/controller math uses the new
		// space (on-device symptom: menu-ray hits landing offset from where
		// the controller points after a recenter).  Re-point them all.
		var rebind=[
			vr.menuRes&&vr.menuRes.quad,
			vr.cursorRes&&vr.cursorRes.quad,
			vr.skyRes&&vr.skyRes.layer,
			vr.helpRes.right&&vr.helpRes.right.quad,
			vr.helpRes.left&&vr.helpRes.left.quad,
			vr.beamRes&&vr.beamRes.right&&vr.beamRes.right.quad,
			vr.beamRes&&vr.beamRes.left&&vr.beamRes.left.quad
		];
		for(var ri=0; ri<rebind.length; ++ri)
		{
			if(rebind[ri])
			{
				try{ rebind[ri].space=vr.refSpace; }catch(e){}
			}
		}
		// If the menu is currently showing, clear the anchor so it re-
		// positions relative to the new refSpace on the very next frame.
		if(vr.menuRes&&vr.menuRes.inLayers)
		{
			vr.menuAnchor=null;
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
	var DIAL_SELECT_THRESHOLD=0.5;
	var DIAL_HYSTERESIS_DEG=6;  // Extra angle past a sector boundary before the pick switches (anti-flicker).  // magnitude to (re)pick a sector.
	var DIAL_VISIBLE_THRESHOLD=0.3; // magnitude to fade the dial layer in.
	var DIAL_HIDE_DELAY_MS=1200;    // time after re-centring before it hides.
	// Shared N-way sector pick: quantizes the stick angle (x,upY already in
	// plain screen terms, see updateDialStick's doc comment) to sectorN even
	// wedges -- sector i's centre is at i*(360/sectorN) degrees clockwise
	// from up (0deg=up, matching Canvas/atan2 convention: 0deg=up (x=0,
	// upY=1), 90deg=right, +-180deg=down, -90deg=left) -- and writes the
	// result into dial[field] (either 'sel', the normal fixed-table pick, or
	// 'guiSel', the GUI-guide's dynamic-N pick; see updateDialStick below).
	// Boundary hysteresis: keeps the current sector until the stick points
	// DIAL_HYSTERESIS_DEG past the shared boundary, so aiming near a
	// boundary doesn't flicker (and buzz) between two sectors. Sweeping the
	// stick around the rim still re-selects continuously, sector by sector.
	// A haptic pulse fires on every actual sector change (used by both the
	// normal dial and the GUI guide -- see their respective doc comments).
	function pickDialSector(dial,field,x,upY,sectorN,rawSrc)
	{
		var deg=Math.atan2(x,upY)*180/Math.PI;
		if(deg<0)
		{
			deg+=360;
		}
		var idx=Math.round(deg/(360/sectorN))%sectorN;
		var cur=dial[field];
		if(idx!==cur && null!=cur && cur<sectorN)
		{
			var half=180/sectorN;
			var curCen=cur*(360/sectorN);
			var away=Math.abs(((deg-curCen)%360+540)%360-180);
			if(away<=half+DIAL_HYSTERESIS_DEG)
			{
				idx=cur;
			}
		}
		if(idx!==cur)
		{
			dial[field]=idx;
			vrHapticPulse(rawSrc);
		}
	}
	// Which sticky-selection FIELD a dial's own highlight actually depends on
	// right now: dial.guiSel while a GUI-guide face is showing (guiMode
	// truthy -- drawGuiDialGuide reads dial.guiSel directly, see its own
	// doc comment), dial.sel for the normal fixed-function face otherwise
	// (drawDial's own 'sel' parameter). Used by updateDialLayers's redraw
	// gate below so the per-hand quad canvas actually re-uploads when the
	// GUI-guide's pointed sector changes -- bug fix: the gate used to
	// compare dial.sel unconditionally even while guiMode was set, but
	// updateDialStick never touches dial.sel while routing picks into
	// dial.guiSel (see its own doc comment) -- so dial.sel sat frozen at
	// whatever it was before the dialog opened, the gate's inequality check
	// never tripped again after the guiMode-change redraw that opened the
	// dialog, and the on-quad highlight silently stopped tracking the stick
	// for the rest of that dialog session (the AP-menu field report this
	// fixes: "no pointing highlight at all"). Exposed as vr.dialRedrawKey
	// purely for scripts/smoke-vrgui.mjs, which cannot reach the real
	// quad-layer path headless (vr.mvBinding requires a genuine WebXR
	// session) but can still assert this exact decision tracks guiSel.
	function dialRedrawKey(dial,guiMode)
	{
		return (guiMode ? dial.guiSel : dial.sel);
	}
	// sectorN: this hand's NORMAL flight-function dial's sector count
	// (RIGHT_DIAL.length/LEFT_DIAL.length, 6 today -- the caller passes the
	// table length; see processControllerPlain's call sites), quantized via
	// pickDialSector into dial.sel (a numeric 0..sectorN-1 index). Also runs
	// (harmlessly) while the generic/ESC GUI-guide face is showing, since
	// that face's uniform "every sector = ESC" dispatch doesn't key off sel
	// at all -- see vr.ctl.dial's doc comment. guiSectorN: 0/undefined
	// leaves the GUI-guide's pick untouched this call; a positive integer
	// instead runs that SAME pickDialSector helper into dial.guiSel (a
	// numeric 0..guiSectorN-1 sector index -- see guiDialEngagedFor/
	// drawGuiDialGuide), quantized to guiSectorN even wedges instead of the
	// fixed table's sectorN. Kept as two entirely separate fields (not one
	// field reused for both) so a dialog closing can never leave the normal
	// dial holding a stale numeric value picked under a different N -- see
	// vr.ctl.dial's doc comment.
	function updateDialStick(dial,thumb,rawSrc,sectorN,guiSectorN)
	{
		var x=(thumb ? thumb[0] : 0)||0;
		var upY=(thumb ? -thumb[1] : 0)||0;
		var mag=Math.sqrt(x*x+upY*upY);
		var now=(typeof performance!=='undefined' ? performance.now() : Date.now());
		// Bug fix (stale highlight on re-deflection), round 2: EVERY fresh
		// deflection from center is a fresh gesture, so on the RISING edge
		// of (mag > DIAL_SELECT_THRESHOLD) -- tracked in dial.picking, set
		// false whenever mag is at/below the threshold -- clear the
		// remembered sector before the pick, so it starts fresh from the
		// CURRENT stick angle with no hysteresis bias toward wherever the
		// stick pointed during the PREVIOUS gesture (see pickDialSector:
		// cur==null skips the hysteresis branch entirely and just takes the
		// freshly computed idx).  Hysteresis exists solely to stop
		// boundary-flicker WITHIN one continuous deflection; it must never
		// arbitrate ACROSS gestures.  Round 1 of this fix cleared only when
		// the dial had gone fully INVISIBLE first -- but dial.visible
		// lingers for DIAL_HIDE_DELAY_MS (1200 ms) after return-to-rest
		// (the fade timer below), and the on-device gesture re-deflects
		// well inside that window, so nothing cleared and the old sector's
		// band still won (the "stale highlight STILL reproduces" field
		// report).  The threshold edge has no such latency.  Note this also
		// clears when a swing from one sector to the opposite one passes
		// THROUGH the center (mag dips below the threshold mid-swing):
		// correct and desirable -- the moment the stick re-emerges it
		// points somewhere definite, and that pick should win immediately.
		// Only the field THIS gesture routes into is cleared (not both):
		// the pick that immediately follows repopulates it within this same
		// call, so null never outlives the function -- whereas clearing the
		// OTHER face's field would leave it null across a dialog interlude
		// and break its sticky-selection contract (e.g. rdial.sel=null
		// would kill the trigger's fire-last-selected/default-Gun dispatch,
		// RIGHT_DIAL[rdial.sel], until the next normal-face gesture).
		if(DIAL_SELECT_THRESHOLD<mag)
		{
			var pickField=(guiSectorN ? 'guiSel' : 'sel');
			if(!dial.picking)
			{
				dial.picking=true;
				dial[pickField]=null;
			}
			pickDialSector(dial,pickField,x,upY,(guiSectorN ? guiSectorN : sectorN),rawSrc);
		}
		else
		{
			dial.picking=false;
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
	// Toggled by holding the LEFT hand's X button for >=A_RECENTER_MS (see
	// processControllerPlain's left-hand branch and vr.ctl.xBtn) -- once per
	// hold, mirroring the right hand's A long-press recenter. A manual show
	// (toggling back on) disarms the auto-hide timer (shownAt=0) -- only the
	// initial auto-show times out on its own; once the pilot has explicitly
	// asked to see it again it stays up until toggled off.
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
		// True while the main-menu quad is being shown: B/Y dispatch ESC so the
		// pilot can navigate back, and flight-control inputs (stick/throttle/
		// trigger/dial) are suppressed -- the menu uses ray-to-mouse injection
		// instead (see processMenuRayInput/YsfwInjectMouseEvent).
		var menuVisible=!!(vr.menuRes&&vr.menuRes.inLayers);
		// Menu routing MUST run before either hand's normal flight branch.  The
		// old right-hand path did not test menuVisible until after its stick,
		// dial and trigger logic.  A right trigger therefore injected BOTH the
		// ray's mouse click and RIGHT_DIAL's default Space key; in the flight-
		// setup GUI that Space activated the keyboard-focused Formation button
		// instead of the Aircraft button under the ray.  The left-hand branch
		// happened to test menuVisible before its dial/trigger, producing the
		// observed asymmetric behaviour.  Consume both hands symmetrically here
		// and return before ANY flight-control action can leak into the menu.
		if(menuVisible)
		{
			var menuTriggerPressed=entry.trigger>TRIGGER_THRESHOLD;
			if('right'===entry.hand)
			{
				// Release any state that may have been active before returning to
				// the menu, but do not turn a menu grip/trigger into a flight input.
				HEAPF32[ptr+0]=0;
				HEAPF32[ptr+1]=0;
				HEAPF32[ptr+2]=0;
				HEAPF32[ptr+3]=0;
				vr.ctl.stick.grabbed=false;
				vr.ctl.stick.q0=null;
				vr.ctl.propAnchor.right=null;
				var menuRightDial=vr.ctl.dial.right;
				if(menuRightDial.engaged && 'hold'===menuRightDial.engaged.mode)
				{
					vrKeyEdge(menuRightDial.engaged.code,false);
				}
				menuRightDial.engaged=null;
				vr.ctl.rightTrigger=menuTriggerPressed; // consume level, no key

				// A has no menu meaning.  Track/own its physical level so a press
				// begun in the menu cannot become a gear tap after the transition.
				var menuAPressed=!!(entry.buttons && entry.buttons.a);
				if(menuAPressed)
				{
					vr.ctl.aBtn.pressed=true;
					vr.ctl.aBtn.owned=true;
					vr.ctl.aBtn.recentered=true; // suppress hold action too
				}
				else
				{
					vr.ctl.aBtn.pressed=false;
					vr.ctl.aBtn.owned=false;
					vr.ctl.aBtn.recentered=false;
				}

				// B remains the explicit go-back action while the menu is visible.
				var menuBPressed=!!(entry.buttons && entry.buttons.b);
				vrKeyEdge('KeyB',false);
				if(menuBPressed && !vr.ctl.rightB)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap('Escape');
				}
				vr.ctl.rightB=menuBPressed;
				vr.ctl.rightBSwallow=menuBPressed;
			}
			else if('left'===entry.hand)
			{
				HEAPF32[ptr+4]=0;
				vr.ctl.thr.grabbed=false;
				vr.ctl.thr.p0=null;
				vr.ctl.thr.fwd0=null;
				vr.ctl.propAnchor.left=null;
				var menuLeftDial=vr.ctl.dial.left;
				if(menuLeftDial.engaged && 'hold'===menuLeftDial.engaged.mode)
				{
					vrKeyEdge(menuLeftDial.engaged.code,false);
				}
				menuLeftDial.engaged=null;
				vr.ctl.leftTrigger=menuTriggerPressed; // consume level, no key

				// X likewise has no menu meaning; consume it without toggling help.
				var menuXPressed=!!(entry.buttons && entry.buttons.a);
				if(menuXPressed)
				{
					vr.ctl.xBtn.pressed=true;
					vr.ctl.xBtn.owned=true;
					vr.ctl.xBtn.helped=true; // suppress hold action too
				}
				else
				{
					vr.ctl.xBtn.pressed=false;
					vr.ctl.xBtn.owned=false;
					vr.ctl.xBtn.helped=false;
				}

				// Y mirrors B as the left-hand go-back action.
				var menuYPressed=!!(entry.buttons && entry.buttons.b);
				if(menuYPressed && !vr.ctl.leftY)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap('Escape');
				}
				vr.ctl.leftY=menuYPressed;
				vr.ctl.leftYSwallow=menuYPressed;
			}
			return;
		}

		// [7] is a level-sensed "either XR trigger" confirmation input for
		// FsCenterJoystick's pre-flight screen.  updateControllers (or the
		// headless poke hook) clears it once at the start of each whole frame;
		// individual hand calls only OR a press into it.  Menu triggers return
		// above so a click that launches a flight cannot bleed into this slot.
		if(entry.trigger>TRIGGER_THRESHOLD)
		{
			HEAPF32[ptr+7]=1;
		}
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
			// Fresh dialog: always start the N-way guide pointed at sector 0
			// (the first real option) regardless of whichever sector a
			// PREVIOUS, differently-sized dialog last left guiSel on -- a
			// smaller menu closing and a bigger one opening right after must
			// not silently inherit an out-of-range or misleading index.
			vr.ctl.dial.right.guiSel=0;
			vr.ctl.dial.left.guiSel=0;
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
				// Self-centering on release.  NOTE these zeros alone cannot do
				// it: [0] flips to 0 in the same write, so the engine's
				// grabbed-branch never consumes them (it reads [1..3] only
				// while [0] is 1).  The real spring-to-neutral is the engine's
				// stickEverGrabbed branch (fsvr.h [8], set while grabbed
				// above): it centers aileron/elevator/rudder on every
				// non-grabbed frame.  The zeros stay for block cleanliness.
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
				// stickEverGrabbed latch (fsvr.h [8], the stick counterpart
				// of throttle's [6]): once set, the engine centers the three
				// axes on every non-grabbed frame, so releasing the grab
				// really springs the stick to neutral instead of freezing
				// the last deflection (the release-edge zeros above land on
				// the same frame [0] flips to 0 and are never consumed).
				HEAPF32[ptr+8]=1;
			}

			var rdial=vr.ctl.dial.right;
			// guiMenu (computeGuiMenuLayout) reads the engine's REAL
			// option-label list (fsvr.h's FsVrGuiMenuPointer) and is exposed
			// on rdial.guiMenu for the guide to draw from and for
			// inspection/tests, so the guide can never promise a mapping
			// that either doesn't exist or the router doesn't actually
			// implement: guiMode is 'ap' when guiMenu.drivable (the
			// per-option positional Digit hotkeys are live AND there is at
			// least one real option to label them with), 'generic' otherwise
			// (only the Escape reroutes are trustworthy). Computed BEFORE
			// updateDialStick below (not after, as it once was) because the
			// N-way GUI-guide pick needs to know N=guiMenu.options.length
			// this same call.
			var guiMenu=(rActive ? computeGuiMenuLayout(guiState.apMenu) : null);
			var guiSectorN=(guiMenu && guiMenu.drivable) ? guiMenu.options.length : 0;
			// Sector-selection bookkeeping (haptic-on-change, visibility/fade
			// timer) runs unconditionally -- it is harmless bystander state
			// when the OTHER hand owns an open dialog. guiSectorN>0 routes
			// this call to the N-way GUI-guide pick (rdial.guiSel) instead of
			// the normal fixed-table one (rdial.sel, RIGHT_DIAL.length
			// sectors) -- see updateDialStick's doc comment; the SAME
			// underlying stick geometry and pickDialSector helper drive both.
			updateDialStick(rdial,entry.thumb,rawSrc,RIGHT_DIAL.length,guiSectorN);

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
			// dialog existed.
			rdial.guiMenu=guiMenu;
			rdial.guiMode=(!guiMenu ? null : (guiMenu.drivable ? 'ap' : 'generic'));
			if(rActive)
			{
				// Forced visibility is now DRIVABLE-ONLY: the N-way face is
				// the sole way to discover a dialog's real options, so it must
				// appear unprompted. The generic/ESC face labels nothing (every
				// sector fires the same Escape), and the dialogs that get it
				// (replay/continue/stationary/vehicle-change/chat) are either
				// long-lived overlays a pilot mostly WATCHES (replay) or
				// auto-shown parked-state info (stationary) -- forcing a
				// 4-spoke "ESC" cluster into view for their whole lifetime
				// read as noise on device. The reroute itself is unchanged
				// (sector tap still fires Escape); flicking the thumbstick
				// shows the ESC face via the normal engagement rule, and the
				// forced panel below carries the dialog's actual content.
				if(guiMenu && guiMenu.drivable)
				{
					rdial.visible=true;
				}
				// GUI_DIAL_CAPACITY sectors cannot reach every option
				// (radio-comm's wingman-command menu is exactly at the cap,
				// see FsGuiRadioCommCommandDialog), and some in-flight
				// dialogs are not hotkey-driven at all
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
					rdial.engaged=guiDialEngagedFor(guiMenu,rdial.guiSel);
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
			// owns an open dialog (rActive), the tap is simply parked --
			// no gear drop from a mid-dialog fumble, and no dialog meaning
			// either (the N-way sectors already reach every real option;
			// cancel is B, see below). Recenter is left enabled either way
			// -- it is a view-only action, not a flight or dialog control.
			var aPressed=!!(entry.buttons && entry.buttons.a);
			var aBtn=vr.ctl.aBtn;
			var aNow=(typeof performance!=='undefined' ? performance.now() : Date.now());
			if(aPressed && !aBtn.pressed)
			{
				aBtn.pressAt=aNow;
				aBtn.recentered=false;
				aBtn.owned=false;
			}
			if(aPressed && rActive)
			{
				aBtn.owned=true; // see aBtn's doc comment: no tap on release.
			}
			if(aPressed && !aBtn.recentered && (aNow-aBtn.pressAt)>=A_RECENTER_MS)
			{
				vrRecenter();
				aBtn.recentered=true;
			}
			if(!aPressed && aBtn.pressed && !aBtn.recentered && (aNow-aBtn.pressAt)<A_TAP_MAX_MS)
			{
				if(!rActive && !aBtn.owned)
				{
					vrKeyTap('KeyG'); // Default landing-gear key: a real tap, not a hold.
				}
			}
			aBtn.pressed=aPressed;

			// Right B: normally a held spoiler/air-brake key; while THIS hand
			// owns an open dialog, B is instead the truthful cancel/Escape
			// binding (GUI_ESCAPE_ACTION is the one input confirmed safe for
			// ANY open dialog -- see its doc comment), fired on the press
			// edge -- the ONE input the owner hand has spare regardless of
			// how many of the N sectors + trigger the currently-open
			// dialog's real options occupy, so a pilot can always back out
			// of a dialog without touching the other (fully normal) hand at
			// all (see drawGuiDialGuide's on-quad label for this) -- plus a
			// release-if-held safety so a brake held from before the dialog
			// opened doesn't stay stuck on.
			var bPressed=!!(entry.buttons && entry.buttons.b);
			if(rActive && bPressed)
			{
				// This press overlapped dialog ownership (the cancel press
				// itself, or a brake held from before the dialog opened) --
				// swallow it from the normal path until physical release,
				// or the Escape below closes the dialog and the very next
				// frame's !rActive path would toggle the air brake off the
				// still-held button (see vr.ctl.rightBSwallow's doc
				// comment).
				vr.ctl.rightBSwallow=true;
			}
			if(!rActive)
			{
				vrKeyEdge('KeyB',bPressed && !vr.ctl.rightBSwallow); // Default spoiler/air-brake key.
			}
			else
			{
				vrKeyEdge('KeyB',false); // Release it if it was held from before the dialog opened.
				if(bPressed && !vr.ctl.rightB)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap('Escape');
				}
			}
			if(!bPressed)
			{
				vr.ctl.rightBSwallow=false;
			}
			vr.ctl.rightB=bPressed;
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

			// Left X: same press/hold/release bookkeeping as the right
			// hand's A (see A_TAP_MAX_MS/A_RECENTER_MS above, vr.ctl.xBtn),
			// but X drives only ONE action now: held >=A_RECENTER_MS toggles
			// the help placards (toggleHelp), once per hold. X no longer has
			// a quick-tap action at all -- it used to quick-tap the view
			// toggle, but that fought the help long-press on the same
			// button (a quick pilot glance at "which view am I in" could
			// accidentally eat the start of a help-toggle hold, and vice
			// versa) and needed a whole separate `outside` toggle-state field
			// to track F1-vs-F2. View control now lives entirely on left Y
			// below, a plain single-purpose tap. Flaps-down (X's meaning
			// before the view toggle ever existed) still lives on the left
			// dial's Flap- sector, so no function is lost.
			var xPressed=!!(entry.buttons && entry.buttons.a);
			var xBtn=vr.ctl.xBtn;
			var xNow=(typeof performance!=='undefined' ? performance.now() : Date.now());
			if(xPressed && !xBtn.pressed)
			{
				xBtn.pressAt=xNow;
				xBtn.helped=false;
				xBtn.owned=false;
			}
			if(xPressed && lActive)
			{
				xBtn.owned=true;
			}
			if(xPressed && !xBtn.helped && (xNow-xBtn.pressAt)>=A_RECENTER_MS)
			{
				toggleHelp(rawSrc);
				xBtn.helped=true;
			}
			xBtn.pressed=xPressed;

			// Left Y: view-cycle tap outside dialogs (Fix for the Quest 3S
			// field report that the OLD X-tap view toggle only ever
			// alternated cockpit<->ONE external view, when desktop F2
			// actually cycles through FIVE distinct external views --
			// FSOUTSIDEPLAYERPLANE/FSFIXEDPOINTPLAYERPLANE/
			// FSVARIABLEPOINTPLAYERPLANE/FSFROMTOPOFPLAYERPLANE/
			// FSPLAYERPLANEFROMSIDE, see FsSimulation::ViewingControl's
			// FSBTF_OUTSIDEPLAYERVIEW case). Fires on the PRESS EDGE only (a
			// held Y does not repeat-fire): reads the aircraft-state block's
			// slot [6] (fsvr.h) for where mainWindowViewmode currently sits
			// along that chain and dispatches F2 to advance it, UNLESS it is
			// already at the chain's last stop (slot6==5,
			// FSPLAYERPLANEFROMSIDE) in which case F1 returns straight to
			// the cockpit -- so N presses from cockpit view walk through
			// every external view exactly once before returning home,
			// matching the desktop F2 experience instead of a two-state
			// toggle. While THIS hand owns an open dialog, Y is instead the
			// truthful cancel/Escape binding, exactly mirroring the right
			// hand's B above -- fired on the press edge, plus the same
			// swallow-until-release latch (vr.ctl.leftYSwallow) Y always
			// used for its dialog-cancel duty: a successful Escape can close
			// the dialog out from under the still-held button, and WITHOUT
			// the latch the very next frame (lActive now false, yPressed
			// still true, but no longer a fresh edge since vr.ctl.leftY was
			// already set true by the very press that cancelled the dialog)
			// would see a non-owner press-edge check -- the latch is the
			// belt to the edge-check's suspenders, guaranteeing a
			// dialog-cancelling press can NEVER also advance the view on the
			// same or a later frame of that same physical press.
			var yPressed=!!(entry.buttons && entry.buttons.b);
			var yPressEdge=(yPressed && !vr.ctl.leftY);
			if(lActive && yPressed)
			{
				vr.ctl.leftYSwallow=true;
			}
			if(!lActive)
			{
				if(yPressEdge && !vr.ctl.leftYSwallow)
				{
					var vsPtr=_YsfwVrAircraftStateDataPointer()>>2;
					var viewCyclePos=HEAPF32[vsPtr+6];
					vrHapticPulse(rawSrc);
					vrKeyTap(5===Math.round(viewCyclePos) ? 'F1' : 'F2'); // Last external view -> cockpit (F1); otherwise advance the chain (F2).
				}
			}
			else if(yPressEdge)
			{
				vrHapticPulse(rawSrc);
				vrKeyTap('Escape');
			}
			if(!yPressed)
			{
				vr.ctl.leftYSwallow=false;
			}
			vr.ctl.leftY=yPressed;

			// Left trigger: dial-selected function (see LEFT_DIAL) when this
			// hand is NOT the dialog owner (including no dialog at all) --
			// fully normal, sticky-sector semantics as always. When lActive,
			// this becomes the dialog's own confirm input instead, exactly
			// mirroring the right dial's N-way GUI-guide routing (see
			// rActive's branch above) so the dialog is drivable from
			// WHICHEVER hand opened it.
			var ldial=vr.ctl.dial.left;
			// Symmetric to the right dial's guiMenu/guiSectorN computation
			// above: computed BEFORE updateDialStick so the N-way GUI-guide
			// pick (ldial.guiSel) knows N=guiMenuL.options.length this call.
			var guiMenuL=(lActive ? computeGuiMenuLayout(guiState.apMenu) : null);
			var guiSectorNL=(guiMenuL && guiMenuL.drivable) ? guiMenuL.options.length : 0;
			updateDialStick(ldial,entry.thumb,rawSrc,LEFT_DIAL.length,guiSectorNL);
			// Dialog-guide takeover on the left dial, symmetric to the right
			// dial's rActive branch above: only while lActive, this dial
			// becomes the dialog's selection guide (forced visible,
			// drawGuiDialGuide instead of the normal LEFT_DIAL face). When
			// the RIGHT hand owns the dialog instead, lActive is false and
			// this dial is left completely alone -- normal face, normal
			// thumbstick-engagement visibility, exactly as if no dialog
			// existed (matches the brief: "the other hand fully reverts to
			// its normal functions").
			ldial.guiMenu=guiMenuL;
			ldial.guiMode=(!guiMenuL ? null : (guiMenuL.drivable ? 'ap' : 'generic'));
			if(lActive)
			{
				// Drivable-only forced visibility, mirroring the right dial's
				// rActive branch above (see its comment): the generic/ESC face
				// follows the normal engagement rule instead of parking a
				// 4-spoke "ESC" cluster in view for the dialog's lifetime.
				if(guiMenuL && guiMenuL.drivable)
				{
					ldial.visible=true;
				}
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
					ldial.engaged=guiDialEngagedFor(guiMenuL,ldial.guiSel);
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
		}
	}

	// Real XR path: adapt each live XRInputSource + this frame's grip pose
	// into the plain shape and run it through processControllerPlain.  Only
	// called when a valid viewer pose exists this frame (see onXRFrame).
	function updateControllers(frame,pose)
	{
		var viewerQuat=pose.transform.orientation;
		var viewerPos=pose.transform.position;
		// Reset both hands' grip pose before the loop: a hand with no source
		// (or no pose) this frame leaves its entry null, telling
		// updateHelpLayers to skip that hand's placard transform update
		// rather than snapping it to a stale position.
		vr.ctl.gripPose.right=null;
		vr.ctl.gripPose.left=null;
		// Same reasoning for the right hand's hand-pose-block grabbed flag
		// (writeHandPoseBlock's [7]): a controller that loses tracking this
		// frame must not leave a stale "still grabbed" stick glued to its
		// last known position forever -- see fsvr.h's FsVrHandPoseDataPointer
		// doc comment. (The left hand has no such flag in this block -- the
		// engine gates it on FsVrControlDataPointer[4] instead, which is
		// left untouched here, matching its own existing hold-last-value
		// behaviour on release.)
		HEAPF32[(_YsfwVrHandPoseDataPointer()>>2)+7]=0;
		// Same per-frame reset for the tracked flags (control block [9]/[10],
		// fsvr.h): they gate the engine's ungrabbed controller-model draw, and
		// a hand whose source (or grip pose) is gone this frame must read as
		// absent, not as its stale last-written pose.  Re-set below for every
		// hand that actually delivers a grip pose this frame.
		var ctlFlagsPtr=_YsfwVrControlDataPointer()>>2;
		HEAPF32[ctlFlagsPtr+9]=0;
		HEAPF32[ctlFlagsPtr+10]=0;
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
					// xr-standard buttons[3] = thumbstick click -- INERT.
					// processControllerPlain no longer reads this at all
					// (pressing the stick physically jolts it, awkward in
					// VR); kept only so the plain shape stays uniform with
					// pokeControllerFrame's, which smoke tests still poke to
					// assert the no-op.
					stick:!!(gp.buttons[3] && gp.buttons[3].pressed)
				}
			},viewerQuat,src);
			// See fsvr.h's FsVrHandPoseDataPointer doc comment: written AFTER
			// processControllerPlain so st.grabbed/th.grabbed (set
			// synchronously inside it) reflect this frame's effective grab
			// (physical squeeze OR sticky latch) by the time we read it here.
			// While grabbed, the block carries the frozen ANCHOR console
			// pose (grab-start point, synthetic upright orientation --
			// see updateHandPropAnchor), not the live grip pose: the
			// console stays put and only its articulated rod/lever follows
			// the hand, via the live control deflections.
			var grabbedNow=('right'===hand ? vr.ctl.stick.grabbed : vr.ctl.thr.grabbed);
			var anchor=updateHandPropAnchor(hand,gpos,viewerPos,viewerQuat,grabbedNow);
			writeHandPoseBlock(hand,(anchor ? anchor.pos : gpos),(anchor ? anchor.quat : gori),viewerPos,viewerQuat,grabbedNow);
			// This hand delivered a grip pose this frame: raise its tracked
			// flag (zeroed at the top of updateControllers) so the engine
			// may draw the controller model at the live pose just written.
			HEAPF32[ctlFlagsPtr+('right'===hand ? 9 : 10)]=1;
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
	// Canvas-space angle (0deg=east/+x, 90deg=south/+y, clockwise, matching
	// CanvasRenderingContext2D.arc's convention) for each of the 4 CARDINAL
	// direction keys -- "up" is drawn at the top of the texture (-90deg).
	// Only the generic/ESC GUI-guide face (drawGuiDialGuide's fixed
	// GUI_GUIDE_SECTORS spokes) uses this any more: the normal dial
	// (drawDial) and the drivable GUI-guide's N-way face both compute their
	// own sector angles directly as -90+i*(360/N) (i, N numeric), matching
	// updateDialStick's pick -- see their own comments.
	var DIAL_SECTOR_CANVAS_DEG={up:-90,right:0,down:90,left:180};
	// Per-hand dial canvas/quad-layer texture resolution, in px (square).
	// Raised from the original 256 to 384 (2026-07 radial-label redesign):
	// the GUI guide draws FULL option text (not clipped to ~5-9 chars)
	// rotated along each sector's spoke, so crisp small text at the outer
	// radius matters far more than it did for the old fixed-wedge normal
	// dial labels; the normal dial face was subsequently brought onto the
	// SAME radial-spoke-label design (drawDial) and now shares this exact
	// 384px baseline (k=w/384 in both). 384 is still a trivial per-frame
	// 2D-canvas-plus-texSubImage2D cost (same code path as the old 256,
	// just more texels) and the physical quad size (ensureDialResources's
	// width/height:0.12, unchanged) stays the same, so this is
	// resolution-only, not layout. drawDial/drawGuiDialGuide/
	// ensureDialResources/dumpDialLayer all derive their w/h/cx/cy/rOuter
	// from the ACTUAL canvas size (ctx.canvas.width), not this constant
	// directly, so both faces' proportions are bit-for-bit the same design
	// regardless of canvas support/fallback size.
	var DIAL_CANVAS_PX=384;

	// Live aircraft-state readouts on the normal dial face (fsvr.h /
	// FsVrAircraftStateDataPointer): the pre-redesign face keyed these off
	// the fixed up/right/down/left slots (gear/brake lines under those
	// sectors) plus a centre-hub weapon/flap readout. The transparent-radial
	// redesign has no fixed slots and no hub, so the state is now keyed off
	// each table ENTRY's key code instead (dialEntryStateText below) and
	// drawn as a second, dimmer span chained outward along that entry's own
	// spoke -- position-independent, so RIGHT_DIAL/LEFT_DIAL can be
	// reordered freely without touching this. The weapon readout rides the
	// weapon-select (Digit2) spoke now that there is no hub.
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
	// Live-state text for one dial-table entry, keyed off entry.code (NOT a
	// sector position): KeyG = gear UP/DOWN or transitional %, KeyB = brake
	// ON/OFF (KeyB toggles ctlBrake+ctlSpoiler together, see fsvr.h), KeyR/
	// KeyF = current flap % (either flap sector tells the pilot where the
	// flaps already are), Digit2 = selected weapon short-name + remaining
	// count. null = this entry has no live state to show.
	function dialEntryStateText(entry,state)
	{
		if(!state || !state.valid)
		{
			return null;
		}
		switch(entry.code)
		{
		case 'KeyG':
			if(state.gear<=0.02){ return 'UP'; }
			if(state.gear>=0.98){ return 'DOWN'; }
			return fmtPct(state.gear);
		case 'KeyB':
			return state.brake>=0.5 ? 'ON' : 'OFF';
		case 'KeyR':
		case 'KeyF':
			return fmtPct(state.flap);
		case 'Digit2':
			return weaponLabel(state.wpnType)+' '+Math.max(0,Math.round(state.wpnCount));
		case 'Escape':
			// The press-twice grammar of the 終了 sector (first ESC closes
			// any submenu, the second consecutive one leaves the flight).
			return '×2';
		}
		return null;
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
	//                real option. Like the normal RIGHT_DIAL/LEFT_DIAL face
	//                (a fixed table, N=6 sectors today), this is ALSO N-WAY,
	//                but N is DYNAMIC here: one wedge per real option
	//                (N=guiMenu.options.length, up to GUI_DIAL_CAPACITY=8),
	//                evenly dividing the circle starting at up (12 o'clock)
	//                and going clockwise --
	//                sector i is guiMenu.options[i], labelled with its own
	//                parsed hotkey digit and option text (see
	//                guiDialEngagedFor/hotkeyCode for the matching dispatch
	//                math in processControllerPlain, and updateDialStick for
	//                the matching stick-angle pick). The currently
	//                stick-selected sector (dial.guiSel) is highlighted so
	//                the pilot can confirm a pick before pulling the
	//                trigger, mirroring the normal dial's own
	//                (dir===sel)-highlight (see drawDial below). The cancel
	//                binding (the owner hand's B/Y press, unconditional on
	//                rActive/lActive) is re-stated on a single small corner
	//                hint line; if the dialog has MORE
	//                real options than GUI_DIAL_CAPACITY (guiMenu.overflow
	//                -- e.g. radio-comm's wingman-command menu sits exactly
	//                at the 8-option cap, so only a 9th+ option would ever
	//                overflow), that same line also points at the on-quad
	//                panel (forced on, see maybeForceGuiPanel). The owner
	//                hand's A (X on the left) does nothing during a dialog
	//                (parked -- see processControllerPlain); B/Y's cancel
	//                meaning is what the corner hint line above already
	//                documents, so there is nothing else to remind about and
	//                no centre hub any more -- the middle of the guide stays
	//                fully transparent. Full option text
	//                (not a clipped
	//                few characters) is drawn RADIALLY along each sector's
	//                spoke (see drawSpokeSpan/fitSpokeLabel below), so
	//                legibility degrades much more gracefully as N grows
	//                past ~6 than the old horizontal-clipped-text-in-a-
	//                wedge layout did -- font size only shrinks (down to a
	//                12px*canvasScale floor) as a LAST resort before finally
	//                ellipsizing; scripts/smoke-vrgui.mjs dumps a PNG of an
	//                N>4 guide for a human to judge.
	//   'generic' -- !guiMenu.drivable: either the open dialog is not
	//                hotkey-driven at all (replay/continue/stationary/
	//                vehicle-change/chat dialogs -- mouse-only), or (rare)
	//                the engine reported apMenu but zero parseable options.
	//                This face stays the ORIGINAL fixed 4-sector uniform
	//                "ESC" look (not N-way -- there is no per-option content
	//                to divide sectors by), matching that every sector
	//                dispatches the exact same GUI_ESCAPE_ACTION tap
	//                (see rdial/ldial's engaged assignment above). The
	//                on-quad panel is forced on here too, so the dialog's
	//                real content (however many options it has) is still
	//                readable even though the dial can't drive it.
	// The OTHER (non-owner) hand never reaches this function at all -- its
	// guiMode stays null and it keeps drawing its own normal dial face, see
	// drawDial below.
	//
	// ---- Fully-transparent, radial-label redesign (2026-07) ----------------
	// Replaces the old opaque-wedge-fill + horizontally-clipped-text look
	// (e.g. "Brea…" for "Break and Attack") with: NO outer circle, NO wedge
	// fill, NO wedge borders, NO centre hub -- only floating text (plus thin
	// per-sector tick marks and one small corner hint line) over whatever
	// the pilot is actually looking at. Every option's FULL label text is drawn ROTATED to run
	// outward along its own sector's spoke (see drawSpokeSpan), which is
	// what makes room for the full text instead of a handful of clipped
	// characters: a spoke's usable length is far greater than a wedge's
	// horizontal chord ever was.
	//
	// Upside-down prevention (drawSpokeSpan's `flip`): a span rotated by
	// its sector's canvas angle (centerRad) reads fine -- at worst sideways,
	// comfortable with a slight head tilt -- as long as the spoke's
	// on-canvas X-direction is non-negative (Math.cos(centerRad)>=0, i.e.
	// the spoke points into the canvas-RIGHT half). Past that (the spoke's
	// direction has crossed more than +-90deg off upright, into the
	// canvas-LEFT half, Math.cos(centerRad)<0) an unflipped span would
	// render fully upside-down and mirrored. For exactly those sectors,
	// drawSpokeSpan rotates an EXTRA 180deg (folding the effective on-screen
	// rotation back into the readable +-90deg range) and right-aligns the
	// text instead of left-aligning it, so it still visually starts near
	// the hub and grows outward -- every label ends up readable without the
	// viewer ever needing to tilt their head past +-90deg.
	var GUI_GUIDE_SECTORS=['up','right','down','left'];
	// Shrinks `text`'s font (bold sans-serif) from startPx down to floorPx
	// (1px steps) until it fits maxWidth; if even the floor size overflows,
	// ellipsizes at the floor size as a last resort (fit-then-shrink-then-
	// ellipsize, in that priority order -- see this function's callers).
	// ctx.font/measureText are unaffected by the current transform (translate/
	// rotate), so this is safe to call before drawSpokeSpan's save/rotate.
	function fitSpokeLabel(ctx,text,maxWidth,startPx,floorPx)
	{
		text=text||'';
		var fontPx=startPx;
		ctx.font='bold '+fontPx+'px sans-serif';
		while(floorPx<fontPx && maxWidth<ctx.measureText(text).width)
		{
			fontPx-=1;
			ctx.font='bold '+fontPx+'px sans-serif';
		}
		if(maxWidth>=ctx.measureText(text).width)
		{
			return {text:text,fontPx:fontPx};
		}
		var t=text;
		while(1<t.length && maxWidth<ctx.measureText(t+'…').width)
		{
			t=t.slice(0,-1);
		}
		return {text:t+'…',fontPx:fontPx};
	}
	// Draws `text` along the spoke at canvas angle `centerRad`, treating `r`
	// as a physical (always-positive, hub-to-rim) starting radius and
	// returning the physical radius immediately past what was just drawn --
	// so callers can chain multiple spans (a hotkey digit, then the option
	// text) outward along the same spoke without having to reason about the
	// upside-down `flip` themselves (see this function's doc comment on
	// drawGuiDialGuide above for the flip rule). A dark stroke under the
	// bright fill keeps the label legible against both a bright sky and a
	// dark ground behind this fully-transparent canvas.
	function drawSpokeSpan(ctx,cx,cy,centerRad,flip,r,text,fontPx,fillStyle)
	{
		ctx.save();
		ctx.translate(cx,cy);
		ctx.rotate(flip ? centerRad+Math.PI : centerRad);
		ctx.font='bold '+fontPx+'px sans-serif';
		ctx.textBaseline='middle';
		ctx.textAlign=flip ? 'right' : 'left';
		var localX=flip ? -r : r;
		var width=ctx.measureText(text).width;
		ctx.lineWidth=Math.max(2,fontPx*0.22);
		ctx.strokeStyle='rgba(8,10,14,0.9)';
		ctx.strokeText(text,localX,0);
		ctx.fillStyle=fillStyle;
		ctx.fillText(text,localX,0);
		ctx.restore();
		return r+width;
	}
	function drawGuiDialGuide(ctx,guiMode,hand)
	{
		// k is relative to a 384px canvas (DIAL_CANVAS_PX) -- ALL the pixel
		// budget numbers below (hubR, tick lengths, digit/text start radii,
		// rOuter's margin from the edge) are tuned against that baseline so
		// a full-length option label actually gets the ~140px of spoke
		// length it needs; if the canvas is ever smaller (no quad-layer
		// support -- see dumpDialLayer/ensureDialResources), k<1 shrinks
		// everything proportionally rather than recomputing a second set of
		// constants. (drawDial's own k is intentionally still relative to
		// 256 -- that face's numbers were tuned for the original 256px
		// canvas and must stay bit-for-bit the same proportions.)
		var w=ctx.canvas.width,h=ctx.canvas.height,cx=w/2,cy=h/2,k=w/384;
		// rOuter reaches almost to the canvas edge -- there is no outer
		// circle/wedge border to stay inside of any more, so the old
		// 110/256=0.43 fraction would waste more than half the available
		// spoke length for nothing.
		var rOuter=w/2-10*k;
		var menu=vr.ctl.dial[hand].guiMenu; // {options,cancel,overflow,drivable} or null/stale -- see computeGuiMenuLayout.
		var options=(menu && menu.options) || [];
		// No hub disc is drawn any more (see the tail of this function), but
		// its radius lives on as the central keep-clear zone the tick marks
		// and label spans still start outside of -- the centre stays fully
		// transparent so the stick's own physical direction is the pointer.
		var hubR=28*k;
		if('ap'===guiMode && 0<options.length)
		{
			// N-way: one spoke per real option, N<=GUI_DIAL_CAPACITY (8).
			// Sector i's centre is at canvas angle -90deg (up) + i*wedge,
			// clockwise -- the SAME convention updateDialStick's N-way pick
			// quantizes the stick angle to, so the highlighted/selected
			// spoke here always matches what a trigger pull would actually
			// confirm.
			var n=options.length;
			var wedge=2*Math.PI/n;
			var selIdx=vr.ctl.dial[hand].guiSel;
			// Starting font sizes shrink a little as N grows (tighter
			// angular clearance near the hub) -- fitSpokeLabel then shrinks
			// the OPTION TEXT further per-label, down to a floor, before
			// ever ellipsizing (see drawGuiDialGuide's doc comment above).
			var numFontBase=(4>=n ? 22 : (6>=n ? 20 : 18))*k;
			var textFontStart=(4>=n ? 17 : (6>=n ? 16 : 14))*k;
			var floorFontPx=12*k;
			for(var i=0; i<n; ++i)
			{
				var centerRad=-Math.PI/2+i*wedge;
				var flip=Math.cos(centerRad)<0; // see the flip-rule doc comment above.
				var selected=(i===selIdx);
				// Thin tick mark at the sector's inner end -- minimal
				// orientation accent replacing the old wedge borders. Kept
				// SHORT (unlike the old wedge-radius-spanning border) so it
				// does not eat into the label's radius budget -- the tick
				// is purely an orientation cue, not a boundary. Always
				// drawn along the TRUE outward direction (never flipped):
				// only TEXT readability needs the 180deg fold, the geometry
				// itself is fine either way.
				var tickInnerR=hubR+3*k, tickOuterR=selected ? hubR+13*k : hubR+7*k;
				ctx.save();
				ctx.translate(cx,cy);
				ctx.rotate(centerRad);
				ctx.beginPath();
				ctx.moveTo(tickInnerR,0);
				ctx.lineTo(tickOuterR,0);
				ctx.lineWidth=(selected ? 3 : 1.5)*k;
				ctx.strokeStyle=selected ? 'rgba(255,214,64,0.95)' : 'rgba(230,237,243,0.55)';
				ctx.stroke();
				// digitStartR: where the hotkey digit begins. Chained off
				// THIS sector's own tickOuterR (with a bigger gap when
				// selected, since the arrowhead below reaches a bit further
				// than the plain tick) so the arrowhead can never overlap
				// the digit even though selected/unselected ticks differ.
				var digitStartR=tickOuterR+(selected ? 9*k : 5*k);
				if(selected)
				{
					// Selection accent: a small arrowhead beyond the tick,
					// since there is no wedge fill left to highlight with.
					// Sized to stay clear of digitStartR above.
					var apexR=tickOuterR+6*k;
					ctx.beginPath();
					ctx.moveTo(apexR,0);
					ctx.lineTo(apexR-5*k,-4*k);
					ctx.lineTo(apexR-5*k,4*k);
					ctx.closePath();
					ctx.fillStyle='rgba(255,214,64,0.95)';
					ctx.fill();
				}
				ctx.restore();
				var opt=options[i];
				var digitFontPx=selected ? numFontBase+3*k : numFontBase;
				var digitColor=selected ? '#ffe066' : '#fff';
				var r=drawSpokeSpan(ctx,cx,cy,centerRad,flip,digitStartR,opt.hotkey||String(i+1),digitFontPx,digitColor);
				r+=4*k; // gap between the hotkey digit and the option text.
				var avail=Math.max(20*k,rOuter-r);
				var fit=fitSpokeLabel(ctx,opt.text||'',avail,selected ? textFontStart+2*k : textFontStart,floorFontPx);
				var textColor=selected ? '#ffe066' : '#dff2e8';
				drawSpokeSpan(ctx,cx,cy,centerRad,flip,r,fit.text,fit.fontPx,textColor);
			}
		}
		else
		{
			// Generic/ESC face: same fully-transparent treatment, but there
			// is no per-option content to label -- every sector dispatches
			// the identical GUI_ESCAPE_ACTION, so this stays a simple fixed
			// 4-spoke "ESC" reminder (unrotated: 3 short latin letters read
			// fine upright at any position, so radial rotation would only
			// add visual noise here for no legibility gain).
			for(var gi=0; gi<GUI_GUIDE_SECTORS.length; ++gi)
			{
				var dir=GUI_GUIDE_SECTORS[gi];
				var gCenterRad=DIAL_SECTOR_CANVAS_DEG[dir]*Math.PI/180;
				ctx.save();
				ctx.translate(cx,cy);
				ctx.rotate(gCenterRad);
				ctx.beginPath();
				ctx.moveTo(hubR+4*k,0);
				ctx.lineTo(hubR+14*k,0);
				ctx.lineWidth=1.5*k;
				ctx.strokeStyle='rgba(230,237,243,0.55)';
				ctx.stroke();
				ctx.restore();
				var gLabelR=hubR+26*k;
				var glx=cx+Math.cos(gCenterRad)*gLabelR, gly=cy+Math.sin(gCenterRad)*gLabelR;
				ctx.textAlign='center';
				ctx.textBaseline='middle';
				ctx.font='bold '+(20*k)+'px sans-serif';
				// Amber -- a different hue from the 'ap' N-way face's white/
				// yellow makes "this isn't the usual dial" obvious at a
				// glance, before reading any text.
				ctx.lineWidth=3*k;
				ctx.strokeStyle='rgba(8,10,14,0.9)';
				ctx.strokeText('ESC',glx,gly);
				ctx.fillStyle='#ffb37a';
				ctx.fillText('ESC',glx,gly);
			}
		}
		// No centre hub any more -- the old hub disc only repeated what the
		// selected sector's accent already shows, and the "A=5 B=0" reminder
		// it carried died with the face-button reroutes it described (see
		// processControllerPlain: the owner hand's A/X is parked now, B/Y is
		// cancel), so the centre stays fully transparent like everything
		// else. The ONE binding no sector can label -- cancel, this SAME
		// hand's B (right) / Y (left) press -- plus the overflow/panel
		// pointer goes on a single small fit-shrunk line tucked into the
		// canvas' bottom-LEFT corner: the only bottom-edge region no spoke
		// label can ever reach (a straight-down spoke's rotated text runs
		// through bottom-CENTRE; the bottom-left DIAGONAL spoke is capped at
		// rOuter, whose corner-ward component tops out at rOuter/sqrt(2),
		// well above this line).
		var cancelLabel=('right'===hand ? 'B' : 'Y');
		var hint;
		if('ap'===guiMode)
		{
			hint=(menu && menu.overflow) ? ('他はパネル参照 / 取消:'+cancelLabel) : ('取消:'+cancelLabel);
		}
		else
		{
			hint=(0<options.length ? 'パネル参照('+options.length+') / ' : '')+'全入力=ESC';
		}
		var hintFit=fitSpokeLabel(ctx,hint,cx-16*k,12*k,8*k);
		ctx.font='bold '+hintFit.fontPx+'px sans-serif';
		ctx.textAlign='left';
		ctx.textBaseline='middle';
		ctx.lineWidth=Math.max(2,hintFit.fontPx*0.22);
		ctx.strokeStyle='rgba(8,10,14,0.9)';
		ctx.strokeText(hintFit.text,6*k,h-10*k);
		ctx.fillStyle='rgba(255,224,130,0.95)';
		ctx.fillText(hintFit.text,6*k,h-10*k);
	}
	// ---- Normal flight-function dial face: fully-transparent, radial-label
	// (2026-07, same redesign/visual language as drawGuiDialGuide below) ----
	// RIGHT_DIAL/LEFT_DIAL are now N-way arrays (N=6 today) rather than a
	// fixed up/right/down/left table, so this face is drawn exactly like
	// the GUI guide's 'ap' branch (see drawGuiDialGuide's doc comment for
	// the full design rationale -- no background disc, no outer circle, no
	// wedge fill/borders, no centre hub, only floating text), just WITHOUT
	// the leading hotkey-digit span (these are fixed functions, not
	// numbered menu options) and with N fixed at the table's own length
	// instead of a dialog's dynamic option count. sel (numeric 0..N-1, see
	// updateDialStick/pickDialSector) picks which sector gets the longer/
	// amber tick + arrowhead accent; 'hold'-mode entries currently being
	// fired share that SAME accent while the trigger is held (dial.sel does
	// not change mid-hold, so no extra state/color is needed here -- see
	// the class doc comment's Four-refinements section).
	function drawDial(ctx,hand,sel,state,guiMode)
	{
		var w=ctx.canvas.width,h=ctx.canvas.height,cx=w/2,cy=h/2,k=w/384;
		ctx.clearRect(0,0,w,h);
		// guiMode is only ever non-null for whichever hand currently OWNS an
		// open dialog (see processControllerPlain's rActive/lActive) -- so
		// this check no longer needs to (and must not) hardcode 'right'.
		if(guiMode)
		{
			drawGuiDialGuide(ctx,guiMode,hand);
			return;
		}
		var table=('right'===hand ? RIGHT_DIAL : LEFT_DIAL);
		var n=table.length;
		var wedge=2*Math.PI/n;
		// Same hubR/rOuter keep-clear convention as drawGuiDialGuide (k here
		// is also w/384, so the two faces' proportions match exactly).
		var rOuter=w/2-10*k;
		var hubR=28*k;
		var textFontStart=17*k, floorFontPx=12*k;
		for(var i=0; i<n; ++i)
		{
			var centerRad=-Math.PI/2+i*wedge;
			var flip=Math.cos(centerRad)<0; // see drawGuiDialGuide's flip-rule doc comment.
			var selected=(i===sel);
			var tickInnerR=hubR+3*k, tickOuterR=selected ? hubR+13*k : hubR+7*k;
			ctx.save();
			ctx.translate(cx,cy);
			ctx.rotate(centerRad);
			ctx.beginPath();
			ctx.moveTo(tickInnerR,0);
			ctx.lineTo(tickOuterR,0);
			ctx.lineWidth=(selected ? 3 : 1.5)*k;
			ctx.strokeStyle=selected ? 'rgba(255,214,64,0.95)' : 'rgba(230,237,243,0.55)';
			ctx.stroke();
			if(selected)
			{
				var apexR=tickOuterR+6*k;
				ctx.beginPath();
				ctx.moveTo(apexR,0);
				ctx.lineTo(apexR-5*k,-4*k);
				ctx.lineTo(apexR-5*k,4*k);
				ctx.closePath();
				ctx.fillStyle='rgba(255,214,64,0.95)';
				ctx.fill();
			}
			ctx.restore();
			var labelStartR=tickOuterR+(selected ? 9*k : 5*k);
			var avail=Math.max(20*k,rOuter-labelStartR);
			var fit=fitSpokeLabel(ctx,table[i].label,avail,selected ? textFontStart+2*k : textFontStart,floorFontPx);
			var textColor=selected ? '#ffe066' : '#dff2e8';
			var r=drawSpokeSpan(ctx,cx,cy,centerRad,flip,labelStartR,fit.text,fit.fontPx,textColor);
			// Live-state readout (gear/brake/flap/weapon -- see
			// dialEntryStateText above): a second, dimmer span chained
			// outward past the label on the same spoke. The labels are all
			// short, so the leftover radius comfortably fits these few-char
			// readouts; fitSpokeLabel still guards the pathological case.
			var stateText=dialEntryStateText(table[i],state);
			if(stateText)
			{
				var stateStartR=r+5*k;
				var stateFit=fitSpokeLabel(ctx,stateText,Math.max(16*k,rOuter-stateStartR),13*k,9*k);
				var stateColor=selected ? 'rgba(255,224,130,0.9)' : 'rgba(170,214,190,0.9)';
				drawSpokeSpan(ctx,cx,cy,centerRad,flip,stateStartR,stateFit.text,stateFit.fontPx,stateColor);
			}
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
				canvas.width=DIAL_CANVAS_PX;
				canvas.height=DIAL_CANVAS_PX;
				var quad=vr.mvBinding.createQuadLayer({
					space:vr.viewerSpace,
					viewPixelWidth:DIAL_CANVAS_PX,
					viewPixelHeight:DIAL_CANVAS_PX,
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
			else if(vr.testDialFace)
			{
				// Headless dial-face harness (scripts/smoke-vrdialface.mjs):
				// canvas-only resource so the REAL updateDialLayers state
				// machine below (redraw gate, drawnSel bookkeeping, visible/
				// inLayers lifecycle) runs end-to-end without a live XR
				// session -- quad:null routes the upload step into the
				// compositor MODEL below instead of GL. This exists because
				// three rounds of stale-highlight fixes asserted only on PICK
				// state while the RENDER/PRESENT half was the untested part;
				// see vr.tickDialFace's doc comment.
				//
				// presentedCanvas: what the headset compositor SHOWS, as
				// opposed to `canvas` (what drawDial painted).  The model
				// mirrors two real WebXR-layers semantics that the stale-GUN
				// device bug hinged on: (1) an upload only reaches the eye if
				// the layer is in the CURRENTLY APPLIED render state
				// (inAppliedRenderState -- XRSession.updateRenderState takes
				// effect on the NEXT frame, so the sync at the tail of
				// updateDialLayers lags the upload in its own frame by one);
				// (2) a layer re-added to the render state re-presents its
				// LAST SUBMITTED buffer, however old.
				var testCanvas=document.createElement('canvas');
				testCanvas.width=DIAL_CANVAS_PX;
				testCanvas.height=DIAL_CANVAS_PX;
				var presented=document.createElement('canvas');
				presented.width=DIAL_CANVAS_PX;
				presented.height=DIAL_CANVAS_PX;
				res={canvas:testCanvas,ctx:testCanvas.getContext('2d'),quad:null,inLayers:false,
					presentedCanvas:presented,presentedCtx:presented.getContext('2d'),
					inAppliedRenderState:false};
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
	// Scratch canvas for the (rare) case a layer's allocated sub-image
	// viewport size differs from the source canvas -- the content is scaled
	// through here so it still fills the quad exactly.
	var subImageScaleScratch=null;
	// One-shot diagnostic: report the first sub-image whose viewport is NOT
	// the naive full-texture (0,0,w,h) -- the exact allocator behaviour the
	// 2026-07 corruption (see below) depends on.  Runs once per session.
	var subImageVpReported=false;
	function reportSubImageViewport(vp,srcW,srcH)
	{
		if(subImageVpReported)
		{
			return;
		}
		subImageVpReported=true;
		var msg='[vr] subimage viewport x='+vp.x+' y='+vp.y+' w='+vp.width+' h='+vp.height+' (src '+srcW+'x'+srcH+')';
		console.warn(msg);
		try
		{
			if(globalThis.ysfwDiag)
			{
				globalThis.ysfwDiag.push('vrvp',{msg:msg});
			}
		}
		catch(e){}
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
		// Honour the sub-image VIEWPORT (2026-07 Quest field report): the
		// compositor may pack several layers' sub-images into one shared
		// texture, and it grew visible once the menu scene crossed ~10 live
		// layers -- uploads pinned to (0,0) then landed in whichever layer
		// owned the texture's corner (on device: a second phantom "menu"
		// quad showing another layer's region, cursor rings drawn offset
		// from the ray).  Upload into THIS layer's assigned rectangle, and
		// scale through the scratch canvas if the allocated size differs
		// from the source.
		var vp=(sub&&sub.viewport)?sub.viewport:null;
		var dx=(vp?vp.x:0),dy=(vp?vp.y:0);
		var src=canvas;
		if(vp&&(vp.x!==0||vp.y!==0||vp.width!==canvas.width||vp.height!==canvas.height))
		{
			reportSubImageViewport(vp,canvas.width,canvas.height);
		}
		if(vp&&(vp.width!==canvas.width||vp.height!==canvas.height)&&0<vp.width&&0<vp.height)
		{
			if(!subImageScaleScratch)
			{
				subImageScaleScratch=document.createElement('canvas');
			}
			var sc=subImageScaleScratch;
			if(sc.width!==vp.width||sc.height!==vp.height)
			{
				sc.width=vp.width;
				sc.height=vp.height;
			}
			var sctx=sc.getContext('2d');
			if(sctx)
			{
				sctx.clearRect(0,0,sc.width,sc.height);
				sctx.drawImage(canvas,0,0,sc.width,sc.height);
				src=sc;
			}
		}
		GLctx.texSubImage2D(GLctx.TEXTURE_2D,0,dx,dy,GLctx.RGBA,GLctx.UNSIGNED_BYTE,src);
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
		if(!vr.mvBinding && !vr.testDialFace)
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
			// Redraw when the sticky sector selection changes, OR the
			// guiMode changes (a dialog just opened/closed/switched between
			// apMenu and generic). stateSig is still tracked/compared here
			// too (harmless -- drawDial no longer paints aircraft state
			// on the normal face, see its doc comment, so a state-only
			// change now just re-draws identical pixels) rather than
			// threading a third redraw condition's removal through this
			// call, dumpDialLayer, and drawDial's shared signature.
			// "Sticky sector selection" means dial.guiSel while guiMode is
			// set, dial.sel otherwise -- see dialRedrawKey's doc comment for
			// why this must NOT simply be dial.sel unconditionally (that was
			// the AP-menu no-highlight bug: dial.sel never changes while
			// picks are routed into dial.guiSel by updateDialStick, so the
			// old unconditional dial.sel comparison could never detect a
			// guiSel-only change and the quad silently stopped redrawing).
			var redrawKey=dialRedrawKey(dial,guiMode);
			if(res.drawnSel!==redrawKey || res.drawnStateSig!==stateSig || res.drawnGuiMode!==guiMode)
			{
				try
				{
					drawDial(res.ctx,hand,dial.sel,state,guiMode);
					res.drawnSel=redrawKey;
					res.drawnStateSig=stateSig;
					res.drawnGuiMode=guiMode;
				}
				catch(e){} // Leave res.drawn* unset so the next frame retries.
			}
			// Upload the canvas EVERY frame the quad is presented -- the
			// upload is deliberately NOT behind the repaint gate above.
			// Root cause of the thrice-reported stale-GUN-highlight device
			// bug (round 4, reproduced visually by scripts/
			// smoke-vrdialface.mjs's compositor model): a quad layer's
			// upload only reaches the eye if the layer is in the CURRENTLY
			// APPLIED render state, but on the dial's reappearance frame the
			// quad is re-added via syncRenderStateLayers at the END of this
			// function and XRSession.updateRenderState only takes effect on
			// the NEXT frame -- so when a fast flick crossed both the
			// visible and select thresholds inside one 72 Hz frame, the
			// gate's single redraw+upload landed in a never-presented
			// swapchain buffer (no exception raised), the gate then closed
			// (drawn* marked done), and the compositor re-presented the
			// LAST SUBMITTED buffer: the pre-hide GUN face, frozen while
			// the stick pointed elsewhere.  Uploading every presented frame
			// removes ALL freshness state from the GL boundary (also
			// covering compositor-side buffer loss, which needsRedraw was
			// supposed to signal); the paint gate above still keeps the
			// expensive canvas 2D work change-driven.  Cost: one 384x384
			// texSubImage2D per visible dial per frame, only while a dial is
			// actually shown (thumbstick engaged + the 1.2 s fade window) --
			// negligible next to the scene pass.
			try
			{
				if(res.quad)
				{
					var sub=vr.mvBinding.getSubImage(res.quad,frame);
					uploadCanvasToSubImage(res.canvas,sub);
				}
				else if(res.presentedCtx && res.inAppliedRenderState)
				{
					// Headless compositor model (see ensureDialResources'
					// test-mode branch): the upload reaches the presented
					// buffer only for a layer in the APPLIED render state.
					res.presentedCtx.clearRect(0,0,res.presentedCanvas.width,res.presentedCanvas.height);
					res.presentedCtx.drawImage(res.canvas,0,0);
				}
			}
			catch(e){} // Transient (e.g. the very frame of re-add): the next frame's upload heals it.
		}
		if(layersChanged)
		{
			syncRenderStateLayers();
		}
	}

	// Rebuilds session.renderState.layers from scratch out of every quad
	// currently marked inLayers (dial + help placards, both hands, plus the
	// single perf placard) plus the projection layer first/background.
	// Dial, help, and perf visuals are each updated from separate functions
	// (updateDialLayers/updateHelpLayers/updatePerfLayers) that can each
	// change independently, so none may build the array from just its own
	// state -- doing so would silently drop the others' quads the next time
	// only one of them changes (the array is not additive across calls,
	// WebXR replaces the whole list each updateRenderState).
	function syncRenderStateLayers()
	{
		var layers=[vr.mvLayer];
		if(vr.dialRes.right && vr.dialRes.right.inLayers){ layers.push(vr.dialRes.right.quad); }
		if(vr.dialRes.left && vr.dialRes.left.inLayers){ layers.push(vr.dialRes.left.quad); }
		if(vr.helpRes.right && vr.helpRes.right.inLayers){ layers.push(vr.helpRes.right.quad); }
		if(vr.helpRes.left && vr.helpRes.left.inLayers){ layers.push(vr.helpRes.left.quad); }
		if(vr.perfRes && vr.perfRes.inLayers){ layers.push(vr.perfRes.quad); }
		// Sky equirect: placed between dials/perf and the menu quad so it fills
		// the black void (no active 3D scene) while the menu is shown.
		if(vr.skyRes && vr.skyRes.inLayers && vr.skyRes.layer){ layers.push(vr.skyRes.layer); }
		// Menu quad: placed after the sky so it composites over it.
		if(vr.menuRes && vr.menuRes.inLayers && vr.menuRes.quad){ layers.push(vr.menuRes.quad); }
		// VR keyboard: hangs under the menu board, same compositing slot.
		if(vr.kbd && vr.kbd.res && vr.kbd.res.inLayers && vr.kbd.res.quad){ layers.push(vr.kbd.res.quad); }
		// Controller laser beams: physically in front of the menu board, so
		// composited over it (and under the cursor ring, which sits ON it).
		if(vr.beamRes && vr.beamRes.right && vr.beamRes.right.inLayers){ layers.push(vr.beamRes.right.quad); }
		if(vr.beamRes && vr.beamRes.left && vr.beamRes.left.inLayers){ layers.push(vr.beamRes.left.quad); }
		// Transparent cursor overlay: front-most and exactly coextensive with
		// the menu. Both hand rings share this one composition layer.
		if(vr.cursorRes && vr.cursorRes.inLayers){ layers.push(vr.cursorRes.quad); }
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
			{cx:64, cy:132, label:'X',        label2:'長押し:ヘルプ'},
			{cx:96, cy:132, label:'Y',        label2:'視点切替 / メニュー中:取消'},
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

	// Folds a new JS-side sample (ms) into vr.jsPerf[key] with the same
	// alpha=0.05 EMA as the engine's fsvr.h FsVrPerfDataPointer, so the
	// '[vrperf]' line mixes native and JS numbers on the same footing.
	function accumJsPerf(key,ms)
	{
		var p=vr.jsPerf;
		p[key]=(0===p[key] ? ms : p[key]*0.95+ms*0.05);
	}

	// Single source of truth for every number the '[vrperf]' console line,
	// the in-headset perf placard (drawPerfPlacard below), and the
	// post-session chip (vr.stats.phases, see the session-end handler)
	// display, so the three consumers can never drift out of sync with each
	// other or with fsvr.h's FsVrPerfDataPointer slot layout. Safe to call
	// whether or not the wasm build exports _YsfwVrPerfDataPointer
	// (defensive: older cached builds during development). All EMA, so a
	// single call is a representative snapshot, not a one-frame spike.
	function readVrPerfSnapshot()
	{
		var tick=(Module._YsfwGetTickMs ? Module._YsfwGetTickMs() : 0);
		var sim=0,draw=0,scene=0,hud=0,gui=0,reticle=0;
		if(Module._YsfwVrPerfDataPointer)
		{
			var p=Module._YsfwVrPerfDataPointer()>>2;
			sim=HEAPF32[p+0]; draw=HEAPF32[p+1];
			scene=HEAPF32[p+2]; hud=HEAPF32[p+3]; gui=HEAPF32[p+4]; reticle=HEAPF32[p+5];
		}
		var jp=vr.jsPerf;
		// vr.stats only exists once vr.enter() has run at least once (set at
		// the top of vr.enter, below) -- guard so headless callers that draw
		// the placard via forceMultiview/dumpPerfPlacard without a real
		// session (never calling vr.enter) get 0 instead of throwing.
		return {tick:tick,sim:sim,draw:draw,scene:scene,hud:hud,gui:gui,reticle:reticle,
		        ctl:jp.ctl,dial:jp.dial,layers:jp.layers,fps:(vr.stats ? vr.stats.fps : 0)};
	}

	// Prints the '[vrperf]' phase-breakdown line: engine tick/sim/draw
	// (YsfwGetTickMs / FsVrPerfDataPointer slots [0][1]), the multiview
	// draw-path breakdown (slots [2..5], see fsvr.h), and the JS-side EMAs
	// gathered in onXRFrame around the multiview-only maintenance calls
	// (controller processing, dial canvas redraw+upload, help/perf-quad
	// layer maintenance).
	function printVrPerfLine()
	{
		var s=readVrPerfSnapshot();
		console.log('[vrperf] tick '+s.tick.toFixed(1)+
		            ' | sim '+s.sim.toFixed(1)+' draw '+s.draw.toFixed(1)+
		            ' | scene '+s.scene.toFixed(1)+' hud '+s.hud.toFixed(1)+' gui '+s.gui.toFixed(1)+' reticle '+s.reticle.toFixed(1)+
		            ' | js: ctl '+s.ctl.toFixed(1)+' dial '+s.dial.toFixed(1)+' layers '+s.layers.toFixed(1)+
		            ' (ms EMA)');
	}

	// ---- Perf placard: head-locked live numbers (Module.ysfwVrOptions.perf)
	// -------------------------------------------------------------------
	// Same lazy-resource / layers-path discipline as the dial and help quads
	// above: quad-layer visuals are a "nice to have" here -- any failure
	// leaves the '[vrperf]' console line and the post-session chip working
	// exactly as before. This is the actual fix for "reading the console in
	// VR is impractical": the same EMA numbers printed every 5s are also
	// redrawn onto a small head-locked quad, at most once a second.
	var PERF_CANVAS_W=768, PERF_CANVAS_H=192;
	var PERF_QUAD_W=0.30, PERF_QUAD_H=0.075;
	// Below and centred relative to the dial quads (ensureDialResources:
	// x=+-0.18, y=-0.18, z=-0.8, 0.12m square each) -- this placard's own
	// y=-0.2625..-0.3375 band (0.075m tall, centred at -0.30) never overlaps
	// the dials' y=-0.12..-0.24 band regardless of its wider x extent.
	var PERF_QUAD_POS={x:0,y:-0.30,z:-0.85};
	// Drawn at most once a second (see updatePerfLayers) -- dark-
	// translucent-rounded-panel visual language matching drawHelpCanvas
	// above, monospace so the columns of numbers line up.
	function drawPerfPlacard(ctx)
	{
		var w=PERF_CANVAS_W,h=PERF_CANVAS_H;
		var s=readVrPerfSnapshot();
		ctx.clearRect(0,0,w,h);
		ctx.fillStyle='rgba(10,14,20,0.6)';
		roundRectPath(ctx,4,4,w-8,h-8,16);
		ctx.fill();
		ctx.strokeStyle='rgba(230,237,243,0.35)';
		ctx.lineWidth=2;
		ctx.stroke();

		ctx.textAlign='left';
		ctx.textBaseline='middle';
		ctx.font='30px monospace';
		ctx.fillStyle='rgba(230,237,243,0.95)';
		ctx.fillText('tick '+s.tick.toFixed(1)+'ms  sim '+s.sim.toFixed(1)+'  draw '+s.draw.toFixed(1),24,50);
		ctx.fillText('scene '+s.scene.toFixed(1)+'  hud '+s.hud.toFixed(1)+'  gui '+s.gui.toFixed(1)+'  ret '+s.reticle.toFixed(1),24,102);
		ctx.fillStyle='rgba(160,200,255,0.95)';
		// session.frameRate: the compositor rate actually GRANTED (see the
		// updateTargetFrameRate negotiation) -- fps vs this rate is the
		// pacing readout: fps well below a granted 72 means missed vsyncs,
		// not a wrong target.
		var hz=(vr.session && vr.session.frameRate) ? ('@'+Math.round(vr.session.frameRate)+'Hz') : '';
		ctx.fillText('js: ctl '+s.ctl.toFixed(1)+'  dial '+s.dial.toFixed(1)+'  layers '+s.layers.toFixed(1)+'   '+s.fps.toFixed(1)+'fps'+hz,24,154);
	}
	function ensurePerfResources()
	{
		if(undefined!==vr.perfRes)
		{
			return vr.perfRes; // cached: an object, or false (unavailable).
		}
		var res=false;
		try
		{
			if(vr.mvBinding && vr.viewerSpace)
			{
				var canvas=document.createElement('canvas');
				canvas.width=PERF_CANVAS_W;
				canvas.height=PERF_CANVAS_H;
				var quad=vr.mvBinding.createQuadLayer({
					space:vr.viewerSpace,
					viewPixelWidth:PERF_CANVAS_W,
					viewPixelHeight:PERF_CANVAS_H,
					layout:'mono',
					width:PERF_QUAD_W,
					height:PERF_QUAD_H,
					transform:new XRRigidTransform(PERF_QUAD_POS)
				});
				try
				{
					if('blendTextureSourceAlpha' in quad)
					{
						quad.blendTextureSourceAlpha=true;
					}
				}catch(e){}
				res={canvas:canvas,ctx:canvas.getContext('2d'),quad:quad,inLayers:false,drawnAt:0};
			}
		}
		catch(e)
		{
			console.warn('[vr] perf quad layer unavailable: '+(e&&e.message?e.message:e));
			res=false;
		}
		vr.perfRes=res;
		return res;
	}
	// Per-frame perf-placard maintenance, the perf counterpart of
	// updateDialLayers/updateHelpLayers above: created lazily on the first VR
	// frame with Module.ysfwVrOptions.perf enabled, torn down (both the
	// layers-array entry and the toggle-off case below) the instant perf is
	// switched off, and fully reset at session end (see the session-end
	// handler). Redrawn+uploaded at most once a second -- see
	// drawPerfPlacard's doc comment.
	function updatePerfLayers(frame)
	{
		var opts=Module.ysfwVrOptions||{};
		if(!vr.mvBinding || !opts.perf)
		{
			if(vr.perfRes && vr.perfRes.inLayers)
			{
				vr.perfRes.inLayers=false;
				syncRenderStateLayers();
			}
			return; // No layers support, or the perf placard just isn't wanted.
		}
		var res=ensurePerfResources();
		if(!res)
		{
			return; // No quad-layer support: console line/chip still work.
		}
		var layersChanged=false;
		if(!res.inLayers)
		{
			res.inLayers=true;
			res.drawnAt=0; // Force an immediate first draw+upload.
			layersChanged=true;
		}
		var now=(typeof performance!=='undefined' ? performance.now() : Date.now());
		if(1000<=now-res.drawnAt)
		{
			try
			{
				drawPerfPlacard(res.ctx);
				var sub=vr.mvBinding.getSubImage(res.quad,frame);
				uploadCanvasToSubImage(res.canvas,sub);
				res.drawnAt=now;
			}
			catch(e){} // Leave res.drawnAt so the next frame retries.
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
			st.bucketT0=t;
			vr.jsPerfWindow=t;
		}
		++st.frames;
		++st.framesWindow;
		++st.bucketFrames;
		st.t1=t;
		if(2000<=t-st.tWindow)
		{
			st.fps=1000*st.framesWindow/(t-st.tWindow);
			console.log('[vr] '+st.fps.toFixed(1)+' fps');
			st.tWindow=t;
			st.framesWindow=0;
		}
		// 30s fps buckets (vr.stats.fpsSeries), shipped with the vr-end
		// metric: a single session average cannot say whether a low number
		// means "the first minute is heavy" or "it degrades over time", and
		// headset sessions are exactly the ones that only exist remotely.
		// Capped at 120 buckets (an hour) so a kiosk-length session cannot
		// grow an unbounded array or an oversized Analytics Engine blob.
		if(30000<=t-st.bucketT0)
		{
			if(st.fpsSeries.length<120)
			{
				st.fpsSeries.push(Math.round(1000*st.bucketFrames/(t-st.bucketT0)));
			}
			st.bucketT0=t;
			st.bucketFrames=0;
		}

		// Phase-breakdown perf line (?vrperf=1): every 5s, independent of the
		// 2s fps window above so the two don't fight over st's bookkeeping.
		if((Module.ysfwVrOptions||{}).perf && 5000<=t-vr.jsPerfWindow)
		{
			printVrPerfLine();
			vr.jsPerfWindow=t;
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

		// Rebuilt as an OR across all tracked hands by processControllerPlain.
		// Clear before asking for a pose so a transient tracking loss cannot
		// leave the pre-flight confirmation trigger stuck down.
		HEAPF32[(_YsfwVrControlDataPointer()>>2)+7]=0;
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
				var perfP0=performance.now();
				updateControllers(frame,pose);
				var perfP1=performance.now();
				updateDialLayers(frame);
				var perfP2=performance.now();
				updateHelpLayers(frame);
				var perfP3=performance.now();
				updatePerfLayers(frame);
				var perfP4=performance.now();
				accumJsPerf('ctl',perfP1-perfP0);
				accumJsPerf('dial',perfP2-perfP1);
				// Help + perf placard maintenance folded into one bucket
				// (see jsPerf's doc comment on the vr object literal).
				accumJsPerf('layers',(perfP3-perfP2)+(perfP4-perfP3));
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

		// Update the menu quad layer: blit the engine's menu FBO into the
		// XRQuadLayer swapchain if the engine drew this frame (menuDrawn flag),
		// and add/remove the quad from renderState.layers as visibility changes.
		updateMenuLayer(frame);

		// Immersive presentation is supported for the main menu, an active
		// flight, and replay playback (YSRUNMODE_REPLAYRECORD exports
		// ysfwReplaying, not ysfwInFlight -- see fsrunloop.cpp's ChangeRunMode
		// EM_ASM block; its draw path is the same SimDrawAllScreen multiview
		// branch a live flight uses, so it presents correctly).  Demo/attract
		// and other 2D-only screens do not redraw the XR projection correctly;
		// leaving their last texture alive makes a frozen rectangle follow the
		// head.  The sky layer covers the short grace window (updateMenuLayer),
		// then we return to 2D with an explicit reason.  Resetting on every
		// supported frame also covers transitions.
		var menuVisibleNow=!!(vr.menuRes&&vr.menuRes.inLayers);
		if(globalThis.ysfwInFlight||globalThis.ysfwReplaying||menuVisibleNow)
		{
			vr.unsupportedVrFrames=0;
		}
		else if(UNSUPPORTED_VR_GRACE<++vr.unsupportedVrFrames)
		{
			vr.endReason=(!vr.menuRes||!vr.menuRes.quad) ? 'menu-unsupported' : 'not-menu-or-flight';
			session.end().catch(function(){});
			return;
		}

		// Ray-to-mouse synthesis: project controller aim rays onto the menu quad
		// plane and inject synthetic mouse events into the engine while the
		// menu is being shown.
		if(vr.menuRes&&vr.menuRes.inLayers&&vr.menuAnchor)
		{
			processMenuRayInput(frame);
		}

		// Ring cursor at the ray hit point (reads the menuRayState the call
		// above just refreshed; hides itself when the menu is not visible).
		updateMenuCursor(frame);

		// Controller laser beams from each hand to the menu plane (hide
		// themselves when the menu is not visible).
		updateMenuBeams(frame);

		// Watchdog: end the session when the engine stops presenting entirely
		// (~1.5s of silence).  While the main menu is visible DrawMenu sets
		// FsVrMarkSimDrawn every frame (keeping simSilentFrames at 0), so the
		// watchdog is safely disarmed during normal menu navigation.  On
		// browsers without WebXR-layers support the menu quad can never be
		// created (setupMenu is gated on vr.mvLayer) and DrawMenu deliberately
		// stays silent, so the watchdog fires here and returns the user to the
		// 2D page -- record why so index.html's onVrEnd can explain it.
		if(0<_YsfwVrConsumeSimDrawnFrames())
		{
			vr.simSilentFrames=0;
		}
		else if(100<++vr.simSilentFrames)
		{
			if(!globalThis.ysfwInFlight && (!vr.menuRes || !vr.menuRes.quad))
			{
				vr.endReason='menu-unsupported';
			}
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
		vr.stats={frames:0,framesWindow:0,t0:0,t1:0,tWindow:0,fps:0,bucketT0:0,bucketFrames:0,fpsSeries:[]};
		vr.jsPerf={ctl:0,dial:0,layers:0};
		vr.endReason=null;
		vr.endListenerArmed=false;
		vr.unsupportedVrFrames=0;
		vr.jsPerfWindow=0;
		var wantMultiview=(undefined!==opts.multiview ? !!opts.multiview : true);
		var sessionInit={requiredFeatures:['local'],optionalFeatures:['layers']};
		return navigator.xr.requestSession('immersive-vr',sessionInit).then(function(session)
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
					// The spec attribute is supportedFrameRates -- an earlier
					// revision read the nonexistent session.frameRates, so this
					// whole block silently no-oped and the session stayed at
					// the browser default (90Hz on Quest 3S). Missing 90Hz's
					// 11.1ms deadline by a little dropped the effective rate
					// to ~60fps even with the engine tick at 7ms -- the pacing
					// gap this negotiation exists to close (72Hz = 13.9ms).
					var rates=session.supportedFrameRates||session.frameRates;
					if(rates && rates.length && session.updateTargetFrameRate)
					{
						var best=0;
						rates.forEach(function(r){ if(r<=frameRate && best<r){ best=r; } });
						if(0===best)
						{
							rates.forEach(function(r){ if(0===best || r<best){ best=r; } });
						}
						if(0<best)
						{
							session.updateTargetFrameRate(best).then(function()
							{
								console.log('[vr] target frame rate '+best+'Hz (granted '+(session.frameRate||'?')+'Hz) of ['+Array.prototype.join.call(rates,',')+']');
							}).catch(function(e)
							{
								console.warn('[vr] updateTargetFrameRate('+best+') rejected: '+(e&&e.message?e.message:e));
							});
						}
					}
					else
					{
						console.log('[vr] frame-rate negotiation unavailable (supportedFrameRates absent); staying at browser default'+(session.frameRate ? ' '+session.frameRate+'Hz' : ''));
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

				// From here on, a torn-down session emits its own vr-end
				// (the 'end' listener below) -- the enter catch's vr-fail
				// report stands down so a setup failure past this point is
				// counted once, not twice (see the catch's doc comment).
				vr.endListenerArmed=true;
				session.addEventListener('end',function()
				{
					var st=vr.stats;
					if(st && 100<st.t1-st.t0)
					{
						st.seconds=(st.t1-st.t0)/1000;
						st.avgFps=(st.frames-1)/st.seconds;
						// Close the open fps bucket if it spans enough to
						// mean anything (5s): the tail is where slow
						// degradation would show, so it must not be dropped.
						if(5000<=st.t1-st.bucketT0 && 0<st.bucketFrames && st.fpsSeries.length<120)
						{
							st.fpsSeries.push(Math.round(1000*st.bucketFrames/(st.t1-st.bucketT0)));
						}
						// Engine CPU time per tick (EMA).  If this is close to the
						// frame period (1000/fps), the frame is CPU-bound -- a
						// resolution-independent read that survives thermal drift,
						// unlike comparing fps across separate (differently-heated)
						// runs.
						st.cpuMs=(Module._YsfwGetTickMs ? Module._YsfwGetTickMs() : 0);
						console.log('[vr] session avg '+st.avgFps.toFixed(1)+' fps, '+
						            st.cpuMs.toFixed(0)+'ms CPU/frame (period '+(1000/st.avgFps).toFixed(0)+'ms), over '+st.seconds.toFixed(1)+'s');
						// Phase breakdown, unconditionally (costs nothing once the
						// session is already ending): whatever the perf block last
						// held, right next to the fps/CPU summary above.
						printVrPerfLine();
						// Same numbers, snapshotted onto vr.stats so
						// web/index.html's post-session chip (Module.onVrEnd)
						// can show a phase line too -- unconditionally (not
						// gated behind Module.ysfwVrOptions.perf like the
						// console line/quad above): the snapshot itself costs
						// nothing, and the chip is what actually gets read
						// after a headset A/B run.
						var pf=readVrPerfSnapshot();
						st.phases={sim:pf.sim,draw:pf.draw,scene:pf.scene,hud:pf.hud,gui:pf.gui,reticle:pf.reticle,
						           ctl:pf.ctl,dial:pf.dial,layers:pf.layers};
						// The GRANTED compositor rate, for the chip: avg fps
						// vs this is the frame-pacing verdict (see the
						// updateTargetFrameRate negotiation above).
						st.grantedHz=(vr.session && vr.session.frameRate) ? Math.round(vr.session.frameRate) : 0;
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
					vr.unsupportedVrFrames=0;

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
					vr.ctl.aBtn={pressed:false,pressAt:0,recentered:false,owned:false};
					vr.ctl.xBtn={pressed:false,pressAt:0,helped:false,owned:false};
					vr.ctl.rightB=false;
					vr.ctl.rightBSwallow=false;
					vr.ctl.leftY=false;
					vr.ctl.leftYSwallow=false;
					vr.ctl.leftTrigger=false;
					vr.ctl.dial.right={sel:0,guiSel:0,engaged:null,visible:false,hideAt:0,picking:false};
					vr.ctl.dial.left={sel:0,guiSel:0,engaged:null,visible:false,hideAt:0,picking:false};
					vr.ctl.gripPose={right:null,left:null};
					vr.ctl.propAnchor={right:null,left:null};
					vr.viewerSpace=null;
					vr.dialRes={right:undefined,left:undefined};
					vr.helpRes={right:undefined,left:undefined};
					vr.help={visible:false,shownAt:0};
					vr.perfRes=undefined;
					// menuRes/skyRes/cursorRes/beamRes are nulled by their
					// teardown functions below (nulling them first would make
					// the teardowns early-return and leak the GL resources).
					resetMenuRayState();

					teardownHud();
					teardownGui();
					teardownShadowFbo();
					teardownMenu();
					teardownSky();
					teardownCursor();
					teardownBeams();
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
					setupShadowFbo();
					setupMenu();
					setupSky();
					setupCursor();
					setupBeams();
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
			// Record WHY before tearing down (issue #79: this path used to end
			// the session with endReason=null, so neither the vr-end diag
			// event nor any user-visible explanation carried the failure).
			// The rethrow still reaches the shell's per-entry-point catches
			// (button / autostart / tap overlay), which own the toast.
			if(!vr.endReason)
			{
				vr.endReason='enter-failed: '+((err&&err.message) ? err.message : err);
			}
			console.error('[vr] enter failed:',err);
			// Report the failed ATTEMPT to the shell (Module.onVrFail -> the
			// vr-fail metric): a vr-end needs a session, so a requestSession
			// rejection -- the whole phone-Chrome class that advertises
			// immersive-vr and then refuses it -- was invisible to metrics.
			// Once the 'end' listener is armed, the teardown below emits a
			// vr-end carrying this same endReason, and reporting here too
			// would count one failure twice -- so stand down in that case.
			if(!vr.endListenerArmed && Module.onVrFail)
			{
				Module.onVrFail(vr.endReason);
			}
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
	//         buttons:{a:bool,b:bool,stick:bool (optional, xr-standard
	//         thumbstick click -- INERT, processControllerPlain no longer
	//         reads it; kept only so tests can assert the no-op. A held long
	//         (right) recenters/(left) toggles help via vr.ctl.aBtn/xBtn; B
	//         (right)/Y (left) cancel an owned dialog -- see toggleHelp/
	//         processControllerPlain)}}
	//   viewerQuat: optional [x,y,z,w] headset orientation (default identity,
	//         forward -Z).
	//   viewerPos: optional [x,y,z] headset position (default [0,0,0]) --
	//         used only to derive the FsVrHandPoseDataPointer block (see
	//         writeHandPoseBlock) exactly as updateControllers does; the
	//         flight-control math in processControllerPlain never reads it.
	// Goes through the exact same processControllerPlain as the real XR path
	// (updateControllers) -- no duplicated control logic.
	vr.pokeControllerFrame=function(list,viewerQuat,viewerPos)
	{
		var vq=viewerQuat ? {x:viewerQuat[0],y:viewerQuat[1],z:viewerQuat[2],w:viewerQuat[3]} : {x:0,y:0,z:0,w:1};
		var vp=viewerPos ? {x:viewerPos[0],y:viewerPos[1],z:viewerPos[2]} : {x:0,y:0,z:0};
		// Match updateControllers: this slot represents this complete frame,
		// then processControllerPlain ORs in either hand's trigger.
		var pokeCtlPtr=_YsfwVrControlDataPointer()>>2;
		HEAPF32[pokeCtlPtr+7]=0;
		// And the per-frame tracked-flag reset ([9]/[10], fsvr.h) -- the
		// engine's ungrabbed controller-model draw gates on these, so the
		// hook must reproduce the real path's absent-hand behaviour too.
		HEAPF32[pokeCtlPtr+9]=0;
		HEAPF32[pokeCtlPtr+10]=0;
		for(var i=0; i<list.length; ++i)
		{
			var e=list[i];
			var gp={x:e.pos[0],y:e.pos[1],z:e.pos[2]};
			var gq={x:e.quat[0],y:e.quat[1],z:e.quat[2],w:e.quat[3]};
			processControllerPlain({
				hand:e.hand,
				pos:gp,
				quat:gq,
				squeeze:(undefined!==e.squeeze ? e.squeeze : 0),
				trigger:(undefined!==e.trigger ? e.trigger : 0),
				thumb:e.thumb,
				buttons:e.buttons||{}
			},vq,null);
			// See updateControllers' identical write for the real XR path,
			// anchor handling included.
			var grabbedNow=('right'===e.hand ? vr.ctl.stick.grabbed : vr.ctl.thr.grabbed);
			var anchor=updateHandPropAnchor(e.hand,gp,vp,vq,grabbedNow);
			writeHandPoseBlock(e.hand,(anchor ? anchor.pos : gp),(anchor ? anchor.quat : gq),vp,vq,grabbedNow);
			HEAPF32[pokeCtlPtr+('right'===e.hand ? 9 : 10)]=1;
		}
	};
	// Headless test hook: read the hand-pose block back as a plain array
	// (see fsvr.h's FsVrHandPoseDataPointer doc comment for the layout) --
	// the read-side counterpart of pokeControllerFrame's write, for scripts
	// that want to assert the viewer-space re-basing math directly instead
	// of only checking the rendered result.
	vr.readHandPoseBlock=function()
	{
		var ptr=_YsfwVrHandPoseDataPointer()>>2;
		var out=[];
		for(var i=0; i<16; ++i)
		{
			out.push(HEAPF32[ptr+i]);
		}
		return out;
	};
	// Headless test hook for the anchored-HOTAS-prop math
	// (scripts/smoke-vrctl.mjs): the EXACT synthetic anchor orientation the
	// real grab path captures (handPropAnchorQuat -- same function object,
	// not a reimplementation), as a plain [x,y,z,w] array from plain array
	// inputs.  Lets a test assert the upright/facing-away construction
	// (q*(0,0,-1)==reference up, q*(0,-1,0)==horizontal away vector) in
	// isolation, while the anchor-invariance property itself is asserted
	// end-to-end through pokeControllerFrame + readHandPoseBlock.
	vr.handPropAnchorQuat=function(gripPos,viewerPos,viewerQuat)
	{
		var q=handPropAnchorQuat(
			{x:gripPos[0],y:gripPos[1],z:gripPos[2]},
			{x:viewerPos[0],y:viewerPos[1],z:viewerPos[2]},
			{x:viewerQuat[0],y:viewerQuat[1],z:viewerQuat[2],w:viewerQuat[3]});
		return [q.x,q.y,q.z,q.w];
	};
	// Headless test hooks for the N-way GUI dial guide (scripts/
	// smoke-vrgui.mjs), fabricating a dialog the real engine has no easy
	// headless path to (radio-comm's wingman-command menu needs a live AI
	// wingman in formation) -- see vr.testGuiOverride's doc comment on the vr
	// state block for why this is a deliberate, test-only shortcut rather
	// than faking the native FsVrGuiDataPointer/FsVrGuiMenuPointer blocks
	// directly (the real engine tick would immediately overwrite those).
	//   lines: array of raw option-label strings, SAME format the engine
	//     serializes (FsSimulation::SimSerializeVrGuiMenu) -- e.g.
	//     '1...Break and Attack', '0...Don't send' -- parsed the exact same
	//     way a real menu is (parseMenuLabel/computeGuiMenuLayout), so this
	//     exercises the real parsing/sector-mapping code, not a re-implementation.
	//   opts: {visible, apMenu} -- both default true (a visible, hotkey-driven
	//     dialog); pass apMenu:false to fabricate a non-hotkey (generic/ESC)
	//     dialog instead.
	// After this call, guiDialogState()/readGuiMenu() return the fabricated
	// state until vr.clearGuiOverride() -- processControllerPlain then drives
	// the owner hand's dial exactly as it would for a real dialog.
	vr.pokeGuiMenu=function(lines,opts)
	{
		opts=opts||{};
		vr.testGuiOverride={
			visible:(false!==opts.visible),
			apMenu:(false!==opts.apMenu),
			menu:lines||[]
		};
	};
	vr.clearGuiOverride=function()
	{
		vr.testGuiOverride=null;
	};

	// TEST-ONLY: forces the VR G-load blackout/redout full-field tint
	// (FsVrDrawFullScreenTint, SimDrawAllScreen) to a fixed colour/alpha,
	// bypassing the real G-load gate entirely -- scripts have no headless
	// path to a real high-G manoeuvre. Defaults to red (a redout), since
	// that is the more visually distinctive smoke-test signature; pass
	// r=g=b=0 for a blackout instead. alpha<=0 clears the override (same as
	// vr.clearBlackoutOverride()).
	vr.pokeBlackout=function(alpha,r,g,b)
	{
		_YsfwVrSetBlackoutOverride(alpha>0 ? 1 : 0,
			(undefined!==r ? r : 1), (undefined!==g ? g : 0), (undefined!==b ? b : 0),
			alpha);
	};
	vr.clearBlackoutOverride=function()
	{
		_YsfwVrSetBlackoutOverride(0,0,0,0,0);
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
	// Pure-math menu test hooks (no XR state) -- ray geometry, proportional
	// texture fit, physical quad aspect, and two-hand mouse arbitration.
	vr.intersectRayWithAnchoredQuad=intersectRayWithAnchoredQuad;
	vr.fitMenuTextureSize=fitMenuTextureSize;
	vr.menuQuadMetricSize=menuQuadMetricSize;
	vr.chooseMenuRayHand=chooseMenuRayHand;
	vr.menuUvToPixel=menuUvToPixel;
	vr.cursorOverlayPoint=cursorOverlayPoint;
	vr.beamPoseFor=beamPoseFor;
	// VR-keyboard test hooks (scripts/smoke-vrmenu.mjs): expose the pure
	// layout/dispatch machinery and the visibility driver so a headless
	// test can type without a headset.
	vr.kbdHitKey=kbdHitKey;
	vr.kbdKeyRects=kbdKeyRects;
	vr.kbdDispatchKey=kbdDispatchKey;
	vr.kbdUpdate=updateKbdLayer;
	vr.kbdState=function(){ return kbdState(); };

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
		setupShadowFbo();
		setupMenu(); // Test mode: allocates menu FBO without XRQuadLayer.
		setupSky();  // Test mode: setupSky checks for mvBinding and skips gracefully.
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
	// Headless test hook for the main-menu-in-VR path ONLY: the menu FBO is a
	// plain mono texture (see setupMenu) and DrawMenu's off-screen pass never
	// touches the multiview scene machinery, so this hook deliberately does
	// NOT require OVR_multiview2 -- CI runners have no multiview-capable GL,
	// which is why scripts/smoke-vrmenu.mjs cannot use forceMultiview above
	// (the other VR smokes run on a real GPU instead).  Just allocate the
	// menu FBO in test mode and flip the engine into VR-presenting so
	// FsRunLoop::DrawMenu takes its VR branch.
	vr.forceVrMenu=function()
	{
		vr.testMode=true;
		setupMenu();
		if(!vr.menuRes)
		{
			return 'no menu fbo';
		}
		_YsfwVrSetPresenting(1);
		return 'ok';
	};
	// Headless test hook: run the REAL menu teardown (zeroes the menu data
	// block and frees the GL resources) -- page-context scripts cannot touch
	// the block directly (HEAPF32 is not an exported runtime method), so
	// smoke-vrmenu.mjs exercises teardown through this instead.
	vr.teardownMenuForTest=function()
	{
		teardownMenu();
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

	// Headless test hooks for the collimated gunsight reticle
	// (scripts/smoke-vrreticle.mjs).  readMultiviewCenterPatch reads back a
	// (2*half)x(2*half) RGBA patch centered on a scene layer of the test color
	// texture-array; the .mjs then locates the HUD-green reticle pixels and
	// compares their centroid between the two eye layers (zero disparity is the
	// whole point of the collimated fix).  GL readPixels is bottom-up; the patch
	// is returned in that native orientation (fine for a layer-vs-layer compare).
	vr.readMultiviewCenterPatch=function(layer,half)
	{
		var W=vr.testW,H=vr.testH;
		var cx=Math.floor(W/2),cy=Math.floor(H/2);
		var x0=cx-half,y0=cy-half,w=2*half,h=2*half;
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.testColor,0,layer);
		var px=new Uint8Array(w*h*4);
		GLctx.readPixels(x0,y0,w,h,GLctx.RGBA,GLctx.UNSIGNED_BYTE,px);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,prev);
		GLctx.deleteFramebuffer(rfb);
		return { W:W,H:H,x0:x0,y0:y0,w:w,h:h,px:Array.from(px) };
	};
	// dumpMultiviewLayer: center-cropped PNG (data URL) of a scene layer, for
	// eyeball/golden-image evidence of the reticle (scripts/smoke-vrreticle.mjs
	// writes it out).  cropHalf defaults to a full-frame dump; scale (default 1)
	// nearest-neighbor upscales the crop so the ~3 px reticle is legible.
	// Vertically flipped (readPixels bottom-up -> top-down canvas), like
	// dumpHudLayer.
	vr.dumpMultiviewLayer=function(layer,cropHalf,scale)
	{
		scale=scale||1;
		var W=vr.testW,H=vr.testH;
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.testColor,0,layer);
		var full=new Uint8ClampedArray(W*H*4);
		GLctx.readPixels(0,0,W,H,GLctx.RGBA,GLctx.UNSIGNED_BYTE,full);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,prev);
		GLctx.deleteFramebuffer(rfb);
		var cx=Math.floor(W/2),cy=Math.floor(H/2);
		var half=cropHalf||Math.floor(Math.min(W,H)/2);
		var ox=cx-half,oy=cy-half,cw=2*half,ch=2*half;
		var out=new Uint8ClampedArray(cw*ch*4);
		for(var y=0; y<ch; ++y)
		{
			var srcY=H-1-(oy+y);
			for(var x=0; x<cw; ++x)
			{
				var si=(srcY*W+(ox+x))*4,di=(y*cw+x)*4;
				out[di]=full[si];out[di+1]=full[si+1];out[di+2]=full[si+2];out[di+3]=full[si+3];
			}
		}
		var src=document.createElement('canvas');
		src.width=cw;src.height=ch;
		var sctx=src.getContext('2d');
		var imgData=sctx.createImageData(cw,ch);
		imgData.data.set(out);
		sctx.putImageData(imgData,0,0);
		if(1===scale)
		{
			return src.toDataURL('image/png');
		}
		var canvas=document.createElement('canvas');
		canvas.width=cw*scale;canvas.height=ch*scale;
		var ctx2d=canvas.getContext('2d');
		ctx2d.imageSmoothingEnabled=false;
		ctx2d.drawImage(src,0,0,canvas.width,canvas.height);
		return canvas.toDataURL('image/png');
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

	// Headless test hook for the VR perf phase-breakdown block (see fsvr.h's
	// FsVrPerfDataPointer doc comment): the 16-float block as a plain array
	// -- same pattern as readHudData/readAircraftState above (the hosting
	// page has no HEAPF32 access; this is the read-side counterpart from
	// inside the module). Used by scripts to probe slots [0..5] directly
	// without waiting on the '[vrperf]' console line's 5s cadence.
	vr.readPerfData=function()
	{
		var p=_YsfwVrPerfDataPointer()>>2;
		var out=[];
		for(var i=0; i<16; ++i)
		{
			out.push(HEAPF32[p+i]);
		}
		return out;
	};
	// readHudPatchStats: mean luminance + mean alpha (0-255) over a patch of a
	// HUD texture layer centered on top-down texture coords (cxTop,cyTop).  Used
	// by scripts/smoke-vrreticle.mjs to assert the gun-crosshair region of the
	// flat HUD is now empty (the crosshair moved to the world-space reticle),
	// while the rest of the HUD (readHudLayerStats) is untouched.  readPixels is
	// bottom-up, so the top-down row is flipped here.
	vr.readHudPatchStats=function(layer,cxTop,cyTop,half)
	{
		if(!vr.hud)
		{
			return { lum:0, alpha:0, n:0 };
		}
		var W=vr.hud.w,H=vr.hud.h;
		var x0=Math.max(0,cxTop-half),x1=Math.min(W,cxTop+half);
		var gy0=Math.max(0,H-(cyTop+half)),gy1=Math.min(H,H-(cyTop-half));
		var w=x1-x0,h=gy1-gy0;
		var rfb=GLctx.createFramebuffer();
		var prev=GLctx.getParameter(GLctx.READ_FRAMEBUFFER_BINDING);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,rfb);
		GLctx.framebufferTextureLayer(GLctx.READ_FRAMEBUFFER,GLctx.COLOR_ATTACHMENT0,vr.hud.tex,0,layer);
		var px=new Uint8Array(w*h*4);
		GLctx.readPixels(x0,gy0,w,h,GLctx.RGBA,GLctx.UNSIGNED_BYTE,px);
		GLctx.bindFramebuffer(GLctx.READ_FRAMEBUFFER,prev);
		GLctx.deleteFramebuffer(rfb);
		var lum=0,alpha=0,n=px.length/4;
		for(var i=0; i<px.length; i+=4)
		{
			lum+=0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
			alpha+=px[i+3];
		}
		return { lum:lum/n, alpha:alpha/n, n:n };
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
			canvas.width=DIAL_CANVAS_PX;
			canvas.height=DIAL_CANVAS_PX;
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

	// dialRedrawKey: headless-probe helper for scripts/smoke-vrgui.mjs. The
	// real per-hand quad's redraw gate (updateDialLayers) lives entirely
	// behind vr.mvBinding, which requires a genuine WebXR session and so
	// cannot be driven headless -- but its redraw DECISION (dialRedrawKey
	// above) is a plain, pure function of vr.ctl.dial[hand]'s own state, so
	// it can be probed directly: exercises the EXACT SAME function the real
	// gate calls, proving a guiSel-only change (no dial.sel change) is
	// actually detected -- the AP-menu no-highlight bug this guards against.
	vr.dialRedrawKey=function(hand)
	{
		var dial=vr.ctl.dial[hand];
		return dialRedrawKey(dial,dial.guiMode||null);
	};

	// ---- Headless dial-FACE harness (scripts/smoke-vrdialface.mjs) --------
	// Three rounds of "stale GUN highlight" fixes asserted only on internal
	// pick state (dial.sel / dialRedrawKey) while the user-visible RENDER
	// path -- updateDialLayers' redraw gate, drawn* bookkeeping, and the
	// visible/inLayers lifecycle -- never ran headless at all (early-out on
	// !vr.mvBinding).  These hooks close that gap: tickDialFace drives the
	// REAL updateDialLayers (vr.testDialFace makes ensureDialResources hand
	// out a canvas-only resource and skips just the GL upload/renderState
	// steps), so a test can poke Quest-shaped controller entries through
	// pokeControllerFrame and then read back the canvas AS THE GATE LAST
	// PAINTED IT -- unlike vr.dumpDialLayer above, which always repaints
	// fresh and therefore can never catch a stale-gate bug.
	vr.tickDialFace=function()
	{
		vr.testDialFace=true;
		// Apply the "pending render state" one frame late, exactly like
		// XRSession.updateRenderState: what syncRenderStateLayers decided at
		// the END of the previous tick (res.inLayers) is what the compositor
		// model considers live DURING this tick.
		var hands=['right','left'];
		for(var i=0; i<hands.length; ++i)
		{
			var res=vr.dialRes[hands[i]];
			if(res)
			{
				res.inAppliedRenderState=res.inLayers;
			}
		}
		updateDialLayers(null);
	};
	// The per-hand face as the user would SEE it: the compositor model's
	// presented buffer in harness mode (null before anything was ever
	// presented).  NO repaint happens here -- that is the whole point.
	vr.dumpRenderedDialFace=function(hand)
	{
		var res=vr.dialRes[hand];
		if(!res)
		{
			return null;
		}
		var c=res.presentedCanvas||res.canvas;
		return c ? c.toDataURL('image/png') : null;
	};
	// Pixel probe into the LAST-PAINTED canvas: over a small patch centred
	// on the given canvas coordinates, the mean RGBA plus a count of
	// "selection accent" pixels (the amber tick/arrowhead drawDial paints
	// ONLY on the selected sector: rgba(255,214,64,0.95) / #ffe066, vs the
	// faint gray-blue ticks everywhere else) -- lets a test assert WHICH
	// sector the LAST PAINT highlighted without PNG round-trips.
	vr.readRenderedDialPatch=function(hand,cxPix,cyPix,half)
	{
		var res=vr.dialRes[hand];
		var ctx=(res ? (res.presentedCtx||res.ctx) : null);
		if(!ctx)
		{
			return null;
		}
		half=half||6;
		var d=ctx.getImageData(cxPix-half,cyPix-half,2*half,2*half).data;
		var n=d.length/4,r=0,g=0,b=0,a=0,accent=0;
		for(var i=0; i<n; ++i)
		{
			var pr=d[i*4],pg=d[i*4+1],pb=d[i*4+2],pa=d[i*4+3];
			r+=pr; g+=pg; b+=pb; a+=pa;
			if(128<pa && 200<pr && 150<pg && pb<130)
			{
				++accent;
			}
		}
		return {r:r/n,g:g/n,b:b/n,a:a/n,accent:accent};
	};
	// Full per-frame trace of everything the gate and the pick depend on --
	// the "instrument deeper" channel if the visual repro ever goes quiet.
	vr.dialFaceDebug=function(hand)
	{
		var dial=vr.ctl.dial[hand];
		var res=vr.dialRes[hand];
		return {
			sel:dial.sel,
			guiSel:dial.guiSel,
			picking:!!dial.picking,
			visible:!!dial.visible,
			guiMode:dial.guiMode||null,
			redrawKey:dialRedrawKey(dial,dial.guiMode||null),
			inLayers:(res ? !!res.inLayers : null),
			drawnSel:(res ? res.drawnSel : null),
			drawnGuiMode:(res ? res.drawnGuiMode : null)
		};
	};

	// dumpPerfPlacard: headless-probe helper, the perf-placard counterpart of
	// dumpDialLayer above, so a human/script can eyeball what the perf
	// placard (drawPerfPlacard) actually renders without a real WebXR
	// session/quad-layer (ensurePerfResources requires vr.mvBinding/
	// vr.viewerSpace, neither of which exist in the headless test harness --
	// vr.forceMultiview does not stand up a real WebXR layers binding, see
	// its doc comment). Draws through the EXACT SAME drawPerfPlacard the
	// real head-locked quad uses, onto a throwaway 2D canvas -- a readback
	// of the real placard content, not a reimplementation of it.
	vr.dumpPerfPlacard=function()
	{
		try
		{
			var canvas=document.createElement('canvas');
			canvas.width=PERF_CANVAS_W;
			canvas.height=PERF_CANVAS_H;
			var ctx=canvas.getContext('2d');
			drawPerfPlacard(ctx);
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
