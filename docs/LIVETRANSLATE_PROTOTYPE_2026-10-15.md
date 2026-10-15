# LiveTranslate 最小离线原型与待批准对照试听

2026-10-15。父候选 `ffb3f7a2178c678177cb08641970c3215a310e6f`（两通挂断诊断、字幕修复）；独立分支 `codex/ai-phone-livetranslate-prototype-20261015`。本轮仅离线，不推送、部署、拨号、安装、上传录音、调用付费模型或改凭据/网络。完整需求不因原型缩减。

## 保护与切回

原候选和 incident/display 证据已经独立封存，完整211提交bundle在临时目录clone/fsck成功，428/428源文件哈希一致。旧call-fix工作树未改；原integration的6d及未提交PROGRESS正文/patch单独保留。封存不含用户录音、依赖目录、构建产物或运行秘密配置。原OpenAI、三段Plan B、A原型与旧试听执行器均保留；本轮不再大规模优化旧三段路径。

原型只增加独立实验模块和命令，不加入生产provider工厂、默认配置、网页或电话入口。因此现有OpenAI代码默认选择、线上6d阿里配置和生产音频链均不改变；不设置LiveTranslate开关时不会建会话。回到父ffb3新建worktree即可恢复本轮前代码，不能reset覆盖他人工作。此前两通实际挂断及farmer来源仍未确认。

## 官方能力与协议边界

核验日期为北京时间2026-10-15；以下依据现行官方文档，不是本次付费接口回执：

- exact `qwen3.8-livetranslate-flash-realtime`，北京地址为 `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime`。旧3.5文档URL同时列新版；不可用旧3.5字段或公共ASR地址替代。
- 输入PCM16LE、mono、16kHz；输出PCM16 mono24kHz。WAV只作本地文件容器，送的是PCM base64，不传WAV头。
- 先session.created，再session.update，再匹配session.updated后才可送音。3.8使用output_modalities及嵌套audio.input.turn_detection；speaker_detection阈值固定0.5，不混入旧版静音参数或自定义聊天提示。
- 本方session目标en、text+audio；对方独立session目标zh、text-only。原文ASR始终开且免费，无独立Fun-ASR/Qwen-MT/CosyVoice调用。
- 不把旧三段的JSON历史、tm_list或自定义聊天指令套入新协议。会话内上下文由供应商直接语音模型处理，本原型不假称可控制其内部记忆或通过提示词锁定声线；上下文理解和数字/否定/更正准确性仍需同素材试听。
- 明确请求Tina、enable_voice_clone=false，并验证会话确认。Tina是待试听候选，不证明男性听感或长期稳定；loongandy_v3不适用于本路径。不建克隆音色，不实时声音复刻。文档ACK示例可能省略clone字段；保守检查若拒绝实际回执应报告，不能静默接受启用复刻。
- source转写按item_id和delta更新，completed为全文；译文text-only走response.text，语音模式走response.audio_transcript，音频走response.audio.delta。原文与译文分别保留来源、版本和模态。
- 官方明确同VAD段source.id与assistant译文item.previous_item_id的直接关系。仅本会话已知source+显式边可配对；缺失、冲突或指向译文时不猜，不用语言、相似文本或最近到达项目配对。
- event_id用于去重，不能按相同文字/PCM去重。官方无数字音频chunk序号/offset，WebSocket内按接收顺序处理；本地序号不是供应商序号，不能宣称恢复供应商发送前的任意同item乱序。
- 只response.done.status=completed作为完整响应证据；text/audio.done也可能出现在不完整响应。缺usage留未知，不填0。
- 正常session.finish后保留尾段直到session.finished再关闭。没有找到本模型支持response.cancel/max_output_tokens；原型不发送这些参数。取消先本地fence、停输入/排队，再关闭连接；已生成未播放的音频仍可能计费，关闭不是账单封顶证明。

官方来源：

- <https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime>
- <https://help.aliyun.com/zh/model-studio/live-translator-client-events>
- <https://help.aliyun.com/zh/model-studio/live-translator-server-events>
- <https://help.aliyun.com/zh/model-studio/qwen3-8-livetranslate-flash-realtime>
- <https://help.aliyun.com/zh/model-studio/omni-voice-list>
- <https://help.aliyun.com/zh/model-studio/model-pricing>

协议与独立审查的摘录/核验时间/哈希另存交付证据；不是完整动态网页哈希。

## 双向原型的行为

两个角色各自会话/epoch。只原始输入可append：本方中文直接LiveTranslate→英文音频分片，独立顺序发送到显式sink；对方原始英文先直通耳麦sink、再并行送只文字翻译，不合成中文。合成音频不会进入任何模型输入。尚无Twilio接线/电话采样率转换或真实播放器接入。

字幕复用ConversationEventAdapter及父候选可靠说话块机制；同方原文/译文持续增量更新，换方才新块。原文未到或边未知的译文为辅助未配对内容，不能伪造来源。显示合并不等待整块完成、不阻塞首音频。输出译音的逐字对齐和原始ASR修订之间没有官方版本对应；不得把当前原文版本硬填为已播音频的来源版本，已播内容不能被后文悄改。

官方直接边也没有保证恒定1:1。同一source出现多个translation item时，现有显示适配器不能证明它们是追加还是重译；原型会明确提示多项目限制，保留各项目/真实边/版本及已发声音证据，降为独立未配对显示，不重复原文、不覆盖或漏掉译文。这是当前原型展示适配限制，不能谎称供应商没提供source边，也不宣称已经完成该类生产体验。不同响应音频按已知response创建顺序有界FIFO，前一音频流结束后才移交下一响应；同一响应首片立即可发，不能把跨响应到达交错直接混播。

说话继续或对方插话不会自动取消本方尚未播完的正确译文；对方原音通路不被译音队列等待阻塞。队列有限，容量/顺序/供应商错误明确报错并停止模型输入、清空未发积压、关闭翻译会话，保留错误可见状态；不会无条件吞错或直接调用电话挂断。真实end/owner断开则停止全部输入输出、清理会话与排队。原型未接生产电话；未来接线仍需保留原身份、所有权、无人通话清理和手动挂断，不能以本策略放宽生产保护。

## 接入与本环境只读预检

需要用户在安全环境界面配置：

1. 同一北京业务空间的密钥绑定 `ALIYUN_BEIJING_API_KEY`（只安全输入，不发聊天）。
2. 显式业务空间ID及其精确 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` 域名。
3. 将该精确域名加入网络放行及密钥注入目标。旧 `dashscope.aliyuncs.com` 目标不自动覆盖它；保留代理、TLS和现有策略，不绕过。

本任务预检只读取环境状态/策略、没有连接模型端点：当前状态未报告ready阿里密钥绑定，未提供专属workspace域名且其目标不在放行表，故真实连通性、账户/业务空间权限与模型可用性未确认。没有为探测而发送付费请求，也没改任何配置。Codex环境配置不代表Railway已配置；本轮无需Railway变更。

## 最小对照素材与范围（全部待新批准）

入口使用现有Node与锁定依赖，不需要新增工具。帮助及默认预检都不会读密钥或连接模型：

```bash
node --import tsx scripts/livetranslate-audition.mts --help
node --import tsx scripts/livetranslate-audition.mts --manifest /ABS/PRIVATE/manifest.json
```

从 `docs/livetranslate-audition.manifest.example.json` 在独立资料目录建立manifest；示例刻意不能直接执行，需填写实际workspace及两份用户新批准WAV的SHA256，录音路径相对manifest且不得越界/软链接。不在Git保存审批、真实录音或密钥。可选speechEndMs须是人工标注最后语音样本的毫秒位置；缺失时声学终点到首样本保持未知，不把文件尾伪装为停说。未来实际运行另需 `--run --approval /ABS/PRIVATE/new-approval.json --out /ABS/PRIVATE/NEW-OUTPUT`；本轮未生成生效审批，也未运行该分支。CLI依次处理两方向录音，不代表并发电话或真实播放器已验收。

一次性审批锁只在当前共用Git目录内有效，不是供应商账户的跨机器全局锁；已消费审批不能复制到新clone再执行。恢复包不包含任何可复用的生效审批或秘密配置。

建议本方与对方各一个16kHz/mono/PCM16 WAV，实际总长≤24秒、总共最多两个初始会话、0自动重试/重连。服务端自动分段；观察最多6个响应、接收音频观察36秒、整体90秒时停止，是本地暴露/等待约束，不能保证供应商未先生成额外内容或费用硬封顶。参考译文仅验收，不进入模型输入。后续试听必须绑定新素材哈希、专属域名、模型/音色、数据发送同意和明确新金额，旧OpenAI/阿里授权均不复用。

已有 `audition_24k_mono_pcm16.wav`：21.097秒中文、24kHz/mono/PCM16，未为本次LiveTranslate授权，也不符合原型16k输入；未上传、未改原文件。不能假装它已获新供应商/新模型发送同意。需要用户提供16k样本，或另行同意只本地转换为新文件并标注转换及哈希；结合英文后总时长仍须校验。其他历史english命名文件不当作已确认对方人声素材。

最短待录稿（时长以实际文件为准，不自动开启麦克风）：

- 中文：“我想预约水管工。不是十五美元，是五十美元。六月十五日，不是六月五日。”
- 英文：“I'm the plumber. June fifteenth works. Please don't charge the card yet.”

参考结果：中文段应保留plumber、fifteen→fifty及June fifth→fifteenth的否定/更正；英文段应是“我是水管工。六月十五日可以。请暂时不要从这张卡扣款。”不把参考答案硬编码到运行请求。

“对照”只能使用相同音频哈希、同一终点基准和可比阶段的既有三段回执；本轮不重新调用旧三段。录音不同或旧回执缺少同基准时，只并列记录，不宣称优劣或速度提升。

## 现行价格与预算建议

北京公开费率（2026-10-15核验，人民币/百万token）：音频输入40，文字输出100，音频输出160。3.8源语ASR识别结果免费；不额外加独立ASR/MT/TTS费用。新加坡是独立地域和费率，本原型不切换。官方音频估算输入7token/秒、输出12.5token/秒，按模态token最终核算，不把分钟估算再重复加费。

规划例：输入24秒约168音频token=¥0.00672；输出36秒约450音频token=¥0.072；文字译文预留2048token=¥0.2048，合计约¥0.28352。2048为估算预留，不是供应商限制；36秒为计划接收时长，不限制已生成内容。

模型页列最大输出4096token，但未证明它在双模态usage中的合计口径，且无可设置的本次max_output接口。风险算例：6×4096全部按较高音频输出价估约¥3.93216；假设每次重复处理全部24秒音频，6×168输入约¥0.04032，共约¥3.97248。这个假设不能覆盖未明确的隐式历史/文字输入计费和关闭前超额生成，不是保守账单硬上限。

建议下一步另批一次 **人民币5元观察预算**，不默认花完；用户可在试听前缩小素材/方向/响应范围。旧人民币1元只是旧建议，不作为本次授权。若用户要求不可突破的严格账单硬封顶，当前文档及本地限额不足以证明，必须保持不执行并说明。官方未列本模型文字输入费率，若usage出现该项，或缺模态明细，费用待核不能当0，也不套用Omni价格。实际入账仍以供应商账单确认。

## 时序验收与仍未证实项目

离线fake事件只验证流程：重复/迟到/错误/超时/关闭/尾段/清理、独立音轨、字幕更新、顺序播放及未配对保护。实际效果、男性听感、长期音色稳定、准确性、响应延迟、模型账户可用性及实际费用均未试听。

真实试听须分别记录：用户标注最后语音样本终点（若提供）、供应商speech_stopped估计终点、原文final、译文首delta/全文到达、英文首PCM、入队及sink发送开始、队列等待。供应商终点不是声学真值，firstPCM不是实际播放；未接真实播放器时实际播放开始保持null。官方“低至2.3秒”只作宣传能力说明，不能替代本次结果。

本轮最终SHA、实际命令、通过/失败/跳过项目和恢复包以收据为准；不沿用旧测试数量或把离线通过称电话验收。

本轮最终统一结果：npm test为1973项/1968通过/5项Windows条件跳过/0失败或取消；typecheck、build、全部新增TS/脚本/测试ESLint及diff-check通过。client26、duplex24、audition40、真实client假WS的runner E2E2项均包含于该全量；独审重叠次数不相加。独审红测及修复后的绿测、初版日志均保留。没有新UI改动，本轮没有重跑浏览器或Docker，也没有真实供应商、网络音频、耳麦或电话验收。
