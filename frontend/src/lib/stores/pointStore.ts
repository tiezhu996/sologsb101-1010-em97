/**
 * 测点 store：维护测点集合、接地电阻录入草稿与装置筛选。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅。
 *
 * 证据快照规则（与仪器台账解耦的关键）：
 * - 录入 / 复测测点时，用当前仪器台账与校准记录固化一份证据快照（仪器编号 + 当次校准有效期）；
 * - 只改实测值 / 限值不会触碰快照（测点改值不能让快照悄悄变化）；
 * - 结论已签发的测点整体锁定，改值、换仪器、删除一律拒绝。
 *
 * 依赖方向（单向）：pointStore → utils/db、types/*、utils/*、buildingStore、meterStore。
 * 装置维度的测点统计（同时依赖两个 store）已下沉到 stores/pointStats.ts，避免循环依赖。
 */
import { derived, get, writable } from 'svelte/store'
import { db, watchTable } from '$lib/utils/db'
import type { EvidenceState, Point, PointDraft } from '$lib/types/point'
import { createEmptyPointDraft } from '$lib/types/point'
import { deviceList } from '$lib/stores/buildingStore'
import { calibrationList, meterList } from '$lib/stores/meterStore'
import { buildEvidenceSnapshot } from '$lib/utils/evidence'
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

/** 测点行：附带装置类型与合格标记，供测点录入页表格展示 */
export const pointRows = derived([pointList, deviceList], ([$points, $devices]) =>
  $points
    .map((point) => {
      const device = $devices.find((item) => item.id === point.deviceId)
      return {
        point,
        device,
        deviceType: device?.type ?? '未知装置',
        qualified: isQualified(point.measuredOhm, point.limitOhm),
        ratio: limitRatio(point.measuredOhm, point.limitOhm)
      }
    })
    .sort((a, b) => b.ratio - a.ratio)
)

/** 证据状态计数：待复测清单与待补证范围的入口统计 */
export const evidenceCounts = derived(pointList, ($points) => {
  const counts: Record<EvidenceState, number> = { 有效: 0, 待复测: 0, 待补证: 0, 需补充: 0 }
  $points.forEach((point) => {
    counts[point.evidenceState] += 1
  })
  return counts
})

export function resetPointDraft(limitOhm = 10): void {
  pointDraft.set(createEmptyPointDraft(limitOhm))
}

export function setActiveDevice(deviceId: string | null): void {
  activeDeviceId.set(deviceId)
}

/* ------------------------------- 测点 ------------------------------- */

/** 用当前台账构建证据快照（录入 / 复测时调用，过期或注销不影响已固化的历史快照） */
function snapshotFor(meterId: string | null) {
  return buildEvidenceSnapshot(meterId, get(meterList), get(calibrationList))
}

/** 测点是否已有签发结论（签发后测点数据锁定） */
async function hasIssuedVerdict(pointId: string): Promise<boolean> {
  const verdict = await db.verdicts.where('pointId').equals(pointId).first()
  return verdict?.confirmed === true
}

/** 测点录入载荷：仪器以 meterId 选择，保存时固化为快照 */
export interface PointPayload {
  code: string
  location: string
  measuredOhm: number
  limitOhm: number
  meterId: string | null
  measureDate: string
}

export async function createPoint(deviceId: string, payload: PointPayload): Promise<Point> {
  const now = Date.now()
  const { meterId, ...rest } = payload
  const row: Point = {
    ...rest,
    ...snapshotFor(meterId),
    deviceId,
    id: `pnt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now
  }
  await db.points.put(row)
  return row
}

/**
 * 更新测点：
 * - 结论已签发 → 拒绝（签发后测点数据锁定，不随任何操作变化）
 * - patch 含 meterId（重新选用仪器 / 复测）→ 重新固化证据快照
 * - 仅改实测值 / 限值等 → 快照字段原样保留，绝不悄悄变化
 */
export async function updatePoint(id: string, patch: Partial<PointPayload>): Promise<void> {
  if (await hasIssuedVerdict(id)) {
    throw new Error('该测点结论已签发，测点数据已锁定，不能修改')
  }
  const next: Record<string, unknown> = { ...patch, updatedAt: Date.now() }
  if ('meterId' in patch) {
    Object.assign(next, snapshotFor(patch.meterId ?? null))
  }
  await db.points.update(id, next as never)
}

/** 删除测点：同时删除其判定记录；已签发的测点拒绝删除 */
export async function removePoint(id: string): Promise<void> {
  if (await hasIssuedVerdict(id)) {
    throw new Error('该测点结论已签发，不能删除；如需调整请先处理判定记录')
  }
  await db.transaction('rw', [db.points, db.verdicts], async () => {
    await db.verdicts.where('pointId').equals(id).delete()
    await db.points.delete(id)
  })
}

/**
 * 批量改写某装置全部测点的实测电阻（批量录入场景）。
 * 只改实测值，不触碰证据快照；已签发测点跳过并计数返回。
 */
export async function bulkSetMeasured(
  deviceId: string,
  measuredOhm: number
): Promise<{ modified: number; skipped: number }> {
  const now = Date.now()
  const points = await db.points.where('deviceId').equals(deviceId).toArray()
  const verdicts = await db.verdicts.where('pointId').anyOf(points.map((point) => point.id)).toArray()
  const issuedPointIds = new Set(verdicts.filter((verdict) => verdict.confirmed).map((verdict) => verdict.pointId))
  const targets = points.filter((point) => !issuedPointIds.has(point.id))
  await db.points.bulkPut(targets.map((point) => ({ ...point, measuredOhm, updatedAt: now })))
  return { modified: targets.length, skipped: points.length - targets.length }
}

/**
 * 批量导入解析后的粘贴行（替换该装置原有测点）。
 * 装置内已有签发结论时整体拒绝，避免悄悄覆盖已签发证据；
 * 新测点按所选仪器统一固化证据快照。
 */
export async function importPointRows(
  deviceId: string,
  rows: Array<{ code: string; location: string; measuredOhm: number; limitOhm: number }>,
  meta: { meterId: string | null; measureDate: string }
): Promise<number> {
  const now = Date.now()
  const snapshot = snapshotFor(meta.meterId)
  const records: Point[] = rows.map((row, index) => ({
    id: `pnt_${Date.now().toString(36)}${index}${Math.random().toString(36).slice(2, 6)}`,
    deviceId,
    code: row.code,
    location: row.location,
    measuredOhm: row.measuredOhm,
    limitOhm: row.limitOhm,
    ...snapshot,
    measureDate: meta.measureDate,
    createdAt: now + index,
    updatedAt: now + index
  }))
  await db.transaction('rw', [db.points, db.verdicts], async () => {
    const oldIds = (await db.points.where('deviceId').equals(deviceId).toArray()).map((row) => row.id)
    if (oldIds.length > 0) {
      const issued = await db.verdicts.where('pointId').anyOf(oldIds).toArray()
      if (issued.some((verdict) => verdict.confirmed)) {
        throw new Error('该装置存在已签发结论的测点，不能整体替换；请先处理相关判定')
      }
      await db.verdicts.where('pointId').anyOf(oldIds).delete()
    }
    await db.points.where('deviceId').equals(deviceId).delete()
    await db.points.bulkPut(records)
  })
  return records.length
}
