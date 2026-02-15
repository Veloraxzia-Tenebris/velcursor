# velCursor

`velCursor` is a VS Code extension + injected renderer pair for inertial cursor motion and hex-polygon trail visualization.

## Model Overview

The system has two coupled components:

1. Host-side inertial controller (`extension.js`, `cursorInertia.js`)
2. Browser-side trail renderer (`cursorTrail.js`, loaded via Custom CSS/JS)

Primary objective:

- maximize perceived continuity of cursor motion subject to bounded CPU/GPU budget.

## Discrete Inertia Dynamics

State:

- scalar velocity `v_k`
- direction `d_k`
- tick interval `\Delta t = tickMs`

Update equations:

- same-direction impulse:
  - `v_k <- min(v_k + impulse, maxVelocity)`
- direction switch:
  - `v_k <- max(initialVelocity, 0.1 * v_k)`
- per-tick step magnitude:
  - first tick: `s_k = 2`
  - subsequent ticks: `s_k = clamp(round(v_k), 1, maxStepPerTick)`
- decay:
  - `v_{k+1} = decay * v_k`
- stop criterion:
  - inertia run ends when `v_k < cutoff`

Level-to-parameter mapping (`level in [1, 10]`):

- `t = (level - 1) / 9`
- `impulse(level) = IMPULSE_MIN + t(IMPULSE_MAX - IMPULSE_MIN)`
- `tickMs(level) = round(TICK_MS_MIN + t(TICK_MS_MAX - TICK_MS_MIN))`

## Trail Geometry Pipeline

Trail cells are rendered as directional hex polygons.

Pipeline:

1. sample caret-corner polygon from spring state
2. canonicalize winding/corner correspondence
3. interpolate intermediate polygons
4. construct directional hex cells
5. append caret-anchored head bridge + head cap
6. alpha-fade by sample age

Age envelope:

- `frac = clamp((now - t_sample)/ttlMs, 0, 1)`
- width scale:
  - `w(frac) = 0.20 + 0.80(1 - frac)`

## Runtime Namespaces

- active-guard flag: `window.__vel_cursor_active__`
- cleanup hook: `window.__velCursorCleanup`
- canvas id: `__vel_cursor_canvas__`
- caret-layer style id: `__vel_cursor_native_caret_layer__`

## Commands

Extension commands:

- `VelCursor: Activate Inertia`
- `VelCursor: Deactivate Inertia`
- `VelCursor: Set Inertia Impulse Level`
- `VelCursor: Set Inertia Tick Slowness Level`

Default keybindings:

- single-step: `Alt+I`, `Alt+K`, `Alt+J`, `Alt+L`
- inertia impulses: `Ctrl+Alt+I`, `Ctrl+Alt+K`, `Ctrl+Alt+J`, `Ctrl+Alt+L`
- stop inertia: `Esc`
- toggle select mode: `Alt+U`

## Loader Setup (Custom CSS/JS)

1. Add `cursorTrail.js` to your Custom CSS/JS loader import list.
2. Apply/patch the loader.
3. Reload VS Code.

If the loader caches assets, re-apply after script edits.

## Tuning Coordinates

For responsiveness:

- increase `inertiaImpulseLevel`
- decrease `inertiaTickSlowLevel`

For smoother trail continuity:

- decrease `adaptiveInterpStepPx`
- increase `maxInterpPerPush`
- decrease `drawSubdivideStepPx`
- increase `maxDrawSubdivisions`

For stronger hex profile visibility:

- decrease `partialEdgeShare`
- increase `concavityDepth` (above `0`)

For immediate onset:

- keep `minMoveCharsForTrail = 0`

## Constraints

- trail runtime is browser-side only; it is not imported by `extension.js`
- rendering depends on Monaco caret DOM (`.monaco-editor .cursor`)
- visual output quality is constrained by frame-time adaptation and subdivision budget
