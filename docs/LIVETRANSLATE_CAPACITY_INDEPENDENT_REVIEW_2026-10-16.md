# 容量压缩冻结实现：独立审查

父提交 `cf62d18eb8dc371f294c8c08f03d2472992e5d4a`。冻结client SHA256 `97a1f8a4cada61da1a4d29cd97e01758dbcb331fe6f30938bb850079651f2ec1`；types `61c60971f05a457fbb5bcd9e14b8e8a9ba22949b82663b7859dde529b83ba1c5`。开始和独立探针后哈希均吻合。业务仅这两文件，333行新增/15行删除；测试/helper/新技术文档亦已静态审阅并在同名JSON绑定哈希。

**结论：本轮冻结范围未发现剩余阻断问题。** 这是离线实现审查，不是实通、声音、时延或费用验收。主代理全量成绩和本独审执行分别记录，不合计重叠测试。

## 逐项结论

- 单client跨来源最多32成熟重响应。成熟必须完成且已发布，只有一个明确准入的输出，无持有PCM、排序/锚点/未知绑定或pendingUsage依赖。closed记录只保留ID、source起点和空audio/单slot父状态，没有正文/PCM。原256 active保护不被回收未完成对象绕过。
- closed与旧terminal共同1024，输入待插入keys从eviction候选排除，整源迁移保持计数、逐键预留，避免批次旧键逐出后重新插入导致超额。active/grace来源和floor未严格越过start的zero-duration身份保持pin；没有安全可回收项时明确TERMINAL_CAPACITY，不暗丢身份。
- typed ledger没有进入旧bool terminal的previous-owner过滤。新input普通前驱可指向closed output；closed自身角色复用、跨source/response/slot写入仍失败，匹配迟到重复不重新发声或发布。无文字相似度去重、无按语言改说话方。
- 4096 event摘要仍在closed正路径之前校验；压缩不提前清未完成来源digest。整source证明完成时释放包含closed keys的原摘要，预算耗尽仍明确失败。closed response轻量父状态保留created/done原voice/config/status等校验顺序。
- source完成摘要合并到order/finish/退休；空闭合输出不证明后来非空原文已翻译。usage有pending则不成熟；准入后按旧顺序/规范发布一次，closed duplicate done不补记未知或重复发布。
- cleanup清ledger、summary、usage、计数和等待。新增快照只含计数，未新增正文/秘密日志。发送泵、模型、Andre、请求内容、分段、格式、2/4B PCM、publishAudio/电话packet/mark及microtask seal未改。

## 独立执行与所有尝试

只运行4个自编合成事件探针，使用已有fake socket与既有外网守卫，没有运行全量或作者整组测试：

1. 明确构造response.done先于VAD导致非空pendingUsage；VAD迟到后只发布一次，随后41完成触发压缩，duplicate done不二次发布。
2. 同一非空pendingUsage及持有输出状态abort后，迟到VAD/done不发音、不发布usage、不新增wire；active/closed/summary/digest清零。
3. 544个完成响应占满1024 pin，zero-duration同offset来源退休不能释pin；明确TERMINAL_CAPACITY，失败前预算仍1024，cleanup后0。
4. 尚未final的source下，closed响应原event ID换payload仍EVENT_CONFLICT，没有音频重播。

最终4/4通过。首attempt仅因审计目录不能解析`ws`依赖在候选场景启动前退出；已完整保留。只将审计探针import指向项目现有依赖，第二attempt通过；未安装、改业务或删断言。两个进程外网守卫均externalNetworkAttempts=0（允许的本地调用各4，为tsx运行机制）。原脚本、两次stdout/stderr及哈希在同名JSON。

完成/usage子审查只读未实跑；其发现的“作者abort没有直接构造非空pendingUsage”覆盖限制，由上述探针1/2补足。主代理另报33容量、17差分、4跨层及2339总项/2334通过/5Windows跳过和7浏览器；这些没有被冒充本独审重跑。

## 一项非阻塞的异常流政策区别

对已压缩并done的旧response，若新event ID突然使用另一个output item ID占用slot0，新typed分支显式报response_slot_rebound。cf62保留done父对象时在slot检查前直接return，会忽略这类迟到不一致。该差别是安全收紧，不是既有合法流的音频/译文调度变化；不能宣传“每一种错误流也完全相同”。无须为保持旧忽略行为撤销新保护。

## 文档与剩余边界

新技术文档正确区分synthetic与真实5帧配置前缀、无真实257事故帧、逻辑保留计数与heap/耳端播放、545次fixture音频已交付后回收失败，以及事件密集时4096可能先耗尽。没有把新增观测当历史故障根因；withdraw未知不被本地忽略规则证明。

预算依然有限；没有真实通话/音频、男性听感、实际延迟或费用核验。历史SEND_UNAVAILABLE具体原因、约20秒offset差及回声/来源症状仍未知。未改极短PCM问题；任意无限迟到ID的永久识别不可能由有限记录保证。后续候选提交与最终文档若变化，需追加哈希绑定；本报告不批准推送或发布。
