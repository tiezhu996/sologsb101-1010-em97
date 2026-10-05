/** 测点证据状态 */
export const EVIDENCE_STATES = ['有效', '待复测', '待补证', '需补充'] as const
export type EvidenceState = (typeof EVIDENCE_STATES)[number]

/**
 * 测点证据快照：录入测点时把仪器编号与当次校准有效期固化下来，
 * 与仪器台账 / 校准记录分开保存——之后仪器送检、校准更正、仪器注销
 * 都不会悄悄改变本快照；结论签发后也不再跟随台账变化。
 */
export interface EvidenceSnapshot {
  /** 仪器 id（台账外键；为 null 表示未关联仪器，归入待补证） */
  meterId: string | null
  /** 快照：仪器编号 */
  meterCode: string
  /** 快照：仪器名称 */
  meterName: string
  /** 快照：当次校准记录 id */
  calibrationId: string | null
  /** 快照：当次校准有效期至（空串表示未登记） */
  calibrationValidUntil: string
  /** 证据状态：有效 / 待复测 / 待补证 / 需补充 */
  evidenceState: EvidenceState
  /** 失效来源：`校准记录id#更正序号`，写入失败重试时据此幂等，不重复失效 */
  evidenceInvalidatedBy: string | null
}

/** 测点：接地电阻实测点，逐个录入实测值与限值，并携带仪器证据快照 */
export interface Point extends EvidenceSnapshot {
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
  /** 检测日期 */
  measureDate: string
  createdAt: number
  updatedAt: number
}

/** 测点录入草稿（批量粘贴与单条新增共用） */
export interface PointDraft {
  code: string
  location: string
  measuredOhm: number
  limitOhm: number
  /** 选用的仪器 id（保存时固化为证据快照） */
  meterId: string | null
  measureDate: string
}

export function createEmptyPointDraft(limitOhm = 10, meterId: string | null = null, measureDate = ''): PointDraft {
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
