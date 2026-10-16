# 独立实现审查（最终修正复核）

基线 `e31ceb45d515c6fd93c8baff2761aec7949f18a8`；检查本轮工作树差异，排除既有PROGRESS资料与node_modules。15个实现/测试/fixture输入SHA256见同名JSON；候选提交仍待主代理固定。

**结论：两项已报告P2均已修复并由原探针独立复核；本轮范围未发现剩余可行动阻断。** 这不等于真实通话根因已确认或声音已验收。

## 发现、修复及保留证据

1. **迟到成功回调越过2秒期限。** 原send-pump回调未校验总接受年龄；在due timer未派发时，3秒成功回调曾得到written640且无failure。现`src/experiments/livetranslate-send-pump.ts:242–246`先校验接受年龄，再计入written。原探针代码不变重跑，得到`oldest_send_timeout / written0 / stoppedtrue / timers0`。新增1999／2000／3000ms与late callback error优先回归已读核。
2. **诊断观察器异常替换transport首因。** 原client在send_failed观察回调抛异常时先报CALLBACK_FAILED，覆盖后续原SEND_UNAVAILABLE。现`src/experiments/livetranslate-client.ts:646–652`隔离观察器异常。原探针不变重跑，保留`SEND_UNAVAILABLE`；新增健康写继续与失败首因回归已读核。

`IMPLEMENTATION_REVIEW_REDFINDINGS_SNAPSHOT.*`及两个原始RED输出保留；GREEN输出分文件保存，未覆盖原证据。这两项是人工调度的正确性探针，不能据此认定实通事故同因。

## 其他路径核验

- phone-only FIFO单次发送、最多一个in-flight；pending PCM含in-flight共64000bytes、wire及旧transport阈值1MiB；最老2秒期限不被新帧重置。无重试、重连或供应商回退。
- finish排在已接受音频后，后续append拒绝；停止围栏先于清理，迟到或重复callback不能恢复发送。close观察与原始failure分开。
- `client.ts:932–1064`按每方向可靠VAD源偏移及稳定序号排序，保持当前源增量出音；已到达的后源译文/PCM阻塞才计5秒。合法空response不猜归属，也不替代前源缺失译文；非空本方译文缺音频仍明确报错；晚到新旧源输出显式停译，完成重复不重播。
- `phone-bridge.ts:163–204`单侧失败停两模型、清译音，不结束电话；remote原音及用户/对端挂断清理保留。定向fake生命周期验证原音不被模型发送等待阻塞、停译后仍可听、手动及真实媒体stop清理两腿。
- 新reason/state/type/basis与计数经固定枚举及数值白名单；没有原始异常、正文、音频、凭据、号码或provider ID透传。written只表示本地回调；provider endpoint仍是估计；actualPlaybackStartAt不冒充耳端播放。
- 新真实事件fixture逐字段对照封存原件：30生命周期＋10offset＋3关键事件＋2峰值投影吻合；终止的stage为固定fixture标签，at映射原observedAtMs。它只重放应用诊断元数据，未伪造供应商帧、音频或原ASR。

## 独立执行

- 修复前新增三组定向回归：40/40，0失败/跳过（`targeted-regressions.log`）。
- 修复后受影响send-pump＋client：62/62，0失败/跳过（`affected-regressions-green.log`）。
- 两个原探针代码未改，分别RED→GREEN。以上两次测试有重叠，不能相加成102项独立测试。未运行全仓或浏览器；主代理全量成绩单独绑定。

未联网、调用平台/模型/电话、读取凭据、安装或编辑实现。诊断子审查另存`DIAGNOSTIC_IMPLEMENTATION_SUBREVIEW.json`（只读未执行测试，其早期文件hash与本报告最终hash分别保留）。

仍待真实验证：旧SEND_UNAVAILABLE确切分支、跨方向真实声学/耳端顺序、重复中文来源、真实音频质量与稳定性。供应商无“源未来所有响应已完”水位，后到新旧源可能按明确策略停译；256身份窗口限制未改变。

## 最终样式哈希补录

最后三文件仅有6条精准lint注释与2处import空行差异。独立在内存反向撤销这些确切差异后，三文件SHA256全部恢复到上一版审查输入；其余12输入逐字节未变，因此确认无控制流或数据改变。详见`FINAL_STYLE_BINDING.json`；同名JSON已绑定当前15输入最终哈希。未重复执行测试；主代理后续全量/浏览器结果由其单独报告，不算本独审重新执行。
