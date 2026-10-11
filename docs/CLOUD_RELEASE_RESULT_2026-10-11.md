# 12:19 UTC 发布调用回收结果与电话最小后续

本记录更新早先 [恢复报告](CLOUD_RECOVERY_ACCEPTANCE_2026-10-11.md) 的“原patch仍STAGED、尚未发布”状态。本次没有发起第二次发布、切换工具、回滚、修改配置、拨号或运行模型探测。最新指令已暂停外部发布；后续开发在独立交付分支，不再推动部署关联分支。

## 本任务的一次调用实际已提交

- 接到父线程明确移交发布责任后，重新读取原patch：唯一 `32101bad-cdc7-440e-832f-550130fbcf10`、STAGED、唯一字段 `source.commitSha` 为 `4bab94e → 7b598f1`，无变量/资源/其他服务变更。AI仍原部署calls-disabled，Portal正常。
- 随后仅一次调用 `railway_accept_deploy`，目标环境 `c5db5ddb-26b6-48ce-b920-dc1ebbe30fa8`。工具通过 functions.exec cell `26` 等待；在接收父线程后续“暂停发布、确认UI异常”的指令后，本任务只调用wait收取原调用结果，没有重试。
- 原调用最终返回 `committed:true`、`deploymentStatus:triggered`，workflow为 `commitChanges/c5db5ddb-26b6-48ce-b920-dc1ebbe30fa8/32101bad-cdc7-440e-832f-550130fbcf10`。父线程另外两次调用的Cancelled记录不能覆盖本调用的实际结果。工具未提供确认消息ID或批准主体，不能推断哪个UI动作使其继续。
- 新deployment `27330903-d42c-49e3-aae7-747988ab458a` 创建12:19:15.771 UTC，**12:19:45.626 UTC SUCCESS**；单副本Online、无失败，pendingWork空、staged=null。**当前本任务没有挂起发布/确认请求。**
- 平台构建日志12:19:42.608 UTC `/api/health` **1/1成功**；新容器12:19:42.055 UTC日志为 `CLOUD_WEB_WORKBENCH_STARTED_CALLS_DISABLED`。
- Portal仍原 `78923ac3-8a35-4d89-8aef-e7911a6a3dfb`；AI原单副本、1CPU/500MB、5GB卷和 `/data` 挂载保持。公网CONNECT403不绕过，实际网页与Google由父线程已授权浏览器验收。

## 精确来源有未闭合差异

服务配置读取的 `source.commitSha` 为 `7b598f1337a0edbd24c9dc20f09268ad1b2c238d`，但新部署metadata报告 `a3ab2ec36921c4fbf1bb0d859ed1ae652473a71b`，提交说明为恢复文档提交。因此不能声称精确7b598f1部署已验收。

本地Git确认两提交仅差 `PROGRESS.md`、`docs/CLOUD_PHONE_READY_CHECK.md`、`docs/CLOUD_RECOVERY_ACCEPTANCE_2026-10-11.md` 三份文档。对Dockerfile及全部COPY输入（package/lock、tsconfig、src、public、prepare-desktop脚本）的 `git diff --exit-code` 为0；Dockerfile不复制上述三份文档。可证明这两个候选的应用构建输入一致，不能由此推断平台具体checkout SHA或声称核验实际容器字节。

新镜像日志digest为 `sha256:d8d256c9d343f777d8becac2de3d9dccf427d81084cb71e7f2355a19ccf7e6fb`，配置digest为 `sha256:13ba298bbbd49bef4af5a6c12bf69b0c5cf04098daa165e481465e65cf895a25`，deployment snapshot为 `e1504a44-2507-47a3-bf37-f6d94e71db01`。这些标识来自该deployment的日志/元数据，不是根据Git分支推算。

后续逐文件核对104个构建输入（包括文件mode、字节长度、内容SHA-256）完全相同，两份有序JSON清单的SHA-256均为 `f3394f848cdfa0905599be5f3995c04d841ad2cc30231e3344def00ebd4690b1`。清单在 `/tmp/ai-phone-build-input-manifest.json`。这是源码构建输入等价证据，不是实际运行容器文件清单；没有重复构建或付费操作。

`get-service-config`的live source是已保存环境配置；`list-deployments`的meta是该次部署记录。两字段在本次实际不一致。完整时间窗构建日志没有checkout/克隆SHA或来源证明；当前连接器没有拉取部署镜像、读容器文件或读取部署源码快照内容的接口。因此不能确认后台真正checkout了a3ab2ec，或只有元数据引用分支头；也不能仅凭source.commitSha断言运行7b598f1。最精确结论是：该deployment的实际构建日志镜像标识已核准，平台运行健康且calls-disabled；两个候选源码的应用构建输入一致；精确源码到运行字节的来源证明尚缺。

已核对[Railway官方API说明](https://docs.railway.com/integrations/api/manage-services#deploy-a-service)：`serviceInstanceDeployV2`用显式 `commitSha` 参数选择特定提交。本次调用的是环境级 `accept_deploy`，工具参数只有环境ID和说明，没有部署SHA参数，且结果只给workflow、不返回checkout证据。官方说明不能证明该环境patch内部如何选取源码；差异因此仍定位在平台从配置应用到具体部署/元数据的环节，不能断言用户提交错误或平台已经按某SHA构建。未执行该API或任何新发布。

不以第二次发布或回滚“修正”元数据，不添加公网诊断或凭据。后续若现有平台详情能显示原始checkout SHA/构建来源，或已有授权运行入口能读取容器应用文件哈希，可只读补齐最后一层证据。父线程可继续公网页面/真实Google验收，保持拨号关闭。

## 可在开发环境实施的最小源码修正

以下原最小改造方案已在开发环境实施并完成离线回归，详见 [预算驱动时长](CLOUD_BUDGET_DURATION.md)。尚未发布、未录入真实费用证据，不解除电话门槛。

1. 把完整已核验费用证据产生的有限 `D` 及媒体限额定义为一个策略对象。缺少证据、非整数/溢出、超过5美元或不在服务/费率有效窗口内均拒绝。不能用默认300秒、固定2美元工程预留、字节代理或分钟均价替代证明；实际D当前无可验证值。
2. 同步修改 `cloud-service-config.ts` 的固定300000ms/72MB、`cloud-budget-journal.ts` 的300000ms/100MB校验、`session-manager.ts` 的浏览器腿 `seconds > 300`、`cloud-call-usage.ts` 的14.4MB PCM/2.4MB PCMU、`cloud-service.ts` 的providerUsage接线与 `cloud-index.ts` 的300秒检查输出。两腿均取journal剩余绝对时间，应用截止取D/服务截止/费率有效期最早值并留清理余量；秒数向下取整，所有实际发送含补零和drain计入。
3. PCM16/24k为每秒48000字节，PCMU/8k为每秒8000字节；按固定三/五会话分别核各流及journal聚合额度。文字60次/450000输入代理/72000输出预留不因延长D扩大。Pocket本机单独五分钟保护不属此次cloud continuous-captions改动。
4. 时长、字节、启用会话及共享用量策略版本须绑定原journal scope；原锁、sentinel、费用预留和未知SID责任保留。策略不一致拒绝恢复，不能迁移成空账本。scope变更的线上接续要先核原责任再决定，不能靠重启续额度。
5. 离线测试覆盖小于/等于/大于300秒的一致执行、预算不足及证据过期拒绝、两腿timeLimit/创建迟到/清理失败、音频额度及整数溢出、原journal重启与scope不匹配拒绝、默认电话仍关闭。无需真人电话、供应商或密钥即可验证这些接线；测试不能证明费率证据本身。

## 可执行的运行核验顺序

1. **App只读核验**：在已有授权运行入口中仅输出 `TWILIO_TWIML_APP_SID` 与指定App的相等布尔值；用现有Twilio认证GET该App，核Voice URL/POST，记录布尔结果而非秘密。目标只核存在，不打印清值、也不重新索要。现Railway MCP只有变量名，没有容器执行；开发环境无既有Railway CLI/token或供应商凭据，所以本任务当前不能执行这一步。
2. **journal只读检查**：在同一既有运行入口，以只读方式检查原目录、owner/mode、lock、`trial-budget.json` 和initialized sentinel的一致性，输出锁是否存在、版本、冻结、预留金额、未终结/未知责任计数。不要实例化 `CloudBudgetJournal` 做检查：其构造函数会创建独占锁并可能初始化文件。还须对照既有实例/供应商腿确认锁是否真陈旧，不能按时间或PID猜测删除。当前网页服务只开放登录、health和状态，不提供journal运营读取路由；不为绕过限制添加公网诊断接口。
3. **连续模型核验**：现 `scripts/verify-providers.ts` 默认legacy，不能代表云候选。准备时显式复用 `verifyProviders(config, 'continuous-captions')`，出程配对明确启用时另加 `checkPrefixRealtime`；三路/五路分别核验。其真实WebSocket可能计费，先报告端点、连接数、输入输出限额、超时、失败清理和费用预留，纳入同一5美元总额。禁止为探测拨号；不得用模型目录可见代替会话可用。
4. **费用/窗口核验**：确认实际目标线路、两腿、各Media Stream、所有模型、自动ASR/VAD与在途费用及适用附加费；从完整费用证据推导D并先持久预留，再配置已验证字段和统一窗口。没有证据就保持phone关闭；不新建凭据、不改OpenAI账户级限额。
5. **用户测试**：上述完成后先向父线程/用户报告ready；只安排唯一本人目标的一通，费用仍为Twilio+OpenAI合计5美元。静态网页、Google登录和离线回归各自验收，不代表实际手机声音、翻译质量或延迟。
