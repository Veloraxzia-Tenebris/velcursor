"use strict";

const vscode = require("vscode");

/** @typedef {"up"|"down"|"left"|"right"} Direction */

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
		tickMs: 32,					 // base cadence
		initialVelocity: 1.1, // starting speed when inertia starts
		impulse: 0.86,				 // added per repeated Ctrl+Alt press
		maxVelocity: 512.0,
		decay: 0.96,					// multiply each tick
		cutoff: 0.99,				 // stop when below this
		maxStepPerTick: 8,	 // cap per tick
		suppressSelectionEvents: 512
	};

	#state = {
		running: false,
		dir: /** @type {Direction|null} */ (null),
		velocity: 0,
		timer: /** @type {NodeJS.Timeout|null} */ (null),
		expectedSig: /** @type {string|null} */ (null),
		suppressSelEvents: 0,
		selectMode: false
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

		if (this.#state.timer) {
			clearInterval(this.#state.timer);
			this.#state.timer = null;
		}
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

			// immediate tick, then loop
			void this.#tickOnce();
			this.#state.timer = setInterval(() => void this.#tickOnce(), this.#cfg.tickMs);
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

		const step = this.#stepFromVelocity(this.#state.velocity);
		const dir = this.#state.dir;

		this.#state.suppressSelEvents = this.#cfg.suppressSelectionEvents;

		await moveCursor(dir, step, this.#state.selectMode);

		this.#state.expectedSig = selectionSig(editor);
		this.#state.velocity *= this.#cfg.decay;
	}

	#stepFromVelocity(v) {
		const raw = Math.round(v);
		return Math.max(1, Math.min(this.#cfg.maxStepPerTick, raw));
	}
}

let inertiaController = null;
let inertiaDisposables = null;

function activate() {
	if (inertiaDisposables) return false;

	inertiaController = new InertiaCursorController();

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
	isActive
};
