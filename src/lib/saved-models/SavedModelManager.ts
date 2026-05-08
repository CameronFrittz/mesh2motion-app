import { Vector3 } from 'three'
import { type Mesh2MotionEngine } from '../../Mesh2MotionEngine.ts'
import BoneTransformState from '../interfaces/BoneTransformState.ts'
import { SkeletonType } from '../enums/SkeletonType.ts'
import { ProcessStep } from '../enums/ProcessStep.ts'
import { Utility } from '../Utilities.ts'
import { RigConfig } from '../RigConfig.ts'
import { SavedModelStore } from './SavedModelStore.ts'
import {
  type SavedBoneTransform,
  type SavedModelRecord,
  type SavedModelSource
} from './SavedModelTypes.ts'

export class SavedModelManager {
  private readonly store: SavedModelStore = new SavedModelStore()
  private pending_load_record: SavedModelRecord | null = null
  private active_saved_model_id: string | null = null

  constructor (private readonly bootstrap: Mesh2MotionEngine) {}

  public initialize (): void {
    if (!this.has_saved_model_ui()) {
      return
    }

    this.bootstrap.ui.dom_save_model_button?.addEventListener('click', () => {
      void this.save_current_model()
    })

    this.bootstrap.ui.dom_load_saved_model_button?.addEventListener('click', () => {
      void this.load_selected_model()
    })

    this.bootstrap.ui.dom_delete_saved_model_button?.addEventListener('click', () => {
      void this.delete_selected_model()
    })

    this.bootstrap.load_model_step.addEventListener('modelLoaded', () => {
      this.handle_model_loaded()
    })

    this.bootstrap.load_skeleton_step.addEventListener('skeletonLoaded', () => {
      this.handle_skeleton_loaded()
    })

    void this.refresh_saved_model_list()
  }

  private has_saved_model_ui (): boolean {
    return this.bootstrap.ui.dom_saved_models_select !== null
  }

  private async save_current_model (): Promise<void> {
    try {
      const model_source = this.bootstrap.load_model_step.get_current_model_source()
      if (model_source === null) {
        this.set_status('Load a model before saving.')
        return
      }

      if (!this.can_save_current_skeleton()) {
        this.set_status('Position a skeleton before saving.')
        return
      }

      const existing_record = this.active_saved_model_id === null
        ? undefined
        : await this.store.get(this.active_saved_model_id)
      const default_name = existing_record?.name ?? this.default_name_for_model_source(model_source)
      const prompted_name = window.prompt('Save model as', default_name)

      if (prompted_name === null) {
        return
      }

      const name = prompted_name.trim()
      if (name === '') {
        this.set_status('Saved model name cannot be empty.')
        return
      }

      this.set_status(`Preparing ${name} for saving...`)
      const prepared_model_source = await this.bootstrap.load_model_step.export_prepared_model_source(
        this.file_name_for_saved_model(name)
      )
      const now = Date.now()
      const record: SavedModelRecord = {
        id: existing_record?.id ?? this.generate_id(),
        name,
        created_at: existing_record?.created_at ?? now,
        updated_at: now,
        model_source: prepared_model_source,
        skeleton_type: this.bootstrap.load_skeleton_step.skeleton_type(),
        hand_skeleton_type: this.bootstrap.load_skeleton_step.selected_hand_skeleton_type(),
        skeleton_scale: this.bootstrap.load_skeleton_step.skeleton_scale(),
        use_head_weight_correction: this.bootstrap.edit_skeleton_step.use_head_weight_correction(),
        preview_plane_height: this.bootstrap.edit_skeleton_step.get_preview_plane_height(),
        bone_transforms: this.saved_bone_transforms_from_current_skeleton()
      }

      await this.store.put(record)
      this.active_saved_model_id = record.id
      await this.refresh_saved_model_list(record.id)
      this.set_status(`Saved ${record.name}.`)
    } catch (error) {
      console.error('Could not save model', error)
      this.set_status(`Could not save model: ${this.message_from_error(error)}`)
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
        this.set_status('Saved model could not be found.')
        await this.refresh_saved_model_list()
        return
      }

      this.pending_load_record = record
      this.active_saved_model_id = record.id
      this.set_status(`Loading ${record.name}...`)

      this.bootstrap.process_step = this.bootstrap.process_step_changed(ProcessStep.LoadModel)
      this.bootstrap.load_model_step.load_saved_model_source(record.model_source)
    } catch (error) {
      console.error('Could not load saved model', error)
      this.pending_load_record = null
      this.set_status(`Could not load saved model: ${this.message_from_error(error)}`)
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

      const should_delete = window.confirm(`Delete saved model "${record.name}"?`)
      if (!should_delete) {
        return
      }

      await this.store.delete(selected_id)
      if (this.active_saved_model_id === selected_id) {
        this.active_saved_model_id = null
      }
      if (this.pending_load_record?.id === selected_id) {
        this.pending_load_record = null
      }

      await this.refresh_saved_model_list()
      this.set_status(`Deleted ${record.name}.`)
    } catch (error) {
      console.error('Could not delete saved model', error)
      this.set_status(`Could not delete saved model: ${this.message_from_error(error)}`)
    }
  }

  private handle_model_loaded (): void {
    if (this.pending_load_record === null) {
      this.active_saved_model_id = null
      return
    }

    const record = this.pending_load_record
    const rig_file = RigConfig.rig_file_for(record.skeleton_type)
    if (rig_file === undefined) {
      this.pending_load_record = null
      this.set_status('Saved model uses an unknown skeleton type.')
      return
    }

    this.bootstrap.load_skeleton_step.apply_saved_skeleton_settings(
      record.skeleton_type,
      record.hand_skeleton_type,
      record.skeleton_scale
    )

    this.set_status(`Loading skeleton for ${record.name}...`)
    this.bootstrap.load_skeleton_step.load_skeleton_file(rig_file)
  }

  private handle_skeleton_loaded (): void {
    if (this.pending_load_record === null) {
      return
    }

    const record = this.pending_load_record
    this.pending_load_record = null
    this.active_saved_model_id = record.id

    this.bootstrap.edit_skeleton_step.apply_saved_edit_settings(
      record.use_head_weight_correction,
      record.preview_plane_height
    )
    this.bootstrap.edit_skeleton_step.restore_bone_transforms(
      this.bone_transform_states_from_saved_transforms(record.bone_transforms)
    )

    void this.refresh_saved_model_list(record.id)
    this.set_status(`Loaded ${record.name}.`)
  }

  private async refresh_saved_model_list (selected_id?: string): Promise<void> {
    const select = this.bootstrap.ui.dom_saved_models_select
    const load_button = this.bootstrap.ui.dom_load_saved_model_button
    const delete_button = this.bootstrap.ui.dom_delete_saved_model_button

    if (select === null) {
      return
    }

    try {
      const records = await this.store.list()
      const preferred_id = selected_id ?? select.value
      select.innerHTML = ''

      if (records.length === 0) {
        const option = document.createElement('option')
        option.value = ''
        option.textContent = 'No saved models'
        select.appendChild(option)
        select.disabled = true
        if (load_button !== null) load_button.disabled = true
        if (delete_button !== null) delete_button.disabled = true
        return
      }

      records.forEach((record) => {
        const option = document.createElement('option')
        option.value = record.id
        option.textContent = `${record.name} (${this.label_for_model_source(record.model_source)})`
        select.appendChild(option)
      })

      select.disabled = false
      if (load_button !== null) load_button.disabled = false
      if (delete_button !== null) delete_button.disabled = false

      if (preferred_id !== '') {
        select.value = preferred_id
      }
    } catch (error) {
      console.error('Could not refresh saved model list', error)
      this.set_status(`Could not read saved models: ${this.message_from_error(error)}`)
    }
  }

  private selected_saved_model_id (): string | null {
    const select = this.bootstrap.ui.dom_saved_models_select
    if (select === null || select.value === '') {
      return null
    }

    return select.value
  }

  private can_save_current_skeleton (): boolean {
    const is_skeleton_step =
      this.bootstrap.process_step === ProcessStep.EditSkeleton ||
      this.bootstrap.process_step === ProcessStep.AnimationsListing

    if (!is_skeleton_step) {
      return false
    }

    const skeleton_type = this.bootstrap.load_skeleton_step.skeleton_type()
    if (skeleton_type === SkeletonType.None || skeleton_type === SkeletonType.Error) {
      return false
    }

    return this.bootstrap.edit_skeleton_step.skeleton().bones.length > 0
  }

  private saved_bone_transforms_from_current_skeleton (): SavedBoneTransform[] {
    return Utility.store_bone_transforms(this.bootstrap.edit_skeleton_step.skeleton()).map((bone_transform) => {
      return {
        name: bone_transform.name,
        position: [bone_transform.position.x, bone_transform.position.y, bone_transform.position.z],
        rotation: [bone_transform.rotation.x, bone_transform.rotation.y, bone_transform.rotation.z],
        scale: [bone_transform.scale.x, bone_transform.scale.y, bone_transform.scale.z]
      }
    })
  }

  private bone_transform_states_from_saved_transforms (saved_transforms: SavedBoneTransform[]): BoneTransformState[] {
    return saved_transforms.map((saved_transform) => {
      return new BoneTransformState(
        saved_transform.name,
        new Vector3(...saved_transform.position),
        new Vector3(...saved_transform.rotation),
        new Vector3(...saved_transform.scale)
      )
    })
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

  private file_name_for_saved_model (name: string): string {
    const clean_name = name
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')

    return clean_name === '' ? 'saved-model' : clean_name
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
    if (this.bootstrap.ui.dom_saved_model_status !== null) {
      this.bootstrap.ui.dom_saved_model_status.textContent = message
    }
  }

  private message_from_error (error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return String(error)
  }
}
