# 连续语音翻译降延迟：候选与接入计划

日期：2026-09-26。核对基线：`codex/local-phone-workbench` 的 `e40a8829a75fe9f2cc6ed4aa84e773cc288a0c32`。本轮为代码审阅与官方资料研究，没有安装新模型、调用新翻译 API、改运行配置、重启或拨号。

## 用户最新优先级

先解决约 3 秒的耳听等待，覆盖自然长句及连续说话，不以缩短测试话术或把 VAD 调小作为主要方案。此前“2 秒以内”只是初步目标，不是用户认可的最终上限。不以漏译、截音或提前播放可能改写的文字换取速度。维持本机开发运行，云端部署另行决定。

## 已确认的等待点

当前 `src/solo/translation-bridge.ts` 使用 `server_vad`（500 ms），关闭自动响应。ASR 增量只更新字幕；收到最终转写后，`nextTurn()` 才把文字发给模型生成译音，还须等待上一轮生成结束。

输出已经按 `response.output_audio.delta` 立即转发，已有 WebSocket；不需要把“增加流式输出”再做一遍。下一轮生成不等待 Twilio 播放 mark。最新 20 段的内部排队中位为零，尚无证据把主要延迟归因于此。

已有服务端停说事件至首音频中位数为 1273/1394 ms；此计时不含前面的停顿判断和全部传输/耳机播放。不能将用户体感 3 秒减去这两个数便认定差额都是网络。详细边界见 [上一轮分析](LATENCY_ACCURACY_REVIEW_2026-09-26.md)。

**主要改造方向：持续送入声音，按已经明确的意思持续输出译音，解除本程序“最终 ASR 才能启动翻译”的门槛。** 长句应能在说话过程中逐步翻译。短句仍受理解上下文、推理和传输影响，不能承诺任何句子都在固定几百毫秒内出声。

## 候选及优先级

| 候选 | 已核实的能力 | 当前限制与建议 |
| --- | --- | --- |
| OpenAI `gpt-realtime-translate` | 官方专用连续语音翻译，可在源讲话过程中输出译音与字幕 | 优先做最小接入试验；账户权限、中英两个方向及耳听速度尚未验证。不是在现有接口里只换模型名称 |
| Palabra Speech-to-Speech | 官方支持中文和英语、双向语音翻译；提供 Twilio 电话示例，支持分块音频和长句拆分 | 作为实际对照候选。宣传“低于 1 秒”不能当本项目电话承诺；partial 译文不证明立即产生译音 |
| SimulStreaming | AlignAtt/LocalAgreement 等策略增量决定输出；支持语音到翻译文字，含中英路径 | 开源自部署研究候选，需另接流式 TTS。完整方案建议 1–2 块 GPU，不是现成桌面电话插件 |
| Meta SeamlessStreaming | 多语种流式语音到语音/文字模型 | 技术实验候选；权重 CC-BY-NC-4.0，不优先用于商业产品；CPU 推理不推荐 |
| Hibiki / Hibiki-Zero | 同时接收及生成语音的研究实现 | 当前官方已发布方向不覆盖中文；排除本次中英替换 |

优先 OpenAI 最小试验，是因现有供应商接入与连续翻译协议的适配关系，不是已经证明它比 Palabra 快。若账户或中英双向能力不满足，直接推进 Palabra；最终由同一输入、同一电话链路对照决定。

也可自研“稳定增量识别 → 增量翻译 → 流式 TTS”。这里的关键是只提交不会再被修改的片段，维护上下文与已播边界；单纯把临时字幕交给另一个通用语言模型，容易增加等待、重复或错误朗读。这条路线比专用 API 多出工程工作，不作为最快验证路径。

## 给本机 Codex 的实施顺序

1. **保留现有引擎作为 A 组。** 增加可选择的翻译提供方适配层，不重写已经打通的拨号、接听、Twilio 号码及通话清理。新增候选默认关闭；现有版本始终可回退。
2. **B 组：OpenAI 专用连续翻译。** 使用 `/v1/realtime/translations?model=gpt-realtime-translate`，不是原对话端点。持续输入音频（包括静音），不等待最终转写、不发送逐句 `response.create`。处理专用音频/字幕事件，按方向各建会话；先验证账户及英、中输出，再进入电话对照。
3. **C 组：Palabra 对照。** 参考官方 Twilio 示例的媒体适配，按当前文档实现认证及连续连接。会话准备只做一次，不每句话重建连接。单独检查长句分段、音频队列和输出时机；字幕提早不能算耳听提早。示例中的原声混音、旧认证方式和临时隧道做法不直接照搬；复制代码前核实许可。
4. **媒体适配。** Twilio 8 kHz μ-law 与候选所需的 PCM 音频之间做持续转换，输出再回编 μ-law。OpenAI WebSocket 使用 24 kHz PCM16；Palabra 可选 24 kHz PCM 输入，输出固定 24 kHz PCM。重采样保持跨块状态，避免逐块启动外部进程、攒整句或重复编码。
5. **保留完整性与退出语义。** 方向、旧事件隔离、鉴权、背压与失败清理继续保留。正常输入结束给引擎有限时间输出剩余音频；用户明确挂断则停止。OpenAI 正常结束使用专用关闭事件等待剩余输出。不要为降低数字而丢旧音频；Twilio `clear` 后收到 mark 不能计为已听完。
6. **实际比较后才选择默认。** 同一设备、同一输入、同一网络做比较；如新引擎无明显改善或产生遗漏，保留 A 组并按分段计时继续定位。

上述为待实施任务，本轮未声称已有适配代码或新引擎测试结果。已有默认识别/翻译模型及用户私密配置均未改。

## 怎样判断确实改善

- 保留 [V1 固定话术](PHONE_TEST_V1.md)，增加中英各 20–30 秒正常语速连续段落；不要求人为改说短句。
- 分别记录：输入音频时间、供应商首个有意义译音块、转发目标线路、实际接收端听见。服务端时间戳不能代替同步耳听测量。
- 长段落核对对应语义片段的跟随延迟，以及停止说话后还有多长尾音；短句核对说完到首个有意义译音。报告两方向的中位数及慢端分布，避免只展示最好一次或无意义首声。
- 同时核对否定、数字、句尾、问句不代答及重复漏译。先用可重复的测试音频在引擎侧比较，再在双方准备好时做电话；真人录音或转写仅按用户确认私密处理，不上传共享仓库。
- 供应商“首 token”“首音频包”或宣传延迟，不直接等同于本项目手机/耳机的听感结果。

本机桥接可能增加跨区域传输，是待测假设。应测网络与播放缓冲再决定是否调整媒体服务位置；固定公网域名解决可达性，不自动降低翻译延迟。本轮不部署云端或增加托管服务。

## 官方来源

- [OpenAI 连续翻译指南](https://developers.openai.com/api/docs/guides/realtime-translation)
- [OpenAI 模型说明](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [Palabra 双向语音翻译与语言清单](https://www.palabra.ai/voice-translation-api)
- [Palabra 官方 Twilio 示例](https://github.com/PalabraAI/twilio-demo)
- [Palabra WebSocket 接入](https://docs.palabra.ai/docs/quick-start/websockets)
- [Palabra 分段与音频设置](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)
- [SimulStreaming 代码、硬件及实现说明](https://github.com/ufal/SimulStreaming)
- [SimulStreaming 英译中实验论文](https://aclanthology.org/2025.iwslt-1.41/)
- [SeamlessStreaming 模型与许可证](https://huggingface.co/facebook/seamless-streaming)
- [Hibiki](https://github.com/kyutai-labs/hibiki)、[Hibiki-Zero 已支持方向](https://github.com/kyutai-labs/hibiki-zero)
- [Twilio 音频、播放标记与缓冲](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
