# 个人云通话：取消应用内五美元预算保护

2026-10-11 12:58:08 UTC 用户明确取消应用内五美元预算。这取代以前的五美元上限、费用证据和预算推导时长要求。此次仅做代码、离线验收和本地交付；不推送、不建PR、不部署、不拨号、不进行付费模型握手。Railway两服务3美元提醒/4美元资源范围、供应商账户级限额、套餐和号码均未改变。

## 当前实现

- `phone` 配置不读取或要求 `CLOUD_CALL_RESERVATION_USD_MICROS`、`CLOUD_CALL_COST_BOUND_JSON`、`CLOUD_RATE_CHECKED_AT`、`CLOUD_RATE_VALID_UNTIL`、`CLOUD_TRIAL_RATE_BOUND_CONFIRMED`、`CLOUD_JOURNAL_DIRECTORY`、`CLOUD_JOURNAL_VOLUME_CONFIRMED` 或旧 `CLOUD_TEST_DEADLINE`。缺失、陈旧或无效的这些旧值不会阻断个人电话启动；不要求用户清空线上旧变量。
- 云个人通话不装配预算journal、金额预留或累计音频/文字预算，不创建目录、锁或sentinel，不读取、更改、删除已有预算文件。旧预算模块及其兼容测试保留为历史代码，不在个人服务路径启用。
- SessionManager显式 `maxCallMs:null`，不使用预算推导截止，不退回300秒或原默认一小时应用计时器；不再向Twilio两腿写预算timeLimit。供应商自身限制仍适用，单次协议响应、缓冲、握手、建连超时和错误清理保持；本机Pocket保护不变。
- 新的个人Voice准入只持有当前通话的内存占用，签发前和使用时仍校验当前call；释放必须等待两腿清理确认。固定单身份登录、Origin/CSRF、controller、每通token/nonce、Twilio验签、owner隔离继续。原目标限制移到独立通话入口，仍只允许配置中已授权的目标。
- 同一时刻最多一通，已结束且确认清理后可再次开始，不保留旧“一生只能消费一次”的预算槽。原有防止内存无限增长的会话/历史注册容量保持，未扩大账号权限或允许匿名拨号。
- 实际供应商连接、send和媒体输出继续检查当前授权，移除用量预算不跳过鉴权。用户挂断、浏览器媒体断开、controller或登录失效、供应商错误都终止媒体并独立清理两腿。个人云服务的任一语音或字幕模型失败都终止通话，不保留只有部分模型工作的通话；本机既有字幕降级行为不改。挂断失败可重试；真实REST创建结果不确定或SID迟到时继续追踪清理，不能假称已结束。
- 页面 `VOICE_CONNECTION_NOT_READY` 提示不再要求预算材料。`--check`明确输出 `applicationBudgetEnabled:false`、`phoneJournalRequired:false`、`applicationCallDurationLimitSeconds:null`、`maxConcurrentCalls:1`；配置检查不访问供应商。

## 已知运行事实

以下由父线程通过既有Railway Console只读核验，未由本代码任务重复调用：

- 当前部署 `27330903-d42c-49e3-aae7-747988ab458a`，网页模式，`appSidMatches=true`、`targetPresent=true`、`webOnlyMode=true`。
- 配置的预算journal目录不存在；只读检查返回 `inspectionIncomplete=true`。这不是“已有旧通话占线”的证据，不初始化或删除任何journal。
- **13:00:27 UTC**：指定AppSID匹配；Voice URL为固定Railway `/voice/client`，POST、无query、origin正确。Twilio queued=0、ringing=0、in-progress=0，三项均 `hasMore=false`。当时没有活跃电话可清理，不删除App、号码或通话记录。
- **13:04:58 UTC**：现有Console使用现有运行凭据GET `/v1/models` 返回HTTP 403，未保留响应正文/头，错误来源、提供方错误代码和实际Realtime权限均无法据此确定。不是“所有模型不可用”的证明；未换凭据、未进行付费握手。实际连接失败沿原清理路径结束通话，页面明确提示模型连接/处理失败及确认线路关闭后手动重试，不伪造403为该次通话原因。

## 离线证据

新增个人路径回归使用生产准入、SessionManager、continuous bridge和实际协议client，只替换供应商网络传输。覆盖超过300秒与旧一小时应用计时器仍继续、音频超过旧300/600秒字节预算、文字超过旧60次预算、双腿不注入预算时长、并发/错误目标拒绝、确认挂断后下一通、主动挂断/断线/授权失效/五个模型会话各自错误后的双腿清理且无自动重连、首次native握手失败不拨远端、挂断失败重试、创建迟到和真实创建错误的未知结果处理。另验证配置完全不读取旧预算及能力预先确认字段、启动不创建目录、已有账本/锁/sentinel内容完全不变。

构建、类型检查、全套测试和浏览器结果见 [PROGRESS](../PROGRESS.md)。离线合成时钟不证明供应商允许同样长的真实会话，也不代表真实模型连接或实际通话通过。

## 最小剩余实际电话条件

1. 父线程协调发布这份本地候选，并在既有AI服务选择电话模式；当前线上仍为web-workbench，代码任务没有更改它。
2. 核验实际默认三路模型会话能力和WebSocket链路；当前未实际握手，不使用模型目录可见冒充通过。为了允许第一次受控测试，旧 `CLOUD_TRANSLATION_CAPABILITY_CONFIRMED` 不再读取或要求；准备检查只表示配置齐备，`--check`明确 `translationCapabilityVerified:false`。实际native握手未就绪不会拨远端号码，握手或模型运行失败会走清理流程；真实能力可以在首次测试中验证，不要求先填“模型已通过”的声明。`CLOUD_PUBLIC_CALLBACK_CONFIRMED` 仍独立保留，父线程据已核实回调设置。
3. 用户完成应用登录、浏览器麦克风/音频设备、Voice连接与本人接听的一通实际验收，核实双向音频、字幕和真实挂断。此次不自动发起测试；第一通用于验证这些未知项，不要求先有成功电话/听感报告才允许开始测试。

费用上界、费率核验、金额预留和预算journal已不再是前置条件。实际费用仍可能产生；本次没有改供应商账户设置。

进程内挂断与错误清理仍有效；该个人模式不把通话状态写入预算journal，因此不能宣称强杀/崩溃后有持久账本恢复。届时应依据供应商实际活跃状态核查，不能把一个不存在的目录当作有电话占线。服务正常关闭仍等待清理，失败保留回调监听和重试能力。

## 10月12日早晨最小发布与测试步骤

### 配置名称、允许值和实际语义

父线程13:13 UTC只读确认 `AI_PHONE_RUNTIME_MODE=cloud`、`CLOUD_SERVICE_MODE=web-workbench`、`CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED=false`、`CLOUD_WARM_INSTANCES=1`；旧 `CLOUD_TEST_DEADLINE=2026-10-11T00:40:00.000Z` 已过期。**新个人phone入口完全不读取该截止时间，可原样保留；不需要续期、删除或另设一个时间。** `web-verification` 独立模式仍使用其试验截止，不能选错模式。

| 类别 | 名称 | 允许值、校验与发布处理 |
| --- | --- | --- |
| 拨号服务开关 | `CLOUD_SERVICE_MODE` | 显式改为 `phone`；`web-workbench`/`web-verification`始终禁止电话。缺省也选择phone，但空值/未知值拒绝；发布时不要依赖缺省。模式只在进程启动选择。 |
| 云入口 | `AI_PHONE_RUNTIME_MODE` | 必须精确 `cloud`，现值保持。使用现有 `npm run start:cloud` 入口。 |
| 可选字幕 | `CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED` | 仅精确 `false`/`true`；缺省false。保持现值false：默认三个模型会话，中文→英文语音、英文原声返回和中文字幕仍工作；true仅额外增加中文侧配对字幕的两个模型会话，并非开启拨号所需。 |
| 单实例 | `CLOUD_WARM_INSTANCES` | `1`或未设置/空值按1解释，其他值拒绝；保持现值1及实际一副本，不能扩容。 |
| 监听端口 | `PORT` | 必需数字字符串，范围1–65535；保留平台当前端口。 |
| 公网地址 | `CLOUD_PUBLIC_ORIGIN`, `PUBLIC_BASE_URL` | 必需HTTPS公网origin，无认证信息、query、hash或额外路径，拒绝本机地址。后者必须精确等于前者归一化origin；保留 `https://ai-phone-test-staging.up.railway.app`，后者无结尾斜杠。媒体自动用同源WSS。 |
| 回调确认 | `CLOUD_PUBLIC_CALLBACK_CONFIRMED` | 必须精确 `true`；是已核实公网回调的运维声明，不是模型通过证明。父线程已核固定同源 `/voice/client` POST，据该证据设置/保持。 |
| 授权目标 | `CLOUD_TEST_TARGET_NUMBER` | 必需已有私有目标，格式 `+1[2-9]xx[2-9]xxxxxx`（精确正则见源码）。只允许该号码，不能用占位号码；不输出清值、不改现值。 |
| 现有Twilio标识 | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_TWIML_APP_SID` | 分别AC/SK/AP加32位十六进制；保留现有值。格式验证不会在线查询所有权；App匹配由父线程既有只读证据支持。 |
| 现有Twilio密钥 | `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SECRET` | 前者32位十六进制，后者长度至少20；非空、无首尾空白/换行/NUL、拒绝占位值。只使用现有秘密，不读取输出、不创建或更换。 |
| 现有主叫 | `TWILIO_CALLER_NUMBER` | 必需合法美国E.164号码，与目标相同的自拨仍拒绝；沿用原号码及来电设置。 |
| 现有模型凭据 | `OPENAI_API_KEY` | 必需非占位，`sk-`前缀且长度至少20；只做格式检查，不代表实时权限通过，不输出或更换。 |
| 既有Google登录 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_EMAIL` | 必需；ID/secret分别最长256/1024、合法唯一邮箱且最长254；无首尾空白/换行/NUL。保留既有身份与OAuth配置；回调由同源 `/auth/google/callback` 生成。 |
| 既有身份绑定 | `GOOGLE_HOSTED_DOMAIN`, `GOOGLE_SUBJECT` | Gmail身份可缺省；非gmail.com身份至少一个已有且独立核实的绑定，domain须合法、subject最长255。保持已有值，不增加授权或放宽校验。 |
| 可选固定模型/路由 | `OPENAI_REALTIME_MODEL`, `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_PROXY_URL` | 可不设；若非空分别只能为 `gpt-realtime-1.5`、`whisper-1`，proxy必须未设或空。实际continuous/caption客户端另用固定模型，不用此配置冒充能力通过。 |

**已从个人phone入口删除的前置字段**：`CLOUD_CALL_RESERVATION_USD_MICROS`、`CLOUD_CALL_COST_BOUND_JSON`、`CLOUD_RATE_CHECKED_AT`、`CLOUD_RATE_VALID_UNTIL`、`CLOUD_TRIAL_RATE_BOUND_CONFIRMED`、`CLOUD_JOURNAL_DIRECTORY`、`CLOUD_JOURNAL_VOLUME_CONFIRMED`、`CLOUD_TEST_DEADLINE`。另不再要求 `CLOUD_TRANSLATION_CAPABILITY_CONFIRMED` 预先声明首次测试成功。这些字段即使缺失、过期或旧值错误也不会被个人模式读取；不需要为此次发布清空线上变量。运行仍校验登录有效性、Origin/CSRF、controller、每通短期令牌/nonce、Twilio签名和授权目标，并保留挂断及异常清理。

最小配置差异是 **`CLOUD_SERVICE_MODE=phone`，以及在缺失/false时依据既有证据设置 `CLOUD_PUBLIC_CALLBACK_CONFIRMED=true`**。其余现有基础变量合法且齐备时保持；字幕false、warm1、过期旧deadline均不改。字段存在不代表隐藏值已校验，发布时应在原实例运行 `npm run check:cloud`，仅查看固定元数据/错误字段名，不打印环境变量。检查成功只表示可开始本人测试。

### 发布与本人操作

由父线程核对已有推送/发布权限后执行，当前代码任务未执行以下外部步骤：

1. 将本地候选提交同步到既有仓库的审查分支，核远端精确SHA并等候该SHA的CI；不要借用旧提交的绿色结果。
2. 仅既有AI服务更新到候选精确SHA并切换 `CLOUD_SERVICE_MODE=phone`。保留现有号码、App、私有目标、Google身份和凭据；根据已回读正确的回调确认 `CLOUD_PUBLIC_CALLBACK_CONFIRMED=true`，单实例及原资源不变。旧预算字段不用删除或重填，不开journal，不新增OAuth授权。若所需已有凭据缺失或失效，具体报告该事实，不自动生成或替换。
3. 一次部署后核SUCCESS、健康、实际源码版本及服务配置。`check:cloud`应为配置齐备、预算关闭、无应用时长上限，且明确实时能力未验证；该命令不握手、不拨号。直接打开 `/controlled` 并完成本人登录，不用浏览器按钮状态冒充电话已打通。
4. 通知用户入口可开始测试后，由用户自己发起一通本人接听的测试。真实模型权限、WebSocket链路、麦克风、音质、字幕及挂断都在这次验证；不以此前没有成功通话为由封锁首次测试。

用户操作：打开 [AI电话测试工作台](https://ai-phone-test-staging.up.railway.app/controlled)，用原Google账号登录；戴耳机，点击“开启通话”，输入已授权的本人603尾号1406号码并点“拨打电话”，允许麦克风。本人接听后先对电脑说一句中文，核实手机侧英文译音；再在电话侧说一句英文，核实电脑侧英文原声和中文字幕。手机用听筒、关闭其他外放以免回声。结束时点“挂断”，确认手机和网页都结束。模型错误时按页面提示等待线路清理完成再手动重试。此入口要等父线程完成上述电话版发布才可使用；当前网页模式仍关闭电话。
