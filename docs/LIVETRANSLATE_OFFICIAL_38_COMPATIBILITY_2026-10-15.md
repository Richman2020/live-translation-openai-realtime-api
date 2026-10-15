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

人工派生用例仅把原样音色改为Aiden，继续保留缺失的复刻字段：当前候选在 configuring 状态、session.enable_voice_clone 校验处停止，期望false，actualType=missing，voiceCloneEnabled=null，录音发送0字节。不进入ready、不发出configuration_accepted、不构造provider_error。

该分支改为专用本地码 LIVETRANSLATE_CLONE_CONFIRMATION_MISSING，汇总分类 voice_clone_disabled_confirmation_missing，中文“缺少复刻关闭确认”。不得称为已启用复刻、供应商拒绝或已确认关闭。明确true仍属于配置矛盾；未将缺失/null/类型错误补为false。

只有人工另加明确false的派生ACK才能通过此项；这只证明本地门控，不证明真实3.8服务会回显false或接受Aiden。官方字段表列boolean，但完整3.8示例没有此键，回显可用性仍是兼容性未决项；关闭复刻要求继续保留。

## response.created 与本地支持范围

共有response.created原样示例是 status=in_progress、voice=Cherry、output=[]，未另标精确3.8模型，不能称为官方3.8 Aiden示例。原样帧在本任务先因Cherry/Aiden矛盾停止。仅修改voice=Aiden的人工派生用例证明空output可接受为“已创建、仍待完成”，不会误判缺少最终输出；若随后直接session.finished仍因pending response停止。

官方response.created字段表将output写string，而完整示例为[]；response.done表写object、示例为数组。当前按阶段和示例形状处理，不把此文档类型差异当作已确认的服务端错误。

共有音频delta/done及部分done表写索引目前固定0；3.8新增原文/译文delta表仅写integer索引，示例为0，没有全局保证单输出/单content。当前实现的output_index=0、content_index=0、单输出/单内容PCM是本地限定；超出范围用具体LIVETRANSLATE_UNSUPPORTED_SCHEMA停止，不能断言供应商违反整个3.8协议。

## 离线验证与类型检查缺项

新增14项官方原样/人工派生用例及关联回归共158项通过，覆盖字段路径负例、缺复刻回显与明确true、空创建输出及pending response清尾。最终8个受保护进程记录真实网络尝试0。日志与网络保护回执保存于独立交付根的evidence；本地模拟结果不证明真实模型或音色可用。

PATH、常见全局目录及已有44个node_modules目录均未找到可用TypeScript编译器；package.json声明typescript但离线依赖未附。故完整tsc --noEmit -p tsconfig.json未执行，不报告类型检查通过，也未安装补齐。
