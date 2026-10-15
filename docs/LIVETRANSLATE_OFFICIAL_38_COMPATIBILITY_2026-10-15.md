# 官方3.8完整示例的离线兼容性核验

范围：只用既有官方页面缓存和 fake socket；不建立新真实连接、不安装依赖。父候选 `1cb4ff6a116791d1ecd9a03e2deb07b360890c92` 保留，本次是其离线增量。旧真实失败、录音及 spent 锁不变。

官方依据：[LiveTranslate服务端事件](https://help.aliyun.com/zh/model-studio/live-translator-server-events)，此前缓存工具引用 `turn599740view0`。完整JSON及字段表转录在 `fixtures/livetranslate-protocol/official-38-document-examples.json`，标注 `official_document_excerpt_not_provider_capture`。这是缓存页面文本转录，不是源HTML字节快照或实际服务端帧。

## 实际字段路径

| 用途 | 3.8 session.updated 实际路径 | 官方原样值 |
| --- | --- | --- |
| 模型 | session.model | qwen3.8-livetranslate-flash-realtime |
| 输出音色 | session.audio.output.voice | Tina |
| 输入格式 | session.audio.input.format.type / sample_rate | pcm / 16000 |
| 输出格式 | session.audio.output.format.type / sample_rate | pcm / 24000 |
| 目标语言 | session.translation.language | en |
| 关闭复刻证据 | session.enable_voice_clone | 示例未出现 |

请求 session.update 使用 session.voice；3.8 ACK使用嵌套 audio.output.voice，两者不可混用。缺少嵌套voice时不能用顶层voice补齐；没有翻译language时不能用自行构造的target_language补齐。

## 缺少关闭复刻确认

原样官方示例包含 Tina，因此本任务会先在 session.audio.output.voice 的 Aiden 门槛停止。这是本地用户要求与示例默认音色不一致，不能称为供应商拒绝Aiden。

最新用户已批准仅在单中文试听中放宽字段缺失的处理。客户端仍显式发送enable_voice_clone=false；同会话对应session.updated且精确模型、Aiden、英文、输入输出PCM及所有其他已有检查通过时，仅缺此字段可记录非致命警告后ready。voiceCloneEnabled保留null，voiceCloneConfirmation=missing_echo_warning，不能标为实际确认关闭复刻。

该策略通过单中文runner显式传入allowMissingVoiceCloneEcho启用；client默认及duplex门槛不变。runner接受null还须核对相同session.id、event_id、receiveSequence和receivedAt的ACK，以及同clip、同receivedAt的非致命缺字段警告。没有匹配证据不能放行。

字段存在且为true、null、字符串/数值/对象/数组仍停止；其他配置不匹配仍停止，不能先发警告再忽略错误。未启用新策略的旧入口仍使用缺确认停止诊断。这项放宽来自本次用户明确授权，不是官方新增了“缺省即false”的保证。真实Aiden支持及复刻实际状态仍未验证。

## response.created 与本地支持范围

共有response.created原样示例是 status=in_progress、voice=Cherry、output=[]，未另标精确3.8模型，不能称为官方3.8 Aiden示例。原样帧在本任务先因Cherry/Aiden矛盾停止。仅修改voice=Aiden的人工派生用例证明空output可接受为“已创建、仍待完成”，不会误判缺少最终输出；若随后直接session.finished仍因pending response停止。

官方response.created字段表将output写string，而完整示例为[]；response.done表写object、示例为数组。当前按阶段和示例形状处理，不把此文档类型差异当作已确认的服务端错误。

共有音频delta/done及部分done表写索引目前固定0；3.8新增原文/译文delta表仅写integer索引，示例为0，没有全局保证单输出/单content。当前实现的output_index=0、content_index=0、单输出/单内容PCM是本地限定；超出范围用具体LIVETRANSLATE_UNSUPPORTED_SCHEMA停止，不能断言供应商违反整个3.8协议。

## 离线验证与类型检查缺项

前阶段官方示例及关联回归158项通过的证据保留。本次另补仅缺字段警告放行、同会话证据、存在但类型异常及其他配置仍拒绝的回归；本次相关167项离线检查通过，8个受保护进程记录真实网络尝试0；最新日志与回执保存在独立交付根evidence/CLONE_POLICY_*。本地模拟结果不证明真实模型或音色可用。

PATH、常见全局目录及已有44个node_modules目录均未找到可用TypeScript编译器；package.json声明typescript但离线依赖未附。故完整tsc --noEmit -p tsconfig.json未执行，不报告类型检查通过，也未安装补齐。
