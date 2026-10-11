# 云环境恢复与发布复核（2026-10-11）

本次使用原保存云配置恢复执行环境，没有重建项目或连接离线电脑。检查时没有原发布任务已停止的回执，只能确认父线程已经下达停止发布、patch、推送及配置修改的指令。按本次明确交接要求，未确认原任务停止前不应用发布。以下区分独立证据与父线程交接记录。

## 源码与原发布对象

| 检查         | 独立结果                                                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 恢复工作区   | 起点为旧 `5fabf51`、无修改；获取原开发分支后切至 `7b598f1337a0edbd24c9dc20f09268ad1b2c238d`，没有重做源码                                                                                                                                                                                       |
| 分支与 PR    | `codex/cloud-phone-conversation-20261009`；[草稿 PR #3](https://github.com/Richman2020/live-translation-openai-realtime-api/pull/3) 仍 open/draft、未合并                                                                                                                                       |
| 精确源码 CI  | [run 38110048650](https://github.com/Richman2020/live-translation-openai-realtime-api/actions/runs/38110048650) completed/success；最新 job `114383553328` 的 build、typecheck、完整回归、Docker、七组浏览器及格式步骤均 success。旧 combined status 的 pending/空 statuses 不否定 Actions 结果 |
| 仓库技能     | 当前分支与远端 main 的 Git 树均无 `.agents/skills`；`/workspace/.agents` 为空。已读最新仓库规则、进度、需求和相关实现，另读已安装 Railway `use-railway` 技能及部署参考                                                                                                                          |
| 原 patch     | `32101bad-cdc7-440e-832f-550130fbcf10`，STAGED，createdAt/updatedAt 均 `2026-10-11T04:02:06.421Z`                                                                                                                                                                                               |
| 完整暂存差异 | 唯一字段为 AI 服务 `source.commitSha`：`4bab94e009bb56b692ed09750f605f73556a51fb` → `7b598f1337a0edbd24c9dc20f09268ad1b2c238d`。无变量、共享变量、网络、卷或其他服务差异；destructive=false                                                                                                     |
| 当前 AI      | deployment `215d94ea-bd07-4ed9-82e0-d134550aa7f1`，源码仍 `4bab94e`，SUCCESS、单副本 Online、无近期失败；03:15:08.305431842 UTC 日志为 `CLOUD_WEB_WORKBENCH_STARTED_CALLS_DISABLED`                                                                                                             |
| 既有资源     | Virginia 单副本、1 CPU、500000000 bytes 内存、原5GB journal卷挂载 `/data`；Portal仍 `78923ac3-8a35-4d89-8aef-e7911a6a3dfb`。未创建、扩容、升级或改写资源                                                                                                                                        |

网页候选的原发布对象与 CI 有效，但本轮未应用 patch、未触发部署。没有替换、重建或重复提交原 patch。后续文档提交不改变该源码 pin，不能称作该候选已经上线。

## 恢复环境实际验证

Linux、Node 24.19.0、npm 11.9.0、Chromium 151.0.7922.173。按原锁文件安装549个依赖，没有升级；默认npm缓存不可写后改用 `/tmp/ai-phone-npm-cache` 成功，没有改变HOME或权限。

- `npm run prepare:desktop`、`npm run build`、`npm run typecheck` 通过。
- 定向回归 **182/182，零失败/跳过**：google-login、google-oidc、session-page-lease、cloud-web-verification-config/service、cloud-call-usage、cloud-provider-usage-integration、cloud-budget-journal、session-journal-integration。
- `npm run test:web-workbench:browser` **82/82**；实际离线 Chromium，`externalRequests=0`、`realSupplierCalls=0`、`exceptions=[]`。假提供方仅用于隔离测试，没有安装用户cookie、登录真实账号或绕过线上鉴权。
- 覆盖后台无输入超过八小时、多标签、最后关闭30秒宽限、刷新、断网/冻结到期、旧page ID恢复、退出与跨标签旧CSRF；号码键盘仅编辑，所有电话路径及WebSocket拒绝。
- 已查看截图，工作台布局正常，明确显示电话关闭、拨号暂未启用、逐句对话为空。截图在忽略目录 `.runtime/web-workbench-browser/`；不作为线上Google或真人麦克风验收。
- 本轮没有生产源码修改，不以182项覆盖全部1212项；完整原源码CI单独列在上表。

本环境直访 `/api/health` 等公网路径被出口代理拒绝，curl为 `CONNECT tunnel failed, response 403`，web工具也无法访问。这是工具网络限制，不是应用鉴权403或服务宕机证据；平台仍Online。没有关闭证书校验、绕过代理、模拟用户凭据或新建OAuth授权。**本轮未取得线上新版静态资产、health body或真实Google登录结果。**

## 真实电话最小未决项

1. **运行配置对应关系**：Railway OAuth返回 `valuesRedacted=true`。已确认 `CLOUD_TEST_TARGET_NUMBER`、`TWILIO_TWIML_APP_SID` 名称存在，不输出清值；不能证明运行AppSID与父线程已更新的App一致。外部App `/voice/client` POST更新来自父线程交接，本轮未独立重读Twilio、未改来电配置。
2. **原持久责任**：卷挂载只能证明资源存在；网页入口不加载电话journal。未读取原 `trial-budget.lock`、journal内容、未知SID/未结费用或重启恢复状态。不得删除锁、重新初始化预算或把离线恢复测试当线上账本无责任。
3. **实际能力与完整费用**：未运行模型目录/Realtime探测或 `verify:providers`。当前 `costBoundVerified:false`、两美元非文字工程预留及文字字节代理不是完整账单上界；300秒保护不是用户新要求或5美元保证。默认三路、可选五路模型均需按实际配置核验。
4. **启动字段与窗口**：当前变量名缺少七项：`CLOUD_TRANSLATION_CAPABILITY_CONFIRMED`、`CLOUD_PUBLIC_CALLBACK_CONFIRMED`、`CLOUD_TRIAL_RATE_BOUND_CONFIRMED`、`CLOUD_JOURNAL_VOLUME_CONFIRMED`、`CLOUD_CALL_RESERVATION_USD_MICROS`、`CLOUD_RATE_CHECKED_AT`、`CLOUD_RATE_VALID_UNTIL`。旧deadline过期来自交接，本连接不能读其值；实际电话窗口仍须核验。不能代填确认标记。

恢复环境没有Railway CLI、Railway API token或Twilio/OpenAI运行凭据；当前Railway MCP没有容器执行或journal文件读取工具。以上核验不能靠平台列表补齐，不提取/新建/更换密钥或扩大持续访问。

如能力验证必须开启可计费Realtime连接，先报告模型/端点、最大连接数、输入输出额度、统一截止、失败清理和费用预留；将验证费用计入同一Twilio+OpenAI总额5美元，不为探测额外拨号。完整费用上界成立后才生成统一有限时长，同步两腿timeLimit、媒体额度和原journal；取消固定五分钟不等于无限费用。

## 最短继续顺序

1. 取得原任务实际停止确认；再核对原patch ID、状态、完整内容和电话关闭。仍STAGED且内容不变时只提交原patch一次；若已APPLYING/APPLIED则追踪同一发布。
2. 仅AI发布后确认新deployment精确源码为 `7b598f1`、终态SUCCESS、health和calls-disabled；从可访问浏览器检查静态资源、真实Google登录、刷新/多标签/退出。重启清空内存会话，一次重新登录是预期。
3. 保留Portal、原卷和资源限额。Railway两服务累计4美元上限、3美元提醒由父线程监控；本次未读取新账单，不把10:21 UTC的0.0274美元历史值当当前值。
4. 补齐上述电话证据后先通知父线程/用户，再进入唯一本人目标的一通测试。本轮无拨号、付费模型请求或电话模式开启。
