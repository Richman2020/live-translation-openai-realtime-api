# AI 电话 Plan B：阿里云独立路径，离线交付

核对日期：2026-10-14（北京时间）。本轮仅代码、已有依赖下离线测试和本地提交；没有供应商调用、上传样本、真实电话、安装、推送、部署或平台/凭据改动。Railway AI线上及已停止portal-test不操作。用户最新说明：此前OpenAI一美元试听已经执行，其授权已消耗；下方旧历史中的“未执行/未授权”不能复用到Plan B。

## 基线、保护与切回

实际Git链：生产 `d7a395e7ddc7d8a253500ab6d12310c9f8a9cf6a` → 上下文字幕 `8f96e42f4510cbe8ffe7323a5cb64f8a4b73f805` → OpenAI A 原型 `320f01c4fa037989bddc8a26e0574e7282730c8a` → 试听执行器 `e10648b9dd84b80901c383dd685b2073c490690f`。没有默认main/work为最新。Plan B从e106另建 `codex/ai-phone-plan-b-aliyun-offline-20261014`，目录 `/workspace/ai-phone-plan-b-aliyun-20261014`，未覆盖原分支/工作区。

原方案备份包含四个精确提交对象和完整树、各源码tar、生产未提交PROGRESS全文与patch、文件SHA256、无外部依赖的浅Git仓库及恢复说明。浅边界仅d7，没有改提交SHA，也没有Git配置、hooks、reflog、运行.env、凭据或node_modules绝对链接。独立目录恢复及git fsck通过。备份ZIP和独立安全审计随本轮交付；原五个工作树的1548 tracked工作副本全文哈希、HEAD和未提交状态前后核对。

切回代码先在新目录恢复备份，选择 `backup-production`、`backup-context-captions`、`backup-openai-plan-a` 或 `backup-openai-audition-runner`；不要reset/覆盖现有工作区。运行选择默认仍OpenAI；未来改回 `CLOUD_PHONE_TRANSLATION_PROVIDER=openai` 或去掉该选择，在下一次已授权服务启动生效。服务启动和每通媒体绑定持有冻结快照，当前通话不换供应商。配置/服务重启/发布仍需要当轮授权，本轮没有实施。

## 实际路径与供应商隔离

| 方向 | ASR | 文字翻译与字幕 | 音频 |
| --- | --- | --- | --- |
| 本方中文 | 独立Fun-ASR zh任务，原始PCM24k | Qwen-MT单次有界原文上下文，临时字幕修订，确定版本配对 | 同一确定英文译文送CosyVoice固定loongandy_v3，PCM24k顺序播放 |
| 对方英文 | 独立Fun-ASR en任务 | 同一Qwen-MT策略生成中文字幕 | 既有英文PCMU原音直接送耳麦，**不创建中文TTS** |

固定模型 `fun-asr-realtime`、`qwen-mt-flash`、`cosyvoice-v3-flash`，声线 `loongandy_v3`。阿里官方描述为美式英语男声，支持北京/新加坡；只有参数一致的离线证据，男性听感/持续稳定尚未试听。此音色不支持SSML/Instruct/timestamp，本实现没有发送。

来源：[CosyVoice音色](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)、[Fun-ASR](https://help.aliyun.com/en/model-studio/fun-asr-realtime)。普通Fun-ASR支持中英和任意采样率，本轮沿用电话桥接的24k PCM，分别发送zh/en首个language_hint；没有拿只支持中文的8k型号识别英文。

电话/SID/身份/签名/controller/单通/双腿清理仍由原SessionManager、server与ContinuousTranslationBridge负责，未放宽校验。原音不会等待识别、翻译或译音队列。Plan B不调用OpenAI、不隐式使用其caption factory、不在异常时切模型或供应商；失败清理当前通话。A原型、原OpenAI原生译音/字幕客户端、试听执行器及锁文件全文保留。

## 默认关闭、配置和只读检查

`CLOUD_PHONE_TRANSLATION_PROVIDER` 缺省为 `openai`，此时不读取阿里密钥，也不连接阿里。显式 `aliyun-plan-b` 才选择新路径；不开放浏览器任意改供应商字段，不开发设置页。

| 字段 | 北京 | 新加坡 |
| --- | --- | --- |
| ALIYUN_PLAN_B_REGION | beijing | singapore |
| 专用现有密钥变量 | ALIYUN_BEIJING_API_KEY | ALIYUN_SINGAPORE_API_KEY |
| WS | wss://dashscope.aliyuncs.com/api-ws/v1/inference | wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference |
| MT HTTP | https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions | https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions |

仅选中地域的密钥可用，缺失报字段名固定码，不借用其他地域或OpenAI密钥。若显式设置ASR/MT/TTS/voice/sample_rate覆盖字段，必须与本轮固定值一致，否则拒绝；不静默忽略错误模型。可选 `ALIYUN_PLAN_B_PROXY_URL` 或继承当前HTTPS_PROXY/HTTP_PROXY；HTTPS/WSS都沿用代理/TLS，不绕过网络策略，不改凭据。公共端点官方仍支持；本轮未实现业务空间域名覆盖，若账户要求WorkspaceId专属端点先报告，不能猜域名。

选中Plan B的cloud配置不读取/要求未使用的OpenAI key；只跳过该模型凭据的配置检查，Twilio/Google身份、Origin/CSRF、SID/nonce/controller等检查全部保留。默认OpenAI仍有原凭据要求。`cloud-index --check`只报固定模型/voice/地域、两ASR任务、TTS按确定小节创建、OpenAI任务0；不访问供应商，不承诺三层已实际可用。

## 上下文、版本、分段与播放行为

沿用每通有界原文CallContext：每方4来源、每来源2版本，快照最多6条/1600字符/120秒；明确source、role、原始时序和revision，生成译文不当原始识别。原始text与保守displayText区分，金额、日期、地址、否定不截断猜补；旧测试稿/参考英文不输入模型。

ASR使用官方 `input.context` 数组，只有可靠同方已确定原文，每条≤400字符、最多5条，过长整条省略；run-task及变化后continue-task更新，不发虚构messages外层。Qwen-MT仅**一个user消息**，以JSON边界分开RECENT_RAW_CONTEXT与CURRENT_SOURCE，明确只译当前、前文只消歧、保留自我更正/数字/否定/不确定，不回答问题或新增事实。未发送system/assistant、多轮历史、translation_options.context或不支持的json_schema。

官方支持user自定义提示；本实现是单次上下文提示策略，不是正式多轮协议。官方不保证模型绝不翻译上下文或补事实；真实样本若不能可靠遵循，最小替代是另行明确批准通用Qwen文本模型的单次严格翻译协议，不能运行出错时自动切换。本轮没有换该模型。

来源：[Qwen-MT指南](https://help.aliyun.com/zh/model-studio/machine-translation)、[MT API](https://help.aliyun.com/zh/model-studio/qwen-mt-api)、[Fun-ASR事件](https://help.aliyun.com/en/model-studio/fun-asr-client-events)。

字幕草稿按350ms合并节流，版本更新原条目；确定更新及时提交。自然小节内部配对，外层继续已有同方连续speaker block；对方有效原文后换块，不能把全场同方跨越对方发言合并。空确定原文撤回未播字幕和context事实，旧翻译不会复活。已知早来源未确定时，后来源不抢播；有界缺失终态失败属故障清理，不是整通时限。

译音只用已确认自然小节的同一英文快照，字幕和发声不双算两份不同译文。TTS请求独立递增、固定voice、新任务UUID；FIFO单队列，同方继续或对方插话不取消正确尚未播完的译文，对方原音仍直接通过。Twilio mark提供实际播放证据和6秒背压，完成由共享exact delivery count封口，回执全部到齐才played；单纯生成/发送不叫播放完成。重复/旧task/迟到音频不能串到新来源或新通话。

取消/挂断后同步阻断输入、请求和旧音频，取消MT，终止两ASR与TTS；北京发送官方取消directive，新加坡不支持该指令，仅本地作废并关闭，不假称已生成内容免费。清理和provider异常走原两腿安全结束；没有恢复个人金额、测试截止或固定总通话时长限制，也没有用户控制倒计时。

来源：[CosyVoice客户端](https://help.aliyun.com/zh/model-studio/cosyvoice-client-events)、[服务端](https://help.aliyun.com/en/model-studio/cosyvoice-server-events)。按官方每个sentence-synthesis marker绑定其后一binary message，同句可以有多个marker/audio对；ws库网络分片不是独立音频来源。

**明确延迟边界：**尚未确定的ASR只更新字幕，不按任意字数猜一个译音定稿。同一ASR source持续60秒且只给partial的模拟中，字幕完整更新，定稿前译音0次、定稿后1次；多确定小节可增量FIFO发声。Fun-ASR在真实连续发言中是否及时给sentence_end、首音和持续播放体验仍需试听，不能把接口/模拟当已达低延迟。

## 地域计价和本轮费用

2026-10-14官方中文价格页核对（人民币，按量、不依赖优惠）：

| 模型/计量 | 北京 | 新加坡 |
| --- | ---: | ---: |
| ASR输入音频每秒 | ¥0.00033 | ¥0.00066 |
| MT每百万输入tokens | ¥0.7 | ¥1.174 |
| MT每百万输出tokens | ¥1.95 | ¥3.596 |
| TTS每万输入字符 | ¥1 | ¥0.9541 |

来源：[模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)。不把人民币直接当美元，不给未经实测的每分钟整链路总价。

两方ASR秒数、每次MT输入/输出token（含指令/近期原文重复发送）和TTS字符分别计。draft及修订可能多次MT；350ms节流降低无意义逐字请求但不构成金额上限。MT max_tokens=2048是每请求输出参数，不是整通费控。ASR duration、TTS characters是任务累计，重复取max，不逐句相加；无完整usage标未知。未播/取消内容可能已计费。费用/usage诊断只有限数值、模型、地域和固定枚举，不默认录音或持久保存正文。

本轮模型费用为0（请求0），没有买套餐/付费资源。原Railway独立3美元提醒、接近4美元用户决定关停/Hobby范围不变；本轮不读取/操作平台。新试听需地域密钥、安全通路、向阿里发送样本同意和**新的独立金额批准**。

## 最终离线验证与独立审查

- 新增Plan B共100项：ASR22、MT17、TTS21、pipeline/bridge32、配置/选择/网络/启动8。全部fake供应商或纯本地HTTP，无模型/录音上传。
- 最终 `npm test` 1718总数／1713通过／5 Windows条件跳过／0失败；`npm run typecheck`、`npm run build`、新增源码/测试lint与格式检查通过。既有SDK准备仅复制已锁定本地文件，不安装、不运行安装生命周期脚本。
- 首轮整树6失败都是旧OpenAI执行器固定候选保护拒绝Plan B工作树；没有放宽原生产guard。只将该组测试夹具隔离到精确e106 Git checkout，本轮13/13重验，再完整回归得上述最终成绩。原CLI代码和OpenAI模型实现全文不变。
- 旧范围lint仍1 error：shared bridge第927行既有no-plusplus；cloud-service第149/191行2处既有no-console。逻辑为固定诊断枚举/有限数值，非本轮新增泄露；不为消提示扩大改动，不声称全仓库lint通过。
- 独立协议与流程审查发现并修复4项：TTS结束后取消仍吐缓冲音频、早来源迟final导致译音反序、播放未sealed及计数未回收、空final未撤回旧草稿/context。报告给触发、位置、影响及mock复验；最终无阻止离线交付的重要问题。无问题不等于真实模型/通话验收。

最终完整SHA、完整差异、各文件SHA256、测试命令/退出码、失败/跳过/未执行记录及独立报告在本轮交付RECEIPT与审计JSON绑定。原工作区保护前后记录和无密钥备份一并提供。

## 下一步尚未验证

实际账户/地域模型权限、代理握手和supplier ACK；原文识别、上下文数字/否定/日期忠实度；男声听感和长时稳定；连续发言ASR定稿及时性、首音/插话/积压；实际费用与账单；实际电话双向接通、字幕和挂断清理。最小试听配合清单见 [下一步](ALIYUN_PLAN_B_MINIMAL_AUDITION_NEXT.md)，不自动执行。
