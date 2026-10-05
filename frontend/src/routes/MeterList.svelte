<script lang="ts">
  /**
   * 模块：/meters 仪器台账与校准记录
   * 仪器与校准记录独立建账，与测点证据快照分开保存：
   * - 登记 / 注销仪器不触碰历史测点快照；
   * - 更正校准记录后，未签发测点退回待复测，已签发结论标记需补充（原依据保留）。
   */
  import StatBadge from '$lib/components/common/StatBadge.svelte'
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte'
  import {
    activeMeters,
    addCalibration,
    calibrationList,
    cancelMeter,
    correctCalibration,
    createMeter,
    meterList
  } from '$lib/stores/meterStore.ts'
  import { evidenceCounts, pointList } from '$lib/stores/pointStore.ts'
  import { issuedScope } from '$lib/stores/rectifyStore.ts'
  import { isCalibrationExpired, latestCalibrationOf } from '$lib/types/meter.ts'
  import type { Calibration, Meter } from '$lib/types/meter.ts'

  interface CalibrationForm {
    certificateNo: string
    calibratedAt: string
    validUntil: string
  }

  const today = new Date().toISOString().slice(0, 10)

  let notice = $state('')
  let formError = $state('')
  let busy = $state(false)
  let showMeterDialog = $state(false)
  let meterForm = $state({ code: '', name: '' })
  /** 校准弹窗模式：add=登记新校准，correct=更正已有记录（触发证据失效评估） */
  let calibrationMode = $state<'add' | 'correct'>('add')
  let calibrationMeterId = $state<string | null>(null)
  let editingCalibrationId = $state<string | null>(null)
  let showCalibrationDialog = $state(false)
  let calibrationForm = $state<CalibrationForm>({ certificateNo: '', calibratedAt: today, validUntil: '' })

  /** 每台仪器的关联测点数（按快照外键统计，注销后数字不变） */
  const pointCountByMeter = $derived.by(() => {
    const map = new Map<string, number>()
    $pointList.forEach((point) => {
      if (point.meterId) map.set(point.meterId, (map.get(point.meterId) ?? 0) + 1)
    })
    return map
  })

  const meterRows = $derived(
    [...$meterList]
      .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
      .map((meter) => ({
        meter,
        calibration: latestCalibrationOf($calibrationList, meter.id),
        pointCount: pointCountByMeter.get(meter.id) ?? 0
      }))
  )

  const calibrationRows = $derived(
    [...$calibrationList]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((calibration) => ({
        calibration,
        meter: $meterList.find((meter) => meter.id === calibration.meterId) ?? null
      }))
  )

  function meterOfCalibration(calibration: Calibration): Meter | null {
    return $meterList.find((meter) => meter.id === calibration.meterId) ?? null
  }

  function openMeterDialog(): void {
    meterForm = { code: '', name: '' }
    formError = ''
    showMeterDialog = true
  }

  async function submitMeter(): Promise<void> {
    busy = true
    try {
      const meter = await createMeter(meterForm)
      notice = `仪器 ${meter.name}（${meter.code}）已登记，请继续登记其校准记录。`
      showMeterDialog = false
    } catch (error) {
      formError = error instanceof Error ? error.message : '保存失败'
    } finally {
      busy = false
    }
  }

  function openAddCalibration(meter: Meter): void {
    calibrationMode = 'add'
    calibrationMeterId = meter.id
    editingCalibrationId = null
    calibrationForm = { certificateNo: '', calibratedAt: today, validUntil: '' }
    formError = ''
    showCalibrationDialog = true
  }

  function openCorrectCalibration(calibration: Calibration): void {
    calibrationMode = 'correct'
    calibrationMeterId = calibration.meterId
    editingCalibrationId = calibration.id
    calibrationForm = {
      certificateNo: calibration.certificateNo,
      calibratedAt: calibration.calibratedAt,
      validUntil: calibration.validUntil
    }
    formError = ''
    showCalibrationDialog = true
  }

  async function submitCalibration(): Promise<void> {
    if (!calibrationForm.validUntil) {
      formError = '请填写校准有效期'
      return
    }
    busy = true
    try {
      if (calibrationMode === 'add') {
        if (!calibrationMeterId) return
        await addCalibration(calibrationMeterId, calibrationForm)
        notice = '校准记录已登记；新录入测点将按最新校准有效期固化证据快照。'
      } else if (editingCalibrationId) {
        const result = await correctCalibration(editingCalibrationId, calibrationForm)
        notice = `校准记录已更正（第 ${result.revision} 次）：${result.retest} 个未签发测点退回待复测，${result.supplement} 条已签发结论标记为需补充（原依据保留）。`
      }
      showCalibrationDialog = false
    } catch (error) {
      formError = error instanceof Error ? error.message : '保存失败'
    } finally {
      busy = false
    }
  }

  async function confirmCancelMeter(meter: Meter): Promise<void> {
    const count = pointCountByMeter.get(meter.id) ?? 0
    const ok = window.confirm(
      `注销仪器「${meter.name} / ${meter.code}」？\n注销后不能再登记校准、不能用于新测点；已录入的 ${count} 个测点证据快照保持原样，不随台账变化。`
    )
    if (!ok) return
    busy = true
    try {
      await cancelMeter(meter.id)
      notice = `仪器 ${meter.code} 已注销；历史测点快照不受影响。`
    } catch (error) {
      notice = error instanceof Error ? error.message : '注销失败'
    } finally {
      busy = false
    }
  }
</script>

<section class="page">
  <div class="gb-brand-bar"></div>

  <div class="page__head">
    <div>
      <h2 class="page__title">仪器台账与校准记录</h2>
      <p class="gb-hint">
        仪器与校准记录独立建账；测点录入时固定仪器编号与当次校准有效期，此后台账变更不影响已录入快照。
        更正校准记录会使未签发测点退回待复测，已签发结论保留原依据并标记需补充。
      </p>
    </div>
    <div class="page__actions">
      <button class="btn btn--primary" type="button" onclick={openMeterDialog}>＋ 登记仪器</button>
    </div>
  </div>

  {#if notice}
    <p class="gb-alert">{notice}</p>
  {/if}

  <div class="gb-stats-row">
    <StatBadge label="在用仪器" value={$activeMeters.length} suffix="台" tone="primary" />
    <StatBadge
      label="已注销"
      value={$meterList.length - $activeMeters.length}
      suffix="台"
      tone={$meterList.length - $activeMeters.length > 0 ? 'warning' : 'default'}
    />
    <StatBadge label="校准记录" value={$calibrationList.length} suffix="条" tone="info" />
    <StatBadge
      label="待复测测点"
      value={$evidenceCounts['待复测']}
      suffix="点"
      tone={$evidenceCounts['待复测'] > 0 ? 'danger' : 'success'}
    />
    <StatBadge
      label="需补充结论"
      value={$issuedScope.needsSupplement}
      suffix="条"
      tone={$issuedScope.needsSupplement > 0 ? 'warning' : 'success'}
    />
  </div>

  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>仪器台账（{$meterList.length} 台）</h3>
      <span class="gb-hint">注销只改台账状态，历史测点快照保持原样</span>
    </div>
    {#if meterRows.length === 0}
      <EmptyPanel
        title="还没有仪器"
        description="先登记检测仪器与其校准记录，录入测点时才能固化仪器编号与校准有效期。"
        actionText="登记仪器"
        onAction={openMeterDialog}
        compact
      />
    {:else}
      <table class="gb-table">
        <thead>
          <tr>
            <th>仪器编号</th>
            <th>仪器名称</th>
            <th>状态</th>
            <th>当前校准</th>
            <th class="is-num">关联测点</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each meterRows as row (row.meter.id)}
            <tr>
              <td class="gb-mono">{row.meter.code}</td>
              <td>{row.meter.name}</td>
              <td>
                <span class="gb-tag" class:is-cancelled={row.meter.state === '注销'}>{row.meter.state}</span>
              </td>
              <td>
                {#if row.calibration}
                  <div class="gb-mono">{row.calibration.certificateNo || '未填证书号'}</div>
                  <div class="gb-hint">
                    {#if row.calibration.validUntil}
                      有效期至 {row.calibration.validUntil}
                      {#if isCalibrationExpired(row.calibration.validUntil, today)}
                        <span class="gb-danger">（已过期）</span>
                      {/if}
                    {:else}
                      有效期未登记
                    {/if}
                  </div>
                {:else}
                  <span class="gb-hint">尚未登记校准</span>
                {/if}
              </td>
              <td class="is-num gb-mono">{row.pointCount}</td>
              <td class="row-actions">
                {#if row.meter.state === '在用'}
                  <button class="btn btn--small" type="button" disabled={busy} onclick={() => openAddCalibration(row.meter)}>
                    登记校准
                  </button>
                  <button
                    class="btn btn--danger btn--small"
                    type="button"
                    disabled={busy}
                    onclick={() => confirmCancelMeter(row.meter)}
                  >
                    注销
                  </button>
                {:else}
                  <span class="gb-hint">已注销</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <div class="gb-panel">
    <div class="gb-panel-title">
      <h3>校准记录（{$calibrationList.length} 条）</h3>
      <span class="gb-hint">更正记录会触发受影响测点的证据失效评估，且操作幂等可重试</span>
    </div>
    {#if calibrationRows.length === 0}
      <EmptyPanel title="还没有校准记录" description="在仪器台账中点击「登记校准」，记录证书编号与有效期。" compact />
    {:else}
      <table class="gb-table">
        <thead>
          <tr>
            <th>仪器</th>
            <th>证书编号</th>
            <th>校准日期</th>
            <th>有效期至</th>
            <th class="is-num">更正次数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each calibrationRows as row (row.calibration.id)}
            {@const meter = meterOfCalibration(row.calibration)}
            <tr>
              <td>
                {#if meter}
                  <div>{meter.name}</div>
                  <div class="gb-hint gb-mono">{meter.code}{meter.state === '注销' ? '（已注销）' : ''}</div>
                {:else}
                  <span class="gb-hint">仪器已删除</span>
                {/if}
              </td>
              <td class="gb-mono">{row.calibration.certificateNo || '—'}</td>
              <td class="gb-mono">{row.calibration.calibratedAt || '未登记'}</td>
              <td class="gb-mono">
                {#if row.calibration.validUntil}
                  {row.calibration.validUntil}
                  {#if isCalibrationExpired(row.calibration.validUntil, today)}
                    <span class="gb-danger">（已过期）</span>
                  {/if}
                {:else}
                  未登记
                {/if}
              </td>
              <td class="is-num gb-mono">{row.calibration.revision}</td>
              <td class="row-actions">
                <button
                  class="btn btn--small"
                  type="button"
                  disabled={busy}
                  onclick={() => openCorrectCalibration(row.calibration)}
                >
                  更正
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

{#if showMeterDialog}
  <div class="gb-modal-backdrop" role="presentation" onclick={() => (showMeterDialog = false)}>
    <div
      class="gb-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event: MouseEvent) => event.stopPropagation()}
      onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
    >
      <div class="gb-modal__head">
        <h3>登记仪器</h3>
        <button class="gb-modal__close" type="button" onclick={() => (showMeterDialog = false)}>×</button>
      </div>
      <div class="gb-modal__body">
        {#if formError}
          <p class="gb-alert">{formError}</p>
        {/if}
        <div class="gb-modal__grid">
          <label class="gb-field">
            <span>仪器编号 *</span>
            <input bind:value={meterForm.code} placeholder="如 No.20230517" maxlength="40" />
          </label>
          <label class="gb-field">
            <span>仪器名称 *</span>
            <input bind:value={meterForm.name} placeholder="如 ZC-8 接地电阻测试仪" maxlength="40" />
          </label>
        </div>
        <p class="gb-hint">仪器编号全局唯一，测点录入时按编号固化证据快照；登记后请在台账中补充校准记录。</p>
      </div>
      <div class="gb-modal__foot">
        <button class="btn" type="button" onclick={() => (showMeterDialog = false)}>取消</button>
        <button class="btn btn--primary" type="button" disabled={busy} onclick={submitMeter}>登记</button>
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
        <h3>{calibrationMode === 'add' ? '登记校准记录' : '更正校准记录'}</h3>
        <button class="gb-modal__close" type="button" onclick={() => (showCalibrationDialog = false)}>×</button>
      </div>
      <div class="gb-modal__body">
        {#if formError}
          <p class="gb-alert">{formError}</p>
        {/if}
        {#if calibrationMode === 'correct'}
          <p class="gb-alert">
            更正后：引用该记录的未签发测点将退回「待复测」，已签发结论保留原依据并标记「需补充」；
            测点已固化的快照本身不会被改写。
          </p>
        {/if}
        <div class="gb-modal__grid">
          <label class="gb-field">
            <span>校准证书编号</span>
            <input bind:value={calibrationForm.certificateNo} placeholder="如 JL2026-0318" maxlength="40" />
          </label>
          <label class="gb-field">
            <span>校准日期</span>
            <input type="date" bind:value={calibrationForm.calibratedAt} />
          </label>
          <label class="gb-field">
            <span>有效期至 *</span>
            <input type="date" bind:value={calibrationForm.validUntil} />
          </label>
        </div>
      </div>
      <div class="gb-modal__foot">
        <button class="btn" type="button" onclick={() => (showCalibrationDialog = false)}>取消</button>
        <button class="btn btn--primary" type="button" disabled={busy} onclick={submitCalibration}>
          {calibrationMode === 'add' ? '登记' : '确认更正'}
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

  .gb-tag.is-cancelled {
    color: #8c8479;
    border-color: #d8d2c8;
    background: #f4f2ee;
  }
</style>
