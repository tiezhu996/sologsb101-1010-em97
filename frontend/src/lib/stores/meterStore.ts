/**
 * 仪器 store：维护仪器台账与校准记录，并承担「校准更正 → 测点证据失效」的联动。
 *
 * 核心约束：
 * - 仪器校准记录与测点证据快照分开保存；台账 / 校准的任何变更都不会回写测点快照。
 * - 校准记录更正后：尚未签发的受影响测点退回待复测；已签发结论保留原依据、标记需补充。
 * - 失效写入在单个事务内完成，且以 `校准记录id#更正序号` 为幂等键——
 *   写入失败整体回滚，重试不会把同一批测点重复失效。
 *
 * 依赖方向（单向）：meterStore → utils/db、types/*、utils/evidence，不 import 其他 store。
 */
import { derived, get, writable } from 'svelte/store'
import { createId, db, watchTable } from '$lib/utils/db'
import type { Calibration, Meter } from '$lib/types/meter'
import { latestCalibrationOf } from '$lib/types/meter'

/** 响应式仪器台账与校准记录 */
export const meterList = writable<Meter[]>([])
export const calibrationList = writable<Calibration[]>([])
export const meterReady = writable(false)

watchTable<Meter>(() => db.meters).subscribe((rows) => {
  meterList.set(rows)
  meterReady.set(true)
})
watchTable<Calibration>(() => db.calibrations).subscribe((rows) => {
  calibrationList.set(rows)
})

/** 在用仪器（新测点只能选用在用仪器；注销仪器的历史快照不受影响） */
export const activeMeters = derived(meterList, ($meters) => $meters.filter((meter) => meter.state === '在用'))

export function meterById(id: string | null | undefined): Meter | null {
  if (!id) return null
  return get(meterList).find((meter) => meter.id === id) ?? null
}

/** 仪器当前最新校准记录 */
export function latestCalibrationOfMeter(meterId: string | null | undefined): Calibration | null {
  return latestCalibrationOf(get(calibrationList), meterId)
}

/* ------------------------------ 仪器台账 ------------------------------ */

export async function createMeter(payload: { code: string; name: string }): Promise<Meter> {
  const code = payload.code.trim()
  const name = payload.name.trim()
  if (!code) throw new Error('请填写仪器编号')
  if (!name) throw new Error('请填写仪器名称')
  const duplicated = get(meterList).some((meter) => meter.code === code)
  if (duplicated) throw new Error(`仪器编号 ${code} 已存在，编号全局唯一`)
  const now = Date.now()
  const row: Meter = { id: createId('mtr'), code, name, state: '在用', createdAt: now, updatedAt: now }
  await db.meters.put(row)
  return row
}

/**
 * 注销仪器：只改台账状态，不触碰任何测点证据快照——
 * 历史测点仍显示录入时固定的仪器编号与当次校准有效期。
 */
export async function cancelMeter(id: string): Promise<void> {
  const meter = meterById(id)
  if (!meter) throw new Error('仪器不存在')
  if (meter.state === '注销') return
  await db.meters.update(id, { state: '注销', updatedAt: Date.now() } as never)
}

/* ------------------------------ 校准记录 ------------------------------ */

export async function addCalibration(
  meterId: string,
  payload: { certificateNo: string; calibratedAt: string; validUntil: string }
): Promise<Calibration> {
  const meter = meterById(meterId)
  if (!meter) throw new Error('仪器不存在')
  if (meter.state === '注销') throw new Error('仪器已注销，不能再登记校准')
  if (!payload.validUntil) throw new Error('请填写校准有效期')
  const now = Date.now()
  const row: Calibration = {
    id: createId('cal'),
    meterId,
    certificateNo: payload.certificateNo.trim(),
    calibratedAt: payload.calibratedAt,
    validUntil: payload.validUntil,
    revision: 0,
    createdAt: now,
    updatedAt: now
  }
  await db.calibrations.put(row)
  return row
}

export interface CorrectCalibrationResult {
  /** 退回待复测的未签发测点数 */
  retest: number
  /** 标记需补充的已签发结论数 */
  supplement: number
  /** 本次更正后的序号 */
  revision: number
}

/**
 * 更正校准记录（证书编号 / 校准日期 / 有效期），并联动失效受影响测点：
 * - 未签发测点：证据退回「待复测」，未确认判定一并作废回「待判定」
 * - 已签发结论：保留原依据与快照，测点标记「需补充」、判定 needsSupplement = true
 *
 * 幂等保证：整个操作在单个 Dexie 事务内完成，失败整体回滚；
 * 每个测点记录失效来源 `校准记录id#revision`，同一更正重试时已被处理的测点直接跳过，
 * 不会因重试而重复失效。
 */
export async function correctCalibration(
  id: string,
  patch: { certificateNo?: string; calibratedAt?: string; validUntil?: string }
): Promise<CorrectCalibrationResult> {
  return db.transaction('rw', [db.calibrations, db.points, db.verdicts], async () => {
    const calibration = await db.calibrations.get(id)
    if (!calibration) throw new Error('校准记录不存在')
    const now = Date.now()
    const revision = (calibration.revision ?? 0) + 1
    const invalidationKey = `${id}#${revision}`
    await db.calibrations.update(id, {
      certificateNo: patch.certificateNo ?? calibration.certificateNo,
      calibratedAt: patch.calibratedAt ?? calibration.calibratedAt,
      validUntil: patch.validUntil ?? calibration.validUntil,
      revision,
      updatedAt: now
    } as never)

    const result: CorrectCalibrationResult = { retest: 0, supplement: 0, revision }
    const affected = await db.points.where('calibrationId').equals(id).toArray()
    for (const point of affected) {
      // 幂等守卫：本次更正已处理过的测点跳过（重试不重复失效）
      if (point.evidenceInvalidatedBy === invalidationKey) continue
      const verdict = await db.verdicts.where('pointId').equals(point.id).first()
      if (verdict?.confirmed) {
        // 已签发：结论与依据保持原样，仅标记需补充
        await db.points.update(point.id, {
          evidenceState: '需补充',
          evidenceInvalidatedBy: invalidationKey,
          updatedAt: now
        } as never)
        await db.verdicts.update(verdict.id, { needsSupplement: true, updatedAt: now } as never)
        result.supplement += 1
      } else {
        // 未签发：退回待复测，未确认判定作废
        await db.points.update(point.id, {
          evidenceState: '待复测',
          evidenceInvalidatedBy: invalidationKey,
          updatedAt: now
        } as never)
        if (verdict && (verdict.result !== '待判定' || verdict.confirmed)) {
          await db.verdicts.update(verdict.id, { result: '待判定', confirmed: false, updatedAt: now } as never)
        }
        result.retest += 1
      }
    }
    return result
  })
}
