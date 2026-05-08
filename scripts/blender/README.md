# Mesh2Motion Blender Sprite Sheet Pipeline

This folder contains a Blender add-on that connects Mesh2Motion exports to the
Blender Sprite Sheets add-on workflow.

## Install

1. In Blender, open `Edit > Preferences > Add-ons`.
2. Click `Install...`.
3. Select `mesh2motion_sprite_sheet_pipeline.py`.
4. Enable `Mesh2Motion Sprite Sheet Pipeline`.

The original `Blender Sprite Sheets` add-on must also be installed and enabled.

## Use

1. Open the `.blend` file that contains your rigged Mesh2Motion character.
2. Make sure every animation is a Blender Action.
3. Open `View3D > Sidebar > Mesh2Motion > Mesh2Motion Sprite Sheets`.
4. Set `Target` to the root object that the Sprite Sheet add-on should render.
5. Set `Output Path`, tile size, FPS, and transform settings.
6. Keep `Only Render Marked Frames` enabled.
7. Keep `Run In Background Blender` enabled for large batches.
8. Make sure the Sprite Sheet add-on's `Bin` path is already configured.
9. Click `Render All Directions`.

By default, rendering runs in a separate background Blender process. This keeps
the active Blender UI responsive and avoids render-display/OpenGL driver crashes
that can happen when hundreds of sheets are rendered from the UI process. The
current `.blend` file is saved before the background process starts so it can
load the selected target and settings.

The add-on also writes `mesh2motion_sprite_render.log` and
`.mesh2motion_sprite_render_progress.json` into the output folder. If Blender or
the driver crashes, keep `Resume By Skipping Existing Sheets` enabled and run the
batch again; completed `.png` plus `.bss` pairs are skipped.

When `Run In Background Blender` is enabled, `Auto-Restart Attempts` controls how
many times the UI process will relaunch the background worker if it stops before
the batch is marked finished. Each restart uses the same output folder and skips
completed sheets, so long batches can recover without pressing the render button
again.

If `Run In Background Blender` is disabled, rendering runs as a modal Blender UI
job. The UI can update between individual tile renders, and pressing `Esc`
cancels the remaining export. Blender still runs each individual tile render on
the main thread, so the interface can pause briefly while a single frame is being
rendered.

The operator renders every renderable Blender Action in the file through the
Sprite Sheet add-on. This matches Mesh2Motion GLB exports that contain multiple
animations. For each action and facing, the add-on produces a separate `.png`
sheet and `.bss` metadata file inside a lowercase folder named with the output
prefix and action.

Output names use:

`<OUTPUT_PREFIX>_<ACTION_NAME>_<DIRECTION>.png`

For example, an `INJURED` action with output prefix `BROWNMAGE` produces
a `brownmage_injured` folder containing `BROWNMAGE_INJURED_N.png`,
`BROWNMAGE_INJURED_NNE.png`, and so on.

The 16 facings are: `N`, `NNE`, `NE`, `ENE`, `E`, `ESE`, `SE`, `SSE`, `S`,
`SSW`, `SW`, `WSW`, `W`, `WNW`, `NW`, `NNW`.

Direction suffixes are named for the direction the character is facing in-game.
Version `0.2.11` reverses the older `N`/`S` rotation convention so exported
filenames match the visible facing direction.

If an action has no Action Pose Markers, the add-on can create missing markers
from keyed frames before rendering. This supports the Sprite Sheet add-on's
marked-frame-only render mode.
