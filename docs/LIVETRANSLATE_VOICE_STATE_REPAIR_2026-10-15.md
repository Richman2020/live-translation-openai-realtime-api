# 4c1ad02音色状态修复：仅离线

在当前项目和目录继续，父提交为 `4c1ad02234481ee14c1e3a4093f3c09e51e4ebfb`。原录音、Tina成功基准、51份本次失败交付文件及5枚已消费spent锁保留。此次没有新的模型连接、录音上传或执行授权；不安装、不推送、不部署、不改凭据/网络，不补跑。

## 已证实根因

以下行号属于精确旧提交4c1ad02的 `src/experiments/livetranslate-client.ts`，不是当前文件行号：

1. 142–143从用户请求初始化 `voice=Andre` 和 `effectiveVoice=voice`。
2. 725–727识别本次批准的更新冲突。809又执行 `effectiveVoice = s.audio.output.voice`，把Tina这一层回显当成唯一后续判断依据；815把嵌套Tina存入ready结果的兼容字段voice。
3. 366–367要求 `response.voice === effectiveVoice`；`response.created` 在971调用，`response.done` 在1115调用。因此真实第5帧 `response.created.voice="Andre"` 被拿去和Tina比较，产生本地 `LIVETRANSLATE_CONFIGURATION_REJECTED`。

真实 `output: []` 没有触发拒绝，捕获范围没有供应商error。此前174项测试错误地把该Andre响应组合列作拒绝预期，未覆盖真实组合；本次已更正，不能再拿旧测试通过作为此处兼容依据。原始来源、源文件哈希及旧代码摘录在独立证据目录 `evidence/voice-state-repair-20261015/ROOT_CAUSE_4c1ad02.json`。

## 新的状态模型

请求音色为不可变Andre，始终发送 `session.voice="Andre"`、`enable_voice_clone=false`。分别保存session.created、session.updated顶层/嵌套，以及每次response.created/done的音色声明；每层保留reported/missing/invalid_type/unsupported_value，不以缺失填默认，不保留任意未知字符串。`onVoiceEvidence`记录对应会话/响应/事件ID、接收序号及时间。

只有同会话、同次更新的全部配置检查通过，且已获准的topAndre/nestedTina组合成立，才建立冻结的兼容政策：后续响应声明可为Andre或Tina。这个集合不因某次response而缩小或扩大；第三个音色、null或其他异常类型仍拒绝。缺response.voice按本地兼容策略记未知，并不声称官方保证该字段可省略。默认strict、dual、duplex及exactAndre更新仍只接受原请求值。

ready.voice保留为**已弃用的嵌套回显兼容别名**，没有再次赋给请求或后续唯一比较值；正式字段是requestedVoice、sessionOutputVoiceEcho、voicePolicy与逐事件voiceEvidence。runner复核policy中的请求、精确允许集合、同ACK标识/序号/时间/各层回显及已批准警告，不能仅凭兼容别名放行。报告v2使用confirmedConfigurationMetadata取代误称actualEffectiveConfigurations，明确这些只是配置元数据，不是实际声学音色。

## 全流程分支核对

| 分支 | 保留或修正的行为 | 证据范围 |
| --- | --- | --- |
| session.created | 保存初始默认回显，不要求预先为Andre；原id/model门槛保留，再发送固定请求 | 真实5帧回放与合成 |
| session.updated | 完整配置、同会话、PCM/en及复刻检查先通过，才建立窄政策；缺clone仅按原规则警告未知 | 真实冲突及负例合成 |
| response.created | 统一政策验证声明，记录每层证据；创建阶段空output正常，id/status/就绪顺序仍严格 | 真实Andre响应通过原停点；其他合成 |
| 音频分片 | 不新增不存在的必填voice；原PCM16、分片格式/大小、来源/响应绑定、FIFO及限量保持；附请求/政策上下文，声学未知 | 仅合成；真实失败未捕获音频 |
| response.done | 与created共用固定政策；先观测/校验再处理已done早返，新event_id的第三声线不被吞；usage与完成事件不重复记 | 仅合成 |
| 重复与乱序 | 同event_id同内容幂等，异内容拒绝；未创建响应的输出、缺关键来源/完成字段等继续拒绝 | 仅合成 |
| 清尾 | 完整原/译文、音频done、response.done及session.finished等原门槛保留；空created不等于空done成功 | 仅合成 |
| 超时/取消/供应商错误 | 继续停止和清理，不换模型/音色、不重试重连；部分音频只能记部分，不能记完整 | 仅合成 |
| 无usage | 可与完整音频同时存在，但费用仍未知；basis=unknown不能因数组非空冒充已报告用量 | 仅合成 |

协议进展、完整英文音频、男声听感/漂移是独立outcomes。字段中出现Andre/Tina不构成听感判断；声学音色、男声验收及漂移均保持未测。

## 回放、回归及工具限制

`actual-andre-session-tina-response-andre.redacted.json`精确保留此次5条脱敏入站事件，出站配置来自实际ws.send原字符串，源哈希可核对。对照测试从Git提取精确4c1ad02旧client/types，只重定位模块导入以使用现有依赖，旧版稳定在response.voice失败；新版本通过同一个真实停点。没有追加伪造的音频/完成事件到真实回放；回放时钟只是帧序号，不是模型时延。

后续完整输出、缺字段、重复乱序、空output、供应商错误、无音频、部分音频、usage缺失、清尾/超时/取消均明确标为synthetic。8文件统一回归205/205通过，9份统一回归guard报告网络尝试合计0。各定向及合成证据分别保存，不合并成“真实完整试听通过”。

已实际运行 `npm run typecheck -- --pretty false`，退出127：PATH及本项目确切位置均无tsc。完整类型检查未完成，不把tsx转译或运行测试当类型检查。仅做精确路径核验，没有广泛重复查找或安装。启动该检查时，网络guard阻断并记录1次尝试；没有保存目标，不能归因为模型调用，也不能声称所有检查的网络尝试均为0。没有放行或重试该尝试。

## 仍可能阻止下一次完整试听的具体事项

- 真实捕获只到response.created；实际音频、response.done、来源/字幕绑定及session.finished尾部仍无本次真实证据。若后续不符合现有协议门槛，仍会停止，不能由合成通过预先担保完整音频。
- 单输出/index=0、最多6响应、36秒输出及90秒总限时等本地范围保持；超出这些范围会停止，不称为模型故障。未经客户端对应请求的更新或错误状态也不自动恢复。
- Andre/Tina元数据的供应商权威含义仍未明确，当前只是用户批准范围内的本地兼容政策。真实男声和无漂移必须听取实际音频，不能从名称或回显推定；短录音不代表长通话稳定。
- 完整tsc缺编译器仍是集成验收缺项；缺usage或未明示的文本输入费率仍导致费用待核，不以未知作零。

新的scope为 `livetranslate-single-local-andre-voice-state-v1`，父版本绑定4c1ad02；旧已消费授权不能用于新候选。本轮止于离线修复及固定提交，下一次真实试听须另行确认。
