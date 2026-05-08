import { AnimationRetargetService } from './AnimationRetargetService.ts'
import {
  type SavedRiggedBoneMapping,
  type SavedRiggedModelRecord,
  SavedRiggedModelStore
} from './SavedRiggedModelStore.ts'
import { type StepBoneMapping, TargetBoneMappingType } from './steps/StepBoneMapping.ts'
import { type StepLoadSourceSkeleton } from './steps/StepLoadSourceSkeleton.ts'
import { type StepLoadTargetModel } from './steps/StepLoadTargetModel.ts'
import { type SavedModelSource } from '../lib/saved-models/SavedModelTypes.ts'
import { SkeletonType } from '../lib/enums/SkeletonType.ts'

export interface RetargetSavedModelCallbacks {
  on_restore_ready: () => void
}

export class RetargetSavedModelManager {
  private readonly store: SavedRiggedModelStore = new SavedRiggedModelStore()
  private pending_load_record: SavedRiggedModelRecord | null = null
  private active_saved_model_id: string | null = null
  private is_waiting_for_source_skeleton: boolean = false
  private is_waiting_for_target_model: boolean = false

  private saved_models_select: HTMLSelectElement | null = null
  private load_saved_model_button: HTMLButtonElement | null = null
  private delete_saved_model_button: HTMLButtonElement | null = null
  private save_model_button: HTMLButtonElement | null = null
  private saved_model_status: HTMLElement | null = null

  constructor (
    private readonly step_load_source_skeleton: StepLoadSourceSkeleton,
    private readonly step_load_target_model: StepLoadTargetModel,
    private readonly step_bone_mapping: StepBoneMapping,
    private readonly callbacks: RetargetSavedModelCallbacks
  ) {}

  public initialize (): void {
    this.saved_models_select = document.getElementById('saved-rigged-models-select') as HTMLSelectElement | null
    this.load_saved_model_button = document.getElementById('load-saved-rigged-model-button') as HTMLButtonElement | null
    this.delete_saved_model_button = document.getElementById('delete-saved-rigged-model-button') as HTMLButtonElement | null
    this.save_model_button = document.getElementById('save-rigged-model-button') as HTMLButtonElement | null
    this.saved_model_status = document.getElementById('saved-rigged-model-status')

    if (this.saved_models_select === null) {
      return
    }

    this.save_model_button?.addEventListener('click', () => {
      void this.save_current_model()
    })

    this.load_saved_model_button?.addEventListener('click', () => {
      void this.load_selected_model()
    })

    this.delete_saved_model_button?.addEventListener('click', () => {
      void this.delete_selected_model()
    })

    this.step_load_source_skeleton.addEventListener('skeleton-loaded', () => {
      if (!this.is_waiting_for_source_skeleton) {
        return
      }

      this.is_waiting_for_source_skeleton = false
      this.try_finish_pending_load()
    })

    this.step_load_target_model.addEventListener('target-model-loaded', () => {
      if (!this.is_waiting_for_target_model) {
        this.active_saved_model_id = null
        return
      }

      this.is_waiting_for_target_model = false
      this.try_finish_pending_load()
    })

    void this.refresh_saved_model_list()
  }

  private async save_current_model (): Promise<void> {
    try {
      const target_model_source = this.step_load_target_model.get_current_model_source()
      if (target_model_source === null) {
        this.set_status('Upload a rig before saving.')
        return
      }

      const source_skeleton_type = this.step_load_source_skeleton.get_skeleton_type()
      if (source_skeleton_type === SkeletonType.None || source_skeleton_type === SkeletonType.Error) {
        this.set_status('Choose a source skeleton before saving.')
        return
      }

      const existing_record = this.active_saved_model_id === null
        ? undefined
        : await this.store.get(this.active_saved_model_id)
      const default_name = existing_record?.name ?? this.default_name_for_model_source(target_model_source)
      const prompted_name = window.prompt('Save rigged model as', default_name)

      if (prompted_name === null) {
        return
      }

      const name = prompted_name.trim()
      if (name === '') {
        this.set_status('Saved rigged model name cannot be empty.')
        return
      }

      const retarget_service = AnimationRetargetService.getInstance()
      const now = Date.now()
      const record: SavedRiggedModelRecord = {
        id: existing_record?.id ?? this.generate_id(),
        name,
        created_at: existing_record?.created_at ?? now,
        updated_at: now,
        target_model_source,
        source_skeleton_type,
        target_mapping_type: retarget_service.get_target_mapping_type(),
        bone_mappings: this.bone_mapping_entries_from_map(retarget_service.get_bone_mappings())
      }

      await this.store.put(record)
      this.active_saved_model_id = record.id
      await this.refresh_saved_model_list(record.id)
      this.set_status(`Saved ${record.name}.`)
    } catch (error) {
      console.error('Could not save rigged model', error)
      this.set_status(`Could not save rigged model: ${this.message_from_error(error)}`)
    }
  }

  private async load_selected_model (): Promise<void> {
    const selected_id = this.selected_saved_model_id()
    if (selected_id === null) {
      return
    }

    try {
      const record = await this.store.get(selected_id)
      if (record === undefined) {
        this.set_status('Saved rigged model could not be found.')
        await this.refresh_saved_model_list()
        return
      }

      this.pending_load_record = record
      this.active_saved_model_id = record.id
      this.is_waiting_for_source_skeleton = true
      this.is_waiting_for_target_model = true
      this.set_status(`Loading ${record.name}...`)

      this.step_load_source_skeleton.load_skeleton_type(record.source_skeleton_type)
      this.step_load_target_model.load_target_model_source(record.target_model_source)
    } catch (error) {
      console.error('Could not load saved rigged model', error)
      this.clear_pending_load()
      this.set_status(`Could not load saved rigged model: ${this.message_from_error(error)}`)
    }
  }

  private async delete_selected_model (): Promise<void> {
    const selected_id = this.selected_saved_model_id()
    if (selected_id === null) {
      return
    }

    try {
      const record = await this.store.get(selected_id)
      if (record === undefined) {
        await this.refresh_saved_model_list()
        return
      }

      const should_delete = window.confirm(`Delete saved rigged model "${record.name}"?`)
      if (!should_delete) {
        return
      }

      await this.store.delete(selected_id)
      if (this.active_saved_model_id === selected_id) {
        this.active_saved_model_id = null
      }

      if (this.pending_load_record?.id === selected_id) {
        this.clear_pending_load()
      }

      await this.refresh_saved_model_list()
      this.set_status(`Deleted ${record.name}.`)
    } catch (error) {
      console.error('Could not delete saved rigged model', error)
      this.set_status(`Could not delete saved rigged model: ${this.message_from_error(error)}`)
    }
  }

  private try_finish_pending_load (): void {
    if (
      this.pending_load_record === null ||
      this.is_waiting_for_source_skeleton ||
      this.is_waiting_for_target_model
    ) {
      return
    }

    const record = this.pending_load_record
    this.clear_pending_load()
    this.active_saved_model_id = record.id

    const restored_mappings = new Map<string, string>()
    record.bone_mappings.forEach((mapping) => {
      restored_mappings.set(mapping.target_bone_name, mapping.source_bone_name)
    })

    this.step_bone_mapping.restore_bone_mappings(
      restored_mappings,
      record.target_mapping_type ?? TargetBoneMappingType.Custom
    )

    this.callbacks.on_restore_ready()
    void this.refresh_saved_model_list(record.id)
    this.set_status(`Loaded ${record.name}.`)
  }

  private clear_pending_load (): void {
    this.pending_load_record = null
    this.is_waiting_for_source_skeleton = false
    this.is_waiting_for_target_model = false
  }

  private async refresh_saved_model_list (selected_id?: string): Promise<void> {
    if (this.saved_models_select === null) {
      return
    }

    try {
      const records = await this.store.list()
      const preferred_id = selected_id ?? this.saved_models_select.value
      this.saved_models_select.innerHTML = ''

      if (records.length === 0) {
        const option = document.createElement('option')
        option.value = ''
        option.textContent = 'No saved rigged models'
        this.saved_models_select.appendChild(option)
        this.saved_models_select.disabled = true
        if (this.load_saved_model_button !== null) this.load_saved_model_button.disabled = true
        if (this.delete_saved_model_button !== null) this.delete_saved_model_button.disabled = true
        return
      }

      records.forEach((record) => {
        const option = document.createElement('option')
        option.value = record.id
        option.textContent = `${record.name} (${this.label_for_model_source(record.target_model_source)})`
        this.saved_models_select?.appendChild(option)
      })

      this.saved_models_select.disabled = false
      if (this.load_saved_model_button !== null) this.load_saved_model_button.disabled = false
      if (this.delete_saved_model_button !== null) this.delete_saved_model_button.disabled = false

      if (preferred_id !== '') {
        this.saved_models_select.value = preferred_id
      }
    } catch (error) {
      console.error('Could not refresh saved rigged model list', error)
      this.set_status(`Could not read saved rigged models: ${this.message_from_error(error)}`)
    }
  }

  private selected_saved_model_id (): string | null {
    if (this.saved_models_select === null || this.saved_models_select.value === '') {
      return null
    }

    return this.saved_models_select.value
  }

  private bone_mapping_entries_from_map (bone_mappings: Map<string, string>): SavedRiggedBoneMapping[] {
    const entries: SavedRiggedBoneMapping[] = []
    bone_mappings.forEach((source_bone_name, target_bone_name) => {
      entries.push({ target_bone_name, source_bone_name })
    })
    return entries
  }

  private default_name_for_model_source (source: SavedModelSource): string {
    const file_name = source.kind === 'upload' ? source.file_name : source.file_name
    const last_dot_index = file_name.lastIndexOf('.')
    if (last_dot_index <= 0) {
      return file_name
    }

    return file_name.slice(0, last_dot_index)
  }

  private label_for_model_source (source: SavedModelSource): string {
    if (source.kind === 'path') {
      return source.file_name
    }

    return `${source.file_name}, ${this.format_byte_size(source.byte_size)}`
  }

  private format_byte_size (byte_size: number): string {
    if (byte_size < 1024) {
      return `${byte_size} B`
    }

    const kilobytes = byte_size / 1024
    if (kilobytes < 1024) {
      return `${kilobytes.toFixed(1)} KB`
    }

    const megabytes = kilobytes / 1024
    return `${megabytes.toFixed(1)} MB`
  }

  private generate_id (): string {
    if (window.crypto.randomUUID !== undefined) {
      return window.crypto.randomUUID()
    }

    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }

  private set_status (message: string): void {
    if (this.saved_model_status !== null) {
      this.saved_model_status.textContent = message
    }
  }

  private message_from_error (error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return String(error)
  }
}
