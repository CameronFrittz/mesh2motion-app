import { AnimationPlayer } from '../lib/processes/animations-listing/AnimationPlayer.ts'
import { AnimationSearch } from '../lib/processes/animations-listing/AnimationSearch.ts'
import { AnimationLoader } from '../lib/processes/animations-listing/AnimationLoader.ts'
import { AnimationPackStore, animation_pack_metadata, apply_animation_pack_name_overrides } from '../lib/processes/animations-listing/AnimationPackStore.ts'
import { ImportedAnimationPreviewFactory } from '../lib/processes/animations-listing/ImportedAnimationPreviewFactory.ts'
import { type AnimationClip, AnimationMixer, type SkinnedMesh, Object3D, type AnimationAction } from 'three'
import type { ThemeManager } from '../lib/ThemeManager.ts'
import { type TransformedAnimationClipPair } from '../lib/processes/animations-listing/interfaces/TransformedAnimationClipPair.ts'
import { AnimationRetargetService } from './AnimationRetargetService.ts'
import { StepExportRetargetedAnimations } from './steps/StepExportRetargetedAnimations.ts'
import { UI } from '../lib/UI.ts'

/**
 * RetargetAnimationListing - Handles animation listing and playback specifically for retargeting workflow
 * Reuses AnimationPlayer, AnimationSearch, and AnimationLoader but tailored for retargeting needs
 */
export class RetargetAnimationListing extends EventTarget {
  private readonly theme_manager: ThemeManager
  private readonly animation_player: AnimationPlayer
  private readonly animation_loader: AnimationLoader = new AnimationLoader()
  private readonly animation_pack_store: AnimationPackStore = new AnimationPackStore()
  private readonly imported_animation_preview_factory: ImportedAnimationPreviewFactory = new ImportedAnimationPreviewFactory(
    () => AnimationRetargetService.getInstance().get_target_skinned_meshes(),
    () => AnimationRetargetService.getInstance().get_target_armature()
  )
  private readonly step_export_retargeted_animations: StepExportRetargetedAnimations = new StepExportRetargetedAnimations()
  private animation_clips_loaded: TransformedAnimationClipPair[] = []
  private animation_mixer: AnimationMixer = new AnimationMixer(new Object3D())
  private readonly preview_clip_cache: Map<string, AnimationClip> = new Map()
  private readonly ui: UI = UI.getInstance()

  private _added_event_listeners: boolean = false

  public animation_search: AnimationSearch | null = null

  private is_animations_active: boolean = false

  private export_button: HTMLButtonElement | null = null

  constructor (theme_manager: ThemeManager) {
    super()
    this.theme_manager = theme_manager
    this.animation_player = new AnimationPlayer()
  }

  public begin (): void {
    this.reset_step_data()

    if (!this._added_event_listeners) {
      this.add_event_listeners()
      this._added_event_listeners = true
    }

    this.show_bone_toggle_button(true)
  }

  public end (): void {
    this.show_bone_toggle_button(false) // cannot toggle bone display in configuration area
    this.stop_preview() // stop any playing animations in the listing
  }

  private show_bone_toggle_button (show: boolean): void {
    if (this.ui.dom_show_skeleton_container != null) {
      this.ui.dom_show_skeleton_container.style.display = show ? 'inline-flex' : 'none'
    }
  }

  public reset_step_data (): void {
    this.animation_clips_loaded = []
    this.animation_mixer = new AnimationMixer(new Object3D())
    this.preview_clip_cache.clear()
    this.imported_animation_preview_factory.clear_cache()
    this.animation_player.clear_animation()
  }

  public mixer (): AnimationMixer {
    return this.animation_mixer
  }

  public animation_clips (): AnimationClip[] {
    return this.animation_clips_loaded.map(clip => clip.display_animation_clip)
  }

  /**
   * This will be called any time we enter the retarget animation listing step
   */
  public start_preview (): void {
    this.is_animations_active = true
  }

  public stop_preview (): void {
    this.is_animations_active = false

    // Stop all active animations in the mixer
    // this is really important if we go back to the bone mapping
    // this makes sure to stop any running animations in listing
    if (this.animation_mixer !== null) {
      this.animation_mixer.stopAllAction()
    }

    // Clear the animation player UI
    this.animation_player.clear_animation()
  }

  public load_and_apply_default_animation_to_skinned_mesh (): void {
    this.animation_loader.set_animations_file_path('../../animations/')
    this.animation_clips_loaded = []
    this.animation_mixer = new AnimationMixer(new Object3D())

    // this animation loader comes from the Mesh2Motion engine, so still
    // pass in the skeleton type this way
    this.animation_loader.load_animations(AnimationRetargetService.getInstance().get_skeleton_type())
      .then(async (loaded_clips: TransformedAnimationClipPair[]) => {
        const stored_pack_clips = await this.load_stored_animation_packs()
        this.animation_clips_loaded = [...loaded_clips, ...stored_pack_clips]
        this.on_all_animations_loaded()
      })
      .catch((error: Error) => {
        console.error('Failed to load animations for retargeting:', error)
      })
  }

  private async load_stored_animation_packs (): Promise<TransformedAnimationClipPair[]> {
    try {
      const skeleton_type = AnimationRetargetService.getInstance().get_skeleton_type()
      const records = await this.animation_pack_store.list_by_skeleton_type(skeleton_type)
      const loaded_pack_clips: TransformedAnimationClipPair[] = []

      for (const record of records) {
        try {
          const loaded_clips = await this.animation_loader.load_animations_from_array_buffer(
            record.glb_data,
            `${record.name}.glb`,
            1.0,
            animation_pack_metadata(record)
          )
          loaded_pack_clips.push(...apply_animation_pack_name_overrides(record, loaded_clips))
        } catch (error) {
          console.warn(`Failed to load saved animation pack "${record.name}" for retargeting:`, error)
        }
      }

      return loaded_pack_clips
    } catch (error) {
      console.warn('Failed to list saved animation packs for retargeting:', error)
      return []
    }
  }

  /**
   * Enable the export button only if there are animations selected
   */
  private update_export_button_enabled_state (): void {
    // if there are no animations selected disable the download button

    const animations_selected_count: number = this.animation_search?.get_selected_animation_indices().length ?? 0

    if (this.export_button !== null) {
      this.export_button.disabled = animations_selected_count === 0
    }

    // update the count inside the export/download button
    const count_element = document.getElementById('animation-selection-count')
    if (count_element !== null) {
      count_element.textContent = animations_selected_count.toString()
    }
  }

  private on_all_animations_loaded (): void {
    // Sort alphabetically
    this.animation_clips_loaded.sort((a: TransformedAnimationClipPair, b: TransformedAnimationClipPair) => {
      if (a.display_animation_clip.name < b.display_animation_clip.name) return -1
      if (a.display_animation_clip.name > b.display_animation_clip.name) return 1
      return 0
    })

    // Build animation UI
    this.build_animation_clip_ui(this.animation_clips_loaded)

    // Update animation selection count when selections change
    this.animation_search?.addEventListener('export-options-changed', () => {
      this.update_export_button_enabled_state()
    })

    // Update animation listing count display
    const listing_count_element = document.getElementById('animation-listing-count')
    if (listing_count_element !== null) {
      listing_count_element.textContent = this.animation_clips_loaded.length.toString()
    }

    // the export button enabled state relies on the animation search being initialized
    // since we created a new one above, we need to recalculate this method
    this.update_export_button_enabled_state()

    console.log(`Loaded ${this.animation_clips_loaded.length} animations for retargeting`)
  }

  private build_animation_clip_ui (animation_clips: TransformedAnimationClipPair[]): void {
    // Initialize AnimationSearch with the loaded clips
    this.animation_search = new AnimationSearch(
      'animation-filter',
      'animations-items',
      this.theme_manager,
      AnimationRetargetService.getInstance().get_skeleton_type(),
      (animation) => this.imported_animation_preview_factory.create_preview_element(
        this.preview_animation_clip(animation)
      )
    )

    this.animation_search.initialize_animations(animation_clips)

    // Add click event listeners to animation items for playback
    const animations_container = document.getElementById('animations-items')
    if (animations_container !== null) {
      animations_container.addEventListener('click', (event) => {
        const target = event.target as HTMLElement

        const rename_button = target.closest<HTMLButtonElement>('.anim-rename-button')
        if (rename_button !== null) {
          const index = parseInt(rename_button.dataset.index ?? '-1')
          if (index >= 0) {
            void this.rename_animation(index)
          }
          return
        }

        const button = target.closest('.play')

        if (button !== null) {
          const index = parseInt((button as HTMLButtonElement).dataset.index ?? '-1')
          if (index >= 0) {
            this.play_animation(index)
          }
        }
      })
    }
  }

  private async rename_animation (index: number): Promise<void> {
    const animation_pair = this.animation_clips_loaded[index]
    if (animation_pair === undefined) {
      return
    }

    const current_name = animation_pair.display_animation_clip.name
    const new_name = window.prompt('Animation name', current_name)
    if (new_name === null) {
      return
    }

    const trimmed_new_name = new_name.trim()
    if (trimmed_new_name === '' || trimmed_new_name === current_name) {
      return
    }

    // Persist the rename to the saved animation pack so it survives reloads.
    const metadata = animation_pair.metadata
    if (metadata.source_type === 'stored-pack' &&
        metadata.pack_id !== undefined &&
        metadata.original_clip_name !== undefined) {
      try {
        const record = await this.animation_pack_store.get(metadata.pack_id)
        if (record !== null) {
          record.animation_name_overrides = {
            ...(record.animation_name_overrides ?? {}),
            [metadata.original_clip_name]: trimmed_new_name
          }
          record.updated_at = Date.now()
          await this.animation_pack_store.put(record)
        }
      } catch (error) {
        console.warn('Failed to persist animation rename:', error)
      }
    }

    // Stash the original name on first rename so preview lookups (which key off
    // the original GLB clip name) keep resolving.
    if (metadata.original_clip_name === undefined) {
      metadata.original_clip_name = current_name
    }

    animation_pair.original_animation_clip.name = trimmed_new_name
    animation_pair.display_animation_clip.name = trimmed_new_name

    // Invalidate cached retargeted preview clips for this animation.
    this.preview_clip_cache.clear()

    this.animation_search?.rerender_current_filter()
  }

  private preview_animation_clip (animation: AnimationClip): AnimationClip {
    const cache_key = [
      animation.uuid,
      animation.name,
      animation.duration,
      animation.tracks.length
    ].join(':')
    const cached_clip = this.preview_clip_cache.get(cache_key)
    if (cached_clip !== undefined) {
      return cached_clip
    }

    try {
      const retargeted_clip = AnimationRetargetService.getInstance().retarget_animation_clip(animation)
      this.preview_clip_cache.set(cache_key, retargeted_clip)
      return retargeted_clip
    } catch (error) {
      console.warn('Failed to create retargeted animation preview:', error)
      return animation
    }
  }

  private play_animation (index: number): void {
    if (index < 0 || index >= this.animation_clips_loaded.length) {
      console.warn('Invalid animation index:', index)
      return
    }

    const animation_pair = this.animation_clips_loaded[index]
    const display_clip = animation_pair.display_animation_clip

    // Stop all current actions
    this.animation_mixer.stopAllAction()

    // Retarget the animation using the shared service
    const retargeted_clip: AnimationClip = AnimationRetargetService.getInstance().retarget_animation_clip(
      display_clip
    )

    // Create new actions for each skinned mesh with the retargeted animation
    const skinned_meshes_to_animate: SkinnedMesh[] = AnimationRetargetService.getInstance().get_target_skinned_meshes()
    const actions: AnimationAction[] = skinned_meshes_to_animate.map((mesh) => {
      const action = this.animation_mixer.clipAction(retargeted_clip, mesh)
      action.reset()
      action.play()
      return action
    })

    // Update the animation player UI
    this.animation_player.set_animation(retargeted_clip, actions)

    console.log('Playing retargeted animation:', retargeted_clip.name)
  }

  private add_event_listeners (): void {
    // Add any retarget-specific event listeners here
    // For now, keeping it minimal
    this.setup_animation_loop()

    // configure export animations button
    this.export_button = document.getElementById('export-retargeting-button') as HTMLButtonElement
    this.export_button?.addEventListener('click', () => {
      // send in all the selected animation clips for export
      this.step_export_retargeted_animations.set_animation_clips_to_export(
        this.animation_clips_loaded.map(clip => clip.display_animation_clip),
        this.get_selected_animation_indices()
      )

      // configure the export out step with retargeting info
      this.step_export_retargeted_animations.export('retargeted_animations')
    })
  }

  public get_animation_player (): AnimationPlayer {
    return this.animation_player
  }

  public get_selected_animation_indices (): number[] {
    return this.animation_search?.get_selected_animation_indices() ?? []
  }

  private setup_animation_loop (): void {
    let last_time = performance.now()
    const animate = (): void => {
      requestAnimationFrame(animate)

      // calculate delta time and pass it into preview
      const current_time = performance.now()
      const delta_time = (current_time - last_time) / 1000 // Convert to seconds
      last_time = current_time

      if (this.is_animations_active) {
        this.animation_frame_logic(delta_time)
      }
    }
    animate()
  }

  private animation_frame_logic (delta_time: number): void {
    if (this.animation_mixer === null) return

    this.animation_mixer.update(delta_time)
    this.animation_player.update(delta_time)

    // CRITICAL: Update the skeleton and skinned meshes after animation changes the bones
    // const skinned_meshes: SkinnedMesh[] = AnimationRetargetService.getInstance().get_target_skinned_meshes()
    // skinned_meshes.forEach((skinned_mesh) => {
    //   skinned_mesh.skeleton.bones.forEach(bone => {
    //     bone.updateMatrixWorld(true)
    //   })
    // })
  }
}
