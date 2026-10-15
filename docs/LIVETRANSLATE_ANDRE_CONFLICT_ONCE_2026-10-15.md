# Andre单次试听：用户明确批准的窄音色冲突例外

用户批准基于 `29997d6bf545c6d6c28c3563f95b9a84c1ef3ea0` 最小适配、离线验收并固定新提交后，执行一次北京 `qwen3.8-livetranslate-flash-realtime` 中文转英文试听。完整原录音21.097375秒、SHA256 `58419fda20d4b0062e5ede15b289fdd052c3a5b4c789b6e195a22f9fa4f8af1f`；一个会话，最多人民币5元，零重试重连。5元是用户授权预算，不是供应商账单硬封顶。旧授权、旧四枚spent与Tina基准/失败证据保留，本轮独立记录，不补跑。

## 唯一允许的例外

客户端只请求 `session.voice="Andre"`，显式 `enable_voice_clone=false`；不添加Tina请求、回退、其他音色、3.5或外部TTS。仅single-local可信调用显式启用例外，并绑定新的 `livetranslate-single-local-andre-tina-conflict-audition-v1` scope及父提交29997d6。

同一会话对应 `session.updated` 的顶层voice精确Andre、嵌套 `audio.output.voice` 精确Tina，且其他配置全部通过时，可以警告后继续。客户端确认结果confirmedSessions[].voice保留嵌套Tina，不伪填Andre，服务端原始顶层Andre不改写；同时保存requestedVoice/topLevelVoice/voiceConfirmation以及与ACK的sessionId、eventId、接收序号和接收时间绑定的警告。runner仅在同ACK及警告证据匹配时接纳；后续response若带音色，必须与本次已接受的实际回显一致。未启用例外、顶层缺失/异值、嵌套其他值/缺失/异常类型均不获得此豁免。

精确模型、英文、PCM类型/采样率、会话和来源绑定、有限输出及清尾等检查保持。复刻明确true或类型异常仍拒绝；仅缺字段延续此前批准的同ACK警告未知规则，不能写成“实际关闭已确认”。默认client、dual与duplex不获得本例外。回显Tina只是配置观察，无法证明实际听感；输出完整性、是否听起来为男声及有无明显漂移仍须检查实际音频。

## 执行与证据边界

先离线验证上述完整链路、严格模式仍拒绝冲突及其他配置错误仍停止，再固定本地新提交；当前环境、代理/证书/目标域、录音哈希、预算限量及一次性锁核验通过后仅执行该一次会话。不建立额外探测连接。实际出站JSON、脱敏入站原事件、原文/译文、原样PCM封装的英文WAV、时序、分类usage及费用留在独立执行根；无usage记未知，未入账记待核，不以0输入推断0费用。

英文WAV不改变音高、速度或声线。若仍为女声，男声目标未通过，不换音色补跑。首PCM捕获与实际播放开始分开，声学终点/实际播放未测即未知；短录音不证明长通话声线稳定。不安装、不拨号、不接Twilio、不推送、不部署、不改凭据或网络。

完整类型检查仍为原有集成验收缺项，本轮不重新查找或安装编译器。离线结果与真实执行回执分别保存，不将fake回放冒充供应商运行。

## 本轮离线结果

指定7文件174/174测试通过；8份网络阻断guard报告的真实网络尝试合计0。包括完整冲突链路、其他配置拒绝、缺复刻双警告及伪造同ACK证据拒绝，具体场景见独立执行根evidence/ANDRE_CONFLICT_OFFLINE_REPLAY_RESULTS.json及测试日志。默认CLI预检为Andre、新scope/parent、supplierRequests=0且未读取凭据。
