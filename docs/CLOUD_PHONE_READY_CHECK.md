# 最新覆盖：用户已取消应用内预算（2026-10-11 12:58 UTC）

当前以 [个人云通话](CLOUD_PERSONAL_NO_BUDGET.md) 为准。应用内五美元、费率/费用上界、预留及预算journal均不再作为电话前置。父线程已通过既有Console核对AppSID与固定Railway Voice POST回调正确；13:00:27 UTC Twilio queued/ringing/in-progress均0且无更多分页。journal目录不存在不是占线，不初始化或删除。剩余为候选发布/电话模式、真实模型与媒体连接、本人通话验收；本代码任务不推送、不部署或拨号。以下保留原阶段清单，预算相关项已撤销。

# 云电话准备核对

2026-10-11 最新进展：整通应用用量闸门与超限提前清理已接入生产路径，本轮只交付代码与离线验证，不部署。运行仍固定 `4bab94e` 的 `web-workbench` UI，电话、controller、Voice、付费模型与全部 WS 仍关闭。父线程报告新版应用登录与使用中自动保持已实际验证；号码编辑无拨号和真实电话仍分别记录。本表未标为 ready，不设置确认标记、修改回调或发起电话。

## 授权与只读证据

- 最新真实测试仅一通，Twilio与OpenAI合计最多5美元，不自动充值；用户已取消五分钟要求，有限防失联时长须从完整预算上界推导，当前未证明，旧300秒代码保护暂不放大；父线程完成准备并先通知用户 ready，用户可接听后才进入测试。Railway两服务合计资源最多4美元、3美元提醒，保留现有Hobby、不升级；资源和通话预算分别管理。
- 父线程本轮外部 Twilio 只读报告余额 **12.95293 USD / Pay-as-you-go**。这是账户余额证据，不证明每个模型、Voice资源或成本上界已验证，不是5美元账单硬限。
- 现有 Twilio 号码仅以尾号5995识别：Voice POST仍为旧 tunnel 的 incoming 回调，Status为空，没有 App 绑定。它是已核对的现有号码，**不能推定为本次被叫**；最新唯一本人目标已由父线程从原用户消息核验，不再重复索取；清值只用于本次已授权测试的私有配置，不写入仓库或日志，本代码任务尚未写云变量。
- **外部App回调已完成**：父线程已将 `AI Phone local desktop`（仅留SID前缀 `APa6bb…`）的Voice URL改为 `https://ai-phone-test-staging.up.railway.app/voice/client`、POST并刷新读回；Fallback/Status仍为空，未拨号。用户已批准旧桌面出呼受影响，号码来电配置未改，父线程继续浏览器复核。外部App更新不能证明部署隐藏的 `TWILIO_TWIML_APP_SID` 与该App一致；仍须安全核验实际SID，不能按相同名字或变量存在推断。

## 尚缺的电话配置与证据

2026-10-11恢复任务重新读取Railway变量名：`CLOUD_TEST_TARGET_NUMBER`已存在，修正此前“目标字段不存在”的旧结果；当前仍有以下七个确认/金额/费率字段缺少。连接返回 valuesRedacted=true、只给名称，不能由本工具证明目标值或配置App SID与外部核对资源一致。完整恢复证据见 [恢复验收交接](CLOUD_RECOVERY_ACCEPTANCE_2026-10-11.md)。

| 字段 | 完成条件 |
| --- | --- |
| `CLOUD_TRANSLATION_CAPABILITY_CONFIRMED` | 核验所选模式全部固定模型、端点与账户能力，不能由离线测试代填 |
| `CLOUD_PUBLIC_CALLBACK_CONFIRMED` | 外部App出呼迁移与刷新回读已完成；仍须核对部署实际SID、固定HTTPS/WSS可达性及原签名/归属保护 |
| `CLOUD_TRIAL_RATE_BOUND_CONFIRMED` | 有覆盖所有会话、两腿与迟到责任的保守成本证据；估计不等于硬上限 |
| `CLOUD_JOURNAL_VOLUME_CONFIRMED` | 核验原私有持久卷、journal锁/恢复/清理与责任保留，不新建空预算冒充恢复 |
| `CLOUD_TEST_TARGET_NUMBER`（已存在） | 父线程已核验原用户提供的唯一本人目标；本轮只独立确认变量名存在，不读出清值，不取现有Twilio号码代替 |
| `CLOUD_CALL_RESERVATION_USD_MICROS` | 配置须为整数microUSD，严格大于2000000且不超过5000000；仍须有已核价完整责任证据 |
| `CLOUD_RATE_CHECKED_AT` | 真实费率证据的规范UTC核对时间 |
| `CLOUD_RATE_VALID_UNTIL` | 覆盖电话试验截止、满足原时效校验的规范UTC时间 |

原 `CLOUD_TEST_DEADLINE` 已过期是交接记录，本连接无法独立读其值；另须在已批准的统一试验窗口内核验和更新，不计入上述七个缺字段，不能靠反复重启延长授权。费用目前有估计，尚不足以宣称供应商硬封顶，不能先设确认标记再测试证明。实际能力、完整成本及目标未核实前，保持电话模式启动拒绝。 当前已增加两文字分支共享的整通60请求、450000输入代理单位、72000预留输出tokens及每次1200输出上限，各PCM输入流14.4MB；实际send前计入补零、drain、重复上下文，失败/取消不退款。总应用预留不超过配置金额，包含固定2美元非文字工程预留。字节代理与工程预留不证明自动ASR/VAD、特殊tokens、税费、目的地和供应商终止拖延费用；`CLOUD_TRIAL_RATE_BOUND_CONFIRMED` 仍不能由离线cap代填。见 [整通限额与官方费率缺口](CLOUD_CALL_USAGE_LIMITS.md)。

## 模型、字幕与验收

既有连续候选默认 **三条** OpenAI 会话：专用连续译音、回程英文转写和中文字幕；显式 `CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED=true` 增加两条出程原文/译文旁路，共 **五条**。可选旁路重复发送中文音频，另计音频与文字输入输出，不能隐瞒或只核 native 一条。固定模型为 `gpt-realtime-translate`、`gpt-live-transcribe`、`gpt-4o-transcribe` 和两路 `gpt-realtime-1.5`（三会话模式不启用出程原文和参考翻译）。媒体使用 `wss://ai-phone-test-staging.up.railway.app/voice/media`；`/voice/connect`、`/voice/status`、`/voice/stream-status` 的 POST URL 由服务器逐通生成并带 `sessionId/role/nonce`，不能把全局 Status 设置为裸路径。职责见 [连续候选](CLOUD_CONTINUOUS_TRIAL.md)。

出程 native 英文生成文字和旁路配对的“参考翻译”分别显示；参考翻译不是实际译音逐字稿，不代表已播放。缺少可靠 native utterance/source/final 时不得强行配对或伪造完整播放回执。回程对方英文原声先回听、旁路显示中文字幕，不新增中文配音。

UI、离线模拟和真实Google登录不代替真实麦克风/手机验收。实际短测分别记录数字/否定、持续讲话尾部积压、内容完整性、自然度与耳听延迟；停止后须确认两腿和未知创建责任清理，不能以浏览器关闭宣称电话已结束。当前尚无该云端真实通话证据。
