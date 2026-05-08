import { type ThemeManager } from '../../ThemeManager'
import { SkeletonType } from '../../enums/SkeletonType'
import { RigConfig } from '../../RigConfig'
import { type AnimationWithState } from './interfaces/AnimationWithState'
import { type TransformedAnimationClipPair } from './interfaces/TransformedAnimationClipPair'

type AnimationPreviewFactory = (animation: AnimationWithState) => HTMLElement | null
type DisposablePreviewElement = HTMLElement & { disposePreview?: () => void }

export class AnimationSearch extends EventTarget {
  private all_animations: AnimationWithState[] = []
  private readonly filter_input: HTMLInputElement | null = null
  private readonly animation_list_container: HTMLElement | null = null
  private filtered_animations_list: AnimationWithState[] = []

  private readonly theme_manager: ThemeManager
  private readonly skeleton_type: SkeletonType

  private custom_event: CustomEvent | null = null
  private preview_observer: IntersectionObserver | null = null
  private readonly generated_preview_load_queue: HTMLElement[] = []
  private generated_preview_queue_version: number = 0
  private is_processing_generated_preview_queue: boolean = false

  constructor (
    filter_input_id: string,
    animation_list_container_id: string,
    theme_manager: ThemeManager,
    skeleton_type: SkeletonType,
    private readonly animation_preview_factory: AnimationPreviewFactory | null = null
  ) {
    super()
    this.filter_input = document.querySelector(`#${filter_input_id}`)
    this.animation_list_container = document.querySelector(`#${animation_list_container_id}`)
    this.theme_manager = theme_manager
    this.skeleton_type = skeleton_type
    this.setup_event_listeners()
  }

  public initialize_animations (animations: TransformedAnimationClipPair[]): void {
    // Convert to animations with state tracking
    this.all_animations = this.map_animations_to_state(animations)

    this.render_filtered_animations('')
  }

  public add_animations (animations: TransformedAnimationClipPair[]): void {
    const new_animations = this.map_animations_to_state(animations)

    this.all_animations.push(...new_animations)
    const filter_text = this.filter_input?.value.toLowerCase() ?? ''
    this.render_filtered_animations(filter_text)
  }

  public rerender_current_filter (): void {
    this.render_filtered_animations(this.filter_input?.value.toLowerCase() ?? '')
  }

  /**
   * Convert the animation listing data to a format
   * that works for what the UI needs
   * @param animations The list of animations to convert to a format with state for the UI
   * @returns A list of animations with state for the UI to track which animations are selected for export and filtering
   */
  private map_animations_to_state (animations: TransformedAnimationClipPair[]): AnimationWithState[] {
    return animations.map((pair) => {
      const animation_with_state = pair.display_animation_clip as unknown as AnimationWithState
      animation_with_state.isChecked = false
      animation_with_state.metadata = pair.metadata // enhanced searching/display with custom animations
      return animation_with_state
    })
  }

  private setup_event_listeners (): void {
    this.setup_filter_listener()
    this.setup_checkbox_listeners()
    this.setup_theme_change_listener()
  }

  private setup_theme_change_listener (): void {
    // rebuild animation previews so we have the correct theme
    this.theme_manager.addEventListener('theme-changed', (new_theme) => {
      this.render_filtered_animations(this.filter_input?.value ?? '')
    })
  }

  private setup_filter_listener (): void {
    if (this.filter_input === null) {
      return
    }

    // Add the filter event listener
    this.filter_input.addEventListener('input', (event) => {
      const filter_text = (event.target as HTMLInputElement).value.toLowerCase()
      this.render_filtered_animations(filter_text)

      // emit an event to notify that we have filtered our animation listing
      this.custom_event = new CustomEvent('filtered-animations-listing', { detail: { selectedAnimations: this.get_selected_animation_indices() } })
      this.dispatchEvent(this.custom_event)
    })
  }

  private setup_checkbox_listeners (): void {
    if (this.animation_list_container === null) {
      return
    }

    // Add event listener to the container for checkbox changes (event delegation)
    this.animation_list_container.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement
      if (target?.type === 'checkbox') {
        this.save_current_checkbox_states()
      }

      // emit an event to notify other parts of the application that export options have changed
      this.custom_event = new CustomEvent('export-options-changed', { detail: { selectedAnimations: this.get_selected_animation_indices() } })
      this.dispatchEvent(this.custom_event)
    })
  }

  private save_current_checkbox_states (): void {
    if (this.animation_list_container === null) {
      return
    }

    const checkboxes = this.animation_list_container.querySelectorAll('input[type="checkbox"]')
    checkboxes.forEach((checkbox) => {
      const input = checkbox as HTMLInputElement
      const animation_index = parseInt(input.value)

      if (!isNaN(animation_index) && animation_index < this.all_animations.length) {
        this.all_animations[animation_index].isChecked = input.checked
      }
    })
  }

  /* animations that are shown on UI after filtering */
  public filtered_animations (): AnimationWithState[] {
    return this.filtered_animations_list
  }

  private render_filtered_animations (filter_text: string): void {
    if (this.animation_list_container === null) {
      return
    }

    // Filter animations based on search text
    this.filtered_animations_list = this.all_animations.filter(animation => {
      const metadata = animation.metadata
      const searchable_text = [
        animation.name,
        metadata?.pack_name ?? '',
        metadata?.source_format ?? '',
        metadata?.root_motion ?? '',
        ...(metadata?.tags ?? [])
      ].join(' ').toLowerCase()

      return searchable_text.includes(filter_text)
    })

    // Clear and rebuild the animation list
    this.preview_observer?.disconnect()
    this.preview_observer = null
    this.generated_preview_load_queue.length = 0
    this.generated_preview_queue_version += 1
    this.dispose_loaded_preview_elements()
    this.animation_list_container.innerHTML = ''

    // Show "no animations found" if the filtered list is empty
    if (this.filtered_animations_list.length === 0) {
      this.animation_list_container.innerHTML = '<div class="no-animations-message">No animations found</div>'
      return
    }

    this.filtered_animations_list.forEach((animation_clip) => {
      if (this.animation_list_container == null) {
        return
      }

      // Find the original index in the full list for proper data-index
      const original_index = this.all_animations.findIndex(clip => clip === animation_clip)

      // Check if this animation was previously checked
      const was_checked: boolean = animation_clip.isChecked ?? false
      const checked_attribute = was_checked ? 'checked' : ''

      // build out where the video previews will be stored
      // each skeleton type has its own folder
      const preview_folder: string = RigConfig.by_skeleton_type(this.skeleton_type)?.animation_preview_folder ?? 'error'
      if (preview_folder === 'error') {
        console.error('Unknown skeleton type for animation previews. Add the rig to RigConfig.ts.')
      }

      const anim_name: string = animation_clip.name
      const theme_name: string = this.theme_manager.get_current_theme()
      const source_type = animation_clip.metadata?.source_type ?? 'default-library'
      const is_imported_animation = source_type !== 'default-library'
      const should_generate_model_preview = this.animation_preview_factory !== null

      const preview_data_src_attribute = !is_imported_animation
        ? ` data-src="../animpreviews/${preview_folder}/${theme_name}_${anim_name}.webm"`
        : ''
      const preview_data_generated_index_attribute = should_generate_model_preview
        ? ` data-generated-preview-index="${original_index}"`
        : ''
      const preview_data_imported_index_attribute = is_imported_animation
        ? ` data-imported-index="${original_index}"`
        : ''

      let custom_animation_badge_html = ''
      if (source_type === 'custom-import') {
        custom_animation_badge_html = '<span class="anim-custom-badge" title="Custom animation" aria-label="Custom animation">C</span>'
      } else if (source_type === 'stored-pack') {
        custom_animation_badge_html = '<span class="anim-custom-badge" title="Animation pack" aria-label="Animation pack">P</span>'
      }

      const rename_button_html = is_imported_animation
        ? `<button type="button" class="secondary-button anim-rename-button" data-index="${original_index}" title="Rename animation" aria-label="Rename animation">
            <span class="material-symbols-outlined">edit</span>
          </button>`
        : ''

      const delete_button_html = is_imported_animation
        ? `<button type="button" class="secondary-button anim-delete-button" data-index="${original_index}" title="Delete animation" aria-label="Delete animation">
            <span class="material-symbols-outlined">delete</span>
          </button>`
        : ''

      const animation_entry_html = `
        <div class="${is_imported_animation ? 'anim-custom-item' : 'anim-item'}">
          ${rename_button_html}
          ${delete_button_html}
          <button class="secondary-button play" data-index="${original_index}" style="display: flex; flex-direction:column; position: relative;">
            ${custom_animation_badge_html}
            <div class="anim-preview-placeholder"${preview_data_src_attribute}${preview_data_generated_index_attribute}${preview_data_imported_index_attribute} style="pointer-events: none;"></div>
            <label class="styled-checkbox">
              <input type="checkbox" name="${this.escape_attribute(animation_clip.name)}" value="${original_index}" ${checked_attribute}>
              <span class="anim-preview-label">${this.escape_html(this.animation_name_clean(animation_clip.name))}</span>
            </label>
          </button>
        </div>`

      // append the entire item HTML to the DOM element
      this.animation_list_container.innerHTML += animation_entry_html
    })

    // only so many WebM videos can be playing at the same time
    // so this is an optimization to convert only elements in the active scroll area to video elements
    this.setup_lazy_video_loading()
  }

  /**
   * Sets up lazy loading for video previews using Intersection Observer.
   * Only loads video elements when their placeholders are visible in the viewport.
   */
  private setup_lazy_video_loading (): void {
    // Only set up IntersectionObserver if the container exists
    // any animation entry that is in view will run this code to convert it to a video element
    this.preview_observer?.disconnect()

    const observer = new IntersectionObserver((entries: IntersectionObserverEntry[], _obs: IntersectionObserver) => {
      entries.forEach(entry => {
        const placeholder = entry.target as HTMLElement

        if (!entry.isIntersecting) {
          placeholder.removeAttribute('data-preview-visible')
          placeholder.removeAttribute('data-preview-queued')
          if (this.has_generated_preview(placeholder)) {
            this.unload_generated_animation_preview(placeholder)
          }
          return
        }

        const generated_animation_index = this.generated_preview_index(placeholder)
        if (generated_animation_index !== null) {
          placeholder.setAttribute('data-preview-visible', 'true')
          this.queue_generated_animation_preview(placeholder)
          return
        }

        // if element is already a video, and it is in view, don't convert
        // it to a video again, it is ok so abort any further work
        const existing_video = placeholder.querySelector('video')
        if (existing_video != null) {
          return
        }

        this.load_static_video_preview(placeholder)
      })
    }, { rootMargin: this.animation_preview_factory !== null ? '24px' : '120px' }) // model previews are generated on demand and should stay close to the viewport

    // grabs all the animation list elements and tells the observer to start watching them for processing
    const placeholders = this.animation_list_container?.querySelectorAll('.anim-preview-placeholder')
    placeholders?.forEach(ph => { observer.observe(ph) })
    this.preview_observer = observer
  }

  private dispose_loaded_preview_elements (): void {
    if (this.animation_list_container === null) {
      return
    }

    const preview_elements = this.animation_list_container.querySelectorAll<DisposablePreviewElement>('.anim-preview-placeholder > *')
    preview_elements.forEach((preview_element) => {
      preview_element.disposePreview?.()
    })
  }

  private queue_generated_animation_preview (placeholder: HTMLElement): void {
    if (
      placeholder.getAttribute('data-preview-loaded') === 'true' ||
      placeholder.getAttribute('data-preview-queued') === 'true'
    ) {
      return
    }

    placeholder.setAttribute('data-preview-queued', 'true')
    this.generated_preview_load_queue.push(placeholder)
    void this.process_generated_preview_load_queue()
  }

  private async process_generated_preview_load_queue (): Promise<void> {
    if (this.is_processing_generated_preview_queue) {
      return
    }

    const queue_version = this.generated_preview_queue_version
    this.is_processing_generated_preview_queue = true

    try {
      while (
        this.generated_preview_load_queue.length > 0 &&
        queue_version === this.generated_preview_queue_version
      ) {
        const placeholder = this.generated_preview_load_queue.shift()
        if (placeholder === undefined) {
          continue
        }

        placeholder.removeAttribute('data-preview-queued')
        if (
          !placeholder.isConnected ||
          placeholder.getAttribute('data-preview-visible') !== 'true'
        ) {
          continue
        }

        const generated_animation_index = this.generated_preview_index(placeholder)
        if (generated_animation_index !== null) {
          this.load_generated_animation_preview(placeholder, generated_animation_index)
        }

        await this.wait_for_animation_frame()
      }
    } finally {
      this.is_processing_generated_preview_queue = false
      if (this.generated_preview_load_queue.length > 0) {
        void this.process_generated_preview_load_queue()
      }
    }
  }

  private async wait_for_animation_frame (): Promise<void> {
    await new Promise<void>(resolve => {
      window.requestAnimationFrame(() => {
        resolve()
      })
    })
  }

  private has_generated_preview (placeholder: HTMLElement): boolean {
    return this.generated_preview_index(placeholder) !== null
  }

  private generated_preview_index (placeholder: HTMLElement): string | null {
    return placeholder.getAttribute('data-generated-preview-index') ?? placeholder.getAttribute('data-imported-index')
  }

  private load_generated_animation_preview (placeholder: HTMLElement, animation_index_string: string): void {
    if (placeholder.getAttribute('data-preview-loaded') === 'true') {
      return
    }

    const animation_index = Number(animation_index_string)
    if (!Number.isInteger(animation_index) || animation_index < 0 || animation_index >= this.all_animations.length) {
      return
    }

    const animation = this.all_animations[animation_index]
    const preview_element = this.animation_preview_factory?.(animation)
    if (preview_element === null || preview_element === undefined) {
      if (placeholder.getAttribute('data-src') !== null) {
        this.load_static_video_preview(placeholder)
        return
      }

      placeholder.innerHTML = ''
      placeholder.appendChild(this.create_generated_preview_fallback())
      placeholder.setAttribute('data-preview-loaded', 'true')
      return
    }

    placeholder.innerHTML = ''
    placeholder.appendChild(preview_element)
    placeholder.setAttribute('data-preview-loaded', 'true')
  }

  private unload_generated_animation_preview (placeholder: HTMLElement): void {
    if (placeholder.getAttribute('data-preview-loaded') !== 'true') {
      return
    }

    for (const child of Array.from(placeholder.children)) {
      const preview_element = child as DisposablePreviewElement
      preview_element.disposePreview?.()
    }

    placeholder.innerHTML = ''
    placeholder.removeAttribute('data-preview-loaded')
    placeholder.removeAttribute('data-preview-queued')
    placeholder.removeAttribute('data-preview-visible')
  }

  private load_static_video_preview (placeholder: HTMLElement): void {
    const existing_video = placeholder.querySelector('video')
    if (existing_video != null) {
      return
    }

    const src = placeholder.getAttribute('data-src') ?? ''
    if (src === '') {
      return
    }

    const video = document.createElement('video')
    video.className = 'anim-preview'
    video.src = src
    video.width = 100
    video.height = 120
    video.loop = true
    video.muted = true
    video.playsInline = true // tells mobile browsers to play inline instead of going fullscreen
    video.autoplay = true
    placeholder.innerHTML = ''
    placeholder.appendChild(video)
    placeholder.setAttribute('data-preview-loaded', 'true')
  }

  private create_generated_preview_fallback (): HTMLElement {
    const fallback = document.createElement('div')
    fallback.className = 'anim-preview anim-imported-preview-fallback'
    return fallback
  }

  public animation_name_clean (input: string): string {
    return input.replace(/_/g, ' ')
  }

  private escape_html (input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  private escape_attribute (input: string): string {
    return this.escape_html(input)
  }

  /**
   * Gets the list of filtered animations. Returns all animations if no filtering
   * @returns An array of selected animations.
   */
  public get_selected_animations (): AnimationWithState[] {
    return this.all_animations.filter(animation => animation.isChecked === true)
  }

  /**
   * Gets the list of animations that are checked to be exported
   * @returns An array of selected animation indices.
   */
  public get_selected_animation_indices (): number[] {
    return this.all_animations
      .map((animation, index) => (animation.isChecked === true) ? index : -1)
      .filter(index => index !== -1)
  }

  public clear_filter (): void {
    if (this.filter_input !== null) {
      this.filter_input.value = ''
      this.render_filtered_animations('')
    }
  }
}
