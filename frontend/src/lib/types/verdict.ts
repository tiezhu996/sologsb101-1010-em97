/**
 * 判定结论。
 *
 * 结论签发（confirmed=true）时把当次实测值、限值与仪器证据快照复制进
 * issuedSnapshot 冻结保存：此后测点改值、仪器注销、校准记录更正都不影响
 * 已签发结论的原依据；若原依据被动过，测点证据状态会变为「需补充」，
 * 但本记录仍显示签发时的原始依据，等待复测补充而不是被悄悄改写。
 */
export type VerdictResult = '合格' | '不合格' | '待判定'

export const VERDICT_RESULTS: VerdictResult[] = ['合格', '不合格', '待判定']

/** 签发时冻结的依据快照（与测点证据快照分离保存） */
export interface IssuedEvidence {
  /** 签发时实测电阻（Ω） */
  measuredOhm: number
  /** 签发时限值（Ω） */
  limitOhm: number
  /** 签发时检测日期 */
  measureDate: string
  /** 仪器编号 */
  meterId: string
  /** 仪器名称与型号 */
  meterName: string
  /** 校准证书编号 */
  certificateNo: string
  /** 当次校准有效期至 */
  calibrationValidUntil: string
  /** 冻结时间戳（签发时间） */
  issuedAt: number
}

/** 判定：实测值与限值比对后的结论，检测人确认（签发）后生效且冻结依据 */
export interface Verdict {
  id: string
  /** 被判定的测点 */
  pointId: string
  /** 判定结论 */
  result: VerdictResult
  /** 判定依据（规范条款 / 限值来源） */
  basis: string
  /** 检测人 */
  inspector: string
  /** 判定日期 */
  verdictDate: string
  /** 是否已由检测人确认（签发）生效；签发后不再跟随测点与仪器台账变化 */
  confirmed: boolean
  /** 签发时冻结的原始依据（未签发时为 null；退回复测后保留到再次签发覆盖） */
  issuedSnapshot: IssuedEvidence | null
  createdAt: number
  updatedAt: number
}

/** 自动初判：实测值 ≤ 限值判合格，否则不合格 */
export function judgePoint(measuredOhm: number, limitOhm: number): VerdictResult {
  if (!Number.isFinite(measuredOhm) || !Number.isFinite(limitOhm) || limitOhm <= 0) return '待判定'
  return measuredOhm <= limitOhm ? '合格' : '不合格'
}

/** 判定依据模板：按防雷类别与装置类型给出常用条款说明 */
export function defaultBasis(protectionClass: string, deviceType: string, limitOhm: number): string {
  const clause =
    protectionClass === '一类'
      ? 'GB 50057-2010 第 4.3 节'
      : protectionClass === '二类'
        ? 'GB 50057-2010 第 4.4 节'
        : 'GB 50057-2010 第 4.5 节'
  return `${clause}：${protectionClass}防雷建筑物${deviceType}接地电阻不大于 ${limitOhm} Ω`
}

/** 由测点证据快照组装签发冻结依据 */
export function buildIssuedEvidence(input: {
  measuredOhm: number
  limitOhm: number
  measureDate: string
  meterId: string
  meterName: string
  certificateNo: string
  calibrationValidUntil: string
  issuedAt?: number
}): IssuedEvidence {
  return {
    measuredOhm: input.measuredOhm,
    limitOhm: input.limitOhm,
    measureDate: input.measureDate,
    meterId: input.meterId,
    meterName: input.meterName,
    certificateNo: input.certificateNo,
    calibrationValidUntil: input.calibrationValidUntil,
    issuedAt: input.issuedAt ?? Date.now()
  }
}
