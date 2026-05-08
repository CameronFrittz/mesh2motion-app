import { type SkeletonType } from '../lib/enums/SkeletonType.ts'
import { clone_saved_model_source, type SavedModelSource } from '../lib/saved-models/SavedModelTypes.ts'
import { type TargetBoneMappingType } from './steps/StepBoneMapping.ts'

const DATABASE_NAME = 'mesh2motion-saved-rigged-models'
const DATABASE_VERSION = 1
const STORE_NAME = 'saved-rigged-models'
const UPDATED_AT_INDEX = 'updated_at'

export interface SavedRiggedBoneMapping {
  target_bone_name: string
  source_bone_name: string
}

export interface SavedRiggedModelRecord {
  id: string
  name: string
  created_at: number
  updated_at: number
  target_model_source: SavedModelSource
  source_skeleton_type: SkeletonType
  target_mapping_type: TargetBoneMappingType
  bone_mappings: SavedRiggedBoneMapping[]
}

export function clone_saved_rigged_model_record (record: SavedRiggedModelRecord): SavedRiggedModelRecord {
  return {
    ...record,
    target_model_source: clone_saved_model_source(record.target_model_source),
    bone_mappings: record.bone_mappings.map((mapping) => ({ ...mapping }))
  }
}

export class SavedRiggedModelStore {
  private database_promise: Promise<IDBDatabase> | null = null

  public async list (): Promise<SavedRiggedModelRecord[]> {
    const database = await this.database()

    return await new Promise<SavedRiggedModelRecord[]>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll() as IDBRequest<SavedRiggedModelRecord[]>

      request.onsuccess = () => {
        resolve(request.result.sort((a, b) => b.updated_at - a.updated_at))
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not list saved rigged models'))
      }
    })
  }

  public async get (id: string): Promise<SavedRiggedModelRecord | undefined> {
    const database = await this.database()

    return await new Promise<SavedRiggedModelRecord | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(id) as IDBRequest<SavedRiggedModelRecord | undefined>

      request.onsuccess = () => {
        resolve(request.result === undefined ? undefined : clone_saved_rigged_model_record(request.result))
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not load saved rigged model'))
      }
    })
  }

  public async put (record: SavedRiggedModelRecord): Promise<void> {
    const database = await this.database()

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.put(clone_saved_rigged_model_record(record))

      request.onsuccess = () => {
        resolve()
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not save rigged model'))
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
        reject(request.error ?? new Error('Could not delete saved rigged model'))
      }
    })
  }

  private async database (): Promise<IDBDatabase> {
    if (this.database_promise !== null) {
      return await this.database_promise
    }

    this.database_promise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser does not support saved rigged models.'))
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
      }

      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not open saved rigged model storage'))
      }
    })

    return await this.database_promise
  }
}
