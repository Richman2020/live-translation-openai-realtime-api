# CI #73：受控刷新边界的测试同步与安全诊断

本轮从精确父提交 `e97ab1a3139381411daaedec99b2b29f4252058b` 在独立本地分支 `codex/ai-phone-ci73-controlled-fixture-20261016` 开发。原集成分支、原 CI 日志及未提交的进度记录已保留。只修改受控浏览器夹具、两份测试和本记录/PROGRESS；没有改 `src/`、`public/`、工作流、模型、音色、鉴权、电话保护或第257响应容量限制。

## 原始失败、实际复现与结论

原 CI [#73 / run 38833366465](https://github.com/Richman2020/live-translation-openai-realtime-api/actions/runs/38833366465)，attempt 1，head 为上述 e97。`verify-controlled-browser.mts` 原1752行在模拟媒体断开后等待 `readonly && !mute` 超时12秒；此前 manager 闸门已经释放。原日志没有失败瞬间的页面 phase、mute、SDK、bootstrap 完成及 SSE 接收顺序。因此原 CI 首个异常及具体竞态仍未确认，不能归因 DBus、页面泄漏、取消或某个供应商。

源码可确认一个独立的**测试就绪条件缺口**：夹具在后台恢复并点击刷新后只等待 mute；工作台刷新先关闭旧 SSE、标记 disconnected，再异步读取状态并重建 SSE。而 `controller-client.js` 的 accepted-call `canMute` 本来就不依赖 connected。因此 mute=true 不能证明刷新完成。这个行为本身不构成业务缺陷。

使用现有真实本地 Chromium、真实工作台和本地假电话/媒体，分别扣留原生 bootstrap 响应或下一条原生 SSE 请求：

- bootstrap-held：页面 active/mute=true/connected=false，bootstrap 20次开始、19次完成、1次待完成。媒体在此时断开；释放原始响应后，页面 readonly/mute=false/SDK closed；服务端无活动通话、Voice reservation=0，两条假供应商腿各清理一次。
- sse-held：bootstrap 已完成，但当前 SSE=7、已打开 SSE=6；页面仍 active/mute=true/connected=false。媒体断开并释放真实请求后，同样严格收尾。
- 正常就绪后断开也收尾通过。向已关闭的旧 SSE 实例人工注入迟到 active 事件，确认实际派发且诊断接收数增加1，不能恢复通话或引起额外写请求。

以上确认旧 mute-only 屏障确实可过早通过；**没有复现原 CI 的确切超时事件顺序，也没有确认生产页面未收尾的缺陷**。正常断开、真实扣留请求的两个边界，以及人工构造迟到事件必须分开看。没有用新增业务清理、伪造终态、修改 DOM 或强制 revoke 使测试通过。

## 最小修复及诊断

1. 刷新后等待可验证条件：新 bootstrap 已开始且所有读取完成/无 pending；新 SSE 是当前实例且已经 open；页面连接且可见；活动状态、mute 与 SDK 均匹配。未增加固定延时或放宽12秒失败条件。
2. 保留原 `readonly && !mute`，改为一次原子页面读取，并额外要求 SDK 关闭、服务端闸门释放、Voice reservation 清零及原控制所有权释放。
3. 新增固定字段白名单的有界安全时间线：服务端 call status、闸门、Voice reservation、清理计数；页面 phase/mute/SDK；bootstrap 开始及 JSON 读取完成时间；SSE 实例、open/close、接收顺序；扣留/释放及收尾。页面时间带 document timeOrigin，不把服务器产生事件当作浏览器收到事件。一般服务端快照不冒用缓存 bootstrap 中的 controller mode。
4. 只记录本地序号、固定 route/status/phase、布尔值及时间；不序列化 URL/query、认证头、cookie、CSRF、lease proof、号码、SID、正文或任意异常对象。每页最多512条、合并最多1024条，淘汰数有记录，发生失败另留原子状态快照。该窗口是诊断容量，与翻译的256关联窗口无关。
5. 两个 gate 只绑定一个页面/精确请求，有限超时、finally 释放；没有新增授权请求或重试。清理先停脚本/加载、排空 CDP、关闭连接，再执行严格异常和外部请求断言，最后才写 acceptance，避免遗留成功文件掩盖收尾失败。
6. 新增10项诊断安全测试、7项真实 controller 契约测试，覆盖断开前后、断流后 fresh read、终态先后、处理中的清理、迟到读取/事件。明确建模工作台外层 terminal → hangup，不把缺少外层动作的 controller-only 中间 ready 状态冒充生产缺陷。

## 最终冻结验证

| 检查 | 本轮最终结果 |
| --- | --- |
| 额外 fixture noEmit 类型检查 | 通过（包含本夹具及两份新测试）。 |
| `npm run typecheck` | 通过。 |
| `npm run build` | 通过。 |
| 全部 `tests/*.test.ts`（Node/tsx，concurrency=4） | **2185 total / 2180 pass / 5 Windows-only skip / 0 fail**。 |
| 全部 `public/*.js` 的 `node --check` | 通过。 |
| `npm run test:conversation:browser` | **43项通过**；exceptions=[]，externalRequests=0。 |
| `npm run test:controlled:browser` | **107项通过**；exceptions=[]，externalRequests=0。 |
| `npm run test:controlled:continuous:browser` | **114项通过**；exceptions=[]，externalRequests=0。 |
| `npm run test:controlled:continuous:browser（paired captions=false）` | **111项通过**；exceptions=[]，externalRequests=0。 |
| `npm run test:google:browser` | **29项通过**；exceptions=[]，externalRequests=0。 |
| `npm run test:web-verification:browser` | **50项通过**；exceptions=[]，externalRequests=0。 |
| `npm run test:web-workbench:browser（daily）` | **84项通过**；exceptions=[]，externalRequests=0。 |
| `git diff --check` | 通过；含此前未执行项。提交前另核 staged 新文件，提交后再核完整提交差异。 |

本地最终七组浏览器均执行，未跳过 daily。5项跳过仅 Linux 无法执行的 Windows 进程时间戳/ACL 用例。Node 网络守卫的193份进程回执外连尝试合计0；浏览器仅本地假供应商，0真实供应商调用。Docker 未在本轮执行，新SHA完整GitHub CI也尚未执行。

使用现有锁定依赖、Node v24.19.0、Chromium 151.0.7922.173；无安装。所有最终命令逐项核对5份源码 SHA256，执行前后不变。Node 进程只允许 loopback/本地 socket；浏览器只操作本地假 SDK/供应商，所有受控浏览器 acceptance 都检查无外部服务请求。没有真实模型、电话或录音上传。

## 所有开发运行记录

没有重跑 CI 或靠重复相同命令挑选成功。以下早期失败都保留，未当作最终通过：

| 运行 | 结果与处置 |
| --- | --- |
| 初次额外夹具 noEmit 类型检查 | exit 2；临时检查配置未启用既有 `.mts` 导入所需选项，且 fixture JSON 目标缺类型；仅补检查配置及目标类型断言。 |
| trace helper 第1次 | 9/10；测试预期白名单字段数25而实际23，修正测试计数。 |
| trace helper 第2次 | 10/10。 |
| 独立可控 controller 状态复现 | 7/7；无浏览器/网络，仅验证状态合同。 |
| 永久边界测试第1次 | 7/7。 |
| 初次真实 Chromium 诊断 | 99项通过；随后加强 gate/收尾/迟到事件确实派发的断言，重新冻结后才进行完整验证。 |
| 第2次额外夹具 noEmit 类型检查 | exit 2；新增测试的 `resolve()` 少了 void 参数；修为 `resolve(undefined)`，无行为变化。此项原始输出仅终端保留，结构化记录明确标为非原始日志，不伪造日志。 |
| 永久边界测试第2次 | 7/7。 |
| 独立审查的纯事件检查 | 17/17；发生在上述 void 类型修正前，哈希绑定在独审回执；最终冻结17项由全量回归覆盖。 |
| 最终冻结全部检查 | 见上表；每个命令执行一次，保留 argv、退出码、时长、前后源码哈希、日志及浏览器产物。 |

独立审查不访问平台或凭据，不替代浏览器实测。审查建议的收尾后断言、精确一次 gate、超时计时器释放、缓存 mode 标注和迟到注入有效性均已处理；最终回执另绑定冻结哈希。

## 保存、剩余限制和下一步

审计目录：`/workspace/ai-phone-reference/ci73-local-fix-20261016`，含原 CI 日志、原进度全文/patch、哈希、全部尝试、最终浏览器 acceptance/安全时序及独审。保留原进度中的前阶段失败事实，不以本次本地成功改写 GitHub #73 为成功。

本次仅形成新本地提交。后续拟申请范围：把本提交（以最终回执的完整 SHA 为准）非强推到 `codex/cloud-phone-conversation-livetranslate-ci-20261015`，先核远端仍为 e97 或已是同 SHA，复核实际自动部署关联，再跟进该精确 SHA 的完整 CI（含 Docker 与七组浏览器）。本轮未做新 SHA 的 GitHub CI 或 Docker；不能拿旧 CI Docker 成功替代。

本轮不 push/PR/merge/deploy、不改 Railway/Twilio/凭据/网络；没有新增付费调用。最后已知线上仍是前阶段只读记录 `6d061820d8cbb062ec3e3a168f05dd3bbd9b63ec` / `f2609bcc-7ec3-456b-80e9-50ba03a8b431`，本轮未重新访问平台，不能把它说成刚回读。语音方案及线上设置未改。**第257个单来源响应停止翻译仍未解决**；真实通话、长通话及新 SHA CI 均未验收。
