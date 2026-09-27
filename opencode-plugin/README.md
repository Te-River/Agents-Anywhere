# OpenCode Plugin

> **形态已变更（2026-09-27）**：Agents Anywhere 的 OpenCode 接入不再依赖本插件。
> Connector 现在直接接宿主自带的 HTTP 服务面（`$XDG_STATE_HOME/opencode/service.json`
> 注册 + `/api/*`），与 Codex / Claude 的接入形态一致；实现与实测证据见
> [`docs/opencode-server-surface.md`](../docs/opencode-server-surface.md) 与
> [`connector/connector/runtimes/opencode/serve/`](../connector/connector/runtimes/opencode/serve/)。
> 本文下面描述的 **loopback bridge 传输在 Connector 侧已被删除**（`runtimes/opencode/bridge/`、
> `runtime.py`、`discovery.py` 及其测试），所以本插件装载后**没有对端**：它仍会监听回环端口并
> 写端点文件，但没有任何 Connector 会来扫。保留本目录只为登录命令（`/aa-login` 等）与历史取证；
> 是否整体退役见仓库讨论。

Agents Anywhere 的 OpenCode V2 接入，以 OpenCode **进程内插件**形态交付（包名 `@agents-anywhere/opencode-plugin`）。对宿主零侵入：不写 OpenCode 配置、不抢 hook、不另起常驻进程，只在本进程内监听回环端口并发布端点文件，等本机 Connector 上来连接。

职责与分阶段定义见设计文档（不在本仓库提交，位于 `.git/opencode-team/20260926-213919/opencode-design/`：`01` 总设计含 P1–P5 分期、`02` P0 增量与假设表、`03` 契约裁定）；实现报告在同级 `opencode-p0/`、`opencode-p2/`、`opencode-p5/`。对端形态的 Connector 侧 runtime 见 [`connector/connector/runtimes/opencode/serve/`](../connector/connector/runtimes/opencode/serve/)，同类插件实现见 [DSH Bridge Next](../dsh-bridge-next/README.md)。

## 已实现

```text
OpenCode 进程内服务端插件（`.` 入口）setup(ctx)
  → 监听 127.0.0.1:0，NDJSON JSON-RPC 2.0 loopback bridge
  → 原子发布端点文件 endpoints/<servicePid>-<port>.json（含 32 字节 loopback token）
  → 本机 Connector 扫端点 → 首帧 initialize 握手（token / runtime=="opencode" / 协议主版本 1 / 绝对 location；缺 location → -32602 拒绝并关闭）
  → 只读方法面：ping、runtime.getCapabilities、session.list/getSnapshot/getState/getNotices
  → OpenCode 事件投影为规范 timeline，经 sync.batch（begin/items/commit/notifications）分页推送
  → Connector 以 runtime.sync.ack 回检查点，Hub 只按 durable.seq 前进
```

- 双入口：`.` 是**服务端**插件，P1 已实现；`./tui`（`src/tui/index.ts`，仓库根另有 `tui.ts` 转发 shim）是 TUI **状态提示面**——**它不注册任何命令**（2.0.18 无命令注册面，实测），登录/退出的主触发都在**服务端**（`/aa-login` 命令 + 缺凭据自动触发），TUI 只用 `ui.toast` 提示「用 `/aa-login` 连接」。模块契约与**真实装载均已实测**（A10，见「尚未实现」与「TUI」一节）。
- 只读方法面（P1）：`ping`、`runtime.getCapabilities`、`session.list`、`session.getSnapshot`、`session.getState`、`session.getNotices`，以及推流面的 `runtime.sync.subscribe` / `runtime.sync.ack`（两者在线上都是请求，故在被服务白名单内）。其余方法（含 P3 的写方法）一律回 `-32601`；bridge 从不主动发起请求，只接受通知。
- 目录面（D3/D4）：`catalog.listAgents` → `{ agents: [{ id, name?, description?, mode("primary"\|"subagent"\|"all"), hidden }] }`（源自 `ctx.agent`），`catalog.listModels` → `{ runtime, revision, models: [...] }`（源自 `ctx.model`）。能力行 `catalog.agent` / `catalog.model` **由 `install()` 实测的 ctx 面派生**：缺 `ctx.agent`/`ctx.model` 即 `unavailable` + 原因，方法回 `UNSUPPORTED_OPERATION`（与 `catalog.permission` 同款），手机端据此隐藏选择器。`hidden` 过滤语义与 `ctx.model` 项形状**未验证**（A10 未展开）。
- 握手契约：每条连接的首帧必须是 `initialize`，常量时间比较 token，并校验 `runtime == "opencode"` 与协议主版本 `1`。`location` 是**必填的项目绑定**：首帧 `initialize` 必须携带**绝对目录**（如 `D:\Github\Agents-Anywhere`），**缺失/空/相对**一律回 `-32602` `INVALID_PARAMS` 并**关闭连接**（rev3 ruling 1 fail-closed；与上游 live 测试 `connector/tests/test_opencode_bridge_live_integration.py::test_live_handshake_fails_closed` 的断言一致）。Connector 的端点探活（`discovery.py::_handshake`）因此以端点文件自报的 `locations[0]` 作为握手 location 发起，整条链不受影响。握手前的请求不被处理，重复 `initialize` 以 `INVALID_REQUEST` 拒绝；单帧上限 8 MiB，两端一致。
- 端点文件：`~/.agents-anywhere/opencode-bridge/endpoints/<servicePid>-<port>.json`（基目录可用 `AGENT_CONNECTOR_DATA_DIR` 覆盖），目录 `0700`、文件 `0600`，tmp → fsync → rename 原子发布；字段含 `version/runtime/protocolVersion/bridgeId/host:"127.0.0.1"/port/token/pid/serviceVersion/locations/startedAt`，token 为 `randomBytes(32)` 的 base64url。**存活判据是握手成功，不是记录里的 pid**，stale 文件只由探活结论清理。
- 时间线内容寻址：item 的 `contentHash` 与 Connector 用同一条规则（`type`/`status`/`role`/`content`，canonical JSON 排序键、无空格，前缀 `sha256:`）；平台会话 ID 为 `sess_opencode_<sha256(namespace:opencode:externalId)[:24]>`。
- 事件投影只为**实测运行时刻**的事件名写分支，不按发布的 SDK 类型猜：P0 实测的 6 个事件名在 SDK 类型里 0 命中。未知事件或字段缺失按条计数跳过，从不抛错。
- 单例与共存：`Symbol.for('agents-anywhere.opencode.hub')` 保证同一宿主进程只起一个 hub（热重载或第二次 `setup()` 复用现有实例，引用释放到零才丢弃全局句柄）；共存模块只**观测**同进程其它插件，不写配置、不抢 hook、不预先占据名额。
- 权限只观测：`permission.hook("evaluate")` 仅记录请求（为 P3 审批通道预留），回调恒返回 `undefined`。P0 实测 `undefined` 不改变 `effect`；用返回字符串改写 `effect` 属假设 **A11**，未证，故本版不存在任何远端放行/拒绝路径。
- fail-soft：`setup()` 内部失败只记一条 warn 并返回空清理函数，不向宿主的插件加载链抛错——本次进程只是没有远端通道，宿主不被拖垮。

## 尚未实现

| 阶段 | 内容 | 现状 |
|---|---|---|
| P6 | 共存清单、热重载 soak、`engines` 门、审计 | **版本门已实现**（`engines.opencode` 声明 + 运行期探测/告警/能力标注，见「版本门」一节）；共存只做观测，热重载 soak 与审计未做 |
| A10 | TUI 入口的**装载与可用面** | **已证实**（PTY 实测，见 VERIFICATION §二）：全量 `opencode`（裸/`--standalone`）**会**求值并调用本模块的 `setup()`；`opencode mini` **不加载** TUI 插件。模块契约 = `export default { id, setup }`。真实 ctx 顶层 13 键；可用面仅 `ui.toast` + `attention.notify`（可选）；**无命令注册面**（`keymap` 无 `registerLayer`、无 `command` 域）⇒ **TUI 不能注册 `/aa`**，只作状态提示。JSX 面（slot/panel/markdown）零依赖不可作者化，列为未做。**桌面 App 的 TUI 未实跑**（不可干扰 PID 9016）。`cli.json` 不是插件配置载体，勿再使用。子会话父级关系经**同一 TUI 通道**（`api.client.session.list` → `session-index.json`）获取，其 `parentID` 是否真返回仍受未验证约束 |
| 子会话父级 | 真机验证 TUI 索引通道；把子会话**映射进父会话流** | 通道**已实现但未真机实跑**（`session.list` 是否返回 `parentID`、TUI 是否在跑均未证）。**合并进父会话流需 Connector 侧模型改动**（`RuntimeTimelineItem` / `AgentCallToolContent.parent_item_id`），本插件**不做**，仅提供索引 |

## 账号接入（P4）

三件事一体：**账号验证**（回环 OAuth + 无头设备码）、**由插件 spawn Connector**（引导闭环）、**可安装形态**。

- 凭据三层分离，落在 `~/.agents-anywhere/opencode-plugin/`（可用 `AGENT_CONNECTOR_DATA_DIR` 覆盖基目录）：`settings.json`（仅 apiBaseUrl）、`account.json`（账号层访问令牌）、`bindings/<serverKey>/<accountId>.json`（设备层 connector_id + token）、`pending-flow.json`（进行中 OAuth，非凭据）、`login.json`（登录提示：授权 URL / 短码，非凭据，见下）。全部 `0600` + 原子写（tmp → fsync → rename）。
- **复用优先（启动顺序）**：① 已有效凭据 + 设备绑定 → 探测本机共享记录 `~/.agents-anywhere/connector-runtime.json`（CLI / AA Desktop / DSH 共用同一文件，契约 local-machine/2.0）中是否有**存活进程**且**设备绑定一致**；命中即**复用、绝不 spawn**；② 命中但绑定的是别的设备 → 记 warn 并尝试复用其连接（不新建）；③ 完全没有才会 `uv` spawn 一个新 Connector。两条路径都会在日志里说明选了哪条与依据（`src/server/connector-reuse.ts`）。
- **回环 OAuth（§5.1）**：绑 `127.0.0.1:0`；`state`(32B) 恒定时间校验、code 一次性消费（重放 `409`）、超时关闭监听；授权 URL 复用 Web 的 `#/plugin-oauth`，client_id `agents-anywhere-opencode-plugin`，PKCE S256。
- **无头设备码（§5.2，SSH 可用）**：申请设备码 → 显示 `verification_uri` + 短码 → 按 `interval` 轮询，处理 `authorization_pending` / `slow_down`（按返回 interval 递增）/ `access_denied` / `expired_token`。
- **Connector supervisor**：用 `uv` spawn Connector（stdio NDJSON JSON-RPC：`connector.getState` / `connector.start` / `connector.stop` + `connector/state` 通知），崩溃上报 `runtime_error` 并定时重连。源码路径解析顺序：① `AGENT_CONNECTOR_SOURCE` / 显式配置（**覆盖仍最高优先**）② **包内随包分发的副本** `lib/connector/`（Git/包形态下唯一可用来源）③ 开发期同级 `../connector` ④ **可操作的报错**（绝不静默）。`uv` 缺失同理报错（`AGENT_CONNECTOR_UV` 可指定）。**未找到 uv/源码时插件仍可加载**，只是没有连接。
- **登录：装好就能用（三步走，不需要任何环境变量）**
  1. **装**：把本插件写进 `opencode.json`，并顺手带上插件配置项（`options`）：
     ```jsonc
     // 全局 ~/.config/opencode/opencode.json
     {
       "plugins": [
         { "package": "@agents-anywhere/opencode-plugin", "options": { "serverUrl": "https://your-server" } }
       ]
     }
     ```
     （本地目录形态的安装方式与实测结论见「安装进 OpenCode（形态 B′，已实证）」。）
  2. **启动即自动登录**：OpenCode 启动时插件先做**复用优先**（有效凭据 + 设备绑定 → 零交互，见下一条）；**没有可用凭据就自动发起登录**，无需任何环境变量与命令：
     - 本机有图形环境 → **回环 OAuth**，并用**系统默认浏览器**自动打开授权页：只走**系统 shell 关联**，**绝不硬编码浏览器可执行文件或 ProgID**（用户把 Edge Beta / 金丝雀等**渠道版**设为默认时，硬编码会开错、甚至开不了）。Windows 主方式 `rundll32.exe url.dll,FileProtocolHandler <url>`，失败回退 `explorer.exe <url>`；macOS `open <url>`；Linux `xdg-open <url>`。全部**argv 直传、不经 shell**，因此授权 URL 里的 `&` 与 `%` **逐字节原样**送达（`cmd /c start` 会重解析命令行、把 `&` 当命令分隔符截断 URL，故弃用）。**零运行时依赖**。打不开浏览器是 **fail-soft**：回环监听照常，用户按日志 / `login.json` 手动复制 URL 即可；
     - SSH / 无图形（或回环监听起不来）→ **自动改用设备码**（RFC 8628），并给出验证地址 + 短码。
  3. **点一次「授权」**：浏览器里点一次即完成 —— 插件自己交换 token、注册/复用设备、启动 Connector，并打出一行 `已连接：账号 …，设备 …`。
- **授权信息不再「只在日志里」**：授权 URL / 短码 / 有效期**同时**写到两处（第三处留给后续 TUI）：
  - **日志的 INFO 行**：一整行给用户看的文案，可直接复制（回环：URL + 有效期；设备码：`verification_uri` + 短码 + 免输入链接）；
  - **文件 `~/.agents-anywhere/opencode-plugin/login.json`**：原子写、`0600`、与凭据同一套纪律；含 `status`（`pending`/`connected`/`failed`）、`authorizationUrl` 或 `verificationUri` + `userCode`、`expiresAt`。日志行里**给出该文件路径**，用户可直接打开复制。流程结束后该文件被改写为 `status:"connected" | "failed"`，**不再保留 URL 与短码**（不会留下可复用的过期码）；失败记录的 `instruction` 一定带**下一步**，`not_configured` 时特别写清**怎么设置服务器地址**。文件里始终不含任何令牌 / verifier / state。
  - **无头场景的短码在哪**：就在上面两处（日志 INFO 行 + `login.json`），在任意设备的浏览器打开验证地址输入即可；该文件也是**可读状态**，后续 TUI 面（A10）可直接呈现，无需重新推导。
- **三态日志各有「下一步」**（`src/server/login-state.ts`）：`需要登录`（原因 + 当前服务器 + 会自动开始登录）/ `已自动发起登录…`（URL 或短码 + 文件路径 + 有效期）/ `已连接`（账号 + 设备 + 复用还是新建）。
- **配置项（`options`）与环境变量（环境变量降级为「高级 / 无头备用」）**：

  | 插件配置项 | 环境变量（高级 / 无头备用） | 默认 | 作用 |
  |---|---|---|---|
  | `options.serverUrl` | `AGENT_SERVER_URL` | `settings.json` 中的值 | 服务器地址（也接受 `…/api/v2` 后缀） |
  | `options.autoLogin` | `AGENT_AA_AUTO_LOGIN` | `true` | 启动时是否自动发起登录（`false` / `0` / `off` 关闭） |
  | `options.loginMode` | `AGENT_AA_LOGIN` | 自动判定 | 强制 `device`（无头设备码）或 `loopback`（浏览器） |
  | `options.connectorSource` | `AGENT_CONNECTOR_SOURCE` | 见「Connector 前置」 | Connector 源码目录覆盖 |

  优先级：**`options` > 环境变量 > 默认**；单个值非法（如 `serverUrl` 不是 URL）只**降级到下一层**，既不报错也不猜。整体关闭自动登录：`{"options":{"autoLogin":false}}` 或 `AGENT_AA_AUTO_LOGIN=0`。
- **服务器地址的完整解析顺序**（`src/shared/server-url.ts`，**每层都记日志说明来源**，用户因此不必重复配置）：
  1. `options.serverUrl`（`opencode.json` 插件配置项）；
  2. `AGENT_SERVER_URL`（高级 / 无头备用）；
  3. `~/.agents-anywhere/connector-runtime.json` 的 `runtime.serverUrl`（CLI / AA Desktop / DSH 共用的共享记录）；
  4. 桌面端 `%APPDATA%\Agents Anywhere\desktop-server.json` 的 `serverUrl`（macOS 为 `~/Library/Application Support/Agents Anywhere/`，Linux 为 `$XDG_CONFIG_HOME/Agents Anywhere/`）；
  5. 桌面端 `…/connector/desktop-binding.json` 的 `serverUrl`（设备绑定记录）；
  6. `~/.agents-anywhere/opencode-plugin/settings.json` 的 `apiBaseUrl`（上次成功登录写入的默认值）；
  7. 都没有 → `not_configured`，提示**可操作**（点名上面每一种设置方式并指向本节）。
  只读文件的 **`serverUrl` 字段**：同一文件里的 token / 账号 id 等敏感字段既不读取、也不写入日志与 `login.json`。文件缺失、不可读或字段不是合法地址 → 跳过该层（记 debug 行），不报错、不猜。
- **本地自建实例的地址写法**（与 Desktop / DSH 同一套地址规则，实现见 `src/shared/oauth.ts`）：
  - 省略 scheme 时按主机补全：`localhost` / `127.0.0.1` / `[::1]` 补 **`http://`**（本地服务通常是明文 HTTP），其余主机补 `https://`；
  - 允许末尾带 `/api/v2`，使用时一律规范化为**服务器 origin**（无路径）；
  - **Web / OAuth 授权页地址由服务器地址推导**：远程服务**同源**；本地开发的 `localhost`、`127.0.0.1`、`[::1]` 的 **`8000` → `5174`**（本地 Web 端口），**其他端口保持原样**。
  - 例：`{"options":{"serverUrl":"127.0.0.1:8000"}}` → API 走 `http://127.0.0.1:8000`、授权页开 `http://127.0.0.1:5174/#/plugin-oauth?…`；填 `http://127.0.0.1:8080` 则授权页同为 `http://127.0.0.1:8080`（非 8000 不映射）。
  可行性依据：`setup()` 在 OpenCode 进程内运行、可读 `ctx.options` 与 `process.env` 并起异步任务，**不依赖 TUI/浏览器插件的装载**（这正是 A10 未证的部分）；设备码路径更不需要回环回调。日志与 `login.json` 里只有授权 URL 与用户短码（本就给人看的），**不含任何令牌 / verifier / state**。
- **退出登录**：先 `POST /connectors/{id}/revoke` 撤销服务端设备凭据 → 再删本地 binding/account → 再停 Connector；revoke 失败则**不清理本地**（顺序不可逆）。
- **TUI（仅状态提示，无命令面）**（`./tui` 入口）：2.0.18 的真实 TUI ctx **没有命令注册面**（`keymap` 无 `registerLayer`，也没有 `command` 域），因此**不存在 `/aa` 命令**，用户无法从 TUI 触发登录；`/` 命令面板里也不会出现「Agents Anywhere」。TUI 做两件事，都用 `ui.toast`：装载时给出**可操作**状态提示（未登录时显示「用服务端命令 `/aa-login` 连接本机」，已登录时显示账号与设备）；装载后**轮询 `login.json`**，在登录态变化时各 toast 一条可操作信息（开始登录 → 打开授权地址 / 输入短码；成功 → 已连接；失败 → 原因 + 重试命令）——由服务端 `/aa-login` 或自动登录发起的流程因此在 TUI 里也**看得见**（`startLoginStateWatcher`，2s 一次、unref 定时器、dispose 即停、任何失败都吞掉不影响宿主）。`src/tui/index.ts` 仍保留 `/aa` 命令**描述符**与「若 `keymap.layer` 是函数则尝试注册」的降级路径（探测不到即静默 `none`），但那是给将来宿主留的口子，**当前不生效**。**登录主触发在服务端**：`/aa-login` 命令 + 缺凭据自动登录（见上）。

服务端入口的形状则已实测（opencode-cli 2.0.18）：`export default` 必须是带 `id` 与 `setup`（或 `effect`）的**对象**，V1 的 `export const X = async (input) => ({ ... })` 形状加载失败，报 `Plugin must export a default definition with an id and an effect or setup function`。

## 版本门（P6）

宿主 OpenCode 版本漂移快于本插件的契约探针（本机宿主见过 2.0.16 / 2.0.18，下载页为 2.0.6），而本插件是按 **2.0.18** 实测的 V2 `ctx` / 权限 hook / TUI 契约写的，故需要一道**版本门**，避免在不兼容宿主上给出静默的半可用状态。

- **声明**：`package.json` 的 `engines.opencode` 为 `>=2.0.6 <3`。
  - 下限 `2.0.6`：下载页上最早的 2.0.x 版本（同一 2.0 契约族的已知起点）；
  - 上限 `< 3.0.0`：本插件依赖的 `ctx` / hook / TUI 契约是 **V2 专属**，V3 不做假设；
  - 实测/观察值：`2.0.18`（P0/A10 探针）、`2.0.16`（本机宿主）。**2.0.6–2.0.15 未真机验证**，仅凭同一契约族纳入范围。
- **运行期探测**：`src/shared/version-gate.ts` 读取 `ctx.app?.version`（`readServiceVersion`），在 hub 构造与每次 `install(ctx)` 时重新评估；取不到版本就**跳过**并记一条 info（`hostVersionSupported:null`），不猜、不改标。
  - 端点文件里的 `serviceVersion` 由本插件用同一取值写入，**不是独立来源**，故生产路径只认 `ctx.app.version`；`HostVersionSource` 保留 `endpoint.serviceVersion` 仅作枚举。
- **不兼容时**：日志给出**可操作警告**（当前版本 / 支持范围 / 可能后果：能力缺失、权限审批失效、TUI 命令不可用），并把 `runtime.getCapabilities` 的**每一条能力行**标注 `metadata.probe:"unverified"` + `metadata.hostVersionOutOfRange:true`（与 `derived()` 的诚实口径一致）；能力集级 `metadata` 附 `hostVersion` / `hostVersionSource` / `hostVersionSupported` / `hostVersionReason`。**不静默继续假正常**：能力行仍可能应答，但不再声称"已验证"。
- **测试**：`tests/unit/version-gate.test.ts`（低于/等于/高于范围、取不到、非 semver）与 `tests/integration/version-gate.test.ts`（hub 接线：越界告警一次 + 逐行标注；范围内不动；取不到只记录）。

## 已知限制

- **会话发现恒为 `partial`，`complete` 不可达（阻塞 A10）**：Hub 的会话注册表只由全局事件流增量填充（rev3 会话发现方案①），插件加载前已存在、此后不再发事件的会话永远不会出现（冷启动盲区）；平台也没有全量枚举/对账接口可补齐。**且事件流不回放**：`event.subscribe()` 只投递**订阅之后**的事件，插件加载/重连前已创建的会话，其 `session.created` **永久丢失**——这类会话只能靠**任意后继事件**（带 `sessionID`）被发现，故其注册条目的 `createdAt` 记为 `null`（我们没看见创建，就不编造时间），timeline 只有订阅点之后的前缀。既然没有任何事件序列能**证明**覆盖完整，`session.discovery` 能力行的 `metadata.discoveryState` 就诚实地恒报 `partial`（并附 `metadata.reason`），`runtime.getCapabilities` 与各会话 metadata 的 `partial` 布尔同样恒为 `true`。**本版不存在"翻转成 complete"的触发点，也刻意不造一个假触发点**：等外部全量对账通道落地后，翻转必须以规范名 `runtime.capability.updated`（`BRIDGE_NOTIFICATION_METHODS.capabilityUpdated`，与 `server/runtime_host.py:186` 一致）通知 Connector，而不是静默改值。
- **运维含义（自检 / 重启）**：日志里**没有** `session.created` **不等于没装上**——只要出现 `loading plugin` 与端点文件即是已加载（见「自检」）；已订阅之后新建的会话仍会带来 `session.created`。重启插件会重新订阅，必然丢一段历史，**属预期而非故障**；需要完整历史时应在会话空闲期重启（不解决冷启动盲区，那条通道本版不存在）。
- **子会话（subagent）：事件可见；父级关系经 TUI 通道获取（运行期动态标注）**。OpenCode V2 的子会话就是普通 Session——其 `session.created`/`session.renamed`/`session.agent.selected` 等事件同样进入全局流，且带**自己的** `sessionID`。因此本 Hub **会**像普通会话一样发现并投影它们（这就是能力行 `session.subagents` 的 `supported:true` 唯一含义：**事件层覆盖**）。
  - **父级关系来自 TUI 通道**：运行时刻 `session.created` payload **无 `info`**（无 `parentID`/`agent`），`ctx.session.get()` 无 `parentID`，`GET /session/{id}/children` 在本 build **404**（spike 02）。唯一带 `parentID` 的公开类型是 TUI 宿主 SDK 客户端（`api.client`，`@opencode-ai/sdk/v2` 的 `Session.parentID`）。故 **TUI 插件**用 `api.client.session.list({ roots:false })` 枚举会话，**原子写** `~/.agents-anywhere/opencode-bridge/session-index.json`（`{ updatedAt, sessions:[{ id, parentID?, title?, agent?, location? }] }`，tmp→fsync→rename，失败 fail-soft 不阻断），**Hub** 读该文件得知哪些是子会话。
  - **`session.subagents` 的 `metadata.parentRelation` 按运行期实测动态标注**：索引**新鲜**（`updatedAt` 在时效上下界内）→ `supported` + `parentRelationSource:"tui-session-index"`；索引缺失/损坏/**过期** → 回到 `unavailable` + `parentRelationReason`（附 `sessionIndexState`）。**绝不假装支持**：过期索引与无索引等价，既不驱动过滤、也不参与归属。
  - **子会话不进会话列表**（用户决策，对齐 AA/DSH 模型——DSH 把 subagent 从会话列表剔除）：索引**可用**时 `session.list` 只列根会话；索引**不可用**时**不过滤**（fail-soft：陈旧数据不得隐藏任何会话）。
  - **timeline 归属不变、绝不伪造**：子会话事件仍按**自身** sessionID 投影进**自己**的流；本版**不**把子会话内容合并进父会话流（那需要 Connector 侧模型改动，见下方「未验证/后续」）。审批绑定策略未改（owner 仍按 session 认领）。
  - ⚠️ **未在真机实跑验证**：`api.client.session.list` 是否真的返回 `parentID`**未证实**（TUI 装载本身已由 PTY 实测证实；仅该枚举通道的字段未证）。因此能力位**只反映运行期实际读到的索引状态**，不承诺该通道恒可用。**不读** `session_v2.parent_id`（用户未选该路）。

## 卸载与清理（残留清单）

插件没有 CLI（TUI 也无命令注册面，A10 已实测），因此**显式卸载路径**是插件启动时读取的环境变量：

```bash
# 关掉 OpenCode 后，在下次启动的环境里设置（同一 shell / 服务环境）
AGENT_AA_CLEANUP=1     # 也接受 true / yes
```

下次 OpenCode 启动时插件会：① 停止**本插件自己注册设备**对应的 Connector（Windows 用 `taskkill /T` 杀整棵进程树，含 uv 与 python 孙进程）；② 删除本插件数据目录 `~/.agents-anywhere/opencode-plugin/`（`settings.json`、`account.json` 访问令牌、`bindings/**` 设备令牌、`pending-flow.json`、`connector/connector.json`（**含明文 `connectorToken`**）与其 sqlite）；③ 删除端点目录 `~/.agents-anywhere/opencode-bridge/`。完成后写一条 warn 日志，本次**不建立**远端连接。

**不会**（也不应由插件）删除的残留，需手动处理：

| 残留 | 位置 | 手动清理 |
|---|---|---|
| 机器级共享记录（CLI/Desktop/DSH 共用） | `~/.agents-anywhere/connector-runtime.json` | 确认本机无其它 Connector 后删除该文件 |
| 已安装的插件包缓存 | `~/.cache/opencode/packages/<spec>/` | 先从 `opencode.jsonc` 的 `plugins` 移除该条目，再删目录 |
| 残留端点文件（进程崩溃时） | `~/.agents-anywhere/opencode-bridge/endpoints/*.json` | 上面的 `AGENT_AA_CLEANUP=1` 已删除整个 `opencode-bridge/`；如仍残留可手动删 |

数据目录基址可用 `AGENT_CONNECTOR_DATA_DIR` 覆盖，上表路径随之改变。

## 本地构建与安装

需要 Node.js `^22.19.0 || >=24` 与 Corepack。本包是独立的 Yarn 4 项目（`packageManager: yarn@4.18.0`），无运行时依赖，只有 devDependencies。

```bash
cd Agents-Anywhere/opencode-plugin
corepack yarn install
corepack yarn typecheck
corepack yarn test
corepack yarn build
```

仓库不提交依赖锁文件；若父目录存在本地 `yarn.lock` 导致 Yarn 报当前包不属于父项目，在本目录执行 `touch yarn.lock` 后再安装，声明独立项目边界。

`build` 做两件事：`tsdown` 构建双入口 ESM + d.ts 到 `lib/`，随后 `tsx scripts/bundle-connector.ts` 把 Connector 的**运行所需源码**复制进 `lib/connector/`（`pyproject.toml` + `README.md` + `connector/` 包；排除 `tests/`、`_deprecated/`、`_reference/` 与各类缓存；**不复制** `uv.lock`，因为仓库 `.gitignore` 忽略它）。

### 构建产物与漂移校验（产物入库）

**`lib/` 是提交进仓库的产物，不是本地临时文件。** Git 规格安装只在 `node_modules` 里放本子目录、且**从不运行任何安装脚本**（`ignoreScripts:true` + `saveType:"prod"`），安装期不可能构建，`lib/` 必须随仓库交付；`opencode-plugin/.gitignore` 因此**不再**忽略 `lib/`。

| 产物 | 内容 |
|---|---|
| `lib/index.js`·`lib/tui.js`（+ `.map`/`.d.ts`） | `tsdown` 双入口构建结果；`exports`/`main` 指向它们（package 形态） |
| `lib/connector/` | 随包分发的 Connector 运行源码（supervisor 默认优先使用它） |

`corepack yarn check:build` 是**漂移门**（供上游评审/CI）：它把 Connector 重新打包一份，并用真实 `tsdown` CLI 重建到临时目录，再与仓库内 `lib/` **逐字节比对**，不一致即失败（实测：给 `lib/index.js` 追加 1 个字节即报 `changed: [index.js]`）。它需要完整仓库布局（源码 `../connector` 与 `src/` 都在）。因此 `corepack yarn check` 的顺序是 `typecheck → check:build → build → test`——**先校验、再重建**，否则重建会把漂移悄悄抹平。改了 `src/` 后先 `corepack yarn build` 再跑 `corepack yarn check`，并把新的 `lib/` 一并提交。

### 安装进 OpenCode（形态 B′，已实证）

分发实证（`opencode-dist/02` 矩阵 + A10 探针）结论：**file 源（本地目录）只认目录根的固定入口——服务端 `<dir>/index.*`（`index.ts|tsx|js|mjs|cjs`），TUI `<dir>/tui`（`tui.ts` 或 `tui/index.ts`）——完全不读 `package.json` 的 `exports["./tui"]`，且解析不到时【静默跳过】——没有 loading、没有 failed、没有任何日志。** 只有 npm/Git 渠道（package 形态）才消费 `exports`。因此本包在仓库根放两个转发入口：`opencode-plugin/index.ts`（服务端，`export { default } from './src/server/index.ts'`）与 `opencode-plugin/tui.ts`（TUI，`export { default } from './src/tui/index.ts'`），Bun 直接编译 TS；同时 `exports`/`main`/`types` 指向**构建产物**（`"."` → `./lib/index.js`，`"./tui"` → `./lib/tui.js`）以覆盖 npm/Git 渠道，`files` 含 `index.ts`、`tui.ts`、`src` 与 `lib`。**两个 shim 仍指向源码**（`./src/server/index.ts` / `./src/tui/index.ts`）而非 `lib/`：目录形态本就免构建，指向 `lib/` 会在产物缺失时**静默不加载**（dist 02 矩阵 Z7），指向源码则永远可用；根 `index.ts`/`tui.ts` 与 `lib/index.js`/`lib/tui.js` 路径互不重叠，**有产物时不冲突**。

### Git 规格安装（自包含；但本机 Windows/v2.0.18 走不通）

上游/CI 的目标形态是 Git 规格：

```bash
opencode plugin add 'github:<org>/Agents-Anywhere#main::path:opencode-plugin'
```

它只把 `opencode-plugin/` 子目录装进 `node_modules`（同级**不会**有 `connector/`），且不跑任何安装脚本——这正是 `lib/` 与 `lib/connector/` 必须入库的原因（见上）。

> **实测事实（本机 Windows + OpenCode Desktop v2.0.18）**：**任何 Git 规格都装不上**——`git+file:///…::path:opencode-plugin` 与 `github:…#main` 都在 npm 的「git 依赖准备」步骤直接失败（`NpmInstallFailedError: git dep preparation failed`），根因是编译后的单文件 CLI 无法把子进程分派到内嵌 `npm-cli.js`（`opencode-dist/03` §3 已复现）。故本机**未做过 Git 规格的完整安装闭环**。

**兜底**：Git 规格不可用时用本地路径形态（上面的方式 1/2），或对已安装的包显式给出 Connector 路径：

```bash
AGENT_CONNECTOR_SOURCE=D:/path/to/Agents-Anywhere/connector   # 显式覆盖，优先级最高
```

方式 1 — 全局配置加一行（推荐给普通用户）：

```jsonc
// ~/.config/opencode/opencode.jsonc
"plugins": ["file:///C:/绝对路径/Agents-Anywhere/opencode-plugin"]
```

方式 2 — 项目级零配置自动发现（推荐给开发者）：

```bash
mkdir -p .opencode/plugins/agents-anywhere-opencode
cp -r <repo>/opencode-plugin/. .opencode/plugins/agents-anywhere-opencode/   # 排除 node_modules
```

> 实测要点：
> 1. 目录形态的 `<dir>` 里**必须**同时有 `index.ts`（服务端）与 `tui.ts`（TUI）；缺 `index.ts` 时整个目录被**静默跳过**，缺 `tui.ts` 时只有 TUI 面缺失（注册表 `features.tui` 为 false）。
> 2. **全局** `~/.config/opencode/opencode.json(c)` 的 `plugins` 写**本地绝对目录**已实测可行；**项目根** `opencode.json` 的 `plugins` 键**不生效**，不要写在那里（项目级请用方式 2 的 `.opencode/plugins/` 自动发现）。
> 3. **`cli.json` 不是插件配置载体**：把本地路径写进 `cli.json` 后日志零 `loading plugin` 行（A10 实测）。不要再把 `cli.json` 当作安装方式。
> 4. `opencode plugin add` **只接受 npm registry 包或 Git 规格**；本地路径与 `file:` 规格均报 `Plugin target must be an npm registry package or Git package specifier`。

### 自检（必做，因为失败是静默的）

1. 启动日志出现 `msg="loading plugin" … entrypoint=file:///<path>/opencode-plugin/index.ts`；
2. 出现端点文件 `~/.agents-anywhere/opencode-bridge/endpoints/<pid>-<port>.json`；
3. 若本机还没有可用凭据：日志会先有一行**需要登录**（含原因 + 当前服务器），随后一行**已自动发起登录…**（授权 URL 或设备码短码），并写出 `~/.agents-anywhere/opencode-plugin/login.json` —— 点一次「授权」后应出现 `已连接：账号 …，设备 …`。若第 3 条只出现「自动登录已关闭…」，说明 `options.autoLogin` 或 `AGENT_AA_AUTO_LOGIN` 把它关掉了（该行会写明来源）。

**前两条缺一即未装上**（目录 spec 解析不到入口时零日志、零报错）。TUI 入口在 file 源下按目录形态解析为 `<dir>/tui`（即仓库根的 `tui.ts`），**不消费 `exports["./tui"]`**（那是 package 形态的通道）；全量 TUI 的装载已由 PTY 实测证实（A10），`opencode mini` 不加载 TUI 插件。

### Connector 前置

插件用 `uv` 启动 Connector。源码解析顺序：① `AGENT_CONNECTOR_SOURCE` / 显式配置（覆盖最高优先）② **包内** `lib/connector/`（随包分发，Git/包形态下唯一来源）③ 开发期同级 `../connector`；都没有则给出可操作报错（不静默），报错里会列出已尝试的路径。`uv` 缺失同理报错，可用 `AGENT_CONNECTOR_UV` 指定其绝对路径（安装：<https://docs.astral.sh/uv/>）。数据目录可用 `AGENT_CONNECTOR_DATA_DIR` 覆盖（默认 `~/.agents-anywhere`）。

### TUI（A10 已实测：装载证实，仅状态提示）

PTY 实测（`opencode-cli` 2.0.18，证据见 VERIFICATION §二）：**全量 `opencode`（裸 / `--standalone`）会求值并调用本模块的 `setup()`**；**`opencode mini` 不加载 TUI 插件**。模块契约 = `export default { id, setup }`（宿主的 `xCt` 校验器只接受这两个成员；旧的 `{ id, tui(api) }` 判 `Invalid V2 TUI plugin module`）。仓库根另有 `tui.ts` 转发 shim 供目录形态解析。

`setup(context)` 只使用**实测存在**的面：`ui.toast`（状态提示）+ 可选的 `attention.notify`（桌面提醒）。真实 TUI ctx 的 13 个顶层键为 `options, location, app, renderer, client, data, attention, theme, themeMode, markdown, keymap, storage, ui`；其中 **`keymap` 没有 `registerLayer`、也没有 `command` 域**，`ui` 里**没有 `DialogAlert`/`DialogPrompt`** —— 因此旧版的 `keymap.registerLayer(...)` / `command.register(...)` 调用是**静默空操作**，已删除。

**不做的事（明确列出，不伪造）**：

- **不注册任何命令**：2.0.18 没有命令注册面，`/` 面板里不会出现 `/aa`；`setup` 只在 `keymap.layer` **是个函数**时尝试注册（这是唯一可能承载命令的成员），失败或缺失都**静默降级**为 `none` 并只写一条 debug 日志。**`keymap.layer` 的可写性与入参形状未在真机确认**。
- **不实现 JSX / slot / markdown 渲染**：`ui.slot` / `ui.panel` / `markdown.registerCodeBlockRenderer` 需要 JSX 运行时，与本包零依赖冲突；`describeSurfaces()` 只**报告**这些面，绝不注册（二维码面板同因此未实现）。
- **登录不从 TUI 触发**：登录主触发在**服务端**——`/aa-login` 命令与缺凭据自动登录；TUI 未登录时的 toast 文案即指向 `/aa-login`。

`setup` **永不抛错**：缺任何面都安全返回可用的 dispose 句柄，不干扰宿主插件链。此外若探测到宿主 SDK 客户端（`context.client`），会在装载时与随后每 60s 用 `client.session.list({ roots:false })` 枚举会话并**原子写** `~/.agents-anywhere/opencode-bridge/session-index.json`（Hub 据此得知父子关系）；无客户端时是 no-op，枚举失败/形状不识别时**不覆盖**旧索引，`dispose` 时停止写入——整条链路 fail-soft。

## 开发模式

包内**没有** `dev` / `watch` 脚本（对照 DSH 的 `corepack yarn dev`）：改动 `src/` 后重新执行 `corepack yarn build` 更新 `lib/` 即可。本包不启动 OpenCode、Connector、Server 或 Web——它们都是外部进程，本包只在 OpenCode 进程内运行。

| 命令 | 用途 |
|---|---|
| `corepack yarn typecheck` | 服务端、TUI、构建脚本、**测试**四套 tsconfig 的 `tsc` 检查（`tsconfig.tests.json` 已接入，测试的类型错误即回归） |
| `corepack yarn build` | `tsdown` 构建双入口 ESM 与 dts，并把 Connector 打包进 `lib/connector/` |
| `corepack yarn check:build` | 漂移门：重新打包 Connector + 用真实 `tsdown` CLI 重建，与仓库内 `lib/` 逐字节比对 |
| `corepack yarn test` | `tsx --test` 跑 `tests/unit` 与 `tests/integration` |
| `corepack yarn check` | `typecheck → check:build → build → test` 串联 |

协议字段曾与 Connector 侧逐字段镜像（改 `src/shared/protocol.ts` 要同步 `connector/connector/runtimes/opencode/bridge/*.py`）——**该 bridge 目录已随对端形态改造删除**，现在两侧不再共享协议：对端直接用宿主 `/api/*` 的 JSON，形状与陷阱记在 [`docs/opencode-server-surface.md`](../docs/opencode-server-surface.md)。仍然保留的两侧一致性只有一条：平台会话 id 的推导 `sess_opencode_ + sha256("<namespace>:opencode:<externalId>")[:24]` 必须与历史数据字节一致（`serve/mappers.py::platform_session_id`）。`runtime.error` 通知的 `data.code` 走白名单（`isascii`/字母数字/`_`，≤80 字符），不夹带原始异常消息或凭据。
