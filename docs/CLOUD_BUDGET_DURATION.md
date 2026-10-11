# 云电话预算驱动时长：开发实现与运行门槛

**已被取代**：用户于2026-10-11 12:58:08 UTC取消应用内五美元预算。个人phone已解绑本文费用证据、预留、journal和派生时长；本文只保留此前实现记录，不能用作当前前置。最新见 [个人云通话](CLOUD_PERSONAL_NO_BUDGET.md)。

2026-10-11：取消云 continuous-captions 路径固定300秒上限的开发修正已经完成；未发布、未拨号、未调用付费模型、未写任何云变量。用户仍只授权一通、Twilio与OpenAI合计最多5美元。实际费用证据仍不完整，不能据合成测试开启电话。原网页部署与电话关闭状态保持，发布结果单独见 [运行记录](CLOUD_RELEASE_RESULT_2026-10-11.md)。本机Pocket模式不在此次调整范围。

## 统一策略与推导

新增 `cloud-call-cost-bound.ts`，要求私有 `CLOUD_CALL_COST_BOUND_JSON` 提供经人工核实的完整最坏责任上界。没有默认价格、默认时长或在线探测；布尔确认仍须保留，但仅有确认旗标已不足以启动phone。JSON格式、身份绑定、必需费用行、非负整数及有效期均严格校验，失败只返回固定代码，不回显私有内容。

每个费用行必须有 `fixedUsdMicros`、`perSecondUsdMicros` 和指向证据的HTTPS `evidenceUrl`。两项金额都以整数microUSD表示，约定在证据允许的整个时长区间内，该行所有费用不超过 `fixed + perSecond × D`。固定部分须覆盖建立、最小收费、进位、重复上下文、全部自动ASR/VAD生成、未知创建/终止结果与在途责任中不能随D简单线性计入的费用。它是外部审阅的上界声明，**软件无法从URL、字段齐全或全true旗标证明供应商实际收费有界**；未知费用不能填写0。

令R为本通已授权预留（严格大于2000000、不超过5000000），F和r为各行固定费用与每秒费用之和，C为清理余量秒数，T为服务截止和费率有效截止中的较早者：

```text
admissionDeadline = T - C × 1000
D = min(floor((R - F) / r), evidence.maxSeconds,
        floor((admissionDeadline - rates.checkedAt) / 1000))
callDeadline = min(reservationTime + D × 1000, admissionDeadline)
```

使用BigInt求和和除法，拒绝未知项、负数、小数、溢出、零总费率、无法承受1秒或已过期窗口。D不随重启重新计算成新窗口；较晚准入只缩短剩余时间。既有单次服务窗口最多一小时仍保留，证据的maxSeconds和cleanupSeconds各为1–3600整数，不新增长期服务授权。清理时间不是允许无限清理费用：对应金额仍须由完整责任行覆盖；若无法覆盖未知终止时间，证据不成立，仍禁拨。

六处统一消费同一策略：

- `cloud-service-config.ts`：推导D和媒体额度，保留单通、总额5美元及所有原确认门槛。
- `cloud-budget-journal.ts`：持久预留、绝对截止、费用有效期和媒体额度一致；scope纳入完整证据摘要、策略版本和启用的会话模式。
- `session-manager.ts`：两条Twilio腿均从journal剩余绝对期限向下取整；不足1秒拒绝，不向上补1秒；建立和接听不重置原截止计时器。
- `cloud-call-usage.ts`：每路PCM16/24k额度 `48000 × D`，回程PCMU/8k额度 `8000 × D`，真实send处包括补零和drain。
- `cloud-service.ts`：装配相同D，禁止无费用边界、字幕模式不匹配或越过服务截止的配置。
- `cloud-index.ts`：配置检查展示推导出的秒数。

journal聚合输入额度为 `PCM × (出程配对启用 ? 3 : 2) + 2 × PCMU`，聚合输出为 `PCM + PCMU`；每个实际供应商流仍独立受限。文字最多60次、450000输入代理、72000输出预留、每次1200输出限制均不随D增加。字节与固定2美元工程预留仍只是应用保护；snapshot继续标记 `billed:false`、`costBoundVerified:false`，不能拿字节当账单。

## 私有证据格式

顶层字段必须精确为下表；不在仓库提供可复制成真实费率的示例值。

| 字段 | 必需内容 |
| --- | --- |
| version / basis | `1` / `complete-liability-upper-bound` |
| usagePolicy | `continuous-captions-usage-v2`，绑定当前模型/会话与文字限制；这些限制将来改变时须更新版本 |
| accountSid / applicationSid | 必须与现有运行账号和指定App精确相等 |
| targetSha256 | 私有目标E.164字符串的SHA-256，与现有配置精确相等；哈希也不写公开交接 |
| outgoingPairedCaptions | 与运行开关精确相等 |
| maxSeconds / cleanupSeconds | 完整证据覆盖的有限时长区间与已核实的清理余量 |
| coverage | `allMeteredInputAndOutput`、`automaticVadAndAsr`、`roundingAndMinimums`、`taxesAndSurcharges`、`inFlightAndUnknownTermination`，全部必须true且须有实际证据 |
| charges | 精确费用行，每行含上述两个金额和证据URL |

必需费用行：`twilioBrowser`、`twilioTarget`、`twilioMediaStreams`、`openaiTranslation`、`openaiRemoteAsr`、`openaiRemoteText`、`taxesAndSurcharges`、`inFlightAndTermination`。启用出程配对时还须 `openaiOutgoingAsr`、`openaiOutgoingText`；关闭时禁止夹带这两行，防止模式与责任范围混淆。费率检查时间、有效截止、服务截止沿用既有三个私有日期变量，参与证据摘要和持久scope。没有修改生产变量或提交真实费用值。

## 旧账本、重启与清理

保留原journal schema v1、文件、锁和initialized sentinel。无costBound的旧policy仍按原digest解析，用于既有恢复代码和责任核对；生产cloud入口拒绝缺少新costBound。不会把旧scope自动迁移成新策略，更不会初始化一份空的5美元预算。新旧策略打开同一旧账本时scope不匹配会拒绝且文件不变；必须先通过既有授权运行入口核清旧责任，再由父线程决定接续，当前尚未执行。

新策略同scope重启会恢复未清双腿和未知责任；正常终结但账单未知也继续保留整通预留。只有一通准入，耗尽后重启仍拒绝。断线、晚到SID、某腿挂断失败均保留清理责任，不能只停止媒体后宣称结束。

## 离线证据与剩余运行门槛

`tests/fixtures/cloud-cost-evidence.ts` 明确只用于测试：合成F=2000000、r=5000、R=5000000推导D=600。它不是Twilio/OpenAI价格，不允许用于运行配置。定向测试覆盖小于/等于/大于300秒推导、缺费率/未知责任/错误身份和模式拒绝、整数溢出、较早费率截止及清理余量、600秒媒体边界、301秒继续且600秒截止、两腿timeLimit、并发准入、断线清理失败后重试、创建迟到、预算耗尽、旧账本不变及重启责任恢复。

实际仍需在已有授权运行入口完成：隐藏AppSID与指定App相等；原卷/journal锁和未清责任可核实；实际连续模型会话可用；完整费用上界与剩余总预算成立。模型目录可见不代替真实会话；`verify:providers`会开可能计费WebSocket且默认legacy，不可当只读检查。任何真实模型验证须先提交计费方案并纳入同一5美元额度，不能为探测拨号；验证已花费或尚未结清的责任须从本通可用R中扣除，不能给探测和电话各留5美元。准备完成后先通知父线程/用户，再安排已授权唯一本人目标的一通。

现连接器仅能列变量名，无法读取运行值或执行容器命令；不能臆造上述结果。当前缺实际费用证据，所以代码修正完成仍不等于电话ready。
