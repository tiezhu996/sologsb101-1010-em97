/** 仪器状态：在用 / 注销（注销只影响台账，不回写历史测点的证据快照） */
export type MeterState = '在用' | '注销'

export const METER_STATES: MeterState[] = ['在用', '注销']

/**
 * 仪器台账：检测仪器的基本档案。
 * 与测点证据快照分开保存——测点录入时把仪器编号与当次校准有效期固化到快照里，
 * 之后台账变更（送检、更正、注销）都不会悄悄改变已录入测点的证据。
 */
export interface Meter {
  id: string
  /** 仪器编号（管理 / 出厂编号），全局唯一，测点快照按它追溯 */
  code: string
  /** 仪器名称 */
  name: string
  /** 状态：注销后历史快照保持不变，新测点不应再选用 */
  state: MeterState
  createdAt: number
  updatedAt: number
}

/**
 * 仪器校准记录：一次送检 / 校准一行。
 * 更正记录时 revision +1，并触发引用该记录的测点证据失效评估：
 * 未签发测点退回待复测，已签发结论保留原依据并标记需补充。
 */
export interface Calibration {
  id: string
  /** 所属仪器 */
  meterId: string
  /** 校准证书编号 */
  certificateNo: string
  /** 校准日期 */
  calibratedAt: string
  /** 校准有效期至（空串表示未登记） */
  validUntil: string
  /** 更正序号：每次更正 +1，与记录 id 组成幂等键，写入失败重试不会重复失效 */
  revision: number
  createdAt: number
  updatedAt: number
}

/** 取仪器最新一条校准记录（先按校准日期，再按创建时间） */
export function latestCalibrationOf(
  calibrations: Calibration[],
  meterId: string | null | undefined
): Calibration | null {
  if (!meterId) return null
  const list = calibrations.filter((item) => item.meterId === meterId)
  if (list.length === 0) return null
  return [...list].sort(
    (a, b) => (b.calibratedAt || '').localeCompare(a.calibratedAt || '') || b.createdAt - a.createdAt
  )[0]
}

/** 校准是否已过期（相对检测日期；有效期未登记视为不过期） */
export function isCalibrationExpired(validUntil: string, onDate: string): boolean {
  if (!validUntil || !onDate) return false
  return validUntil < onDate
}

/**
 * 解析旧版「仪器名称 / 编号」自由文本（如 "ZC-8 接地电阻测试仪 / No.20230517"）。
 * 无法解析出编号时返回 null——旧数据升级时这类测点归入待补证。
 */
export function parseLegacyMeterText(text: string): { name: string; code: string } | null {
  const parts = (text ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length < 2) return null
  const code = parts[parts.length - 1]
  const name = parts.slice(0, -1).join(' / ')
  if (!code || !name || name === '未填写') return null
  return { name, code }
}
