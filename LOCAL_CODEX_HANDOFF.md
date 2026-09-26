# 电脑端 Codex 接手：本机 solo 电话翻译

日期：2026-09-26。共享仓库：<https://github.com/Richman2020/live-translation-openai-realtime-api>。

当前已实现本机 solo 工作台，企业主档案获批、供应商检查 4/4、号码回调及真实手机接通已有证据，**21216 不再是当前实测阻塞**。最新状态优先读 [PROGRESS.md](PROGRESS.md)，旧 [READINESS_REVIEW.md](READINESS_REVIEW.md) 为历史检查，操作见 [LOCAL_SETUP.md](LOCAL_SETUP.md)。

## 最新接手重点（2026-09-26 09:33 UTC）

本轮无法拨号有两处实际阻塞：本机 worker/server 消失、5050 无监听；旧临时隧道进程仍存活但持续 `Unauthorized: Tunnel not found`，公网 530/1016。现已恢复：两个启动脚本用隐藏 CIM 独立进程，页面失联继续原频率重试、状态成功按来源清旧错并恢复事件连接；正式安全 Stop/Start、重复启动复用、195 项测试通过。新隧道地址仅存本机，原号码/TwiML App 回调已更新并回读 configured，09:33:41Z 公网 ready、无活动通话。没有自动拨号；临时隧道未来仍可能失效，不声称长期可用或无人值守自愈。

## 同日此前（06:43 UTC）

用户已完成固定 V1 真人测试，当前报告识别偏差及耳听 2–3 秒，尚未验收解决。新增耳麦输入选择、实际音轨名称及服务端转写/排队/首音频分段计时已部署；当前页面耳麦输入/输出已选定，未自动拨号。项目默认保持 Whisper，本机私密配置显式改为 `gpt-4o-transcribe` 候选，VAD 不变；同音频 12 句合成 A/B 的转写等待中位数 1068→486 ms，仅证明这组样本，历史候选识别错误保留。

全量 187/187、构建、定向 lint/语法通过；安全重启后的 API 4/4 和公网 readiness 通过。06:26–06:28Z 真人电话正常结束、无 OpenAI 重连，但收到的 RTC 样本有下行丢包；不能据此认定上行 ASR 根因。下一步同稿、同设备，记录原文和耳听等待；查看 [PROGRESS.md](PROGRESS.md)、[ASR_AB_2026-09-26.md](ASR_AB_2026-09-26.md)。此后不要将下面的历史运行值覆盖回当前配置。私密原始结果仍留 `.runtime/`，不提交。

## 同日此前接手重点

- 用户自行 `03:35–03:36Z` 测试，PSTN 61 秒/浏览器 68 秒；真实 mark 确认英语 14 段/289200 字节、中文 5 段/39200 字节，请求/回调 200/204、无流错误。local 共生成 15 段/318400 字节，另有未确认 1 段/29200 字节及一个 0 字节项目，不算已播放。真实听感、翻译质量及疑似回录/ASR 异常仍待确认，不复制真人字幕。
- 03:15–03:16 的三次 31603 实为 `/voice/client` 530 / Cloudflare 1033 / Twilio 11200，没有 PSTN；隧道 TCP 7844 超时后自动重连。Windows 日志未证实休眠，不归因为休眠或再次 KYC 拦截。已加入拨号前公网探针，仍不保证持续稳定或自动改绑。
- 新采音在实际获取时请求 AEC/降噪/自动音量 ideal 偏好，只回读布尔值，缺失显示未知、取消及新通话清空。20 秒本机检测三项 true、RMS 峰 0.09011、76/1201 有声帧，音轨释放，无录音；不证明手机外放已被消除。
- 翻译使用最终 ASR 文本驱动单句输出。新增 `OPENAI_TRANSCRIPTION_MODEL`，默认保留 `whisper-1`，可选 `gpt-4o-transcribe` / `gpt-4o-mini-transcribe`，严格核对供应商确认，不自动回退。真实 gpt-4o 候选接受 4 句，但首句把“今天”识别成“天天”而误译，其余 3 句正确、音频非零；此前 Whisper 4 句成功只是 fixture 证据，不保证普遍可靠。
- 全量 138/138、定向 4 源文件 ESLint 通过；默认恢复 whisper-1 后 4 项受影响测试、最终构建和 app 语法通过。`03:48Z` 正式 Stop 确认清理后 Start 加载；`03:49:26Z` 回读运行模型 whisper-1、新设置 ready、无活动会话，真实严格模型确认 API 4/4、公网 readiness 通过。Computer Use 已确认电话开启、注册可接收来电、拨号可用及新诊断说明可见，保留工作台和本机诊断页；提交推送以 Git 核验为准。企业获批档案地址国家差异仍待独立处理，未发送支持消息。
- 下一步等用户本次实际听感反馈；耳机、手机听筒及其他外放隔离准备好后再做交替固定句对照，不新增无准备电话。不采用自动删句或半双工静音掩盖问题。保留私密配置与并发改动，完成后按 Git 回读报告开发分支、提交与远端状态，草稿 PR 不等于合入 main。

## 2026-09-24 历史复测（被顶部最新结果更新）

同日后续已完成用户提供的企业文件摘取、关键页面核对及私密表单准备；用户确认使用真实经营地址。资料在受限的 `.runtime/support-materials/business-profile/`，共享仓库不保存身份字段。尚未在 Twilio 填写或提交。当前浏览器控制仍超时，已准备应用进程级代理启动入口；缓存 MCP 配置会被启动过程覆盖，不能继续重复该缓存补丁作为稳定修复。用户从新入口启动后，应先用真实页面读取验证连接，再继续企业表单，详见 [PROGRESS.md](PROGRESS.md)。

进一步的原始拒绝、历史通话方向、主账户关系及主档案地址关联已核对，详见 [TWILIO_21216_DIAGNOSIS.md](TWILIO_21216_DIAGNOSIS.md)。最小内联 TwiML 外呼也直接返回 21216；主档案地区与用户描述存在差异，正在核对真实资料及适用的认证路径。私密支持草稿已准备未发送，不应再只以号码为美国号判断账户地区，也不能在供应商未确认前断言某一限制已被最终证明。

用户说明账户为美国账户。原有号码的账户归属、语音能力、运行配置、号码回调及 TwiML App 回调均已实时核对正确，未购买或更换号码。08:54 再次真实拨测仍返回 21216/HTTP 400：浏览器线路持续 2 秒，目标手机通话未创建，清理已确认。具体供应商拦截规则未确定，不能归因于缺少企业档案。详细记录及同步基线见 [PROGRESS.md](PROGRESS.md)。

## 2026-09-23 历史接入与验证记录

- Codex 内置浏览器已实际操作 Twilio、OpenAI 和本机工作台，本轮完成麦克风预检、超时及取消真机验证。Chrome 控制本轮再次约 21 秒后 fetch 失败，独立诊断仍在进行，不把它说成全部网页不可操作。
- Twilio 账户、已有号码、项目 API Key/Secret 与 TwiML App 均已保存；OpenAI 专用密钥已按用户明确批准通过网页创建并经本机设置 UI 保存。7 项供应商设置全部在受限且忽略提交的 `.env`；`check:solo` 的 10 项必需设置全部 `ready`。不重复创建密钥或资源，不将值、SID、号码或私密账户资料写入共享文档。
- 本机服务与隧道运行，公开健康探针通过；临时域名仅留本机。正式 `verify:providers` 在 `2026-09-23T06:05:55.183Z` 返回 4/4 通过：三个 Twilio 项为 `VERIFIED_RESOURCE`，OpenAI 为 `SESSION_UPDATED`，未发送音频或拨号。
- `configure:twilio -- --apply` 已返回 `status: configured`，现有号码 Voice 回调正式接入本机并完成远端回读核验；SMS 未改，原语音配置保存在私密 `.runtime/`。未购买新资源，`realCallTested: false` 表示改绑工具本身不拨号，不包含随后单独的 UI 拨号尝试。
- 麦克风已由用户授权，独立诊断取得 1 条有效音轨并立即释放。工作台旧请求即便权限为 `granted` 仍曾等待；确认无活动电话后刷新并重新注册，真实预检成功。早先的 `prompt`、75 秒 `CALL_SETUP_TIMEOUT` 和 Twilio 查询为空均属未授权阶段历史。
- 本轮 TwiML App Voice 地址/方法匹配，公网健康探针 200 且应用标识正确，无签名 `/voice/client` 表单请求 403。随后两次真实浏览器通话分别持续 2 秒和 1 秒，目标手机通话均未创建；第二次服务事件明确记录 `21216` / HTTP 400。线路清理已确认、`activeSession: null`，无手机响铃/接通、字幕或翻译音频证据。
- 当前按 [Twilio 21216 官方说明](https://www.twilio.com/docs/api/errors/21216)排查风险、监管及适用的 +1 Primary Profile 限制。只读核验显示账户 Full/active、余额为正、美国普通号码地理权限已开、已有获批 Individual Primary、缺 Business Primary，账户创建日期在 2025-10-08 及之后；用户已于 2026-09-24 说明为美国账户，不能宣称 Business Profile 一项就是已证实根因。
- 前端先预检再建会话；30 秒超时、取消、迟到结果及旧 Device 隔离、准备中的来电拒接均已实现，预备流单次交给 SDK。未授权时超时/取消不创建后端电话已真机验证；新增合法数字形式的供应商错误码、HTTP 状态及 21216 页面指引，不暴露原始错误。缺本机令牌的全局错误已在设置页可见并真机验证。
- 原本机保存审批故障已解决，官方密钥连接器两次拒绝留作未明原因的历史记录；网页创建及本机保存已完成。OpenAI 直连超时已通过可选 `OPENAI_PROXY_URL` 解决，验证和实际翻译连接共用该配置，留空直连；代理私密保存后已清理线路并安全重启服务。
- 本轮最终 80/80 项测试、构建、前端语法、TypeScript、定向 lint 及差异检查通过；服务经正式停止脚本确认安全清理后已重启，不重建密钥。全内存探针仍只是替身证据；真实浏览器通话与目标手机通话结果分开记录。开发分支 `codex/local-phone-workbench` 的 `886b62a` 已核对远端，PR #2 仍为草稿未合入，本次新增修改的推送须按 Git 及远端核验。

## 2026-09-24 当时执行顺序（历史，当前步骤见顶部）

1. 按用户已说明的美国账户，核对 Twilio 21216 的适用条件及需要的真实资料或支持审核，不推定 Business Profile 就是原因。麦克风和浏览器线路已通过；处理供应商限制后再进行目标手机实测，不重复创建密钥或资源。
2. 核对隧道地址仍匹配；临时隧道重启可能换址，当前没有自动恢复或自动改绑。
3. 仅在隧道地址变化或相关配置改变时重新准备 App、验证 API，并运行 `configure:twilio -- --apply` 更新回调和回读核验；保留私密旧语音配置备份，短信路由不变，不重复询问旧号码改绑授权。
4. 使用用户指定测试号码，验收外呼、来电、中英两个方向、字幕、挂断/故障清理及真实延迟和用量。没有实际结果前不宣称电话可用。
5. 保留并发改动，把非秘密交接结果提交推送到 `codex/local-phone-workbench` 并核对远端；不得称为已合入 `main`。

## 代码来源与协作边界（历史基线，当前提交以 Git 回读为准）

此前实现提交（`d9394f4ff12addcbceed3c88fa404edc75b8eb44`）未能推送。2026-09-22 晚间 GitHub 连接恢复，已获取并整合远端 `main` 的 `5fabf51`，保留网页版并发检查记录。完整交付提交 `457ea22` 已推送到 `codex/local-phone-workbench` 并核对远端，已建立[草稿 PR #2](https://github.com/Richman2020/live-translation-openai-realtime-api/pull/2)，尚未合入 `main`。网页版读取时须明确该开发分支，不能只看仍为旧 Flex 版本的 `main`。

- 工作目录：`C:\Users\admin\Documents\ChatGPT\AI电话\live-translation-openai-realtime-api`。
- 开发分支：`codex/local-phone-workbench`，本轮从 `main` 的 `1c9eddf548d9783dbb90d8297022f374b742e35f` 同步后开发。此处记录基线，不将其称为今后永远最新的远端。
- 本轮新增 `src/solo/`、`public/`、桌面/隧道/供应商配置脚本及测试；保留上游 Flex 路由与服务代码。先检查 `git status`、分支与远端，再获取和安全整合并发修改，不能重置覆盖。
- 同级 `desktop-preview` 和旧桌面「AI电话（预览）」继续保留。新「AI电话」入口启动当前仓库 solo 服务；不要再把旧静态预览当作真实通话实现。
- 先读 [AGENTS.md](AGENTS.md)、[PROJECT_BRIEF.md](PROJECT_BRIEF.md)、[PROGRESS.md](PROGRESS.md)。历史补丁对应的内容已在共享基线中，不重复应用旧安装或交接补丁。
- 当前为草稿开发分支，尚未合入 `main`。最终 commit 与推送以 Git 历史和远端核验为准，本机工作区变化或本地提交不能称为已经同步。

## 用户既有决定

先在用户电脑开发和运行，暂不部署 Railway 等云主机。用户已授权复用现有 Twilio 号码、替换旧语音回调；新服务和 API 就绪后执行，无需再次询问是否保留旧回调。这不授权删除旧系统数据/资源或开通 Flex。

目标是中文使用者主动拨打美国电话、接听来电，双方听到各自语言并查看字幕；真实端到端延迟是验收重点。当前代码已实现 solo 路线，早期文档中“候选、待开发”是历史状态。

## 入口与实现地图

| 路径/命令 | 职责 |
| --- | --- |
| `src/solo/config.ts`、`npm run check:solo` | solo 配置校验、本机秘密保存；不要求 Flex 变量 |
| `src/solo/server.ts`、`npm run start:solo` | 本机 UI/鉴权 API/SSE、语音 Webhook 与媒体流；公开 `/api/health` 仅返回应用标识 |
| `src/solo/session-manager.ts` | 单通话、Voice SDK 接入、两侧配对、状态回调、号码限制及挂断清理 |
| `src/solo/translation-bridge.ts` | 两个独立 Realtime 翻译会话；我方普通话→英语，对方英语→普通话；等待配置确认 |
| `public/` | 实际状态与字幕驱动的中文工作台，私密设置、手动 API 验证、可选本机记录 |
| `scripts/Start-AIPhone.ps1`、`Stop-AIPhone.ps1` | 识别服务与进程归属、隐藏启动、安全清理后停止 |
| `scripts/Install-DesktopShortcut.ps1` | 新建「AI电话」桌面入口，保留旧预览 |
| `scripts/Start-Tunnel.ps1`、`Stop-Tunnel.ps1` | 使用本机 cloudflared 建立临时隧道并保存公开地址；确认无通话后只停止本项目隧道 |
| `npm run configure:twilio` | 默认只读计划；`-- --prepare` 准备资源；`-- --apply` 验证后切换号码 |
| `npm run verify:providers`、设置页「验证 API 连接」 | 实际 Twilio 资源和 OpenAI Realtime `session.updated` 验证，不发起电话 |

浏览器只得到短期语音令牌，不得到供应商长期密钥。拨号使用服务端生成的会话标识和一次性连接参数，不能绕过后端另拨一通；SSE/记录不包含连接 nonce。忙线和线路关闭未确认时阻止下一通，允许重试挂断。停止脚本收到 `ok` 与 `safeToStop` 均为 `true` 后才能回收自己的后台进程。

## 2026-09-22 已验证与尚未验证（历史快照）

以下保留当时检查结果；其中“7 项配置缺失”“Twilio 页面空白”“没有供应商 API 验证”“号码未切换”等均已被上方 2026-09-23 的实际结果更新，不代表当前状态。真实电话与延迟尚未验证的边界仍适用。

本机 Node.js 24.15.0、npm 11.12.1 下，`npm run build`、最终 `npm test` 54/54、`src/solo/` ESLint、独立 scripts TypeScript 检查和锁文件 `npm ci --dry-run` 均通过。Windows 实际 fixture 验证空临时文件先应用私有 ACL，再写入测试秘密及原子替换；未使用供应商真实密钥。

Windows PowerShell 5.1 下启动、停止/端口释放、重启均实测成功。`D:\桌面文件\AI电话.lnk` 已创建，并通过该快捷方式实际启动当前 5050 服务。隔离浏览器 UI 已检查工作台、设置保存与状态展示；测试页面及测试服务现已关闭。

真实 Cloudflare 临时隧道已启动，`PUBLIC_BASE_URL` 已写入本机设置。公网 `/api/health` 返回 200，工作台与状态接口返回 403，无签名语音 POST 和 WSS 握手返回 403；本机鉴权的 401/403 拒绝符合预期。这些证明可达性与访问边界，不证明真实 Twilio 签名成功、媒体流或电话接通。

`check:solo` 当前模型、本机访问保护和公开地址就绪，仍缺少 7 项供应商配置；`configure:twilio` 默认检查按预期返回 blocked，没有改绑号码。OpenAI 安全写入本机的确认返回 `not_approved`，没有创建或写入新密钥；Twilio 内置浏览器登录页空白，Chrome 连接故障，未取得运行凭据。网页登录/历史账户核验不能代替本机 API 身份验证。

没有真实 OpenAI Realtime 会话、Twilio API 资源验证、号码切换、真实拨号或来电测试，也没有延迟、稳定性或费用验收。号码改绑脚本会备份旧语音设置，在最后切换时同时清空旧 Voice fallback 和号码 status callback，防止事件继续进入旧系统；短信配置不变，此远端变更尚未执行。

## 2026-09-22 当时执行顺序（历史，当前步骤见上方）

1. 保留本地与远端并发修改，检查当前实际分支，按共享规则提交推送到草稿开发分支并核对远端；不能称为已合入 `main`。
2. 在用户电脑启动 solo 服务，通过已授权的安全设置流程补齐运行凭据。OpenAI 本机写入尚未获得确认，不绕过 `not_approved`；若继续该步骤，应说明此前确认未获批准。不要把密钥发送到聊天或提交仓库。
3. 核对已运行的 Cloudflare 临时隧道及本机服务仍可用、`PUBLIC_BASE_URL` 仍匹配。保持机器、服务和隧道运行，域名变化后重做相关配置。
4. 先查看 `npm run configure:twilio` 的计划，再 `npm run configure:twilio -- --prepare`。后者准备 Key/App 并保存号码语音设置备份，尚不替换号码入站路由。
5. 点击「验证 API 连接」或运行 `npm run verify:providers`。各项真实通过后，执行 `npm run configure:twilio -- --apply`，让脚本再次验证并最后切换已授权号码、清空旧 Voice fallback/status callback，再读取远端核对。不要重复索取旧号码改绑授权。
6. 用户点击「开启通话」后注册浏览器电话；向用户指定的测试接听号码拨打，并另测来电。拨号/接听时允许麦克风，建议耳机。
7. 验证中文→英语、英语→中文、字幕、短长句、数字姓名、打断及任一侧挂断/清理。分别记录从说话结束到对端听到翻译的真实延迟，更新进度与共享提交。

## 保留的 Flex 版本

`npm run dev` / `npm start` 仍运行上游 Flex 流程，`npm run check:config` 仍要求 Flex 号码、Workflow 和 ngrok。不要将其检查失败误判为 solo 需要开通 Flex；不要同时占用 5050 端口。上游配置和真实验收步骤在 README 与 LOCAL_SETUP 的独立 Flex 章节。
