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
    functions to a dialog they didn't open. Discoverability: the owner hand's
    quad is FORCED visible for as long as a dialog stays open (regardless of
    thumbstick engagement) and switches to a dialog-guide face -- N sectors
    numbered 1..N labelled with the
    dialog's REAL option text when drivable, or a uniform "ESC" face (with a
    "see panel" hint once the panel is forced) otherwise -- see
    drawGuiDialGuide/rdial.guiMode/rdial.guiMenu (ldial.* symmetrically);
    falls back to the normal dial the instant the dialog closes. Grip-stick
    (aileron/elevator/rudder) and the throttle grip are NEVER affected, on
    EITHER hand: the plane keeps flying regardless of any open dialog. A
    haptic pulse fires on every sector change in guide mode too (the SAME
    updateDialStick pick the normal dial uses, just quantized to the
    dialog's own N wedges instead of the fixed table's N -- see its doc
    comment), standing in for the visual feedback a pilot not looking at
    the guide quad would otherwise miss.
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
			// Left X button: same tap-vs-long-press shape as aBtn (owned
			// included), but the long action toggles the help placards
			// instead of recentering (see toggleHelp,
			// processControllerPlain's left-hand branch). helped mirrors
			// aBtn.recentered: fires toggleHelp at most once per hold.
			xBtn:{pressed:false,pressAt:0,helped:false,owned:false},
			// Right B / left Y previous-press state -- re-added ONLY for the
			// dialog-owner cancel press-edge (see processControllerPlain's
			// rActive/lActive branches); the normal, non-owner B/Y dispatch
			// stays pure level-sensed vrKeyEdge and needs no edge memory of
			// its own. The *Swallow flags latch a press that overlapped
			// dialog ownership (the cancel press itself, or a brake/flap-up
			// press held from before the dialog opened): a successful
			// Escape closes the dialog out from under the still-held
			// button, and without the latch the very next frame's non-owner
			// path would fire the normal air-brake/flaps-up key. Swallowed
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
			dial:{
				right:{sel:0,guiSel:0,engaged:null,visible:false,hideAt:0},
				left:{sel:0,guiSel:0,engaged:null,visible:false,hideAt:0}
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
		// [5] 300deg. FSBTF_AUTOTRIM (KeyT): a level-sensed virtual button
		// (same fscontrol.cpp switch as FIREWEAPON/DISPENSEFLARE) -- fires
		// while held, so 'hold' (holding it trims continuously; releasing
		// stops).
		{label:'トリム',  code:'KeyT',     mode:'hold'}
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
		if(DIAL_SELECT_THRESHOLD<mag)
		{
			if(guiSectorN)
			{
				pickDialSector(dial,'guiSel',x,upY,guiSectorN,rawSrc);
			}
			else
			{
				pickDialSector(dial,'sel',x,upY,sectorN,rawSrc);
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
				rdial.visible=true;
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

			// Left X: mirrors the right hand's A tap-vs-long-press pattern
			// (see A_TAP_MAX_MS/A_RECENTER_MS above, vr.ctl.xBtn), but the
			// LONG action here is toggleHelp, not recenter: a quick
			// press+release (<A_TAP_MAX_MS) taps the flaps-down key
			// (FSBTF_FLAPDOWN steps one flap position per press, so a real
			// tap -- not the old held vrKeyEdge -- matches its semantics);
			// held >=A_RECENTER_MS instead toggles the help placards once
			// per hold and suppresses the flap tap on the eventual release.
			// While THIS hand owns an open dialog (lActive), the quick-tap
			// flap dispatch is parked (same reasoning as the right hand's A
			// above -- no face-button fumble mid-dialog), but the long-press
			// help toggle stays live regardless -- it is a view-only action,
			// not a flight or dialog control (same reasoning as the right
			// hand's A long-press recenter staying live during dialogs).
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
				xBtn.owned=true; // see xBtn's doc comment: no tap on release.
			}
			if(xPressed && !xBtn.helped && (xNow-xBtn.pressAt)>=A_RECENTER_MS)
			{
				toggleHelp(rawSrc);
				xBtn.helped=true;
			}
			if(!xPressed && xBtn.pressed && !xBtn.helped && (xNow-xBtn.pressAt)<A_TAP_MAX_MS)
			{
				if(!lActive && !xBtn.owned)
				{
					vrKeyTap('KeyF'); // Default flaps-down key: a real tap, one flap step per press.
				}
			}
			xBtn.pressed=xPressed;

			// Left Y: normally a held flaps-up key; while THIS hand owns an
			// open dialog, Y is instead the truthful cancel/Escape binding,
			// exactly mirroring the right hand's B above -- fired on the
			// press edge, plus a release-if-held safety so a flaps-up hold
			// from before the dialog opened doesn't stay stuck on.
			var yPressed=!!(entry.buttons && entry.buttons.b);
			if(lActive && yPressed)
			{
				// Same swallow-until-release rule as the right B above (see
				// vr.ctl.leftYSwallow's doc comment): without it, the very
				// cancel press that closes the dialog would fire flaps-up
				// off the still-held button one frame later.
				vr.ctl.leftYSwallow=true;
			}
			if(!lActive)
			{
				vrKeyEdge('KeyR',yPressed && !vr.ctl.leftYSwallow); // Default flaps-up key.
			}
			else
			{
				vrKeyEdge('KeyR',false);
				if(yPressed && !vr.ctl.leftY)
				{
					vrHapticPulse(rawSrc);
					vrKeyTap('Escape');
				}
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
					// xr-standard buttons[3] = thumbstick click -- INERT.
					// processControllerPlain no longer reads this at all
					// (pressing the stick physically jolts it, awkward in
					// VR); kept only so the plain shape stays uniform with
					// pokeControllerFrame's, which smoke tests still poke to
					// assert the no-op.
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
			// Redraw when the sticky sector selection changes, OR the
			// guiMode changes (a dialog just opened/closed/switched between
			// apMenu and generic). stateSig is still tracked/compared here
			// too (harmless -- drawDial no longer paints aircraft state
			// on the normal face, see its doc comment, so a state-only
			// change now just re-draws identical pixels) rather than
			// threading a third redraw condition's removal through this
			// call, dumpDialLayer, and drawDial's shared signature.
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
			{cx:64, cy:132, label:'X',        label2:'フラップ下げ(長押し:ヘルプ)'},
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
			vr.jsPerfWindow=t;
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
		vr.jsPerf={ctl:0,dial:0,layers:0};
		vr.jsPerfWindow=0;
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
					vr.ctl.dial.right={sel:0,guiSel:0,engaged:null,visible:false,hideAt:0};
					vr.ctl.dial.left={sel:0,guiSel:0,engaged:null,visible:false,hideAt:0};
					vr.ctl.gripPose={right:null,left:null};
					vr.viewerSpace=null;
					vr.dialRes={right:undefined,left:undefined};
					vr.helpRes={right:undefined,left:undefined};
					vr.help={visible:false,shownAt:0};
					vr.perfRes=undefined;

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
	//         buttons:{a:bool,b:bool,stick:bool (optional, xr-standard
	//         thumbstick click -- INERT, processControllerPlain no longer
	//         reads it; kept only so tests can assert the no-op. A held long
	//         (right) recenters/(left) toggles help via vr.ctl.aBtn/xBtn; B
	//         (right)/Y (left) cancel an owned dialog -- see toggleHelp/
	//         processControllerPlain)}}
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
