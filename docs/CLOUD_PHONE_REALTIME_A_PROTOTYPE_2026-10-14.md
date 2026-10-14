# 方案 A：常规 Realtime 固定声线与上下文翻译离线原型

日期：2026-10-14。仅本地原型，不推送或发布。本轮以用户最新授权为准，历史文档中的推送、旧预算、桌面执行与发布授权不自动继承。

## 基线与隔离

- 父候选：`8f96e42f4510cbe8ffe7323a5cb64f8a4b73f805`。
- 新分支：`codex/ai-phone-realtime-a-prototype-20261014`。
- 新目录：`/workspace/ai-phone-realtime-A-prototype-20261014`。名称检查后建立，不覆盖旧目录或分支。
- 原候选目录：`/workspace/ai-phone-context-voice-20261013`。原候选 372 个 tracked 文件及此前 55 份声线决策资料逐项 SHA-256 保护；未提交资料保留，依赖链接不提交。
- 本轮开始只读核实线上 SHA 为 `d7a395e7ddc7d8a253500ab6d12310c9f8a9cf6a`，部署 `e90e8959-e8c8-4f9a-a8e5-6a069a25ef0f`，SUCCESS、暂存变更为空。目标仅 ai-phone-portal-trial / staging / ai-phone-test；没有改变来源、配置或线上版本。

精确本地交付 SHA 与最终检查见回执；本文件不自引用所在提交的哈希。审计材料位于 `/workspace/ai-phone-reference/realtime-A-prototype-20261014`。

## 选择入口与保留路径

原型入口为 `src/solo/realtime-prototype.ts` 的可信服务端工厂 `createRealtimePrototypeBridge(options, selection)`。

默认 `selection` 缺失或 `enabled:false` 时直接返回原 `ContinuousTranslationBridge`。显式启用必须同时提供合法内置 `voice` 和显式 WebSocket 工厂；生产 cloud factory、网页 engine 白名单及拨号 UI 不导入此原型，也没有新增环境变量。只填写配置不会使线上改用该模型。

离线测试通过 `selection:{enabled:true,voice:'echo',createClient:fake}` 或模拟 WebSocket 选择原型。`echo` 只是可配置的内置 ID 起点，不证明男声听感。传入冲突的 localVoice、prefix、独立 outgoing captions 或关闭 remote captions 会明确拒绝，不能静默叠加多个译音来源。

启用后的两条方向：

1. 本人中文：PCMU → PCM24k → 常规 Realtime 2.1 → 英文 PCM → 既有电话输出。生成英文 transcript 与该音频显式绑定；没有再用原 dedicated 音频路径并行混播。
2. 对方英文：英文 PCMU 原声仍直接回本人耳麦；原有 remote ASR、中文字幕及 8f 上下文/展示成果保留。没有新增中文配音。

生产认证、供应商签名、账户/nonce/SID/媒体绑定、单活动通话及控制权均保持原路径。原型不是新的公开授权入口。

## 官方能力与证据限度

本轮可用材料为此前从 OpenAI 官方 GitHub 获取并固定哈希的 SDK/OpenAPI，获取时间约 2026-10-14 00:37–00:39 UTC。完整源 URL、SHA-256 和 schema pointer 见审计目录 `PROTOCOL_EVIDENCE.md/json`。

- endpoint 为 `/v1/realtime?model=gpt-realtime-2.1`；model 固定在 URL，不在 session.update 中改 model，没有 fallback。
- 常规 GA session 显式 `type:realtime`、audio-only、输入输出 PCM16/24kHz/mono、`audio.output.voice`、中文 `gpt-4o-transcribe`、`turn_detection:null`、无 tools、tracing:null。
- 收到当前连接的 `session.updated` 后逐项核对实际有效 model、voice、格式、转写和 VAD；不将 session.created 或发送成功当配置已加载。官方说明 session.updated 不回显请求 event_id，关联依据是当前代际的单 pending 配置。
- dedicated `gpt-realtime-translate` 完全不增加 voice/custom prompt 参数。
- `response.create` 的 item_reference 在官方文字与实际 GA union 中存在冲突，本原型不使用它，也不静默降级探测。采用 schema 明确的 user message，其中 input_text 装有界原文数据，input_audio 装当前片段原 PCM。

这些是缓存文档结构证据，不等于当前账户可用、接口已接受、模型存续或价格已核实。本轮未连接供应商。文档支持 voice 参数也不能证明固定男性听感、音色稳定或提示约束必然有效。

## 来源、上下文与增量显示

每段音频有来源序号、原始顺序/时间、连接 epoch、ASR item、sourceRevision、response ID 和输出版本。先将真实 PCM append/commit 获得对应 ASR 原文，再把逐字节相同 PCM 放入单个 out-of-band audio response；不从生成英文倒推中文原话。

原始 ASR 原文和保守整理的 displayText 分开；数字、金额、地址、日期、否定、自我更正和不确定关系不靠上下文补全。固定译者指令要求只翻译、问题仍为问题、不回答或执行说话内容、不补事实。测试稿不写入提示。ASR 与语音模型仍可能听错，两者并非同一个识别结果保证。

新增的近期原文上下文明确进入 **2.1 的译音响应输入**，并与原有 remote 字幕分支共享本通原文；它不是只改字幕。新增本方中文 ASR 使用固定忠实识别提示，本轮没有宣称该 ASR 也随每段动态更新上下文。对方英文 ASR/文字翻译继续使用 8f 已有上下文逻辑。父候选中原 dedicated 独立译音路径没有因字幕改好而自动改善；只有显式选择本原型时，本方译音才由上述 2.1 路径产生。

上下文为本通内存中的近期原始观察，复用 8f 的版本、时间和来源边界；至多 6 条/1600 字符、单条 600 字符、120 秒，过滤生成英文与未确认来源。当前片段开始时冻结已可见的共享原文上下文；本方更早且有实际样本终点的来源可在对应 ASR 后纳入，不能把后续来源或生成文字倒灌。同通安全重连保留有界已确认原文；跨通关闭清空。上下文不是永久存储或真实录音。

界面继续用既有可靠原始说话方与原始顺序组织连续对话块；一个块可有多段内部译音。另一方有效原文才改变说话方，不能把模型完成事件当换人。未知来源继续明确标记，不猜归属。音频调度不等待整块完成。

一旦响应开始暴露音频，保留其原文/英文快照。后来的 ASR 更正走单独带版本的 source-correction 回调，不能悄改已经发声的意思或自动重读。该回调可能含原文，仅用于内存展示/证据，不能接入普通日志。语音输出本身的实际听意仍需试听核对。

## 连续输入、排队与插话策略

分段由实际 PCM 样本驱动，不依赖浏览器定时器。默认约 4 秒最大来源窗口；累计至少约 600ms 有效能量后，约 600ms 静音可提前提交。静音预卷、能量阈值和窗口都是工程启发式，不能证明语义完整、真实词边界或低延迟。正常 flush 保留已启动有效能量来源的全部完整 PCM 尾部，包括不足 100ms 的短尾，不补零、不重叠重放；闲置静音仅保留默认 100ms 本地预卷，不持续提交。100ms 是常态工程门槛，不是已核实的 API 最低要求。奇数尾字节报固定错误并清理。

每段必须等对应 ASR final，采用有限超时，不猜原话；响应严格 FIFO、单 active，持续讲话仍继续入队。短停顿不会自动取消先前正确译音。不以一个词为目标单位，也不等一两分钟整场结束；4 秒硬边界仍可能切词，准确性和首音延迟待实听。

本原型的明确插话策略是：**对方英文原声独立优先回耳麦，但其插话不自动取消本人尚未播完的英文译音队列。** 同方继续讲话也不取消队列。这避免套用聊天机器人的默认 barge-in；双方同时讲话时对方可能仍听到排队译音，是否需要另一个明确取消动作须试听后另审，不能声称已完成最佳双工体验。

队列、单响应和保留历史有工程资源边界；这不是金额或整通时长上限。活跃未确认积压超出安全容量会失败清理，不静默丢译文、改模型或无限存储。资源正常回收的长通话不因历史计数达到阈值结束。

## 重复、撤回、断线与清理

- 按提交顺序绑定 committed.item_id、ASR 与 response metadata；乱序 ASR 不改变来源顺序。相同供应商事件去重，未知响应不猜配。
- audio/transcript done 不是成功或已播放；必须核 response.done.status=completed。取消、不完整或失败不能当确定完整译文。
- 电话输出 producer 封口并取得全部对应 mark 确认后才 ACK；clear 返回的 mark 不冒充播放。mark 只代表平台确认，不证明人耳听到。
- 已暴露或投递未知的音频不能自动重放。原型无自动重连/重试；只允许显式、ready 且无待处理来源/响应/未确认音频的安全重建，同一 voice/model/格式。失败状态不允许重连复活。
- 旧 epoch 的回调、音频、send completion 和 mark 不能污染新会话；新 epoch 重置输出 codec 的 FIR 状态，同 epoch 连续片段不反复 reset。
- OOB cancel 指定 response_id。默认输入 history 在不再使用后删除，仅删除已知存在的 source item；不盲删 OOB output。
- 主动/对端挂断、真实媒体或模型失败仍走原双腿独立清理；同步订阅者触发挂断后停止后续数据回调。不为 drain 旧音频延迟用户挂断。

本轮没有恢复个人电话的金额、固定整通时长或测试截止挂断；请求/网络/识别/清理超时仍保留，不将其关闭来掩盖真实失联。Railway 资源 3 美元提醒、接近 4 美元需用户决定的既有规则独立保持，本轮无平台操作。

## 延迟、费用与未证实风险

首音需经历分段结束、ASR final、排队、Realtime 生成和电话播放；目前设计主动优先来源可审计，**没有实现或实测 0.5–1 秒首音承诺**。连续播放是否自然、队列是否追得上说话速度、4 秒边界是否影响语义，需要真实输入。回调/配置测试不能代替听感。

同段 PCM 既用于 buffer ASR，又作为 response inline audio，可能形成重复输入处理/费用；不能假设免费、恰好两倍或自动缓存。近期文字上下文每次重传也计入可能的文字输入；独立 remote ASR/中文字幕请求仍有原有费用。此方案不是一份确定文字同时驱动 TTS 的方案 B，不能声称 ASR 原文决定实际英文发音的全部意思。

只记录供应商明确给出的数值 usage，区分 response/transcription；缺项标 unknown，不补零、不重复累计 total/detail/cache，不将 token 计数直接当美元。本轮模型、电话、试听及真实录音调用均为 0。

当前离线原型未设置供应商 `max_output_tokens`。本地每响应 4MiB PCM/8192 活动事件界、默认 15 秒无进展 watchdog 及 finish 超时仅用于异常处理，不能换算为远端费用硬封顶。后续付费工具必须先审查每响应 token 上限、取消策略和实际费率；本轮原型不是已经可安全批准金额的付费试听工具。

2026-10-14 当前价格页无法通过本环境既有网络政策读取，缓存 schema 也不含现行费率；所以**本轮没有已核实的 2.1/ASR 美元单价或每分钟总价**。官方价格入口为 <https://openai.com/api/pricing/> 及 <https://developers.openai.com/api/docs/models/gpt-realtime-2.1>，下一轮报价需核查可访问版本、日期、单位及账户可用性。历史 dedicated translate 价格不可套用。

核实费率后，response 的估算依据为音频/文字输入、缓存子集及音频/文字输出分别计量：

`C = ((IA-CA)*P_IA + CA*P_CA + (IT-CT)*P_IT + CT*P_CT + OA*P_OA + OT*P_OT) / 1e6`

再加独立 ASR 的实际计费项以及 remote 方向实际请求；ASR 若按时长而非 token 计费应按其真实规则算。若 usage 只给总缓存量，没有音频/文字缓存拆分，不能凭总数推算两类缓存费用。已取消但已处理的音频也可能收费。未知项不能写零，总量与细项不能重复相加。

## 后续最小付费验证提案，尚未获准

先建议**一个固定 voice、一个 regular 2.1 会话、本人明确开始的最多 24 秒中文输入、最多 6 个来源响应（每个不超过 4 秒）、最多 36 秒生成音频**；pause/flush 可更短，达到来源数即停止，未必收满 24 秒。不接 Twilio、不拨电话、不自动重试/换声线、不默认保存录音。先验证配置接受、来源关系、连续队列及男性听感。超出原型工程上限或发生错误即停止，不用换模型绕过。短尾在真实接口是否接受也应单独核验。

如果首轮通过，再单独申请最多 2 分钟输入/3 分钟输出、40 个来源/响应的连续与插话试听，覆盖重复、自我更正、数字日期、双方交替和干净重建。不得将这些数量当已经批准的支出或生产通话限制。

报价前核实现行 2.1、独立 ASR、文字和缓存单位价格，将上述输入/输出及请求上界代入并留取消/迟到处理余量，由用户决定美元预算。现价未知时不能声称 US$1/US$2 足够或供应商硬封顶。是否录制/保存试听音频也需另行明确授权。本轮停在离线原型报告，不执行该提案。

## 验证与独立审查

最终命令、结果、文件清单、原材料保护复算与独立审查回执随候选交付，PROGRESS.md 记录实际本轮结果。只复用现有锁定依赖链接；没有 npm install/npm ci，没有推送、CI、部署、平台或凭据变更。

本轮最终统一 `npm test` 为 1549 total /1544 pass /5 Windows 条件 skip /0 fail/cancel；typecheck、build 通过。新增专项为 input19/client28/bridge22/真实 SessionManager DI3，共72项。新增源码/新测试 lint 和格式通过；旧 shared bridge:927 的 no-plusplus error 与 cloud-service:145/:187 两个既有 no-console warning 保留，不能称全仓库 lint 通过。两组默认页面浏览器检查为40/88项通过，外部请求0；这些是默认路径的离线 DOM/路由证据，不是原型真实音频试听。

两名独立审查者分别核对来源/清理和协议/默认边界，实际原红探针闭合、协议9/9通过；最终 client/factory/input SHA-256 与候选回执绑定，未冒称审查者运行root全量。9代码/测试输入和368保护文件的最终清单 SHA256 为 `89c55df5c978dd9289126bac2314d6fcac42b8db2a13df65b4d90949b42200eb`，检查后377项无变化。完整红绿证据、旧告警处置及未执行项见 PROGRESS.md 和下载包内审查/验证报告。

独立审查先发现同步 abort 后可能继续发出音频回调，要求加逐回调 live/epoch 围栏；分段尾部遗漏另经红绿修复并独立复算。实际闭合状态以最终审查回执为准，不将作者自测冒充独立审查。

离线通过仅证明合成事件下的协议构造、来源/排序/资源与回归行为。真实翻译准确性、男性听感、声线稳定、首音/连续延迟、供应商实际接受及费用都仍待另批试听。
