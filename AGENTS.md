# 本项目的共享协作规则（用户明确要求）

2026-10-11 最新用户修订优先：取消“最多5分钟”作为产品/测试要求，继续仅单次测试、Twilio与OpenAI合计最多5美元，不授权无限通话或额外费用。硬时长须由已验证完整费率与预算推导，并与两腿供应商时限、媒体字节额度和失联清理一致；目前证据不足，旧300秒/14.4MB仅为尚未替换的代码保护，不是新的用户要求或5美元保证，电话保持关闭。用户已批准将旧桌面TwiML App出呼Voice回调切Railway，旧桌面出呼受影响、号码来电不改；父线程已完成并刷新回读外部App的Voice URL为固定Railway /voice/client POST，Fallback/Status为空，未拨号；部署隐藏SID是否一致仍待安全核验，不能按App名称推断。父线程已从原用户消息核验唯一本人目标，清值只用于授权测试的私有配置，不写Git/文档/日志；实际配置与费用门槛仍须核对。父线程报告新版应用登录及使用中保持登录已实际验证；真实麦克风/手机仍未验收。见[预算驱动时长边界](docs/CLOUD_CALL_USAGE_LIMITS.md#预算驱动时长最新用户修订)。

2026-10-11 最新范围：从 `356b23f` 继续实现整通应用用量闸门与超限提前清理，授权代码、离线验证和原分支交付，本轮不部署、不拨号、不访问付费模型。五会话共享限额已接入生产调用路径，但字节代理和固定非文字工程预留不构成供应商费用证明，不能据此填写 `CLOUD_TRIAL_RATE_BOUND_CONFIRMED` 或开启电话。运行仍固定 `4bab94e`、`calls-disabled`；父线程已实际看到新版 UI，Google 重登、号码编辑无拨号验收与电话准备分别记录。保持原持久 journal、一通/300秒/$5授权，不迁移 schema、清空账本或用重启续额度；详见 [整通限额](docs/CLOUD_CALL_USAGE_LIMITS.md)。

共享仓库：<https://github.com/Richman2020/live-translation-openai-realtime-api>

本项目以这个 GitHub 仓库作为 ChatGPT、电脑端 Codex 和后续会话共同读取的交接来源。聊天说明或某个环境里的本地修改，不能代替仓库中的代码与记录。

## 每次开始

1. 检查当前仓库、分支、工作区未提交修改及远端最新提交；获取远端更新，在不覆盖现有修改的前提下同步当前任务需要的分支。不要直接重置或覆盖电脑端 Codex 等其他参与者的工作。
2. 阅读远端最新适用版本的 `AGENTS.md`、[PROGRESS.md](PROGRESS.md) 和 [PROJECT_BRIEF.md](PROJECT_BRIEF.md)，再阅读相关代码；安装操作参考 [LOCAL_SETUP.md](LOCAL_SETUP.md)。若当前分支与远端不同，先查明差异再继续。
3. 以实际代码、测试结果和这些交接文件为依据。不能把其他会话的推测、未推送修改或用户报告的快捷方式，自动当成当前环境已验证的功能。

## 每次修改与结束

- 将与本项目有关的新需求、决定、代码和文档落入本仓库。需求变化更新 `PROJECT_BRIEF.md`，完成情况和下一步更新 `PROGRESS.md`；不要只留在聊天中。
- `PROGRESS.md` 应写明工作日期、修改内容、验证环境与结果、尚未验证的部分、阻塞和下一步。区分已编译、离线测试、API 连通、真实双向电话与延迟实测。
- 用户已要求将本项目更新提交并推送到本仓库。完成必要验证后提交代码和进度记录；推送前再次检查远端并保留并发改动。发生冲突时安全整合，不强制推送、不丢弃他人提交。
- 根据已有分支/保护规则推送到适当分支；若通过开发分支或 PR 交接，明确记录分支与链接，不能把它说成已合入 `main`。
- 成功后核对远端提交，并向用户报告仓库、分支、commit 和主要结果。若权限、网络或其他原因导致推送失败，说明真实状态和阻塞；本地提交或补丁不能称为“已经同步到 GitHub”。
- 密钥、密码、访问令牌、真实私密配置和个人账号资料不得提交。`.env` 留在运行环境；共享变量名、模板和配置完成状态即可，日志也不得泄露秘密。

这些规则适用于读取本仓库的 ChatGPT/Codex 会话。用户也希望其他项目采用同样的仓库协作方式；开展其他项目时，应把规则写入那个项目自己的仓库。这里的文件不会自动控制没有读取本仓库的其他会话，也不能使云端助手直接访问用户电脑。

## 本机 solo 模式的运行边界（2026-09-22）

### 2026-10-09 云端开发第一里程碑

2026-10-11 最新 UI 与续期授权：用户已批准将实际电话工作台的号码、设备检测和逐句对话布局适配到独立 `calls-disabled` 网页，不接电话 SDK、controller、付费模型或媒体连接；本轮仅 UI 更新的 AI 服务部署已获授权，电话与全部 WS 继续关闭。日常 `web-workbench` 已获真实前台操作触发的节流自动续期授权，闲置约15分钟、登录最长8小时，沿用内存会话、原 Google 单身份、Origin/CSRF、退出/过期与迟到结果保护；读取、合成事件和后台心跳不续期，原 `web-verification` 保持手动行为。下面“手动且不自动续权”“仅文档不部署”为此前阶段，不覆盖本段。本轮回归与浏览器终态见 [PROGRESS](PROGRESS.md)。

真实电话准备继续限一通、最多300秒、Twilio与OpenAI合计最多5美元；父线程完成 [准备核对](docs/CLOUD_PHONE_READY_CHECK.md) 并先通知用户 ready 后才进入实际测试，不能用网页登录或 UI 部署替代电话就绪。Railway两服务合计资源最多4美元、3美元提醒，保留现有Hobby、不升级扩容；两项预算分别核对，不把余额或费率估算当供应商账单硬上限。共享 TwiML App 的出呼 Voice URL 迁移范围尚待父线程明确，来电号码回调保持，未取得目标号码清值时不得猜测或拨号。

2026-10-11 02:42 UTC最新结果：主线程实际Google应用登录已成功，正常回工作台并由服务端确认会话；同次callback200、受保护状态由401转200，运行固定e94d2cf/部署516c94de…，精确源码CI全部通过。下方“实际登录仍待验收”为此前阶段。此次只补共享运行记录/草稿PR，不再部署无关修改；电话/全部WS保持关闭，原身份/安全边界、两服务资源4美元/3美元提醒、Hobby不升级继续，真实通话及实际手动续期/退出仍分别验收。不将网页登录成功扩展为电话授权。

2026-10-11 最新登录故障授权：用户实际 Google 回调出现 `LOGIN_FAILED`，继续实施仅服务端固定失败枚举诊断、回归并仅部署既有 AI 测试服务，由主线程协调实际浏览器重现后最小修复。不得记录 URL、code、token、cookie、身份、原始异常或完整认证参数；原响应和所有认证规则保持，未知回调参数兼容风险先加回归，不能据猜测放宽。新增凭据、权限或安全设置另报，电话/WS保持关闭，Portal不更新，两服务资源4美元/3美元提醒与Hobby不升级继续。实际Google完整登录成功才算修复，健康和模拟测试不代替。

02:32 UTC细分实际日志已证明 `CALLBACK_PARAMS_UNKNOWN_ISS`。主线程授权最小协议兼容修复、回归与仅AI部署：仅新增已核实Google标准授权响应 `iss`，有值须精确等于固定Googleissuer，重复/错误/其他未知仍拒绝，不跟随issuer联网，不删除state/nonce/PKCE/签名/audience/精确邮箱/hd或subject/会话校验。保留原缺iss响应兼容；实际登录成功前不得称为完成，新增凭据权限安全设置仍另报。

2026-10-11 01:58 UTC 最新运行授权：用户批准恢复两个网页工作台，费用范围已改为两测试服务合计资源最多4美元、3美元提醒，维持现有Hobby，不升级扩容；30美元/月授权已撤回，不能沿用。主线程协调费用基线与持续监控，不自行设置账户全局停机规则。AI现已按固定 `5b6047f` 部署 `web-workbench` 并回读SUCCESS/1副本Online，1CPU/500MB及原卷保持；电话、所有WS、凭据权限、账本和Twilio回调均不变。平台health通过；本云浏览器公网访问仍遇代理隧道拒绝，真实页面与应用Google登录由主线程/用户另验。源码保持commit pin，后续仅文档记录推送不会触发平台升级。下段“本轮不部署/两服务Offline”为此前代码交付及停止时状态，不覆盖本段最新恢复授权；详见 [PROGRESS](PROGRESS.md)。

2026-10-11 最新批准日常登录工作台：显式 `CLOUD_SERVICE_MODE=web-workbench` 没有试验服务截止时间，仍仅网页和严格 Google 单身份认证，电话、controller、Voice、模型、账本及所有 WebSocket 关闭。服务持续可用不延长会话：沿用 15 分钟空闲期限、8 小时绝对上限、手动 CSRF 续期、退出与迟到 OAuth 保护；内存身份在重启后失效，不增加自动续权或持久登录。原 `web-verification` 和缺省 `phone` 仍有原期限及全部门槛。本轮只在原开发分支实现、测试、推送和更新草稿 PR，不更新 Railway 源码/部署/秘密/容量/卷。上轮两个 staging 服务已由主线程停止，5 GB 卷保留；持续托管预算仍由主线程确认，旧一小时授权不能扩展为长期启动授权。见 [日常网页工作台](docs/CLOUD_WEB_WORKBENCH.md)。下方 2026-10-10 暂存与未 provision 描述为当时历史状态。

2026-10-10 今晚最新范围为网页、严格 Google 登录和健康验收，用户离线期间不拨号。显式 `CLOUD_SERVICE_MODE=web-verification` 使用独立入口与配置，仅开放登录壳、健康及鉴权读取；通话、controller、Twilio Voice、媒体 WebSocket、付费模型和电话账本路径关闭，不虚填能力/费率/卷确认或占位号码。缺省仍为完整 `phone` 模式，保留全部原启动与收费准入保护；模式变更须明确配置并重启，请求不能切换。代码任务继续授权在原开发分支提交推送及更新草稿 PR，部署与两个服务合计资源 0.50 美元/最多一小时的统一开始和停止由主线程协调。本轮不部署、合并或调用收费供应商。5 GB 卷及验收前持续存储费用已获用户授权，但当前仅暂存、未 provision；不能将浏览器已有 Google 会话或配置预期 Workspace 域说成本应用已通过真实 OIDC 登录。见 [网页验收模式](docs/CLOUD_WEB_VERIFICATION.md)。

2026-10-10 最新授权优先于下面历史 Pocket/云入口未实现的阶段描述：完成限时 Virginia 单实例云代码与离线交付，出程复用现有专用连续译音，回程英文原声与独立中文字幕；Pocket 固定版本/哈希代码仅保留本地对照，不部署 GPU 或下载模型。新增独立认证云入口不删除旧本机 loopback/启动保护。必须保留逐句配对、owner/controller/Voice、独立两腿清理及持久预算；配置不齐或存储/供应商责任未知时拒绝收费操作。现有 OpenAI/Twilio 配置只核对当前环境变量名称与存在状态，不打印/复制秘密、不从其他项目搬凭据。用户继续授权锁定开发依赖、原独立分支推送及草稿 PR；不合并、不改 Twilio 回调、不实际拨号/访问付费模型。真实登录/账户能力、独立配置、资源/费用和部署由主线程协调，主线程已获独立 Neon 免费测试项目及两个 Railway 测试服务合计 0.50 美元、最多一小时授权；本代码任务不重复创建资源或部署。运行与未验收边界见 [限时云候选](docs/CLOUD_CONTINUOUS_TRIAL.md)。

最新继续授权从 `3d4660b` 开始实现最小Google OIDC登录代码与离线假提供方验证，首版仅显式运行配置中的一个已验证工作身份，不开放注册。真实OAuth客户端创建、secret录入、实际账号授权及持续访问扩展另行确认；同步当前会话resolver不得执行异步身份交换。用户明确授权在现有云开发环境从已核验官方源重新下载必要Pocket材料，不接用户电脑、不新增费用、不安装/执行新增软件或绕过权限；可以制定官方固定版本的新可重建环境，但不得虚构旧本机freeze或宣称Linuxwarm已通过。沿用Railway Hobby，资源/区域/域名/持久化未定，不创建或部署；后续首轮仅本人美国号码，Twilio+OpenAI总额最多5美元、不得自动充值，当前不拨号或调用付费API。真实邮箱/号码不写Git、示例或日志。保持cloud guards，不改电话回调、不合并。

最新继续授权从已独立核验CI的 `bda4697` 开始，将现有controller与每通Voice协议接到实际工作台网页，通过显式DI隔离入口和fake SDK/provider验收。覆盖领取/续约/撤销、只读标签、刷新/导航/取消/断连及迟到结果；保持默认local、逐句字幕、Pocket Michael和英文原声回程。补最小持久预算/intent、两腿SID与清理事务恢复契约，尚不选择或实现存储与登录。完成提交、推送和精确CI核验后停在真实部署输入门槛，不自行增加后续fake里程碑；完整Python freeze和预置模型缺失仅报告材料阻塞，不访问用户电脑提取或下载。当前接线见 [实际工作台](docs/CLOUD_CONTROLLED_WORKBENCH.md)，停止点见 [事务与恢复门槛](docs/CLOUD_TRANSACTION_RECOVERY.md)。

最新继续授权从已核验 `48ac522` 开始，完成单人标签页controller lease及per-call一次性Voice加入许可的离线闭环。验证过的会话与标签页、服务端epoch、期限、显式续约/撤销绑定；活动或未确认清理时拒绝接管。生产签名器与持久预算/intent没有默认实现，仅预留明确注入端口，测试只用假令牌。cloud两个guard、回环及Twilio验签继续；不选登录提供方、不配置秘密/权限、不新增依赖或模型、不部署/改回调/拨号/合并。实现与剩余门槛见 [控制租约与Voice许可](docs/CLOUD_CONTROLLER_VOICE.md)。

最新已授权里程碑从 `709806b` 继续，将独立授权组件通过显式服务端依赖注入接入真实电话应用路由，并用模拟身份/provider/bridge离线验收。注入不得绕过两个cloud启动保护；默认local流程保持可用，注入应用仍限制回环连接。未决定登录、控制lease、持久预算/journal、语音令牌等路径继续拒绝，不增加真实访问权限，不配置秘密、部署或调用付费服务。记录见 [应用集成](docs/CLOUD_PHONE_APPLICATION_INTEGRATION.md)。

当前进一步授权为登录提供方解耦的独立会话/通话授权组件与HTTP/浏览器WS离线隔离验收。模拟身份仅在tests，不允许生产默认模拟器或请求启用；不选登录提供方、不创建真实凭据、不开放公网，不改变local/Twilio边界或解除cloud拒绝启动。实现与未接线门槛见 [云访问边界](docs/CLOUD_ACCESS_BOUNDARY.md)。

后续已授权小里程碑为测试源码类型清理、保持运行行为的完整回归，以及云认证/会话隔离/部署准备方案文档。推荐方案优先复用现有锁定依赖与Node内置能力，不创建凭据、不引入新外部provider或收费服务，不扩大实际访问权限；需新增依赖、模型下载或外部配置时先报告具体请求。方案见 [云认证与部署准备](docs/CLOUD_AUTH_DEPLOYMENT_PLAN.md)，尚不能解除cloud启动保护。

本轮已批准在云端环境开发、安装原锁定开发依赖、提交推送独立分支并创建草稿 PR；不合并、不生产部署、不改 Twilio 回调、不访问付费 API、不连接用户电脑。功能基线为 `codex/local-phone-workbench` / PR #2，不能从仅含旧 Flex 的 main 重做。最新需求和离线证据见 [逐句对话记录](docs/CONVERSATION_MILESTONE.md)。

云模式需独立浏览器认证、owner 会话隔离及断线清理，不能删除本机 loopback 检查开放控制 API。目前 solo 两个入口均在 cloud 模式拒绝启动；配置解析/设计不代表云电话可部署。Pocket 保留固定 Michael、锁定版本和资产哈希，参数化路径不授权即时下载模型或更换引擎。后续实现和验收门槛见 [云模式设计](docs/CLOUD_MODE_DESIGN.md)。

当前新增实现是 `src/solo/` 与 `public/` 的单人桌面通话模式，运行命令为 `npm run start:solo`；保留原版 Flex 实现，两个模式的配置与启动要求分别判断。

- solo 模式允许在供应商配置未齐时启动本机服务及设置界面，以便安全填写配置。`npm run check:solo` 只检查本机格式；缺失或无效配置必须拦截通话，不能填入占位值冒充就绪。
- 仅本机界面/API 可以操作通话，须带本机访问凭据。公开隧道用于签名校验的语音回调与媒体流；公开 `/api/health` 只返回应用标识，不提供配置、密钥或通话能力。
- 按 [LOCAL_SETUP.md](LOCAL_SETUP.md) 先启动本机服务、填写私密设置、建立公网隧道，再运行 `configure:twilio -- --prepare`、验证 API；验证成功后才运行 `--apply` 改绑号码。用户已授权复用旧号码并替换旧语音回调，无需重复索取该项授权。不得把这一授权扩展成删除旧系统资源。
- 2026-10-02 用户已授权统一真实桌面入口并持续自动恢复。桌面启动器会启动独立恢复程序，由它在服务器空闲维护保护下执行等价的资源检查、私密备份、供应商验证、已有语音回调改绑和远端回读；不要同时手工改绑或启动第二个恢复进程。主动 Stop 暂停恢复，下一次桌面启动解除暂停。实际工作台浏览器仍须保持已注册，后台健康不能代替接听就绪。
- 停止服务使用 `scripts/Stop-AIPhone.ps1`：先请求服务清理电话线路，收到 `ok: true` 和 `safeToStop: true` 后才回收本启动器的进程。清理未确认时保留服务并重试挂断，不能盲目强杀后宣称线路已结束。
- API 验证、离线测试、界面验证和真实双向电话是不同证据。未取得实际结果前，不宣称供应商已接入或通话/延迟验收通过。

以下保留上游 Flex 项目的结构与运行要求；其中 Studio、Flex、TaskRouter 及“配置完成后才启动”的规则仅适用于原版 Flex 模式，不适用于先启动 solo 设置页的流程。

---

# Live Voice Translation with Twilio & OpenAI Realtime

A middleware service that uses Twilio Voice, Studio, Flex, and TaskRouter together with the OpenAI Realtime API to provide bidirectional live voice translation between a caller and a contact center agent.

## Commands

```bash
# Install dependencies (requires Node v20.10.0+)
npm install

# Copy environment variables
cp .env.sample .env

# Run in development mode
npm run dev

# Expose webhooks locally (required — Media Streams must reach this server)
# Requires ngrok — install and authenticate at https://ngrok.com before running
ngrok http 5050
# Copy the Forwarding URL (e.g. https://abc123.ngrok.app) into NGROK_DOMAIN in .env
```

## Environment Variables

Copy `.env.sample` to `.env`. Never commit `.env`.

```bash
cp .env.sample .env
```

| Variable | Where to find | Format |
| -------- | ------------- | ------ |
| `TWILIO_ACCOUNT_SID` | [Console](https://console.twilio.com) homepage | Starts with `AC` |
| `TWILIO_AUTH_TOKEN` | Console homepage → click to reveal | 32-char string. Treat as a password. |
| `TWILIO_CALLER_NUMBER` | Console → Phone Numbers → Manage — the number **not** connected to Flex | E.164 format: `+15551234567` |
| `TWILIO_FLEX_NUMBER` | Console → Phone Numbers → Manage — the number auto-provisioned with your Flex account | E.164 format: `+15551234567` |
| `TWILIO_FLEX_WORKFLOW_SID` | Console → TaskRouter → Workspaces → Flex Task Assignment → Workflows | Starts with `WW` |
| `OPENAI_API_KEY` | [OpenAI API Keys](https://platform.openai.com/api-keys) | Starts with `sk-` |
| `NGROK_DOMAIN` | The Forwarding URL from `ngrok http 5050` — hostname only, no `https://` | `abc123.ngrok.app` |
| `API_PORT` | Optional. Port the local server listens on. | Default: `5050` |
| `FORWARD_AUDIO_BEFORE_TRANSLATION` | Optional. Set `true` in production to reduce perceived silence; leave `false` for local testing. | `false` |

## Project Structure

- `src/routes/incoming-call.ts` — handles inbound caller webhook from Studio; starts Media Stream to OpenAI
- `src/routes/flex-reservation-accepted.ts` — handles TaskRouter event when agent accepts; bridges both streams
- `src/routes/outbound-call.ts` — webhook for the Flex/agent-facing phone number
- `src/services/AudioInterceptor.ts` — intercepts Media Stream audio from both parties and routes through OpenAI
- `src/prompts.ts` — OpenAI Realtime prompts for caller and agent translation; edit here to change languages or behavior
- `inbound_language_studio_flow.json` — Studio Flow definition to import into Twilio Console

## Agent Boundaries (upstream Flex mode only)

**Always:**
- Confirm `.env` is fully populated and ngrok is running before starting the server
- Walk the user through all three Twilio setup steps in order: (1) import Studio Flow, (2) point `TWILIO_CALLER_NUMBER` to the Studio Flow, (3) point `TWILIO_FLEX_NUMBER` and TaskRouter workspace to the middleware
- Remind the user that `NGROK_DOMAIN` must be updated every time a new ngrok session is started, and all three webhook URLs in Twilio Console must be updated to match
- Confirm the Flex Agent Desktop is open and agent status is set to **Available** before the user places a test call

**Never:**
- Run the app before the Twilio Console configuration is complete — the call flow will silently fail
- Use `TWILIO_FLEX_NUMBER` as the number to call when testing — calls must go to `TWILIO_CALLER_NUMBER`
- Hardcode credentials or phone numbers in source files

## Verify It's Working

1. Start the server with `npm run dev`, confirm it logs that it's listening on port 5050, then open the Flex Agent Desktop and set your status to **Available**
2. From a mobile phone, call the number in `TWILIO_CALLER_NUMBER` — select a language when prompted, and on the Flex Agent Desktop accept the incoming task; once connected, speak on either end and you should hear the translated audio delivered to the other party

## Twilio Resources

- [Twilio Console](https://console.twilio.com) — credentials, phone numbers, webhook configuration
- [Twilio Media Streams docs](https://www.twilio.com/docs/voice/media-streams)
- [Twilio Flex overview](https://www.twilio.com/docs/flex)
- [TaskRouter docs](https://www.twilio.com/docs/taskrouter)
