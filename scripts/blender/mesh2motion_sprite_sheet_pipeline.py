bl_info = {
    "name": "Mesh2Motion Sprite Sheet Pipeline",
    "author": "Mesh2Motion",
    "version": (0, 2, 12),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Mesh2Motion",
    "description": "Batch-render Mesh2Motion actions through the Blender Sprite Sheets add-on.",
    "category": "Animation",
}

import json
import math
import os
import platform
import re
import shutil
import subprocess

import bpy
from bpy.props import BoolProperty, FloatProperty, IntProperty, PointerProperty, StringProperty
from bpy.types import Object, Operator, Panel, PropertyGroup


DIRECTIONS = [
    ("N", 0.0),
    ("NNE", math.radians(-22.5)),
    ("NE", math.radians(-45.0)),
    ("ENE", math.radians(-67.5)),
    ("E", -math.pi / 2.0),
    ("ESE", math.radians(-112.5)),
    ("SE", math.radians(-135.0)),
    ("SSE", math.radians(-157.5)),
    ("S", math.pi),
    ("SSW", math.radians(157.5)),
    ("SW", math.radians(135.0)),
    ("WSW", math.radians(112.5)),
    ("W", math.pi / 2.0),
    ("WNW", math.radians(67.5)),
    ("NW", math.radians(45.0)),
    ("NNW", math.radians(22.5)),
]

DIRECTION_SUFFIXES = {direction for direction, _ in DIRECTIONS}

ASSEMBLER_FILENAMES = {
    "Windows": "assembler.exe",
    "Linux": "assembler_linux",
    "Darwin": "assembler_mac",
}

PIVOT_NAME = "__MESH2MOTION_DIRECTION_PIVOT__"
RENDER_SUBJECT_TYPES = {"ARMATURE", "EMPTY", "MESH"}
MESH2MOTION_RENDER_JOB_ACTIVE = False
PROGRESS_FILENAME = ".mesh2motion_sprite_render_progress.json"
LOG_FILENAME = "mesh2motion_sprite_render.log"


def sanitize_name(value):
    cleaned = re.sub(r'[\\/:*?"<>|]+', "_", value.strip())
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned or "SPRITE"


def derive_prefix(target):
    name_parts = target.name.rsplit("_", 1)
    if len(name_parts) == 2 and name_parts[1].upper() in DIRECTION_SUFFIXES:
        return sanitize_name(name_parts[0]).upper()

    return sanitize_name(target.name).upper()


def sheet_name_for_action_direction(prefix, action, direction_name):
    action_name = sanitize_name(action.name).upper()
    return f"{prefix}_{action_name}_{direction_name}"


def action_folder_name(prefix, action):
    return f"{sanitize_name(prefix)}_{sanitize_name(action.name)}".lower()


def spritesheet_props(scene):
    if not hasattr(scene, "SpriteSheetPropertyGroup"):
        return None

    return scene.SpriteSheetPropertyGroup


def spritesheet_progress_props(scene):
    if not hasattr(scene, "ProgressPropertyGroup"):
        return None

    return scene.ProgressPropertyGroup


def spritesheet_assembler_path(props):
    filename = ASSEMBLER_FILENAMES.get(platform.system(), "assembler_mac")
    return os.path.normpath(os.path.join(bpy.path.abspath(props.binPath), filename))


def action_frame_range(action):
    frame_range = getattr(action, "frame_range", None)
    if frame_range is None:
        return None

    start = math.floor(frame_range[0])
    end = math.ceil(frame_range[1])
    if end < start:
        return None

    return start, end


def animation_end_index(start_index, rendered_frame_count):
    return start_index + max(rendered_frame_count - 1, 0)


def count_digits(value):
    count = 0
    while value > 0:
        count += 1
        value = value // 10
    return count


def index_to_string(tile_index, tile_total):
    empty_digits = count_digits(tile_total) - count_digits(tile_index)
    return ("0" * empty_digits) + str(tile_index)


def action_fcurves(action):
    fcurves = []

    # Blender 4.3 and older, plus Blender 4.4's compatibility API.
    legacy_fcurves = getattr(action, "fcurves", None)
    if legacy_fcurves is not None:
        try:
            fcurves.extend(list(legacy_fcurves))
        except Exception:
            pass

    # Blender 5.0 slotted actions store F-curves in layer/strip/channelbag data.
    layers = getattr(action, "layers", None)
    slots = list(getattr(action, "slots", []) or [])
    if layers is not None:
        for layer in layers:
            strips = getattr(layer, "strips", []) or []
            for strip in strips:
                channelbags = getattr(strip, "channelbags", None)
                if channelbags is not None:
                    for channelbag in channelbags:
                        fcurves.extend(list(getattr(channelbag, "fcurves", []) or []))

                channelbag_fn = getattr(strip, "channelbag", None)
                if callable(channelbag_fn):
                    for slot in slots:
                        try:
                            channelbag = channelbag_fn(slot)
                        except Exception:
                            channelbag = None

                        if channelbag is not None:
                            fcurves.extend(list(getattr(channelbag, "fcurves", []) or []))

    unique_fcurves = []
    seen = set()
    for fcurve in fcurves:
        key = fcurve.as_pointer() if hasattr(fcurve, "as_pointer") else id(fcurve)
        if key in seen:
            continue
        seen.add(key)
        unique_fcurves.append(fcurve)

    return unique_fcurves


def keyed_frames_for_action(action):
    frames = set()
    for fcurve in action_fcurves(action):
        for keyframe in fcurve.keyframe_points:
            frames.add(int(round(keyframe.co.x)))

    if len(frames) > 0:
        return frames

    if getattr(action, "is_empty", False):
        return frames

    frame_range = getattr(action, "frame_range", None)
    if frame_range is not None:
        start = int(round(frame_range[0]))
        end = int(round(frame_range[1]))
        if end >= start:
            return set(range(start, end + 1))

    return frames


def frames_to_render_for_action(action, only_render_marked_frames):
    markers = getattr(action, "pose_markers", None)
    if only_render_marked_frames and markers is not None and len(markers) > 0:
        return sorted({int(round(marker.frame)) for marker in markers.values()})

    bounds = action_frame_range(action)
    if bounds is not None:
        start, end = bounds
        return list(range(start, end + 1))

    return sorted(keyed_frames_for_action(action))


def ensure_action_pose_markers(action):
    if len(action.pose_markers) > 0:
        return 0

    added_count = 0
    for frame in sorted(keyed_frames_for_action(action)):
        marker = action.pose_markers.new(f"F{frame}")
        marker.frame = frame
        added_count += 1

    return added_count


def renderable_actions():
    return [
        action for action in bpy.data.actions
        if len(keyed_frames_for_action(action)) > 0
    ]


def configure_sprite_sheet_plugin(context, settings):
    props = spritesheet_props(context.scene)
    if props is None:
        raise RuntimeError("The Blender Sprite Sheets add-on is not enabled.")

    props.target = settings.target_object
    props.tileSize = (settings.tile_width, settings.tile_height)
    props.fps = settings.fps
    props.onlyRenderMarkedFrames = settings.only_render_marked_frames
    props.outputPath = bpy.path.abspath(settings.output_path)

    context.scene.render.filepath = props.outputPath
    if settings.target_object.animation_data is None:
        settings.target_object.animation_data_create()


def add_subject_with_children(subject_objects, obj):
    if obj in subject_objects or obj.type not in RENDER_SUBJECT_TYPES:
        return

    subject_objects.add(obj)
    for child in obj.children:
        add_subject_with_children(subject_objects, child)


def render_subject_objects(target, scene):
    subject_objects = set()
    add_subject_with_children(subject_objects, target)

    if target.type == "ARMATURE":
        for obj in scene.objects:
            for modifier in obj.modifiers:
                if modifier.type == "ARMATURE" and modifier.object == target:
                    add_subject_with_children(subject_objects, obj)

    return subject_objects


def subject_roots(subject_objects):
    return [
        obj for obj in subject_objects
        if obj.parent not in subject_objects
    ]


def create_direction_pivot(context, target):
    subject_objects = render_subject_objects(target, context.scene)
    roots = subject_roots(subject_objects)
    if len(roots) == 0:
        raise RuntimeError("No render subject objects found for the selected target.")

    pivot = bpy.data.objects.new(PIVOT_NAME, None)
    pivot.empty_display_type = "PLAIN_AXES"
    pivot.empty_display_size = 0.5
    pivot.location = (0.0, 0.0, 0.0)
    pivot.rotation_euler = (0.0, 0.0, 0.0)
    pivot.scale = (1.0, 1.0, 1.0)

    target_collection = target.users_collection[0] if len(target.users_collection) > 0 else context.scene.collection
    target_collection.objects.link(pivot)

    restore_records = []
    for obj in roots:
        matrix_world = obj.matrix_world.copy()
        restore_records.append({
            "object": obj,
            "parent": obj.parent,
            "matrix_parent_inverse": obj.matrix_parent_inverse.copy(),
            "matrix_world": matrix_world,
        })
        obj.parent = pivot
        obj.matrix_world = matrix_world

    context.view_layer.update()
    return pivot, restore_records


def remove_direction_pivot(context, pivot, restore_records):
    for record in restore_records:
        obj = record["object"]
        if obj.name not in bpy.data.objects:
            continue

        obj.parent = record["parent"]
        obj.matrix_parent_inverse = record["matrix_parent_inverse"]
        obj.matrix_world = record["matrix_world"]

    if pivot is not None and pivot.name in bpy.data.objects:
        bpy.data.objects.remove(pivot, do_unlink=True)

    context.view_layer.update()


def apply_direction_transform(target, settings, rotation_z, pivot=None):
    if pivot is not None:
        pivot.location = (0.0, 0.0, 0.0)
        pivot.rotation_euler = (0.0, 0.0, rotation_z)
        pivot.scale = (1.0, 1.0, 1.0)
        pivot.update_tag()

    if settings.apply_pipeline_transform:
        target.location = (0.0, 0.0, 0.0)
        target.rotation_euler[0] = math.radians(settings.rotation_x_degrees)
        target.rotation_euler[1] = 0.0
        target.rotation_euler[2] = 0.0 if pivot is not None else rotation_z
        target.scale = (settings.scale, settings.scale, settings.scale)
    else:
        if pivot is None:
            target.rotation_euler[2] = rotation_z

    target.update_tag()


def assert_sprite_sheet_runtime(scene):
    props = spritesheet_props(scene)
    progress_props = spritesheet_progress_props(scene)

    if props is None or progress_props is None:
        raise RuntimeError("The Blender Sprite Sheets add-on is not enabled.")

    assembler_path = spritesheet_assembler_path(props)
    if not os.path.isfile(assembler_path):
        raise RuntimeError(f"Sprite sheet assembler was not found at {assembler_path}")

    return props, progress_props


def temp_path_for_output(output_path):
    return bpy.path.abspath(os.path.join(output_path, "temp"))


def progress_path_for_output(output_path):
    return bpy.path.abspath(os.path.join(output_path, PROGRESS_FILENAME))


def log_path_for_output(output_path):
    return bpy.path.abspath(os.path.join(output_path, LOG_FILENAME))


def cleanup_stray_tile_files(output_path, sheet_name=""):
    if output_path == "" or sheet_name == "":
        return

    output_path = bpy.path.abspath(output_path)
    if not os.path.isdir(output_path):
        return

    stray_prefix = f"temp{sheet_name}"
    for filename in os.listdir(output_path):
        if filename.startswith(stray_prefix) and filename.lower().endswith(".png"):
            os.remove(os.path.join(output_path, filename))


def reset_temp_path(output_path, sheet_name=""):
    cleanup_stray_tile_files(output_path, sheet_name)

    temp_path = temp_path_for_output(output_path)
    if os.path.exists(temp_path):
        shutil.rmtree(temp_path)
    os.makedirs(temp_path, exist_ok=True)


def cleanup_temp_path(output_path, sheet_name=""):
    if output_path == "":
        return

    cleanup_stray_tile_files(output_path, sheet_name)

    temp_path = temp_path_for_output(output_path)
    if os.path.exists(temp_path):
        shutil.rmtree(temp_path)


def sheet_output_exists(output_path, sheet_name):
    png_path = bpy.path.abspath(os.path.join(output_path, f"{sheet_name}.png"))
    metadata_path = bpy.path.abspath(os.path.join(output_path, f"{sheet_name}.bss"))
    return os.path.isfile(png_path) and os.path.isfile(metadata_path)


def write_progress_file(progress_path, payload):
    if progress_path == "":
        return

    os.makedirs(os.path.dirname(progress_path), exist_ok=True)
    temp_path = f"{progress_path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2)
    os.replace(temp_path, progress_path)


def read_progress_file(progress_path):
    if progress_path == "" or not os.path.isfile(progress_path):
        return None

    try:
        with open(progress_path, "r", encoding="utf-8") as file:
            return json.load(file)
    except Exception:
        return None


def apply_safe_render_settings(scene, settings):
    state = {
        "display_mode": getattr(scene.render, "display_mode", None),
        "use_lock_interface": getattr(scene.render, "use_lock_interface", None),
    }

    if settings.disable_render_display and hasattr(scene.render, "display_mode"):
        try:
            scene.render.display_mode = "NONE"
        except TypeError:
            pass

    if hasattr(scene.render, "use_lock_interface"):
        scene.render.use_lock_interface = True

    return state


def restore_safe_render_settings(scene, state):
    if state is None:
        return

    if state.get("display_mode") is not None and hasattr(scene.render, "display_mode"):
        try:
            scene.render.display_mode = state["display_mode"]
        except TypeError:
            pass

    if state.get("use_lock_interface") is not None and hasattr(scene.render, "use_lock_interface"):
        scene.render.use_lock_interface = state["use_lock_interface"]


def render_tile_direct(scene, props, progress_props):
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.resolution_percentage = 100
    scene.render.resolution_x = props.tileSize[0]
    scene.render.resolution_y = props.tileSize[1]
    tile_name = progress_props.actionName + index_to_string(progress_props.tileIndex, progress_props.tileTotal)
    scene.render.filepath = os.path.join(props.outputPath, "temp", tile_name)

    if hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = 1

    bpy.ops.render.render(write_still=True)


def assemble_sprite_sheet(props, output_path, sheet_name):
    result = subprocess.run(
        [spritesheet_assembler_path(props), "--root", output_path, "--out", f"{sheet_name}.png"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        details = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"Sprite sheet assembler failed: {details or result.returncode}")


def write_sprite_sheet_metadata(props, output_path, sheet_name, action, rendered_frame_count):
    animation_end = animation_end_index(0, rendered_frame_count)
    json_info = {
        "name": sheet_name,
        "tileWidth": props.tileSize[0],
        "tileHeight": props.tileSize[1],
        "frameRate": props.fps,
        "animations": [{
            "name": action.name,
            "end": animation_end,
        }],
    }

    with open(bpy.path.abspath(os.path.join(output_path, f"{sheet_name}.bss")), "w") as file:
        json.dump(json_info, file, indent="\t")


def run_directional_sprite_sheet_batch(context, progress_path=""):
    settings = context.scene.mesh2motion_sprite_sheet_settings
    target = settings.target_object
    if target is None:
        raise RuntimeError("Choose a target object first.")

    actions = renderable_actions()
    if len(actions) == 0:
        raise RuntimeError("No renderable actions found. Each Mesh2Motion animation needs to be a Blender action.")

    if settings.create_pose_markers_from_keyframes:
        marker_count = 0
        for action in actions:
            marker_count += ensure_action_pose_markers(action)
        if marker_count > 0:
            print(f"Added {marker_count} missing action pose markers.")

    configure_sprite_sheet_plugin(context, settings)
    props, progress_props = assert_sprite_sheet_runtime(context.scene)

    output_path = bpy.path.abspath(settings.output_path)
    prefix = sanitize_name(settings.output_prefix).upper() if settings.output_prefix.strip() else derive_prefix(target)
    total_sheets = len(actions) * len(DIRECTIONS)

    os.makedirs(output_path, exist_ok=True)
    progress_props.rendering = True
    progress_props.success = False
    progress_props.actionTotal = total_sheets

    original_name = target.name
    original_rotation = target.rotation_euler.copy()
    original_scale = target.scale.copy()
    original_location = target.location.copy()
    original_action = target.animation_data.action if target.animation_data else None
    original_filepath = context.scene.render.filepath
    safe_render_state = apply_safe_render_settings(context.scene, settings)

    pivot = None
    pivot_restore_records = []
    current_output_path = ""
    completed_sheets = 0

    def write_progress(status, action_name="", sheet_name="", tile_index=0, tile_total=0, error_message=""):
        write_progress_file(progress_path, {
            "status": status,
            "actionName": sheet_name,
            "sourceActionName": action_name,
            "actionIndex": completed_sheets,
            "actionTotal": total_sheets,
            "tileIndex": tile_index,
            "tileTotal": tile_total,
            "completedSheets": completed_sheets,
            "totalSheets": total_sheets,
            "error": error_message,
        })

    try:
        write_progress("starting")

        if target.animation_data is None:
            target.animation_data_create()

        pivot, pivot_restore_records = create_direction_pivot(context, target)

        for action in actions:
            frames = frames_to_render_for_action(action, settings.only_render_marked_frames)
            if len(frames) == 0:
                continue

            for direction_name, rotation_z in DIRECTIONS:
                sheet_name = sheet_name_for_action_direction(prefix, action, direction_name)
                current_output_path = os.path.join(output_path, action_folder_name(prefix, action))

                os.makedirs(current_output_path, exist_ok=True)

                if settings.skip_existing_sheets and sheet_output_exists(current_output_path, sheet_name):
                    completed_sheets += 1
                    write_progress("skipped", action.name, sheet_name, len(frames), len(frames))
                    continue

                reset_temp_path(current_output_path, sheet_name)

                target.name = sheet_name
                target.animation_data.action = action

                props.outputPath = current_output_path
                props.target = target
                props.onlyRenderMarkedFrames = settings.only_render_marked_frames
                context.scene.render.filepath = current_output_path

                apply_direction_transform(target, settings, rotation_z, pivot)
                context.view_layer.update()

                progress_props.actionName = sheet_name
                progress_props.actionIndex = completed_sheets
                progress_props.actionTotal = total_sheets
                progress_props.tileTotal = len(frames)

                for frame_index, frame in enumerate(frames):
                    write_progress("rendering", action.name, sheet_name, frame_index, len(frames))
                    context.scene.frame_set(frame)
                    apply_direction_transform(target, settings, rotation_z, pivot)
                    context.view_layer.update()

                    progress_props.tileIndex = frame_index
                    render_tile_direct(context.scene, props, progress_props)

                assemble_sprite_sheet(props, current_output_path, sheet_name)
                write_sprite_sheet_metadata(props, current_output_path, sheet_name, action, len(frames))
                cleanup_temp_path(current_output_path, sheet_name)

                completed_sheets += 1
                write_progress("assembled", action.name, sheet_name, len(frames), len(frames))

        write_progress("finished")
        progress_props.success = True
        return completed_sheets
    except Exception as error:
        progress_props.success = False
        write_progress("error", error_message=str(error))
        raise error
    finally:
        progress_props.rendering = False
        cleanup_temp_path(current_output_path)

        if pivot is not None:
            remove_direction_pivot(context, pivot, pivot_restore_records)

        if original_name is not None:
            target.name = original_name
        target.rotation_euler = original_rotation
        target.scale = original_scale
        target.location = original_location
        if target.animation_data is not None:
            target.animation_data.action = original_action
        context.scene.render.filepath = original_filepath
        restore_safe_render_settings(context.scene, safe_render_state)
        context.view_layer.update()


class Mesh2MotionSpriteSheetSettings(PropertyGroup):
    target_object: PointerProperty(
        name="Target",
        description="Root object that the sprite sheet add-on will animate and render",
        type=Object,
    )
    output_path: StringProperty(
        name="Output Path",
        description="Folder where each directional sprite sheet and sidecar file will be written",
        subtype="DIR_PATH",
        default="//sprite_exports",
    )
    output_prefix: StringProperty(
        name="Output Prefix",
        description="Base name for rendered sheets. Empty uses the target object name",
        default="",
    )
    tile_width: IntProperty(
        name="Tile Width",
        default=240,
        min=1,
    )
    tile_height: IntProperty(
        name="Tile Height",
        default=240,
        min=1,
    )
    fps: IntProperty(
        name="FPS",
        default=24,
        min=1,
    )
    only_render_marked_frames: BoolProperty(
        name="Only Render Marked Frames",
        default=True,
    )
    create_pose_markers_from_keyframes: BoolProperty(
        name="Create Missing Pose Markers",
        description="If an action has no pose markers, add one on each keyed frame so marked-frame rendering works",
        default=True,
    )
    run_in_background: BoolProperty(
        name="Run In Background Blender",
        description="Launch a separate background Blender process for the batch render. This avoids UI/OpenGL render-display crashes and keeps this Blender session responsive",
        default=True,
    )
    background_restart_attempts: IntProperty(
        name="Auto-Restart Attempts",
        description="Automatically relaunch the background Blender worker if it stops before the batch finishes. Completed sheets are skipped on each retry",
        default=10,
        min=0,
        max=100,
    )
    skip_existing_sheets: BoolProperty(
        name="Resume By Skipping Existing Sheets",
        description="Skip a direction if both its PNG and BSS files already exist",
        default=True,
    )
    disable_render_display: BoolProperty(
        name="Disable Render Display",
        description="Prevent Blender from opening/updating a render display during batch renders",
        default=True,
    )
    ui_render_delay: FloatProperty(
        name="UI Render Delay",
        description="Delay between tile renders when not using the background process",
        default=0.25,
        min=0.01,
    )
    apply_pipeline_transform: BoolProperty(
        name="Apply Pipeline Transform",
        default=True,
    )
    rotation_x_degrees: FloatProperty(
        name="Rotation X",
        default=90.0,
    )
    scale: FloatProperty(
        name="Scale",
        default=0.04,
        min=0.0001,
    )


class MESH2MOTION_OT_configure_sprite_sheet_plugin(Operator):
    bl_idname = "mesh2motion.configure_sprite_sheet_plugin"
    bl_label = "Apply Sprite Sheet Settings"
    bl_description = "Push Mesh2Motion settings into the Blender Sprite Sheets add-on panel"

    def execute(self, context):
        settings = context.scene.mesh2motion_sprite_sheet_settings
        if settings.target_object is None:
            self.report({"ERROR"}, "Choose a target object first.")
            return {"CANCELLED"}

        try:
            configure_sprite_sheet_plugin(context, settings)
        except RuntimeError as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        self.report({"INFO"}, "Sprite sheet plug-in settings applied.")
        return {"FINISHED"}


class MESH2MOTION_OT_render_directional_sprite_sheets_background(Operator):
    bl_idname = "mesh2motion.render_directional_sprite_sheets_background"
    bl_label = "Render All Directions Background Worker"
    bl_description = "Internal worker used by the Mesh2Motion background sprite-sheet render process"
    bl_options = {"INTERNAL"}

    def execute(self, context):
        progress_path = os.environ.get("MESH2MOTION_PROGRESS_PATH", "")

        try:
            sheet_count = run_directional_sprite_sheet_batch(context, progress_path)
        except Exception as error:
            self.report({"ERROR"}, str(error))
            print(f"Mesh2Motion background render failed: {error}")
            return {"CANCELLED"}

        self.report({"INFO"}, f"Background rendered {sheet_count} sprite sheets.")
        return {"FINISHED"}


class MESH2MOTION_OT_render_directional_sprite_sheets(Operator):
    bl_idname = "mesh2motion.render_directional_sprite_sheets"
    bl_label = "Render All Directions"
    bl_description = "Render all actions through the sprite sheet add-on for 16 directional facings"
    bl_options = {"REGISTER"}

    def _reset_state(self):
        self._timer = None
        self._settings = None
        self._target = None
        self._props = None
        self._progress_props = None
        self._actions = []
        self._action_index = 0
        self._direction_index = 0
        self._completed_sheets = 0
        self._total_sheets = 0
        self._output_path = ""
        self._prefix = ""
        self._current_action = None
        self._current_direction_name = ""
        self._current_rotation_z = 0.0
        self._current_sheet_name = ""
        self._current_output_path = ""
        self._current_frames = []
        self._frame_index = 0
        self._direction_pivot = None
        self._pivot_restore_records = []
        self._safe_render_state = None
        self._background_process = None
        self._background_log_file = None
        self._background_log_path = ""
        self._background_progress_path = ""
        self._background_last_status = ""
        self._background_command = []
        self._background_env = None
        self._background_cwd = ""
        self._background_restart_count = 0
        self._background_restart_limit = 0
        self._original_name = None
        self._original_rotation = None
        self._original_scale = None
        self._original_location = None
        self._original_action = None
        self._original_filepath = None

    def invoke(self, context, event):
        return self._start(context)

    def execute(self, context):
        return self._start(context)

    def _start(self, context):
        global MESH2MOTION_RENDER_JOB_ACTIVE

        self._reset_state()

        if context.window is None:
            self.report({"ERROR"}, "Render All Directions must be run from the Blender UI.")
            return {"CANCELLED"}

        settings = context.scene.mesh2motion_sprite_sheet_settings
        target = settings.target_object
        if target is None:
            self.report({"ERROR"}, "Choose a target object first.")
            return {"CANCELLED"}

        actions = renderable_actions()
        if len(actions) == 0:
            self.report({"ERROR"}, "No renderable actions found. Each Mesh2Motion animation needs to be a Blender action.")
            return {"CANCELLED"}

        if settings.create_pose_markers_from_keyframes:
            marker_count = 0
            for action in actions:
                marker_count += ensure_action_pose_markers(action)
            if marker_count > 0:
                self.report({"INFO"}, f"Added {marker_count} missing action pose markers.")

        try:
            configure_sprite_sheet_plugin(context, settings)
            props, progress_props = assert_sprite_sheet_runtime(context.scene)
        except RuntimeError as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        if MESH2MOTION_RENDER_JOB_ACTIVE:
            self.report({"ERROR"}, "A sprite sheet render is already running.")
            return {"CANCELLED"}

        if progress_props.rendering:
            progress_props.rendering = False
            progress_props.success = False

        if settings.run_in_background and not bpy.app.background:
            return self._start_background_process(context, settings, actions, progress_props)

        try:
            self._settings = settings
            self._target = target
            self._props = props
            self._progress_props = progress_props
            self._actions = actions
            self._output_path = bpy.path.abspath(settings.output_path)
            self._prefix = sanitize_name(settings.output_prefix).upper() if settings.output_prefix.strip() else derive_prefix(target)
            self._total_sheets = len(actions) * len(DIRECTIONS)

            os.makedirs(self._output_path, exist_ok=True)

            self._original_name = target.name
            self._original_rotation = target.rotation_euler.copy()
            self._original_scale = target.scale.copy()
            self._original_location = target.location.copy()
            self._original_action = target.animation_data.action if target.animation_data else None
            self._original_filepath = context.scene.render.filepath
            self._safe_render_state = apply_safe_render_settings(context.scene, settings)

            if target.animation_data is not None:
                target.animation_data.action = actions[0]

            self._direction_pivot, self._pivot_restore_records = create_direction_pivot(context, target)
            if not self._setup_next_sheet(context):
                raise RuntimeError("No frames were found for the selected actions.")
        except RuntimeError as error:
            self._cleanup(context, success=False)
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        MESH2MOTION_RENDER_JOB_ACTIVE = True
        progress_props.rendering = True
        progress_props.success = False
        progress_props.actionTotal = self._total_sheets

        self._timer = context.window_manager.event_timer_add(settings.ui_render_delay, window=context.window)
        context.window_manager.modal_handler_add(self)

        self.report({"INFO"}, f"Started rendering {self._total_sheets} sprite sheets. Press Esc to cancel.")
        return {"RUNNING_MODAL"}

    def _start_background_process(self, context, settings, actions, progress_props):
        global MESH2MOTION_RENDER_JOB_ACTIVE

        blend_path = bpy.data.filepath
        if blend_path == "":
            self.report({"ERROR"}, "Save the .blend file before running a background sprite-sheet render.")
            return {"CANCELLED"}

        output_path = bpy.path.abspath(settings.output_path)
        os.makedirs(output_path, exist_ok=True)

        progress_path = progress_path_for_output(output_path)
        log_path = log_path_for_output(output_path)
        write_progress_file(progress_path, {
            "status": "starting",
            "actionName": "",
            "actionIndex": 0,
            "actionTotal": len(actions) * len(DIRECTIONS),
            "tileIndex": 0,
            "tileTotal": 0,
            "completedSheets": 0,
            "totalSheets": len(actions) * len(DIRECTIONS),
        })

        # Persist the current add-on settings and target pointer for the background Blender process.
        bpy.ops.wm.save_as_mainfile(filepath=blend_path)

        command = [
            bpy.app.binary_path,
            "--background",
            blend_path,
            "--python",
            bpy.path.abspath(__file__),
            "--python-expr",
            "import bpy, sys; result = bpy.ops.mesh2motion.render_directional_sprite_sheets_background(); sys.exit(0 if 'FINISHED' in result else 1)",
        ]

        env = os.environ.copy()
        env["MESH2MOTION_PROGRESS_PATH"] = progress_path

        self._settings = settings
        self._progress_props = progress_props
        self._output_path = output_path
        self._total_sheets = len(actions) * len(DIRECTIONS)
        self._background_log_path = log_path
        self._background_progress_path = progress_path
        self._background_command = command
        self._background_env = env
        self._background_cwd = os.path.dirname(blend_path)
        self._background_restart_limit = settings.background_restart_attempts

        try:
            self._launch_background_process(log_mode="w")
        except OSError as error:
            MESH2MOTION_RENDER_JOB_ACTIVE = False
            self.report({"ERROR"}, f"Failed to start background Blender render: {error}")
            return {"CANCELLED"}

        MESH2MOTION_RENDER_JOB_ACTIVE = True
        progress_props.rendering = True
        progress_props.success = False
        progress_props.actionTotal = self._total_sheets

        self._timer = context.window_manager.event_timer_add(1.0, window=context.window)
        context.window_manager.modal_handler_add(self)

        self.report({"INFO"}, f"Started background render for {self._total_sheets} sprite sheets. Log: {log_path}")
        return {"RUNNING_MODAL"}

    def _launch_background_process(self, log_mode="a"):
        log_file = open(self._background_log_path, log_mode, encoding="utf-8")
        try:
            if log_mode == "a":
                log_file.write(
                    f"\n\n--- Mesh2Motion background render restart "
                    f"{self._background_restart_count}/{self._background_restart_limit} ---\n"
                )
                log_file.flush()

            process = subprocess.Popen(
                self._background_command,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                env=self._background_env,
                cwd=self._background_cwd,
            )
        except OSError:
            log_file.close()
            raise

        self._background_process = process
        self._background_log_file = log_file

    def _close_background_log_file(self):
        if self._background_log_file is not None:
            self._background_log_file.close()
            self._background_log_file = None

    def _background_run_complete(self, return_code, progress):
        if return_code != 0:
            return False

        if progress is None:
            return True

        if progress.get("status", "") == "finished":
            return True

        completed_sheets = int(progress.get("completedSheets", 0))
        total_sheets = int(progress.get("totalSheets", self._total_sheets))
        return total_sheets > 0 and completed_sheets >= total_sheets

    def _restart_background_process(self, return_code, progress):
        if self._background_restart_count >= self._background_restart_limit:
            return False

        self._background_restart_count += 1
        restart_payload = dict(progress or {})
        restart_payload.update({
            "status": "restarting",
            "actionTotal": int(restart_payload.get("actionTotal", self._total_sheets)),
            "totalSheets": int(restart_payload.get("totalSheets", self._total_sheets)),
            "restartAttempt": self._background_restart_count,
            "restartLimit": self._background_restart_limit,
            "error": f"Background Blender stopped with exit code {return_code}; restarting.",
        })
        write_progress_file(self._background_progress_path, restart_payload)

        self._launch_background_process(log_mode="a")
        if self._progress_props is not None:
            self._progress_props.rendering = True
            self._progress_props.success = False

        return True

    def _setup_next_sheet(self, context):
        while self._action_index < len(self._actions):
            action = self._actions[self._action_index]
            direction_name, rotation_z = DIRECTIONS[self._direction_index]
            frames = frames_to_render_for_action(action, self._settings.only_render_marked_frames)

            self._current_action = action
            self._current_direction_name = direction_name
            self._current_rotation_z = rotation_z
            self._current_sheet_name = sheet_name_for_action_direction(self._prefix, action, direction_name)
            self._current_output_path = os.path.join(self._output_path, action_folder_name(self._prefix, action))
            self._current_frames = frames
            self._frame_index = 0

            if len(frames) == 0:
                self._advance_sheet()
                continue

            os.makedirs(self._current_output_path, exist_ok=True)
            if self._settings.skip_existing_sheets and sheet_output_exists(self._current_output_path, self._current_sheet_name):
                self._advance_sheet()
                continue

            reset_temp_path(self._current_output_path, self._current_sheet_name)

            self._target.name = self._current_sheet_name
            self._target.animation_data.action = action

            self._props.outputPath = self._current_output_path
            self._props.target = self._target
            self._props.onlyRenderMarkedFrames = self._settings.only_render_marked_frames
            context.scene.render.filepath = self._current_output_path

            apply_direction_transform(self._target, self._settings, rotation_z, self._direction_pivot)
            context.view_layer.update()

            self._progress_props.actionName = self._current_sheet_name
            self._progress_props.actionIndex = self._completed_sheets
            self._progress_props.actionTotal = self._total_sheets
            self._progress_props.tileIndex = 0
            self._progress_props.tileTotal = len(frames)
            return True

        return False

    def _advance_sheet(self):
        self._completed_sheets += 1
        self._direction_index += 1
        if self._direction_index >= len(DIRECTIONS):
            self._direction_index = 0
            self._action_index += 1

    def _finish_current_sheet(self):
        assemble_sprite_sheet(self._props, self._current_output_path, self._current_sheet_name)
        write_sprite_sheet_metadata(
            self._props,
            self._current_output_path,
            self._current_sheet_name,
            self._current_action,
            len(self._current_frames),
        )
        cleanup_temp_path(self._current_output_path, self._current_sheet_name)
        self._progress_props.success = True

    def _render_next_tile(self, context):
        if self._frame_index >= len(self._current_frames):
            self._finish_current_sheet()
            self._advance_sheet()
            if self._setup_next_sheet(context):
                return {"RUNNING_MODAL"}
            return self._finish(context)

        frame = self._current_frames[self._frame_index]
        context.scene.frame_set(frame)
        apply_direction_transform(self._target, self._settings, self._current_rotation_z, self._direction_pivot)
        context.view_layer.update()

        self._progress_props.tileIndex = self._frame_index
        render_tile_direct(context.scene, self._props, self._progress_props)

        self._frame_index += 1
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if event.type == "ESC":
            return self.cancel(context)

        if event.type == "TIMER":
            if self._background_process is not None:
                return self._monitor_background_process(context)

            try:
                result = self._render_next_tile(context)
            except RuntimeError as error:
                self._cleanup(context, success=False)
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}

            if context.area is not None:
                context.area.tag_redraw()
            return result

        return {"PASS_THROUGH"}

    def _monitor_background_process(self, context):
        global MESH2MOTION_RENDER_JOB_ACTIVE

        progress = read_progress_file(self._background_progress_path)
        if progress is not None and self._progress_props is not None:
            self._progress_props.actionName = progress.get("actionName", "")
            self._progress_props.actionIndex = int(progress.get("actionIndex", 0))
            self._progress_props.actionTotal = int(progress.get("actionTotal", self._total_sheets))
            self._progress_props.tileIndex = int(progress.get("tileIndex", 0))
            self._progress_props.tileTotal = int(progress.get("tileTotal", 0))

            status = progress.get("status", "")
            if status != self._background_last_status:
                self._background_last_status = status
                if status not in {"", "rendering"}:
                    print(f"Mesh2Motion background render status: {status}")

        return_code = self._background_process.poll()
        if return_code is None:
            if context.area is not None:
                context.area.tag_redraw()
            return {"RUNNING_MODAL"}

        self._close_background_log_file()
        if not self._background_run_complete(return_code, progress):
            try:
                if self._restart_background_process(return_code, progress):
                    self.report(
                        {"WARNING"},
                        f"Background render stopped and was restarted "
                        f"({self._background_restart_count}/{self._background_restart_limit}).",
                    )
                    return {"RUNNING_MODAL"}
            except OSError as error:
                error_message = f"Failed to restart background Blender render: {error}"
                if progress is not None:
                    error_message = f"{error_message} Last worker error: {progress.get('error', '')}"
                self.report({"ERROR"}, error_message)
                if self._progress_props is not None:
                    self._progress_props.rendering = False
                    self._progress_props.success = False
                MESH2MOTION_RENDER_JOB_ACTIVE = False
                return {"CANCELLED"}

        if self._timer is not None:
            context.window_manager.event_timer_remove(self._timer)
            self._timer = None

        MESH2MOTION_RENDER_JOB_ACTIVE = False

        if self._progress_props is not None:
            self._progress_props.rendering = False
            self._progress_props.success = self._background_run_complete(return_code, progress)

        if self._background_run_complete(return_code, progress):
            sheet_count = 0
            if progress is not None:
                sheet_count = int(progress.get("completedSheets", 0))
            self.report({"INFO"}, f"Background render finished: {sheet_count} sprite sheets. Log: {self._background_log_path}")
            return {"FINISHED"}

        error_message = ""
        if progress is not None:
            error_message = progress.get("error", "")

        details = f" {error_message}" if error_message else ""
        self.report({"ERROR"}, f"Background render failed with exit code {return_code}.{details} See log: {self._background_log_path}")
        return {"CANCELLED"}

    def _finish(self, context):
        sheet_count = self._completed_sheets
        output_path = self._output_path
        action_count = len(self._actions)
        self._cleanup(context, success=True)
        self.report({"INFO"}, f"Rendered {sheet_count} sprite sheets for {action_count} actions into action folders under {output_path}")
        return {"FINISHED"}

    def cancel(self, context):
        if self._background_process is not None and self._background_process.poll() is None:
            self._background_process.terminate()

        self._cleanup(context, success=False)
        self.report({"INFO"}, "Sprite sheet render cancelled.")
        return {"CANCELLED"}

    def _cleanup(self, context, success):
        global MESH2MOTION_RENDER_JOB_ACTIVE

        MESH2MOTION_RENDER_JOB_ACTIVE = False

        if self._timer is not None:
            context.window_manager.event_timer_remove(self._timer)
            self._timer = None

        if self._background_log_file is not None:
            self._close_background_log_file()

        cleanup_temp_path(self._current_output_path, self._current_sheet_name)

        if self._progress_props is not None:
            self._progress_props.rendering = False
            self._progress_props.success = success

        if self._target is not None:
            remove_direction_pivot(context, self._direction_pivot, self._pivot_restore_records)

            if self._original_name is not None:
                self._target.name = self._original_name
            if self._original_rotation is not None:
                self._target.rotation_euler = self._original_rotation
            if self._original_scale is not None:
                self._target.scale = self._original_scale
            if self._original_location is not None:
                self._target.location = self._original_location
            if self._target.animation_data is not None:
                self._target.animation_data.action = self._original_action
            if self._original_filepath is not None:
                context.scene.render.filepath = self._original_filepath

            restore_safe_render_settings(context.scene, self._safe_render_state)
            context.view_layer.update()


class MESH2MOTION_PT_sprite_sheet_pipeline(Panel):
    bl_idname = "MESH2MOTION_PT_sprite_sheet_pipeline"
    bl_label = "Mesh2Motion Sprite Sheets"
    bl_category = "Mesh2Motion"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"

    def draw(self, context):
        layout = self.layout
        settings = context.scene.mesh2motion_sprite_sheet_settings

        layout.prop(settings, "target_object")
        layout.prop(settings, "output_path")
        layout.prop(settings, "output_prefix")
        layout.label(text=f"Actions in file: {len(bpy.data.actions)}")

        row = layout.row(align=True)
        row.prop(settings, "tile_width")
        row.prop(settings, "tile_height")
        layout.prop(settings, "fps")
        layout.prop(settings, "only_render_marked_frames")
        layout.prop(settings, "create_pose_markers_from_keyframes")
        layout.prop(settings, "run_in_background")
        if settings.run_in_background:
            layout.prop(settings, "background_restart_attempts")
        layout.prop(settings, "skip_existing_sheets")
        layout.prop(settings, "disable_render_display")
        if not settings.run_in_background:
            layout.prop(settings, "ui_render_delay")

        layout.separator()
        layout.prop(settings, "apply_pipeline_transform")
        if settings.apply_pipeline_transform:
            layout.prop(settings, "rotation_x_degrees")
            layout.prop(settings, "scale")

        layout.separator()
        layout.operator("mesh2motion.configure_sprite_sheet_plugin", icon="CHECKMARK")
        layout.operator_context = "INVOKE_DEFAULT"
        layout.operator("mesh2motion.render_directional_sprite_sheets", icon="RENDER_ANIMATION")


classes = (
    Mesh2MotionSpriteSheetSettings,
    MESH2MOTION_OT_configure_sprite_sheet_plugin,
    MESH2MOTION_OT_render_directional_sprite_sheets_background,
    MESH2MOTION_OT_render_directional_sprite_sheets,
    MESH2MOTION_PT_sprite_sheet_pipeline,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)

    bpy.types.Scene.mesh2motion_sprite_sheet_settings = PointerProperty(
        type=Mesh2MotionSpriteSheetSettings
    )


def unregister():
    del bpy.types.Scene.mesh2motion_sprite_sheet_settings

    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    try:
        register()
    except ValueError:
        # The add-on may already be enabled when a background Blender process
        # runs this file through --python. In that case the registered operator
        # classes are already available for the following --python-expr call.
        pass
