// extension.js
const vscode = require("vscode");
const inertia = require('./cursorInertia');
const trail = require('./cursorTrail');

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("velcursor.activateInertia", () => {
			const changed = inertia.activate?.();
			const message = changed ? "Inertia controls activated." : "Inertia controls are already active.";
			vscode.window.showInformationMessage(message);
		}),
		vscode.commands.registerCommand("velcursor.deactivateInertia", () => {
			if (inertia.isActive?.()) {
				inertia.deactivate?.();
				vscode.window.showInformationMessage("Inertia controls deactivated.");
				return;
			}

			vscode.window.showInformationMessage("Inertia controls are already inactive.");
		}),
		vscode.commands.registerCommand("velcursor.activateTrail", () => {
			const changed = trail.activate?.();
			if (changed) {
				vscode.window.showInformationMessage("Cursor trail activated.");
				return;
			}

			if (trail.isActive?.()) {
				vscode.window.showInformationMessage("Cursor trail is already active.");
			}
		}),
		vscode.commands.registerCommand("velcursor.deactivateTrail", () => {
			if (trail.isActive?.()) {
				trail.deactivate?.();
				vscode.window.showInformationMessage("Cursor trail deactivated.");
				return;
			}

			vscode.window.showInformationMessage("Cursor trail is already inactive.");
		})
	);

	// Keep movement commands available by default on extension activation.
	inertia.activate?.();
}

function deactivate() {
	trail.deactivate?.();
	inertia.deactivate?.();
}

module.exports = { activate, deactivate };
