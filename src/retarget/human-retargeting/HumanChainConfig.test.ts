import { describe, expect, it } from 'vitest'
import { HumanChainConfig } from './HumanChainConfig'

function create_numbered_mixamo_mapping (): Map<string, string> {
  const mappings = new Map<string, string>()

  Object.entries(HumanChainConfig.mesh2motion_config).forEach(([chain_name, source_bone_names]) => {
    const mixamo_bone_names = HumanChainConfig.mixamo_config[chain_name]

    source_bone_names.forEach((source_bone_name, index) => {
      const mixamo_bone_name = mixamo_bone_names[index]
      mappings.set(mixamo_bone_name.replace('mixamorig', 'mixamorig5'), source_bone_name)
    })
  })

  return mappings
}

describe('HumanChainConfig', () => {
  it('builds a Mixamo target config from actual mapped target bone names', () => {
    const target_config = HumanChainConfig.build_mixamo_target_config(create_numbered_mixamo_mapping())

    expect(target_config.pelvis).toEqual(['mixamorig5Hips'])
    expect(target_config.armL).toEqual([
      'mixamorig5LeftArm',
      'mixamorig5LeftForeArm',
      'mixamorig5LeftHand'
    ])
    expect(target_config.fingersPinkyL).toEqual([
      'mixamorig5LeftHandPinky1',
      'mixamorig5LeftHandPinky2',
      'mixamorig5LeftHandPinky3',
      'mixamorig5LeftHandPinky4'
    ])
  })

  it('falls back to the stock Mixamo config when no mapping exists yet', () => {
    const target_config = HumanChainConfig.build_mixamo_target_config(new Map())

    expect(target_config.pelvis).toEqual(['mixamorigHips'])
    expect(target_config.armL).toEqual([
      'mixamorigLeftArm',
      'mixamorigLeftForeArm',
      'mixamorigLeftHand'
    ])
  })
})
