/**
 * 仪器 store：仪器台账 + 校准记录 + 证据联动规则。
 *
 * 两侧分离保存：
 *   - 台账侧（instruments / calibrations）：仪器名称可改、校准记录可更正、仪器可注销；
 *   - 证据侧（Point.evidence / Verdict.issuedSnapshot）：测点录入与结论签发时冻结，
 *     不随台账侧任何改动而悄悄变化。
 *
 * 校准记录更正的联动：
 *   - 尚未签发（判定未确认）且引用该校准记录的测点 → 退回「待复测」，判定作废；
 *   - 已签发测点 → 保留原依据（issuedSnapshot 不动），证据状态标「需补充」；
 *   - 已退回/已标记的测点不重复失效（flagKey 幂等），写入失败重试也不会二次失效。
 *
 * 依赖方向：instrumentStore → utils/db、types/*、utils/evidence、buildingStore；
 * 不反向 import pointStore / rectifyStore（那会形成循环依赖），联动直接读写 db。
 */
import { derived, get, writable } from 'svelte/store'
import { db, watchTable } from '$lib/utils/db'
import type { Instrument, InstrumentDraft, InstrumentStatus } from '$lib/types/instrument'
import type { Calibration, CalibrationDraft } from '$lib/types/calibration'
import { calibrationState, latestCalibration } from '$lib/types/calibration'
import type { EvidenceStatus, Point, PointEvidence } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import { buildEvidence, freezeEvidenceForPoint } from '$lib/utils/evidence'

/** 响应式仪器 / 校准集合 */
export const instrumentList = writable<Instrument[]>([])
export const calibrationList = writable<Calibration[]>([])
export const instrumentReady = writable(false)

watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
  instrumentList.set(rows)
  instrumentReady.set(true)
})
watchTable<Calibration>(() => db.calibrations).subscribe((rows) => {
  calibrationList.set(rows)
})

/** 按仪器取校准记录（校准日期倒序） */
export function calibrationsOfInstrument(instrumentId: string | null | undefined): Calibration[] {
  if (!instrumentId) return []
  return get(calibrationList)
    .filter((item) => item.instrumentId === instrumentId)
    .sort((a, b) => (a.calibrateDate < b.calibrateDate ? 1 : -1))
}

/** 仪器行：附带最新校准记录与派生状态，供台账页表格展示 */
export interface InstrumentRow {
  instrument: Instrument
  latest: Calibration | null
  calState: ReturnType<typeof calibrationState>
  calibrationCount: number
  calibrations: Calibration[]
}

export const instrumentRows = derived([instrumentList, calibrationList], ([$instruments, $calibrations]) =>
  $instruments
    .map((instrument) => {
      const records = $calibrations
        .filter((item) => item.instrumentId === instrument.id)
        .sort((a, b) => (a.calibrateDate < b.calibrateDate ? 1 : -1))
      const latest = latestCalibration(records)
      return {
        instrument,
        latest,
        calState: latest ? calibrationState(latest.validUntil) : '已到期',
        calibrationCount: records.length,
        calibrations: records
      } satisfies InstrumentRow
    })
    .sort((a, b) => a.instrument.code.localeCompare(b.instrument.code, 'zh-Hans-CN'))
)

/** 录入测点可选仪器：在用且最新校准有效的仪器 */
export function meterOptionsForMeasureDate(
  measureDate: string,
  now = new Date().toISOString().slice(0, 10)
): Array<{ value: string; label: string; validUntil: string; disabled: boolean; reason: string }> {
  const instruments = get(instrumentList)
  const calibrations = get(calibrationList)
  return instruments
    .map((instrument) => {
      const records = calibrations.filter((item) => item.instrumentId === instrument.id)
      const latest = latestCalibration(records)
      const label = `${instrument.name} / ${instrument.code}${latest ? `（校准至 ${latest.validUntil}）` : '（无校准记录）'}`
      if (instrument.status === '注销') {
        return { value: instrument.code, label, validUntil: latest?.validUntil ?? '', disabled: true, reason: '仪器已注销' }
      }
      if (!latest || !latest.validUntil) {
        return { value: instrument.code, label, validUntil: '', disabled: true, reason: '无校准有效期记录' }
      }
      const expired = latest.validUntil < now
      const outOfWindow = measureDate && (measureDate < latest.calibrateDate || measureDate > latest.validUntil)
      if (expired) return { value: instrument.code, label, validUntil: latest.validUntil, disabled: true, reason: '校准已到期' }
      if (outOfWindow) return { value: instrument.code, label, validUntil: latest.validUntil, disabled: true, reason: '检测日期不在校准有效期内' }
      return { value: instrument.code, label, validUntil: latest.validUntil, disabled: false, reason: '' }
    })
    .sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.label.localeCompare(b.label, 'zh-Hans-CN'))
}

/**
 * 生成校准更正联动的幂等键：同一校准记录更正到同一有效期只失效一次。
 * 键由「校准记录 id + 新校准日期 + 新有效期」确定性派生，
 * 写入失败后调用方用相同参数重试时，已标记测点命中同键直接跳过，不重复失效；
 * 之后再次更正到不同日期会得到新键，按新的一次更正处理。
 */
function buildFlagKey(calibrationId: string, calibrateDate: string, validUntil: string): string {
  return `calfix:${calibrationId}:${calibrateDate || 'na'}:${validUntil || 'na'}`
}

/* ------------------------------ 仪器台账 ------------------------------ */

export async function createInstrument(payload: InstrumentDraft): Promise<Instrument> {
  const code = payload.code.trim()
  const duplicate = get(instrumentList).some((item) => item.code === code)
  if (duplicate) throw new Error(`仪器编号「${code}」已存在，请使用唯一编号`)
  const now = Date.now()
  const row: Instrument = {
    ...payload,
    code,
    name: payload.name.trim(),
    spec: payload.spec.trim(),
    manufacturer: payload.manufacturer.trim(),
    remark: payload.remark.trim(),
    status: '在用',
    retiredAt: null,
    id: `mtr_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now
  }
  await db.instruments.put(row)
  return row
}

/**
 * 更正仪器台账（名称/规格等）。
 * 只改台账行，绝不回改任何测点证据快照与已签发依据。
 */
export async function updateInstrument(id: string, patch: Partial<InstrumentDraft>): Promise<void> {
  const next: Partial<Instrument> = { updatedAt: Date.now() }
  if (patch.name !== undefined) next.name = patch.name.trim()
  if (patch.spec !== undefined) next.spec = patch.spec.trim()
  if (patch.manufacturer !== undefined) next.manufacturer = patch.manufacturer.trim()
  if (patch.remark !== undefined) next.remark = patch.remark.trim()
  // 编号是快照引用键：台账编号不允许直接改，避免历史快照找不到来源；
  // 确需更正编号应注销后重新登记仪器。
  await db.instruments.update(id, next as never)
}

/**
 * 注销 / 恢复仪器。注销不删除任何数据，也不改动测点快照：
 * 已签发结果保留原依据，未签发测点不会被悄悄失效，仅无法再选它录入新测点。
 */
export async function setInstrumentStatus(id: string, status: InstrumentStatus): Promise<void> {
  await db.instruments.update(id, {
    status,
    retiredAt: status === '注销' ? new Date().toISOString().slice(0, 10) : null,
    updatedAt: Date.now()
  } as never)
}

/* ------------------------------ 校准记录 ------------------------------ */

export async function createCalibration(instrumentId: string, payload: CalibrationDraft): Promise<Calibration> {
  const now = Date.now()
  const row: Calibration = {
    ...payload,
    instrumentId,
    agency: payload.agency.trim(),
    certificateNo: payload.certificateNo.trim(),
    conclusion: payload.conclusion.trim(),
    correctionNote: '',
    id: `cal_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now
  }
  await db.calibrations.put(row)
  return row
}

export interface CalibrationCorrectionResult {
  /** 退回待复测（未签发）测点数 */
  retested: number
  /** 已签发、保留原依据并标记需补充的测点数 */
  supplement: number
}

/**
 * 更正校准记录并联动受影响测点。
 *
 * 仅当「校准日期 / 有效期至」被更正、导致原快照依据发生变化时才联动；
 * 只改机构/证书号/结论文字不触发测点失效。
 *
 * 联动在单事务内完成：
 *   - 未签发测点（无判定或判定未确认）→ 证据退回「待复测」并作废判定；
 *   - 已签发测点 → issuedSnapshot 原样保留，证据标「需补充」；
 *   - flagKey 幂等：已经被本次更正标记过的测点跳过，调用方重试不会重复失效。
 */
export async function correctCalibration(
  id: string,
  patch: Partial<CalibrationDraft>,
  reason = ''
): Promise<CalibrationCorrectionResult> {
  const before = await db.calibrations.get(id)
  if (!before) throw new Error('校准记录不存在或已被删除')

  const nextAgency = patch.agency !== undefined ? patch.agency.trim() : before.agency
  const nextCert = patch.certificateNo !== undefined ? patch.certificateNo.trim() : before.certificateNo
  const nextConclusion = patch.conclusion !== undefined ? patch.conclusion.trim() : before.conclusion
  const nextCalibrateDate = patch.calibrateDate ?? before.calibrateDate
  const nextValidUntil = patch.validUntil ?? before.validUntil

  const windowChanged = nextCalibrateDate !== before.calibrateDate || nextValidUntil !== before.validUntil

  const flagKey = buildFlagKey(id, nextCalibrateDate, nextValidUntil)
  const note =
    reason.trim() ||
    `校准记录已更正（有效期 ${before.validUntil || '—'} → ${nextValidUntil || '—'}），${windowChanged ? '原依据失效，需重新复测' : '请核对证书信息'}`

  let retested = 0
  let supplement = 0

  await db.transaction('rw', [db.calibrations, db.points, db.verdicts], async () => {
    await db.calibrations.put({
      ...before,
      agency: nextAgency,
      certificateNo: nextCert,
      conclusion: nextConclusion,
      calibrateDate: nextCalibrateDate,
      validUntil: nextValidUntil,
      correctionNote: windowChanged ? note : before.correctionNote,
      updatedAt: Date.now()
    })

    if (!windowChanged) return

    // 引用该校准记录的测点（同时兼容旧数据按仪器编号引用、calibrationId 为空的情况：
    // 只处理快照里明确固定了本校准记录 id 的测点，避免误伤）
    const affected = await db.points.filter((item) => item.evidence?.calibrationId === id).toArray()
    const verdicts = await db.verdicts.where('pointId').anyOf(affected.map((point) => point.id)).toArray()
    const verdictByPoint = new Map(verdicts.map((verdict) => [verdict.pointId, verdict]))

    const affectedPointIds: string[] = []
    const supplementPointIds: string[] = []

    for (const point of affected) {
      const verdict = verdictByPoint.get(point.id)
      const issued = Boolean(verdict?.confirmed)
      // 幂等：同一次更正重试时，已带本次 flagKey 的测点不再重复失效
      if (point.evidence.flagKey === flagKey) continue
      if (issued) supplementPointIds.push(point.id)
      else affectedPointIds.push(point.id)
    }

    if (affectedPointIds.length > 0) {
      await db.points
        .where('id')
        .anyOf(affectedPointIds)
        .modify((point: Point) => {
          point.evidence = {
            ...point.evidence,
            status: '待复测' as EvidenceStatus,
            note,
            flagKey
          }
          point.updatedAt = Date.now()
        })
      // 未签发判定随退回一并作废（已签发的判定不动）
      await db.verdicts
        .where('pointId')
        .anyOf(affectedPointIds)
        .filter((verdict) => !verdict.confirmed)
        .delete()
      retested = affectedPointIds.length
    }

    if (supplementPointIds.length > 0) {
      await db.points
        .where('id')
        .anyOf(supplementPointIds)
        .modify((point: Point) => {
          point.evidence = {
            ...point.evidence,
            status: '需补充' as EvidenceStatus,
            note,
            flagKey
          }
          point.updatedAt = Date.now()
        })
      supplement = supplementPointIds.length
    }
  })

  return { retested, supplement }
}

export async function removeCalibration(id: string): Promise<CalibrationCorrectionResult> {
  const before = await db.calibrations.get(id)
  if (!before) return { retested: 0, supplement: 0 }
  const flagKey = buildFlagKey(id, 'deleted', 'deleted')
  const note = `校准证书 ${before.certificateNo || id} 已被撤销，原依据失效，需重新复测`
  let retested = 0
  let supplement = 0
  await db.transaction('rw', [db.calibrations, db.points, db.verdicts], async () => {
    const affected = await db.points.filter((item) => item.evidence?.calibrationId === id).toArray()
    const verdicts = await db.verdicts.where('pointId').anyOf(affected.map((point) => point.id)).toArray()
    const verdictByPoint = new Map(verdicts.map((verdict) => [verdict.pointId, verdict]))
    const affectedPointIds: string[] = []
    const supplementPointIds: string[] = []
    for (const point of affected) {
      if (point.evidence.flagKey === flagKey) continue
      if (verdictByPoint.get(point.id)?.confirmed) supplementPointIds.push(point.id)
      else affectedPointIds.push(point.id)
    }
    if (affectedPointIds.length > 0) {
      await db.points.where('id').anyOf(affectedPointIds).modify((point: Point) => {
        point.evidence = { ...point.evidence, status: '待复测' as EvidenceStatus, note, flagKey }
        point.updatedAt = Date.now()
      })
      await db.verdicts
        .where('pointId')
        .anyOf(affectedPointIds)
        .filter((verdict) => !verdict.confirmed)
        .delete()
      retested = affectedPointIds.length
    }
    if (supplementPointIds.length > 0) {
      await db.points.where('id').anyOf(supplementPointIds).modify((point: Point) => {
        point.evidence = { ...point.evidence, status: '需补充' as EvidenceStatus, note, flagKey }
        point.updatedAt = Date.now()
      })
      supplement = supplementPointIds.length
    }
    await db.calibrations.delete(id)
  })
  return { retested, supplement }
}

/* ------------------------------ 复测与补证 ------------------------------ */

/**
 * 退回待复测：测点改值 / 更换仪器 / 手工退回共用入口。
 * - 已签发测点：保留原判定行但恢复为未签发「待判定」，issuedSnapshot 保留原依据，
 *   页面上仍可查看签发时依据，直到重新复测签发覆盖；
 * - 未签发测点：判定作废；
 * - 证据按新选择的仪器重新冻结；未选仪器则保持「待复测」。
 */
export async function retestPoint(
  point: Point,
  options: { meterId?: string; measureDate?: string; note?: string } = {}
): Promise<PointEvidence> {
  const meterId = options.meterId ?? ''
  const measureDate = options.measureDate ?? point.measureDate
  const instruments = get(instrumentList)
  const calibrations = get(calibrationList)
  const evidence: PointEvidence = meterId
    ? freezeEvidenceForPoint({ meterId, measureDate, instruments, calibrations })
    : buildEvidence({
        meterId: '',
        meterName: '',
        calibrationId: '',
        certificateNo: '',
        calibrationValidUntil: '',
        status: '待复测',
        note: options.note ?? '测点已退回待复测：请重新测量并选择有效仪器后签发'
      })

  await db.transaction('rw', [db.points, db.verdicts], async () => {
    await db.points.update(point.id, {
      measureDate,
      evidence,
      updatedAt: Date.now()
    } as never)
    const existing = await db.verdicts.where('pointId').equals(point.id).first()
    if (existing) {
      if (existing.confirmed) {
        // 已签发：结论恢复待判定、未签发；原依据快照保留备查（不删除、不改写）
        await db.verdicts.put({
          ...existing,
          result: '待判定',
          confirmed: false,
          inspector: existing.inspector,
          updatedAt: Date.now()
        })
      } else {
        await db.verdicts.delete(existing.id)
      }
    }
  })
  return evidence
}

/** 仅在证据状态为「需补充 / 待补证」且重新复测后，由签发动作清除待补充标记 */
export function isEvidenceUsable(evidence: PointEvidence): boolean {
  return evidence.status === '有效'
}

/** 校验某判定行是否允许签发：证据须为「有效」 */
export function verdictIssuable(verdict: Verdict | null, evidence: PointEvidence): { ok: boolean; reason: string } {
  void verdict
  if (evidence.status === '待补证') return { ok: false, reason: '证据待补证：缺少有效仪器编号或校准依据' }
  if (evidence.status === '待复测') return { ok: false, reason: '测点已退回待复测，请重新测量后再签发' }
  if (evidence.status === '需补充') return { ok: false, reason: '原校准依据已变更，请复测补证后再签发' }
  return { ok: true, reason: '' }
}

export { calibrationState, latestCalibration }
