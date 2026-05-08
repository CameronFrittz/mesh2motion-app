import { type BoneMetadata } from './BoneAutoMapper'

/**
 * MixamoMapper - Direct bone name mapping for Mixamo rigs
 * Source: Mesh2Motion skeleton (hardcoded names)
 * Target: Mixamo skeleton (mixamorig: prefix)
 */
export class MixamoMapper {
  /**
   * Direct mapping: Mesh2Motion bone name -> Mixamo bone name
   */
  private static readonly BONE_MAP: Record<string, string> = {
    // Torso
    pelvis: 'mixamorigHips',
    spine_01: 'mixamorigSpine',
    spine_02: 'mixamorigSpine1',
    spine_03: 'mixamorigSpine2',
    neck_01: 'mixamorigNeck',
    head: 'mixamorigHead',
    head_leaf: 'mixamorigHeadTop_End',

    // Left Arm
    clavicle_l: 'mixamorigLeftShoulder',
    upperarm_l: 'mixamorigLeftArm',
    lowerarm_l: 'mixamorigLeftForeArm',
    hand_l: 'mixamorigLeftHand',

    // Right Arm
    clavicle_r: 'mixamorigRightShoulder',
    upperarm_r: 'mixamorigRightArm',
    lowerarm_r: 'mixamorigRightForeArm',
    hand_r: 'mixamorigRightHand',

    // Left Leg
    thigh_l: 'mixamorigLeftUpLeg',
    calf_l: 'mixamorigLeftLeg',
    foot_l: 'mixamorigLeftFoot',
    ball_l: 'mixamorigLeftToeBase',
    ball_leaf_l: 'mixamorigLeftToe_End',

    // Right Leg
    thigh_r: 'mixamorigRightUpLeg',
    calf_r: 'mixamorigRightLeg',
    foot_r: 'mixamorigRightFoot',
    ball_r: 'mixamorigRightToeBase',
    ball_leaf_r: 'mixamorigRightToe_End',

    // Left Hand Fingers - Thumb
    thumb_01_l: 'mixamorigLeftHandThumb1',
    thumb_02_l: 'mixamorigLeftHandThumb2',
    thumb_03_l: 'mixamorigLeftHandThumb3',
    thumb_04_leaf_l: 'mixamorigLeftHandThumb4',

    // Left Hand Fingers - Index
    index_01_l: 'mixamorigLeftHandIndex1',
    index_02_l: 'mixamorigLeftHandIndex2',
    index_03_l: 'mixamorigLeftHandIndex3',
    index_04_leaf_l: 'mixamorigLeftHandIndex4',

    // Left Hand Fingers - Middle
    middle_01_l: 'mixamorigLeftHandMiddle1',
    middle_02_l: 'mixamorigLeftHandMiddle2',
    middle_03_l: 'mixamorigLeftHandMiddle3',
    middle_04_leaf_l: 'mixamorigLeftHandMiddle4',

    // Left Hand Fingers - Ring
    ring_01_l: 'mixamorigLeftHandRing1',
    ring_02_l: 'mixamorigLeftHandRing2',
    ring_03_l: 'mixamorigLeftHandRing3',
    ring_04_leaf_l: 'mixamorigLeftHandRing4',

    // Left Hand Fingers - Pinky
    pinky_01_l: 'mixamorigLeftHandPinky1',
    pinky_02_l: 'mixamorigLeftHandPinky2',
    pinky_03_l: 'mixamorigLeftHandPinky3',
    pinky_04_leaf_l: 'mixamorigLeftHandPinky4',

    // Right Hand Fingers - Thumb
    thumb_01_r: 'mixamorigRightHandThumb1',
    thumb_02_r: 'mixamorigRightHandThumb2',
    thumb_03_r: 'mixamorigRightHandThumb3',
    thumb_04_leaf_r: 'mixamorigRightHandThumb4',

    // Right Hand Fingers - Index
    index_01_r: 'mixamorigRightHandIndex1',
    index_02_r: 'mixamorigRightHandIndex2',
    index_03_r: 'mixamorigRightHandIndex3',
    index_04_leaf_r: 'mixamorigRightHandIndex4',

    // Right Hand Fingers - Middle
    middle_01_r: 'mixamorigRightHandMiddle1',
    middle_02_r: 'mixamorigRightHandMiddle2',
    middle_03_r: 'mixamorigRightHandMiddle3',
    middle_04_leaf_r: 'mixamorigRightHandMiddle4',

    // Right Hand Fingers - Ring
    ring_01_r: 'mixamorigRightHandRing1',
    ring_02_r: 'mixamorigRightHandRing2',
    ring_03_r: 'mixamorigRightHandRing3',
    ring_04_leaf_r: 'mixamorigRightHandRing4',

    // Right Hand Fingers - Pinky
    pinky_01_r: 'mixamorigRightHandPinky1',
    pinky_02_r: 'mixamorigRightHandPinky2',
    pinky_03_r: 'mixamorigRightHandPinky3',
    pinky_04_leaf_r: 'mixamorigRightHandPinky4'
  }

  /**
   * Check if the given skeleton is a Mixamo skeleton
   * @param bones - Bones to check
   * @returns True if any bone name contains "mixamorig"
   */
  static is_target_valid_skeleton (bone_names: string[]): boolean {
    return bone_names.some(name => name.toLowerCase().includes('mixamorig'))
  }

  /**
   * Get the expected Mixamo bone name for a Mesh2Motion bone name.
   */
  static map_source_bone_name_to_mixamo (source_bone_name: string): string | undefined {
    return this.BONE_MAP[source_bone_name]
  }

  /**
   * Normalize Mixamo bone names for matching. Some Mixamo exports include a numeric
   * rig prefix or namespace separator, such as "mixamorig5LeftArm" or
   * "mixamorig:LeftArm", while our table stores the canonical "mixamorigLeftArm".
   */
  private static normalize_mixamo_bone_name (bone_name: string): string {
    const lower_name = bone_name.trim().toLowerCase()
    const mixamo_prefix_index = lower_name.indexOf('mixamorig')
    const mixamo_name = mixamo_prefix_index >= 0
      ? lower_name.slice(mixamo_prefix_index)
      : lower_name

    return mixamo_name
      .replace(/^mixamorig[\d\s:_.|-]*/g, '')
      .replace(/[\s:_.|-]/g, '')
  }

  /**
   * Map Mesh2Motion bones to Mixamo bones
   * @param source_bones - Mesh2Motion skeleton bones
   * @param target_bones - Mixamo skeleton bones
   * @returns Map of target bone name -> source bone name
   */
  static map_mixamo_bones (source_bones: BoneMetadata[], target_bones: BoneMetadata[]): Map<string, string> {
    const mappings = new Map<string, string>()

    // console.log('=== MIXAMO DIRECT MAPPING ===')

    const target_bones_by_normalized_mixamo_name = new Map<string, BoneMetadata>()
    for (const target_bone of target_bones) {
      const normalized_mixamo_name = this.normalize_mixamo_bone_name(target_bone.name)
      if (!target_bones_by_normalized_mixamo_name.has(normalized_mixamo_name)) {
        target_bones_by_normalized_mixamo_name.set(normalized_mixamo_name, target_bone)
      }
    }

    // For each source bone (Mesh2Motion), find matching target bone (Mixamo)
    for (const source_bone of source_bones) {
      const expected_mixamo_name: string | undefined = this.BONE_MAP[source_bone.name]

      if (expected_mixamo_name !== undefined) {
        const normalized_mixamo_name = this.normalize_mixamo_bone_name(expected_mixamo_name)
        const target_bone: BoneMetadata | undefined = target_bones_by_normalized_mixamo_name.get(normalized_mixamo_name)

        if (target_bone !== undefined) {
          mappings.set(target_bone.name, source_bone.name)
          // console.log(`Mapped: ${target_bone.name} -> ${source_bone.name}`)
        }
      }
    }

    console.log(`Mixamo mapping complete: ${mappings.size} bones mapped`)
    return mappings
  }
}
