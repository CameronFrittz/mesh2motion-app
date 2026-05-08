import {
  AmbientLight,
  type AnimationClip,
  AnimationMixer,
  Box3,
  DirectionalLight,
  Group,
  Object3D,
  PerspectiveCamera,
  Scene,
  type SkinnedMesh,
  Vector3,
  WebGLRenderer
} from 'three'
import { clone as clone_with_skeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'

const PREVIEW_WIDTH = 100
const PREVIEW_HEIGHT = 120
const PREVIEW_FRAME_COUNT = 6
const PREVIEW_FRAME_INTERVAL_MS = 140
const PREVIEW_IMAGE_TYPE = 'image/webp'
const PREVIEW_IMAGE_QUALITY = 0.72

/**
 * Generates lightweight animated preview frame strips using the current character mesh.
 * A single shared renderer keeps the animation list from exhausting WebGL contexts.
 */
export class ImportedAnimationPreviewFactory {
  private readonly active_preview_disposers: Set<() => void> = new Set()
  private readonly frame_cache: Map<string, string[]> = new Map()
  private readonly pending_frame_jobs: Map<string, Promise<string[] | null>> = new Map()
  private preview_generation_queue: Promise<void> = Promise.resolve()
  private renderer: WebGLRenderer | null = null
  private cache_version: number = 0

  constructor (
    private readonly get_skinned_meshes: () => SkinnedMesh[],
    private readonly get_preview_root: (() => Object3D | null) | null = null
  ) {}

  public clear_cache (): void {
    for (const dispose_preview of Array.from(this.active_preview_disposers)) {
      dispose_preview()
    }
    this.active_preview_disposers.clear()
    this.frame_cache.clear()
    this.pending_frame_jobs.clear()
    this.cache_version += 1
  }

  public create_preview_element (animation_clip: AnimationClip): HTMLElement | null {
    const skinned_meshes = this.visible_skinned_meshes()
    if (skinned_meshes.length === 0) {
      return null
    }

    return this.create_frame_strip_preview(animation_clip, skinned_meshes)
  }

  private visible_skinned_meshes (): SkinnedMesh[] {
    const skinned_meshes = this.get_skinned_meshes()
    const visible_meshes = skinned_meshes.filter(mesh => mesh.visible)
    return visible_meshes.length > 0 ? visible_meshes : skinned_meshes
  }

  private create_frame_strip_preview (animation_clip: AnimationClip, skinned_meshes: SkinnedMesh[]): HTMLElement | null {
    if (this.shared_renderer() === null) {
      return null
    }

    const preview_image = document.createElement('img') as HTMLImageElement & { disposePreview?: () => void }
    preview_image.className = 'anim-preview anim-imported-preview'
    preview_image.width = PREVIEW_WIDTH
    preview_image.height = PREVIEW_HEIGHT
    preview_image.alt = `${animation_clip.name} preview`
    preview_image.decoding = 'async'

    const cache_key = this.preview_cache_key(animation_clip, skinned_meshes)
    const cached_frames = this.frame_cache.get(cache_key)
    const cache_version = this.cache_version

    let frame_timer_id: number | null = null
    let disposed = false

    const dispose_preview = (): void => {
      if (disposed) {
        return
      }

      disposed = true
      if (frame_timer_id !== null) {
        window.clearInterval(frame_timer_id)
        frame_timer_id = null
      }
      this.active_preview_disposers.delete(dispose_preview)
    }

    const start_frame_animation = (frames: string[]): void => {
      if (disposed || frames.length === 0) {
        return
      }

      let current_frame_index = 0
      preview_image.src = frames[current_frame_index]

      if (frames.length <= 1) {
        return
      }

      frame_timer_id = window.setInterval(() => {
        if (disposed) {
          return
        }

        if (!preview_image.isConnected) {
          dispose_preview()
          return
        }

        current_frame_index = (current_frame_index + 1) % frames.length
        preview_image.src = frames[current_frame_index]
      }, PREVIEW_FRAME_INTERVAL_MS)
    }

    preview_image.disposePreview = dispose_preview
    this.active_preview_disposers.add(dispose_preview)

    if (cached_frames !== undefined) {
      start_frame_animation(cached_frames)
      return preview_image
    }

    this.enqueue_frame_generation(cache_key, animation_clip, skinned_meshes, cache_version)
      .then((frames) => {
        if (
          disposed ||
          frames === null ||
          cache_version !== this.cache_version ||
          !preview_image.isConnected
        ) {
          return
        }

        start_frame_animation(frames)
      })
      .catch((error) => {
        if (!disposed) {
          console.warn(`Failed to generate animation preview for "${animation_clip.name}":`, error)
        }
      })

    return preview_image
  }

  private preview_cache_key (animation_clip: AnimationClip, skinned_meshes: SkinnedMesh[]): string {
    const root_uuid = this.get_preview_root?.()?.uuid ?? 'mesh-root'
    const mesh_signature = skinned_meshes.map(mesh => mesh.uuid).join('|')
    return [
      this.cache_version,
      root_uuid,
      mesh_signature,
      animation_clip.uuid,
      animation_clip.name,
      animation_clip.duration,
      animation_clip.tracks.length
    ].join(':')
  }

  private enqueue_frame_generation (
    cache_key: string,
    animation_clip: AnimationClip,
    skinned_meshes: SkinnedMesh[],
    cache_version: number
  ): Promise<string[] | null> {
    const pending_job = this.pending_frame_jobs.get(cache_key)
    if (pending_job !== undefined) {
      return pending_job
    }

    const job = this.preview_generation_queue
      .catch(() => undefined)
      .then(async () => {
        if (cache_version !== this.cache_version) {
          return null
        }

        await this.wait_for_browser_frame()

        const frames = await this.generate_preview_frames(animation_clip, skinned_meshes, cache_version)
        if (frames !== null && cache_version === this.cache_version) {
          this.frame_cache.set(cache_key, frames)
        }
        return frames
      })
      .finally(() => {
        this.pending_frame_jobs.delete(cache_key)
      })

    this.pending_frame_jobs.set(cache_key, job)
    this.preview_generation_queue = job.then(() => undefined, () => undefined)

    return job
  }

  private async generate_preview_frames (
    animation_clip: AnimationClip,
    skinned_meshes: SkinnedMesh[],
    cache_version: number
  ): Promise<string[] | null> {
    const renderer = this.shared_renderer()
    if (renderer === null) {
      return null
    }

    const preview_root = this.clone_preview_root(skinned_meshes)
    if (preview_root.children.length === 0) {
      return null
    }

    const scene = this.create_scene(preview_root)
    const mixer = new AnimationMixer(preview_root)

    for (const preview_mesh of preview_root.children) {
      const action = mixer.clipAction(animation_clip, preview_mesh)
      action.reset()
      action.play()
    }

    mixer.setTime(0)
    preview_root.updateMatrixWorld(true)
    this.center_preview_root(preview_root)

    const camera = this.create_camera(preview_root)
    const frames: string[] = []

    try {
      for (let frame_index = 0; frame_index < PREVIEW_FRAME_COUNT; frame_index += 1) {
        if (cache_version !== this.cache_version) {
          return null
        }

        const frame_time = this.animation_frame_time(animation_clip, frame_index)
        mixer.setTime(frame_time)
        preview_root.updateMatrixWorld(true)
        renderer.clear()
        renderer.render(scene, camera)
        frames.push(renderer.domElement.toDataURL(PREVIEW_IMAGE_TYPE, PREVIEW_IMAGE_QUALITY))

        if (frame_index < PREVIEW_FRAME_COUNT - 1) {
          await this.wait_for_browser_frame()
        }
      }
    } catch (error) {
      console.warn(`Failed to render animation preview frames for "${animation_clip.name}":`, error)
      return null
    } finally {
      scene.clear()
    }

    return frames
  }

  private shared_renderer (): WebGLRenderer | null {
    if (this.renderer !== null) {
      return this.renderer
    }

    try {
      const renderer = new WebGLRenderer({
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true
      })
      renderer.setClearColor(0x000000, 0)
      renderer.setPixelRatio(1)
      renderer.setSize(PREVIEW_WIDTH, PREVIEW_HEIGHT, false)
      this.renderer = renderer
      return renderer
    } catch (error) {
      console.warn('Imported animation previews are unavailable in this browser:', error)
      return null
    }
  }

  private animation_frame_time (animation_clip: AnimationClip, frame_index: number): number {
    if (animation_clip.duration <= 0) {
      return 0
    }

    return (animation_clip.duration * frame_index) / PREVIEW_FRAME_COUNT
  }

  private async wait_for_browser_frame (): Promise<void> {
    await new Promise<void>(resolve => {
      window.requestAnimationFrame(() => {
        resolve()
      })
    })
  }

  private clone_preview_root (skinned_meshes: SkinnedMesh[]): Group {
    const preview_root = new Group()
    const source_preview_root = this.get_preview_root?.() ?? null
    if (source_preview_root !== null && source_preview_root.children.length > 0) {
      try {
        const cloned_root = clone_with_skeleton(source_preview_root)
        this.reset_cloned_skinned_meshes(cloned_root)
        preview_root.add(cloned_root)
        return preview_root
      } catch (error) {
        console.warn('Failed to clone imported animation preview root. Falling back to mesh clones:', error)
      }
    }

    for (const source_mesh of skinned_meshes) {
      try {
        const preview_mesh = clone_with_skeleton(source_mesh)
        preview_mesh.name = source_mesh.name
        this.reset_cloned_skinned_meshes(preview_mesh)
        preview_root.add(preview_mesh)
      } catch (error) {
        console.warn(`Failed to clone imported animation preview mesh "${source_mesh.name}":`, error)
      }
    }
    return preview_root
  }

  private reset_cloned_skinned_meshes (root: Object3D): void {
    root.traverse((child) => {
      const possible_skinned_mesh = child as SkinnedMesh
      if (possible_skinned_mesh.isSkinnedMesh === true) {
        possible_skinned_mesh.skeleton.pose()
      }
    })
  }

  private create_scene (preview_root: Group): Scene {
    const scene = new Scene()
    scene.add(new AmbientLight(0xffffff, 2.2))

    const key_light = new DirectionalLight(0xffffff, 2.4)
    key_light.position.set(2, 4, 4)
    scene.add(key_light)

    const fill_light = new DirectionalLight(0xffffff, 0.9)
    fill_light.position.set(-3, 2, 3)
    scene.add(fill_light)

    scene.add(preview_root)
    return scene
  }

  private center_preview_root (preview_root: Group): void {
    const box = new Box3().setFromObject(preview_root)
    if (box.isEmpty()) {
      return
    }

    const center = box.getCenter(new Vector3())
    preview_root.position.sub(center)
    preview_root.updateMatrixWorld(true)
  }

  private create_camera (preview_root: Group): PerspectiveCamera {
    const centered_box = new Box3().setFromObject(preview_root)
    const size = centered_box.getSize(new Vector3())
    const max_dimension = Math.max(size.x, size.y, size.z, 1)

    const camera = new PerspectiveCamera(32, PREVIEW_WIDTH / PREVIEW_HEIGHT, 0.01, 1000)
    camera.position.set(0, max_dimension * 0.12, max_dimension * 2.35)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()

    return camera
  }
}
