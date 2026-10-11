# 云电话整通应用用量限额

2026-10-11：从 `356b23f` 继续实现已授权的整通用量闸门与超限提前清理。本轮无部署、真实电话或付费API；运行仍固定 `4bab94e`、calls-disabled。父线程已实际看到新版UI，Google重登、号码编辑无拨号与真实电话分别验收。本轮离线验证见 [PROGRESS](../PROGRESS.md)，推送对应的精确CI结果见[草稿PR #3](https://github.com/Richman2020/live-translation-openai-realtime-api/pull/3)。

## 生产接线与实际限额

`cloud-service.ts` 把已配置整通金额传给 SessionManager，每通创建一个 `cloud-call-usage.ts` 状态。continuous bridge 包装实际WebSocket创建与send；native、remote ASR/text、outgoing ASR/text最多各占一次固定槽，不能重连恢复额度。默认三会话，显式开启出程配对字幕后五会话；两个不同文字client共享一份总额。

| 项目 | 应用侧约束 |
| --- | --- |
| 整通预留 | 整数microUSD，严格大于2000000且不超过5000000；所有已准入文字预留与固定非文字预留之和不得超过配置金额 |
| 非文字预留 | 固定2000000 microUSD；是工程预留，未证明为供应商非文字费用上界 |
| PCM24k输入 | native、remote ASR、outgoing ASR各最多14400000 bytes，即每流300秒PCM16单声道；实际发送包括客户端补零与drain |
| 播放 | native PCM最多14400000 bytes；回程PCMU最多2400000 bytes；不能据收到/播放字节推定供应商只生成这些输出 |
| 两文字分支累计 | 最多60次response.create、450000输入代理单位、72000预留输出tokens |
| 每次文字请求 | `conversation:none`、显式纯文本input、输出text、max_output_tokens为1–1200，输入代理最多32768 units |
| 输入代理计算 | 实际序列化请求UTF-8字节数 + 该session instructions UTF-8字节数 + 4096工程余量；每次重新计入重复上下文、转义和instructions |
| 文字预留金额 | `inputUnits * 4 + max_output_tokens * 16` microUSD；发送前原子消耗，不依赖缓存折扣 |
| 协议限制 | 固定模型/URL/会话形状、无工具、限定消息类型；全部send最多100000条；未知或非法消息关闭准入 |

满额文字代理计算为 `450000*4 + 72000*16 = 2952000` microUSD，加固定非文字预留为4952000。**这是应用预留算式，不是4.952美元供应商账单证明。** 小于该金额的合法配置会更早触发金额限制；限额是最大值，不保证整通一定能运行300秒或完成60次请求。

准入在实际付费连接/发送前执行，因此字幕定时器、ASR结果触发的延迟翻译也不能跳过。失败、取消、超时和未知发送结果不退款；正常收尾也继续计数。拒绝后同步停止整个bridge、abort所有模型分支，再独立清理两条电话腿；不能只禁用字幕继续音频。迟到SID仍清理，未知责任保留，浏览器关闭不等于供应商已经终止。

原durable journal必须先预留整通，maxCalls=1、原300秒墙钟限制、两腿时限和清理职责继续。新状态是单通内存闸门，不改变journal schema、不清空锁或账本、不退款、不因重启恢复授权。snapshot固定标为 `scope:application_reserved`、`billed:false`、`costBoundVerified:false`。

## 官方价格与尚未证明的部分

以下为2026-10-11公开官方页面核对，不是账户实际资格或目标费率验收。

| 固定模型/服务 | 公开证据 | 不能据此推出的保证 |
| --- | --- | --- |
| gpt-realtime-translate | [模型页](https://developers.openai.com/api/docs/models/gpt-realtime-translate)：音频时长$0.034/min | 未闭合输入/输出计量、静音、取整及关闭在途责任；socket墙钟不代替上传时长 |
| gpt-live-transcribe | [模型页](https://developers.openai.com/api/docs/models/gpt-live-transcribe)：音频时长$0.017/min | 不把每分钟展示价直接当完整会话账单；补零/尾音也进入本地输入限额 |
| 两路gpt-realtime-1.5文字 | [模型页](https://developers.openai.com/api/docs/models/gpt-realtime-1.5)：输入$4/M、输出$16/M tokens | 4/16 microUSD每token已核对，但inputUnits不是已证明的billing tokens |
| gpt-4o-transcribe | [模型页](https://developers.openai.com/api/docs/models/gpt-4o-transcribe)：输入$2.50/M、输出$10/M；[定价页](https://developers.openai.com/api/docs/pricing)列$0.006/min为Estimated cost | 音频/文字token分类、自动VAD各turn完整责任仍未闭合；本次未得到旧$6/M audio费率的当前官方支持，不能套旧价或分钟均值保证 |
| Twilio | [美国页](https://www.twilio.com/en-us/voice/pricing/us)：普通外呼$0.014/min、browser/app $0.004/min、Media Streams $0.0044/min；Alaska $0.0945/min | `+1`不能证明普通美国路由；两腿、各stream、清理延迟、取整、税费和附加费均须独立覆盖 |

[Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)明确：conversation:none不把输出加入默认对话，显式input建立本次上下文，max_output_tokens限制单次响应输出。现有两client符合这一文字路径，但每次重复提供的context和instructions仍会收费。

[官方成本指南](https://developers.openai.com/api/docs/guides/voice-latency-cost?voice-api=realtime)明确：输入转写独立计费，manual或VAD commit均触发；completed.usage包含input_tokens、input_token_details.text_tokens/audio_tokens与output_tokens。因此应用显式commit数量或收到的transcript字节不能限制全部已发生转写。模型页的2000 max output也不足证明Realtime自动turn数量及在途费用。接收后再停不能撤销已生成的输出。

UTF-8字节可作文本内容的保守工程代理；[tiktoken](https://github.com/openai/tiktoken)为byte-BPE实现，但模型特殊tokens、供应商框架及隐含上下文未获得严格上界。官方成本指南也说明内容外特殊tokens会增加计数；额外4096只是工程余量，不能用它把costBoundVerified改成true。

[Twilio Call resource](https://www.twilio.com/docs/voice/api/call-resource)的timeLimit以秒限制通话，具体约束依账户配置；两腿实际生效仍须验收。预留时各腿完整分钟向上取整是保守计算策略，本轮未成功读取官方帮助页的具体进位规则，也未闭合Media Streams计费粒度。[目标号码费率文档](https://www.twilio.com/docs/voice/pricing)提供按目的号码/来源读取价格的机制，本轮未访问账户。[条款§3.2](https://www.twilio.com/en-us/legal/tos)明确价格不含适用税费和通信附加费；固定2美元预留不能替代这些上界证据。

## 门槛与后续

当前可证明的是应用拒绝进一步发送和保留清理责任，不是供应商严格金额封顶。继续保留能力、完整费用、回调范围、唯一本人目标、原卷/journal和统一试验窗口等全部门槛；不自行设置 `CLOUD_TRIAL_RATE_BOUND_CONFIRMED`，不开放电话。准备完成后仍由父线程先通知用户ready，再进入已授权的一通、300秒、5美元测试。Railway两服务4美元/3美元提醒预算独立管理。
