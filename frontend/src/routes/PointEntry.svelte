<script lang="ts">
  /**
   * 模块 3：/points 接地电阻测点录入
   * 逐点录实测电阻与限值、支持批量粘贴；按装置筛选汇总，复用 <FilterBar>、<QualifyTag>。
   */
  import FilterBar from '$lib/components/common/FilterBar.svelte'
  import type { FilterChange } from '$lib/components/common/FilterBar.svelte'
  import QualifyTag from '$lib/components/common/QualifyTag.svelte'
  import StatBadge from '$lib/components/common/StatBadge.svelte'
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte'
  import {
    activeDeviceId,
    bulkSetMeasured,
    createPoint,
    importPointRows,
    pasteText,
    pendingEvidencePoints,
    pointList,
    pointRows,
    pointsOfDevice,
    removePoint,
    setActiveDevice,
    updatePoint
  } from '$lib/stores/pointStore.ts'
  import { buildingById, deviceList, selectBuilding } from '$lib/stores/buildingStore.ts'
  import { meterOptionsForMeasureDate } from '$lib/stores/instrumentStore.ts'
  import { parsePointPaste } from '$lib/types/point.ts'
  import type { Point, PointPasteRow } from '$lib/types/point.ts'
  import { DEVICE_TYPES } from '$lib/types/device.ts'
  import type { DeviceType } from '$lib/types/device.ts'
  import { isQualified, limitRatio, qualifyRate, suggestLimitOhm } from '$lib/utils/resistance.ts'
  import { readQuery, writeQuery } from '$lib/utils/query.ts'
  import { useRouter } from '$lib/utils/router.ts'

  const { push } = useRouter()

  interface PointForm {
    code: string
    location: string
    measuredOhm: number
    limitOhm: number
    /** 选择仪器台账中的仪器编号；证据快照保存编号 + 当次校准有效期 */
    meterId: string
    measureDate: string
  }

  const query = readQuery()
  if (query.device) {
    setActiveDevice(query.device)
    const target = $deviceList.find((device) => device.id === query.device)
    if (target) selectBuilding(target.buildingId)
  }

  let keyword = $state('')
  let typeFilter = $state<DeviceType[]>([...DEVICE_TYPES])
  let showDialog = $state(false)
  let editingId = $state<string | null>(null)
  let formError = $state('')
  let showPaste = $state(false)
  let pasteErrors = $state<string[]>([])
  let pastePreview = $state<PointPasteRow[]>([])
  let bulkValue = $state<number | null>(null)
  /** 批量粘贴导入使用的仪器编号（导入的新测点按它冻结证据） */
  let pasteMeterId = $state('')

  let form = $state<PointForm>({
    code: '',
    location: '',
    measuredOhm: 0,
    limitOhm: 10,
    meterId: '',
    measureDate: new Date().toISOString().slice(0, 10)
  })

  /** 表单当前编辑的测点（用于判断是否已签发、是否会触发退回待复测） */
  let editingPoint = $state<Point | null>(null)

  const meterOptions = $derived(meterOptionsForMeasureDate(form.measureDate || new Date().toISOString().slice(0, 10)))
  const selectedMeter = $derived(meterOptions.find((option) => option.value === form.meterId) ?? null)

  const deviceOptions = $derived(
    $deviceList.map((device) => {
      const building = buildingById(device.buildingId)
      return {
        label: `${building?.name ?? '未知建筑物'} · ${device.type}${device.spec ? ` ${device.spec}` : ''}`,
        value: device.id
      }
    })
  )

  const filterValues = $derived<Record<string, string | string[]>>({
    deviceIds: $activeDeviceId === null ? [] : [$activeDeviceId],
    types: typeFilter as string[]
  })

  /** 表格行：带装置与建筑物信息、合格标记 */
  const rows = $derived(
    $pointRows.filter((row) => {
      if (typeFilter.length > 0 && !typeFilter.includes(row.deviceType as DeviceType)) return false
      const device = row.device
      if (!device) return false
      const building = buildingById(device.buildingId)
      const text = `${row.point.code}${row.point.location}${row.point.evidence?.meterId ?? ''}${row.point.evidence?.meterName ?? ''}${building?.name ?? ''}${device.material}`
      return keyword.trim().length === 0 || text.includes(keyword.trim())
    })
  )

  const totals = $derived({
    points: rows.length,
    unqualified: rows.filter((row) => !row.qualified).length,
    rate: qualifyRate(rows.map((row) => row.qualified)),
    activeDevicePoints: $activeDeviceId ? pointsOfDevice($activeDeviceId).length : $pointList.length,
    pendingEvidence: $pendingEvidencePoints.length
  })

  const activeDevice = $derived(
    $activeDeviceId ? $deviceList.find((device) => device.id === $activeDeviceId) ?? null : null
  )
  const activeBuilding = $derived(activeDevice ? buildingById(activeDevice.buildingId) : null)
  const defaultLimit = $derived(
    activeDevice ? suggestLimitOhm(activeBuilding?.protectionClass ?? '三类', activeDevice.type) : 10
  )

  function openCreate(): void {
    if (!$activeDeviceId) {
      window.alert('请先在筛选栏选择一条防雷装置，再录入该装置的测点。')
      return
    }
    editingId = null
    editingPoint = null
    formError = ''
    const existing = pointsOfDevice($activeDeviceId)
    const index = existing.length + 1
    // 默认沿用同装置最近一个测点的仪器编号（仍可改选其他在用且校准有效的仪器）
    const defaultMeterId = existing.find((point) => point.evidence?.meterId)?.evidence.meterId ?? ''
    form = {
      code: `JD-${String(index).padStart(2, '0')}`,
      location: '',
      measuredOhm: 0,
      limitOhm: defaultLimit,
      meterId: defaultMeterId,
      measureDate: existing[0]?.measureDate ?? new Date().toISOString().slice(0, 10)
    }
    showDialog = true
  }

  function openEdit(point: Point): void {
    editingId = point.id
    editingPoint = point
    formError = ''
    form = {
      code: point.code,
      location: point.location,
      measuredOhm: point.measuredOhm,
      limitOhm: point.limitOhm,
      meterId: point.evidence?.meterId ?? '',
      measureDate: point.measureDate
    }
    showDialog = true
  }

  async function submitForm(): Promise<void> {
    if (!form.code.trim()) {
      formError = '请填写测点编号'
      return
    }
    if (!Number.isFinite(Number(form.measuredOhm)) || Number(form.measuredOhm) < 0) {
      formError = '实测电阻应为非负数字（Ω）'
      return
    }
    if (!Number.isFinite(Number(form.limitOhm)) || Number(form.limitOhm) <= 0) {
      formError = '限值应为大于 0 的数字（Ω）'
      return
    }
    if (!form.meterId) {
      formError = '请选择检测仪器（须在用且校准有效期覆盖检测日期）；无有效依据的测点只能归入待补证'
      return
    }
    const meter = meterOptions.find((option) => option.value === form.meterId)
    if (meter?.disabled) {
      const ok = window.confirm(`仪器「${meter.label}」${meter.reason}。仍要保存为「待补证」测点吗？`)
      if (!ok) return
    }
    if (editingId) {
      const valueWillChange =
        editingPoint !== null &&
        (editingPoint.measuredOhm !== Number(form.measuredOhm) ||
          editingPoint.limitOhm !== Number(form.limitOhm) ||
          editingPoint.measureDate !== form.measureDate ||
          editingPoint.evidence?.meterId !== form.meterId)
      if (valueWillChange) {
        const ok = window.confirm(
          '修改实测值 / 限值 / 检测日期 / 仪器后：\n' +
            '· 未签发测点按新值重新判定；\n· 已签发测点将退回「待复测」，原签发结论保留原依据备查，需复测后重新签发。\n确认保存？'
        )
        if (!ok) return
      }
      const result = await updatePoint(editingId, {
        code: form.code.trim(),
        location: form.location.trim(),
        measuredOhm: Number(form.measuredOhm),
        limitOhm: Number(form.limitOhm),
        meterId: form.meterId,
        measureDate: form.measureDate
      })
      window.alert(result.pushedBack ? '该测点已签发，改值后已退回待复测，原依据保留，请复测后重新签发。' : '测点已保存。')
    } else if ($activeDeviceId) {
      await createPoint($activeDeviceId, {
        code: form.code.trim(),
        location: form.location.trim(),
        measuredOhm: Number(form.measuredOhm),
        limitOhm: Number(form.limitOhm),
        meterId: form.meterId,
        measureDate: form.measureDate
      })
    }
    showDialog = false
  }

  async function confirmRemove(point: Point): Promise<void> {
    const ok = window.confirm(`删除测点「${point.code}」（实测 ${point.measuredOhm} Ω）并同时删除其判定记录？`)
    if (!ok) return
    await removePoint(point.id)
  }

  async function applyBulkMeasured(): Promise<void> {
    if (!$activeDeviceId || bulkValue === null) return
    const total = pointsOfDevice($activeDeviceId).length
    const ok = window.confirm(
      `将该装置全部 ${total} 个测点的实测电阻统一改写为 ${bulkValue} Ω？\n已签发测点会退回「待复测」，原签发依据保留备查。`
    )
    if (!ok) return
    const result = await bulkSetMeasured($activeDeviceId, Number(bulkValue))
    window.alert(
      result.pushedBack > 0
        ? `已改写 ${result.total} 个测点，其中 ${result.pushedBack} 个已签发测点退回待复测，需重新复测签发。`
        : `已改写 ${result.total} 个测点。`
    )
    bulkValue = null
  }

  function openPaste(): void {
    pasteText.set('')
    pasteErrors = []
    pastePreview = []
    pasteMeterId = pointsOfDevice($activeDeviceId ?? '')[0]?.evidence?.meterId ?? meterOptions[0]?.value ?? ''
    showPaste = true
  }

  function previewPaste(): void {
    const parsed = parsePointPaste($pasteText, defaultLimit)
    pasteErrors = parsed.errors
    pastePreview = parsed.rows
  }

  const pasteMeterOptions = $derived(
    meterOptionsForMeasureDate(new Date().toISOString().slice(0, 10))
  )

  async function submitPaste(): Promise<void> {
    if (!$activeDeviceId) return
    if (!pasteMeterId) {
      pasteErrors = ['请先在「仪器与校准」页登记仪器并录入校准有效期，再选择导入用仪器。']
      return
    }
    const parsed = parsePointPaste($pasteText, defaultLimit)
    pasteErrors = parsed.errors
    pastePreview = parsed.rows
    if (parsed.rows.length === 0) return
    const ok = window.confirm(
      `将用 ${parsed.rows.length} 行数据替换该装置现有 ${pointsOfDevice($activeDeviceId).length} 个测点，确认导入？\n新测点按所选仪器当次校准有效期冻结证据；旧测点（含已签发结论）将被替换。`
    )
    if (!ok) return
    await importPointRows($activeDeviceId, parsed.rows, {
      meterId: pasteMeterId,
      measureDate: new Date().toISOString().slice(0, 10)
    })
    showPaste = false
  }

  function handleFilterChange(next: FilterChange): void {
    const deviceId = ((next.values.deviceIds as string[]) ?? [])[0] ?? null
    setActiveDevice(deviceId)
    typeFilter = ((next.values.types as string[]) ?? []) as DeviceType[]
    keyword = next.keyword
    writeQuery('/points', {
      device: deviceId,
      kw: next.keyword,
      type: ((next.values.types as string[]) ?? []).join(',')
    })
  }

  function handleReset(): void {
    setActiveDevice(null)
    typeFilter = [...DEVICE_TYPES]
    keyword = ''
    writeQuery('/points', {})
  }

  async function gotoVerdicts(): Promise<void> {
    push('/verdicts')
  }
</script>

<section class="page">
  <div class="gb-brand-bar"></div>

  <div class="page__head">
    <div>
      <h2 class="page__title">接地电阻测点录入</h2>
      <p class="gb-hint">
        按装置逐点录入实测电阻与限值，可批量粘贴整段手记数据；实测值 ≤ 限值判合格，超限会即时标红。
      </p>
      {#if activeDevice}
        <p class="gb-hint">
          当前装置：{activeBuilding?.name ?? '未知建筑物'} · {activeDevice.type}
          {activeDevice.spec ? `（${activeDevice.spec}）` : ''} · 建议限值 {defaultLimit} Ω
        </p>
      {/if}
    </div>
    <div class="page__actions">
      <button class="btn" type="button" onclick={openPaste}>批量粘贴</button>
      <button class="btn btn--primary" type="button" onclick={openCreate}>＋ 新增测点</button>
    </div>
  </div>

  <FilterBar
    keyword={keyword}
    selects={[
      { key: 'deviceIds', label: '防雷装置', options: deviceOptions, multiple: false },
      { key: 'types', label: '装置类型', options: DEVICE_TYPES.map((type) => ({ label: type, value: type })) }
    ]}
    values={filterValues}
    keywordPlaceholder="搜索测点编号 / 位置 / 仪器"
    onChange={handleFilterChange}
    onReset={handleReset}
  />

  <div class="gb-stats-row">
    <StatBadge label="当前测点" value={totals.points} suffix="点" tone="primary" />
    <StatBadge
      label="不合格"
      value={totals.unqualified}
      suffix="点"
      tone={totals.unqualified > 0 ? 'danger' : 'success'}
    />
    <StatBadge label="合格率" value={totals.rate} percent={totals.rate} tone="success" />
    <StatBadge label="选中装置测点" value={totals.activeDevicePoints} suffix="点" tone="info" />
    <StatBadge
      label="待复测 / 待补证"
      value={totals.pendingEvidence}
      suffix="点"
      tone={totals.pendingEvidence > 0 ? 'warning' : 'success'}
    />
  </div>

  {#if $pendingEvidencePoints.length > 0}
    <div class="gb-panel pending-panel">
      <div class="gb-panel-title">
        <h3>待复测 / 待补证清单（{$pendingEvidencePoints.length}）</h3>
        <span class="gb-hint">校准更正退回、已签发改值、旧数据缺仪器编号的测点都在此列；已签发结果的原依据继续保留可查。</span>
      </div>
      <table class="gb-table">
        <thead>
          <tr>
            <th>测点编号</th>
            <th>位置</th>
            <th>证据状态</th>
            <th>快照仪器 / 校准有效期</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          {#each $pendingEvidencePoints as point (point.id)}
            <tr>
              <td class="gb-mono">{point.code}</td>
              <td>{point.location}</td>
              <td><span class="ev-tag ev-tag--{point.evidence.status}">{point.evidence.status}</span></td>
              <td class="gb-hint">
                {point.evidence.meterName || '—'}
                {#if point.evidence.calibrationValidUntil}
                  <div>校准至 {point.evidence.calibrationValidUntil}</div>
                {/if}
              </td>
              <td class="gb-hint">{point.evidence.note || '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if $activeDeviceId}
    <div class="gb-panel">
      <div class="gb-panel-title">
        <h3>批量录入</h3>
        <span class="gb-hint">适合野外手记一次性录入：统一改写实测值，或整段粘贴导入。</span>
      </div>
      <div class="bulk-row">
        <label class="gb-field">
          <span>统一实测电阻（Ω）</span>
          <input type="number" min="0" step="0.01" bind:value={bulkValue} placeholder="如 4.5" />
        </label>
        <button class="btn" type="button" onclick={applyBulkMeasured}>批量改写实测值</button>
        <button class="btn" type="button" onclick={openPaste}>批量粘贴导入</button>
      </div>
    </div>
  {/if}

  {#if rows.length === 0}
    <EmptyPanel
      title={$pointList.length === 0 ? '还没有接地电阻测点' : '没有符合条件的测点'}
      description="选择一条防雷装置后逐点录入测点编号、位置与实测电阻；也可以批量粘贴导入手记数据。"
      actionText="新增测点"
      secondaryText="重置筛选"
      onAction={openCreate}
      onSecondary={handleReset}
    />
  {:else}
    <div class="gb-panel">
      <table class="gb-table">
        <thead>
          <tr>
            <th>测点编号</th>
            <th>位置</th>
            <th>所属装置</th>
            <th class="is-num">实测（Ω）</th>
            <th class="is-num">限值（Ω）</th>
            <th class="is-num">占限值</th>
            <th>判定</th>
            <th>证据状态</th>
            <th>检测仪器（录入时固定）</th>
            <th>检测日期</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.point.id)}
            <tr class:is-bad={!row.qualified}>
              <td class="gb-mono">{row.point.code}</td>
              <td>{row.point.location}</td>
              <td>
                <span class="gb-tag">{row.deviceType}</span>
                <span class="gb-hint"> {buildingById(row.device?.buildingId)?.name ?? ''}</span>
              </td>
              <td class="is-num gb-mono">{row.point.measuredOhm}</td>
              <td class="is-num gb-mono">{row.point.limitOhm}</td>
              <td class="is-num gb-mono">{limitRatio(row.point.measuredOhm, row.point.limitOhm)}</td>
              <td>
                <QualifyTag measuredOhm={row.point.measuredOhm} limitOhm={row.point.limitOhm} size="small" />
                {#if !isQualified(row.point.measuredOhm, row.point.limitOhm)}
                  <span class="gb-danger">
                    超限 {((limitRatio(row.point.measuredOhm, row.point.limitOhm) - 1) * 100).toFixed(1)}%
                  </span>
                {/if}
              </td>
              <td>
                {#if row.point.evidence && row.point.evidence.status !== '有效'}
                  <span class="ev-tag ev-tag--{row.point.evidence.status}">{row.point.evidence.status}</span>
                {:else}
                  <span class="gb-tag">已固定</span>
                {/if}
              </td>
              <td class="gb-hint">
                {row.point.evidence?.meterName || row.point.meter || '—'}
                {#if row.point.evidence?.calibrationValidUntil}
                  <div title="当次校准有效期，录入时固定，不随后续台账变化">
                    校准至 {row.point.evidence.calibrationValidUntil}
                  </div>
                {/if}
              </td>
              <td class="gb-mono">{row.point.measureDate}</td>
              <td class="row-actions">
                <button class="btn btn--small" type="button" onclick={() => openEdit(row.point)}>编辑/复测</button>
                <button class="btn btn--danger btn--small" type="button" onclick={() => confirmRemove(row.point)}>
                  删除
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <p class="gb-hint">
    下一步：到「合格判定与整改」页执行自动初判与检测人确认，并由不合格判定批量生成整改建议。
    <button class="link" type="button" onclick={gotoVerdicts}>前往合格判定 →</button>
  </p>
</section>

{#if showDialog}
  <div class="gb-modal-backdrop" role="presentation" onclick={() => (showDialog = false)}>
    <div
      class="gb-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event: MouseEvent) => event.stopPropagation()}
      onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
    >
      <div class="gb-modal__head">
        <h3>{editingId ? '编辑测点' : '新增接地电阻测点'}</h3>
        <button class="gb-modal__close" type="button" onclick={() => (showDialog = false)}>×</button>
      </div>
      <div class="gb-modal__body">
        {#if formError}
          <p class="gb-alert">{formError}</p>
        {/if}
        <div class="gb-modal__grid">
          <label class="gb-field">
            <span>测点编号 *</span>
            <input bind:value={form.code} placeholder="如 JD-01" maxlength="24" />
          </label>
          <label class="gb-field">
            <span>位置</span>
            <input bind:value={form.location} placeholder="如 屋面西北角接闪带引下点" maxlength="60" />
          </label>
          <label class="gb-field">
            <span>实测电阻（Ω）*</span>
            <input type="number" min="0" max="1000" step="0.01" bind:value={form.measuredOhm} />
          </label>
          <label class="gb-field">
            <span>限值（Ω）*</span>
            <input type="number" min="0.01" max="1000" step="0.01" bind:value={form.limitOhm} />
          </label>
          <label class="gb-field">
            <span>检测日期</span>
            <input type="date" bind:value={form.measureDate} />
          </label>
          <label class="gb-field">
            <span>检测仪器 *（按编号选择，录入时固定校准有效期）</span>
            <select bind:value={form.meterId}>
              <option value="">请选择在用且校准有效的仪器</option>
              {#each meterOptions as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>
        {#if selectedMeter?.disabled}
          <p class="gb-alert">该仪器当前不可用：{selectedMeter.reason}。保存后测点证据将归入「待补证」，不能签发结论。</p>
        {:else if selectedMeter}
          <p class="gb-hint">证据快照将固定：仪器编号 {selectedMeter.value}，当次校准有效期至 {selectedMeter.validUntil}。</p>
        {/if}
        {#if editingPoint?.evidence && editingPoint.evidence.status !== '有效'}
          <p class="gb-alert">
            该测点证据状态为「{editingPoint.evidence.status}」：{editingPoint.evidence.note || '需复测补证'}
          </p>
        {/if}
        {#if editingPoint}
          <p class="gb-hint">
            证据快照在首次录入时固定；仅当更换仪器时才会按新仪器的当次校准有效期重新冻结。
            修改实测值不会改变快照，已签发结论会因此退回待复测并保留原依据。
          </p>
        {/if}
      </div>
      <div class="gb-modal__foot">
        <button class="btn" type="button" onclick={() => (showDialog = false)}>取消</button>
        <button class="btn btn--primary" type="button" onclick={submitForm}>
          {editingId ? '保存修改' : '新增测点'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showPaste}
  <div class="gb-modal-backdrop" role="presentation" onclick={() => (showPaste = false)}>
    <div
      class="gb-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(event: MouseEvent) => event.stopPropagation()}
      onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
    >
      <div class="gb-modal__head">
        <h3>批量粘贴导入测点</h3>
        <button class="gb-modal__close" type="button" onclick={() => (showPaste = false)}>×</button>
      </div>
      <div class="gb-modal__body">
        <p class="gb-hint">
          每行一条，格式「测点编号,位置,实测电阻[,限值]」，逗号 / 制表符 / 分号均可。示例：<br />
          <span class="gb-mono">JD-07,罐区东侧测试井,3.8,4</span><br />
          <span class="gb-mono">JD-08;罐区西侧测试井;5.6;4</span>
        </p>
        <label class="gb-field">
          <span>导入使用的检测仪器 *（新测点按它的当次校准有效期固定证据）</span>
          <select bind:value={pasteMeterId}>
            <option value="">请选择在用且校准有效的仪器</option>
            {#each pasteMeterOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="gb-field">
          <span>粘贴内容</span>
          <textarea
            rows="8"
            value={$pasteText}
            placeholder="JD-07,罐区东侧测试井,3.8,4"
            oninput={(event: Event) => pasteText.set((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        {#if pasteErrors.length > 0}
          <div class="errors">
            {#each pasteErrors as error, index (index)}
              <p class="gb-alert">{error}</p>
            {/each}
          </div>
        {/if}
        {#if pastePreview.length > 0}
          <table class="gb-table">
            <thead>
              <tr><th>编号</th><th>位置</th><th class="is-num">实测</th><th class="is-num">限值</th></tr>
            </thead>
            <tbody>
              {#each pastePreview as row, index (index)}
                <tr>
                  <td class="gb-mono">{row.code}</td>
                  <td>{row.location}</td>
                  <td class="is-num gb-mono">{row.measuredOhm}</td>
                  <td class="is-num gb-mono">{row.limitOhm}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
      <div class="gb-modal__foot">
        <button class="btn" type="button" onclick={() => (showPaste = false)}>取消</button>
        <button class="btn" type="button" onclick={previewPaste}>解析预览</button>
        <button class="btn btn--primary" type="button" onclick={submitPaste}>覆盖导入</button>
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

  .bulk-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
  }

  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  tr.is-bad td {
    background: #fff6f4;
  }

  .errors {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 160px;
    overflow: auto;
  }

  .pending-panel {
    border-left: 4px solid #d99a1f;
  }

  .ev-tag {
    display: inline-block;
    padding: 1px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .ev-tag--有效 {
    color: #1e8449;
    background: #eaf6ee;
  }

  .ev-tag--待复测 {
    color: #9a6a00;
    background: #fdf3d7;
  }

  .ev-tag--需补充 {
    color: #b0561b;
    background: #fdebdc;
  }

  .ev-tag--待补证 {
    color: #c0392b;
    background: #fdecea;
  }

  .link {
    border: none;
    background: transparent;
    color: #1d3557;
    text-decoration: underline;
    cursor: pointer;
    font-size: 12px;
  }
</style>
