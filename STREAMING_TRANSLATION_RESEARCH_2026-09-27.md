# 连续电话翻译降延迟：市场与 GitHub 调研

调研整理日期：2026-09-27，承接 2026-09-26 的真实通话与分析。用户本轮明确：先研究等待时间，不把短句压到 2 秒视为最优方案；要自然长讲话也能持续跟上，优先复用市场/GitHub 的已有实现。

本轮只读取公开官方资料、仓库和现有源码；没有安装候选、调用收费模型、拨号、更改配置或重启服务。以下排序是技术适配判断，不是实测速度排名。

同步时发现并保留远端 `020c8f9` 的 [OpenAI/Palabra 并行研究与接入顺序](STREAMING_TRANSLATION_OPTIONS_2026-09-26.md)。本文补充 Soniox 与更多开源候选，原方案和来源不删除；两份材料均未证明实际胜出供应商。

## 结论与建议

优先做两个独立对照：**OpenAI 专用实时翻译 + 官方 Twilio 示例**，以及 **Soniox 流式翻译 + 流式 TTS**。Palabra 为下一候选，Qwen/豆包作国内线路及长讲话备选。现有号码、浏览器工作台和电话管理继续复用，先替换独立候选里的翻译桥，不重写整套电话系统。

真正要改变的是“必须等一轮讲话最终识别完才开始翻译”的结构。连续讲话时，翻译应在原声仍输入时开始，已经说出的内容与译音的距离不能持续扩大。以缩短 VAD 或让用户只说短句作为主要解决办法，不满足新要求。

此前“短句 2 秒以内”是建议阶段值，本轮不再将它视为最终目标或上限。先比较同一材料下的完整延迟曲线，再提出有证据的目标；不能凭宣传承诺亚秒电话翻译。

## 现有系统的真实等待点

### 用户补充：准确度与识别是否一起解决（2026-09-27）

用户明确要求不能为了速度牺牲译意，询问是否增加更精确的识别模型。专业建议是**分层定位、联合验收、分步改动**：识别、译意和延迟共同决定候选是否采用，不能先优化速度再把正确性留到最后。以下是待验证建议，未新增模型或修改运行配置。

当前已使用专门 ASR：本机选择 `gpt-4o-transcribe`，最终文字再驱动 `gpt-realtime-1.5`。识别错会传给后续翻译；但采音不完整或切句错误也可能是起点，先用可核对的原声定位，不直接堆第二个模型。

| 改法 | 对等待的影响 | 对实际译音的影响 |
| --- | --- | --- |
| 替换现有识别模型 | 不必然变慢，取决于推理、上下文、切句和最终结果稳定时间 | 若相同电话音频上更准确，可改善文字驱动的译音；需成对比较 |
| 第二个模型复核后才放行翻译 | 复核进入必经路径，会增加相应等待；具体增量须测 | 可能发现错误，但复核也会错，不能当准确率保证 |
| 连续语音翻译旁边并行识别 | 不必把识别完成作为译音启动条件；额外负载和费用仍需评估 | 可用于字幕和诊断；若结果不参与音频生成，不能自动提高译音准确度，更不能改掉已播放的内容 |

拟议 OpenAI 专用连续翻译直接接收音频，原文字幕是可选旁路能力；不能把更换字幕识别模型等同于改善译音理解。若需要由识别文字控制所说内容，需另评估“稳定增量文字 → 翻译 → 流式 TTS”的方案和等待代价。另一模型的字幕也不是绝对真值，应以源音频和人工复核的含义为准。[官方连续翻译与评估说明](https://github.com/openai/openai-cookbook/blob/main/examples/voice_solutions/realtime_translation_guide.mdx)

更强模型不必然更慢；等待更多上下文可能减少误识别，同时增加文字输出时间。短期优化应比较首个可用结果、稳定结果、错误修订和实际译音时机，不能仅比较一次接口耗时。[官方识别延迟与准确度说明](https://developers.openai.com/api/docs/guides/realtime-transcription)

实施门槛：同一批真实、可核对的中英输入，分别统计原文识别、最终译音语义以及耳听延迟；包含自然长讲话、数字、否定、时间、姓名、句尾和自我纠正。候选在代表性测试中出现漏译、额外内容或关键含义错误，不因更快而通过。只有字幕正确、或整体字错率下降，也不能覆盖译音关键错误。必要的含义确认等待应保留，不能盲目抢先播出。先比较连续翻译候选与旧版，失败按层定位，再决定替换 ASR 或采用增量文字路线。

`src/solo/translation-bridge.ts`：500 ms 静音切句；等待最终转写；同方向上一条 response 未完成也须等待；将文字送入新 response 生成译音。输出 delta 已立即写给 Twilio，没有主动等待整条译音生成完成。旧设计曾用于减少原声直译与可见原文不一致的问题，新方案仍要验证准确度。

前轮 20 段真人日志的局部处理中位数为两个方向 1273/1394 ms，详见 [此前分析](LATENCY_ACCURACY_REVIEW_2026-09-26.md)。它不包括完整网络、VAD 与终端播放。本轮没有新电话测量，不能算出各网络跳数的耗时占比。

## 商业 API 候选

| 候选 | 已核实能力 | 本项目适配与关键限制 |
| --- | --- | --- |
| OpenAI `gpt-realtime-translate` | 专用连续语音翻译；边接收边输出；官方 Node/Twilio demo 已存在，目标语言表含 `zh`、`en` | 最接近当前 Node 主干。每方向独立会话，8k μ-law ↔ 24k PCM16；账户权限和本线路效果未测。代码公开不等于模型开源或免费 |
| Soniox | 识别与翻译 token 持续输出，流式 TTS 可在原句结束前出声；中英语音输出 | 有官方语音翻译 demo。STT 支持 μ-law、TTS 支持 8k μ-law，有利于电话适配；仍须实现双向路由、字幕与播音队列。总延迟不是只有 TTS 首音耗时 |
| Palabra | 语音翻译 API、部分转录翻译、长句拆分、自动语速和队列管理 | 输入 16–48k PCM/Opus/WAV、输出 24k PCM，需转码。默认未播放队列目标 5 秒/上限 20 秒，溢出会丢较旧音频；不是固定多等 5 秒，但必须检查长讲话积压和漏译 |
| Qwen LiveTranslate | 官方列出 3.8 与 3.5 实时模型，中英均支持音频；3.5 文档明确可在输入过程中返回译音 | 默认 PCM16k 入/24k 出；北京/新加坡 WS，3.5 另有 WebRTC/AOQ。3.8/3.5 协议不同。官方“低至 2.3 秒”口径不足以直接与本电话停口到耳听比较 |
| Seed LiveInterpret 2.0 | 官方中英双向连续语音翻译，针对长讲话调整输出节奏，火山引擎提供入口 | 厂商报告语音首词约 2.53 秒及 2–3 秒级同传，不是本线路耳听实测，也不等于说完再等 2.53 秒。协议及账户开通条件本轮未完整核实，列作候补 |
| Azure Speech Translation | 正式 SDK、连续识别/翻译；另有 Live Interpreter 路线 | 连续字幕不能直接证明连续译音低延迟；Live Interpreter 的访问条件需另核验。暂不作为首轮优先项 |

来源（均已打开正文）：

- [OpenAI 连续翻译指南](https://developers.openai.com/api/docs/guides/realtime-translation)；[官方电话示例](https://github.com/openai/openai-cookbook/tree/main/examples/voice_solutions/realtime_translation_guide/twilio-translation-demo)。
- [Soniox S2S 架构](https://soniox.com/docs/translation/sts-translation)、[语言](https://soniox.com/docs/translation/supported-languages)、[STT 格式](https://soniox.com/docs/stt/rt/real-time-transcription)、[TTS 格式](https://soniox.com/docs/tts/concepts/audio-formats)。
- [Palabra 队列、切句和格式](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)。
- [Qwen 官方文档，更新于 2026-09-23](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-livetranslate-flash-realtime)。
- [Seed 官方模型与评估](https://seed.bytedance.com/en/seed_liveinterpret)；[Azure 官方说明](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-translate-speech)。

## 可以复用什么，不能把什么当成成品

1. **OpenAI Cookbook 电话 demo（首选参考）**：已通过 GitHub Contents 回读真实的 `audio.js`、`realtime-translation.js`、`room.js`、`languages.js` 等文件，语言表含中英；仓库根许可证 MIT。可适配音频转换和连续会话，保留许可声明。demo 的两路来电配对、内存状态不能覆盖本项目浏览器外呼、安全控制和挂断清理。[源码目录](https://github.com/openai/openai-cookbook/tree/main/examples/voice_solutions/realtime_translation_guide/twilio-translation-demo/src)、[许可证](https://github.com/openai/openai-cookbook/blob/main/LICENSE)。
2. **Soniox 官方 demo**：真实 FastAPI/JS 应用，可借鉴双 WebSocket、TTS 预热、保活和结束排空。已读 `main.py`，有未限制长度的 asyncio 文本队列；当前示例 TTS 模型仍为 v1，文档示例为 v2，不能直接照搬。采用前核对 token 稳定性、去重、模型版本和许可证，不能仅凭有源码宣称已生产可用。[示例目录](https://github.com/soniox/soniox_examples/tree/master/apps/soniox-speech-to-speech-translation-demo)。
3. **Pipecat**：可借用 Twilio 编解码、流式重采样与队列处理设计；Python 框架，不是翻译模型。**LiveKit** 的实时翻译示例适合房间音轨路由，但迁移电话还涉及 SIP；换框架本身不消除模型整句等待。[Pipecat 适配源码](https://reference-server.pipecat.ai/en/latest/_modules/pipecat/serializers/twilio.html)、[LiveKit 示例](https://github.com/livekit-examples/gemini-live-translate)。
4. **Palabra 官方 Twilio demo**：远端研究指向该仓库，本轮再次打开核实，确有 FastAPI/Twilio 媒体桥。原示例包含原声混音，不直接照搬；采用前核对当前认证、语言、许可与队列策略。[官方示例](https://github.com/PalabraAI/twilio-demo)。

## 开源模型筛选

| 项目 | 是否满足中英连续语音 | 不优先替换当前电话的原因 |
| --- | --- | --- |
| [SimulS2ST-Omni](https://github.com/hasaki321/SimulS2ST-Omni) | 已发布中英双向长音频 S2S、WS demo；代码 MIT、模型标 Apache-2.0 | 需 Linux/CUDA；论文附录 F 的最低延迟英→中档 RTF 大于 1，计算会落后输入；完整双工交互列为后续工作。不是已证明快于本电话的方案 |
| [Confucius4-T3PO](https://github.com/netease-youdao/Confucius4-T3PO) | 中英增量文本翻译，READ/WRITE 策略；demo 接流式识别 | 缺译音生成，还要接 TTS/GPU。适合借鉴增量提交机制，不是完整电话同传 |
| [SeamlessStreaming](https://github.com/facebookresearch/seamless_communication) | 官方语言表包括中英 S2S | GPU/研究部署栈；代码 MIT、模型 CC-BY-NC 4.0，不能把代码许可当模型商用许可 |
| [Hibiki](https://github.com/kyutai-labs/hibiki) / [Hibiki-Zero](https://github.com/kyutai-labs/hibiki-zero) | 已发布方向没有中英双向 | 语言不匹配，排除直接使用 |
| [StreamSpeech](https://github.com/ictnlp/StreamSpeech) | 公开模型主要法/西/德→英 | 不是现成中英双向；分块 320 ms 不等于译音耳听 320 ms |

[SimulS2ST-Omni 论文限制与计算延迟](https://arxiv.org/html/2607.19810v1)、[模型卡](https://huggingface.co/HA-SA-ki/SimulS2ST-Omni)、[SeamlessStreaming 模型卡](https://huggingface.co/facebook/seamless-streaming)。这些是作者和厂商证据，本轮未独立复现硬件性能；开源模型文件大小也不等于所需显存。

## 如何公平验证长讲话延迟

首轮限定“现有版本、OpenAI 专用连续翻译、Soniox”三个条件；若外部候选无法获取，再按 Palabra、Qwen 顺序替补。账户接入可用后才进行受控实验，不必同时重构五家。

- 同一组自然中英素材，包括 V1 短对话、20–30 秒完整长表达、60 秒连续讲话、句中停顿、否定、数字和自我纠正；两个方向分别统计。长素材是新增压力组，不替换 V1。
- 按真实语速送音频，不能高速上传文件后把离线处理时间当流式延迟。比较模型时共用格式/样本；比较电话时共用线路和设备，注明转码开销。
- 同一时钟记录三个指标：开始说话到首个有意义译音；对应语义片段从原声到实际译音的持续落后；停止讲话后最后内容播完的尾部等待。短句另保留既有停说到首译音口径，不能互换。
- 比较开头、中段和末段延迟是否增长；保留 p50/p95/最大值及样本数。语音已经在播放时，单一“停说→首音”指标会失去意义，必须看对应内容和尾部等待。
- 完整性作为约束：漏句、改数字、丢否定、重复、播放队列丢弃都计失败，不能通过删除排队译音或让用户只说短句换取快。
- 可参考 [live-s2st-eval](https://github.com/VoiceFrom/live-s2st-eval) 的同钟音频/语义对齐方法。它由供应商维护、用模型判分且需另有凭据；本轮未验证许可证或运行，先借鉴测量口径，不把其中厂商排名当独立结论。

待模型对照胜出后，再检查电话网络/部署位置是否仍是主要开销。当前 Twilio Media Streams 为 8k μ-law，换 WebRTC/LiveKit 不能自动让 PSTN 全程宽带；Twilio mark 也不能替代实际听到声音的时点。[Twilio 媒体及缓存说明](https://www.twilio.com/docs/voice/media-streams/websocket-messages)

## 本轮完成状态

已完成公开方案筛选、关键源码存在性/部分实现检查和实验设计，并更新共享需求与进度。尚未实现新翻译桥、验证新账户权限、安装模型或获得新真实通话结果。本轮仅文档变更，使用差异检查，不重跑无关源码测试。各示例的最终采用版本、依赖及许可应在实现时固定。
