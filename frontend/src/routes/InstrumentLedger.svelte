<script lang="ts">
  /**
   * 模块：/instruments 仪器台账与校准记录
   *
   * - 仪器台账（编号/名称/状态）与测点证据快照分离保存：
   *   仪器更名、注销不回改任何已录入测点与已签发依据；
   * - 校准记录可登记多条；「更正」校准日期/有效期会联动：
   *   未签发受影响测点退回待复测，已签发结果保留原依据并标记「需补充」；
   * - 注销仪器仅停用，不删除快照；联动操作均为幂等，重试不重复失效。
   */
  import StatBadge from '$lib/components/common/StatBadge.svelte'
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte'
  import {
    calibrationList,
    correctCalibration,
    createCalibration,
    createInstrument,
    instrumentList,
    instrumentRows,
    removeCalibration,
    setInstrumentStatus,
    updateInstrument
  } from '$lib/stores/instrumentStore.ts'
  import { pointList } from '$lib/stores/pointStore.ts'
  import { INSTRUMENT_STATUSES } from '$lib/types/instrument.ts'
  import type { Instrument, InstrumentDraft, InstrumentStatus } from '$lib/types/instrument.ts'
  import type { Calibration, CalibrationDraft } from '$lib/types/calibration.ts'
  import { calibrationState } from '$lib/types/calibration.ts'

  let notice = $state('')
  let showInstrumentDialog = $state(false)
  let editingInstrumentId = $state<string | null>(null)
  let instrumentFormError = $state('')
  let instrumentForm = $state<InstrumentDraft>({ code: '', name: '', spec: '', manufacturer: '', remark: '' })

  let expandedInstrumentId = $state<string | null>(null)
  let showCalibrationDialog = $state(false)
  let editingCalibrationId = $state<string | null>(null)
  let calibrationInstrumentId = $state<string>('')
  let calibrationFormError = $state('')
  let calibrationForm = $state<CalibrationDraft>({
    agency: '',
    certificateNo: '',
    calibrateDate: new Date().toISOString().slice(0, 10),
    validUntil: '',
    conclusion: ''
  })

  const today = $derived(new Date().toISOString().slice(0, 10))

  const inUseCount = $derived($instrumentList.filter((item) => item.status === '在用').length)
  const expiredCount = $derived(
    $instrumentRows.filter((row) => row.instrument.status === '在用' && row.calState !== '有效').length
  )
  const pendingEvidenceCount = $derived(
    $pointList.filter((point) => point.evidence && point.evidence.status !== '有效').length
  )

  function openInstrumentCreate(): void {
    editingInstrumentId = null
    instrumentFormError = ''
    instrumentForm = { code: '', name: '', spec: '', manufacturer: '', remark: '' }
    showInstrumentDialog = true
  }

  function openInstrumentEdit(instrument: Instrument): void {
    editingInstrumentId = instrument.id
    instrumentFormError = ''
    instrumentForm = {
      code: instrument.code,
      name: instrument.name,
      spec: instrument.spec,
      manufacturer: instrument.manufacturer,
      remark: instrument.remark
    }
    showInstrumentDialog = true
  }

  async function submitInstrument(): Promise<void> {
    if (!instrumentForm.code.trim()) {
      instrumentFormError = '请填写仪器编号（测点证据快照按此编号追溯）'
      return
    }
    if (!instrumentForm.name.trim()) {
      instrumentFormError = '请填写仪器名称与型号'
      return
    }
    try {
      if (editingInstrumentId) {
        await updateInstrument(editingInstrumentId, instrumentForm)
        notice = '仪器台账已更新；历史测点证据快照保持录入时内容不变。'
      } else {
        await createInstrument(instrumentForm)
        notice = `仪器「${instrumentForm.code}」已登记，登记校准记录后即可用于测点录入。`
      }
      showInstrumentDialog = false
    } catch (error) {
      instrumentFormError = error instanceof Error ? error.message : '保存失败'
    }
  }

  async function toggleRetire(instrument: Instrument): Promise<void> {
    const next: InstrumentStatus = instrument.status === '注销' ? '在用' : '注销'
    if (next === '注销') {
      const using = $pointList.filter((point) => point.evidence?.meterId === instrument.code).length
      const ok = window.confirm(
        `注销仪器「${instrument.code}」后不能再用于录入新测点。\n已有 ${using} 个测点的证据快照与已签发依据不会被改动，仍可追溯。确认注销？`
      )
      if (!ok) return
    }
    await setInstrumentStatus(instrument.id, next)
    notice =
      next === '注销'
        ? '仪器已注销：历史测点证据快照原样保留，仅禁止录入新测点。'
        : '仪器已恢复在用。'
  }

  function toggleExpand(instrumentId: string): void {
    expandedInstrumentId = expandedInstrumentId === instrumentId ? null : instrumentId
  }

  function openCalibrationCreate(instrumentId: string): void {
    editingCalibrationId = null
    calibrationInstrumentId = instrumentId
    calibrationFormError = ''
    calibrationForm = {
      agency: '',
      certificateNo: '',
      calibrateDate: today,
      validUntil: '',
      conclusion: ''
    }
    showCalibrationDialog = true
  }

  function openCalibrationEdit(calibration: Calibration): void {
    editingCalibrationId = calibration.id
    calibrationInstrumentId = calibration.instrumentId
    calibrationFormError = ''
    calibrationForm = {
      agency: calibration.agency,
      certificateNo: calibration.certificateNo,
      calibrateDate: calibration.calibrateDate,
      validUntil: calibration.validUntil,
      conclusion: calibration.conclusion
    }
    showCalibrationDialog = true
  }

  async function submitCalibration(): Promise<void> {
    if (!calibrationForm.calibrateDate) {
      calibrationFormError = '请填写校准日期'
      return
    }
    if (!calibrationForm.validUntil) {
      calibrationFormError = '请填写校准有效期至（录入测点时固定该日期）'
      return
    }
    if (calibrationForm.validUntil < calibrationForm.calibrateDate) {
      calibrationFormError = '有效期至不能早于校准日期'
      return
    }
    if (editingCalibrationId) {
      const usedCount = $pointList.filter((point) => point.evidence?.calibrationId === editingCalibrationId).length
      const before = $calibrationList.find((item) => item.id === editingCalibrationId)
      const windowChanged =
        before && (before.calibrateDate !== calibrationForm.calibrateDate || before.validUntil !== calibrationForm.validUntil)
      if (windowChanged && usedCount > 0) {
        const ok = window.confirm(
          `校准日期/有效期更正将联动 ${usedCount} 个引用该证书的测点：\n` +
            '· 尚未签发的测点退回「待复测」；\n· 已签发结果保留原依据，证据标「需补充」。\n确认更正？'
        )
        if (!ok) return
      }
      const result = await correctCalibration(editingCalibrationId, calibrationForm)
      notice =
        result.retested > 0 || result.supplement > 0
          ? `校准记录已更正：${result.retested} 个未签发测点退回待复测，${result.supplement} 个已签发结果保留原依据并标记需补充。`
          : '校准记录已更新，未影响已录入测点。'
    } else {
      await createCalibration(calibrationInstrumentId, calibrationForm)
      notice = '校准记录已登记；之后录入的测点会固定本次有效期。'
    }
    showCalibrationDialog = false
  }

  async function confirmRemoveCalibration(calibration: Calibration): Promise<void> {
    const usedCount = $pointList.filter((point) => point.evidence?.calibrationId === calibration.id).length
    const ok = window.confirm(
      `撤销校准证书「${calibration.certificateNo || calibration.id}」？\n` +
        (usedCount > 0
          ? `将联动 ${usedCount} 个测点：未签发退回待复测，已签发保留原依据并标记需补充。`
          : '当前没有测点引用该证书。')
    )
    if (!ok) return
    const result = await removeCalibration(calibration.id)
    notice = `证书已撤销：${result.retested} 个测点退回待复测，${result.supplement} 个已签发结果标记需补充。`
  }

  function stateTone(state: string): string {
    if (state === '有效') return 'color:#1e8449;background:#eaf6ee;'
    if (state === '即将到期') return 'color:#9a6a00;background:#fdf3d7;'
    return 'color:#c0392b;background:#fdecea;'
  }
</script>

<section class="page">
  <div class="gb-brand-bar"></div>

  <div class="page__head">
    <div>
      <h2 class="page__title">仪器台账与校准记录</h2>
      <p class="gb-hint">
        仪器名称与校准有效期在测点录入时固定为证据快照；台账更名、证书更正、仪器注销都不会回改历史快照。
        校准有效期更正后，未签发测点退回待复测，已签发结果保留原依据并提示需补充。
      </p>
    </div>
    <div class="page__actions">
      <button class="btn btn--primary" type="button" onclick={openInstrumentCreate}>＋ 登记仪器</button>
    </div>
  </div>

  {#if notice}
    <p class="gb-alert">{notice}</p>
  {/if}

  <div class="gb-stats-row">
    <StatBadge label="仪器总数" value={$instrumentRows.length} suffix="台" tone="primary" />
    <StatBadge label="在用" value={inUseCount} suffix="台" tone="success" />
    <StatBadge label="校准异常（在用）" value={expiredCount} suffix="台" tone={expiredCount > 0 ? 'danger' : 'success'} />
    <StatBadge label="证据待处理测点" value={pendingEvidenceCount} suffix="点" tone={pendingEvidenceCount > 0 ? 'warning' : 'success'} />
  </div>

  {#if $instrumentRows.length === 0}
    <EmptyPanel
      title="还没有登记检测仪器"
      description="先登记仪器（如 ZC-8 接地电阻测试仪）并录入校准有效期，测点录入时才能固定仪器编号与校准依据。"
      actionText="登记仪器"
      onAction={openInstrumentCreate}
    />
  {:else}
    <div class="gb-panel">
      <div class="gb-panel-title">
        <h3>仪器台账</h3>
        <span class="gb-hint">展开可登记 / 更正校准记录；注销只停用仪器，不改动任何测点证据。</span>
      </div>
      <table class="gb-table">
        <thead>
          <tr>
            <th>仪器编号</th>
            <th>名称 / 型号</th>
            <th>生产厂家</th>
            <th class="is-num">校准记录</th>
            <th>最新校准有效期</th>
            <th>校准状态</th>
            <th>台账状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each $instrumentRows as row (row.instrument.id)}
            <tr class:is-retired={row.instrument.status === '注销'}>
              <td class="gb-mono">{row.instrument.code}</td>
              <td>
                <div>{row.instrument.name}</div>
                <div class="gb-hint">{row.instrument.spec}</div>
              </td>
              <td class="gb-hint">{row.instrument.manufacturer || '—'}</td>
              <td class="is-num gb-mono">{row.calibrationCount}</td>
              <td class="gb-mono">{row.latest?.validUntil ?? '—'}</td>
              <td>
                <span class="state-tag" style={stateTone(row.instrument.status === '注销' ? '已注销' : row.calState)}>
                  {row.instrument.status === '注销' ? '已注销' : row.calState}
                </span>
              </td>
              <td>
                <span class="gb-tag">{row.instrument.status}</span>
                {#if row.instrument.retiredAt}
                  <div class="gb-hint">{row.instrument.retiredAt}</div>
                {/if}
              </td>
              <td class="row-actions">
                <button class="btn btn--small" type="button" onclick={() => toggleExpand(row.instrument.id)}>
                  {expandedInstrumentId === row.instrument.id ? '收起校准' : '校准记录'}
                </button>
                <button class="btn btn--small" type="button" onclick={() => openInstrumentEdit(row.instrument)}>编辑</button>
                <button
                  class="btn {row.instrument.status === '注销' ? 'btn--primary' : 'btn--danger'} btn--small"
                  type="button"
                  onclick={() => toggleRetire(row.instrument)}
                >
                  {row.instrument.status === '注销' ? '恢复在用' : '注销'}
                </button>
              </td>
            </tr>
            {#if expandedInstrumentId === row.instrument.id}
              <tr class="cal-row">
                <td colspan="8">
                  <div class="cal-head">
                    <strong>{row.instrument.name} / {row.instrument.code} 的校准记录</strong>
                    <button class="btn btn--small btn--primary" type="button" onclick={() => openCalibrationCreate(row.instrument.id)}>
                      ＋ 登记校准
                    </button>
                  </div>
                  {#if row.calibrations.length === 0}
                    <p class="gb-hint">尚无校准记录，该仪器不能用于测点录入（证据将归入待补证）。</p>
                  {:else}
                    <table class="gb-table cal-table">
                      <thead>
                        <tr>
                          <th>校准机构</th>
                          <th>证书编号</th>
                          <th>校准日期</th>
                          <th>有效期至</th>
                          <th>状态</th>
                          <th>结论 / 更正说明</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each row.calibrations as calibration (calibration.id)}
                          <tr>
                            <td>{calibration.agency || '—'}</td>
                            <td class="gb-mono">{calibration.certificateNo || '—'}</td>
                            <td class="gb-mono">{calibration.calibrateDate}</td>
                            <td class="gb-mono">{calibration.validUntil}</td>
                            <td>
                              <span class="state-tag" style={stateTone(calibrationState(calibration.validUntil, today))}>
                                {calibrationState(calibration.validUntil, today)}
                              </span>
                            </td>
                            <td class="gb-hint">
                              {calibration.conclusion || '—'}
                              {#if calibration.correctionNote}
                                <div class="gb-danger">更正：{calibration.correctionNote}</div>
                              {/if}
                            </td>
                            <td class="row-actions">
                              <button class="btn btn--small" type="button" onclick={() => openCalibrationEdit(calibration)}>更正</button>
                              <button class="btn btn--danger btn--small" type="button" onclick={() => confirmRemoveCalibration(calibration)}>
                                撤销
                              </button>
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <p class="gb-hint">
    追溯原则：测点保存的是录入当次的仪器编号与校准有效期快照；本页任何修改都只影响之后新录入的测点，
    已签发结论以签发时冻结的依据为准，需变更时走「退回待复测 → 复测 → 重新签发」。
  </p>
</section>

{#if showInstrumentDialog}
  <div class="gb-modal-backdrop" role="presentation" onclick={() => (showInstrumentDialog = false)}>
    <div
      class="gb-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event: MouseEvent) => event.stopPropagation()}
      onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
    >
      <div class="gb-modal__head">
        <h3>{editingInstrumentId ? '编辑仪器台账' : '登记检测仪器'}</h3>
        <button class="gb-modal__close" type="button" onclick={() => (showInstrumentDialog = false)}>×</button>
      </div>
      <div class="gb-modal__body">
        {#if instrumentFormError}
          <p class="gb-alert">{instrumentFormError}</p>
        {/if}
        <div class="gb-modal__grid">
          <label class="gb-field">
            <span>仪器编号 *（测点快照引用，创建后不可改）</span>
            <input
              bind:value={instrumentForm.code}
              placeholder="如 No.20230517"
              maxlength="40"
              disabled={editingInstrumentId !== null}
            />
          </label>
          <label class="gb-field">
            <span>名称与型号 *</span>
            <input bind:value={instrumentForm.name} placeholder="如 ZC-8 接地电阻测试仪" maxlength="60" />
          </label>
          <label class="gb-field">
            <span>规格 / 量程</span>
            <input bind:value={instrumentForm.spec} placeholder="如 0~100 Ω" maxlength="40" />
          </label>
          <label class="gb-field">
            <span>生产厂家</span>
            <input bind:value={instrumentForm.manufacturer} placeholder="如 上海第六电表厂" maxlength="40" />
          </label>
        </div>
        <label class="gb-field">
          <span>备注</span>
          <textarea rows="2" bind:value={instrumentForm.remark} maxlength="120"></textarea>
        </label>
        {#if editingInstrumentId}
          <p class="gb-hint">
            仪器编号是历史测点证据的追溯键，不允许修改；名称等台账信息的更正不会回改已录入快照。
            注销/启用请在列表中操作（{INSTRUMENT_STATUSES.join(' / ')}）。
          </p>
        {/if}
      </div>
      <div class="gb-modal__foot">
        <button class="btn" type="button" onclick={() => (showInstrumentDialog = false)}>取消</button>
        <button class="btn btn--primary" type="button" onclick={submitInstrument}>
          {editingInstrumentId ? '保存修改' : '登记仪器'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showCalibrationDialog}
  <div class="gb-modal-backdrop" role="presentation" onclick={() => (showCalibrationDialog = false)}>
    <div
      class="gb-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event: MouseEvent) => event.stopPropagation()}
      onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
    >
      <div class="gb-modal__head">
        <h3>{editingCalibrationId ? '更正校准记录' : '登记校准记录'}</h3>
        <button class="gb-modal__close" type="button" onclick={() => (showCalibrationDialog = false)}>×</button>
      </div>
      <div class="gb-modal__body">
        {#if calibrationFormError}
          <p class="gb-alert">{calibrationFormError}</p>
        {/if}
        <div class="gb-modal__grid">
          <label class="gb-field">
            <span>校准 / 送检机构</span>
            <input bind:value={calibrationForm.agency} placeholder="如 市计量测试研究院" maxlength="40" />
          </label>
          <label class="gb-field">
            <span>证书编号</span>
            <input bind:value={calibrationForm.certificateNo} placeholder="如 JL-2026-0517" maxlength="40" />
          </label>
          <label class="gb-field">
            <span>校准日期 *</span>
            <input type="date" bind:value={calibrationForm.calibrateDate} />
          </label>
          <label class="gb-field">
            <span>有效期至 *（测点录入时固定）</span>
            <input type="date" bind:value={calibrationForm.validUntil} />
          </label>
        </div>
        <label class="gb-field">
          <span>校准结论</span>
          <textarea rows="2" bind:value={calibrationForm.conclusion} maxlength="120"></textarea>
        </label>
        {#if editingCalibrationId}
          <p class="gb-hint">
            仅更改机构、证书号、结论文字不影响测点；更改校准日期或有效期将联动引用该证书的测点：
            未签发退回待复测、已签发保留原依据并标记需补充（重复提交不会重复失效）。
          </p>
        {/if}
      </div>
      <div class="gb-modal__foot">
        <button class="btn" type="button" onclick={() => (showCalibrationDialog = false)}>取消</button>
        <button class="btn btn--primary" type="button" onclick={submitCalibration}>
          {editingCalibrationId ? '保存更正' : '登记校准'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .page__head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .page__title {
    margin: 0 0 4px;
    font-size: 19px;
    color: #1d3557;
  }

  .page__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  tr.is-retired td {
    color: #8c8479;
    background: #f6f5f2;
  }

  .cal-row td {
    background: #f8fafc;
    padding: 12px 16px;
  }

  .cal-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .cal-table {
    margin-top: 6px;
  }

  .state-tag {
    display: inline-block;
    padding: 1px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
</style>
