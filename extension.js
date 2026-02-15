// extension.js
const vscode = require("vscode");
const inertia = require('./cursorInertia');

const CONFIG_SECTION = "velcursor";
const IMPULSE_LEVEL_KEY = "inertiaImpulseLevel";
const TICK_SLOW_LEVEL_KEY = "inertiaTickSlowLevel";
const LEVEL_MIN = 1;
const LEVEL_MAX = 10;

function levelItems(currentLevel) {
	return Array.from({ length: LEVEL_MAX - LEVEL_MIN + 1 }, (_, idx) => {
		const level = LEVEL_MIN + idx;
		return {
			label: String(level),
			description: level === currentLevel ? "Current" : ""
		};
	});
}

async function pickLevel(title, placeHolder, currentLevel) {
	const picked = await vscode.window.showQuickPick(levelItems(currentLevel), {
		title,
		placeHolder
	});
	if (!picked) return null;

	return Number(picked.label);
}

async function updateLevelSetting(settingKey, level) {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	await config.update(settingKey, level, vscode.ConfigurationTarget.Global);
}

function activate(context) {
	const syncInertiaTuningFromConfig = () => inertia.applyUserTuningFromConfig?.();

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
		vscode.commands.registerCommand("velcursor.setInertiaImpulseLevel", async () => {
			const current = inertia.getCurrentTuning?.();
			const pickedLevel = await pickLevel(
				"Set Inertia Impulse Level",
				"1 = weakest acceleration, 10 = strongest acceleration",
				current?.impulseLevel ?? 4
			);
			if (pickedLevel === null) return;

			await updateLevelSetting(IMPULSE_LEVEL_KEY, pickedLevel);
			const applied = syncInertiaTuningFromConfig() ?? inertia.getCurrentTuning?.();
			if (!applied) return;

			vscode.window.showInformationMessage(
				`Inertia impulse level set to ${applied.impulseLevel}/10 (${applied.impulse.toFixed(2)} velocity units per impulse).`
			);
		}),
		vscode.commands.registerCommand("velcursor.setInertiaTickSlowLevel", async () => {
			const current = inertia.getCurrentTuning?.();
			const pickedLevel = await pickLevel(
				"Set Inertia Tick Slowness Level",
				"1 = fastest cadence, 10 = slowest cadence",
				current?.tickSlowLevel ?? 4
			);
			if (pickedLevel === null) return;

			await updateLevelSetting(TICK_SLOW_LEVEL_KEY, pickedLevel);
			const applied = syncInertiaTuningFromConfig() ?? inertia.getCurrentTuning?.();
			if (!applied) return;

			vscode.window.showInformationMessage(
				`Inertia tick slowness level set to ${applied.tickSlowLevel}/10 (${applied.tickMs} ms per tick).`
			);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration(`${CONFIG_SECTION}.${IMPULSE_LEVEL_KEY}`) ||
				event.affectsConfiguration(`${CONFIG_SECTION}.${TICK_SLOW_LEVEL_KEY}`)
			) {
				syncInertiaTuningFromConfig();
			}
		})
	);

	// Keep movement commands available by default on extension activation.
	inertia.activate?.();
	syncInertiaTuningFromConfig();
}

function deactivate() {
	inertia.deactivate?.();
}

module.exports = { activate, deactivate };
