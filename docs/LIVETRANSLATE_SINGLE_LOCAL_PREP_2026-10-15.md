# 单中文 LiveTranslate 最小试听准备（2026-10-15）

本轮只完成离线转换、单中文入口及预检；没有连接模型、发送录音、产生模型费用、安装、推送、部署或修改密钥/网络。原 f2e0acd4ec1d42450feb29e290fd0455244bc466 与原交付包保留。本地增量仍在 codex/ai-phone-livetranslate-prototype-20261015；线上、OpenAI 和阿里三段方案不变。英文方向本次不验收，无需等待英文录音。

## 完整录音与校验

| 文件 | 格式 | 样本数 | 完整时长 | SHA256 |
| --- | --- | --- | --- | --- |
| audition_24k_mono_pcm16.wav（用户原文件） | 24kHz / mono / PCM16 | 506336 | 21.097333333333335 秒 | 2fa83fd693485802a715e17666e83a4d748a30a78cdcf5d4b0d14ca5f11059e1 |
| audition_16k_mono_pcm16_full.wav（本地派生） | 16kHz / mono / PCM16 | 337558 | 21.097375 秒 | 58419fda20d4b0062e5ede15b289fdd052c3a5b4c789b6e195a22f9fa4f8af1f |

使用已安装 FFmpeg swresample，完整 24k→16k 有理重采样；没有裁剪、重录、变速或归一化。原文件前后哈希不变。新样本数为 ceil(506336×16000/24000)，向上舍入多约 0.041667 毫秒，低于一个 16k 样本，不丢尾段。派生 WAV 为 675194 字节，音频 PCM 为 675116 字节。

资料目录为 `/workspace/ai-phone-reference/livetranslate-single-local-20261015`，含 `CONVERSION_RECEIPT.json`、`AUDIO_SHA256SUMS`、派生样本、真实 workspace 的 `single-local.manifest.json` 和离线预检；录音不进 Git。独审 RIFF/fmt/data、样本数、哈希及原文件不变均通过，没有试听或对声学质量作结论。

## 单中文入口与停止条件

manifest v2 / `mode=single-local`，只有一个 local 中文 clip；旧 v1 双向模式保留。固定一个北京 `qwen3.8-livetranslate-flash-realtime` 会话、预设 `Tina`、`enable_voice_clone=false`，输出英文音频和译文，不调用独立 ASR/MT/TTS。

默认命令只读样本、manifest 与元数据，不读密钥或联网：

```sh
node --import tsx scripts/livetranslate-audition.mts --manifest /workspace/ai-phone-reference/livetranslate-single-local-20261015/single-local.manifest.json
```

新模式只接受独立 v2 审批 scope `livetranslate-single-local-audition-v1`，绑定实际最终 SHA、manifest/样本哈希、模型、Tina、精确域名、新样本发送同意及新人民币金额；旧双向/OpenAI/阿里试听授权均不能复用。尚未创建真实批准文件、一次消费记录或输出目录。未来执行须另外提供 `--run --approval PATH --out NEW_PRIVATE_DIRECTORY`，不能仅靠本报告执行。

本地限制：输入累计≤24秒、一个会话、最多接纳6响应、保存英文音频≤36秒、总等待≤90秒、零自动重试/重连。失败/超时/取消立即停止后续发送与事件接纳并关闭会话，供应商错误/配置拒绝不换型号或音色。第7响应可能已生成，检测后停止；超出保存范围的音频及关连接前已生成但未保存/播放的内容仍可能计费。官方接口未确认支持输出 token 上限或独立取消生成参数，未伪造这类能力；这些本地条件不构成账单硬封顶，也不限制正常线上电话时长。

客户端在会话创建时显式设置模型、语言、格式、Tina 和关闭复刻，收到匹配 session.updated 后才能发送 PCM；ACK 缺失、不完整或不匹配则拒绝。尤其 clone=false 回读目前是保守要求，真实接口是否返回该字段仍待核；本轮只能验证模拟接受/拒绝，未取得供应商确认，不承诺 Tina 为男声或听感稳定。

## 真实时间发送与未来交付

每20毫秒最多640字节顺序发送，最后556字节完整保留；等待相应音频时长后才继续，没有瞬间上传/补发追赶。逐帧记录 clipId、PCM偏移、长度、音频流起止和 application append 单调时刻；记录 sendStartedAt/sendCompletedAt/sendElapsedMs。它们是应用发送观察，不是网络实际收包或人耳播放证明。

独立使用真实派生样本、生产默认 wait/performance 时钟及本地内存 fake-client 验证：**1055包，675116字节逐字节一致，一个模拟会话；首末 append 跨度21309.688毫秒，发送完成跨度21326.290毫秒**，名义21097.375毫秒与调度开销分开。未创建 WebSocket、读取真实 key 或生成可听试听产物；这些时间不是模型延迟。

未来成功执行交付 `english-combined.wav`、逐响应英文 WAV、原始识别/译文事件、配置回读、逐帧发送时序、首PCM到达、FIFO交付/等待、译文定稿及响应完成时间、分类usage和费用。音频收集结束为 runner 单调时刻，文件写完另记 epoch 时间且不是 fsync/播放时刻。原音人工声学终点未标注，不能用文件末尾或供应商估计终点冒充真实说话结束；实际播放未测则为 unknown。首PCM、全文、响应完成、完整文件写完分别报告，不拿首包代替完整等待。

## Workspace 与用户手动配置

用户提供非敏感 ID：`ws-y26guohg2gsusct1`。已填真实 manifest，SHA256 为 `d67f3988d0d7f038856da1d1f3d17aba13383d8641b9f5564440b889cd4e6d80`。

- [北京业务空间管理](https://bailian.console.aliyun.com/cn-beijing/settings/workspace)：查看既有 Workspace ID/API Host，无需新建空间。
- 精确目标域名：`ws-y26guohg2gsusct1.cn-beijing.maas.aliyuncs.com`。
- 精确入口：`wss://ws-y26guohg2gsusct1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime`。
- 沿用变量 `ALIYUN_BEIJING_API_KEY`。用户本人从[北京 API Key 页](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)确认现有 key 匹配该空间/地域及精确模型权限；不向聊天提供 key，也不因为示例变量名不同就换凭据。
- 用户在 **设置 → Codex Cloud → Environments → live-translation-openai-realtime-api → … → Edit → Network secrets → Manage → ALIYUN_BEIJING_API_KEY → Allowed domains** 加入上面的精确主机，保留原需用目标域；检查受限 Internet access/Additional allowed domains 包含它，保存并 Republish。不要改成全网放行，不修改 Railway。随后从已发布环境启动任务，只验证安全元数据，不假定旧任务实时更新。

当前任务13:18:12（北京时间）metadata显示spec/observed revision均126、network enforced，没有ready阿里绑定、没有maas专属host放行。此为当前任务快照，不代表用户草稿/其他任务配置；没有读取实际密钥。用户给ID后只填manifest，没有新增权限、探测API或改网络。本轮仍缺已发布环境的有效绑定/精确主机放行、账户精确模型权限证据及新金额/发送确认。

官方依据：[Workspace ID](https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id)、[地域](https://help.aliyun.com/zh/model-studio/regions)、[密钥范围](https://help.aliyun.com/zh/model-studio/get-api-key)、[连接与会话](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)、[客户端事件](https://help.aliyun.com/zh/model-studio/live-translator-client-events)、[Codex 环境](https://learn.chatgpt.com/docs/environments/cloud-environments)。公开文档核对2026-10-15 13:16北京时间；没有登录读取用户账户或密钥。

## 本次用量、价格与新预算

2026-10-15核对[北京3.8模型公价](https://help.aliyun.com/zh/model-studio/qwen3-8-livetranslate-flash-realtime)、[价格表](https://help.aliyun.com/zh/model-studio/model-pricing)：音频入¥40、译文文字出¥100、音频出¥160/百万token；原文ASR免费。输入约7、输出约12.5音频token/秒只用于规划；实际以usage/账单核对。

| 规划项 | 估计用量 | 估计人民币 |
| --- | --- | --- |
| 完整中文输入21.097375秒，一次发送 | 147.681625音频token | 0.005907265 |
| 计划英文输出≤36秒 | 450音频token | 0.072 |
| 单中文译文预留（不是服务端限制） | 1024文字token | 0.1024 |
| 正常规划合计 | 上述三项 | **0.180307265** |

原¥0.28352来自旧双向规划：24秒输入168token×40/M（¥0.00672）+36秒输出450token×160/M（¥0.072）+2048译文token×100/M（¥0.2048）。不是测得费用，也不是本次单中文录音估计。

保守观察例为6×4096输出token全部按最高输出¥160/M计¥3.93216，加完整输入按6轮重复计¥0.03544359，约**¥3.96760359**；仍建议新批准额度¥5，规划余量约¥1.0324。4096仅模型页面能力的规划假设，尚非已核实的跨模态上限；隐式历史/输入文字计费、额外生成和服务端关停时差未全部定价，不把未知按0。因此¥5目前**未获批准，也不是可证明的账单硬封顶**。若用户要求不可越过的硬金额边界，而供应商侧不能提供，执行应停下说明，不能用本地计数伪装满足。

本次仅一个实时会话/连接；不单独提交ASR/翻译/TTS，不主动重复输入，不自动重试重连。供应商自动分句产生的响应数量只能观察后停止，不能保证恰好响应一次；完整长句的实际分段尚待试听。不会自动重跑旧三段路径做对照。

## 本轮离线验收与待确认

新增单中文/独立审批/真实时钟及尾帧回归连同既有audition和真实client假WS E2E共 **52/52通过，0失败/跳过**；独审另行复跑同52项并核冻结文件哈希。定向ESLint、typecheck及build通过。旧1973项属于f2e历史全量，不冒称本轮全量。没有重新进行付费或真实通话验收。

下一步用户最少操作：完成以上现有环境精确域名/匹配key的手动保存发布；再明确同意把该哈希完整录音发给本空间LiveTranslate，并决定新人民币额度（¥5只建议，须理解本地停止不等于硬封顶）。之后先在新任务核有效配置；满足条件及新批准后才可一次执行。无需重录或补英文样本。准确性、Tina听感、真实延迟、完整输出及入账费用均未验证。
