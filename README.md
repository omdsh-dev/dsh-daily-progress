# dsh-daily-progress

**Author / Maintainer:** [@Zacklinkk](https://github.com/Zacklinkk)

每日进度成就系统（DSH Web 插件，双半架构）：

- **host 半**（`src/` → `lib/index.js`）：`daily_progress` 存储域（每日计划持久化于宿主 storage-domain 的 json 后端）+ 完成率 / streak / 周率指标 + 自有 HTTP 路由（`/daily-progress/state`、`/daily-progress/mutate`，loopback-only）。
- **client 半**（P1 起，`src/client/` → `lib/client.js`）：`conversation.input.dock` 温度计 widget + 两栏计划面板（Modal）+ 21:00 浏览器提醒。


## 已确认口径

- 存储：storage-domain + json 后端（记录键 `<scope>:<date>`，V1 scope=`default`，按用户隔离预留）。
- streak：达成日 = 当日有 ≥1 条计划且完成率 100%；今天未达成**不中断**历史 streak（只暂停累计）。
- 周完成率：本周（周一为起点）**截至今天**的条目 done/total；未来日不参与。
- 日期一律是**用户的本地日历日**（YYYY-MM-DD 字符串，由 client 随请求携带）；历史日锁定只读；跨日惰性 rollover（昨天未完成项自动 carry，`clearToday` 后不重携）。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test 单测（metrics/calendar）
npm run build       # tsc 产出 lib/
npm run probe       # 活体验证：真实 @deepseek-ai 运行时包 + json 后端全链路
```

`probe` 依赖本机 DSH 运行时包解析：把 `node_modules/@deepseek-ai/` 下三个包软链到
`${DSH_PROFILE:-~/.dsh/profiles}/node_modules/@deepseek-ai/{dsh-storage,dsh-storage-json,dsh-storage-domain}`。
生产环境由宿主组合在运行时解析这些包，无需随包发布。

## 安装（DSH profile）

1. 在 profile 的 `package.json` dependencies 加入本包（或 `dsh plugin install` 渠道）；
2. profile 的 `cordis.patch.yml` 加一行 `{ id: daily-progress, name: dsh-daily-progress }`（本包 `dsh.bundle.patch` 指向的 `cordis.patch.yml` 已含此 insert）；
3. 重启 DSH Web；client 半由 `dsh.client` manifest 自动装配。

## 路由契约（host）

- `GET /daily-progress/state?localDate=YYYY-MM-DD&tz=IANA` → `Snapshot`
- `POST /daily-progress/mutate` `{localDate, tz, op, payload}` → `{ok:true, snapshot} | {ok:false, code, message}`
  - ops：`toggleItem{itemId}`（仅当天）、`addItem{target:'today'|'tomorrow', text}`、`removeItem`、`editItemText`、`setTomorrow{items}`、`clearToday`
- 所有路由仅接受 loopback Host；写操作落盘后广播 `domain/changed`（进程内）。

## 已知边界

- 「今天」以 client 上报的 `localDate` 为准（host 不知道用户时区）；单机个人工具语义下可接受，防回溯/防篡改不在威胁模型内。
- 数据通道为插件自有同源路由 + 轮询/乐观更新（外部插件无法扩展核心 `/api` RPC 表或转发事件 allowlist）。
