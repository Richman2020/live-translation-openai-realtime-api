# 本项目的共享协作规则（用户明确要求）

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
