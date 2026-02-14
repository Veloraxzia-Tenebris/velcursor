"use strict";

const vscode = require("vscode");

/**
 * Inertial cursor math model
 *
 * State:
 * - Velocity v (unitless cursor-speed scalar)
 * - Tick cadence tickMs (milliseconds per tick)
 *
 * Equations and flow:
 * 1) Start of a new inertia run:
 *    v0 = initialVelocity
 * 2) Repeated same-direction impulse key while running:
 *    v = min(maxVelocity, v + impulse)
 * 3) Direction switch impulse while running:
 *    v = max(initialVelocity, 0.1 * v)
 * 4) Per-tick cursor step:
 *    - First tick after run start: step = 2 (forced invariant)
 *    - Later ticks: step = clamp(round(v), 1, maxStepPerTick)
 * 5) Per-tick decay:
 *    v_{k+1} = decay * v_k
 * 6) Stop condition:
 *    stop when v < cutoff
 *
 * Level mapping (for user settings, level in [1, 10]):
 * - t = (level - 1) / 9
 * - impulse(level) = IMPULSE_MIN + t * (IMPULSE_MAX - IMPULSE_MIN)
 * - tickMs(level) = round(TICK_MS_MIN + t * (TICK_MS_MAX - TICK_MS_MIN))
 *
 * Tick slowness interpretation:
 * - Higher tick level => larger tickMs => slower update cadence.
 */

/** @typedef {"up"|"down"|"left"|"right"} Direction */
/** @typedef {{impulseLevel: number, tickSlowLevel: number, impulse: number, tickMs: number}} InertiaTuning */

const CONFIG_SECTION = "velcursor";
const IMPULSE_LEVEL_KEY = "inertiaImpulseLevel";
const TICK_SLOW_LEVEL_KEY = "inertiaTickSlowLevel";

const LEVEL_MIN = 1;
const LEVEL_MAX = 10;

const IMPULSE_MIN = 0.30;
const IMPULSE_MAX = 2.10;

const TICK_MS_MIN = 14;
const TICK_MS_MAX = 68;

const DEFAULT_IMPULSE_LEVEL = 4;
const DEFAULT_TICK_SLOW_LEVEL = 4;

function clampLevel(value, fallback) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Math.round(numeric)));
}

function normalizeLevel(level) {
	return (level - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN);
}

function impulseFromLevel(level) {
	const t = normalizeLevel(level);
	return Number((IMPULSE_MIN + t * (IMPULSE_MAX - IMPULSE_MIN)).toFixed(2));
}

function tickMsFromLevel(level) {
	const t = normalizeLevel(level);
	return Math.round(TICK_MS_MIN + t * (TICK_MS_MAX - TICK_MS_MIN));
}

/**
 * @param {number} impulseLevel
 * @param {number} tickSlowLevel
 * @returns {InertiaTuning}
 */
function makeTuning(impulseLevel, tickSlowLevel) {
	const safeImpulseLevel = clampLevel(impulseLevel, DEFAULT_IMPULSE_LEVEL);
	const safeTickSlowLevel = clampLevel(tickSlowLevel, DEFAULT_TICK_SLOW_LEVEL);
	return {
		impulseLevel: safeImpulseLevel,
		tickSlowLevel: safeTickSlowLevel,
		impulse: impulseFromLevel(safeImpulseLevel),
		tickMs: tickMsFromLevel(safeTickSlowLevel)
	};
}

/**
 * @returns {InertiaTuning}
 */
function readTuningFromConfig() {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return makeTuning(
		config.get(IMPULSE_LEVEL_KEY, DEFAULT_IMPULSE_LEVEL),
		config.get(TICK_SLOW_LEVEL_KEY, DEFAULT_TICK_SLOW_LEVEL)
	);
}

function byForDir(dir) {
	return (dir === "up" || dir === "down") ? "wrappedLine" : "character";
}

async function moveCursor(dir, step, select) {
	// Built-in VS Code command
	await vscode.commands.executeCommand("cursorMove", {
		to: dir,
		by: byForDir(dir),
		value: step,
		select: Boolean(select)
	});
}

function selectionSig(editor) {
	const s = editor.selection;
	const uri = editor.document.uri.toString();
	return `${uri}|A:${s.active.line},${s.active.character}|B:${s.anchor.line},${s.anchor.character}`;
}

/**
 * Inertia controller:
 * - Triggered only by Ctrl+Alt+IJKL commands (impulse events).
 * - Alt+IJKL is single-step only and never enters inertia.
 */
class InertiaCursorController {
	#cfg = {
		// Units: milliseconds per simulation tick.
		// Suggested range: 14 to 68 via level mapping (1 to 10).
		// Nominal value: 32 (tick slow level 4).
		// +: Increases delay between movement updates; inertia feels slower/smoother.
		// -: Decreases delay between movement updates; inertia feels faster/more reactive.
		tickMs: tickMsFromLevel(DEFAULT_TICK_SLOW_LEVEL),

		// Units: velocity units.
		// Suggested range: 1.0 to 1.5.
		// Nominal value: 1.1.
		// +: Starts each inertia run with a larger baseline speed.
		// -: Starts each inertia run more gently.
		initialVelocity: 1.1,

		// Units: velocity units added per same-direction impulse key press.
		// Suggested range: 0.30 to 2.10 via level mapping (1 to 10).
		// Nominal value: 0.90 (impulse level 4).
		// +: Accelerates more aggressively when you keep pressing the same direction.
		// -: Produces gentler acceleration for repeated key presses.
		impulse: impulseFromLevel(DEFAULT_IMPULSE_LEVEL),

		// Units: velocity units.
		// Suggested range: 64 to 1024.
		// Nominal value: 512.
		// +: Allows higher peak speed before clamping.
		// -: Limits maximum reachable speed.
		maxVelocity: 512.0,

		// Units: unitless multiplier applied each tick.
		// Suggested range: 0.90 to 0.99.
		// Nominal value: 0.96.
		// +: Decays velocity more slowly; inertia lasts longer.
		// -: Decays velocity faster; inertia stops sooner.
		decay: 0.96,

		// Units: velocity units.
		// Suggested range: 0.80 to 1.20.
		// Nominal value: 0.99.
		// +: Requires more residual speed to continue; runs stop earlier.
		// -: Allows slower movement to continue; runs persist longer.
		cutoff: 0.99,

		// Units: cursor units per tick (characters horizontally, wrapped lines vertically).
		// Suggested range: 4 to 16.
		// Nominal value: 8.
		// +: Permits larger per-tick jumps at high velocity.
		// -: Limits per-tick jumps and improves fine control.
		maxStepPerTick: 8,

		// Units: event count.
		// Suggested range: 128 to 2048.
		// Nominal value: 512.
		// +: Ignores more extension-caused selection events before external-stop detection.
		// -: Reacts sooner to unexpected selection changes.
		suppressSelectionEvents: 512
	};

	#state = {
		running: false,
		dir: /** @type {Direction|null} */ (null),
		velocity: 0,
		timer: /** @type {NodeJS.Timeout|null} */ (null),
		expectedSig: /** @type {string|null} */ (null),
		suppressSelEvents: 0,
		selectMode: false,
		firstTickPending: false
	};

	wire() {
		return vscode.window.onDidChangeTextEditorSelection((e) => {
			if (!this.#state.running) return;

			const active = vscode.window.activeTextEditor;
			if (!active) return;
			if (e.textEditor !== active) return;

			if (this.#state.suppressSelEvents > 0) {
				this.#state.suppressSelEvents--;
				return;
			}

			const sig = selectionSig(active);
			if (sig !== this.#state.expectedSig) this.stop();
		});
	}

	stop() {
		this.#state.running = false;
		this.#state.dir = null;
		this.#state.velocity = 0;
		this.#state.expectedSig = null;
		this.#state.firstTickPending = false;

		if (this.#state.timer) {
			clearInterval(this.#state.timer);
			this.#state.timer = null;
		}
	}

	/**
	 * @param {InertiaTuning} tuning
	 * @returns {InertiaTuning}
	 */
	applyTuning(tuning) {
		const next = makeTuning(tuning.impulseLevel, tuning.tickSlowLevel);
		const tickChanged = this.#cfg.tickMs !== next.tickMs;
		this.#cfg.tickMs = next.tickMs;
		this.#cfg.impulse = next.impulse;

		if (tickChanged && this.#state.running) {
			this.#restartTimer();
		}

		return next;
	}

	toggleSelectMode() {
		this.#state.selectMode = !this.#state.selectMode;
		const label = this.#state.selectMode ? "ON" : "OFF";
		vscode.window.setStatusBarMessage(`Cursor select mode: ${label}`, 1500);
	}

	isSelectMode() {
		return this.#state.selectMode;
	}

	/**
	 * Start inertia or add impulse. Only called by Ctrl+Alt bindings.
	 * @param {Direction} dir
	 */
	impulse(dir) {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		if (!this.#state.running) {
			this.#state.running = true;
			this.#state.dir = dir;
			this.#state.velocity = this.#cfg.initialVelocity;
			this.#state.expectedSig = selectionSig(editor);
			this.#state.firstTickPending = true;

			// immediate tick, then loop
			void this.#tickOnce();
			this.#restartTimer();
			return;
		}

		// Running: direction change dampens, same direction accelerates.
		if (this.#state.dir !== dir) {
			this.#state.dir = dir;
			this.#state.velocity = Math.max(this.#cfg.initialVelocity, this.#state.velocity * 0.1);
			return;
		}

		this.#state.velocity = Math.min(this.#cfg.maxVelocity, this.#state.velocity + this.#cfg.impulse);
	}

	async #tickOnce() {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !this.#state.running || !this.#state.dir) {
			this.stop();
			return;
		}

		if (this.#state.velocity < this.#cfg.cutoff) {
			this.stop();
			return;
		}

		const step = this.#state.firstTickPending ? 2 : this.#stepFromVelocity(this.#state.velocity);
		const dir = this.#state.dir;
		this.#state.firstTickPending = false;

		this.#state.suppressSelEvents = this.#cfg.suppressSelectionEvents;

		await moveCursor(dir, step, this.#state.selectMode);

		this.#state.expectedSig = selectionSig(editor);
		this.#state.velocity *= this.#cfg.decay;
	}

	#stepFromVelocity(v) {
		const raw = Math.round(v);
		return Math.max(1, Math.min(this.#cfg.maxStepPerTick, raw));
	}

	#restartTimer() {
		if (this.#state.timer) {
			clearInterval(this.#state.timer);
		}
		this.#state.timer = setInterval(() => void this.#tickOnce(), this.#cfg.tickMs);
	}
}

let inertiaController = null;
let inertiaDisposables = null;
/** @type {InertiaTuning} */
let currentTuning = makeTuning(DEFAULT_IMPULSE_LEVEL, DEFAULT_TICK_SLOW_LEVEL);

/**
 * @param {InertiaTuning} tuning
 * @returns {InertiaTuning}
 */
function applyResolvedTuning(tuning) {
	if (inertiaController) {
		currentTuning = inertiaController.applyTuning(tuning);
		return getCurrentTuning();
	}

	currentTuning = makeTuning(tuning.impulseLevel, tuning.tickSlowLevel);
	return getCurrentTuning();
}

/**
 * @returns {InertiaTuning}
 */
function applyUserTuningFromConfig() {
	return applyResolvedTuning(readTuningFromConfig());
}

/**
 * @returns {InertiaTuning}
 */
function getCurrentTuning() {
	return { ...currentTuning };
}

function activate() {
	if (inertiaDisposables) return false;

	inertiaController = new InertiaCursorController();
	applyUserTuningFromConfig();

	// Single-step commands (Alt+IJKL)
	const commandDisposables = [
		inertiaController.wire(),
		vscode.commands.registerCommand("cursorOnce.up", () => void moveCursor("up", 1, inertiaController?.isSelectMode() ?? false)),
		vscode.commands.registerCommand("cursorOnce.down", () => void moveCursor("down", 1, inertiaController?.isSelectMode() ?? false)),
		vscode.commands.registerCommand("cursorOnce.left", () => void moveCursor("left", 1, inertiaController?.isSelectMode() ?? false)),
		vscode.commands.registerCommand("cursorOnce.right", () => void moveCursor("right", 1, inertiaController?.isSelectMode() ?? false)),
		// Inertia commands (Ctrl+Alt+IJKL)
		vscode.commands.registerCommand("inertiaCursor.up", () => inertiaController?.impulse("up")),
		vscode.commands.registerCommand("inertiaCursor.down", () => inertiaController?.impulse("down")),
		vscode.commands.registerCommand("inertiaCursor.left", () => inertiaController?.impulse("left")),
		vscode.commands.registerCommand("inertiaCursor.right", () => inertiaController?.impulse("right")),
		vscode.commands.registerCommand("inertiaCursor.stop", () => inertiaController?.stop()),
		vscode.commands.registerCommand("inertiaCursor.toggleSelectMode", () => inertiaController?.toggleSelectMode())
	];

	inertiaDisposables = vscode.Disposable.from(...commandDisposables);
	return true;
}

function deactivate() {
	if (inertiaController) inertiaController.stop();

	if (inertiaDisposables) {
		inertiaDisposables.dispose();
		inertiaDisposables = null;
	}

	inertiaController = null;
}

function isActive() {
	return Boolean(inertiaDisposables);
}

module.exports = {
	activate,
	deactivate,
	isActive,
	applyUserTuningFromConfig,
	getCurrentTuning
};
