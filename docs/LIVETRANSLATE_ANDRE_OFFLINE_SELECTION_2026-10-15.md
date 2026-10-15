# Andre 单中文离线候选（2026-10-15）

本轮只选择官方支持英文输出的3.8预设男声并做最小离线适配，不建立模型连接，不上传录音，不复用已消费授权。基于已保留的Tina候选 `7a938da8400f76b8178350937b711b17de207131`（包含 `a66fd3f5881f0258ee704988592ea5640a3d0559`），另建独立目录；原版本、录音、历史失败、Tina输出及四枚spent锁不改。

## 选择及官方依据

选择安德雷，准确ID **`Andre`**。官方[音色页的LiveTranslate专节](https://help.aliyun.com/zh/model-studio/omni-voice-list)将“3.8 / 3.5实时”明确映射到 `qwen3.8-livetranslate-flash-realtime` 等型号；Andre同行标注“声音磁性，自然舒服、沉稳男生”，适用“3.8 / 3.5实时”，支持“中文（普通话）＋28种外语”，该节语言表含英语。[英文版同节](https://help.aliyun.com/en/model-studio/omni-voice-list)写明“Magnetic, natural, and steady male voice”。据文字描述选其用于商务电话候选，未进行多音色调用或听感比较。

该页同时包含其他模型章节，以上依据只取LiveTranslate专节，不套用Omni或CosyVoice音色列表。公开文档工具返回、原样关键行和完整官方示例保存于独立根的 `evidence/OFFICIAL_38_PRESET_VOICE_RESEARCH_20261015.json` 及 `OFFICIAL_PUBLIC_DOCUMENT_TOOL_RESPONSES.json`；工具查询日期为2026-10-15，页面精确修订时间未知。

## 请求字段、回显及仍存缺口

[LiveTranslate客户端参考](https://help.aliyun.com/zh/model-studio/live-translator-client-events)的 `session.update` 参数表说明：未启用声音复刻时，`voice` 可设置系统预设音色，并明确3.8与3.5默认Tina。因此本候选按该协议发送 **`session.voice="Andre"`**、**`session.enable_voice_clone=false`**、`session.translation.language="en"`，保持原输入16kHz与输出24kHz单声道PCM16配置；不加入参考译文或语料。

同页精确3.8完整示例包含 `session.voice="default"`、`enable_voice_clone=true`，属于复刻场景。没有找到“精确3.8＋固定预设男声＋clone=false”的完整官方请求示例，也没有找到LiveTranslate将 `session.audio.output.voice` 指定为请求setter的明确说明。Omni客户端参考的嵌套setter及字段优先级不移植至此。

[3.8使用说明](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)及[服务端事件参考](https://help.aliyun.com/zh/model-studio/live-translator-server-events)指向 `session.updated.session.audio.output.voice` 作为实际输出配置的回显路径。历史同一会话的更新确认曾出现顶层 `voice="Aiden"`，但 `audio.output.voice="Tina"`；这是配置冲突证据，不能推断Aiden必然不受支持，也不能以更换Andre证明setter已生效。有效请求字段及冲突响应含义仍可向供应商确认。

只在同一会话收到对应更新成功确认、精确模型/英文/PCM格式/实际输出voice均匹配Andre后才允许发送。仅缺复刻字段可按此前批准策略警告继续，观测值保持未知；存在时必须为boolean false，true或类型异常仍停止。输出Tina或任何其他voice仍拒绝；顶层Andre不能替代嵌套输出字段确认。

## 最小改动与离线验证

- 仅single-local选择Andre，独立授权scope `livetranslate-single-local-andre-audition-v1`，父版本绑定7a938；拒绝旧Tina/Aiden授权。默认client、dual、duplex继续原Aiden，原显式Tina能力及关闭复刻策略保留。
- 使用真实历史Aiden/Tina冲突的两帧脱敏入站fixture；其源文件哈希和“历史出站未捕获”明确记录。Andre/Tina冲突另标人工构造，不将本次fake发送冒充历史请求。两者在发送录音前停止。
- 指定7文件170项离线回归在网络阻断guard下通过；统一测试未另存guard计数文件，默认CLI预检另存计数为0；覆盖请求绑定、完整链路、配置拒绝、通知/错误、缺字段、voice回落与清尾。单输出/index=0仍为本地范围。完整TypeScript类型检查继续为既有集成验收缺项，本轮未重复查找或安装编译器。
- 默认CLI预检不加 `--run`。原录音SHA256保持 `58419fda20d4b0062e5ede15b289fdd052c3a5b4c789b6e195a22f9fa4f8af1f`，完整21.097375秒。原一会话、24秒输入、6响应、36秒输出、90秒总限时、零重试重连不变；这些是本地限制，不是平台账单硬封顶。

## 后续验收

本轮无真实调用或新执行授权文件。未来单次试听须另有当次数据发送和费用授权，不能使用旧锁/旧授权补跑。服务端输出voice确认只是辅助证据；最终须获得完整英文译音并实际听完，确认听起来是男声且无明显漂移。当前Andre实际接受、实际男声听感及稳定性均未验证；Tina旧输出不能作为本次男声成功交付。短试听不代表长通话验收。
