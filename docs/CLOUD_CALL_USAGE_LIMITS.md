# 云电话整通应用用量限额

**最新覆盖（2026-10-11 12:58 UTC）**：用户已取消应用内五美元预算；个人phone不启用下文整通金额/累计用量预算，也不需要费用上界或预算journal。实际鉴权、协议技术限制与双腿清理保持，见 [个人云通话](CLOUD_PERSONAL_NO_BUDGET.md)。本文为历史记录。

2026-10-11最新开发修正：固定300秒及对应媒体额度已由完整费用上界推导的D替换，六处接线和离线回归已完成；尚未发布，实际费用证据仍缺失、电话仍关闭。实现、精确证据格式与旧journal兼容见 [预算驱动时长](CLOUD_BUDGET_DURATION.md)。以下固定300秒和“尚待实现”段落保留原阶段记录，不代表最新源码，也不恢复已撤销的五分钟要求。

2026-10-11：从 `356b23f` 继续实现已授权的整通用量闸门与超限提前清理。本轮无部署、真实电话或付费API；运行仍固定 `4bab94e`、calls-disabled。父线程报告新版应用登录和使用中自动保持已实际验证；号码编辑无拨号与真实电话分别验收。本轮离线验证见 [PROGRESS](../PROGRESS.md)，推送对应的精确CI结果见[草稿PR #3](https://github.com/Richman2020/live-translation-openai-realtime-api/pull/3)。

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

当前可证明的是应用拒绝进一步发送和保留清理责任，不是供应商严格金额封顶。继续保留能力、完整费用、回调范围、唯一本人目标、原卷/journal和统一试验窗口等全部门槛；不自行设置 `CLOUD_TRIAL_RATE_BOUND_CONFIRMED`，不开放电话。准备完成后仍由父线程先通知用户ready，再进入已授权的单次、合计5美元测试；用户已撤销固定五分钟要求，见下文。Railway两服务4美元/3美元提醒预算独立管理。


## 预算驱动时长：最新用户修订

用户已明确不要固定五分钟，仍只授权一通且Twilio/OpenAI合计最多5美元。也已批准将旧桌面App出呼Voice回调切到Railway，来电不改；父线程已完成并刷新读回外部App的Railway /voice/client POST，Fallback/Status为空、未拨号；部署隐藏App SID是否一致仍待安全核验；唯一本人目标已由父线程从原用户消息核验，清值只用于授权测试的私有配置，不写仓库/文档/日志，本任务未写云变量。**不能证明更长通话在5美元内；现有300秒也不是已证明费用保证。** 上表300秒对应的是当前代码保护，不是最新用户产品要求，不将其静默改大或去掉。

预算驱动的有限兜底时长应满足：

```text
完整最坏费用(D) = 文字请求责任上界
                + translate计费音频分钟 × 0.034
                + live-transcribe计费音频分钟 × 0.017
                + 4o-transcribe完整责任上界
                + browser腿与实际目标腿费用 + 各Media Stream费用
                + 适用税费/附加费 + 建立、未知结果和在途清理余量
完整最坏费用(D) <= 5美元
```

按普通美国目标、一条browser腿、两条Media Streams，且计费音频分钟恰等于D的未验证假设，公开已知项是`(0.034 + 0.017 + 0.004 + 0.014 + 2*0.0044)D = 0.0778D`美元。它缺少4o转写、进位、税费、特殊tokens和清理责任，**不能把此式解成可批准的运行时长**，也不采用4o的0.006美元/分钟均值补洞。现有2.952美元文字代理和2美元工程预留均需先闭合真实上界。

最短后续改造：先核实4o自动VAD/转写输出和在途责任、模型完整计费token/音频计量，以及安全提供的目标号码实际费率与附加费；然后生成一个已验证的有限D和完整费用预留，原子落原持久journal后再创建资源。同一D驱动Twilio两腿timeLimit、应用绝对截止、PCM/PCMU累计字节和断连清理。金额不足立即停止；失联或进程失败由供应商时限兜底，未知SID/账单不清除预留。不同字节格式必须按各自采样率换算，包含补零/尾帧；文字仍按真实请求逐次预留，不能因扩大D自动增加次数或总额。

目前D缺证据而无可证明值，先保留phone关闭。需要变更的旧固定点包括cloud-service-config、cloud-budget-journal的policy校验、SessionManager的两腿时限检查、cloud-call-usage音频额度和cloud-index的检查输出；必须同步修改并回归，不能只换UI文案或增大某个常量。journal scope包含时长与字节额度，变更时须先核验原账本/未清责任并按恢复契约处理，不能删除原账本或重新初始化空预算。服务试验窗口也须覆盖D及清理期限，并由统一窗口授权，不用重启延长。

参数化还需将所有字节总量与策略版本一同绑定：现有journal聚合输入/输出各72MB，策略校验最大100MB，不能只增大单流额度；共享用量策略也应纳入持久scope，避免相同账本悄然改变责任。准入截止应取预算D、费率有效期和服务统一期限的最早值并留清理余量；原60秒Voice加入期限与late-callback窗口不是通话时长。Pocket本地模式的独立保护不属于此次云候选调整范围。
