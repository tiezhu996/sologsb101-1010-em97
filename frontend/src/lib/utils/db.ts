/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gblightprot，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（建筑物 → 防雷装置 → 测点 → 判定 → 整改建议）
 * - v3 起新增「仪器台账 instruments」与「校准记录 calibrations」，测点仪器信息改为
 *   录入即冻结的证据快照（Point.evidence），判定签发时冻结原始依据（Verdict.issuedSnapshot）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Building } from '$lib/types/building'
import type { Device } from '$lib/types/device'
import { DEVICE_TYPES } from '$lib/types/device'
import type { Point, PointEvidence } from '$lib/types/point'
import type { Verdict } from '$lib/types/verdict'
import { buildIssuedEvidence, defaultBasis, judgePoint } from '$lib/types/verdict'
import type { Rectify } from '$lib/types/rectify'
import { SUGGESTION_TEMPLATES } from '$lib/types/rectify'
import type { Instrument } from '$lib/types/instrument'
import type { Calibration } from '$lib/types/calibration'
import { suggestLimitOhm } from '$lib/utils/resistance'
import { freezeEvidenceForPoint, normalizePointEvidence } from '$lib/utils/evidence'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gblightprot'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gblightprot:db-version',
  lastBackupAt: 'gblightprot:last-backup-at',
  lastBuildingId: 'gblightprot:last-building-id'
} as const

/** 备份文件结构，供 utils/export.ts 与备份页使用 */
export interface BackupPayload {
  app: 'gblightprot'
  dbVersion: number
  exportedAt: string
  buildings: Building[]
  devices: Device[]
  instruments: Instrument[]
  calibrations: Calibration[]
  points: Point[]
  verdicts: Verdict[]
  rectifies: Rectify[]
}

export class LightProtDatabase extends Dexie {
  buildings!: Table<Building, string>
  devices!: Table<Device, string>
  instruments!: Table<Instrument, string>
  calibrations!: Table<Calibration, string>
  points!: Table<Point, string>
  verdicts!: Table<Verdict, string>
  rectifies!: Table<Rectify, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      buildings: 'id, name, usage, protectionClass',
      devices: 'id, buildingId, type, material',
      points: 'id, deviceId, code, measuredOhm',
      verdicts: 'id, pointId, result',
      rectifies: 'id, buildingId, state'
    })

    // v2：补齐筛选与统计需要的索引（用途/类别/层数、装置类型、限值、判定与状态）
    this.version(2)
      .stores({
        buildings: 'id, name, usage, protectionClass, floors, heightM, updatedAt',
        devices: 'id, buildingId, type, material, spec, quantity, installDate, updatedAt',
        points: 'id, deviceId, code, measuredOhm, limitOhm, measureDate, updatedAt',
        verdicts: 'id, pointId, result, confirmed, verdictDate, updatedAt',
        rectifies: 'id, buildingId, pointId, state, deadline, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与判定确认标记，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['buildings', () => ({ floors: 1, heightM: 4 })],
          ['devices', () => ({ quantity: 1, installDate: new Date().toISOString().slice(0, 10) })],
          ['points', () => ({ limitOhm: 10, meter: '', measureDate: new Date().toISOString().slice(0, 10) })],
          ['verdicts', () => ({ result: '待判定', confirmed: false, inspector: '', basis: '' })],
          ['rectifies', () => ({ state: '待整改', owner: '', pointId: null })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }
      })

    // v3：仪器台账 + 校准记录；测点仪器改为证据快照；判定签发冻结原始依据
    this.version(DB_VERSION)
      .stores({
        buildings: 'id, name, usage, protectionClass, floors, heightM, updatedAt',
        devices: 'id, buildingId, type, material, spec, quantity, installDate, updatedAt',
        instruments: 'id, code, status, updatedAt',
        calibrations: 'id, instrumentId, validUntil, calibrateDate, updatedAt',
        points: 'id, deviceId, code, measuredOhm, limitOhm, measureDate, evidence.status, updatedAt',
        verdicts: 'id, pointId, result, confirmed, verdictDate, updatedAt',
        rectifies: 'id, buildingId, pointId, state, deadline, updatedAt'
      })
      .upgrade(async (tx) => {
        // 测点写入证据快照。旧数据缺仪器编号/校准有效期 → 归入待补证；
        // 快照一旦写入即固定，仪器表与校准表的后续变化不回改这里。
        await tx
          .table('points')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.evidence && typeof row.evidence === 'object') return
            row.evidence = normalizePointEvidence(row)
          })

        // 已签发判定按测点真实数据冻结原始依据；未签发为 null。
        // modify 回调内不能跨表读取 points，先统一置 null，再用两表数据回填。
        await tx
          .table('verdicts')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.issuedSnapshot === 'undefined') row.issuedSnapshot = null
          })
        const pointRows = await tx.table('points').toArray()
        const verdictRows = await tx.table('verdicts').toArray()
        const pointById = new Map<string, Record<string, unknown>>(
          pointRows.map((row: Record<string, unknown>) => [String(row.id), row])
        )
        for (const verdict of verdictRows as Array<Record<string, unknown>>) {
          if (verdict.confirmed !== true) continue
          const point = pointById.get(String(verdict.pointId))
          const evidence = point?.evidence as PointEvidence | undefined
          if (!point || !evidence) continue
          verdict.issuedSnapshot = buildIssuedEvidence({
            measuredOhm: Number(point.measuredOhm ?? 0),
            limitOhm: Number(point.limitOhm ?? 0),
            measureDate: typeof point.measureDate === 'string' ? point.measureDate : '',
            meterId: evidence.meterId,
            meterName: evidence.meterName,
            certificateNo: evidence.certificateNo,
            calibrationValidUntil: evidence.calibrationValidUntil
          })
          await tx.table('verdicts').put(verdict)
        }

        // 仪器/校准表为空时灌入基础台账（含演示数据引用的三台仪器），
        // 用户自己登记过仪器则不覆盖；旧测点引用不到的编号仍保持待补证。
        const instrumentCount = await tx.table('instruments').count()
        if (instrumentCount === 0) {
          const catalog = buildBaselineInstruments()
          await tx.table('instruments').bulkPut(catalog.instruments)
          await tx.table('calibrations').bulkPut(catalog.calibrations)
        }
      })
  }
}

export const db = new LightProtDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/**
 * 订阅单表变化（Dexie liveQuery），返回取消订阅函数。
 * 供 Svelte store 在模块加载时启动响应式数据流。
 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* --------------------------- 基础仪器台账（播种/迁移共用） --------------------------- */

/**
 * 基础仪器台账：演示数据引用的三台仪器 + 各自最近一条校准记录。
 * No.20201122 的校准早已过期，用于演示「已签发结果保留原依据、证据待补证」。
 */
export function buildBaselineInstruments(): { instruments: Instrument[]; calibrations: Calibration[] } {
  const now = Date.now()
  const instruments: Instrument[] = [
    {
      id: 'mtr_zc8_20230517',
      code: 'No.20230517',
      name: 'ZC-8 接地电阻测试仪',
      spec: '0~100 Ω',
      manufacturer: '上海第六电表厂',
      status: '在用',
      retiredAt: null,
      remark: '油库综合楼检测主力仪器',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'mtr_der_a221104',
      code: 'No.A221104',
      name: 'DER2571 数字接地电阻表',
      spec: '0.01~200 Ω',
      manufacturer: '武汉得亚电力',
      status: '在用',
      retiredAt: null,
      remark: '医院项目常用',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'mtr_zc8_20201122',
      code: 'No.20201122',
      name: 'ZC-8 接地电阻测试仪',
      spec: '0~100 Ω',
      manufacturer: '上海第六电表厂',
      status: '在用',
      retiredAt: null,
      remark: '旧仪器，校准已过期，待重新送检',
      createdAt: now,
      updatedAt: now
    }
  ]
  const iso = (offsetDays: number): string => new Date(now + offsetDays * 86400000).toISOString().slice(0, 10)
  const calibrations: Calibration[] = [
    {
      id: 'cal_20230517_a',
      instrumentId: 'mtr_zc8_20230517',
      agency: '市计量测试研究院',
      certificateNo: 'JL-2026-0517',
      calibrateDate: iso(-60),
      validUntil: iso(305),
      conclusion: '合格，准予使用',
      correctionNote: '',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'cal_a221104_a',
      instrumentId: 'mtr_der_a221104',
      agency: '省电力计量中心',
      certificateNo: 'DL-2026-A221104',
      calibrateDate: iso(-40),
      validUntil: iso(325),
      conclusion: '合格，准予使用',
      correctionNote: '',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'cal_20201122_a',
      instrumentId: 'mtr_zc8_20201122',
      agency: '市计量测试研究院',
      certificateNo: 'JL-2020-1122',
      calibrateDate: '2019-11-23',
      validUntil: '2020-11-22',
      conclusion: '合格（该证书已过期）',
      correctionNote: '',
      createdAt: now,
      updatedAt: now
    }
  ]
  return { instruments, calibrations }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedPoint {
  id: string
  deviceId: string
  code: string
  location: string
  measuredOhm: number
  limitOhm: number
  /** 录入当次选用的仪器编号（Instrument.code），证据快照按它与校准有效期冻结 */
  meterId: string
  measureDate: string
}

interface SeedDevice {
  id: string
  buildingId: string
  type: (typeof DEVICE_TYPES)[number]
  material: string
  spec: string
  quantity: number
  installDate: string
  points: SeedPoint[]
}

/**
 * 播种演示数据：3 栋建筑物 → 6 个防雷装置 → 9 个测点 → 逐点自动初判 → 2 条整改建议，
 * 保证父 → 子 → 孙三层链路可点开，且既有合格也有不合格样本。
 * 测点证据在写入时按仪器台账与校准有效期冻结；判定签发时冻结原始依据。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const buildings: Array<Omit<Building, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'bld_oil01',
      name: '临港油库综合楼',
      usage: '油库',
      protectionClass: '一类',
      floors: 4,
      heightM: 18.6,
      address: '临港工业园区纬三路 18 号'
    },
    {
      id: 'bld_hosp02',
      name: '市第一医院住院部',
      usage: '医院',
      protectionClass: '二类',
      floors: 12,
      heightM: 46.2,
      address: '解放东路 220 号'
    },
    {
      id: 'bld_school03',
      name: '第三中学教学楼',
      usage: '学校',
      protectionClass: '三类',
      floors: 5,
      heightM: 19.8,
      address: '文化路 77 号'
    }
  ]

  const devices: SeedDevice[] = [
    {
      id: 'dev_oil_belt',
      buildingId: 'bld_oil01',
      type: '接闪带',
      material: '热镀锌圆钢',
      spec: 'Φ12',
      quantity: 186,
      installDate: '2019-06-12',
      points: [
        {
          id: 'pnt_oil_belt_1',
          deviceId: 'dev_oil_belt',
          code: 'JD-OIL-01',
          location: '屋面西北角接闪带引下点',
          measuredOhm: 3.2,
          limitOhm: 10,
          meterId: 'No.20230517',
          measureDate: today
        },
        {
          id: 'pnt_oil_belt_2',
          deviceId: 'dev_oil_belt',
          code: 'JD-OIL-02',
          location: '屋面东南角接闪带引下点',
          measuredOhm: 4.1,
          limitOhm: 10,
          meterId: 'No.20230517',
          measureDate: today
        }
      ]
    },
    {
      id: 'dev_oil_down',
      buildingId: 'bld_oil01',
      type: '引下线',
      material: '热镀锌扁钢',
      spec: '-40×4',
      quantity: 8,
      installDate: '2019-06-12',
      points: [
        {
          id: 'pnt_oil_down_1',
          deviceId: 'dev_oil_down',
          code: 'JD-OIL-03',
          location: '北侧 3 号引下线断接卡处',
          measuredOhm: 12.6,
          limitOhm: 10,
          meterId: 'No.20230517',
          measureDate: today
        },
        {
          id: 'pnt_oil_down_2',
          deviceId: 'dev_oil_down',
          code: 'JD-OIL-04',
          location: '南侧 6 号引下线断接卡处',
          measuredOhm: 6.8,
          limitOhm: 10,
          meterId: 'No.20230517',
          measureDate: today
        }
      ]
    },
    {
      id: 'dev_oil_grid',
      buildingId: 'bld_oil01',
      type: '接地体',
      material: '石墨接地模块',
      spec: '500×400×60',
      quantity: 24,
      installDate: '2019-06-20',
      points: [
        {
          id: 'pnt_oil_grid_1',
          deviceId: 'dev_oil_grid',
          code: 'JD-OIL-05',
          location: '罐区环形接地体东侧测试井',
          measuredOhm: 3.9,
          limitOhm: 4,
          meterId: 'No.20230517',
          measureDate: today
        },
        {
          id: 'pnt_oil_grid_2',
          deviceId: 'dev_oil_grid',
          code: 'JD-OIL-06',
          location: '罐区环形接地体西侧测试井',
          measuredOhm: 5.4,
          limitOhm: 4,
          meterId: 'No.20230517',
          measureDate: today
        }
      ]
    },
    {
      id: 'dev_hosp_rod',
      buildingId: 'bld_hosp02',
      type: '接闪杆',
      material: '不锈钢',
      spec: 'Φ25 × 1.5 m',
      quantity: 4,
      installDate: '2021-03-08',
      points: [
        {
          id: 'pnt_hosp_rod_1',
          deviceId: 'dev_hosp_rod',
          code: 'JD-HOS-01',
          location: '裙房屋面接闪杆杆基',
          measuredOhm: 7.4,
          limitOhm: 10,
          meterId: 'No.A221104',
          measureDate: today
        }
      ]
    },
    {
      id: 'dev_hosp_down',
      buildingId: 'bld_hosp02',
      type: '引下线',
      material: '铜包钢',
      spec: 'Φ16',
      quantity: 12,
      installDate: '2021-03-08',
      points: [
        {
          id: 'pnt_hosp_down_1',
          deviceId: 'dev_hosp_down',
          code: 'JD-HOS-02',
          location: '主楼东侧引下线断接卡',
          measuredOhm: 8.9,
          limitOhm: 10,
          meterId: 'No.A221104',
          measureDate: today
        },
        {
          id: 'pnt_hosp_down_2',
          deviceId: 'dev_hosp_down',
          code: 'JD-HOS-03',
          location: '主楼西侧引下线断接卡',
          measuredOhm: 15.2,
          limitOhm: 10,
          meterId: 'No.A221104',
          measureDate: today
        }
      ]
    },
    {
      id: 'dev_school_belt',
      buildingId: 'bld_school03',
      type: '接闪带',
      material: '热镀锌圆钢',
      spec: 'Φ10',
      quantity: 142,
      installDate: '2016-08-30',
      points: [
        {
          id: 'pnt_school_belt_1',
          deviceId: 'dev_school_belt',
          code: 'JD-SCH-01',
          location: '教学楼屋面接闪带东北角',
          measuredOhm: 9.4,
          limitOhm: 10,
          meterId: 'No.20201122',
          measureDate: today
        }
      ]
    }
  ]

  await db.transaction(
    'rw',
    [db.buildings, db.devices, db.instruments, db.calibrations, db.points, db.verdicts, db.rectifies],
    async () => {
      const stamp = (index: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + index,
        updatedAt: now + index
      })

      await db.buildings.bulkPut(buildings.map((building, index) => ({ ...building, ...stamp(index) })))

      const baseline = buildBaselineInstruments()
      await db.instruments.bulkPut(baseline.instruments)
      await db.calibrations.bulkPut(baseline.calibrations)

      const allDevices: Device[] = []
      const allPoints: Point[] = []
      devices.forEach((device, index) => {
        const { points, ...rest } = device
        allDevices.push({ ...rest, ...stamp(index) })
        points.forEach((point, pointIndex) => {
          // 录入当次冻结证据：仪器编号 + 当次校准有效期，之后不随台账变化
          const evidence = freezeEvidenceForPoint({
            meterId: point.meterId,
            measureDate: point.measureDate,
            instruments: baseline.instruments,
            calibrations: baseline.calibrations
          })
          allPoints.push({
            id: point.id,
            deviceId: point.deviceId,
            code: point.code,
            location: point.location,
            measuredOhm: point.measuredOhm,
            limitOhm: point.limitOhm,
            evidence,
            meter: evidence.meterName,
            measureDate: point.measureDate,
            ...stamp(index * 100 + pointIndex)
          })
        })
      })
      await db.devices.bulkPut(allDevices)
      await db.points.bulkPut(allPoints)

      // 逐点自动初判：实测值 ≤ 限值判合格，否则不合格，检测人确认（签发）后生效
      const buildingOfDevice = new Map(allDevices.map((device) => [device.id, device.buildingId]))
      const deviceOfPoint = new Map(allDevices.map((device) => [device.id, device]))
      const verdicts: Verdict[] = allPoints.map((point, index) => {
        const device = deviceOfPoint.get(point.deviceId)
        const building = buildings.find((item) => item.id === buildingOfDevice.get(point.deviceId))
        // 签发即冻结：实测值/限值/仪器编号/校准有效期复制进 issuedSnapshot
        const issuedSnapshot = buildIssuedEvidence({
          measuredOhm: point.measuredOhm,
          limitOhm: point.limitOhm,
          measureDate: point.measureDate,
          meterId: point.evidence.meterId,
          meterName: point.evidence.meterName,
          certificateNo: point.evidence.certificateNo,
          calibrationValidUntil: point.evidence.calibrationValidUntil,
          issuedAt: now + 1000 + index
        })
        return {
          id: `vrd_${point.id}`,
          pointId: point.id,
          result: judgePoint(point.measuredOhm, point.limitOhm),
          basis: defaultBasis(building?.protectionClass ?? '三类', device?.type ?? '接地体', point.limitOhm),
          inspector: '陈立群',
          verdictDate: point.measureDate,
          confirmed: true,
          issuedSnapshot,
          ...stamp(1000 + index)
        }
      })
      await db.verdicts.bulkPut(verdicts)

      // 由不合格判定批量生成整改建议（跟踪到复检闭环）
      const rectifies: Rectify[] = verdicts
        .filter((verdict) => verdict.result === '不合格')
        .map((verdict, index) => {
          const point = allPoints.find((item) => item.id === verdict.pointId)
          const buildingId = point ? buildingOfDevice.get(point.deviceId) ?? '' : ''
          const template =
            index % 2 === 0
              ? SUGGESTION_TEMPLATES[0]
              : SUGGESTION_TEMPLATES[1]
          const deadline = new Date(now + template.days * 86400000).toISOString().slice(0, 10)
          return {
            id: `rct_${verdict.id}`,
            buildingId,
            pointId: verdict.pointId,
            problem: `${template.problem}：${point ? `${point.code} 实测 ${point.measuredOhm} Ω，限值 ${point.limitOhm} Ω` : '测点数据缺失'}`,
            suggestion: template.suggestion,
            deadline,
            state: index === 0 ? '待整改' : '已整改',
            owner: index === 0 ? '王振海' : '刘敏',
            ...stamp(2000 + index)
          }
        })
      if (rectifies.length > 0) {
        await db.rectifies.bulkPut(rectifies)
      } else {
        // 兜底：即使没有不合格点也生成一条演示整改单，保证整改页有内容
        await db.rectifies.put({
          id: 'rct_fallback',
          buildingId: buildings[0].id,
          pointId: allPoints[0]?.id ?? null,
          problem: '接地装置锈蚀巡检记录待补充',
          suggestion: SUGGESTION_TEMPLATES[1].suggestion,
          deadline: new Date(now + 30 * 86400000).toISOString().slice(0, 10),
          state: '待整改',
          owner: '王振海',
          ...stamp(3000)
        })
      }
    }
  )
}

/** 打开数据库并幂等播种：仅当建筑物表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.buildings.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.buildings, db.devices, db.instruments, db.calibrations, db.points, db.verdicts, db.rectifies],
    async () => {
      await Promise.all([
        db.buildings.clear(),
        db.devices.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.points.clear(),
        db.verdicts.clear(),
        db.rectifies.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与备份页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [buildings, devices, instruments, calibrations, points, verdicts, rectifies] = await Promise.all([
    db.buildings.count(),
    db.devices.count(),
    db.instruments.count(),
    db.calibrations.count(),
    db.points.count(),
    db.verdicts.count(),
    db.rectifies.count()
  ])
  return { buildings, devices, instruments, calibrations, points, verdicts, rectifies }
}

/** 写入结构版本号到 localStorage，便于备份页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastBuildingId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBuildingId)
  } catch {
    return null
  }
}

export function writeLastBuildingId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastBuildingId)
    else localStorage.setItem(LS_KEYS.lastBuildingId, id)
  } catch {
    // 忽略
  }
}

/** 建议限值透出（供表单默认值使用） */
export { suggestLimitOhm }
