# 电脑端 Codex 接手：本机 solo 电话翻译

日期：2026-09-23。共享仓库：<https://github.com/Richman2020/live-translation-openai-realtime-api>。

当前已实现独立本机通话工作台，既有 Windows 编译/离线测试、隔离浏览器 UI、桌面启停及公网访问边界证据保留。**2026-09-23 已补齐全部 7 项供应商设置，正式供应商 API 验证 4/4 通过，现有号码语音回调已改绑并回读核验，浏览器线路注册成功。** 真实外呼/来电、双向音频与延迟尚未验收，不能称为完整电话链路已经可用。隧道自动恢复、字幕断线补发、通话中按键菜单和完整指标记录仍未完成。最新完整复核见 [READINESS_REVIEW.md](READINESS_REVIEW.md)，运行步骤见 [LOCAL_SETUP.md](LOCAL_SETUP.md)。

## 2026-09-23 最新交接状态

- Codex 内置浏览器已实际操作 Twilio 页面、本机工作台和 OpenAI 密钥创建流程。此前 Chrome 曾 fetch 失败，本轮未重新测试 Chrome；不要把该历史故障说成全部网页不可操作，也不把内置浏览器成功说成 Chrome 已修复。
- Twilio 账户、已有号码、项目 API Key/Secret 与 TwiML App 均已保存；OpenAI 专用密钥已按用户明确批准通过网页创建并经本机设置 UI 保存。7 项供应商设置全部在受限且忽略提交的 `.env`；`check:solo` 的 10 项必需设置全部 `ready`。不重复创建密钥或资源，不将值、SID、号码或私密账户资料写入共享文档。
- 本机服务与隧道运行，公开健康探针通过；临时域名仅留本机。正式 `verify:providers` 在 `2026-09-23T06:05:55.183Z` 返回 4/4 通过：三个 Twilio 项为 `VERIFIED_RESOURCE`，OpenAI 为 `SESSION_UPDATED`，未发送音频或拨号。
- `configure:twilio -- --apply` 已返回 `status: configured`，现有号码 Voice 回调正式接入本机并完成远端回读核验；SMS 未改，原语音配置保存在私密 `.runtime/`。未购买新资源，`realCallTested: false` 表示改绑工具本身不拨号，不包含随后单独的 UI 拨号尝试。
- 已实际点击“开启通话”，页面显示“电话已开启”“已注册 · 可接收来电”，拨打按钮可用，浏览器线路注册通过。随后对用户指定号码发起真实 UI 拨号，75 秒后返回 `CALL_SETUP_TIMEOUT`，未取得响铃、接通或字幕证据；清理后 `activeSession: null`，无残留活动通话。
- 按测试目标和本项目浏览器身份查询近期 Twilio Calls 均为空，倾向浏览器音频或信令接入阶段，具体原因未定；待用户确认是否出现麦克风授权提示，不能认定根因是麦克风。测试号码及身份值不入共享文档。
- 原本机保存审批故障已解决，官方密钥连接器两次拒绝留作未明原因的历史记录；网页创建及本机保存已完成。OpenAI 直连超时已通过可选 `OPENAI_PROXY_URL` 解决，验证和实际翻译连接共用该配置，留空直连；代理私密保存后已清理线路并安全重启服务。
- 本轮最终 `npm run build`、59/59 项单元测试、TypeScript 及定向 lint 通过，离线 `npm ci --dry-run --ignore-scripts --offline` 安装计划检查通过。开发分支仍为 `codex/local-phone-workbench`，PR #2 尚未合入；新修改是否推送须按 Git 及远端核验。

## 当前接下来的执行顺序（2026-09-23）

1. 配置、四项供应商 API、号码改绑和浏览器线路注册已经完成；先核对服务、隧道及注册状态，确认麦克风授权提示并定位首轮 `CALL_SETUP_TIMEOUT`，不重复创建密钥或资源。
2. 核对隧道地址仍匹配；临时隧道重启可能换址，当前没有自动恢复或自动改绑。
3. 仅在隧道地址变化或相关配置改变时重新准备 App、验证 API，并运行 `configure:twilio -- --apply` 更新回调和回读核验；保留私密旧语音配置备份，短信路由不变，不重复询问旧号码改绑授权。
4. 使用用户指定测试号码，验收外呼、来电、中英两个方向、字幕、挂断/故障清理及真实延迟和用量。没有实际结果前不宣称电话可用。
5. 保留并发改动，把非秘密交接结果提交推送到 `codex/local-phone-workbench` 并核对远端；不得称为已合入 `main`。

## 当前本机代码与协作边界

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
