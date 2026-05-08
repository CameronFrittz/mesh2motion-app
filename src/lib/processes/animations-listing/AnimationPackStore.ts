import { type SkeletonType } from '../../enums/SkeletonType.ts'
import {
  type AnimationClipMetadata,
  type AnimationRootMotionMode,
  type TransformedAnimationClipPair
} from './interfaces/TransformedAnimationClipPair.ts'

const DATABASE_NAME = 'mesh2motion-animation-packs'
const DATABASE_VERSION = 1
const STORE_NAME = 'animation-packs'
const UPDATED_AT_INDEX = 'updated_at'
const SKELETON_TYPE_INDEX = 'skeleton_type'

export type AnimationPackSource = 'mesh2motion' | 'mixamo' | 'mixed'

export interface StoredAnimationPackRecord {
  id: string
  name: string
  skeleton_type: SkeletonType
  source: AnimationPackSource
  tags: string[]
  root_motion_mode: AnimationRootMotionMode
  created_at: number
  updated_at: number
  imported_at: number
  file_names: string[]
  animation_name_overrides?: Record<string, string>
  deleted_animation_names?: string[]
  clip_count: number
  byte_size: number
  glb_data: ArrayBuffer
}

export function animation_pack_metadata (record: StoredAnimationPackRecord): Partial<AnimationClipMetadata> {
  return {
    source_type: 'stored-pack',
    tags: record.tags,
    pack_name: record.name,
    pack_id: record.id,
    imported_at: record.imported_at,
    source_format: record.source,
    source_files: record.file_names,
    root_motion: record.root_motion_mode
  }
}

export function apply_animation_pack_name_overrides (
  record: StoredAnimationPackRecord,
  clips: TransformedAnimationClipPair[]
): TransformedAnimationClipPair[] {
  const deleted_animation_names = new Set(record.deleted_animation_names ?? [])

  return clips.filter((pair) => {
    const original_clip_name = pair.metadata.original_clip_name ?? pair.original_animation_clip.name
    if (deleted_animation_names.has(original_clip_name)) {
      return false
    }

    const renamed_clip_name = record.animation_name_overrides?.[original_clip_name]?.trim()

    pair.metadata = {
      ...pair.metadata,
      pack_id: record.id,
      original_clip_name
    }

    if (renamed_clip_name !== undefined && renamed_clip_name !== '') {
      pair.original_animation_clip.name = renamed_clip_name
      pair.display_animation_clip.name = renamed_clip_name
    }

    return true
  })
}

function clone_record (record: StoredAnimationPackRecord): StoredAnimationPackRecord {
  return {
    ...record,
    tags: [...record.tags],
    file_names: [...record.file_names],
    animation_name_overrides: record.animation_name_overrides === undefined
      ? undefined
      : { ...record.animation_name_overrides },
    deleted_animation_names: record.deleted_animation_names === undefined
      ? undefined
      : [...record.deleted_animation_names],
    glb_data: record.glb_data.slice(0)
  }
}

export class AnimationPackStore {
  private database_promise: Promise<IDBDatabase> | null = null

  public async list (): Promise<StoredAnimationPackRecord[]> {
    const database = await this.database()

    return await new Promise<StoredAnimationPackRecord[]>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll() as IDBRequest<StoredAnimationPackRecord[]>

      request.onsuccess = () => {
        resolve(request.result.map(clone_record).sort((a, b) => b.updated_at - a.updated_at))
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not list animation packs'))
      }
    })
  }

  public async list_by_skeleton_type (skeleton_type: SkeletonType): Promise<StoredAnimationPackRecord[]> {
    const records = await this.list()
    return records.filter(record => record.skeleton_type === skeleton_type)
  }

  public async get (id: string): Promise<StoredAnimationPackRecord | null> {
    const database = await this.database()

    return await new Promise<StoredAnimationPackRecord | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(id) as IDBRequest<StoredAnimationPackRecord | undefined>

      request.onsuccess = () => {
        resolve(request.result === undefined ? null : clone_record(request.result))
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not load animation pack'))
      }
    })
  }

  public async put (record: StoredAnimationPackRecord): Promise<void> {
    const database = await this.database()

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.put(clone_record(record))

      request.onsuccess = () => {
        resolve()
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not save animation pack'))
      }
    })
  }

  public async delete (id: string): Promise<void> {
    const database = await this.database()

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.delete(id)

      request.onsuccess = () => {
        resolve()
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not delete animation pack'))
      }
    })
  }

  private async database (): Promise<IDBDatabase> {
    if (this.database_promise !== null) {
      return await this.database_promise
    }

    this.database_promise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser does not support saved animation packs.'))
        return
      }

      const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

      request.onupgradeneeded = () => {
        const database = request.result
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction?.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: 'id' })

        if (store !== undefined && !store.indexNames.contains(UPDATED_AT_INDEX)) {
          store.createIndex(UPDATED_AT_INDEX, UPDATED_AT_INDEX, { unique: false })
        }

        if (store !== undefined && !store.indexNames.contains(SKELETON_TYPE_INDEX)) {
          store.createIndex(SKELETON_TYPE_INDEX, SKELETON_TYPE_INDEX, { unique: false })
        }
      }

      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not open animation pack storage'))
      }
    })

    return await this.database_promise
  }
}
