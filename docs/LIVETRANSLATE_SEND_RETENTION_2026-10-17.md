# 诊断日志留存补证（仅离线，不修复停译）

以2a9b20553d0bcbdac86c0de90b1d4262a6fc22a6为唯一增量基准。只改诊断collector/投射及必要测试和说明；没有发送泵、client、manager、模型3.8/Andre、字幕、播放或双向停止的业务修改。64000B、1MiB、2秒保护原样保留，不混入容量补丁或重连。第257响应限制及真实发送停滞底因仍未知/未修复。

## 发现与修正

2a9离线提取的原代码复现：合法正文32689B，加入通话关联等外壳后，最终sink收到0行，无丢弃回执。原4warning+terminal+late不会直接挤掉终态；实际缺口是超长整批丢弃、首次send_failed后缺少独立close快照和失败/裁剪口径不足。坏诊断时钟可污染后续ring的合成测试也发现确定诊断缺陷，已只在诊断采样层丢弃非法样本并计数，不改变业务计时。

现行每方向最多6个尝试窗口，按类别独立留位：

| 类别 | 上限 | 关键内容 |
| --- | --- | --- |
| 积压预警 | 3 | 原触发条件16000B或500ms、至少间隔1000ms；额度耗尽只抑制诊断 |
| 首次发送泵失败 | 1 | 实际send_failed与最后一个此前raw_callback固定锚点 |
| 终态 | 1 | 首次正常结束/取消/关闭；可在send_failed后独立记录关闭快照 |
| 首次迟到回调 | 1 | 明确afterStop，不能将迟到错误当新业务fatal |

首失败指发送泵send_failed，不代表整条翻译链所有致命错误。比如transport_close先触发client协议失败时，关闭窗口及既有protocol_failure日志共同关联，firstFailure可合法为null。precedingRawCallback只是此前上下文，不一定是失败帧，不能当因果或供应商ACK。

## 三层留存预算与计数

1. ring最多256条固定scalar元数据；真实覆盖时overwrittenRecords递增，清ring后的新快照不虚增覆盖数。
2. 窗口选择最近24条context，未选入的ring历史记windowContextOmittedRecords。它仍可能在ring内，不等于物理丢失，不能与覆盖计数简单相加成唯一事件数。
3. 每批最终完整JSON含callId/role/event/message外壳最多32768B。超长仅删除最老context，保留最新记录和firstFailure固定2锚点，不截断单个字段。windowTruncatedRecords记录本窗口各层字节裁剪条数；truncatedRecords仅为collector生产者累计字节裁剪，phone层额外裁剪不会被假装反馈为后续producer累计。

6×32768=192KiB/方向，双向最多384KiB新增send_window JSON；换行和既有input/protocol_failure/cleanup等其他日志另计。每次失败投射/输出也消耗自身尝试槽，不自动重试或补写。窗口数是应用尝试次数，非平台留存数量。

suppressedWindows为截至观测点已知的预警/窗口抑制数；suppressedRecords为已知采样丢弃或终态后未保留的调用数；projectionRejectedWindows记录collector拟输出窗口未通过严格投射/编码的次数；sinkErrorWindows只知collector直接onDiagnostic抛错。白名单无自由文本、音频、原译文、头或密钥，观测不可得仍为null，不填0。

summary的lifetime计数/peaks在交付微任务前统一刷新到observedThroughRecordSequence；emittedWindows仍是此批次尝试序号，windowContextOmittedRecords/windowTruncatedRecords属于本窗口。records及外层at仍保留实际触发/采样时间，不能把刷新后的计数推算成触发瞬间数值。

captureEnded=true表明常规ring已结束；futureSuppressedRecords固定null，表示当前已输出窗口无法知道未来无限迟到尾部。后续已知抑制在固定状态/snapshot中O(1)更新，不扩日志预算；没有下一窗口时不能声称这些新增计数已经到达Railway。最后一行不是“未来0丢弃”的证明。

## 内存与失败隔离

ring256条、每批至多24 context，另有固定2条失败/前raw锚点供后续终态/迟到窗口共享。终态清ring、停Node监控；固定锚点和既有回调闭包可能到GC才释放，不承诺瞬时0内存。没有新增音频缓存、应用层定时器、Map或重试/重连；裁剪循环最多24条，且只发生于有界输出微任务。合法正常尺寸无需phone再次fit。

fit先严格scalar投射，不读取getter或携带任意未知字段；MAX_SAFE计数溢出拒绝，不放宽32KiB。无效采样不能污染ring，观测失败不冒充0。输出/日志异常仅影响诊断，不进入发送/翻译/清理决定。

## 应用生成、sink返回、平台保存是三件事

最终formatter添加固定message，符合Railway结构化JSON文档要求；不含通话正文。直接调用可取得安全回执：generatedRows、sinkReturnedRows、discardedWindows以及railwayStored:null。sink只调用一次；抛错不重试、不影响电话。

该回执只对直接调用者可见。既有EventEmitter/client/bridge不将最终logger回执回传到collector，故producer的sinkErrorWindows不等于console或Railway失败总数。若整个输出通道不可用，应用不能保证把“日志丢了”的自证也持久化；本候选没有为此增加第二输出通道或业务反馈。

本轮既有授权Railway docs只读证据：stdout/stderr捕获；JSON需单行且message为required；每副本500行/秒，超出可丢并告警；Hobby留存7天。官方已读页面未确认单行字节上限，32KiB只是应用上限。get_logs每流最大500条、无cursor，查询截断/工具输出截断不能直接当平台丢失。

后续另获发布与一次实测授权后，必须核对：每callId/role窗口序号、完整单行能否取回和JSON解析、最大行字节/锚点完整性、采集告警、查询是否命中500条上限、应用epoch与平台timestamp。缺失时按时间/方向分窗只读查询，保留证据并停止补拨；没有实测就保持未验证。本轮未向线上生成探测日志、未发布或拨号。

## 本轮验证及推送关口

本轮只重跑受影响5文件64项留存/桥接/终态专项，全部通过、无跳过；独立最终5个窄探针通过；完整typecheck/build、2个变更源码lint和diff检查通过。所有中间core失败及root首轮4项consistent-return lint错误均保留；仅显式return undefined修复原返回路径，未放宽规则。完整命令/每轮成绩以本轮回执为准。预警耗尽后的发送泵模拟案例保留了pending_input_limit首因、64000B、Sender87000B/Writable91100B、ws178100B、压缩true、连续确认125/缺口126/后帧1和最老帧50ms；此前raw127不是失败帧。独审合法32743B正文加外壳时裁1条旧context，最终31619B且锚点/最新记录原样。正常结束、取消后迟到、预算耗尽和非法字段仍有针对性覆盖。

旧2a9全量/七组浏览器/18机制和开销可作已完成背景，不冒充本增量新结果；不再重复整轮。

下一步拟用未占用的新分支codex/cloud-phone-conversation-send-diagnostics-ci-20261017。当前AI确实订阅旧input-send分支并固定0746；新分支匹配既有离线CI且没有部署入口/PR。本轮只读看到AI仍运行0746/bbc62689，无staging补丁，未修改平台。

推送安全尚缺两服务Source的明确证据：Auto Website Builder/production的portal与factory-web，现有接口未返回source，也未规定省略表示未连接。需要页面只读核对Disconnected或实际仓库与触发分支；不能将SLEEPING当无自动部署。未补齐前不执行push、不改开关。具体页面/记录见本轮platform报告。用户本轮只批准离线补证，下一轮仍须另行确认最终精确SHA的一次非强推，不推tag/PR/merge或触发发布。
