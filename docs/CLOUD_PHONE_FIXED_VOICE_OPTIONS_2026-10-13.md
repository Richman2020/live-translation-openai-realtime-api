# 云电话固定英文声线：现状审计与可选方案

核对日期：2026-10-13。源码基线：`d7a395e7ddc7d8a253500ab6d12310c9f8a9cf6a`。本文件是方案交付，不是声音修复或试听验收。本子任务测试执行 0、电话 0、付费模型调用 0；未修改 native client、其测试、模型、endpoint 或音频架构，未新增生产诊断或录音。

用户最新目标是中文讲话的英文译音保持同一男性听感，使用内置声音即可，不克隆声音。男性听感需要用户试听确认；voice 名称或同一个 voice ID 不能单独证明性别听感及长时间声线稳定性。当前保留 local 中文→英文 native 译音、remote 英文原声→浏览器及独立中文字幕。

## 结论与证据边界

当前 dedicated `gpt-realtime-translate` 接口无法通过已公布的配置固定内置声线，也无法接收应用自定义翻译 prompt 或 conversation 上下文。官方 cookbook 的 [Key differences](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide#key-differences) 明确说明没有 voice selection/custom prompting，采用动态声音适配；这支持“现架构不能直接锁定既定声线”的结论。

用户报告连续中文讲话 1–2 分钟时英文译音男女听感变化，但本轮没有源音频、生成音频及完整会话轨迹。动态适配是合理候选机制，不能认定为这次变化的唯一根因；也不能确认是否涉及输入中的其他声音、声学条件或其他运行因素。源码未发现按 1–2 分钟计时切 voice、自动重建、失败自动 fallback 或两个出程声音混播的路径，这不替代真人运行证据。

仅给字幕 ASR/文字翻译增加上下文，不能改变当前 native 英文译音的 voice 或向它注入相同上下文。临时字幕后续修订也不能撤回对方已经听到的音频。

如果同一男性听感是硬性要求，需要先决定未来音频路线。常规 Realtime 语音→语音和 ASR→文字翻译→流式 TTS 都有正式选 voice 的能力，但两者都改变当前 dedicated continuous 音频流程。本轮只比较方案，不切换或实现。

## 当前实际音频路径（只读）

以下行号是上述精确基线的源码位置，后续字幕改动可能移动共享文件的行号。

| 检查项 | 源码证据 | 已确认范围 |
| --- | --- | --- |
| 生产引擎 | `src/solo/cloud-service.ts:414`、`:426` | personal phone 仅允许 `continuous-captions`，不是 Pocket/Nano 音色路线。 |
| TTS 路由边界 | `src/solo/session-manager.ts:125`、`:138` | 仅对应 Nano/Pocket 引擎才注入 `localVoice`；当前 cloud continuous 不装配它。 |
| local native 创建 | `src/solo/continuous-translation-bridge.ts:499`、`:563`、`:581` | local attach 预备唯一 local provider；后续两腿连接不会重复创建已有 provider。native local target language 是 `en`。 |
| 固定连接与配置 | `src/solo/continuous-translation-client.ts:293`、`:491` | 单个 client 只创建一个 `/v1/realtime/translations?model=gpt-realtime-translate` WebSocket；一次配置为 output language 及可选 input noise reduction，没有 voice/prompt。 |
| 持续输入 | `src/solo/continuous-translation-bridge.ts:1152`；`src/solo/continuous-translation-client.ts:520` | 同一 provider、同一输入重采样器持续 append PCM；静音不作为重建或新声音条件。 |
| native 输出 | `src/solo/continuous-translation-client.ts:416`；`src/solo/continuous-translation-bridge.ts:1183` | 校验 PCM24k/mono 格式后即时转发，用同一输出重采样器保留尾部及相位；不等字幕/整场讲话结束。 |
| remote 回程 | `src/solo/continuous-translation-bridge.ts:1119` | 英文原声先转发，随后独立送 caption；不是另一个中文 TTS 声音。 |
| 失败与重建 | `src/solo/continuous-translation-client.ts:197`、`:505`；`src/solo/openai-websocket.ts:20` | 失败关闭原连接并走清理，没有自动 reconnect、声音 fallback 或连接工厂重试。新 client 属于新实例；本轮未运行或添加重建测试。 |

客户端对 provider delta 保持到达顺序，提供 event ID 时在本 socket 内去重；显式错误的采样率、声道或格式会拒绝播放，而不是以错误速率播放。上述设计有助于排除若干应用层混播候选，不证明供应商输出音色本身稳定。

既有只读测试材料包括 `tests/continuous-translation-client.test.ts:200`（dedicated 协议）、`:516`（先播音频、静音输入）、`:600`（格式冲突拒绝）、`:670`（固定失败诊断）、`:777`（abort 后迟到不恢复）和 `:1027`（去重及新 client 隔离）。这里只检查了测试代码，本子任务没有重新执行，不能据此填写本轮测试通过。

现有 native 元数据回调仅在有效 expiry 数字存在时报告 `session_created/session_updated`；bridge 给出 role/pipeline 与观察时间，再由 manager 发应用事件（client `:316`、bridge `:592`、manager `:1430`）。它没有声明可选的固定 voice、逐次 session generation 或实际声学检测。不能用当前元数据判断“男性声音保持”或证明这次没有动态适配；本轮不增加生产日志、录音或管线事件。

另核 [translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)：native input/output transcript 的 `elapsed_ms` 都是可选的 translation-frame 流对齐元数据，按 200 ms 递增，多个 delta 可同值。它不是唯一文本 ID；官方也没有保证它是源话语的起止时间或 turn ID，不能用它直接证明 native 译文属于哪个应用 source-turn。不能反向断言它必然是独立的输出播放时钟。保留粗对齐信息与确证语义配对是不同能力；缺失、重复与边界歧义须保持未配对，不按到达时刻或猜测延迟补接。

## 官方接口能够确定的内容

| 路线 | 官方支持及限制 | 本项目仍需实测的内容 |
| --- | --- | --- |
| 现用 dedicated translation | [Cookbook](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide#key-differences) 和 [client events schema](https://developers.openai.com/api/reference/resources/realtime/translation-client-events) 说明以目标语言配置；声音随源说话人一般特征适配；无固定 voice、自定义 prompt 或常规 conversation/response 生命周期。 | 本次听感变化的因果、完整长讲话的声音稳定性、端到端延迟及翻译质量。 |
| 常规 Realtime 语音→语音 | [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options) 支持内置 voice、instructions 和 conversation items；首次输出音频后，同 session 不可再改 voice。它有 response 与 turn 生命周期。 | 指定内置声音是否符合用户男性听感；纯翻译指令遵循；持续不停讲话时什么时候产生首段译音；更正、打断和长通话质量。 |
| ASR→文字翻译→流式 TTS | [Live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) 提供实时识别事件及依模型而定的上下文配置；[Voice agents](https://developers.openai.com/api/docs/guides/voice-agents#build-a-chained-voice-workflow) 支持分阶段架构；[TTS](https://developers.openai.com/api/docs/guides/text-to-speech#voice-options) 有内置 voice 与语音流式返回。 | ASR、翻译和 TTS 的组合错误率；分段首音、跨请求韵律、长讲话队列和更正行为；指定 voice 的实际男性听感。 |

不把 `marin` 或 `cedar` 按名称定义为男声或女声。官方质量建议也不是用户对男性听感的验收。两条候选路线均只考虑内置 voice，不包含自定义 voice 创建、声音克隆或上传同意录音。

## 两条候选方案比较

下面是基于协议的工程分析，不是本项目已完成的实现或性能结果。

| 维度 | A：常规 Realtime 语音→语音 | B：实时 ASR→文字翻译→流式 TTS |
| --- | --- | --- |
| 固定声线 | 在首次输出前固定一个受支持的内置 voice；本通配置及未来合法的新 session 都固定同一个选择。无需按源声音适配，但不保证完全无韵律变化。 | 每个 TTS 请求固定相同内置 voice 和一致风格配置；文本与声音选择分离，但独立请求之间韵律/音色听感仍需测试。 |
| 上下文 | 同一 session 的音频与 conversation 作为上下文，可加只做翻译的 instructions；需限制历史大小、跨通隔离，避免把远端话直接当成本地待译话。 | ASR 使用该具体模型支持的提示；文字翻译显式提供本通有界近期原文/译文，更易核查否定、数字、日期和自我更正；TTS 只读已提交英文，不承担推断原话。 |
| 首音延迟 | 没有独立 ASR→文字→TTS 的串行关卡，有较低延迟潜力。默认 VAD/response 通常在轮次边界后启动，不能直接继承 dedicated 边说边译；短段 commit/response 的设计与质量需单独验证。 | 首音包含获得足够可信识别片段、翻译该片段、TTS 首音及播放等待。流式 TTS 能在该请求的整段音频完成前播放，不能消除前两段等待，也不是任意文字 token 的持续 append 接口。 |
| 1–2 分钟持续讲话与边讲边播 | 不能简单等 1–2 分钟语音结束。需有界分段及 response 排序，避免同一源讲话的新 speech_started 被当作必须取消尚未播完译音的打断。不是当前连续算法的参数修改。 | 识别修订与可播放英文片段分离；只提交不可再替换的前缀/小段，按序流式合成并播放，边讲话边交付。过早提交会读错，过晚提交增延迟；跨段接缝和处理速度必须检验。 |
| 打断与已播放修订 | WebSocket 路线需按实际已播放时长 stop/clear、cancel 和 conversation truncate，避免模型以后以未播放内容作上下文；Twilio 媒体播放队列也要一致清理。 | 取消未提交翻译和未播放 TTS，丢弃旧 generation 的迟到片段并清空播放；已听到的旧内容不能回滚，需要选择怎样播报明确更正。 |
| 识别/翻译准确性 | 能直接利用声学信息，避免显式 ASR 字符错误逐级传递；也可能把翻译任务当成对话回答、概括或猜测。可 prompt 约束，效果仍未知；独立字幕并不保证与译音逐字一致。 | 原始 ASR、整理展示、翻译、TTS 输入可分别核查；能约束字幕和 TTS 读取同一个提交英文。ASR 漏词仍会传递，下游 prompt 不能凭空恢复原话；重复更正要按来源版本管理。 |
| 成本 | 输入/输出音频及文字上下文按选定 Realtime 模型计量；历史重读、输出长度和 reasoning 配置可改变成本。不能只按连接数与 duration 断言便宜。 | ASR 音频、文字翻译输入/输出、TTS 文本/音频分别计费；细碎分段/被取消的已生成内容也可能产生费用。多阶段不必然更贵或更便宜。 |
| 改动范围 | 新协议 adapter、voice/config ack、conversation/turn/response 状态、上下文限额、输出队列、打断/truncate、会话隔离和安全清理回归。使用 OpenAI 也仍是模型/endpoint/音频架构改变。 | 新可发声的翻译/TTS 路线与 revision/提交前缀、排序/背压/播放取消、跨段 codec 状态及费用观察；现字幕支路只能作为可复用材料，不能直接冒充可播放翻译管线。 |

两路都继续保留 remote 英文原声直接返回与中文字幕；voice 只控制 local 中文→英文输出。均不增加双向自动回答，不把双方原声混成一个识别输入，不启用自动失败回退/重拨。现有登录、控制权、单通、供应商验签、一次 join 与双腿失联/错误清理继续是约束。

### 成本比较口径

2026-10-13 读取的 [native model page](https://developers.openai.com/api/docs/models/gpt-realtime-translate) 公示 duration 单价为 $0.034/min；这是文档费率，不是账户回读或本通账单。候选 A/B 未选定可用模型与 snapshot，不能现在给出通话总价或节省比例。

未来比较应分别取得供应商实际 usage 并乘对应费率：A 汇总该模型音频、文字、缓存和其他实际计费项；B 汇总 ASR + 文字翻译 + TTS；再加现有 remote/outgoing 字幕、Twilio 两腿/媒体和云资源。候选 A 的 token 费用、候选 B 的多请求费用不能直接与 native duration 数字相除。按相同语料、输入时长、输出播放量统计 p50/p95 首音、完整译意时间及实际总费用，包含失败和已产生的取消费用。

来源：[Realtime costs](https://developers.openai.com/api/docs/guides/voice-latency-cost#realtime-api-costs)、[pricing](https://developers.openai.com/api/docs/pricing)。这只是方案估算/比较需求，不恢复已取消的应用金额预算、journal 或固定 300 秒截止。

## 建议与后续决策材料

如果优先目标是保持同一男性听感，并能检查“实际播了哪段英文”和上下文更正，建议先把 B 作为评估候选；它提供更直接的文本与发声边界，但能否同时满足持续播放和低延迟尚未验证。A 可作为减少串行处理阶段的对照候选；须先设计持续讲话的分段/response 策略，不能按普通语音助手默认行为直接替换。

未来路线选择至少需要确定：固定内置 voice 的用户试听结果、可用且可锁定的模型、持续讲话提交边界、双方插话时的播放/取消策略、已播放更正的处理、可接受首音/累计延迟及实际费用。此处未指定声线 ID，不按名称猜性别，也没有从官方样例直接批准一个生产模型。核对时常规 Realtime guide 的模型样例与旧 model page 处于不同版本；TTS guide 示例模型页面也显示弃用标记，实施前须再核当前受支持模型、schema、voice 集合和费率，不能照抄旧示例。

需验证的语料应覆盖中文单人连续 1–2 分钟及更长讲话、短停顿、结巴/重复、明确自我更正、数字/日期/地址/否定、双方交替与插话、迟到结果、codec 连续性及新会话隔离。先做无需付费的排序、版本、队列和清理回归；之后经单独授权再做同语料盲听及端到端电话测量。实验首音 0.5–1 秒仅作为候选目标，未达标前不承诺。

评估音频若后续需要留存，应由用户明确选择范围、保存位置及删除方式；本轮未默认录音、保存正文或开启采集。字幕稿件或模型整理文字不能替代录音来判断用户到底说了什么。

本轮止于本文件及官方/源码只读审计。native 听感问题保持“未确诊、未试听验收”；dot 可据此核对未来方案，不把本轮字幕与上下文修改记为已锁定译音男声。
