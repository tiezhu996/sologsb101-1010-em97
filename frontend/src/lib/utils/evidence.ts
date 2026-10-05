/**
 * 证据快照工具：组装 / 迁移 / 判定测点仪器证据。
 *
 * 纯函数叶子模块：只依赖 types，不 import 任何 store，避免循环依赖。
 * 仪器校准记录（台账侧，可变、可更正）与测点证据快照（测点侧，录入即冻结）
 * 的组装、旧数据补齐、退回待复测 / 需补充判定统一在此完成。
 */
import type { Point, PointEvidence, EvidenceStatus } from '$lib/types/point'
import type { Instrument } from '$lib/types/instrument'
import type { Calibration } from '$lib/types/calibration'
import { latestCalibration } from '$lib/types/calibration'

/** 旧版自由文本仪器名 → 仪器编号的映射表（旧数据升级使用） */
export const LEGACY_METER_CODES: Array<{ needle: string; code: string; name: string }> = [
  { needle: '20230517', code: 'No.20230517', name: 'ZC-8 接地电阻测试仪' },
  { needle: 'A221104', code: 'No.A221104', name: 'DER2571 数字接地电阻表' },
  { needle: '20201122', code: 'No.20201122', name: 'ZC-8 接地电阻测试仪' }
]

/** 从旧版 meter 文本解析仪器编号 / 名称（找不到编号返回 null → 归入待补证） */
export function parseLegacyMeter(meter: string | undefined | null): { meterId: string | null; meterName: string } {
  const text = (meter ?? '').trim()
  if (!text) return { meterId: null, meterName: '' }
  const hit = LEGACY_METER_CODES.find((item) => text.includes(item.needle))
  if (hit) return { meterId: hit.code, meterName: text }
  // 文本里自带 No.xxx 编号时直接提取
  const noMatch = text.match(/No\.[A-Za-z0-9-]+/i)
  if (noMatch) return { meterId: noMatch[0], meterName: text }
  return { meterId: null, meterName: text }
}

/** 组装「待补证」快照：旧数据缺仪器编号或外部导入数据依据不全时使用 */
export function buildIncompleteEvidence(input: { meterName?: string; meterId?: string | null; calibrationValidUntil?: string; certificateNo?: string; note?: string } = {}): PointEvidence {
  return {
    meterId: input.meterId ?? '',
    meterName: input.meterName ?? '',
    calibrationId: '',
    certificateNo: input.certificateNo ?? '',
    calibrationValidUntil: input.calibrationValidUntil ?? '',
    frozenAt: Date.now(),
    status: '待补证',
    note: input.note ?? '缺少仪器编号或校准有效期依据，需补证后复测'
  }
}

/** 组装已补证 / 正常录入的证据快照 */
export function buildEvidence(input: {
  meterId: string
  meterName: string
  calibrationId: string
  certificateNo: string
  calibrationValidUntil: string
  status?: EvidenceStatus
  note?: string
  flagKey?: string
  frozenAt?: number
}): PointEvidence {
  const complete = Boolean(input.meterId && input.calibrationValidUntil)
  return {
    meterId: input.meterId,
    meterName: input.meterName,
    calibrationId: input.calibrationId,
    certificateNo: input.certificateNo,
    calibrationValidUntil: input.calibrationValidUntil,
    frozenAt: input.frozenAt ?? Date.now(),
    status: input.status ?? (complete ? '有效' : '待补证'),
    note: input.note ?? (complete ? '' : '缺少仪器编号或校准有效期依据，需补证后复测'),
    flagKey: input.flagKey
  }
}

export interface EvidenceContext {
  instrument?: Instrument
  calibrations: Calibration[]
}

/**
 * 录入测点时冻结证据：
 * 仪器须在用，且最新校准记录的有效期覆盖检测日期，否则归入「待补证」。
 */
export function freezeEvidenceForPoint(input: {
  meterId: string
  measureDate: string
  instruments: Instrument[]
  calibrations: Calibration[]
}): PointEvidence {
  const instrument = input.instruments.find((item) => item.code === input.meterId && item.status === '在用')
  if (!instrument) {
    return buildIncompleteEvidence({ meterId: input.meterId, note: '仪器不存在或已注销，需补证后复测' })
  }
  const calibration = latestCalibration(input.calibrations.filter((item) => item.instrumentId === instrument.id))
  if (!calibration || !calibration.validUntil) {
    return buildIncompleteEvidence({
      meterId: instrument.code,
      meterName: `${instrument.name}${instrument.code ? ` / ${instrument.code}` : ''}`,
      note: '该仪器尚无校准有效期记录，需补证后复测'
    })
  }
  const covered = !input.measureDate || (calibration.calibrateDate <= input.measureDate && input.measureDate <= calibration.validUntil)
  const meterName = `${instrument.name} / ${instrument.code}`
  return buildEvidence({
    meterId: instrument.code,
    meterName,
    calibrationId: calibration.id,
    certificateNo: calibration.certificateNo,
    calibrationValidUntil: calibration.validUntil,
    status: covered ? '有效' : '待补证',
    note: covered ? '' : `检测日期 ${input.measureDate} 不在校准有效期（${calibration.calibrateDate} ~ ${calibration.validUntil}）内，需补证后复测`
  })
}

/**
 * 迁移 / 导入时规范化单条测点的证据快照。
 * - 已有完整快照：原样保留（快照不被悄悄改动），仅补齐缺省字段；
 * - 缺仪器编号或校准有效期：归入「待补证」。
 */
export function normalizePointEvidence(point: Partial<Point> & Record<string, unknown>): PointEvidence {
  const raw = point.evidence as Partial<PointEvidence> | undefined
  const measureDate = typeof point.measureDate === 'string' ? point.measureDate : ''
  if (raw && typeof raw === 'object') {
    const meterId = typeof raw.meterId === 'string' ? raw.meterId.trim() : ''
    const validUntil = typeof raw.calibrationValidUntil === 'string' ? raw.calibrationValidUntil : ''
    const status = (['有效', '待补证', '待复测', '需补充'] as EvidenceStatus[]).includes(raw.status as EvidenceStatus)
      ? (raw.status as EvidenceStatus)
      : meterId && validUntil
        ? '有效'
        : '待补证'
    return {
      meterId,
      meterName: typeof raw.meterName === 'string' ? raw.meterName : '',
      calibrationId: typeof raw.calibrationId === 'string' ? raw.calibrationId : '',
      certificateNo: typeof raw.certificateNo === 'string' ? raw.certificateNo : '',
      calibrationValidUntil: validUntil,
      frozenAt: typeof raw.frozenAt === 'number' ? raw.frozenAt : (typeof point.createdAt === 'number' ? point.createdAt : Date.now()),
      status,
      note:
        typeof raw.note === 'string'
          ? raw.note
          : meterId && validUntil
            ? ''
            : '缺少仪器编号或校准有效期依据，需补证后复测',
      flagKey: typeof raw.flagKey === 'string' ? raw.flagKey : undefined
    }
  }
  // 旧结构：从自由文本 meter 解析，解析不出编号即待补证
  const legacy = parseLegacyMeter(typeof point.meter === 'string' ? point.meter : '')
  const fallback = buildIncompleteEvidence({
    meterId: legacy.meterId,
    meterName: legacy.meterName,
    note: legacy.meterId
      ? '旧数据缺少当次校准有效期，需补证后复测'
      : '旧数据缺少仪器编号，归入待补证'
  })
  void measureDate
  return fallback
}

/** 已签发的结论是否处于「需补充」（依据有效但原证据后来被标记） */
export function needsSupplement(status: EvidenceStatus | undefined): boolean {
  return status === '需补充' || status === '待补证'
}
