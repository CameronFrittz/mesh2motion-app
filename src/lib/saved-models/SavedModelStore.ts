import { type SavedModelRecord } from './SavedModelTypes.ts'

const DATABASE_NAME = 'mesh2motion-saved-models'
const DATABASE_VERSION = 1
const STORE_NAME = 'saved-models'
const UPDATED_AT_INDEX = 'updated_at'

export class SavedModelStore {
  private database_promise: Promise<IDBDatabase> | null = null

  public async list (): Promise<SavedModelRecord[]> {
    const database = await this.database()

    return await new Promise<SavedModelRecord[]>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll() as IDBRequest<SavedModelRecord[]>

      request.onsuccess = () => {
        resolve(request.result.sort((a, b) => b.updated_at - a.updated_at))
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not list saved models'))
      }
    })
  }

  public async get (id: string): Promise<SavedModelRecord | undefined> {
    const database = await this.database()

    return await new Promise<SavedModelRecord | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(id) as IDBRequest<SavedModelRecord | undefined>

      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not load saved model'))
      }
    })
  }

  public async put (record: SavedModelRecord): Promise<void> {
    const database = await this.database()

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.put(record)

      request.onsuccess = () => {
        resolve()
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Could not save model'))
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
        reject(request.error ?? new Error('Could not delete saved model'))
      }
    })
  }

  private async database (): Promise<IDBDatabase> {
    if (this.database_promise !== null) {
      return await this.database_promise
    }

    this.database_promise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser does not support saved models.'))
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
        reject(request.error ?? new Error('Could not open saved model storage'))
      }
    })

    return await this.database_promise
  }
}
