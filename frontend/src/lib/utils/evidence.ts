/**
 * 测点证据快照规则（纯函数，叶子模块）。
 * store 写入、Dexie 升级迁移、JSON 导入规范化三处共用同一套规则，
 * 保证「录入时固定仪器编号与当次校准有效期」在任何入口行为一致。
 */
import type { Calibration, Meter } from '$lib/types/meter'
import { latestCalibrationOf, parseLegacyMeterText } from '$lib/types/meter'
import type { EvidenceSnapshot, Point } from '$lib/types/point'

/** 空快照：未关联仪器（或仪器缺校准记录）时归入待补证 */
export function emptyEvidenceSnapshot(): EvidenceSnapshot {
  return {
    meterId: null,
    meterCode: '',
    meterName: '',
    calibrationId: null,
    calibrationValidUntil: '',
    evidenceState: '待补证',
    evidenceInvalidatedBy: null
  }
}

/**
 * 由仪器台账与校准记录构建测点证据快照。
 * - 仪器不存在或未选择 → 待补证
 * - 仪器无任何校准记录 → 待补证（保留仪器名与编号，便于事后补证）
 * - 正常 → 有效，并固化当次校准记录 id 与有效期
 */
export function buildEvidenceSnapshot(
  meterId: string | null,
  meters: Meter[],
  calibrations: Calibration[]
): EvidenceSnapshot {
  if (!meterId) return emptyEvidenceSnapshot()
  const meter = meters.find((item) => item.id === meterId) ?? null
  if (!meter) return emptyEvidenceSnapshot()
  const calibration = latestCalibrationOf(calibrations, meter.id)
  if (!calibration) {
    return {
      ...emptyEvidenceSnapshot(),
      meterId: meter.id,
      meterCode: meter.code,
      meterName: meter.name
    }
  }
  return {
    meterId: meter.id,
    meterCode: meter.code,
    meterName: meter.name,
    calibrationId: calibration.id,
    calibrationValidUntil: calibration.validUntil,
    evidenceState: '有效',
    evidenceInvalidatedBy: null
  }
}

/**
 * 旧数据证据解析：从「仪器名称 / 编号」自由文本重建仪器台账与校准占位记录。
 * 供 Dexie v3 升级迁移与旧版 JSON 导入共用：
 * - 能解析出编号 → 按编号建 / 复用仪器，并建一条「历史数据迁移」校准占位记录，证据有效
 * - 缺少仪器编号 → 空快照，归入待补证
 *
 * @param existing 已存在的仪器 / 校准记录（导入场景下去重，避免重复建台）
 * @returns 新建（而非复用）的仪器与校准记录，以及逐测点的快照
 */
export function resolveLegacyEvidence(
  rows: Array<{ id: string; meter: string }>,
  now: number,
  existing: { meters?: Meter[]; calibrations?: Calibration[] } = {}
): { meters: Meter[]; calibrations: Calibration[]; snapshots: Map<string, EvidenceSnapshot> } {
  const meters: Meter[] = []
  const calibrations: Calibration[] = []
  const snapshots = new Map<string, EvidenceSnapshot>()
  const meterByCode = new Map<string, Meter>((existing.meters ?? []).map((meter) => [meter.code, meter]))
  const calibrationByMeter = new Map<string, Calibration>()
  ;(existing.calibrations ?? []).forEach((calibration) => {
    if (!calibrationByMeter.has(calibration.meterId)) calibrationByMeter.set(calibration.meterId, calibration)
  })

  rows.forEach((row, index) => {
    const parsed = parseLegacyMeterText(row.meter)
    if (!parsed) {
      snapshots.set(row.id, emptyEvidenceSnapshot())
      return
    }
    let meter = meterByCode.get(parsed.code)
    if (!meter) {
      meter = {
        id: `mtr_legacy_${now.toString(36)}_${index}${Math.random().toString(36).slice(2, 6)}`,
        code: parsed.code,
        name: parsed.name,
        state: '在用',
        createdAt: now + index,
        updatedAt: now + index
      }
      meterByCode.set(parsed.code, meter)
      meters.push(meter)
    }
    let calibration = calibrationByMeter.get(meter.id)
    if (!calibration) {
      calibration = {
        id: `cal_legacy_${now.toString(36)}_${index}${Math.random().toString(36).slice(2, 6)}`,
        meterId: meter.id,
        certificateNo: '历史数据迁移',
        calibratedAt: '',
        validUntil: '',
        revision: 0,
        createdAt: now + index,
        updatedAt: now + index
      }
      calibrationByMeter.set(meter.id, calibration)
      calibrations.push(calibration)
    }
    snapshots.set(row.id, {
      meterId: meter.id,
      meterCode: meter.code,
      meterName: meter.name,
      calibrationId: calibration.id,
      calibrationValidUntil: calibration.validUntil,
      evidenceState: '有效',
      evidenceInvalidatedBy: null
    })
  })
  return { meters, calibrations, snapshots }
}

/** 证据快照的展示文本：仪器名称 / 编号 · 有效期至 YYYY-MM-DD */
export function formatEvidence(
  point: Pick<Point, 'meterName' | 'meterCode' | 'calibrationValidUntil'>
): string {
  const meterText = point.meterCode ? `${point.meterName} / ${point.meterCode}` : point.meterName || '未关联仪器'
  return point.calibrationValidUntil ? `${meterText} · 有效期至 ${point.calibrationValidUntil}` : meterText
}
