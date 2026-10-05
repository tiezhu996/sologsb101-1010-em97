# sologsb101-1010 防雷装置检测与接地电阻台账

面向防雷检测机构的纯前端单页应用：对建筑物的接闪器、引下线与接地装置逐项登记，按测点录入接地电阻实测值并与限值比对判定合格与否，最后汇总出检测结论与整改建议。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22810**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22810）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Svelte 5（runes：`$state` / `$derived` / `$props` / `$effect`） | 页面组件使用 `lang="ts"` |
| 语言 | TypeScript 5.7 | 构建脚本执行 `svelte-check --tsconfig ./tsconfig.json` |
| 路由 | svelte-spa-router 5 | hash 路由，`/buildings`、`/devices`、`/instruments`、`/points`、`/verdicts`、`/backup` |
| 样式 | Tailwind CSS 4（`@tailwindcss/vite`）+ 自定义组件类 | 主题变量走 `@theme` |
| 状态管理 | Svelte store（`writable` / `derived`） | `buildingStore`、`instrumentStore`、`pointStore`、`rectifyStore` |
| 持久化 | Dexie 4（IndexedDB，库名 `gblightprot`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/buildings` | 建筑物与防雷类别台账 | Building、Device、Point | 新建/编辑/删除建筑物，按用途与防雷类别筛选，卡片回显装置数、测点数、不合格数与合格率 |
| `/devices` | 接闪器/引下线/接地装置登记 | Device、Building、Point | 登记类型、材质、规格、数量与安装日期，按建筑物与类型筛选，展开查看该装置全部测点 |
| `/instruments` | 仪器台账与校准记录 | Instrument、Calibration、Point | 登记仪器编号/名称、注销/恢复、按仪器登记校准有效期；更正校准日期联动未签发测点退回待复测、已签发结果标需补充 |
| `/points` | 接地电阻测点录入 | Point、Device、Instrument、Calibration | 录入时按仪器编号固定当次校准有效期为证据快照、批量改写、批量粘贴导入；独立展示待复测/待补证清单 |
| `/verdicts` | 合格判定与整改建议 | Verdict、Point、Rectify、Instrument | 自动初判、检测人签发（冻结实测值/限值/仪器依据，签发后锁定不可改）、待复测/需补充提示、整改状态机 |
| `/backup` | 检测结论与结构版本导出 | 全部模型 | 按建筑物出检测结论、全部测点判定一览（含证据状态）、全量 JSON 导入导出（证据状态随备份保留）、清空重建演示数据 |

> 深层 id 场景：本项目的列表与明细集中在同一组路由（建筑物 → 装置 → 测点 → 判定 → 结论），不存在 `/xxx/:id/yyy` 形式的层级深链；筛选条件通过 query 传递（例如 `/points?device=dev_oil_belt`），刷新后仍可复现当前视图。若 query 指向的装置已被删除，页面自动回落到全部测点并给出空态引导，不会白屏。

## 四、目录结构

```
sologsb101-1010/
├── README.md
├── docker-compose.yml            # name: gblightprot，不写 version
├── Dockerfile                    # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                    # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile                # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf                # 前端独立托管用
    ├── .dockerignore
    ├── package.json              # build = svelte-check && vite build
    ├── tsconfig.json
    ├── vite.config.js
    ├── svelte.config.js
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.js               # Svelte 5 mount 入口，并打开并播种数据库
        ├── App.svelte            # 顶部导航（link action）+ 页脚数据概览
        ├── app.css               # Tailwind 入口 + 主题变量 + 通用组件类
        ├── lib/
        │   ├── types/            # building / device / instrument / calibration / point / verdict / rectify
        │   ├── stores/           # buildingStore / instrumentStore / pointStore / rectifyStore
        │   ├── components/common/# QualifyTag / FilterBar / StatBadge / EmptyPanel
        │   ├── hooks/            # useIdbTable / useQualifyRate
        │   └── utils/            # resistance.ts / db.ts / evidence.ts / export.ts / query.ts
        └── routes/
            ├── index.ts          # 路由表（svelte-spa-router 的 route 映射）
            ├── BuildingList.svelte
            ├── DeviceList.svelte
            ├── InstrumentLedger.svelte
            ├── PointEntry.svelte
            ├── VerdictBoard.svelte
            └── BackupView.svelte
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22810
npm run build      # svelte-check 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gblightprot`，当前结构版本 `v3`。所有读写经 `frontend/src/lib/utils/db.ts` 与 hooks 封装，组件不直接触碰 Dexie 实例。
- **数据表**：`buildings`（建筑物）、`devices`（防雷装置）、`instruments`（检测仪器台账）、`calibrations`（仪器校准/送检记录）、`points`（接地电阻测点，含证据快照 `evidence`）、`verdicts`（合格判定，已签发的冻结依据存 `issuedSnapshot`）、`rectifies`（整改建议）。
- **仪器台账与证据快照分离**：测点只在录入当次把「仪器编号 + 校准记录 id + 校准有效期 + 证书号」冻结进 `Point.evidence`，之后仪器更名、注销、校准记录更正都不回改快照；结论签发时再把实测值/限值/仪器依据冻结进 `Verdict.issuedSnapshot`，已签发结论锁定，检测员不能直接改判。
- **校准更正联动**：校准日期或有效期被更正时，引用该证书且**未签发**的测点退回「待复测」（未确认判定一并作废），**已签发**结果保留原依据、证据标为「需补充」；联动在单事务内按确定性幂等键（校准记录 id + 新日期）执行，写入失败后以相同参数重试不会重复失效。仪器注销只停用台账行，不改动任何快照。
- **证据状态**：`有效` / `待补证`（缺仪器编号或校准有效期，旧数据升级落入此态）/ `待复测`（未签发测点被改值或校准更正退回）/ `需补充`（已签发结果原依据被动过）。待复测与待补证清单在测点页与判定页常驻展示，证据非「有效」不能签发结论。
- **升级迁移**：`db.version(1)`、`db.version(2)` 保留历史结构，`db.version(3).stores(...).upgrade(...)` 新增仪器/校准表并为旧测点补证据快照（缺仪器编号归入待补证）、为已签发旧判定回填冻结依据；调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `buildings` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 栋建筑物 / 6 个防雷装置 / 3 台仪器（含 1 台校准过期）/ 3 条校准记录 / 9 个测点 / 9 条判定 / 2 条整改建议），其中既有合格样本也有超限、待补证样本，便于演示退回待复测与签发依据追溯。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Svelte store 自动刷新，页面用 `$store` 只读订阅。
- **判定规则**：实测电阻 ≤ 限值判合格；限值初始值按防雷类别与装置类型建议（一类/二类接地装置 4 Ω，其余 10 Ω），最终以设计文件与规范条款为准。
- **备份与恢复**：`/backup` 页可导出包含七张表的 JSON 快照（证据状态与签发冻结依据随快照保留），支持「覆盖导入」与「追加导入（重新分配 id）」；旧版备份导入时自动为缺仪器编号的测点补「待补证」快照，绝不静默改写证据状态。备份时间写入 `localStorage`，页脚与备份页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
