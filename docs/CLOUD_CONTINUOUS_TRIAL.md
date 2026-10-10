# 限时 Virginia 云候选

2026-10-10；沿用 `codex/cloud-phone-conversation-20261009` / [草稿 PR #3](https://github.com/Richman2020/live-translation-openai-realtime-api/pull/3)，干净基线 `3182eeaba9e0df058eaa75aca8fa0fb699b41c48`，功能 base 仍为 PR #2 的 `df3c447`。这次交付源码、离线证据与部署设置，没有实际部署、供应商调用、回调修改或合并。

## 音频与字幕

云入口仅允许既有 `continuous-captions` 候选：Chrome 中文送到已有 `gpt-realtime-translate` 专用会话，英文音频立即送手机，不等字幕；手机英文 PCMU 原声先传回浏览器，独立识别与中文字幕旁路随后处理，不合成中文。Pocket/Michael、既有版本与资产哈希保留本地对照，云入口不预热 Pocket、不安装 Python/Torch 或下载模型；上海腾讯不在音频路径。

| OpenAI 会话 | 默认 | 输入及职责 | 音频关键路径 |
| --- | --- | --- | --- |
| `gpt-realtime-translate` | 必需 1 条 | 中文 PCM → 连续英文 PCM | 是；唯一出程译音 |
| `gpt-4o-transcribe` | 必需 1 条 | 对方英文 PCM → 原文字幕 | 否；原声先转发 |
| `gpt-realtime-1.5` | 必需 1 条 | 对方英文文字 → 中文字幕 | 否；无输出语音 |
| `gpt-live-transcribe` | 可选 1 条 | 同一中文 PCM 再识别，供逐句原文 | 否；额外音频输入计费 |
| `gpt-realtime-1.5` | 可选 1 条 | 中文原文 → 独立英文文字，建立配对 ID | 否；额外文字计费，无第二份译音 |

默认三条，仍展示 `session.output_transcript.delta` 的原生英文译音生成文字；它对应模型的英文音频输出，缺少中文原文也不能隐藏。该流独立显示，未保证逐句双语配对，也不证明已完整播放。`CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED=true` 才开启最后两条，共五条；服务端配置决定，网页/HTTP 不能开启。可选配对行明确标识“参考翻译”，与原生英文流分别保留，不将两份输出合成同一份内容。实际音频输入会重复送给可选出程 ASR；旁路不是免费能力，成本核验须覆盖所选模式全部会话、文字输出及线路清理责任；会话数也不等于计费项数。

[官方连续翻译指南](https://developers.openai.com/api/docs/guides/realtime-translation)及[事件参考](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)提供 input/output transcript delta 和可选 elapsed_ms。输入文字须额外 opt-in，不能假设免费，本轮不自动请求源转写模型；若服务端实际提供 native input，其中文原文独立显示、时间关联仅近似。event_id 标识事件，缺少句子/utterance ID、对应源句和确定句界，时间戳可以缺失或重复。原生 delta 按到达顺序原样追加，不插入空格；会话内 event_id 去重、重连/前通迟到事件隔离，不能拿时间戳去重或按第 N 句强行配对。视觉分组不是语义/确定句界。后续可测试原生输入文字替代旁路 ASR以降低重复输入；本轮没有验证相应账户能力或改为新模型。现有稳定语义分段客户端仅在显式开启时复用。

配对原译文沿用稳定 ID、各自临时/确定修订、迟到就地更新、源时间交替、乱序/插话、长句语义小节及阅读历史暂停自动滚动。native 音频 mark 与字幕 utterance 没有可靠关联，字幕行不能根据 native mark 变成“已播放”；打断/清空后同样不能称全文已被对方听到。自然输入结束调用 session.close 后有界等待 session.closed，可排空尾句；主动挂断立即 abort，丢弃晚到音频与文字。旁路失败/两秒准备积压只关闭该字幕支路；原声和 native 音频继续。主媒体失效则清空两方向 Twilio 队列并关闭连接。native 输入/输出 PCM 字节和音频毫秒仅是 `transport_observed`、`billed:false` 观测，不是账单；官方原生事件未给出可依赖的 billing usage，不能把虚构 response.done 用量作为成本凭证。

原生流按最多 1000 字符作视觉分组；首次出现新的对方字幕 utterance 后，下个原生 delta 使用新显示 ID 和时间，保证本地 A → 对方 B → 本地 C 的交替。对方同句的晚到译文及修订原位更新，不反复切断当前原生流；这些分组始终是 diagnostic、final:false，不制造确定句界。

## 云边界与持久预算

浏览器腿收到供应商 `update({timeLimit})` 成功回复后才返回 Stream、允许媒体或准备 native 会话。单腿只进行 native 握手，在手机腿加入前丢弃麦克风帧；native ready 自然触发远端创建，避免“两腿齐才准备、准备好才拨手机”的等待循环。远端在持久 intent 后使用 `create({timeLimit: remainingSeconds})`；先到的已验签回调可作为供应商创建接受信号，没有额外远端 update ACK 请求。

新 `start:cloud` 单进程公开 ingress 监听 `0.0.0.0:$PORT`，受控 Fastify 只听 `127.0.0.1` 的内部随机端口。固定 HTTPS origin/WSS，严格 Host、单值代理头及狭窄公开路径；丢弃代理头后原 loopback、Google cookie/Origin/CSRF、controller epoch、call owner 与 Twilio 签名继续执行。仅 `/voice/media` 可升级 WS；旧 settings/token/presence/verify/shutdown/maintenance/incoming 管理入口不进入公网。原 `start:solo`/`buildSoloServer()` 的 cloud 拒绝保护保留，不能用环境布尔值开放旧 API。

唯一 Google 身份须核验 RS256/issuer/audience/PKCE/state/nonce/verified email；非 Gmail 另需已核实 Workspace hd 或固定 sub。callback 精确为 `${CLOUD_PUBLIC_ORIGIN}/auth/google/callback`。生产 Twilio signer 用原锁定 SDK、本地签名、per-call identity、incomingAllow=false、短 TTL；供应商签名回调仍消费单次 join，JWT 不能独自约束一通电话。

文件 journal 在已批准的私有持久卷内，0700/0600、同步原子提交/fsync、独占单实例锁和初始化标记。Voice 签发前预留已核价保守金额和本地腿 intent；远端创建前另提交 intent。只允许固定一个美国目标，一次试验最多一通、300 秒；总预留上限 5 美元，release 不退款。语音及字幕每个 socket 创建/发送前复核当前许可，真实媒体上传/输出前执行字节额度；不能因为字幕准备成功而跳过预算。供应商失败/迟到 SID/不确定结果保留责任并冻结新准入。

这是保守操作预算，不是供应商账单硬封顶。未核验所选模式所有费率、用量/延迟责任上界时拒绝启动。重启旧 call 一律 cleanup-only，不恢复登录/lease/Voice；残锁不自动接管，账本缺失且初始化标记存在时不重建 5 美元。整个卷丢失无法由文件账本自证，必须先确认真实持久卷和恢复流程。本代码没有创建或接线 Neon。08:55 UTC 主线程获批准备独立 Neon 免费测试项目与两个 Railway 测试服务，基础设施合计操作预算 0.50 美元、最多一小时，计时尚未开始。Neon 仍需独立持久适配；不能把创建数据库当成已接线，不允许临时目录或数据库失败时静默 fallback。

测试绝对截止时间必须在未来一小时内；到期先拒绝新准入、停媒体、独立清理。未知 SID、写盘故障、网络分区、平台 SIGKILL 和崩溃残锁须主线程按供应商/卷实际状态恢复，不能以浏览器关闭或进程退出声称电话已结束。应用截止不是 Railway 基础设施费用硬封顶；平台限时资源停止仍由主线程协调。

## 配置与启动

主线程已分配 `https://ai-phone-test-staging.up.railway.app`，尚未部署或核验健康。未来 `CLOUD_PUBLIC_ORIGIN` 与 `PUBLIC_BASE_URL` 均精确使用此 origin；Google redirect URI 为 `https://ai-phone-test-staging.up.railway.app/auth/google/callback`。TwiML App Voice Request URL 为 `https://ai-phone-test-staging.up.railway.app/voice/client`、POST；媒体为 `wss://ai-phone-test-staging.up.railway.app/voice/media`，健康路径为 `/api/health`。每通 `/voice/connect`、`/voice/status`、`/voice/stream-status` 的 `sessionId/role/nonce` 查询由服务器生成，不能配置为缺参数的全局回调；所有语音回调仍须供应商签名、账户与当前通话归属检查。云候选不开放 `/voice/incoming`，不要运行旧本机自动改绑脚本。

安全填写分工如下，完整名单及默认拒绝值见下面模板；本任务没有设置任何实际变量：

| 谁提供/设置 | 变量 |
| --- | --- |
| 用户安全填写秘密 | `OPENAI_API_KEY`、`TWILIO_AUTH_TOKEN`、`TWILIO_API_KEY_SECRET`、`GOOGLE_CLIENT_SECRET` |
| 用户确认并安全填写私有账号/身份 | `TWILIO_ACCOUNT_SID`、`TWILIO_API_KEY_SID`、`TWILIO_TWIML_APP_SID`、`TWILIO_CALLER_NUMBER`、`CLOUD_TEST_TARGET_NUMBER`、`GOOGLE_CLIENT_ID`、`GOOGLE_ALLOWED_EMAIL`；非 Gmail 另需已核实 `GOOGLE_HOSTED_DOMAIN` 或 `GOOGLE_SUBJECT` |
| 主线程可设置的非秘密运行值 | `AI_PHONE_RUNTIME_MODE=cloud`、`PORT=8080`、`CLOUD_WARM_INSTANCES=1`、上述相同 origin、`CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED=false`、`CLOUD_JOURNAL_DIRECTORY=/data/phone-journal` |
| 完成真实核验后才设置 | `CLOUD_TRANSLATION_CAPABILITY_CONFIRMED`、`CLOUD_PUBLIC_CALLBACK_CONFIRMED`、`CLOUD_JOURNAL_VOLUME_CONFIRMED`、`CLOUD_TRIAL_RATE_BOUND_CONFIRMED`；再生成 `CLOUD_TEST_DEADLINE`、`CLOUD_RATE_CHECKED_AT`、`CLOUD_RATE_VALID_UNTIL`、核价后的 `CLOUD_CALL_RESERVATION_USD_MICROS` |

完整变量名在 [cloud-trial.env.sample](cloud-trial.env.sample)。样例故意缺值/确认标记为 false，不包含真实身份、号码或凭据，不能冒充就绪。当前开发环境与仓库 `.env` 文件中没有 OpenAI/Twilio/Google 配置；旧 Railway 服务已 REMOVED 的元数据不提供当前可运行环境，也没有复制其变量。

运行环境独立注入配置后执行：

```bash
npm run check:cloud
npm run start:cloud
```

`check:cloud` 仅检查配置/运维确认，不打开供应商、文件 journal 或模型；不自动验证 key 权限。需要明确 `CLOUD_PUBLIC_CALLBACK_CONFIRMED`、`CLOUD_TRANSLATION_CAPABILITY_CONFIRMED`、`CLOUD_TRIAL_RATE_BOUND_CONFIRMED`、`CLOUD_JOURNAL_VOLUME_CONFIRMED`，这些是主线程真实核验后的运维声明，不是测试通过证据。`PUBLIC_BASE_URL` 必须精确等于固定 `CLOUD_PUBLIC_ORIGIN`；不要求/生成 LOCAL_ACCESS_TOKEN；不读写用户电脑。

云容器产物为 [Dockerfile.cloud](../Dockerfile.cloud)（Node24.19.0、现有 package-lock、官方 npm 源、无 lifecycle scripts/新依赖）和独立 Docker ignore 白名单，不包含 `.env`、用户资料、模型或 journal。编译启动命令：

```bash
node --import=extensionless/register dist/solo/cloud-index.js
```

[部署设置](../deploy/cloud-service-settings.json)是供主线程审阅的设置清单，不自动创建资源。目标 Virginia `us-east4-eqdc4a`、一个 warm replica、关闭 serverless/自动重启、无重叠部署、持久卷及有限 drain。当前官方[区域文档](https://docs.railway.com/deployments/regions)确认该 region；[配置文档](https://docs.railway.com/infrastructure-as-code)说明新服务应使用 IaC而非旧 railway.json，本轮没有新增 IaC SDK/运行 apply。健康检查仅返回 appId；[官方探针 Host](https://docs.railway.com/deployments/healthchecks) `healthcheck.railway.app` 只允许精确健康路径，不获得控制权。实际 Railway TLS/代理头、region、容器 build、卷与健康探针仍须部署时回读验证。

## 验收与停止点

`prestart:cloud` 和 Docker build 显式执行 `prepare:desktop`，从锁定的本地依赖准备真实 Twilio 浏览器 SDK。真实云入口静态请求已与原件逐字节比较，303,272 bytes、SHA-256 `35d3cb1b22e309f9884724a89250aecd2de4f1556ad7b67a7bc5e06c73dcb74a`，没有使用页面验收的 fake SDK 替代这项检查。

```bash
npm run typecheck
npm run build
npm test
npm run test:cloud:startup
npm run test:conversation:browser
npm run test:controlled:browser
npm run test:controlled:continuous:browser
CONTROLLED_BROWSER_OUTGOING_PAIRED_CAPTIONS=false npm run test:controlled:continuous:browser
npm run test:google:browser
```

测试使用离线身份/签名/WS/Voice/provider，浏览器供应商请求为零；具体最终计数和远端精确 CI 见 PROGRESS 与草稿 PR。限时启动验收使用真实云 builder/ingress/文件 journal 加显式离线依赖；配置检查成功、HTTP 进程存活、旁路字幕通过均不等于供应商接通或真实电话成功。

今晚真实测试仍需独立凭据与 Google callback/身份、当前所选模型账户能力、已核价保守成本上界、已批准资源/持久存储和固定回调核验。没有运行真实麦克风/普通手机、实际登录或付费模型；数字否定/修订、长讲话尾部积压、自然度与耳听延迟分别验收。本轮完成代码/回归/开发分支交付后停止，不扩成新的下载、数据库、部署或付费实验。
