# 本机 AI 电话：安装、配置与验收

仓库：<https://github.com/Richman2020/live-translation-openai-realtime-api>。先读 [AGENTS.md](AGENTS.md)、[PROJECT_BRIEF.md](PROJECT_BRIEF.md) 和 [PROGRESS.md](PROGRESS.md)，保留已有本地修改与私密配置。

当前桌面入口使用 **solo 单人模式**：浏览器电话、Twilio Voice/Media Streams、OpenAI Realtime；默认我说普通话、对方说英语。无需开通 Flex、Studio 或 TaskRouter。原版 Flex 仍保留，运行步骤在本文最后独立说明。

**2026-09-23 当前状态：7 项供应商设置齐全，10 项必需设置全部 `ready`，正式 `verify:providers` 4/4、号码改绑回读、浏览器注册及麦克风预检均通过。** 两次实际拨号到达 Twilio 浏览器线路，目标手机通话均未创建；第二次明确返回 `21216` / HTTP 400。当前需排查 Twilio 外呼限制，手机接通、来电、字幕及双向翻译音频仍待验收。密钥与可选代理仅在本机私密保存；当前草稿分支尚未合入 `main`，同步状态以 Git 核验为准。

2026-09-24 复测：用户说明账户为美国账户；原有号码的归属、语音能力、运行配置和两个语音回调均核对正确。再次真实拨号仍返回 21216/HTTP 400，目标手机通话未创建，失败线路已清理。无需重复购买或更换主叫号码，具体供应商拦截规则仍需核实。

2026-09-22 已验证桌面启动/停止/重启、真实 Cloudflare 隧道及访问边界；当日 `npm run build`、54 项离线测试、solo ESLint、独立 scripts TypeScript 检查及锁文件 `npm ci --dry-run` 均通过。Windows 私密配置实际 fixture 验证了先为临时空文件设置私有 ACL、再写入测试秘密。上述代码与界面证据不代表真实电话接通；完整记录见 [PROGRESS.md](PROGRESS.md)。

2026-09-23 本轮错误诊断及界面修复通过最终 80/80 项测试、构建、前端语法、TypeScript、定向 lint 与差异检查；此前麦克风超时/取消修复和代理检查证据保留。Codex 内置浏览器已实际完成麦克风授权、预检及到达 Twilio 浏览器线路的拨号；Chrome 控制此前约 21 秒后 fetch 失败，单独诊断。

## 1. 安装并打开本机工作台

项目要求 Node.js 20.10.0 及以上；本轮本机验证使用 Node.js 24.15.0、npm 11.12.1。在仓库目录执行：

```powershell
npm ci
npm run setup:local
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-DesktopShortcut.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-AIPhone.ps1
```

`setup:local` 仅在 `.env` 不存在时从模板创建，不覆盖已有文件。安装脚本创建桌面 **AI电话.lnk**，显示为「AI电话」；旧的「AI电话（预览）」保持原样。以后双击新入口即可打开。

本轮已在 `D:\桌面文件\AI电话.lnk` 创建新入口，并通过它实际启动当前 5050 服务；Windows PowerShell 5.1 的启动、停止/端口释放与重启均已验证。隔离 UI 测试页面及测试服务已关闭，当前桌面入口对应实际仓库服务。

启动器在后台运行 `npm run start:solo`，默认监听 `127.0.0.1:5050`；供应商配置缺失时也可打开设置页，但通话被拦截。它生成本机访问令牌，并用启动链接交给页面；页面将其保存到当前标签页会话后立即清除地址栏片段。不要共享启动链接或令牌。启动器会核对已运行服务的身份，不占用其他程序的端口。

`-NoOpen` 可仅启动后台服务。`npm run start:solo` 可用于开发终端启动，但桌面启动器负责安全打开带本机凭据的界面。关闭浏览器窗口不会停止后台服务。

停止桌面启动器创建的服务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Stop-AIPhone.ps1
```

停止脚本先确认服务和进程归属，再请求清理电话线路；只有服务返回 `ok: true`、`safeToStop: true` 才回收本启动器的后台进程。若提示线路关闭待确认，应在工作台点击「重试挂断」，保持服务运行直到清理得到确认。运行日志与进程记录位于忽略提交的 `.runtime/`。

## 2. 在设置页填写私密配置

先保存已有的 Twilio Account SID、Auth Token、当前账户拥有的美国语音号码和 OpenAI API Key。设置仅写入本机 `.env`，密钥输入不预填、不回显；留空表示保留已有值。不要把密钥发送到聊天、源代码、日志或 GitHub。

| 配置 | 用途 |
| --- | --- |
| `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN` | 账户读取、资源准备与 Twilio 回调签名验证 |
| `TWILIO_CALLER_NUMBER` | 已有的 `+1` 语音号码；不自动购买号码 |
| `TWILIO_API_KEY_SID`、`TWILIO_API_KEY_SECRET` | 服务端签发短期浏览器语音令牌；可由后续 `--prepare` 准备 |
| `TWILIO_TWIML_APP_SID` | 浏览器主动拨号使用的 TwiML App；可由后续 `--prepare` 准备 |
| `OPENAI_API_KEY` | 当前账户可用的 OpenAI API 密钥 |
| `OPENAI_REALTIME_MODEL` | 默认 `gpt-realtime-1.5`；账户权限仍须验证 |
| `OPENAI_PROXY_URL` | 可选的 HTTP(S) 代理根地址；用于 OpenAI Realtime 验证与实际翻译连接，留空则直连 |
| `PUBLIC_BASE_URL` | 完整公网 HTTPS 根地址，例如 `https://example.trycloudflare.com`；由隧道脚本保存 |
| `LOCAL_ACCESS_TOKEN` | 启动器生成的本机访问保护，不需要在设置页手动填写 |

保留 `API_HOST=127.0.0.1`，端口默认 `5050`。模板中的 `TWILIO_FLEX_NUMBER`、`TWILIO_FLEX_WORKFLOW_SID`、`NGROK_DOMAIN` 不参与 solo 模式检查。不要填假值绕过检查。

```powershell
npm run check:solo
```

该命令只输出字段名及 `ready/missing/invalid`，不联网、不打印值。所有字段格式通过也不证明账户或真实电话可用。

### OpenAI 密钥配置与连接排障（2026-09-23）

**已解决：本机保存确认立即拒绝。** 此前确认工具报告耗时 0 ms，返回 `not_approved` / `decline`；`approval_policy = "never"` 会拒绝带必填 `targetPath` 的 MCP 表单，不能据此认定用户点击拒绝。[Codex 官方源码](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/elicitation.rs)明确了该分支。用户在当前任务输入框下方权限菜单选择 **Ask for approval** 后，本轮确认工具真实返回 `approved`，目标为仓库内 `.env`，无需继续重复处理旧审批故障。[官方权限说明](https://learn.chatgpt.com/docs/sandboxing)提供该入口；此次没有修改插件、批准逻辑或伪造确认结果。

**密钥已创建并保存。** 官方连接器曾两次返回 `OpenAI Platform rejected the API key request.`，没有错误码，原因未证实。随后用户明确批准网页表单创建操作，已通过 OpenAI 网页创建专用密钥，并由本机设置 UI 保存到受限 `.env`；服务内存配置同步更新，无需为该次保存重启。此问题已不再阻塞配置，不要再次创建密钥或打开 picker，也不要把历史连接器错误归因于余额、权限或网络。

**Realtime 连接代理。** 密钥保存后，原直连检查返回 `SESSION_TIMEOUT`；裸 `ws` 连接没有自动使用 Windows 系统代理。显式使用已有本机 HTTP 代理后，真实诊断在 2470 ms 收到 `session.updated`，未发送音频或发起电话。共享代码现通过可选 `OPENAI_PROXY_URL` 将同一代理配置用于供应商验证和实际翻译 bridge；留空保留直连，也可通过本机设置 API 显式保存空字符串来清除已有代理、恢复直连。值必须是 HTTP(S) 代理根地址，不带路径、查询参数或片段；代理地址及认证信息仅保存在本机私密配置，不写入共享文档或日志。

密钥与代理保存后应重新运行 `check:solo` 和 `verify:providers`；代理字段仅在填写时参加格式检查。本轮代理私密保存后，停止脚本确认线路清理并安全重启服务；正式 `verify:providers` 在 `2026-09-23T06:05:55.183Z` 返回 4/4 通过，随后号码改绑及独立的浏览器线路注册验证也已完成。上述检查不发送音频、不拨号，不能代替真实通话验收。

## 3. 建立公开语音隧道

Twilio 必须访问本机的 HTTPS 回调与 WSS 媒体流，电脑需开机、联网且服务保持运行。Cloudflare 临时隧道脚本需要事先将官方 Windows `cloudflared.exe` 放在仓库的 `.runtime\tools\cloudflared.exe`。脚本不会自动下载程序。

先确认本机服务已启动，再执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Tunnel.ps1
```

脚本以隐藏窗口启动临时隧道，将获得的 `https://…trycloudflare.com` 保存到本机设置的 `PUBLIC_BASE_URL`；进程信息与日志位于 `.runtime/`。此操作本身不改 Twilio 号码回调。

公开端只开放语音路由及只返回应用标识的 `/api/health` 探针；设置、拨号 API 和工作台保持本机访问限制。探针通过只说明地址指向本应用，不代表 Twilio 签名、媒体流或通话成功。

本轮真实隧道已启动并保存 `PUBLIC_BASE_URL`，未将临时域名写入共享文档。实测公网 `/api/health` 为 200、UI/状态接口为 403、无签名语音 POST 与 WSS 握手均为 403；本机未授权/非允许来源请求按预期返回 401/403。之后实际浏览器线路已触发目标外呼，但被 Twilio 21216 拒绝；完整双侧媒体与翻译音频仍待验收。

临时地址在隧道重建后可能变化，每次变化都须重新运行后面的准备、验证与改绑步骤。该隧道是开发入口，尚无生产可用性承诺。`Stop-AIPhone.ps1` 负责电话服务；退出使用时，先安全停止电话服务，再单独停止隧道：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Stop-Tunnel.ps1
```

隧道停止脚本核对记录、程序路径、PID 和启动时间，只停止本项目的 cloudflared。若服务仍有通话、线路清理待确认或无法确认状态，保留隧道运行。停止隧道不会清空已保存的公开地址；下次启动后应核对新地址并重新准备、验证与改绑。

## 4. 准备 Twilio 资源，再验证 API

用户已授权复用现有号码、替换旧系统的语音回调，无需重复询问这一决定。切换必须留到有效配置、目标服务和 API 检查通过之后；这一授权不包含删除旧资源或开通 Flex。

先查看实际配置计划，再准备：

```powershell
npm run configure:twilio
npm run configure:twilio -- --prepare
```

无参数命令检查本机状态、公开探针及号码归属，输出计划，不改远端资源。`--prepare` 在 `.runtime/` 保存原号码语音配置备份；缺少 API Key 或 TwiML App 时创建相应资源并通过本机设置 API 私密保存，已有 TwiML App 时更新它的语音地址为 `/voice/client`（POST）。**准备阶段会创建/更新这些资源，但不切换号码的入站路由**，也不购买号码、不拨电话、不修改短信路由。

如需复用已有 API Key，SID 和 Secret 必须成对有效；不要把其他业务共用的 TwiML App 当作隔离资源。备份用于核对和手动恢复，当前未提供自动回滚命令。

完成后，在设置页点击「验证 API 连接」，或在终端执行：

```powershell
npm run verify:providers
```

验证会真实访问 Twilio/OpenAI，逐项确认账户启用、号码语音能力与归属、TwiML App 地址，以及 OpenAI Realtime 收到 `session.updated`。OpenAI 检查不发送语音或生成翻译；这些通过也不代表真实电话验收。设置页不会自动运行验证，修改设置后应重新验证。

## 5. 最后改绑已授权复用的号码

所有配置和 API 验证通过、没有正在进行的电话时执行：

```powershell
npm run configure:twilio -- --apply
```

`--apply` 会再次准备所需资源并验证供应商；只有全部通过，才清除号码原 `voiceApplicationSid`，将号码 Voice URL 改为当前 `PUBLIC_BASE_URL/voice/incoming`（POST），并清空旧 Voice fallback URL 和号码 status callback，避免语音失败回退或通话状态继续流向旧系统。私密备份包含这些旧地址及请求方法；短信路由保持不变。最后读取远端核对 Voice URL、旧应用/fallback/status callback 已清空。TwiML App 使用 `PUBLIC_BASE_URL/voice/client`（POST）。

失败时检查输出与私密备份，不把 `prepared` 或健康检查当作已成功改绑。2026-09-23 本轮 `--apply` 已返回 `status: configured` 并完成远端回读核验，现有号码 Voice 回调正式接入本机，SMS 路由保持不变，未购买新资源。其 `realCallTested: false` 只说明改绑工具本身不拨号，不包含后来单独的真实拨号尝试。临时隧道地址变化后，须重新准备、验证并改绑；当前没有自动恢复与自动改绑机制。

## 6. 验收真实通话

2026-09-23 已通过 Computer Use 点击本机工作台“开启通话”，页面显示“电话已开启”“已注册 · 可接收来电”，拨打按钮可用；这证明浏览器线路注册成功。随后按用户指定号码发起真实 UI 拨号，75 秒后返回 `CALL_SETUP_TIMEOUT`，未取得响铃、接通或字幕证据；超时清理后 `activeSession: null`，无残留活动通话。

本轮重新核对 TwiML App 回调地址与方法匹配，公网健康探针返回 200 且应用标识正确，无签名 `/voice/client` 返回 403。早先麦克风权限为 `prompt`，独立 `getUserMedia` 15 秒仍等待、Twilio 无通话记录；该阶段已结束。用户授权后，独立诊断取得 1 条有效音轨并立即释放；不录制或上传音频。

在 **Codex 内置浏览器当前标签页的地址栏外层**查找麦克风或网站权限提示，并允许此本机页面使用麦克风；它可能不在网页内容区域内。内置浏览器支持麦克风，后台标签页请求也可能保持等待。网站麦克风权限与任务的 Full access/Ask for approval 是不同控制，切换任务批准模式不能代替网站授权。若看不到提示，先切到当前标签页查看其地址栏权限入口；不要先重建供应商配置。

前端先预检麦克风，再建立后端会话；30 秒超时和“取消准备”均已真机验证，准备失败时不创建电话。预检所得流只交给 SDK 使用一次，取消后的延迟结果及旧 Device 连接会被隔离。**若授权后旧请求仍等待，即便权限已为 `granted`，先确认没有活动电话，再刷新工作台并重新开启通话注册。** 本轮按此操作后真实预检通过，不能因此跳过后续电话与音频验收。

当前两次实际拨号均到达 Twilio 浏览器线路，分别持续 2 秒和 1 秒，目标手机通话均未创建。第二次取得 `providerErrorCode: 21216` / HTTP 400，清理最终确认、`activeSession: null`；服务经正式安全停止后已重启。工作台会显示安全数字错误码及对应指引，不回传原始供应商错误详情。

遇到 **Twilio 21216** 时，按 [官方错误说明](https://www.twilio.com/docs/api/errors/21216)核对风险、监管及适用的 +1 Primary Profile 限制。本轮已只读确认账户 Full/active、余额为正、美国普通号码地理权限开启、已有获批 Individual Primary、缺 Business Primary，账户创建日期在 2025-10-08 及之后；用户已于 2026-09-24 说明为美国账户，不能仅凭缺 Business Profile 认定根因或自行填写企业资料。处理供应商拒绝后再拨用户授权目标，不重复创建密钥。

若缺少本机访问令牌，设置页会显示全局错误及重新从桌面入口打开的指引，已真机核验。测试号码、浏览器身份和临时诊断页面不写入共享文档。

在工作台点击「开启通话」注册浏览器设备，然后向用户指定的测试号码拨号，或用另一部手机拨入 Twilio 号码并在桌面接听。号码采用 `+1` 加十位号码格式，具体可呼叫范围仍受 Twilio 账户权限影响。原旧系统号码不能自动当作测试接听对象。

拨号或接听时浏览器需要麦克风权限，建议佩戴耳机。电脑端默认普通话，对方默认英语；两侧音频进入独立翻译会话。字幕只展示实际收到的原文/译文事件。浏览器本机历史记录需主动开启，默认不保存，不录制音频；导出的字幕也属于用户私密内容。

分别验证主动外呼和来电、双向语音与字幕、静音/拒接/任一侧挂断、忙线/未接/断线、连续通话和线路清理重试。记录短句、长句、数字与姓名、打断场景，从说话结束到另一侧实际听到翻译的延迟。模型首音频耗时不是端到端延迟；没有实测时不承诺亚秒或逐词同传。

代码检查：

```powershell
npm run build
npm test
```

离线测试使用替代连接与测试配置，不连接真实供应商、不拨电话。每次更新进度应分开记录编译、离线测试、界面验证、API 实连和真实通话。

## 保留的上游 Flex 模式

以下仅供继续使用原版 Flex 的开发者，不能和上述 solo 配置混用。原版仍通过 `npm run dev` / `npm start` 启动，使用 `npm run check:config` 检查，要求 OpenAI/Twilio 凭据、两个 Twilio 号码、Flex Workflow SID 和 `NGROK_DOMAIN`。

1. 按 [README 的 Twilio setup](README.md#twilio-setup) 导入并发布 `inbound_language_studio_flow.json`，将 `TWILIO_CALLER_NUMBER` 指向该 Studio Flow。
2. 运行 `ngrok http 5050`，把主机名（不含 `https://`）填入 `NGROK_DOMAIN`；把 Flow 内网址、Flex 号码 `/outbound-call`（POST）、TaskRouter `/reservation-accepted` 与 Reservation Accepted 事件同步配置。
3. 完成配置且 ngrok 正在运行后，执行 `npm run check:config`、`npm run build`、`npm test`，再 `npm run dev`。同一端口上不要同时启动两个模式。
4. 打开 Flex Agent Desktop，坐席设为 **Available**；从手机拨入 `TWILIO_CALLER_NUMBER`，选择语言并在 Flex 接听。不要拨 `TWILIO_FLEX_NUMBER` 作为此入站测试。

原版 `src/routes/outbound-call.ts` 是 Flex 号码回调；solo 桌面主动拨号的实现位于 `src/solo/`，两者不是同一个入口。上游说明完整保留在 README 中。
