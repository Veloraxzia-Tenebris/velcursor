/* global window, document, requestAnimationFrame */
// neovide-cursor.js
//
// Core architecture, rendering order, and physics
//
// 1) Mass-spring corner tracking
// The cursor is decomposed into four corner points. Each corner is an independent spring.
// This permits shear and stretch during high-speed motion.
//
// 2) Rank-based dynamic factor
// Corners are ranked by alignment with the movement direction. Leading corners respond faster.
// Trailing corners lag more. This yields stretch then snap-back behavior.
//
// 3) Dense interpolated polygon ribbon trail
// Trail samples are inserted with interpolation between sparse motion samples, then rendered as
// swept filled polygon quads with TTL fade for smooth continuity.
//
// 4) Trail-only motion + persistent hollow caret box
// During motion, only the ribbon trail is rendered.
// The hollow caret box always follows the live caret.
//
// 5) Monaco-layered canvas (under native caret)
// The overlay canvas is attached to the active Monaco host and rendered below caret layers.
// Native Monaco caret stays visible above custom trail/box rendering.
//
// ----------------------------------------------------------------------
// Dynamics Math Notes (centralized)
// ----------------------------------------------------------------------
//
// A) Critically damped corner springs (per axis)
//    State is tracked as offset from target destination:
//      x = current - destination
//      v = dx/dt
//
//    ODE:
//      x'' + 2*w*x' + w^2*x = 0
//      w = 4 / tau
//
//    Closed-form step over dt:
//      a = x0
//      b = v0 + w*x0
//      x(t) = (a + b*t) * e^(-w*t)
//      v(t) = (b - w*(a + b*t)) * e^(-w*t)
//
// B) Overshoot oscillator (size-only, separate from corner springs)
//      x'' + 2*z*w*x' + w^2*x = 0
//      a = -2*z*w*v - w^2*x
//      v_{n+1} = v_n + a*dt
//      x_{n+1} = x_n + v_{n+1}*dt
//    Motion applies impulses with:
//      v <- v + impulse
//
// C) Corner ranking and response
//      dir = normalize([dx, dy])
//      align_i = rel_i . dir
//    sort align_i ascending => trailing ... leading
//    rankFactor[rank] scales tau per corner.
//
// D) Snap + clamp rules
//    Leading hard-snap impulse:
//      c <- c + alpha * (dest - prev_dest)
//    Stretch clamp:
//      S = maxTrailDistanceFactor * max(w, h)
//      c in [dest - S, dest + S]
//
// ASCII corner index layout:
//      (0)------(1)
//       |        |
//       |   +x   |
//       |   +y   |
//      (3)------(2)
//
// ASCII overshoot signal flow:
//      cursor motion ---> kick ---> v ----> oscillator ----> x ----> size scale

const vscode = require("vscode");

let trailActive = false;

function hasRendererDom() {
	return typeof window !== "undefined" && typeof document !== "undefined";
}

function activate() {
	if (trailActive) return false;

	if (!hasRendererDom()) {
		vscode.window.showWarningMessage("Cursor trail can only run in the editor renderer process.");
		return false;
	}

	installTrailInDom();
	trailActive = true;
	vscode.window.setStatusBarMessage("Cursor trail activated.", 1500);
	return true;
}

function deactivate() {
	if (!trailActive) return false;

	if (hasRendererDom() && typeof window.__neovideCursorCleanup === "function") {
		window.__neovideCursorCleanup();
	}

	trailActive = false;
	vscode.window.setStatusBarMessage("Cursor trail deactivated.", 1500);
	return true;
}

function isActive() {
	return trailActive;
}

function installTrailInDom() {
	"use strict";

	// ======================================================================
	// SECTION 1: Configuration
	// ======================================================================

	const CFG = {
		// Units: CSS color string.
		// Range: Any valid CSS color (recommended hex like #RRGGBB or #RRGGBBAA).
		// +: Brighter/lighter colors increase perceived trail prominence.
		// -: Darker/muted colors reduce trail prominence.
		color: "#FFC0CB",

		// Units: Unitless alpha multiplier.
		// Range: [0, 1].
		// +: Trail becomes more opaque and visually stronger.
		// -: Trail becomes more transparent and subtle.
		opacity: 0.69,

		shadow: {
			// Units: Boolean flag.
			// Range: true | false.
			// +: true enables glow/shadow contribution around custom rendering.
			// -: false disables glow/shadow contribution.
			enabled: true,

			// Units: CSS color string or null.
			// Range: null or any valid CSS color string.
			// +: Brighter/saturated override color makes glow more noticeable.
			// -: Darker/transparent override color makes glow less noticeable.
			color: "#ff00b3",

			// Units: Unitless blur multiplier.
			// Range: >= 0 (recommended [0, 2]).
			// +: Softer, wider glow radius.
			// -: Tighter, crisper glow radius.
			blurFactor: 1.05
		},

		// Trail sample polygon source settings (from spring corners).
		rect: {
			// Units: px.
			// Range: >= 0.
			// +: Trail polygon expands farther from spring corners.
			// -: Trail polygon hugs spring corners more tightly.
			padPx: 2,
			// Units: px.
			// Range: >= 0.
			// +: Reserved setting (currently no active runtime effect).
			// -: Reserved setting (currently no active runtime effect).
			radiusPx: 16
		},

		// Hollow caret box settings (drawn around the live caret).
		box: {
			// Units: px.
			// Range: >= 0.
			// +: Larger base padding at reference font size.
			// -: Smaller base padding at reference font size.
			// Runtime scales this by current font size.
			padPx: 4,
			// Units: px.
			// Range: >= 0.
			// +: Larger base corner radius at reference font size.
			// -: Smaller base corner radius at reference font size.
			// Runtime scales this by current font size.
			radiusPx: 4,
			// Units: px.
			// Range: > 0.
			// +: Hollow box stroke gets thicker and more visible.
			// -: Hollow box stroke gets thinner and lighter.
			lineWidthPx: 2,

			// Units: px.
			// Range: > 0.
			// +: Higher reference lowers runtime scaling for same active font size.
			// -: Lower reference raises runtime scaling for same active font size.
			scaleRefFontSizePx: 14,

			// Units: CSS color string or null.
			// Range: null or any valid CSS color string.
			// +: Brighter/saturated color increases hollow box prominence.
			// -: Darker/transparent color decreases hollow box prominence.
			// null => use top-level trail `color`.
			color: "#FFC0CB",

			// Units: unitless alpha multiplier or null.
			// Range: null or [0, 1].
			// +: Higher value makes hollow box more opaque.
			// -: Lower value makes hollow box more transparent.
			// null => use top-level trail `opacity`.
			opacity: 0.47
		},

		// Trail density and fade behavior.
		trail: {
			// Units: ms.
			// Range: > 0.
			// +: Trail persists longer before fully fading out.
			// -: Trail disappears sooner.
			ttlMs: 256,
			// Units: count (samples).
			// Range: integer >= 1.
			// +: Denser/longer history, but higher CPU/GPU cost.
			// -: Shorter history, lower cost.
			maxRects: 30,
			// Units: unitless alpha floor.
			// Range: [0, 1].
			// +: Old trail never gets very faint; tail stays visible longer.
			// -: Old trail can fade closer to fully transparent.
			minAlpha: 0.0,
			// Units: px.
			// Range: >= 0.
			// +: Requires larger movement before adding a new trail sample.
			// -: Captures smaller motions; increases sample frequency.
			minMovePx: 0.08,
			// Units: character widths.
			// Range: >= 0.
			// +: Suppresses trail for more short caret hops (e.g., normal typing).
			// -: Allows trail on shorter caret hops.
			minMoveCharsForTrail: 1.5,
			// Units: px.
			// Range: >= 0.
			// +: Suppresses tiny corner-shape changes more aggressively.
			// -: Allows subtle corner changes to create trail samples.
			cornerInterpEpsilonPx: 0.02,
			// Units: px.
			// Range: > 0.
			// +: Wider interpolation spacing; fewer intermediate samples.
			// -: Tighter interpolation spacing; more intermediate samples.
			interpStepPx: 0.02,
			// Units: px.
			// Range: > 0.
			// +: Reduces adaptive insertion density (less smoothing, faster).
			// -: Increases adaptive insertion density (smoother, heavier).
			adaptiveInterpStepPx: 0.32,
			// Units: count (samples per push).
			// Range: integer >= 1.
			// +: Allows denser gap filling for large motion jumps.
			// -: Hard-limits insertion more aggressively for performance.
			maxInterpPerPush: 4,
			// Units: px.
			// Range: > 0.
			// +: Fewer draw-time subdivisions across long spans.
			// -: More draw-time subdivisions for smoother ribbons.
			drawSubdivideStepPx: 0.72,
			// Units: count (subdivisions per pair).
			// Range: integer >= 1.
			// +: Allows more geometric refinement (smoother, heavier).
			// -: Caps refinement earlier (faster, potentially rougher).
			maxDrawSubdivisions: 6,
			// Units: count (polygon sides).
			// Range: integer >= 3.
			// +: Smoother, rounder ribbon cells that better conform to the trail.
			// -: Fewer sides reduce draw cost but increase faceting.
			ribbonSides: 4,
			// Units: count (polygon sides).
			// Range: integer >= 3.
			// +: Preserves more contour detail at low quality.
			// -: Drops detail further to save more resources under pressure.
			ribbonSidesMin: 4,
			// Units: Boolean flag.
			// Range: true | false.
			// +: true enforces corner correspondence to reduce twist artifacts.
			// -: false may allow occasional index/winding mismatches.
			twistGuardEnabled: true,
			// Units: unitless blend factor.
			// Range: [0, 1].
			// +: Stronger temporal smoothing; less jitter but more lag.
			// -: More immediate response; can look noisier.
			temporalSmoothFactor: 0.32,
			// Units: px.
			// Range: > 0.
			// +: Keeps smoothing active for larger movements.
			// -: Releases smoothing sooner during motion.
			smoothReleaseDistancePx: 64,
			// Units: px per pushed sample.
			// Range: >= 0.
			// +: Permits larger per-sample corner jumps (snappier, riskier).
			// -: Tighter per-sample corner clamp (smoother, more damped).
			cornerStepClampPx: 8,
			// Units: px allowance per px center movement.
			// Range: >= 0.
			// +: Corner clamp loosens more during fast center motion.
			// -: Corner clamp stays stricter even at higher speed.
			cornerStepSpeedScale: 4,

			stackHex: {
				// Units: Boolean flag.
				// Range: true | false.
				// +: true enables stacked concave-hex trail cell rendering.
				// -: false keeps the simple ribbon trail renderer.
				enabled: false,
				// Units: unitless fraction.
				// Range: [0, 1].
				// +: Shares more of each side edge with the next cell.
				// -: Shares less and makes cells more distinct.
				partialEdgeShare: 0.35,
				// Units: unitless fraction of local cell width.
				// Range: >= 0.
				// +: Stronger concave pull near the base edge.
				// -: Flatter, less concave cell profile.
				concavityDepth: 0.18,
				// Units: count (cells).
				// Range: integer >= 0.
				// +: More head cells switch to real quads near the caret.
				// -: Fewer head cells use real quads.
				headQuadCells: 2,
				// Units: keyword.
				// Range: "forward" | "backward".
				// +: "forward" points concavity toward motion.
				// -: "backward" points concavity opposite motion.
				concavityDirection: "forward",
				// Units: Boolean flag.
				// Range: true | false.
				// +: true uses fill-only cells (no outlines).
				// -: false also draws cell outlines.
				fillOnly: true,
				// Units: px.
				// Range: >= 0.
				// +: Higher value tolerates slightly looser overlap checks.
				// -: Lower value enforces stricter non-overlap behavior.
				overlapEpsilonPx: 0.25,
				// Units: px.
				// Range: > 0.
				// +: Higher value avoids very thin/degenerate cell widths.
				// -: Lower value allows thinner cells.
				minCellWidthPx: 0.8,
				// Units: count (cells per frame).
				// Range: integer >= 1.
				// +: More cells for finer geometric detail.
				// -: Fewer cells for lower render cost.
				maxCellsPerFrame: 48,

				// Dynamic size controller for smoothness/detail demand.
				// Units: Boolean flag.
				// Range: true | false.
				// +: true dynamically adjusts cell length/width.
				// -: false keeps fixed base sizing.
				dynamicSizeEnabled: true,
				// Units: px.
				// Range: > 0.
				// +: Larger nominal along-motion cell length.
				// -: Shorter nominal along-motion cell length.
				baseLenPx: 11,
				// Units: px.
				// Range: > 0.
				// +: Higher floor prevents very short cells in high-detail regions.
				// -: Lower floor allows denser/smaller cells.
				minLenPx: 4,
				// Units: px.
				// Range: >= minLenPx.
				// +: Larger cap allows coarser cells in low-detail regions.
				// -: Smaller cap limits coarse stretching.
				maxLenPx: 22,
				// Units: unitless width scale.
				// Range: > 0.
				// +: Larger floor keeps cells thicker at high detail.
				// -: Smaller floor allows narrower cells.
				minWidthScale: 0.72,
				// Units: unitless width scale.
				// Range: >= minWidthScale.
				// +: Larger cap allows thicker/coarser cells.
				// -: Smaller cap limits width growth.
				maxWidthScale: 1.25,
				// Units: radians.
				// Range: > 0.
				// +: Higher value reduces curvature sensitivity.
				// -: Lower value increases curvature sensitivity.
				curvatureNormRad: 0.18,
				// Units: px.
				// Range: > 0.
				// +: Higher value reduces slow-speed detail sensitivity.
				// -: Lower value increases slow-speed detail sensitivity.
				speedNormPx: 20,
				// Units: unitless multiplier.
				// Range: >= 1.
				// +: Higher value coarsens cells more under low quality.
				// -: Lower value preserves detail more under low quality.
				qualityCoarsenMax: 1.8,
				// Units: unitless weight.
				// Range: >= 0.
				// +: Higher value increases curvature contribution to detail demand.
				// -: Lower value decreases curvature contribution.
				curvatureWeight: 0.55,
				// Units: unitless weight.
				// Range: >= 0.
				// +: Higher value increases speed contribution to detail demand.
				// -: Lower value decreases speed contribution.
				speedWeight: 0.25,
				// Units: unitless weight.
				// Range: >= 0.
				// +: Higher value increases near-head refinement bias.
				// -: Lower value decreases head refinement bias.
				headWeight: 0.2,
				// Units: unitless alpha.
				// Range: [0, 1].
				// +: Higher value reacts faster to target length changes.
				// -: Lower value smooths length transitions more.
				sizeLerpAlpha: 0.35,
				// Units: unitless alpha.
				// Range: [0, 1].
				// +: Higher value reacts faster to width-scale changes.
				// -: Lower value smooths width transitions more.
				widthLerpAlpha: 0.3,
				// Units: degrees.
				// Range: >= 0.
				// +: Higher tolerance allows more perpendicularity slack.
				// -: Lower tolerance enforces stricter perpendicularity.
				perpToleranceDeg: 4
			}
		},

		performance: {
			// Units: Boolean flag.
			// Range: true | false.
			// +: true enables continuous adaptive quality based on frame pressure + move distance.
			// -: false disables adaptive quality; always use full trail quality.
			enabled: true,

			// Units: ms.
			// Range: > 0.
			// +: Higher target tolerates slower frames before reducing quality.
			// -: Lower target reacts earlier to frame-time pressure.
			targetFrameMs: 16.7,

			// Units: ms.
			// Range: > 0.
			// +: Wider window delays pressure ramp-up.
			// -: Narrower window ramps pressure faster.
			framePressureWindowMs: 8.0,

			// Units: unitless EMA alpha.
			// Range: (0, 1].
			// +: Higher value tracks frame spikes more aggressively.
			// -: Lower value smooths frame pressure more.
			emaAlpha: 0.16,

			// Units: px.
			// Range: > 0.
			// +: Larger normalization makes distance pressure less sensitive.
			// -: Smaller normalization makes distance pressure more sensitive.
			distanceNormPx: 120,

			// Units: unitless weight.
			// Range: >= 0.
			// +: Increases influence of frame-time pressure on quality.
			// -: Decreases influence of frame-time pressure.
			frameWeight: 0.7,

			// Units: unitless weight.
			// Range: >= 0.
			// +: Increases influence of move distance on quality.
			// -: Decreases influence of move distance.
			distanceWeight: 0.3,

			// Units: unitless quality floor.
			// Range: (0, 1].
			// +: Higher floor preserves more visual quality under load.
			// -: Lower floor allows stronger quality reduction for performance.
			qualityMin: 0.38,

			// Units: quality units per second.
			// Range: >= 0.
			// +: Drops quality faster when pressure increases.
			// -: Drops quality more gradually.
			degradeRatePerSec: 4.5,

			// Units: quality units per second.
			// Range: >= 0.
			// +: Recovers quality faster when pressure subsides.
			// -: Recovers quality more gradually.
			recoverRatePerSec: 1.6,

			// Units: unitless threshold.
			// Range: [0, 1].
			// +: Keeps adaptation focused on subdivisions for longer.
			// -: Allows blur/history adaptation to start earlier.
			subdivideOnlyThreshold: 0.68,

			// Units: unitless threshold.
			// Range: [0, 1].
			// +: Delays blur attenuation to lower quality levels.
			// -: Starts blur attenuation sooner.
			blurStartThreshold: 0.66,

			// Units: unitless threshold.
			// Range: [0, 1].
			// +: Delays history-length reduction to lower quality levels.
			// -: Starts history-length reduction sooner.
			historyStartThreshold: 0.50,

			// Units: Boolean flag.
			// Range: true | false.
			// +: true adapts effective render cadence to quality/motion pressure.
			// -: false draws every animation frame.
			adaptiveFpsEnabled: false,

			// Units: frames per second.
			// Range: > 0.
			// +: Higher value keeps full-rate rendering under light pressure.
			// -: Lower value reduces CPU/GPU load even when quality is high.
			activeFps: 60,

			// Units: frames per second.
			// Range: > 0.
			// +: Higher value preserves more temporal smoothness while degraded.
			// -: Lower value saves more resources under moderate pressure.
			degradedFps: 45,

			// Units: frames per second.
			// Range: > 0.
			// +: Higher value smooths heavy-load motion more.
			// -: Lower value prioritizes responsiveness/stability under spikes.
			heavyFps: 30,

			// Units: frames per second.
			// Range: > 0.
			// +: Higher value refreshes idle/fading frames more frequently.
			// -: Lower value minimizes idle render overhead.
			idleFps: 20,

			// Units: unitless quality threshold.
			// Range: [0, 1].
			// +: Higher threshold enters degraded cadence sooner.
			// -: Lower threshold keeps active cadence longer.
			degradedFpsQuality: 0.82,

			// Units: unitless quality threshold.
			// Range: [0, 1].
			// +: Higher threshold enters heavy cadence sooner.
			// -: Lower threshold delays heavy cadence.
			heavyFpsQuality: 0.62,

			// Units: ms.
			// Range: >= 0.
			// +: Higher value reduces expensive layout reads more aggressively.
			// -: Lower value tracks layout changes more closely.
			layoutPollIntervalMs: 120,

			// Units: count (subdivisions per frame).
			// Range: integer >= 1.
			// +: Higher value allows more geometric refinement each frame.
			// -: Lower value caps draw work harder during stress.
			maxSubdivisionsPerFrame: 120,

			// Units: Boolean flag.
			// Range: true | false.
			// +: true uses a low-call ribbon strip renderer by default.
			// -: false always uses the legacy per-edge quad path.
			fastPathEnabled: false,

			// Units: Boolean flag.
			// Range: true | false.
			// +: true falls back to legacy rendering if fast-path validity checks fail.
			// -: false skips invalid segments instead of drawing legacy fallback.
			fastPathFallbackLegacy: true
		},

		// Base spring timing for corner motion.
		animation: {
			// Units: seconds.
			// Range: > 0.
			// +: Slower spring response with longer trailing lag.
			// -: Faster spring response with tighter tracking.
			length: 0.25,
			// Units: seconds.
			// Range: > 0.
			// +: Slower response during short moves.
			// -: Snappier response during short moves.
			shortLength: 0.125,
			// Units: px.
			// Range: >= 0.
			// +: More moves qualify as "shortLength" behavior.
			// -: Fewer moves qualify as "shortLength" behavior.
			shortMoveThresholdPx: 32
		},

		// Corner-physics response shaping (lag, snap, and stretch clamping).
		dynamics: {
			// Units: unitless multipliers [trailing, mid, mid, leading].
			// Range: each entry > 0.
			// +: Increasing an entry slows that rank's response.
			// -: Decreasing an entry speeds that rank's response.
			rankFactors: [0.8, 0.4, 0.4, 0.2],

			// Units: Boolean flag.
			// Range: true | false.
			// +: true enables leading-corner snap assist.
			// -: false uses pure spring behavior without snap assist.
			hardSnap: false,

			// Units: unitless fraction.
			// Range: [0, 1].
			// +: Stronger direct catch-up jump on leading corners.
			// -: Weaker direct jump; more spring-driven motion.
			leadingSnapFactor: 0.1,

			// Units: unitless threshold.
			// Range: [0, 1].
			// +: Snap applies to fewer corners (more selective).
			// -: Snap applies to more corners (less selective).
			leadingSnapThreshold: 0.32,

			// Units: seconds.
			// Range: > 0.
			// +: Reserved setting (currently no active runtime effect).
			// -: Reserved setting (currently no active runtime effect).
			animationResetThresholdSec: 0.1,

			// Units: unitless size multiplier.
			// Range: > 0.
			// +: Allows more corner stretch/deformation.
			// -: Restricts stretch for tighter shape control.
			maxTrailDistanceFactor: 8,

			// Units: seconds.
			// Range: > 0.
			// +: Slower settle during hard-snap mode.
			// -: Sharper/faster settle during hard-snap mode.
			snapAnimationLength: 0.16
		},

		// Size-overshoot oscillator (separate from corner spring physics).
		overshoot: {
			// Units: Boolean flag.
			// Range: true | false.
			// +: true enables size overshoot bounce.
			// -: false disables size overshoot bounce.
			enabled: true,

			// Units: oscillator-velocity units per px.
			// Range: >= 0.
			// +: Stronger bounce impulse from movement.
			// -: Weaker bounce impulse from movement.
			kickPerPx: 0.64,

			// Units: oscillator-velocity units.
			// Range: >= 0.
			// +: Permits larger single-frame bounce kicks.
			// -: Limits bounce kick strength.
			maxKick: 16.0,

			// Units: rad/s.
			// Range: > 0.
			// +: Faster oscillation cycles.
			// -: Slower oscillation cycles.
			omega: 16,

			// Units: unitless damping ratio.
			// Range: >= 0 (typical [0, 1]).
			// +: Less ringing and quicker settle.
			// -: More ringing and longer bounce.
			zeta: 0.16,

			// Units: unitless gain.
			// Range: >= 0.
			// +: Larger visible scale expansion/contraction from same oscillator state.
			// -: Smaller visible scale expansion/contraction.
			gain: 0.64,

			// Units: unitless scale delta.
			// Range: <= maxScale.
			// +: Raises lower bound (less inward shrink).
			// -: Lowers lower bound (allows deeper inward shrink).
			minScale: -0.04,

			// Units: unitless scale delta.
			// Range: >= minScale.
			// +: Allows larger peak outward expansion.
			// -: Limits outward expansion.
			maxScale: 0.32,

			// Units: oscillator position units.
			// Range: >= 0.
			// +: Looser settle threshold; overshoot considered settled sooner.
			// -: Stricter settle threshold; overshoot considered active longer.
			settlePosEps: 0.32,
			// Units: oscillator velocity units.
			// Range: >= 0.
			// +: Looser velocity settle threshold; settles sooner.
			// -: Stricter velocity settle threshold; settles later.
			settleVelEps: 0.32
		},

		idle: {
			// Units: ms.
			// Range: >= 0.
			// +: Wait longer before entering low-motion shadow-off mode.
			// -: Enter low-motion shadow-off mode sooner.
			switchDelayMs: 512,

			// Units: px.
			// Range: > 0.
			// +: Thicker legacy fallback stroke for hollow box.
			// -: Thinner legacy fallback stroke for hollow box.
			hollowLineWidthPx: 2
		},

		visibility: {
			// Units: ms.
			// Range: >= 0.
			// +: Keep overlay visible longer while cursor is temporarily missing.
			// -: Hide overlay sooner when cursor is missing.
			noCursorHideDelayMs: 50
		},

		typography: {
			// Units: em (relative to resolved font size).
			// Range: > 0.
			// +: Wider synthetic caret geometry.
			// -: Narrower synthetic caret geometry.
			caretWidthEm: 1,

			// Units: unitless multiplier.
			// Range: > 0.
			// +: Taller fallback synthetic caret height.
			// -: Shorter fallback synthetic caret height.
			lineHeightFallbackMultiplier: 1,

			// Units: px.
			// Range: >= 0.
			// +: Raises minimum caret width floor.
			// -: Lowers minimum caret width floor.
			minCaretWidthPx: 1,

			// Units: px.
			// Range: >= 0.
			// +: Raises minimum line-height floor.
			// -: Lowers minimum line-height floor.
			minLineHeightPx: 1,

			// Units: px.
			// Range: >= 0.
			// +: Ignore more tiny metric fluctuations.
			// -: Respond to smaller metric changes.
			metricEpsilonPx: 1
		},

		motion: {
			// Units: px.
			// Range: >= 0.
			// +: Requires larger center movement before counting as real motion.
			// -: Counts smaller center movement as real motion.
			centerMoveEpsilonPx: 0.75,

			// Units: px.
			// Range: >= 0.
			// +: Ignores more tiny width/height changes.
			// -: Processes subtler width/height changes.
			rectEpsilonPx: 1,

			// Units: Boolean flag.
			// Range: true | false.
			// +: true snaps center to pixel grid, reducing subpixel jitter.
			// -: false preserves raw subpixel center coordinates.
			snapCenterToDevicePixel: true
		}
	};

	// ======================================================================
	// SECTION 2: Utilities
	// ======================================================================

	const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
	const nowMs = () => performance.now();
	const getRectCenter = (r) => ({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
	const parsePx = (v) => {
		if (typeof v !== "string") return NaN;
		const n = parseFloat(v);
		return Number.isFinite(n) ? n : NaN;
	};

	const resolveLineHeightPx = (lineHeightRaw, fontSizePx) => {
		if (typeof lineHeightRaw !== "string") return NaN;
		const v = lineHeightRaw.trim();
		if (!v || v === "normal") return NaN;
		if (v.endsWith("px")) return parsePx(v);
		if (v.endsWith("%")) {
			const n = parseFloat(v);
			return Number.isFinite(n) && fontSizePx > 0 ? (fontSizePx * n) / 100 : NaN;
		}
		const n = parseFloat(v);
		return Number.isFinite(n) && fontSizePx > 0 ? fontSizePx * n : NaN;
	};

	const resolveFontMetricBox = (cursorEl) => {
		const editor = cursorEl?.closest?.(".monaco-editor") ?? null;
		const viewLines = editor?.querySelector?.(".view-lines") ?? null;
		const candidates = [viewLines, editor, cursorEl].filter(Boolean);

		let fontSizePx = NaN;
		let lineHeightPx = NaN;

		for (const el of candidates) {
			const cs = window.getComputedStyle(el);
			if (!(fontSizePx > 0)) {
				const fs = parsePx(cs.fontSize);
				if (fs > 0) fontSizePx = fs;
			}

			if (!(lineHeightPx > 0)) {
				const fsForLh = fontSizePx > 0 ? fontSizePx : parsePx(cs.fontSize);
				const lh = resolveLineHeightPx(cs.lineHeight, fsForLh);
				if (lh > 0) lineHeightPx = lh;
			}
		}

		if (!(fontSizePx > 0)) fontSizePx = 14;
		if (!(lineHeightPx > 0)) {
			lineHeightPx = fontSizePx * CFG.typography.lineHeightFallbackMultiplier;
		}

		return {
			width: Math.max(CFG.typography.minCaretWidthPx, fontSizePx * CFG.typography.caretWidthEm),
			height: Math.max(CFG.typography.minLineHeightPx, lineHeightPx),
			fontSizePx,
			lineHeightPx
		};
	};

	const snapToDevicePixel = (v) => {
		if (!CFG.motion.snapCenterToDevicePixel) return v;
		const dpr = window.devicePixelRatio || 1;
		return Math.round(v * dpr) / dpr;
	};

	const didCenterMove = (prevCenter, nextCenter, epsilon) => {
		if (!prevCenter || !nextCenter) return true;
		const dx = nextCenter.cx - prevCenter.cx;
		const dy = nextCenter.cy - prevCenter.cy;
		return Math.hypot(dx, dy) > epsilon;
	};

	const normalize2 = (x, y) => {
		const len = Math.hypot(x, y);
		return len ? { x: x / len, y: y / len } : { x: 0, y: 0 };
	};

	const resolveColor = (hex) => {
		let h = hex.startsWith("#") ? hex.slice(1) : hex;
		h = h.toUpperCase();
		if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
		if (h.length === 6) h += "FF";
		const r = parseInt(h.slice(0, 2), 16) >> 0;
		const g = parseInt(h.slice(2, 4), 16) >> 0;
		const b = parseInt(h.slice(4, 6), 16) >> 0;
		const a = parseInt(h.slice(6, 8), 16) >> 0;
		return { r, g, b, a };
	};

	const rgbaCss = ({ r, g, b, a }) => `rgba(${r}, ${g}, ${b}, ${a / 255})`;
	const TRAIL_WIDTH_ENVELOPE_AT = (frac) => 0.20 + 0.80 * (1 - frac);
	// Throttle expensive getComputedStyle font metric reads while keeping updates responsive.
	const FONT_METRIC_CACHE_MS = 250;
	// Cache resolved RGBA strings so hot-path draw avoids repeated hex parsing every frame.
	const renderStyleCache = {
		trailKey: "",
		trailOpacity: 1,
		trailColorCss: "rgba(255, 255, 255, 1)",
		boxKey: "",
		boxOpacity: 1,
		boxColorCss: "rgba(255, 255, 255, 1)",
		shadowKey: "",
		shadowColorCss: "rgba(255, 255, 255, 1)"
	};
	const getRenderStyles = () => {
		const trailOpacity = clamp(CFG.opacity, 0, 1);
		const trailKey = `${CFG.color}|${trailOpacity}`;
		if (trailKey !== renderStyleCache.trailKey) {
			const trailBase = resolveColor(CFG.color);
			trailBase.a = Math.round(255 * trailOpacity);
			renderStyleCache.trailOpacity = trailOpacity;
			renderStyleCache.trailColorCss = rgbaCss(trailBase);
			renderStyleCache.trailKey = trailKey;
		}

		const boxOpacity = clamp(CFG.box.opacity ?? trailOpacity, 0, 1);
		const boxColor = CFG.box.color ?? CFG.color;
		const boxKey = `${boxColor}|${boxOpacity}`;
		if (boxKey !== renderStyleCache.boxKey) {
			const boxBase = resolveColor(boxColor);
			boxBase.a = Math.round(255 * boxOpacity);
			renderStyleCache.boxOpacity = boxOpacity;
			renderStyleCache.boxColorCss = rgbaCss(boxBase);
			renderStyleCache.boxKey = boxKey;
		}

		const shadowKey = CFG.shadow.color ?? "__trail__";
		if (shadowKey !== renderStyleCache.shadowKey) {
			renderStyleCache.shadowColorCss = CFG.shadow.color ? rgbaCss(resolveColor(CFG.shadow.color)) : "";
			renderStyleCache.shadowKey = shadowKey;
		}

		return renderStyleCache;
	};

	// ======================================================================
	// SECTION 3: Monaco cursor discovery
	// ======================================================================

	function findMonacoCursorEl() {
		const cursors = document.querySelectorAll(".monaco-editor .cursor");
		for (const el of cursors) {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) return el;
		}
		return null;
	}

	function findCanvasHostForCursorEl(cursorEl) {
		if (!cursorEl) return null;
		const editor = cursorEl.closest(".monaco-editor");
		if (!editor) return null;
		return editor.querySelector(".overflow-guard") || editor;
	}

	function ensureNativeCaretLayerStyle() {
		const id = "__neovide_cursor_native_caret_layer__";
		let tag = document.getElementById(id);
		if (!tag) {
			tag = document.createElement("style");
			tag.id = id;
			document.head.appendChild(tag);
		}
		tag.textContent = `
			.monaco-editor .cursors-layer { z-index: 6 !important; }
			.monaco-editor .cursor { z-index: 7 !important; }
		`;
		return tag;
	}

	// ======================================================================
	// SECTION 4: Canvas overlay
	// ======================================================================

	function makeCanvas() {
		const id = "__neovide_cursor_canvas__";
		let canvas = document.getElementById(id);

		if (!canvas) {
			canvas = document.createElement("canvas");
			canvas.id = id;
			canvas.style.position = "absolute";
			canvas.style.left = "0";
			canvas.style.top = "0";
			canvas.style.width = "100%";
			canvas.style.height = "100%";
			canvas.style.pointerEvents = "none";
			// Keep custom trail/cursor above text but below Monaco caret layers.
			canvas.style.zIndex = "5";
			canvas.style.opacity = "0";
			document.body.appendChild(canvas);
		}

		const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
		return { canvas, ctx };
	}

	function resizeCanvas(canvas) {
		const dpr = window.devicePixelRatio || 1;
		const r = canvas.getBoundingClientRect();
		const w = Math.max(1, Math.floor(r.width * dpr));
		const h = Math.max(1, Math.floor(r.height * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
	}

	function attachCanvasToHost(canvas, host) {
		if (!host) return;
		if (canvas.parentElement === host) return;
		if (window.getComputedStyle(host).position === "static") {
			host.style.position = "relative";
		}
		host.appendChild(canvas);
	}

	function roundRectPath(ctx, x, y, w, h, r) {
		const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
		ctx.beginPath();
		ctx.moveTo(x + rr, y);
		ctx.lineTo(x + w - rr, y);
		ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
		ctx.lineTo(x + w, y + h - rr);
		ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
		ctx.lineTo(x + rr, y + h);
		ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
		ctx.lineTo(x, y + rr);
		ctx.quadraticCurveTo(x, y, x + rr, y);
		ctx.closePath();
	}

	// ======================================================================
	// SECTION 5: Critically damped spring (1D)
	// ======================================================================

	class CritDamped1D {
		constructor(timeConstantSec) {
			this.pos = 0;
			this.vel = 0;
			this.tau = timeConstantSec;
		}

		setTimeConstant(tau) {
			this.tau = tau;
		}

		reset() {
			this.pos = 0;
			this.vel = 0;
		}

		step(dt) {
			if (this.tau <= dt || Math.abs(this.pos) < 0.001) {
				this.reset();
				return false;
			}

			const o = 4.0 / this.tau;
			const a = this.pos;
			const b = this.pos * o + this.vel;
			const c = Math.exp(-o * dt);

			this.pos = (a + b * dt) * c;
			this.vel = c * (-a * o - b * dt * o + b);

			return Math.abs(this.pos) >= 0.01;
		}
	}

	// ======================================================================
	// SECTION 6: Small under-damped overshoot oscillator (scalar)
	// ======================================================================

	class UnderDampedScalar {
		constructor(omega, zeta) {
			this.x = 0;
			this.v = 0;
			this.omega = omega;
			this.zeta = zeta;
		}

		kick(impulse) {
			this.v += impulse;
		}

		step(dt) {
			const w = this.omega;
			const z = this.zeta;

			const a = -2 * z * w * this.v - (w * w) * this.x;
			this.v += a * dt;
			this.x += this.v * dt;

			// deadzone
			if (Math.abs(this.x) < 1e-4 && Math.abs(this.v) < 1e-3) {
				this.x = 0;
				this.v = 0;
			}
		}
	}

	// ======================================================================
	// SECTION 7: Corner control
	// ======================================================================

	const REL_CORNERS = [
		{ x: -0.5, y: -0.5 },
		{ x: 0.5, y: -0.5 },
		{ x: 0.5, y: 0.5 },
		{ x: -0.5, y: 0.5 }
	];

	class Corner {
		constructor(rel) {
			this.rel = rel;

			this.cx = -1e5;
			this.cy = -1e5;

			this.sx = new CritDamped1D(CFG.animation.length);
			this.sy = new CritDamped1D(CFG.animation.length);

			this.pdx = -1e5;
			this.pdy = -1e5;
		}

		getDest(centerX, centerY, w, h) {
			return { x: centerX + this.rel.x * w, y: centerY + this.rel.y * h };
		}

		update(dt, centerX, centerY, w, h, rankFactor, snapState) {
			const dest = this.getDest(centerX, centerY, w, h);

			if (this.pdx < -1e4) {
				this.cx = dest.x;
				this.cy = dest.y;
				this.pdx = dest.x;
				this.pdy = dest.y;
				this.sx.reset();
				this.sy.reset();
				return false;
			}

			this.sx.pos = this.cx - dest.x;
			this.sy.pos = this.cy - dest.y;

			const base = snapState.useShort ? CFG.animation.shortLength : CFG.animation.length;

			let tau;
			if (CFG.dynamics.hardSnap && snapState.leadingness >= CFG.dynamics.leadingSnapThreshold) {
				tau = CFG.dynamics.snapAnimationLength;
			} else {
				tau = Math.max(0.010, base * rankFactor);
			}

			this.sx.setTimeConstant(tau);
			this.sy.setTimeConstant(tau);

			if (CFG.dynamics.hardSnap && snapState.leadingness >= CFG.dynamics.leadingSnapThreshold) {
				const dx = dest.x - this.pdx;
				const dy = dest.y - this.pdy;
				const dist = Math.hypot(dx, dy);
				if (dist > 0.001) {
					this.cx += dx * CFG.dynamics.leadingSnapFactor;
					this.cy += dy * CFG.dynamics.leadingSnapFactor;
				}
			}

			const mx = this.sx.step(dt);
			const my = this.sy.step(dt);

			this.cx = dest.x + this.sx.pos;
			this.cy = dest.y + this.sy.pos;

			const maxStretch = CFG.dynamics.maxTrailDistanceFactor * Math.max(w, h);
			this.cx = clamp(this.cx, dest.x - maxStretch, dest.x + maxStretch);
			this.cy = clamp(this.cy, dest.y - maxStretch, dest.y + maxStretch);

			this.pdx = dest.x;
			this.pdy = dest.y;

			return mx || my;
		}
	}

	// ======================================================================
	// SECTION 8: Cursor squish controller
	// ======================================================================

	class CursorSquish {
		constructor() {
			this.corners = REL_CORNERS.map((r) => new Corner(r));
			this.target = { cx: 0, cy: 0, w: 8, h: 18 };
			this.last = { cx: 0, cy: 0, t: nowMs() };
		}

		setTargetFromRect(r) {
			const cx = r.left + r.width / 2;
			const cy = r.top + r.height / 2;

			const dx = cx - this.last.cx;
			const dy = cy - this.last.cy;
			const dist = Math.hypot(dx, dy);

			const useShort = dist <= CFG.animation.shortMoveThresholdPx;

			this.target.cx = cx;
			this.target.cy = cy;
			this.target.w = Math.max(1, r.width);
			this.target.h = Math.max(1, r.height);

			this.last.cx = cx;
			this.last.cy = cy;

			return { dx, dy, dist, useShort };
		}

		step(dtSec, motionInfo) {
			const dir = motionInfo.dist > 0.0001 ? normalize2(motionInfo.dx, motionInfo.dy) : { x: 0, y: 0 };
			const align = this.corners.map((c) => c.rel.x * dir.x + c.rel.y * dir.y);

			const idxs = [0, 1, 2, 3].sort((a, b) => align[a] - align[b]); // trailing -> leading
			const rankOf = new Array(4);
			for (let i = 0; i < 4; i++) rankOf[idxs[i]] = i;

			const snapState = { useShort: motionInfo.useShort, leadingness: 0 };

			let anyMoving = false;

			for (let i = 0; i < this.corners.length; i++) {
				const rank = rankOf[i];
				const rankFactor = CFG.dynamics.rankFactors[rank] ?? 1.0;

				// leadingness \in [0,1] is used for hard-snap thresholding.
				snapState.leadingness = rank / 3;

				anyMoving =
					this.corners[i].update(dtSec, this.target.cx, this.target.cy, this.target.w, this.target.h, rankFactor, snapState) ||
					anyMoving;
			}

			return anyMoving;
		}

		getAabbRect() {
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const c of this.corners) {
				minX = Math.min(minX, c.cx);
				minY = Math.min(minY, c.cy);
				maxX = Math.max(maxX, c.cx);
				maxY = Math.max(maxY, c.cy);
			}
			return {
				left: minX,
				top: minY,
				width: Math.max(1, maxX - minX),
				height: Math.max(1, maxY - minY)
			};
		}

		getTargetRect() {
			return {
				left: this.target.cx - this.target.w / 2,
				top: this.target.cy - this.target.h / 2,
				width: Math.max(1, this.target.w),
				height: Math.max(1, this.target.h)
			};
		}

		getCornerPolygon(padPx = 0) {
			const pts = this.corners.map((c) => ({ x: c.cx, y: c.cy }));
			if (!(padPx > 0) || pts.length === 0) return pts;

			let sx = 0;
			let sy = 0;
			for (const p of pts) {
				sx += p.x;
				sy += p.y;
			}
			const cx = sx / pts.length;
			const cy = sy / pts.length;

			return pts.map((p) => {
				const dx = p.x - cx;
				const dy = p.y - cy;
				const len = Math.hypot(dx, dy);
				if (len < 1e-6) return { x: p.x, y: p.y };
				const s = (len + padPx) / len;
				return { x: cx + dx * s, y: cy + dy * s };
			});
		}
	}

	// ======================================================================
	// SECTION 9: Polygon ribbon trail sample storage
	// ======================================================================

	// Trail sample shape: { t, cx, cy, pts }
	const trail = [];
	let lastPushed = null;

	const lerp = (a, b, t) => a + (b - a) * t;
	const lerpPoint = (p0, p1, t) => ({ x: lerp(p0.x, p1.x, t), y: lerp(p0.y, p1.y, t) });
	const pointDist = (a, b) => Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
	const clonePolygon = (pts) => pts.map((p) => ({ x: p.x, y: p.y }));
	const rotatePolygon = (pts, offset) => {
		const n = pts.length;
		const out = new Array(n);
		for (let i = 0; i < n; i++) out[i] = pts[(i + offset) % n];
		return out;
	};
	const polygonCenter = (pts) => {
		let sx = 0;
		let sy = 0;
		const n = Math.max(1, pts.length);
		for (const p of pts) {
			sx += p.x;
			sy += p.y;
		}
		return { x: sx / n, y: sy / n };
	};
	const polygonSignedArea = (pts) => {
		const n = pts?.length ?? 0;
		if (n < 3) return 0;
		let s = 0;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
		}
		return 0.5 * s;
	};
	const sortPolygonByAngle = (pts) => {
		if (!pts || pts.length < 3) return clonePolygon(pts || []);
		const c = polygonCenter(pts);
		return pts
			.map((p) => {
				const dx = p.x - c.x;
				const dy = p.y - c.y;
				return {
					p: { x: p.x, y: p.y },
					a: Math.atan2(dy, dx),
					r2: dx * dx + dy * dy
				};
			})
			.sort((a, b) => a.a - b.a || a.r2 - b.r2 || a.p.y - b.p.y || a.p.x - b.p.x)
			.map((o) => o.p);
	};
	const rotateToTopLeftStart = (pts) => {
		const n = pts?.length ?? 0;
		if (n === 0) return [];
		let best = 0;
		for (let i = 1; i < n; i++) {
			if (pts[i].y < pts[best].y || (pts[i].y === pts[best].y && pts[i].x < pts[best].x)) best = i;
		}
		return rotatePolygon(pts, best).map((p) => ({ x: p.x, y: p.y }));
	};
	const orient2 = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	const onSegment = (a, b, p, eps = 1e-6) => {
		if (Math.abs(orient2(a, b, p)) > eps) return false;
		return (
			p.x >= Math.min(a.x, b.x) - eps &&
			p.x <= Math.max(a.x, b.x) + eps &&
			p.y >= Math.min(a.y, b.y) - eps &&
			p.y <= Math.max(a.y, b.y) + eps
		);
	};
	const segmentsIntersect = (a, b, c, d, eps = 1e-6) => {
		const o1 = orient2(a, b, c);
		const o2 = orient2(a, b, d);
		const o3 = orient2(c, d, a);
		const o4 = orient2(c, d, b);
		const properCross =
			((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
			((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
		if (properCross) return true;
		if (Math.abs(o1) <= eps && onSegment(a, b, c, eps)) return true;
		if (Math.abs(o2) <= eps && onSegment(a, b, d, eps)) return true;
		if (Math.abs(o3) <= eps && onSegment(c, d, a, eps)) return true;
		if (Math.abs(o4) <= eps && onSegment(c, d, b, eps)) return true;
		return false;
	};
	const isSelfIntersectingPolygon = (pts) => {
		const n = pts?.length ?? 0;
		if (n < 4) return false;
		for (let i = 0; i < n; i++) {
			const a0 = pts[i];
			const a1 = pts[(i + 1) % n];
			for (let j = i + 1; j < n; j++) {
				// Ignore adjacent edges that share a vertex in the closed loop.
				if (j === i || (i + 1) % n === j || (j + 1) % n === i) continue;
				const b0 = pts[j];
				const b1 = pts[(j + 1) % n];
				if (segmentsIntersect(a0, a1, b0, b1)) return true;
			}
		}
		return false;
	};
		const isValidTrailPolygon = (pts) => Array.isArray(pts) && pts.length >= 3 && !isSelfIntersectingPolygon(pts);
		const lerpPolygon = (p0, p1, t) => {
			const n = Math.min(p0.length, p1.length);
			const out = new Array(n);
			for (let i = 0; i < n; i++) out[i] = lerpPoint(p0[i], p1[i], t);
			return out;
		};
		const ensurePolygonBufferLength = (buf, n) => {
			if (!Array.isArray(buf)) return [];
			for (let i = buf.length; i < n; i++) buf.push({ x: 0, y: 0 });
			buf.length = n;
			return buf;
		};
		const ensureNumberBufferLength = (buf, n) => {
			if (!Array.isArray(buf)) return [];
			for (let i = buf.length; i < n; i++) buf.push(0);
			buf.length = n;
			return buf;
		};
		const lerpPolygonInto = (dst, p0, p1, t) => {
			const n = Math.min(p0?.length ?? 0, p1?.length ?? 0);
			ensurePolygonBufferLength(dst, n);
			for (let i = 0; i < n; i++) {
				dst[i].x = lerp(p0[i].x, p1[i].x, t);
				dst[i].y = lerp(p0[i].y, p1[i].y, t);
			}
			return dst;
		};
		const scalePolygonInto = (dst, pts, cx, cy, scale) => {
			const n = pts?.length ?? 0;
			ensurePolygonBufferLength(dst, n);
			for (let i = 0; i < n; i++) {
				const dx = pts[i].x - cx;
				const dy = pts[i].y - cy;
				dst[i].x = cx + dx * scale;
				dst[i].y = cy + dy * scale;
			}
			return dst;
		};
		const resamplePolygonInto = (dst, src, outSides, edgeLensScratch) => {
			const srcN = src?.length ?? 0;
			const dstN = Math.max(3, outSides | 0);
			if (srcN < 3) return ensurePolygonBufferLength(dst, 0);
			if (srcN === dstN) {
				ensurePolygonBufferLength(dst, dstN);
				for (let i = 0; i < dstN; i++) {
					dst[i].x = src[i].x;
					dst[i].y = src[i].y;
				}
				return dst;
			}

			const edgeLens = ensureNumberBufferLength(edgeLensScratch, srcN);
			let total = 0;
			for (let i = 0; i < srcN; i++) {
				const j = (i + 1) % srcN;
				const dx = src[j].x - src[i].x;
				const dy = src[j].y - src[i].y;
				const len = Math.hypot(dx, dy);
				edgeLens[i] = len;
				total += len;
			}
			ensurePolygonBufferLength(dst, dstN);
			if (!(total > 1e-6)) {
				for (let i = 0; i < dstN; i++) {
					dst[i].x = src[0].x;
					dst[i].y = src[0].y;
				}
				return dst;
			}

			let edgeIdx = 0;
			let edgeEndCum = edgeLens[0];
			let edgeStartCum = 0;
			for (let i = 0; i < dstN; i++) {
				const target = (total * i) / dstN;
				while (edgeIdx < srcN - 1 && target > edgeEndCum) {
					edgeStartCum = edgeEndCum;
					edgeIdx++;
					edgeEndCum += edgeLens[edgeIdx];
				}
				const edgeLen = Math.max(1e-6, edgeLens[edgeIdx]);
				const t = clamp((target - edgeStartCum) / edgeLen, 0, 1);
				const a = src[edgeIdx];
				const b = src[(edgeIdx + 1) % srcN];
				dst[i].x = lerp(a.x, b.x, t);
				dst[i].y = lerp(a.y, b.y, t);
			}
			return dst;
		};
		const pointSub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
		const pointAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
		const pointScale = (p, s) => ({ x: p.x * s, y: p.y * s });
		const pointMid = (a, b) => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
		const pointLen = (p) => Math.hypot(p.x, p.y);
		const pointNormalize = (p) => {
			const d = pointLen(p);
			if (d < 1e-6) return { x: 0, y: 0 };
			return { x: p.x / d, y: p.y / d };
		};
		const pointDot = (a, b) => a.x * b.x + a.y * b.y;
		const pointPerp = (p) => ({ x: -p.y, y: p.x });
		const angleBetweenDirs = (a, b) => {
			const na = pointNormalize(a);
			const nb = pointNormalize(b);
			const c = clamp(pointDot(na, nb), -1, 1);
			return Math.acos(c);
		};
		const aabbFromPolygon = (pts) => {
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (let i = 0; i < pts.length; i++) {
				minX = Math.min(minX, pts[i].x);
				minY = Math.min(minY, pts[i].y);
				maxX = Math.max(maxX, pts[i].x);
				maxY = Math.max(maxY, pts[i].y);
			}
			return { minX, minY, maxX, maxY };
		};
		const aabbOverlaps = (a, b, eps = 0) =>
			!(a.maxX < b.minX - eps || b.maxX < a.minX - eps || a.maxY < b.minY - eps || b.maxY < a.minY - eps);
		const pointInPolygon = (pt, poly) => {
			let inside = false;
			for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
				const xi = poly[i].x;
				const yi = poly[i].y;
				const xj = poly[j].x;
				const yj = poly[j].y;
				const crosses = yi > pt.y !== yj > pt.y;
				if (!crosses) continue;
				const xCross = ((xj - xi) * (pt.y - yi)) / Math.max(1e-9, yj - yi) + xi;
				if (pt.x < xCross) inside = !inside;
			}
			return inside;
		};
		const polygonsOverlap = (a, b, eps = 1e-6) => {
			if (!a || !b || a.length < 3 || b.length < 3) return false;
			const ab = aabbFromPolygon(a);
			const bb = aabbFromPolygon(b);
			if (!aabbOverlaps(ab, bb, eps)) return false;
			for (let i = 0; i < a.length; i++) {
				const a0 = a[i];
				const a1 = a[(i + 1) % a.length];
				for (let j = 0; j < b.length; j++) {
					const b0 = b[j];
					const b1 = b[(j + 1) % b.length];
					if (segmentsIntersect(a0, a1, b0, b1, eps)) return true;
				}
			}
			if (pointInPolygon(a[0], b)) return true;
			if (pointInPolygon(b[0], a)) return true;
			return false;
		};
	const matchPolygonToReference = (pts, refPts) => {
		const n = Math.min(pts?.length ?? 0, refPts?.length ?? 0);
		if (n < 3) return clonePolygon(pts);

		const ref = refPts.slice(0, n);
		const refSign = Math.sign(polygonSignedArea(ref));
		const ordered = sortPolygonByAngle(pts.slice(0, n));

		let best = null;
		let bestScore = Infinity;
		let bases = [ordered, ordered.slice().reverse()];
		if (refSign !== 0) {
			const filtered = bases.filter((b) => Math.sign(polygonSignedArea(b)) === refSign);
			if (filtered.length) bases = filtered;
		}
		for (const base of bases) {
			for (let off = 0; off < n; off++) {
				const cand = rotatePolygon(base, off);
				let score = 0;
				for (let i = 0; i < n; i++) score += pointDist(cand[i], ref[i]);
				if (score < bestScore) {
					bestScore = score;
					best = cand;
				}
			}
		}
		return best ? best.map((p) => ({ x: p.x, y: p.y })) : clonePolygon(pts);
	};
	const canonicalizePolygon = (pts, refPts = null) => {
		const n = pts?.length ?? 0;
		if (n < 3) return clonePolygon(pts || []);
		const ordered = sortPolygonByAngle(pts.slice(0, n));
		if (refPts && refPts.length === n) return matchPolygonToReference(ordered, refPts);
		return rotateToTopLeftStart(ordered);
	};
	const clampPointStep = (from, to, maxStep) => {
		if (!(maxStep > 0)) return { x: to.x, y: to.y };
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const d = Math.hypot(dx, dy);
		if (d <= maxStep || d < 1e-6) return { x: to.x, y: to.y };
		const s = maxStep / d;
		return { x: from.x + dx * s, y: from.y + dy * s };
	};
		const maxCornerDelta = (prevPts, currPts) => {
		const n = Math.min(prevPts?.length ?? 0, currPts?.length ?? 0);
		if (n === 0) return 0;
		let m = 0;
		for (let i = 0; i < n; i++) m = Math.max(m, pointDist(prevPts[i], currPts[i]));
		return m;
	};
	const avgCornerDelta = (prevPts, currPts) => {
		const n = Math.min(prevPts?.length ?? 0, currPts?.length ?? 0);
		if (n === 0) return 0;
		let s = 0;
		for (let i = 0; i < n; i++) s += pointDist(prevPts[i], currPts[i]);
		return s / n;
	};
	const perimeter = (pts) => {
		const n = pts?.length ?? 0;
		if (n < 2) return 0;
		let p = 0;
		for (let i = 0; i < n; i++) p += pointDist(pts[i], pts[(i + 1) % n]);
		return p;
	};

	// Force the corner nearest the target caret location to be an axis-aligned right angle.
	// This biases the leading corner against diagonal skew and helps reduce twist artifacts.
	const enforceLeadingAxisCorner = (pts, targetPoint) => {
		const n = pts?.length ?? 0;
		if (n < 4 || !targetPoint) return clonePolygon(pts || []);

		let leadIdx = 0;
		let bestD2 = Infinity;
		for (let i = 0; i < n; i++) {
			const dx = pts[i].x - targetPoint.x;
			const dy = pts[i].y - targetPoint.y;
			const d2 = dx * dx + dy * dy;
			if (d2 < bestD2) {
				bestD2 = d2;
				leadIdx = i;
			}
		}

		const prevIdx = (leadIdx - 1 + n) % n;
		const nextIdx = (leadIdx + 1) % n;
		const lead = pts[leadIdx];
		const prev = pts[prevIdx];
		const next = pts[nextIdx];

		const makeCandidate = (prevHorizontal) => {
			const cand = clonePolygon(pts);
			if (prevHorizontal) {
				cand[prevIdx] = { x: prev.x, y: lead.y };
				cand[nextIdx] = { x: lead.x, y: next.y };
			} else {
				cand[prevIdx] = { x: lead.x, y: prev.y };
				cand[nextIdx] = { x: next.x, y: lead.y };
			}
			return cand;
		};
		const scoreCandidate = (cand) => pointDist(cand[prevIdx], prev) + pointDist(cand[nextIdx], next);

		const candA = makeCandidate(true);
		const candB = makeCandidate(false);
		const preferA = scoreCandidate(candA) <= scoreCandidate(candB);
		const first = preferA ? candA : candB;
		const second = preferA ? candB : candA;

		if (isValidTrailPolygon(first)) return first;
		if (isValidTrailPolygon(second)) return second;
		return clonePolygon(pts);
	};

	// Interpolation budget scales with perfQuality so heavy load can reduce insertion cost.
	function pushTrailPolygon(poly, targetPoint = null, stampMs = Date.now(), perfQuality = 1) {
		if (!poly || poly.length < 3) return;
		let pts = clonePolygon(poly);
		if (CFG.trail.twistGuardEnabled) {
			pts = canonicalizePolygon(pts, lastPushed?.pts ?? null);
		}
		if (targetPoint) {
			pts = enforceLeadingAxisCorner(pts, targetPoint);
		}
		if (!isValidTrailPolygon(pts)) return;
		let center = polygonCenter(pts);

		if (!lastPushed) {
			const first = { t: stampMs, cx: center.x, cy: center.y, pts };
			trail.push(first);
			lastPushed = first;
			if (trail.length > CFG.trail.maxRects) {
				trail.splice(0, trail.length - CFG.trail.maxRects);
			}
			return;
		}

		if (CFG.trail.twistGuardEnabled && lastPushed.pts.length === pts.length) {
			pts = canonicalizePolygon(pts, lastPushed.pts);
		}

		const rawCenterDx = center.x - lastPushed.cx;
		const rawCenterDy = center.y - lastPushed.cy;
		const rawCenterDist = Math.hypot(rawCenterDx, rawCenterDy);
		const smoothBase = clamp(CFG.trail.temporalSmoothFactor, 0, 0.95);
		const releaseDist = Math.max(1e-4, CFG.trail.smoothReleaseDistancePx || 0);
		const release = clamp(rawCenterDist / releaseDist, 0, 1);
		const smooth = smoothBase * (1 - release);
		if (smooth > 0 && lastPushed.pts.length === pts.length) {
			pts = lerpPolygon(pts, lastPushed.pts, smooth);
		}

		if (CFG.trail.cornerStepClampPx > 0 && lastPushed.pts.length === pts.length) {
			const speedClamp = Math.max(0, CFG.trail.cornerStepSpeedScale || 0) * rawCenterDist;
			const maxStep = CFG.trail.cornerStepClampPx + speedClamp;
			pts = pts.map((p, i) => clampPointStep(lastPushed.pts[i], p, maxStep));
		}
		if (CFG.trail.twistGuardEnabled && lastPushed.pts.length === pts.length) {
			pts = canonicalizePolygon(pts, lastPushed.pts);
		}
		if (targetPoint) {
			pts = enforceLeadingAxisCorner(pts, targetPoint);
		}
		if (!isValidTrailPolygon(pts)) return;
		center = polygonCenter(pts);

		const dx = center.x - lastPushed.cx;
		const dy = center.y - lastPushed.cy;
		const centerDist = Math.hypot(dx, dy);
		const cornerMax = maxCornerDelta(lastPushed.pts, pts);
		const cornerAvg = avgCornerDelta(lastPushed.pts, pts);
		const shapeDelta = Math.abs(perimeter(pts) - perimeter(lastPushed.pts)) * 0.35;
		const interpMetric = Math.max(centerDist, cornerMax, cornerAvg, shapeDelta);
		const moveThreshold = Math.max(CFG.trail.minMovePx, CFG.trail.cornerInterpEpsilonPx);
		if (interpMetric < moveThreshold) return;
		const adaptiveStep =
			Math.max(1e-4, CFG.trail.adaptiveInterpStepPx || CFG.trail.interpStepPx) /
			Math.max(perfQuality, 1e-4);
		const effectiveMaxInterpPerPush = Math.max(1, Math.round(CFG.trail.maxInterpPerPush * perfQuality));
		const segments = Math.min(
			effectiveMaxInterpPerPush,
			Math.max(1, Math.ceil(interpMetric / adaptiveStep))
		);

		// Fill large frame-to-frame gaps with intermediate polygons for a smoother ribbon trail.
		let prevEntryPts = lastPushed.pts;
		let pushedAny = false;
		for (let i = 1; i <= segments; i++) {
			const t = i / segments;
			let entryPts = lerpPolygon(lastPushed.pts, pts, t);
			if (CFG.trail.twistGuardEnabled && prevEntryPts.length === entryPts.length) {
				entryPts = canonicalizePolygon(entryPts, prevEntryPts);
			}
			if (targetPoint) {
				entryPts = enforceLeadingAxisCorner(entryPts, targetPoint);
			}
			if (!isValidTrailPolygon(entryPts)) continue;
			const entryCenter = polygonCenter(entryPts);
			const entry = {
				t: stampMs,
				cx: entryCenter.x,
				cy: entryCenter.y,
				pts: entryPts
			};
			trail.push(entry);
			prevEntryPts = entryPts;
			pushedAny = true;
		}
		if (pushedAny) lastPushed = trail[trail.length - 1];

		if (trail.length > CFG.trail.maxRects) {
			trail.splice(0, trail.length - CFG.trail.maxRects);
		}
	}

	function pruneTrail(now = Date.now()) {
		const ttl = CFG.trail.ttlMs;
		for (let i = trail.length - 1; i >= 0; i--) {
			if (now - trail[i].t > ttl) trail.splice(i, 1);
		}
	}

	// ======================================================================
	// SECTION 10: Renderer (polygon ribbon trail + caret box + overshoot)
	// ======================================================================

	function clearCanvas(ctx, canvas) {
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const W = canvas.width / dpr;
		const H = canvas.height / dpr;
		ctx.clearRect(0, 0, W, H);
	}

		// Reused polygon buffers avoid hot-path allocations in draw loops.
		const drawScratch = {
			prevPts: [],
			currPts: [],
			prevResampled: [],
			currResampled: [],
			aPts: [],
			bPts: [],
			newestPts: [],
			newestResampled: [],
			edgeLensA: [],
			edgeLensB: [],
			stackSizeState: {
				valid: false,
				len: 0,
				widthScale: 1
			}
		};
		const drawRibbonPairLegacy = (ctx, aPts, bPts, ox, oy) => {
			const n = Math.min(aPts?.length ?? 0, bPts?.length ?? 0);
			if (n < 3) return;
			for (let e = 0; e < n; e++) {
				const en = (e + 1) % n;
				ctx.beginPath();
				ctx.moveTo(aPts[e].x - ox, aPts[e].y - oy);
				ctx.lineTo(aPts[en].x - ox, aPts[en].y - oy);
				ctx.lineTo(bPts[en].x - ox, bPts[en].y - oy);
				ctx.lineTo(bPts[e].x - ox, bPts[e].y - oy);
				ctx.closePath();
				ctx.fill();
			}
		};
		const clonePoint = (p) => ({ x: p.x, y: p.y });
		const buildTrailSections = (
			sections,
			now,
			ttl,
			scaleExtra,
			trailStartIndex,
			effectiveDrawSubdivideStep,
			effectiveMaxDrawSubdivisions,
			effectiveRibbonSides,
			remainingSubBudget
		) => {
			sections.length = 0;
			for (let i = trailStartIndex; i < trail.length && remainingSubBudget > 0; i++) {
				const prev = trail[i - 1];
				const curr = trail[i];
				if (!prev || !curr || prev.pts.length < 3 || curr.pts.length < 3) continue;

				const prevFrac = clamp((now - prev.t) / ttl, 0, 1);
				const currFrac = clamp((now - curr.t) / ttl, 0, 1);
				const prevScale = Math.max(0.05, (1 + scaleExtra) * TRAIL_WIDTH_ENVELOPE_AT(prevFrac));
				const currScale = Math.max(0.05, (1 + scaleExtra) * TRAIL_WIDTH_ENVELOPE_AT(currFrac));
				const prevPtsRaw = scalePolygonInto(drawScratch.prevPts, prev.pts, prev.cx, prev.cy, prevScale);
				const currPtsRaw = scalePolygonInto(drawScratch.currPts, curr.pts, curr.cx, curr.cy, currScale);
				const prevPts = resamplePolygonInto(
					drawScratch.prevResampled,
					prevPtsRaw,
					effectiveRibbonSides,
					drawScratch.edgeLensA
				);
				const currPts = resamplePolygonInto(
					drawScratch.currResampled,
					currPtsRaw,
					effectiveRibbonSides,
					drawScratch.edgeLensB
				);

				const pairSpan = maxCornerDelta(prevPts, currPts);
				const subdivStep = Math.max(1e-4, effectiveDrawSubdivideStep);
				const desiredSub = Math.min(
					effectiveMaxDrawSubdivisions,
					Math.max(1, Math.ceil(pairSpan / subdivStep))
				);
				const sub = Math.min(desiredSub, remainingSubBudget);
				if (sub <= 0) break;
				remainingSubBudget -= sub;

				for (let k = 0; k < sub; k++) {
					const ta = k / sub;
					const tb = (k + 1) / sub;
					const aPts = lerpPolygonInto(drawScratch.aPts, prevPts, currPts, ta);
					const bPts = lerpPolygonInto(drawScratch.bPts, prevPts, currPts, tb);
					const fracA = lerp(prevFrac, currFrac, ta);
					const fracB = lerp(prevFrac, currFrac, tb);
					if (sections.length === 0) {
						const cA = polygonCenter(aPts);
						sections.push({ pts: clonePolygon(aPts), cx: cA.x, cy: cA.y, frac: fracA });
					}
					const cB = polygonCenter(bPts);
					sections.push({ pts: clonePolygon(bPts), cx: cB.x, cy: cB.y, frac: fracB });
				}
			}
			return sections;
		};
		const computeSectionFrame = (section, dirHint, minCellWidthPx) => {
			let d = pointNormalize(dirHint);
			if (pointLen(d) < 1e-6) d = { x: 1, y: 0 };
			let n = pointNormalize(pointPerp(d));
			if (pointLen(n) < 1e-6) n = { x: 0, y: 1 };
			let minProj = Infinity;
			let maxProj = -Infinity;
			for (let i = 0; i < section.pts.length; i++) {
				const rel = { x: section.pts[i].x - section.cx, y: section.pts[i].y - section.cy };
				const proj = pointDot(rel, n);
				minProj = Math.min(minProj, proj);
				maxProj = Math.max(maxProj, proj);
			}
			if (maxProj - minProj < minCellWidthPx) {
				const half = minCellWidthPx * 0.5;
				minProj = -half;
				maxProj = half;
			}
			const c = { x: section.cx, y: section.cy };
			const l = pointAdd(c, pointScale(n, minProj));
			const r = pointAdd(c, pointScale(n, maxProj));
			return { c, d, n, l, r, w: Math.max(minCellWidthPx, maxProj - minProj), frac: section.frac };
		};
		const drawStackedHexTrail = (
			ctx,
			ox,
			oy,
			now,
			ttl,
			scaleExtra,
			trailOpacity,
			clampedQuality,
			effectiveMaxRects,
			effectiveDrawSubdivideStep,
			effectiveMaxDrawSubdivisions,
			effectiveRibbonSides
		) => {
			const cfg = CFG.trail.stackHex;
			if (!cfg?.enabled) return false;
			const trailStartIndex = Math.max(1, trail.length - effectiveMaxRects + 1);
			let remainingSubBudget = Math.max(
				8,
				Math.round(Math.max(1, CFG.performance.maxSubdivisionsPerFrame || 1) * clampedQuality)
			);
			const sections = [];
			buildTrailSections(
				sections,
				now,
				ttl,
				scaleExtra,
				trailStartIndex,
				effectiveDrawSubdivideStep,
				effectiveMaxDrawSubdivisions,
				effectiveRibbonSides,
				remainingSubBudget
			);
			if (sections.length < 2) {
				drawScratch.stackSizeState.valid = false;
				return false;
			}

			const maxCells = Math.max(1, Math.round(Math.max(1, cfg.maxCellsPerFrame || 1) * clampedQuality));
			const available = sections.length - 1;
			const stride = Math.max(1, Math.ceil(available / maxCells));
			const picked = [0];
			for (let i = stride; i < sections.length - 1; i += stride) picked.push(i);
			if (picked[picked.length - 1] !== sections.length - 1) picked.push(sections.length - 1);
			if (picked.length < 2) {
				drawScratch.stackSizeState.valid = false;
				return false;
			}

			const firstDir = pointNormalize({
				x: sections[picked[1]].cx - sections[picked[0]].cx,
				y: sections[picked[1]].cy - sections[picked[0]].cy
			});
			const firstFrame = computeSectionFrame(sections[picked[0]], firstDir, cfg.minCellWidthPx);
			let baseL = clonePoint(firstFrame.l);
			let baseR = clonePoint(firstFrame.r);
			let prevD = pointLen(firstDir) > 1e-6 ? firstDir : { x: 1, y: 0 };

			const dyn = drawScratch.stackSizeState;
			let smoothLen = dyn.valid ? dyn.len : Math.max(1, cfg.baseLenPx || 1);
			let smoothWidth = dyn.valid ? dyn.widthScale : 1;
			let drewAny = false;
			const renderedCells = [];

			for (let ci = 0; ci < picked.length - 1; ci++) {
				const s0 = sections[picked[ci]];
				const s1 = sections[picked[ci + 1]];
				const rawMove = { x: s1.cx - s0.cx, y: s1.cy - s0.cy };
				let rawD = pointNormalize(rawMove);
				if (pointLen(rawD) < 1e-6) rawD = prevD;

				const baseVec = pointSub(baseR, baseL);
				let baseDir = pointNormalize(baseVec);
				if (pointLen(baseDir) < 1e-6) {
					baseDir = pointNormalize(pointPerp(rawD));
					if (pointLen(baseDir) < 1e-6) baseDir = { x: 1, y: 0 };
				}
				const dA = pointPerp(baseDir);
				const dB = pointScale(dA, -1);
				let D = pointDot(dA, rawD) >= pointDot(dB, rawD) ? dA : dB;
				const angleDeg = (Math.acos(clamp(pointDot(baseDir, pointNormalize(D)), -1, 1)) * 180) / Math.PI;
				const perpDeviationDeg = Math.abs(90 - angleDeg);
				if (perpDeviationDeg > Math.max(0, cfg.perpToleranceDeg || 0)) {
					D = pointDot(dA, rawD) >= pointDot(dB, rawD) ? dA : dB;
				}
				const N = baseDir;
				const baseMid = pointMid(baseL, baseR);
				const baseWidth = Math.max(cfg.minCellWidthPx, pointLen(baseVec));

				const curvature = angleBetweenDirs(prevD, D);
				const curvPressure = clamp(curvature / Math.max(1e-4, cfg.curvatureNormRad), 0, 1);
				const speedPx = pointLen(rawMove);
				const slowPressure = 1 - clamp(speedPx / Math.max(1e-4, cfg.speedNormPx), 0, 1);
				const cellIndexFromHead = picked.length - 2 - ci;
				const headInfluenceCells = Math.max(4, Math.max(0, cfg.headQuadCells || 0) + 2);
				const headPressure = clamp(1 - cellIndexFromHead / headInfluenceCells, 0, 1);
				const detailNeed = clamp(
					(cfg.curvatureWeight || 0) * curvPressure +
						(cfg.speedWeight || 0) * slowPressure +
						(cfg.headWeight || 0) * headPressure,
					0,
					1
				);

				let targetLen = cfg.baseLenPx;
				let targetWidthScale = 1;
				if (cfg.dynamicSizeEnabled) {
					const qualityCoarsen = lerp(1, Math.max(1, cfg.qualityCoarsenMax || 1), 1 - clampedQuality);
					targetLen = lerp(cfg.maxLenPx, cfg.minLenPx, detailNeed) * qualityCoarsen;
					targetWidthScale =
						lerp(cfg.maxWidthScale, cfg.minWidthScale, detailNeed) * lerp(1, 1.2, 1 - clampedQuality);
				}
				smoothLen = lerp(smoothLen, targetLen, clamp(cfg.sizeLerpAlpha, 0, 1));
				smoothWidth = lerp(smoothWidth, targetWidthScale, clamp(cfg.widthLerpAlpha, 0, 1));
				smoothLen = clamp(
					smoothLen,
					Math.max(1, cfg.minLenPx),
					Math.max(cfg.minLenPx, cfg.maxLenPx * Math.max(1, cfg.qualityCoarsenMax || 1))
				);
				smoothWidth = clamp(
					smoothWidth,
					Math.max(1e-3, cfg.minWidthScale),
					Math.max(cfg.minWidthScale, cfg.maxWidthScale * 1.2)
				);

				const handoffCenter = pointAdd(baseMid, pointScale(D, smoothLen));
				const handoffWidth = Math.max(cfg.minCellWidthPx, baseWidth * smoothWidth);
				const halfW = handoffWidth * 0.5;
				const handoffL = pointAdd(handoffCenter, pointScale(N, -halfW));
				const handoffR = pointAdd(handoffCenter, pointScale(N, halfW));
				let partR = lerpPoint(baseR, handoffR, clamp(cfg.partialEdgeShare, 0, 1));
				let partL = lerpPoint(baseL, handoffL, clamp(cfg.partialEdgeShare, 0, 1));
				const concavitySign = cfg.concavityDirection === "backward" ? -1 : 1;
				const concavityTarget = pointAdd(baseMid, pointScale(D, concavitySign * smoothLen * cfg.concavityDepth));
				const concavityStep = Math.max(0, cfg.concavityDepth) * handoffWidth;
				partR = clampPointStep(partR, concavityTarget, concavityStep);
				partL = clampPointStep(partL, concavityTarget, concavityStep);

				const headQuad = cellIndexFromHead < Math.max(0, cfg.headQuadCells || 0);
				const quadCell = [clonePoint(baseL), clonePoint(baseR), clonePoint(handoffR), clonePoint(handoffL)];
				let cellPts = headQuad
					? quadCell
					: [clonePoint(baseL), clonePoint(baseR), clonePoint(partR), clonePoint(handoffR), clonePoint(handoffL), clonePoint(partL)];
				let valid = isValidTrailPolygon(cellPts);
				if (valid && renderedCells.length > 1) {
					for (let j = 0; j < renderedCells.length - 1; j++) {
						if (polygonsOverlap(cellPts, renderedCells[j], cfg.overlapEpsilonPx || 0)) {
							valid = false;
							break;
						}
					}
				}
				if (!valid && !headQuad) {
					cellPts = quadCell;
					valid = isValidTrailPolygon(cellPts);
				}

				const alphaCell = clamp((1 - s1.frac) * trailOpacity, CFG.trail.minAlpha, 1);
				if (valid && alphaCell > 0) {
					ctx.globalAlpha = alphaCell;
					ctx.beginPath();
					ctx.moveTo(cellPts[0].x - ox, cellPts[0].y - oy);
					for (let i = 1; i < cellPts.length; i++) ctx.lineTo(cellPts[i].x - ox, cellPts[i].y - oy);
					ctx.closePath();
					ctx.fill();
					if (!cfg.fillOnly) {
						ctx.stroke();
					}
					renderedCells.push(cellPts);
					drewAny = true;
				}

				baseL = clonePoint(handoffL);
				baseR = clonePoint(handoffR);
				prevD = D;
			}

			if (drewAny) {
				dyn.valid = true;
				dyn.len = smoothLen;
				dyn.widthScale = smoothWidth;
			} else {
				dyn.valid = false;
			}
			return drewAny;
		};

		// Staged adaptation order: subdivisions first, then shadow blur, then history length.
		// Draw-time canonicalization is intentionally removed; polygons are canonicalized at push-time.
		function draw(ctx, canvas, boxRect, boxFontSizePx, scaleExtra, isIdle, originX, originY, wallNowMs, perfQuality = 1) {
			clearCanvas(ctx, canvas);
			const ox = originX ?? 0;
			const oy = originY ?? 0;
			const styles = getRenderStyles();
			const trailOpacity = styles.trailOpacity;
			const trailColorCss = styles.trailColorCss;
			const boxOpacity = styles.boxOpacity;
			const boxColorCss = styles.boxColorCss;
			const qMin = CFG.performance.qualityMin;
			const clampedQuality = clamp(perfQuality, qMin, 1);
			const allowPostSubdivideCuts = clampedQuality < CFG.performance.subdivideOnlyThreshold;
			const subQuality = clampedQuality;
			const effectiveDrawSubdivideStep = CFG.trail.drawSubdivideStepPx / Math.max(subQuality, 1e-4);
			const effectiveMaxDrawSubdivisions = Math.max(1, Math.round(CFG.trail.maxDrawSubdivisions * subQuality));
			const effectiveRibbonSides = Math.max(
				3,
				Math.round(lerp(CFG.trail.ribbonSidesMin, CFG.trail.ribbonSides, clampedQuality))
			);
			const effectiveMaxRects =
				allowPostSubdivideCuts && clampedQuality < CFG.performance.historyStartThreshold
					? Math.max(8, Math.round(CFG.trail.maxRects * clampedQuality))
					: CFG.trail.maxRects;

			ctx.fillStyle = trailColorCss;
			ctx.strokeStyle = trailColorCss;

			if (CFG.shadow.enabled && !isIdle) {
				ctx.shadowColor = CFG.shadow.color ? styles.shadowColorCss : trailColorCss;
				const baseShadowBlur = Math.max(0, CFG.shadow.blurFactor) * 12;
				let shadowScale = 1;
				if (allowPostSubdivideCuts && clampedQuality < CFG.performance.blurStartThreshold) {
					const denom = Math.max(1e-4, CFG.performance.blurStartThreshold - CFG.performance.qualityMin);
					shadowScale = clamp((clampedQuality - CFG.performance.qualityMin) / denom, 0, 1);
				}
				ctx.shadowBlur = baseShadowBlur * shadowScale;
			} else {
				ctx.shadowColor = "transparent";
				ctx.shadowBlur = 0;
			}

				const now = wallNowMs ?? Date.now();
				const ttl = CFG.trail.ttlMs;
				const minPolyScale = 0.05;
				const drewStacked = drawStackedHexTrail(
					ctx,
					ox,
					oy,
					now,
					ttl,
					scaleExtra,
					trailOpacity,
					clampedQuality,
					effectiveMaxRects,
					effectiveDrawSubdivideStep,
					effectiveMaxDrawSubdivisions,
					effectiveRibbonSides
				);

				if (!drewStacked) {
					const trailStartIndex = Math.max(1, trail.length - effectiveMaxRects + 1);
					// Draw newest pairs first for a stable head and natural fading tail.
					for (let i = trail.length - 1; i >= trailStartIndex; i--) {
						const prev = trail[i - 1];
						const curr = trail[i];
						if (!prev || !curr || prev.pts.length < 3 || curr.pts.length < 3) continue;

						const prevFrac = clamp((now - prev.t) / ttl, 0, 1);
						const currFrac = clamp((now - curr.t) / ttl, 0, 1);
						const prevScale = Math.max(minPolyScale, (1 + scaleExtra) * TRAIL_WIDTH_ENVELOPE_AT(prevFrac));
						const currScale = Math.max(minPolyScale, (1 + scaleExtra) * TRAIL_WIDTH_ENVELOPE_AT(currFrac));
						const prevPtsRaw = scalePolygonInto(drawScratch.prevPts, prev.pts, prev.cx, prev.cy, prevScale);
						const currPtsRaw = scalePolygonInto(drawScratch.currPts, curr.pts, curr.cx, curr.cy, currScale);
						const prevPts = resamplePolygonInto(
							drawScratch.prevResampled,
							prevPtsRaw,
							effectiveRibbonSides,
							drawScratch.edgeLensA
						);
						const currPts = resamplePolygonInto(
							drawScratch.currResampled,
							currPtsRaw,
							effectiveRibbonSides,
							drawScratch.edgeLensB
						);

						const baseN = Math.min(prevPts.length, currPts.length);
						if (baseN < 3) continue;

						const pairSpan = maxCornerDelta(prevPts, currPts);
						const subdivStep = Math.max(1e-4, effectiveDrawSubdivideStep);
						const desiredSub = Math.min(
							effectiveMaxDrawSubdivisions,
							Math.max(1, Math.ceil(pairSpan / subdivStep))
						);
						const sub = desiredSub;

						for (let k = 0; k < sub; k++) {
							const ta = k / sub;
							const tb = (k + 1) / sub;
							const aPts = lerpPolygonInto(drawScratch.aPts, prevPts, currPts, ta);
							const bPts = lerpPolygonInto(drawScratch.bPts, prevPts, currPts, tb);
							const n = Math.min(aPts.length, bPts.length);
							if (n < 3) continue;

							const fracSub = lerp(prevFrac, currFrac, (ta + tb) * 0.5);
							const alphaSub = clamp((1 - fracSub) * trailOpacity, CFG.trail.minAlpha, 1);
							if (alphaSub <= 0) continue;

							ctx.globalAlpha = alphaSub;
							drawRibbonPairLegacy(ctx, aPts, bPts, ox, oy);
						}
					}

					const newest = trail.length ? trail[trail.length - 1] : null;
					if (newest && newest.pts.length >= 3) {
						const fracCap = clamp((now - newest.t) / ttl, 0, 1);
						const alphaCap = clamp((1 - fracCap) * trailOpacity, CFG.trail.minAlpha, 1);
						const polyScale = Math.max(minPolyScale, (1 + scaleExtra) * TRAIL_WIDTH_ENVELOPE_AT(fracCap));
						const newestPtsRaw = scalePolygonInto(drawScratch.newestPts, newest.pts, newest.cx, newest.cy, polyScale);
						const pts = resamplePolygonInto(
							drawScratch.newestResampled,
							newestPtsRaw,
							effectiveRibbonSides,
							drawScratch.edgeLensA
						);
						ctx.globalAlpha = alphaCap;
						ctx.beginPath();
						ctx.moveTo(pts[0].x - ox, pts[0].y - oy);
						for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - ox, pts[i].y - oy);
						ctx.closePath();
						ctx.fill();
					}
				}

			if (boxRect) {
				ctx.globalAlpha = boxOpacity;
				ctx.shadowColor = "transparent";
				ctx.shadowBlur = 0;
				ctx.strokeStyle = boxColorCss;

				const refFontSize = Math.max(1e-4, CFG.box.scaleRefFontSizePx || 14);
				const activeFontSize = boxFontSizePx > 0 ? boxFontSizePx : refFontSize;
				const boxScale = activeFontSize / refFontSize;
				const pad = Math.max(0, CFG.box.padPx * boxScale);
				const radius = Math.max(0, CFG.box.radiusPx * boxScale);
				const x = boxRect.left - pad - ox;
				const y = boxRect.top - pad - oy;
				const w = boxRect.width + 2 * pad;
				const h = boxRect.height + 2 * pad;

				ctx.lineWidth = CFG.box.lineWidthPx ?? CFG.idle.hollowLineWidthPx;
				roundRectPath(ctx, x, y, w, h, radius);
				ctx.stroke();
			}

			ctx.globalAlpha = 1;
			ctx.shadowBlur = 0;
			ctx.shadowColor = "transparent";
		}

	// ======================================================================
	// SECTION 11: Main loop
	// ======================================================================

	const flag = "__neovide_cursor_active__";
	if (window[flag]) return;
	window[flag] = true;

		ensureNativeCaretLayerStyle();
		const { canvas, ctx } = makeCanvas();
		resizeCanvas(canvas);
		let cachedCanvasRect = canvas.getBoundingClientRect();
		let lastCanvasHost = null;

	const NO_MOTION = Object.freeze({ dx: 0, dy: 0, dist: 0, useShort: false });
	const trailTargetPoint = { x: 0, y: 0 };

	const cursor = new CursorSquish();
	const bounce = new UnderDampedScalar(CFG.overshoot.omega, CFG.overshoot.zeta);

	let cursorEl = null;
	let lastAnchorCenter = null;
	let lastFontBox = null;
	let liveCaretRect = null;
	let liveCaretFontSizePx = CFG.box.scaleRefFontSizePx || 14;
	let pendingMotion = null;
	let cachedFontBox = null;
	let cachedFontBoxCursorEl = null;
	let lastFontMetricResolveMs = -Infinity;
	// Continuous adaptive quality state for both small and large jumps.
	let perfFrameEmaMs = CFG.performance.targetFrameMs;
	let perfQuality = 1;
	let perfTargetQuality = 1;
	// Trail is gated per caret hop; short hops (typing-scale moves) skip trail emission.
	let trailAllowedForCurrentMove = true;
	// Idle mode is driven by center-position movement only, not size-only caret animation.
	let lastRealMoveMs = nowMs();
	let lastCursorSeenMs = -Infinity;
	let canvasVisible = false;

	const setCanvasVisible = (visible) => {
		if (canvasVisible === visible) return;
		canvasVisible = visible;
		canvas.style.opacity = visible ? "1" : "0";
	};

	const ensureCursorEl = () => {
		const prevEl = cursorEl;
		if (cursorEl && document.contains(cursorEl)) return cursorEl;
		cursorEl = findMonacoCursorEl();
		if (cursorEl !== prevEl) {
			cachedFontBox = null;
			cachedFontBoxCursorEl = null;
			lastFontMetricResolveMs = -Infinity;
		}
		return cursorEl;
	};

	const pollNativeCursorRect = (frameNowMs) => {
		const el = ensureCursorEl();
		if (!el) return false;

		const r = el.getBoundingClientRect();
		if (!(r.width > 0 && r.height > 0)) return false;
		lastCursorSeenMs = frameNowMs;

		const rawCenter = getRectCenter(r);
		const center = {
			cx: snapToDevicePixel(rawCenter.cx),
			cy: snapToDevicePixel(rawCenter.cy)
		};
		const needsFontMetricResolve =
			!cachedFontBox ||
			cachedFontBoxCursorEl !== el ||
			(frameNowMs - lastFontMetricResolveMs) >= FONT_METRIC_CACHE_MS;
		if (needsFontMetricResolve) {
			cachedFontBox = resolveFontMetricBox(el);
			cachedFontBoxCursorEl = el;
			lastFontMetricResolveMs = frameNowMs;
		}
		const fontBox = cachedFontBox;
		const synthRect = {
			left: center.cx - fontBox.width / 2,
			top: center.cy - fontBox.height / 2,
			width: fontBox.width,
			height: fontBox.height
		};
		liveCaretRect = synthRect;
		liveCaretFontSizePx = fontBox.fontSizePx;
		const centerChanged = didCenterMove(lastAnchorCenter, center, CFG.motion.centerMoveEpsilonPx);
		const metricChanged =
			!lastFontBox ||
			Math.abs(fontBox.width - lastFontBox.width) > CFG.typography.metricEpsilonPx ||
			Math.abs(fontBox.height - lastFontBox.height) > CFG.typography.metricEpsilonPx;
		const changed = !lastAnchorCenter || centerChanged || metricChanged;

		if (!changed) return true;

		lastAnchorCenter = center;
		lastFontBox = { width: fontBox.width, height: fontBox.height };
		pendingMotion = cursor.setTargetFromRect(synthRect);
		if (centerChanged) {
			const minChars = Math.max(0, CFG.trail.minMoveCharsForTrail || 0);
			const charWidthPx = Math.max(1e-4, fontBox.width);
			const minTrailMovePx = minChars * charWidthPx;
			trailAllowedForCurrentMove = pendingMotion.dist >= minTrailMovePx;
			lastRealMoveMs = frameNowMs;
		}
		return true;
	};

		const rafLoop = () => {
			try {
				const frameNowMs = nowMs();
				const hasCursor = pollNativeCursorRect(frameNowMs);
				const host = findCanvasHostForCursorEl(cursorEl);
				if (host && host !== lastCanvasHost) {
					attachCanvasToHost(canvas, host);
					lastCanvasHost = host;
				} else if (host && canvas.parentElement !== host) {
					attachCanvasToHost(canvas, host);
				}

				const dtSec = clamp((frameNowMs - cursor.last.t) / 1000, 0, 0.05);
				cursor.last.t = frameNowMs;

			const cursorVisible = hasCursor || (frameNowMs - lastCursorSeenMs) <= CFG.visibility.noCursorHideDelayMs;
			if (!cursorVisible) {
				setCanvasVisible(false);
				clearCanvas(ctx, canvas);
				requestAnimationFrame(rafLoop);
				return;
			}
			setCanvasVisible(true);

			const motion = pendingMotion || NO_MOTION;
			pendingMotion = null;
			const frameMs = dtSec * 1000;
			if (CFG.performance.enabled) {
				perfFrameEmaMs = lerp(perfFrameEmaMs, frameMs, CFG.performance.emaAlpha);
				const framePressure = clamp(
					(perfFrameEmaMs - CFG.performance.targetFrameMs) / Math.max(1e-4, CFG.performance.framePressureWindowMs),
					0,
					1
				);
				const distancePressure = clamp(motion.dist / Math.max(1e-4, CFG.performance.distanceNormPx), 0, 1);
				const hybridPressure = clamp(
					CFG.performance.frameWeight * framePressure + CFG.performance.distanceWeight * distancePressure,
					0,
					1
				);
				perfTargetQuality = 1 - hybridPressure * (1 - CFG.performance.qualityMin);
				if (perfTargetQuality < perfQuality) {
					perfQuality = Math.max(perfTargetQuality, perfQuality - CFG.performance.degradeRatePerSec * dtSec);
				} else {
					perfQuality = Math.min(perfTargetQuality, perfQuality + CFG.performance.recoverRatePerSec * dtSec);
				}
				perfQuality = clamp(perfQuality, CFG.performance.qualityMin, 1);
			} else {
				perfFrameEmaMs = CFG.performance.targetFrameMs;
				perfTargetQuality = 1;
				perfQuality = 1;
			}

			// Kick overshoot on motion events
			if (CFG.overshoot.enabled && motion.dist > 0) {
				const kick = clamp(motion.dist * CFG.overshoot.kickPerPx, 0, CFG.overshoot.maxKick);
				bounce.kick(kick);
			}

			const moving = cursor.step(dtSec, motion);

			// Overshoot scale derived from oscillator state
			bounce.step(dtSec);

			let scaleExtra = 0;
			if (CFG.overshoot.enabled) {
				scaleExtra = clamp(bounce.x * CFG.overshoot.gain, CFG.overshoot.minScale, CFG.overshoot.maxScale);
			}
			const isIdleByTimer = (frameNowMs - lastRealMoveMs) >= CFG.idle.switchDelayMs;
			const isIdle = isIdleByTimer;
				const boxRect = liveCaretRect ?? cursor.getTargetRect();
				trailTargetPoint.x = boxRect.left + boxRect.width / 2;
				trailTargetPoint.y = boxRect.top + boxRect.height / 2;
				const wallNowMs = Date.now();

				// Even short moves can adapt when frame pressure is high.
				if (moving && trailAllowedForCurrentMove) {
					pushTrailPolygon(cursor.getCornerPolygon(CFG.rect.padPx), trailTargetPoint, wallNowMs, perfQuality);
				}

				pruneTrail(wallNowMs);
				resizeCanvas(canvas);
				cachedCanvasRect = canvas.getBoundingClientRect();

				draw(
					ctx,
					canvas,
					boxRect,
					liveCaretFontSizePx,
					scaleExtra,
					isIdle,
					cachedCanvasRect.left,
					cachedCanvasRect.top,
					wallNowMs,
					perfQuality
				);
			} catch {
				// swallow DOM breakages on VS Code updates
			}

		requestAnimationFrame(rafLoop);
	};

	setCanvasVisible(false);
	requestAnimationFrame(rafLoop);

	window.__neovideCursorCleanup = () => {
		window[flag] = false;
		trail.length = 0;
		lastPushed = null;
		if (canvas && canvas.parentElement) canvas.parentElement.removeChild(canvas);
		const style = document.getElementById("__neovide_cursor_native_caret_layer__");
		if (style && style.parentElement) style.parentElement.removeChild(style);
	};
}

module.exports = {
	activate,
	deactivate,
	isActive
};
