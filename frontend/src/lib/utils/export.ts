/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致；JSON 中不含任何非数据内容。
 * 测点证据状态（有效 / 待复测 / 待补证 / 需补充）随快照一同导出导入，不丢失。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '$lib/utils/db'
import type { Calibration, Meter } from '$lib/types/meter'
import type { Point } from '$lib/types/point'
import { EVIDENCE_STATES } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import { resolveLegacyEvidence } from '$lib/utils/evidence'

/** 备份集合键名 */
export const BACKUP_KEYS = ['buildings', 'devices', 'meters', 'calibrations', 'points', 'verdicts', 'rectifies'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [buildings, devices, meters, calibrations, points, verdicts, rectifies] = await Promise.all([
    db.buildings.toArray(),
    db.devices.toArray(),
    db.meters.toArray(),
    db.calibrations.toArray(),
    db.points.toArray(),
    db.verdicts.toArray(),
    db.rectifies.toArray()
  ])
  return {
    app: 'gblightprot',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    buildings,
    devices,
    meters,
    calibrations,
    points,
    verdicts,
    rectifies
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件（旧版无仪器表也可导入，按待补证规则规范化） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gblightprot') {
    errors.push('app 字段应为 gblightprot，文件来源不明')
  }
  // buildings / devices / points / verdicts / rectifies 为必需；meters / calibrations 为 v3 新增，旧文件可缺省
  const required: BackupKey[] = ['buildings', 'devices', 'points', 'verdicts', 'rectifies']
  for (const key of required) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  for (const key of ['meters', 'calibrations'] as const) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) errors.push(`${key} 字段不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gblightprot',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    buildings: obj.buildings ?? [],
    devices: obj.devices ?? [],
    meters: obj.meters ?? [],
    calibrations: obj.calibrations ?? [],
    points: obj.points ?? [],
    verdicts: obj.verdicts ?? [],
    rectifies: obj.rectifies ?? []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    buildings: payload.buildings.length,
    devices: payload.devices.length,
    meters: payload.meters.length,
    calibrations: payload.calibrations.length,
    points: payload.points.length,
    verdicts: payload.verdicts.length,
    rectifies: payload.rectifies.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 规范化导入快照：
 * - 新版数据：测点证据状态与快照字段原样保留（导入导出不丢状态）
 * - 旧版数据（v2 及以前，测点只有 meter 自由文本）：解析出仪器编号的重建台账与校准占位记录，
 *   缺少仪器编号的测点归入待补证
 * - 判定记录补齐签发时间与需补充标记
 */
export function normalizePayload(payload: BackupPayload): BackupPayload {
  const now = Date.now()
  const meters: Meter[] = payload.meters.map((meter, index) => ({
    ...meter,
    state: meter.state ?? '在用',
    createdAt: meter.createdAt ?? now + index,
    updatedAt: meter.updatedAt ?? now + index
  }))
  const calibrations: Calibration[] = payload.calibrations.map((calibration, index) => ({
    ...calibration,
    revision: calibration.revision ?? 0,
    createdAt: calibration.createdAt ?? now + index,
    updatedAt: calibration.updatedAt ?? now + index
  }))

  // 旧版测点：有 meter 自由文本而没有证据状态的，走统一旧数据解析
  const legacyRows: Array<{ id: string; meter: string }> = []
  const points = payload.points.map((point, index) => {
    const raw = point as Point & { meter?: string }
    const base: Point & { meter?: string } = {
      ...raw,
      meterId: raw.meterId ?? null,
      meterCode: raw.meterCode ?? '',
      meterName: raw.meterName ?? '',
      calibrationId: raw.calibrationId ?? null,
      calibrationValidUntil: raw.calibrationValidUntil ?? '',
      evidenceState: raw.evidenceState ?? '待补证',
      evidenceInvalidatedBy: raw.evidenceInvalidatedBy ?? null,
      createdAt: raw.createdAt ?? now + index,
      updatedAt: raw.updatedAt ?? now + index
    }
    if ((EVIDENCE_STATES as readonly string[]).includes(raw.evidenceState)) {
      delete base.meter
      return base
    }
    legacyRows.push({ id: raw.id, meter: typeof raw.meter === 'string' ? raw.meter : '' })
    return base
  })
  const legacy = resolveLegacyEvidence(legacyRows, now, { meters, calibrations })
  const resolvedPoints = points.map((point) => {
    const snapshot = legacy.snapshots.get(point.id)
    if (!snapshot) {
      const { meter: _legacyMeter, ...rest } = point as Point & { meter?: string }
      return rest as Point
    }
    const { meter: _legacyMeter, ...rest } = point as Point & { meter?: string }
    return { ...rest, ...snapshot } as Point
  })

  const verdicts: Verdict[] = payload.verdicts.map((verdict, index) => ({
    ...verdict,
    issuedAt: verdict.issuedAt ?? (verdict.confirmed ? (verdict.updatedAt ?? now + index) : null),
    needsSupplement: verdict.needsSupplement ?? false,
    createdAt: verdict.createdAt ?? now + index,
    updatedAt: verdict.updatedAt ?? now + index
  }))

  return {
    ...payload,
    meters: [...meters, ...legacy.meters],
    calibrations: [...calibrations, ...legacy.calibrations],
    points: resolvedPoints,
    verdicts
  }
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并；导入前统一规范化 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  const normalized = normalizePayload(payload)
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.buildings, db.devices, db.meters, db.calibrations, db.points, db.verdicts, db.rectifies],
    async () => {
      await db.buildings.bulkPut(normalized.buildings)
      await db.devices.bulkPut(normalized.devices)
      await db.meters.bulkPut(normalized.meters)
      await db.calibrations.bulkPut(normalized.calibrations)
      await db.points.bulkPut(normalized.points)
      await db.verdicts.bulkPut(normalized.verdicts)
      await db.rectifies.bulkPut(normalized.rectifies)
    }
  )
  return countPayload(normalized)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案；证据状态随测点保留 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const buildingMap = new Map<string, string>()
  const deviceMap = new Map<string, string>()
  const meterMap = new Map<string, string>()
  const calibrationMap = new Map<string, string>()
  const pointMap = new Map<string, string>()

  const buildings = payload.buildings.map((building) => {
    const id = createId('bld')
    buildingMap.set(building.id, id)
    return { ...building, id }
  })
  const devices = payload.devices.map((device) => {
    const id = createId('dev')
    deviceMap.set(device.id, id)
    return { ...device, id, buildingId: buildingMap.get(device.buildingId) ?? device.buildingId }
  })
  const meters = payload.meters.map((meter) => {
    const id = createId('mtr')
    meterMap.set(meter.id, id)
    return { ...meter, id }
  })
  const calibrations = payload.calibrations.map((calibration) => {
    const id = createId('cal')
    calibrationMap.set(calibration.id, id)
    return { ...calibration, id, meterId: meterMap.get(calibration.meterId) ?? calibration.meterId }
  })
  const points = payload.points.map((point) => {
    const id = createId('pnt')
    pointMap.set(point.id, id)
    // 失效来源键 `校准记录id#revision` 随校准记录一并重映射，保持幂等键有效
    const invalidatedBy = point.evidenceInvalidatedBy
    const remappedInvalidatedBy = invalidatedBy
      ? (() => {
          const [calibrationId, revision] = invalidatedBy.split('#')
          const mapped = calibrationMap.get(calibrationId)
          return mapped ? `${mapped}#${revision}` : invalidatedBy
        })()
      : null
    return {
      ...point,
      id,
      deviceId: deviceMap.get(point.deviceId) ?? point.deviceId,
      meterId: point.meterId ? (meterMap.get(point.meterId) ?? point.meterId) : null,
      calibrationId: point.calibrationId ? (calibrationMap.get(point.calibrationId) ?? point.calibrationId) : null,
      evidenceInvalidatedBy: remappedInvalidatedBy
    }
  })
  const verdicts = payload.verdicts.map((verdict) => ({
    ...verdict,
    id: createId('vrd'),
    pointId: pointMap.get(verdict.pointId) ?? verdict.pointId
  }))
  const rectifies = payload.rectifies.map((rectify) => ({
    ...rectify,
    id: createId('rct'),
    buildingId: buildingMap.get(rectify.buildingId) ?? rectify.buildingId,
    pointId: rectify.pointId ? pointMap.get(rectify.pointId) ?? rectify.pointId : null
  }))
  return { ...payload, buildings, devices, meters, calibrations, points, verdicts, rectifies }
}

/** 检测结论行：按建筑物汇总测点数、不合格数与结论文字 */
export interface ConclusionLine {
  buildingId: string
  buildingName: string
  usage: string
  protectionClass: string
  deviceCount: number
  pointCount: number
  unqualifiedCount: number
  qualifyRatePct: number
  /** 待复测测点数（校准更正退回、尚未复测签发） */
  pendingRetestCount: number
  /** 已签发但需补充的结论数（校准更正波及，原依据保留） */
  supplementCount: number
  /** 最不利（实测/限值比最大）测点摘要 */
  worstPoint: string
  conclusion: string
  advice: string
}

/** 生成按建筑物的检测结论与整改建议汇总 */
export function buildConclusionLines(payload: BackupPayload): ConclusionLine[] {
  const deviceById = new Map(payload.devices.map((device) => [device.id, device]))
  const verdictByPoint = new Map(payload.verdicts.map((verdict) => [verdict.pointId, verdict]))

  return payload.buildings.map((building) => {
    const devices = payload.devices.filter((device) => device.buildingId === building.id)
    const deviceIds = new Set(devices.map((device) => device.id))
    const points = payload.points.filter((point) => deviceIds.has(point.deviceId))
    const verdicts = points
      .map((point) => verdictByPoint.get(point.id))
      .filter((verdict): verdict is NonNullable<typeof verdict> => Boolean(verdict))
    const unqualified = verdicts.filter((verdict) => verdict.result === '不合格')
    const pendingRetestCount = points.filter((point) => point.evidenceState === '待复测').length
    const supplementCount = verdicts.filter((verdict) => verdict.confirmed && verdict.needsSupplement).length
    let worstRatio = 0
    let worstPoint = '无测点数据'
    points.forEach((point) => {
      const ratio = point.limitOhm > 0 ? point.measuredOhm / point.limitOhm : 0
      if (ratio > worstRatio) {
        worstRatio = ratio
        const device = deviceById.get(point.deviceId)
        worstPoint = `${point.code}（${device?.type ?? '装置'}）实测 ${point.measuredOhm} Ω / 限值 ${point.limitOhm} Ω`
      }
    })
    const qualifyRatePct =
      verdicts.length === 0
        ? 0
        : Number((((verdicts.length - unqualified.length) / verdicts.length) * 100).toFixed(1))
    const rectifies = payload.rectifies.filter((rectify) => rectify.buildingId === building.id)
    const pending = rectifies.filter((rectify) => rectify.state !== '已复检').length
    const conclusion =
      points.length === 0
        ? '未录入测点，无法出具结论'
        : unqualified.length === 0
          ? `所检 ${points.length} 个测点接地电阻均不大于限值，判定合格`
          : `所检 ${points.length} 个测点中 ${unqualified.length} 个不合格，判定不合格`
    const evidenceNotes: string[] = []
    if (pendingRetestCount > 0) evidenceNotes.push(`${pendingRetestCount} 个测点待复测`)
    if (supplementCount > 0) evidenceNotes.push(`${supplementCount} 条已签发结论需补充`)
    const advice =
      rectifies.length === 0
        ? '无需整改，建议按周期复测'
        : `已生成 ${rectifies.length} 条整改建议，其中 ${pending} 条未完成复检闭环`
    return {
      buildingId: building.id,
      buildingName: building.name,
      usage: building.usage,
      protectionClass: building.protectionClass,
      deviceCount: devices.length,
      pointCount: points.length,
      unqualifiedCount: unqualified.length,
      qualifyRatePct,
      pendingRetestCount,
      supplementCount,
      worstPoint,
      conclusion,
      advice: evidenceNotes.length > 0 ? `${advice}；${evidenceNotes.join('，')}` : advice
    }
  })
}
