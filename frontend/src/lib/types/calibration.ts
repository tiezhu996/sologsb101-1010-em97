/**
 * 校准记录：仪器送检 / 校准的有效期登记。
 *
 * 一台仪器可有多条校准记录（按校准日期倒序，最新一条决定当前有效期）。
 * 测点录入时把「当次校准有效期」固定进证据快照；校准记录事后更正只影响
 * 尚未签发（判定未确认）且引用了该仪器的测点——这些测点会退回待复测；
 * 已签发结果保留原依据不变，只标记需要补充。
 */

/** 校准状态（按有效期日期派生展示，不入库） */
export type CalibrationState = '有效' | '即将到期' | '已到期'

export interface Calibration {
  id: string
  /** 所属仪器 id */
  instrumentId: string
  /** 校准 / 送检机构 */
  agency: string
  /** 校准证书编号 */
  certificateNo: string
  /** 校准日期（YYYY-MM-DD） */
  calibrateDate: string
  /** 校准有效期至（YYYY-MM-DD）：测点证据快照固定保存此值 */
  validUntil: string
  /** 结论 / 备注 */
  conclusion: string
  /** 最近一次更正的说明（更正会联动未签发测点退回待复测） */
  correctionNote: string
  createdAt: number
  updatedAt: number
}

/** 校准记录录入/编辑草稿 */
export interface CalibrationDraft {
  agency: string
  certificateNo: string
  calibrateDate: string
  validUntil: string
  conclusion: string
}

export function createEmptyCalibrationDraft(): CalibrationDraft {
  return {
    agency: '',
    certificateNo: '',
    calibrateDate: new Date().toISOString().slice(0, 10),
    validUntil: '',
    conclusion: ''
  }
}

/** 取一组校准记录中最新的一条（按校准日期、id 兜底） */
export function latestCalibration(records: Calibration[]): Calibration | null {
  if (records.length === 0) return null
  return [...records].sort((a, b) => {
    if (a.calibrateDate !== b.calibrateDate) return a.calibrateDate < b.calibrateDate ? 1 : -1
    return b.updatedAt - a.updatedAt
  })[0]
}

/** 按有效期派生校准状态（即将到期窗口默认 30 天） */
export function calibrationState(validUntil: string, today = new Date().toISOString().slice(0, 10), warnDays = 30): CalibrationState {
  if (!validUntil) return '已到期'
  if (validUntil < today) return '已到期'
  const limit = new Date()
  limit.setDate(limit.getDate() + warnDays)
  if (validUntil <= limit.toISOString().slice(0, 10)) return '即将到期'
  return '有效'
}
