/**
 * 测点：接地电阻实测点，逐个录入实测值与限值。
 *
 * 仪器信息以「证据快照」（evidence）形式固定在测点上：录入时写入仪器编号与
 * 当次校准有效期，之后仪器台账更名、校准记录更正、仪器注销都不会回改快照；
 * 已签发结论以判定记录内的签发快照为准（见 verdict.ts 的 issuedSnapshot）。
 */

/** 证据状态：有效 / 待补证（缺仪器编号或校准依据）/ 待复测 / 需补充（已签发但原依据被动过） */
export type EvidenceStatus = '有效' | '待补证' | '待复测' | '需补充'

export const EVIDENCE_STATUSES: EvidenceStatus[] = ['有效', '待补证', '待复测', '需补充']

/** 测点证据快照：录入当次固定，事后不随仪器台账变化 */
export interface PointEvidence {
  /** 仪器编号（固定引用仪器台账的业务编号，而非行 id） */
  meterId: string
  /** 仪器名称与型号（冗余快照，台账更名不影响此处） */
  meterName: string
  /** 当次校准记录行 id（旧数据可能为空字符串） */
  calibrationId: string
  /** 校准证书编号快照 */
  certificateNo: string
  /** 当次校准有效期至（YYYY-MM-DD），录入时固定 */
  calibrationValidUntil: string
  /** 快照固定时间戳 */
  frozenAt: number
  /** 证据状态 */
  status: EvidenceStatus
  /** 状态说明（退回待复测 / 需补充的原因） */
  note: string
  /** 最近一次联动标记的幂等键（校准更正重试不会重复失效） */
  flagKey?: string
}

export interface Point {
  id: string
  /** 所属防雷装置 */
  deviceId: string
  /** 测点编号，如 JD-01 */
  code: string
  /** 测点位置描述 */
  location: string
  /** 实测接地电阻（Ω） */
  measuredOhm: number
  /** 限值（Ω），按防雷类别与装置类型给出初始值 */
  limitOhm: number
  /** 仪器证据快照：仪器编号 + 当次校准有效期，录入后固定 */
  evidence: PointEvidence
  /**
   * @deprecated v3 之前的自由文本仪器名，仅为兼容旧备份保留，
   * 新数据一律使用 evidence.meterName。
   */
  meter?: string
  /** 检测日期 */
  measureDate: string
  createdAt: number
  updatedAt: number
}

/** 测点录入草稿（批量粘贴与单条新增共用）：仪器选择仪器编号，快照由 store 冻结 */
export interface PointDraft {
  code: string
  location: string
  measuredOhm: number
  limitOhm: number
  /** 选中的仪器编号（Instrument.code），须为在用且校准有效期覆盖检测日期 */
  meterId: string
  measureDate: string
}

export function createEmptyPointDraft(limitOhm = 10, meterId = '', measureDate = ''): PointDraft {
  return {
    code: '',
    location: '',
    measuredOhm: 0,
    limitOhm,
    meterId,
    measureDate: measureDate || new Date().toISOString().slice(0, 10)
  }
}

/** 批量粘贴解析出的一行测点草稿 */
export interface PointPasteRow {
  code: string
  location: string
  measuredOhm: number
  limitOhm: number
}

/**
 * 解析批量粘贴文本：每行「测点编号,位置,实测电阻[,限值]」。
 * 逗号 / 制表符 / 分号均可作分隔，纯空格不定界（位置描述常含空格）。
 */
export function parsePointPaste(text: string, defaultLimitOhm = 10): { rows: PointPasteRow[]; errors: string[] } {
  const rows: PointPasteRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 3) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「测点编号,位置,实测电阻」三列`)
      return
    }
    const measuredOhm = Number(cells[2])
    if (!Number.isFinite(measuredOhm) || measuredOhm < 0) {
      errors.push(`第 ${index + 1} 行实测电阻应为非负数字`)
      return
    }
    const limitOhm = cells.length >= 4 ? Number(cells[3]) : defaultLimitOhm
    if (!Number.isFinite(limitOhm) || limitOhm <= 0) {
      errors.push(`第 ${index + 1} 行限值应为大于 0 的数字`)
      return
    }
    rows.push({
      code: cells[0],
      location: cells[1],
      measuredOhm: Number(measuredOhm.toFixed(3)),
      limitOhm: Number(limitOhm.toFixed(3))
    })
  })
  return { rows, errors }
}
