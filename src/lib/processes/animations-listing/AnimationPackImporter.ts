import JSZip from 'jszip'
import {
  AnimationClip,
  Skeleton,
  type Bone,
  type KeyframeTrack,
  type Object3D,
  type SkinnedMesh
} from 'three'
import { UI } from '../../UI.ts'
import { ModalDialog } from '../../ModalDialog.ts'
import { SkeletonType } from '../../enums/SkeletonType.ts'
import { AnimationUtility } from './AnimationUtility.ts'
import {
  AnimationLoader,
  type LoadedAnimationSource
} from './AnimationLoader.ts'
import {
  AnimationPackStore,
  animation_pack_metadata,
  type AnimationPackSource,
  type StoredAnimationPackRecord
} from './AnimationPackStore.ts'
import { AnimationPackExporter } from './AnimationPackExporter.ts'
import {
  type AnimationRootMotionMode,
  type TransformedAnimationClipPair
} from './interfaces/TransformedAnimationClipPair.ts'
import CustomAnimationValidation from './CustomAnimationValidation.ts'
import { RetargetUtils } from '../../../retarget/RetargetUtils.ts'
import { Rig } from '../../../retarget/human-retargeting/Rig.ts'
import { Retargeter } from '../../../retarget/human-retargeting/Retargeter.ts'
import { HumanChainConfig } from '../../../retarget/human-retargeting/HumanChainConfig.ts'

export interface AnimationPackImportContext {
  skinned_meshes_to_animate: SkinnedMesh[]
  skeleton_type: SkeletonType
  skeleton_scale: number
}

export interface AnimationPackImportSuccess {
  record: StoredAnimationPackRecord
  animations: TransformedAnimationClipPair[]
  warnings: string[]
}

type DetectedAnimationSource = 'mesh2motion' | 'mixamo' | 'unknown'

interface AnimationPackImportOptions {
  prefer_file_names_for_clip_names?: boolean
}

interface FileSystemFileHandleLike {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
}

interface FileSystemDirectoryHandleLike {
  kind: 'directory'
  name: string
  values: () => any
}

export class AnimationPackImporter extends EventTarget {
  private readonly ui: UI = UI.getInstance()
  private readonly animation_loader: AnimationLoader
  private readonly store: AnimationPackStore = new AnimationPackStore()
  private readonly exporter: AnimationPackExporter = new AnimationPackExporter()
  private import_context_provider: (() => AnimationPackImportContext) | null = null
  private enabled: boolean = true
  private has_added_event_listeners: boolean = false
  private import_menu_element: HTMLDivElement | null = null

  constructor (animation_loader: AnimationLoader) {
    super()
    this.animation_loader = animation_loader
    this.add_event_listeners()
  }

  public set_import_context_provider (provider: () => AnimationPackImportContext): void {
    this.import_context_provider = provider
  }

  public set_enabled (enabled: boolean): void {
    this.enabled = enabled
    const button = this.ui.dom_import_animation_pack_button
    if (button !== null) {
      button.disabled = !enabled
    }
  }

  private add_event_listeners (): void {
    if (this.has_added_event_listeners) {
      return
    }

    this.ui.dom_import_animation_pack_button?.addEventListener('click', (event) => {
      if (!this.enabled) {
        return
      }

      event.stopPropagation()
      this.toggle_import_menu()
    })

    this.ui.dom_import_animation_pack_input?.addEventListener('change', (event) => {
      void this.handle_import_input_change(event)
    })

    document.addEventListener('click', (event) => {
      if (this.import_menu_element === null) {
        return
      }

      const target = event.target as Node | null
      if (target !== null && this.import_menu_element.contains(target)) {
        return
      }

      this.hide_import_menu()
    })

    this.has_added_event_listeners = true
  }

  private toggle_import_menu (): void {
    if (this.import_menu_element !== null) {
      this.hide_import_menu()
      return
    }

    this.show_import_menu()
  }

  private show_import_menu (): void {
    const button = this.ui.dom_import_animation_pack_button
    if (button === null) {
      return
    }

    const button_rect = button.getBoundingClientRect()
    const menu = document.createElement('div')
    menu.className = 'animation-pack-import-menu'
    menu.innerHTML = `
      <button type="button" class="secondary-button animation-pack-import-menu-option" data-import-mode="folder">
        <span class="material-symbols-outlined">folder_open</span>
        <span>Folder of FBXs</span>
      </button>
      <button type="button" class="secondary-button animation-pack-import-menu-option" data-import-mode="files">
        <span class="material-symbols-outlined">upload_file</span>
        <span>Files or ZIP</span>
      </button>
    `

    menu.style.visibility = 'hidden'

    menu.addEventListener('click', (event) => {
      event.stopPropagation()

      const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-import-mode]')
      if (option === null) {
        return
      }

      const import_mode = option.getAttribute('data-import-mode')
      this.hide_import_menu()

      if (import_mode === 'folder') {
        void this.handle_directory_import()
        return
      }

      this.ui.dom_import_animation_pack_input?.click()
    })

    document.body.appendChild(menu)

    const menu_rect = menu.getBoundingClientRect()
    const viewport_padding = 8
    const gap = 6
    const left = Math.max(
      viewport_padding,
      Math.min(button_rect.left, window.innerWidth - menu_rect.width - viewport_padding)
    )
    let top = button_rect.top - menu_rect.height - gap
    if (top < viewport_padding) {
      top = Math.min(button_rect.bottom + gap, window.innerHeight - menu_rect.height - viewport_padding)
    }

    menu.style.left = `${left}px`
    menu.style.top = `${Math.max(viewport_padding, top)}px`
    menu.style.visibility = 'visible'
    this.import_menu_element = menu
  }

  private hide_import_menu (): void {
    if (this.import_menu_element === null) {
      return
    }

    this.import_menu_element.remove()
    this.import_menu_element = null
  }

  private async handle_import_input_change (event: Event): Promise<void> {
    if (!this.enabled || this.import_context_provider === null) {
      return
    }

    const input = event.target as HTMLInputElement
    const files = input.files
    if (files === null || files.length === 0) {
      return
    }

    const file_list = Array.from(files)
    await this.import_files_with_prompt(file_list, this.default_pack_name(file_list), {
      prefer_file_names_for_clip_names: file_list.length > 1
    })

    input.value = ''
  }

  private async handle_directory_import (): Promise<void> {
    if (!this.enabled || this.import_context_provider === null) {
      return
    }

    try {
      const directory_picker = (window as unknown as {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike>
      }).showDirectoryPicker
      if (typeof directory_picker === 'function') {
        const directory_handle = await directory_picker.call(window)
        const files = await this.collect_animation_files_from_directory(directory_handle)
        await this.import_files_with_prompt(files, directory_handle.name ?? 'Imported Animation Pack', {
          prefer_file_names_for_clip_names: true
        })
        return
      }

      const directory_selection = await this.select_directory_with_input()
      if (directory_selection === null) {
        return
      }

      await this.import_files_with_prompt(directory_selection.files, directory_selection.pack_name, {
        prefer_file_names_for_clip_names: true
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }

      const error_message = error instanceof Error ? error.message : String(error)
      new ModalDialog('Error Importing Animation Folder', error_message).show()
    }
  }

  private async import_files_with_prompt (
    files: File[],
    default_pack_name: string,
    options: AnimationPackImportOptions = {}
  ): Promise<void> {
    if (this.import_context_provider === null) {
      return
    }

    if (files.length === 0) {
      new ModalDialog('Error Importing Animation Pack', 'No FBX, GLB, or GLTF animation files were found.').show()
      return
    }

    const pack_name = window.prompt('Animation pack name', default_pack_name)
    if (pack_name === null || pack_name.trim() === '') {
      return
    }

    this.set_enabled(false)

    try {
      const import_result = await this.import_animation_pack(
        files,
        pack_name.trim(),
        this.import_context_provider(),
        options
      )

      this.dispatchEvent(new CustomEvent<AnimationPackImportSuccess>('pack-import-success', {
        detail: import_result
      }))

      const warning_message = import_result.warnings.length > 0
        ? `<br><br>Skipped ${import_result.warnings.length} file(s):<br>${this.escape_html(import_result.warnings.slice(0, 8).join('\n')).replace(/\n/g, '<br>')}`
        : ''

      new ModalDialog(
        'Animation Pack Imported',
        `${import_result.record.clip_count} animations were added to ${this.escape_html(import_result.record.name)}.${warning_message}`
      ).show()
    } catch (error) {
      const error_message = error instanceof Error ? error.message : String(error)
      new ModalDialog('Error Importing Animation Pack', error_message).show()
    } finally {
      this.set_enabled(true)
    }
  }

  private async import_animation_pack (
    files: File[],
    pack_name: string,
    context: AnimationPackImportContext,
    options: AnimationPackImportOptions = {}
  ): Promise<AnimationPackImportSuccess> {
    if (context.skinned_meshes_to_animate.length === 0) {
      throw new Error('Load or bind a skinned model before importing an animation pack.')
    }

    const animation_files = await this.expand_animation_files(files)
    if (animation_files.length === 0) {
      throw new Error('No FBX, GLB, or GLTF animation files were found.')
    }

    const converted_clips: AnimationClip[] = []
    const source_types = new Set<AnimationPackSource>()
    const warnings: string[] = []
    const prefer_file_names_for_clip_names = options.prefer_file_names_for_clip_names === true ||
      animation_files.length > 1

    for (const file of animation_files) {
      let source: LoadedAnimationSource
      try {
        source = await this.animation_loader.load_animation_source_from_file(file)
      } catch (error) {
        warnings.push(`${file.name}: ${this.readable_import_error(error)}`)
        continue
      }

      if (source.animations.length === 0) {
        warnings.push(`${file.name}: no animations found`)
        continue
      }

      try {
        const detected_source = this.detect_animation_source(source, context.skinned_meshes_to_animate)
        if (detected_source === 'mixamo') {
          if (context.skeleton_type !== SkeletonType.Human) {
            warnings.push(`${source.file_name}: Mixamo animation packs can only be imported into the Human Mesh2Motion skeleton`)
            continue
          }

          converted_clips.push(...this.retarget_mixamo_source(source, context, prefer_file_names_for_clip_names))
          source_types.add('mixamo')
          continue
        }

        if (detected_source === 'mesh2motion') {
          converted_clips.push(...this.process_mesh2motion_source(source, context, prefer_file_names_for_clip_names))
          source_types.add('mesh2motion')
          continue
        }

        warnings.push(`${source.file_name}: does not look like a Mesh2Motion or Mixamo animation file`)
      } catch (error) {
        warnings.push(`${source.file_name}: ${this.readable_import_error(error)}`)
      }
    }

    if (converted_clips.length === 0) {
      const warning_details = warnings.length > 0
        ? `\n\nSkipped files:\n${warnings.slice(0, 12).join('\n')}`
        : ''
      throw new Error(`No animations were imported from the selected files.${warning_details}`)
    }

    this.ensure_unique_clip_names(converted_clips)

    const root_motion_mode = this.detect_root_motion_mode(converted_clips)
    const glb_data = await this.exporter.export_pack_buffer(
      context.skinned_meshes_to_animate,
      converted_clips
    )

    const record = this.create_pack_record(
      pack_name,
      context.skeleton_type,
      this.pack_source_from_set(source_types),
      root_motion_mode,
      animation_files.map(file => file.name),
      converted_clips.length,
      glb_data
    )

    await this.store.put(record)

    const animations = await this.animation_loader.load_animations_from_array_buffer(
      record.glb_data,
      `${record.name}.glb`,
      1.0,
      animation_pack_metadata(record)
    )

    return { record, animations, warnings }
  }

  private async expand_animation_files (files: File[]): Promise<File[]> {
    const animation_files: File[] = []

    for (const file of files) {
      const file_name = file.name.toLowerCase()
      if (this.is_supported_animation_file(file_name)) {
        animation_files.push(file)
        continue
      }

      if (!file_name.endsWith('.zip')) {
        continue
      }

      const zip = await JSZip.loadAsync(await file.arrayBuffer())
      const zip_entries = Object.values(zip.files)
      for (const zip_entry of zip_entries) {
        if (zip_entry.dir || !this.is_supported_animation_file(zip_entry.name.toLowerCase())) {
          continue
        }

        const blob = await zip_entry.async('blob')
        animation_files.push(new File([blob], this.base_name(zip_entry.name)))
      }
    }

    return animation_files
  }

  private async collect_animation_files_from_directory (directory_handle: FileSystemDirectoryHandleLike): Promise<File[]> {
    const animation_files: File[] = []

    for await (const entry of directory_handle.values()) {
      if (entry.kind === 'directory') {
        animation_files.push(...await this.collect_animation_files_from_directory(entry))
        continue
      }

      if (entry.kind !== 'file') {
        continue
      }

      const file = await entry.getFile()
      if (this.is_supported_animation_file(file.name.toLowerCase())) {
        animation_files.push(file)
      }
    }

    return animation_files
  }

  private async select_directory_with_input (): Promise<{ files: File[], pack_name: string } | null> {
    return await new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = '.fbx,.glb,.gltf'
      input.style.display = 'none'
      input.setAttribute('webkitdirectory', '')

      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? [])
          .filter(file => this.is_supported_animation_file(file.name.toLowerCase()))
        input.remove()
        resolve({
          files,
          pack_name: this.default_directory_pack_name(files)
        })
      }, { once: true })

      document.body.appendChild(input)
      input.click()
    })
  }

  private default_directory_pack_name (files: File[]): string {
    const first_file = files[0] as (File & { webkitRelativePath?: string }) | undefined
    const relative_path = first_file?.webkitRelativePath
    if (relative_path !== undefined && relative_path.trim() !== '') {
      return relative_path.split(/[\\/]/)[0] ?? 'Imported Animation Pack'
    }

    return 'Imported Animation Pack'
  }

  private process_mesh2motion_source (
    source: LoadedAnimationSource,
    context: AnimationPackImportContext,
    prefer_file_name: boolean
  ): AnimationClip[] {
    const clips = AnimationUtility.deep_clone_animation_clips(source.animations)
    if (prefer_file_name) {
      clips.forEach((clip, index) => {
        clip.name = this.converted_clip_name(clip, source.file_name, index, true)
      })
    }
    AnimationUtility.clean_track_data(clips, context.skeleton_type)
    this.validate_animation_tracks_match_target(clips, context.skinned_meshes_to_animate, source.file_name)
    return clips
  }

  private retarget_mixamo_source (
    source: LoadedAnimationSource,
    context: AnimationPackImportContext,
    prefer_file_name: boolean
  ): AnimationClip[] {
    return source.animations.map((source_clip, index) => {
      const source_skeleton = this.create_skeleton_from_object(source.root)
      if (source_skeleton === null) {
        throw new Error(`${source.file_name} has Mixamo animation tracks but no readable skeleton.`)
      }

      const target_skeleton = RetargetUtils.clone_skeleton(context.skinned_meshes_to_animate[0].skeleton)
      const source_rig = new Rig(source_skeleton).fromConfig(this.build_actual_mixamo_config(source_skeleton.bones))
      const target_rig = new Rig(target_skeleton).fromConfig(HumanChainConfig.mesh2motion_config)
      const retargeter = new Retargeter(source_rig, target_rig, source_clip)

      retargeter.update(0.001)

      return new AnimationClip(
        this.converted_clip_name(source_clip, source.file_name, index, prefer_file_name),
        source_clip.duration,
        retargeter.bake_animation_to_tracks(30, ['pelvis'])
      )
    })
  }

  private validate_animation_tracks_match_target (
    clips: AnimationClip[],
    skinned_meshes: SkinnedMesh[],
    file_name: string
  ): void {
    const target_bone_names = this.target_bone_names(skinned_meshes)
    const animation_bone_names = CustomAnimationValidation.get_animation_bone_names(clips)

    if (animation_bone_names.size === 0) {
      throw new Error(`${file_name} does not contain recognizable bone animation tracks.`)
    }

    const missing_bones = Array.from(animation_bone_names).filter(bone => !target_bone_names.has(bone))
    if (missing_bones.length > 0) {
      throw new Error(`${file_name} has bones that do not exist on the current Mesh2Motion skeleton: ${missing_bones.join(', ')}`)
    }
  }

  private detect_animation_source (
    source: LoadedAnimationSource,
    skinned_meshes: SkinnedMesh[]
  ): DetectedAnimationSource {
    const source_bone_names = this.collect_bone_names(source.root)
    const animation_bone_names = Array.from(CustomAnimationValidation.get_animation_bone_names(source.animations))

    if ([...source_bone_names, ...animation_bone_names].some(name => this.is_mixamo_bone_name(name))) {
      return 'mixamo'
    }

    const target_bone_names = this.target_bone_names(skinned_meshes)
    if (animation_bone_names.length > 0 && animation_bone_names.every(name => target_bone_names.has(name))) {
      return 'mesh2motion'
    }

    return 'unknown'
  }

  private create_skeleton_from_object (root: Object3D | null): Skeleton | null {
    if (root === null) {
      return null
    }

    const cloned_root = root.clone(true)
    const bones = RetargetUtils.collect_bones(cloned_root) as Bone[]
    if (bones.length === 0) {
      return null
    }

    const skeleton = new Skeleton(bones)
    skeleton.calculateInverses()
    skeleton.pose()
    return skeleton
  }

  private build_actual_mixamo_config (bones: Bone[]): Record<string, string[]> {
    const actual_bone_names_by_normalized_name = new Map<string, string>()
    bones.forEach((bone) => {
      actual_bone_names_by_normalized_name.set(this.normalize_mixamo_bone_name(bone.name), bone.name)
    })

    const config: Record<string, string[]> = {}
    for (const [chain_name, canonical_bone_names] of Object.entries(HumanChainConfig.mixamo_config)) {
      config[chain_name] = canonical_bone_names.map((canonical_bone_name) =>
        actual_bone_names_by_normalized_name.get(this.normalize_mixamo_bone_name(canonical_bone_name)) ?? ''
      )
    }

    if ((config.pelvis ?? []).every(name => name === '')) {
      throw new Error('The Mixamo skeleton is missing a readable hips bone.')
    }

    return config
  }

  private detect_root_motion_mode (clips: AnimationClip[]): AnimationRootMotionMode {
    const root_motion_flags = clips.map(clip => this.clip_has_root_motion(clip))
    const has_root_motion = root_motion_flags.some(Boolean)
    const has_in_place = root_motion_flags.some(value => !value)

    if (has_root_motion && has_in_place) {
      return 'mixed'
    }

    return has_root_motion ? 'root-motion' : 'in-place'
  }

  private clip_has_root_motion (clip: AnimationClip): boolean {
    return clip.tracks.some((track: KeyframeTrack) => {
      const track_name = track.name.toLowerCase()
      if (!track_name.includes('.position') ||
        (!track_name.includes('pelvis') && !track_name.includes('hips') && !track_name.includes('root'))) {
        return false
      }

      const values = track.values
      if (values.length < 6) {
        return false
      }

      const first_x = values[0]
      const first_z = values[2]
      const last_x = values[values.length - 3]
      const last_z = values[values.length - 1]
      return Math.abs(last_x - first_x) > 0.001 || Math.abs(last_z - first_z) > 0.001
    })
  }

  private target_bone_names (skinned_meshes: SkinnedMesh[]): Set<string> {
    const names = new Set<string>()
    skinned_meshes.forEach((skinned_mesh) => {
      skinned_mesh.skeleton.bones.forEach((bone) => {
        names.add(bone.name.toLowerCase())
      })
    })
    return names
  }

  private collect_bone_names (root: Object3D | null): string[] {
    const names: string[] = []
    root?.traverse((child) => {
      if (child.type === 'Bone') {
        names.push(child.name)
      }
    })
    return names
  }

  private create_pack_record (
    pack_name: string,
    skeleton_type: SkeletonType,
    source: AnimationPackSource,
    root_motion_mode: AnimationRootMotionMode,
    file_names: string[],
    clip_count: number,
    glb_data: ArrayBuffer
  ): StoredAnimationPackRecord {
    const now = Date.now()
    return {
      id: this.create_id(),
      name: pack_name,
      skeleton_type,
      source,
      tags: ['pack', source, root_motion_mode],
      root_motion_mode,
      created_at: now,
      updated_at: now,
      imported_at: now,
      file_names,
      clip_count,
      byte_size: glb_data.byteLength,
      glb_data: glb_data.slice(0)
    }
  }

  private pack_source_from_set (source_types: Set<AnimationPackSource>): AnimationPackSource {
    if (source_types.size === 1) {
      return Array.from(source_types)[0]
    }

    return 'mixed'
  }

  private converted_clip_name (
    clip: AnimationClip,
    file_name: string,
    index: number,
    prefer_file_name: boolean
  ): string {
    const fallback_name = this.base_name(file_name).replace(/\.(fbx|glb|gltf)$/i, '')
    const source_name = prefer_file_name || clip.name.trim() === ''
      ? fallback_name
      : clip.name.trim()
    const indexed_name = index > 0 ? `${source_name} ${index + 1}` : source_name

    return this.with_default_motion_suffix(indexed_name)
  }

  private ensure_unique_clip_names (clips: AnimationClip[]): void {
    const used_name_counts = new Map<string, number>()

    clips.forEach((clip) => {
      const used_count = used_name_counts.get(clip.name) ?? 0
      used_name_counts.set(clip.name, used_count + 1)

      if (used_count > 0) {
        clip.name = this.append_duplicate_count_to_clip_name(clip.name, used_count + 1)
      }
    })
  }

  private append_duplicate_count_to_clip_name (clip_name: string, count: number): string {
    const motion_suffix_match = clip_name.match(/^(.*?)(\sR[TM])$/i)
    if (motion_suffix_match !== null) {
      return `${motion_suffix_match[1]} ${count}${motion_suffix_match[2]}`
    }

    return `${clip_name} ${count}`
  }

  private with_default_motion_suffix (clip_name: string): string {
    if (/\sR[TM]$/i.test(clip_name.trim())) {
      return clip_name.trim()
    }

    return `${clip_name.trim()} RT`
  }

  private readable_import_error (error: unknown): string {
    const error_message = error instanceof Error ? error.message : String(error)
    const cleaned_error_message = error_message
      .replace(/^LoadError:\s*/i, '')
      .replace(/^Error:\s*/i, '')

    if (cleaned_error_message.includes('THREE.FBXLoader: Unknown property type')) {
      return `${cleaned_error_message}. This usually means the FBX uses an encoding variant Three.js cannot parse; re-export it as FBX 7.4 Binary or GLB.`
    }

    return cleaned_error_message
  }

  private escape_html (input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  private default_pack_name (files: File[]): string {
    if (files.length === 1) {
      return this.base_name(files[0].name).replace(/\.(fbx|glb|gltf|zip)$/i, '')
    }

    return 'Imported Animation Pack'
  }

  private is_supported_animation_file (file_name: string): boolean {
    return file_name.endsWith('.fbx') || file_name.endsWith('.glb') || file_name.endsWith('.gltf')
  }

  private base_name (file_name: string): string {
    return file_name.split(/[\\/]/).pop() ?? file_name
  }

  private is_mixamo_bone_name (bone_name: string): boolean {
    return bone_name.toLowerCase().includes('mixamorig')
  }

  private normalize_mixamo_bone_name (bone_name: string): string {
    const lower_name = bone_name.trim().toLowerCase()
    const mixamo_prefix_index = lower_name.indexOf('mixamorig')
    const mixamo_name = mixamo_prefix_index >= 0
      ? lower_name.slice(mixamo_prefix_index)
      : lower_name

    return mixamo_name
      .replace(/^mixamorig[\d\s:_.|-]*/g, '')
      .replace(/[\s:_.|-]/g, '')
  }

  private create_id (): string {
    if ('crypto' in window && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID()
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}
