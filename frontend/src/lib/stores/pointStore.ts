/**
 * 测点 store：维护测点集合、接地电阻录入草稿与装置筛选。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅。
 *
 * 依赖方向（单向）：pointStore → utils/db、types/*、utils/resistance、buildingStore、instrumentStore。
 * 装置维度的测点统计（同时依赖两个 store）已下沉到 stores/pointStats.ts，避免循环依赖。
 *
 * 证据规则：
 *   - 新增测点时按所选仪器编号冻结证据快照（仪器编号 + 当次校准有效期）；
 *   - 修改实测值/限值不会回改证据快照；若该测点已签发，改值即退回待复测，
 *     已签发结论的原依据保留在 verdict.issuedSnapshot 中供查看与补充；
 *   - 仪器注销 / 校准记录更正由 instrumentStore 联动处理，本模块只负责测点侧读写。
 */
import { derived, get, writable } from 'svelte/store'
import { db, watchTable } from '$lib/utils/db'
import type { Point, PointDraft, PointEvidence } from '$lib/types/point'
import { createEmptyPointDraft } from '$lib/types/point'
import { deviceList } from '$lib/stores/buildingStore'
import { calibrationList, instrumentList } from '$lib/stores/instrumentStore'
import { freezeEvidenceForPoint } from '$lib/utils/evidence'
import { isQualified, limitRatio } from '$lib/utils/resistance'

/** 响应式测点集合 */
export const pointList = writable<Point[]>([])
export const pointReady = writable(false)

/** 电阻录入草稿（跨页面保留）与批量粘贴文本 */
export const pointDraft = writable<PointDraft>(createEmptyPointDraft())
export const pasteText = writable<string>('')
/** 装置筛选：当前查看的装置 id（null 表示全部） */
export const activeDeviceId = writable<string | null>(null)

watchTable<Point>(() => db.points).subscribe((rows) => {
  pointList.set(rows)
  pointReady.set(true)
})

/** 按装置取测点（按测点编号排序） */
export function pointsOfDevice(deviceId: string | null | undefined): Point[] {
  if (!deviceId) return []
  return get(pointList)
    .filter((point) => point.deviceId === deviceId)
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

/** 当前装置筛选下的测点 */
export const activePoints = derived([pointList, activeDeviceId], ([$points, $deviceId]) => {
  if ($deviceId === null) return [...$points].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  return $points
    .filter((point) => point.deviceId === $deviceId)
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
})

/** 测点行：附带装置类型、合格标记与证据状态，供测点录入页表格展示 */
export const pointRows = derived([pointList, deviceList], ([$points, $devices]) =>
  $points
    .map((point) => {
      const device = $devices.find((item) => item.id === point.deviceId)
      return {
        point,
        device,
        deviceType: device?.type ?? '未知装置',
        qualified: isQualified(point.measuredOhm, point.limitOhm),
        ratio: limitRatio(point.measuredOhm, point.limitOhm),
        evidenceStatus: point.evidence?.status ?? '待补证'
      }
    })
    .sort((a, b) => b.ratio - a.ratio)
)

export function resetPointDraft(limitOhm = 10, meterId = ''): void {
  pointDraft.set(createEmptyPointDraft(limitOhm, meterId))
}

export function setActiveDevice(deviceId: string | null): void {
  activeDeviceId.set(deviceId)
}

/** 按当前仪器/校准台账冻结一条测点证据 */
function freezeForDraft(meterId: string, measureDate: string): PointEvidence {
  return freezeEvidenceForPoint({
    meterId,
    measureDate,
    instruments: get(instrumentList),
    calibrations: get(calibrationList)
  })
}

/* ------------------------------- 测点 ------------------------------- */

/**
 * 新增测点：录入当次固定仪器编号与校准有效期到证据快照。
 * 仪器已注销/校准过期/检测日期不在有效期内时，证据状态落为「待补证」。
 */
export async function createPoint(
  deviceId: string,
  payload: Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'evidence' | 'meter'> &
    Partial<Pick<Point, 'evidence'>> & { meterId?: string }
): Promise<Point> {
  const now = Date.now()
  const evidence =
    payload.evidence ??
    freezeForDraft(payload.meterId ?? '', payload.measureDate)
  const row: Point = {
    id: `pnt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    deviceId,
    code: payload.code,
    location: payload.location,
    measuredOhm: payload.measuredOhm,
    limitOhm: payload.limitOhm,
    evidence,
    meter: evidence.meterName,
    measureDate: payload.measureDate,
    createdAt: now,
    updatedAt: now
  }
  await db.points.put(row)
  return row
}

/**
 * 改值后退回待复测的统一处理：
 * - 未签发测点：仅改值，证据快照不动，删除未确认判定（下一次自动初判重建）；
 * - 已签发测点：原判定保留但恢复为未签发「待判定」，issuedSnapshot 原样保留，
 *   证据状态置「待复测」，检测员必须重新复测并签发，不能直接改动已签发结论。
 * 返回是否触发了「已签发 → 退回待复测」。
 */
async function applyValueChange(
  pointIds: string[],
  patch: { measuredOhm?: number; limitOhm?: number; measureDate?: string; meterId?: string },
  now: number
): Promise<number> {
  if (pointIds.length === 0) return 0
  const verdicts = await db.verdicts.where('pointId').anyOf(pointIds).toArray()
  const confirmedByPoint = new Map(verdicts.filter((verdict) => verdict.confirmed).map((verdict) => [verdict.pointId, verdict]))
  const unconfirmedIds = verdicts.filter((verdict) => !verdict.confirmed).map((verdict) => verdict.id)

  let pushedBack = 0
  await db.transaction('rw', [db.points, db.verdicts], async () => {
    await db.points
      .where('id')
      .anyOf(pointIds)
      .modify((point: Point) => {
        if (patch.measuredOhm !== undefined) point.measuredOhm = patch.measuredOhm
        if (patch.limitOhm !== undefined) point.limitOhm = patch.limitOhm
        if (patch.measureDate !== undefined) point.measureDate = patch.measureDate
        if (confirmedByPoint.has(point.id)) {
          // 已签发测点改值：证据快照的仪器依据保留备查，状态转待复测
          point.evidence = {
            ...point.evidence,
            status: '待复测',
            note: '测点数值已变更，原签发结论保留原依据备查，需重新复测后签发'
          }
          pushedBack += 1
        }
        point.updatedAt = now
      })

    if (unconfirmedIds.length > 0) await db.verdicts.bulkDelete(unconfirmedIds)
    for (const verdict of confirmedByPoint.values()) {
      // issuedSnapshot 不动：保留签发时的实测值/限值/仪器编号/校准有效期
      await db.verdicts.put({
        ...verdict,
        result: '待判定',
        confirmed: false,
        updatedAt: now
      })
    }
  })
  return pushedBack
}

/**
 * 编辑测点。
 * - 只改位置/编号等非结论字段：直接更新，证据不动；
 * - 改实测值/限值/检测日期/仪器：走改值联动（已签发则退回待复测、原依据保留）；
 *   更换仪器时用新仪器编号重新冻结证据。
 */
export async function updatePoint(
  id: string,
  patch: Partial<Pick<Point, 'code' | 'location' | 'measuredOhm' | 'limitOhm' | 'measureDate'>> & { meterId?: string }
): Promise<{ pushedBack: boolean }> {
  const point = await db.points.get(id)
  if (!point) return { pushedBack: false }
  const now = Date.now()
  const valueChanged =
    (patch.measuredOhm !== undefined && patch.measuredOhm !== point.measuredOhm) ||
    (patch.limitOhm !== undefined && patch.limitOhm !== point.limitOhm) ||
    (patch.measureDate !== undefined && patch.measureDate !== point.measureDate) ||
    (patch.meterId !== undefined && patch.meterId !== point.evidence.meterId)

  if (!valueChanged) {
    const safePatch: Partial<Point> = { updatedAt: now }
    if (patch.code !== undefined) safePatch.code = patch.code
    if (patch.location !== undefined) safePatch.location = patch.location
    await db.points.update(id, safePatch as never)
    return { pushedBack: false }
  }

  const measureDate = patch.measureDate ?? point.measureDate
  // 更换仪器：用新仪器编号 + 当次校准有效期重新冻结；未换仪器则保留原快照（改值不改证据）
  let evidence = point.evidence
  if (patch.meterId !== undefined && patch.meterId !== point.evidence.meterId) {
    evidence = freezeForDraft(patch.meterId, measureDate)
  }
  const pushedBackCount = await applyValueChange([id], { ...patch, measureDate }, now)
  if (patch.meterId !== undefined && patch.meterId !== point.evidence.meterId) {
    await db.points.update(id, { evidence, meter: evidence.meterName, updatedAt: Date.now() } as never)
  }
  return { pushedBack: pushedBackCount > 0 }
}

/** 删除测点：同时删除其判定记录（证据快照随测点一并删除） */
export async function removePoint(id: string): Promise<void> {
  await db.transaction('rw', [db.points, db.verdicts], async () => {
    await db.verdicts.where('pointId').equals(id).delete()
    await db.points.delete(id)
  })
}

/**
 * 批量改写某装置全部测点的实测电阻（批量录入场景）。
 * 已签发测点会退回待复测（原签发依据保留），返回退回数量。
 */
export async function bulkSetMeasured(deviceId: string, measuredOhm: number): Promise<{ total: number; pushedBack: number }> {
  const now = Date.now()
  const targetIds = (await db.points.where('deviceId').equals(deviceId).toArray()).map((point) => point.id)
  const pushedBack = await applyValueChange(targetIds, { measuredOhm }, now)
  return { total: targetIds.length, pushedBack }
}

/**
 * 批量导入解析后的粘贴行（替换该装置原有测点）。
 * 新测点按所选仪器（meta.meterId）逐点冻结证据；旧测点连同判定整体替换，
 * 因此导入的全部是未签发的新证据，不携带旧签发状态。
 */
export async function importPointRows(
  deviceId: string,
  rows: Array<{ code: string; location: string; measuredOhm: number; limitOhm: number }>,
  meta: { meterId: string; measureDate: string }
): Promise<number> {
  const now = Date.now()
  const evidence = freezeForDraft(meta.meterId, meta.measureDate)
  const records: Point[] = rows.map((row, index) => ({
    id: `pnt_${Date.now().toString(36)}${index}${Math.random().toString(36).slice(2, 6)}`,
    deviceId,
    code: row.code,
    location: row.location,
    measuredOhm: row.measuredOhm,
    limitOhm: row.limitOhm,
    evidence,
    meter: evidence.meterName,
    measureDate: meta.measureDate,
    createdAt: now + index,
    updatedAt: now + index
  }))
  await db.transaction('rw', [db.points, db.verdicts], async () => {
    const oldIds = (await db.points.where('deviceId').equals(deviceId).toArray()).map((row) => row.id)
    if (oldIds.length > 0) await db.verdicts.where('pointId').anyOf(oldIds).delete()
    await db.points.where('deviceId').equals(deviceId).delete()
    await db.points.bulkPut(records)
  })
  return records.length
}

/** 待复测 / 待补证 / 需补充测点清单（复测台与页签统计共用） */
export const pendingEvidencePoints = derived(pointList, ($points) =>
  $points
    .filter((point) => point.evidence && point.evidence.status !== '有效')
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
)
