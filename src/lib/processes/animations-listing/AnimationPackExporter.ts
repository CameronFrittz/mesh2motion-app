import { Scene, type AnimationClip, type Object3D, type SkinnedMesh } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { RetargetUtils } from '../../../retarget/RetargetUtils.ts'

export class AnimationPackExporter {
  public async export_pack_buffer (skinned_meshes: SkinnedMesh[], animations: AnimationClip[]): Promise<ArrayBuffer> {
    const export_scene = this.create_skeleton_scene(skinned_meshes)

    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const gltf_exporter = new GLTFExporter()

      gltf_exporter.parse(
        export_scene,
        (result: ArrayBuffer | object) => {
          if (result instanceof ArrayBuffer) {
            resolve(result)
            return
          }

          reject(new Error('Animation pack export did not produce a binary GLB buffer.'))
        },
        (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)))
        },
        {
          binary: true,
          onlyVisible: false,
          embedImages: false,
          animations
        }
      )
    })
  }

  private create_skeleton_scene (skinned_meshes: SkinnedMesh[]): Scene {
    const scene = new Scene()
    if (skinned_meshes.length === 0) {
      return scene
    }

    const skeleton = RetargetUtils.clone_skeleton(skinned_meshes[0].skeleton)
    const root_bones = skeleton.bones.filter((bone) =>
      bone.parent === null || bone.parent.type !== 'Bone'
    )

    root_bones.forEach((bone: Object3D) => {
      scene.add(bone)
    })

    return scene
  }
}
