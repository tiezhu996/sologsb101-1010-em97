/**
 * 仪器台账：检测仪器（接地电阻测试仪等）的登记信息。
 *
 * 与「测点证据快照」分离：仪器名称/编号/状态可变，但测点录入时会把当次
 * 使用的仪器编号与校准有效期固定进 Point.evidence，之后不再随本台账变化。
 */

/** 仪器状态：在用 / 注销（注销后不得再录入新测点，历史快照原样保留） */
export type InstrumentStatus = '在用' | '注销'

export const INSTRUMENT_STATUSES: InstrumentStatus[] = ['在用', '注销']

export interface Instrument {
  id: string
  /** 仪器编号（台账唯一，如 No.20230517），测点快照固定引用此值 */
  code: string
  /** 仪器名称与型号，如 ZC-8 接地电阻测试仪 */
  name: string
  /** 规格 / 量程说明 */
  spec: string
  /** 生产厂家 */
  manufacturer: string
  /** 状态：在用 / 注销 */
  status: InstrumentStatus
  /** 注销时间（未注销为 null）；注销不改动任何已存在的测点快照 */
  retiredAt: string | null
  /** 备注 */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 仪器录入/编辑草稿 */
export interface InstrumentDraft {
  code: string
  name: string
  spec: string
  manufacturer: string
  remark: string
}

export function createEmptyInstrumentDraft(): InstrumentDraft {
  return { code: '', name: '', spec: '', manufacturer: '', remark: '' }
}
