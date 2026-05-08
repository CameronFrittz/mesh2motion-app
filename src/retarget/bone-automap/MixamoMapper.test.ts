import { describe, expect, it } from 'vitest'
import { BoneCategory, type BoneMetadata, BoneSide } from './BoneAutoMapper'
import { MixamoMapper } from './MixamoMapper'

function create_bone_metadata (name: string): BoneMetadata {
  return {
    name,
    normalized_name: name.toLowerCase(),
    side: BoneSide.Center,
    category: BoneCategory.Unknown,
    parent_name: null
  }
}

describe('MixamoMapper', () => {
  it('maps Mixamo bones with numbered rig prefixes', () => {
    const source_bones: BoneMetadata[] = [
      create_bone_metadata('pelvis'),
      create_bone_metadata('pinky_01_l'),
      create_bone_metadata('pinky_02_l'),
      create_bone_metadata('pinky_03_l'),
      create_bone_metadata('pinky_04_leaf_l')
    ]
    const target_bones: BoneMetadata[] = [
      create_bone_metadata('mixamorig5Hips'),
      create_bone_metadata('mixamorig5LeftHandPinky1'),
      create_bone_metadata('mixamorig5LeftHandPinky2'),
      create_bone_metadata('mixamorig5LeftHandPinky3'),
      create_bone_metadata('mixamorig5LeftHandPinky4')
    ]

    const mappings = MixamoMapper.map_mixamo_bones(source_bones, target_bones)

    expect(mappings.get('mixamorig5Hips')).toBe('pelvis')
    expect(mappings.get('mixamorig5LeftHandPinky1')).toBe('pinky_01_l')
    expect(mappings.get('mixamorig5LeftHandPinky2')).toBe('pinky_02_l')
    expect(mappings.get('mixamorig5LeftHandPinky3')).toBe('pinky_03_l')
    expect(mappings.get('mixamorig5LeftHandPinky4')).toBe('pinky_04_leaf_l')
  })

  it('maps Mixamo bones with namespace separators', () => {
    const source_bones: BoneMetadata[] = [
      create_bone_metadata('upperarm_l'),
      create_bone_metadata('lowerarm_l'),
      create_bone_metadata('hand_l')
    ]
    const target_bones: BoneMetadata[] = [
      create_bone_metadata('Character:mixamorig:LeftArm'),
      create_bone_metadata('Character:mixamorig:LeftForeArm'),
      create_bone_metadata('Character:mixamorig:LeftHand')
    ]

    const mappings = MixamoMapper.map_mixamo_bones(source_bones, target_bones)

    expect(mappings.get('Character:mixamorig:LeftArm')).toBe('upperarm_l')
    expect(mappings.get('Character:mixamorig:LeftForeArm')).toBe('lowerarm_l')
    expect(mappings.get('Character:mixamorig:LeftHand')).toBe('hand_l')
  })
})
