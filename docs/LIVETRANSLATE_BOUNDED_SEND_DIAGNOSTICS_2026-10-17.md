# 有界发送诊断候选：仅增强诊断，尚未修复真实停译

基准0746dc1fb3d57b6302dd4d7358c6a2b5230847c7。已认可的模型3.8、Andre、复刻关闭、输入PCM、字幕、原声直达、输出播放和双向停止策略不变；64000B、1MiB及2秒保护不变。原0746工作区、cf62及此前失败证据保留；本轮只有离线开发和本地候选，没有安装、推送、部署、变量/凭据/网络变更、拨号或模型调用。

## 为什么需要这些字段

真实callId 9af3a0fd-0670-4211-9249-49b6479e884e（部署bbc62689-a747-4d41-9a6b-741bd2fd91a9）的remote首先发生pending_input_limit：待确认PCM64000B、正文90300B、ws bufferedAmount91100B。local无积压随后被现有全局策略取消，电话媒体26.017秒后才停止。0746并行发送已生效，启动积压曾清零；底层停滞原因仍未知。

ws8.18.0的bufferedAmount是Sender字节与Node Writable字节之和，旧日志没有拆分，send_written也仅在连续成功前缀释放时发出。它们不是供应商接收确认。新诊断只为下次明确区分回调缺口、Sender/压缩停滞和Writable/下层写进度停滞，不选择传输修复。

原保护逐字保留：64000B限制已受理但尚未连续确认释放的PCM，包含应用队列和已send但回调前缀未完成的数据；1MiB分别用于原未确认JSON正文字节准入和ws.bufferedAmount发送等待判断，二者不是同一个计数；2秒从最老受理帧计时，包含排队和回调等待。诊断预警阈值不替换这些保护，也不将成功回调提升为供应商ACK。

## 输出契约与时间

新日志仍使用既有CLOUD_LIVETRANSLATE_DIAGNOSTIC事件，stage为send_window，sendDiagnostic承载固定schemaVersion=1批次。callId来自manager可信通话闭包，role来自桥接绑定；不是依据语言、供应商正文或回调自报身份判断。批内记录共同继承外层callId/role/connectionOrdinal，展开记录时须携带这些公共关联。

| 字段 | 精确含义 |
| --- | --- |
| connectionOrdinal=1 | 当前每通每方向仅一个连接；本候选不重连或重建会话。与callId、role合用，不能单独作为全局身份。 |
| recordSequence / sendSequence | 本诊断记录序号 / 原发送泵发送序号；不等于供应商event ID。 |
| at / monotonicAtMs | 应用采样epoch毫秒 / 进程单调毫秒。平台日志采集时间另存，不能替代应用事件时间。 |
| callbackAt / callbackMonotonicAtMs | 原始ws回调入口的应用/单调时间，可能早于元数据采样时刻；非callback记录为null。 |
| callbackDisposition、callbackDuplicate、callbackAfterStop | 原始回调首次/重复/迟到分类及独立重复、停止后标志，后两者可以同时为true。重复和停止后回调不推进业务确认。 |
| callbackError / callbackErrorCode | 是否错误及极小固定错误码枚举（其他归other）；不记录Error对象、message、stack或任意code文本。 |
| callbackDurationMs | 本地send调用到本地回调观测的耗时；不是网络RTT、供应商接收/识别/消费耗时。 |
| contiguousWrittenSequence | 已按原逻辑释放的连续成功回调前缀序号；不越过失败、缺失或未确认帧。 |
| firstUnconfirmedSequence / prefixGapSequence | 最老尚未连续确认的受理帧；以及有成功后帧被挡时的前缀缺口。无对应对象时null。 |
| completedBehindGapFrames | 原错误/截止检查通过、已成功回调却等待连续前缀释放的帧数；失败、重复、迟到不重复计入。独立只读计数，不参与准入/超时。 |
| oldestUnfinishedAgeMs | **最老尚未连续确认/释放的受理帧年龄**，与原2秒保护的最老对象对应；不是最老尚未到达raw callback的年龄。回调已到但尚未drain时仍可有年龄，完全无未确认帧时null。 |
| queuedFrames / inFlightFrames | 原应用队列与原在途对象数；不为诊断新增音频队列。 |
| accepted/written/pendingAudioBytes | 原受理、连续成功前缀确认、尚未连续确认的PCM计数；不当作供应商ACK。 |
| pendingWireBytes | 尚未连续确认的序列化JSON正文字节，不含WebSocket帧头，不代表TCP字节。 |
| webSocketBufferedBytes | ws公开bufferedAmount合计。不可读取或非法时null。 |
| senderBufferedBytes | ws Sender内部待发送/压缩工作计数，不含供应商消费。不可读取为null。 |
| writableBufferedBytes | Node socket Writable计数；不是内核TCP队列。不可读取为null。 |
| perMessageDeflate | 已OPEN时可观测的实际扩展协商结果；未打开且无已知缓存、字段缺失/不可读为null。默认申请压缩不代表已协商。 |
| eventLoopSampleCount / MeanMs / MaxMs | Node monitorEventLoopDelay直方图的样本数和毫秒统计。20ms分辨率有采样基线；0样本时mean/max为null，不伪造0，不等于额外20ms阻塞。 |
| summary.monitorStopped | 监控停止结果；成功true、活动false，disable失败等不可确认时null。不会因监控异常跳过电话清理。 |

normal_end使用明确diagnostic_end快照，不伪造send_written。cancelled仅说明本地abort，不证明是用户主动挂断；transport_closed也不能直接当作首次异常。

summary的rawCallbackCount/error/duplicate/late等是**诊断实际记录范围内**的计数，不能声称终态后所有回调的总量；终态后至多保留首个迟到窗口。emittedWindows是尝试输出批次序号，不证明已被日志平台采集。

## 有界、低开销和清理

- 每连接最多256条固定元数据环形记录，输出最多24条近期记录及摘要。没有wire字符串、PCM、原译文、provider标识、认证头、URL、号码或凭据引用。
- 预警仅为诊断：pendingPCM至少16000B或最老未确认年龄至少500ms，至少间隔1000ms、每连接最多4次。它不触发挂断、丢帧或新增保护。
- 最多4预警+1终态+1迟到批次，每批最终完整JSON行含event/callId/role外壳最多32768B。每方向新增send_window最多6行/192KiB，两方向最多12行/384KiB，换行另计。原有input/playback和简短failed/cancelled/closed日志不在这个新增日志预算内，未顺带重构。
- project/serialize/sink延后到有界microtask，不在原回调截止判断之前执行重日志。诊断状态计算用常数时间计数及已知item，不新增扫描在途列表；原业务includes/队列逻辑保留。
- 终态清空环形记录、停止event-loop监控；没有新增应用层setTimeout/setInterval，只有Node直方图的20ms监控采样。最多6个已排微任务各保留不超过24条元数据引用，执行后释放。仍可有固定256槽数组随既有回调闭包存活至GC，不宣称终态瞬时零内存。
- 字段读取、监控初始化/disable、投射、序列化和sink异常均隔离。缺失或不可读字段为null；不会为了取得数据改变发送、超时或全局清理。
- 长通话预警配额耗尽后仍保留终态窗口，但不会保留无限历史。环覆盖数和记录序号说明观测范围；不能用这个窗口宣称看到了所有原始供应商事件。

正常挂断原先先标session.ended，再关闭桥接，旧liveAdmission日志gate会挡终态。因此本候选只在现有诊断回调中允许经严格schema校验的终态/迟到窗口关联原callId。原业务admission、call/caption状态、SSE白名单及所有旧事件gate不变；translation-live不在受保护电话SSE转发白名单中。旧会话窗口不会变成新通话的事件。

## 验证及证据绑定

专项覆盖乱序/重复/缺失/错误回调、未知私有字段/throw getter、最老确认前沿年龄、窗口及字节上界、ring覆盖、monitor失败、正常结束/重复结束/迟到和最终日志投射。保留完整首轮错误及必要修正，不通过删除业务断言或盲目重跑取得通过。

复用既有18种机制的同一事件计划，对照0746与候选完整发送内容/顺序、原onObservation、确认前缀、失败位置及终止行为；另用实际localhost ws8.18.0分别检查604ms回调延迟、Sender暂停、Writable暂停。虚拟时钟与真实连接结果分开，不把人工机制说成实通根因。正常路径不得有无法解释的业务差异。

额外内存、日志字节及CPU微基准的全部轮次、最终源码哈希和计量限制保存在本轮独立审计目录/workspace/ai-phone-reference/livetranslate-send-diagnostics-candidate-20261017。微基准不是Railway/真实stdout/供应商链路延迟；最终候选版本与实测数值以本轮回执和comparison报告为准。

最终冻结源码的18/18机制对照、3/3真实localhost连接机制及独立9/9探针通过。三类观测分别为：回调延迟约604ms但peer仍收到120/120帧，Sender/Writable为0/0；Sender停滞时90300/0；Writable停滞时0/91100。它们验证新字段能区分人工注入的机制，不证明真实通话属于其中哪类。

20,000帧、5轮交替微基准的每帧wall中位数为0746的1.288μs、候选5.395μs，新增4.108μs。40个泵、每泵100个未确认帧和200条ring记录的3轮隔离进程测试，JS heap中位数约34,963B→118,853B，增加83,890B（约82KiB/方向）；RSS还受原生监控、分配器和GC影响，均不是硬内存上界。正常20,000帧期间零新增窗口日志，结束输出一批约21KB；人工停滞连接各输出4批、约66—89KB。监控和ring在清理后分别停止和归零，残余GC波动单独报告。

完整typecheck、build、8个变更源码文件的ESLint和git diff --check通过。完整离线测试首轮2296通过/1失败/5跳过：新工作目录尚未运行既有prepare:desktop，导致/vendor/twilio.min.js返回404。保留原日志后，仅运行这个离线复制脚本，核对锁定SDK源/目标SHA256相同；无安装、源码或断言改动。第二轮完整测试2297通过/0失败/5项Windows条件跳过。七组浏览器首轮顺序43/107/123/120/29/50/84共556检查全部通过，外部请求0、exceptions为空；22个public JS语法检查通过。新GitHub CI及Docker未执行。精确候选SHA另见交付回执。

## 后续一次实测的取证与停止清单（本轮不执行）

先另行确认精确候选推送、CI、指定AI staging发布；上线必须核对真实commitHash、构建镜像和运行状态，不能只看source pin。随后再确认本人接听目标、一次通话的数据发送及新金额预算；旧试听授权不能复用。本轮未核费率或批准任何实通。

建议批准后仅一通2—3分钟：双向完整翻译、持续说话、静音后恢复、最后手动挂断。保留callId/方向/连接序号、实际版本、开始结束时间和应用/采集两套时间；收集原始回调及错误、连续前沿/缺口、最老帧年龄、Sender/Writable/ws三项缓冲、实际压缩结果、event-loop样本及第一条终态窗口。

- 任一方向首次停译、发送保护失败、明显持续积压且不恢复、页面状态与实际不符、原声断开或清理异常时，停止本次测试，由用户手动挂断并核对两腿/模型清理。达到获批时长/预算观察线同样停止；费用不是硬封顶。
- 不自动补拨、重连或重放，不为凑齐字段反复试打。取不到的字段保持未知。
- 仅回调缺口且底层缓冲0、Sender独占增长、Writable增长分别形成不同后续调查分支；任何单个值均不等同供应商故障或TCP拥塞。

本候选**仅增强诊断，尚未修复真实停译**。第257响应限制原样保留，健康方向隔离未实施，长通话稳定性及真实日志输出开销仍未验收。
