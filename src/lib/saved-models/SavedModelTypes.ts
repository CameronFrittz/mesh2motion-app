import { type HandSkeletonType, type SkeletonType } from '../enums/SkeletonType.ts'

export type SavedVector3 = [number, number, number]

export interface SavedBoneTransform {
  name: string
  position: SavedVector3
  rotation: SavedVector3
  scale: SavedVector3
}

export interface SavedUploadedModelSource {
  kind: 'upload'
  file_name: string
  file_extension: string
  model_data: ArrayBuffer
  byte_size: number
}

export interface SavedPathModelSource {
  kind: 'path'
  file_name: string
  file_extension: string
  model_path: string
}

export type SavedModelSource = SavedUploadedModelSource | SavedPathModelSource

export interface SavedModelRecord {
  id: string
  name: string
  created_at: number
  updated_at: number
  model_source: SavedModelSource
  skeleton_type: SkeletonType
  hand_skeleton_type: HandSkeletonType
  skeleton_scale: number
  use_head_weight_correction: boolean
  preview_plane_height: number
  bone_transforms: SavedBoneTransform[]
}

export function clone_saved_model_source (source: SavedModelSource): SavedModelSource {
  if (source.kind === 'upload') {
    return {
      ...source,
      model_data: source.model_data.slice(0)
    }
  }

  return { ...source }
}
