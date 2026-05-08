import { type AnimationClip } from 'three'

export type AnimationSourceType = 'default-library' | 'custom-import' | 'stored-pack'
export type AnimationRootMotionMode = 'unknown' | 'in-place' | 'root-motion' | 'mixed'

export interface AnimationClipMetadata {
  source_type: AnimationSourceType
  tags: string[]
  pack_name?: string
  pack_id?: string
  original_clip_name?: string
  imported_at?: number
  source_format?: string
  source_files?: string[]
  root_motion?: AnimationRootMotionMode
}

export interface TransformedAnimationClipPair {
  /**
   * The original version of the animation clip, without any transformations
   * applied to it.
   *
   * This allows for simple non-destructive modification of the animation,
   * since we can always reset to the original.
   */
  original_animation_clip: AnimationClip
  /**
   * The warped version of the animation clip, which is what will be displayed
   * and downloaded by the user.
   */
  display_animation_clip: AnimationClip

  /**
   * Extendable metadata for this animation clip.
   */
  metadata: AnimationClipMetadata
}
