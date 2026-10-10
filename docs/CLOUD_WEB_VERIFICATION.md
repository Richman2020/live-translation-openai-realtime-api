# 限时网页与 Google 登录验证模式

2026-10-10；新增显式 `CLOUD_SERVICE_MODE=web-verification`，用于先验收固定云网址、登录页及 Google 身份边界。未设置该变量时默认 `phone`，仍执行[电话模式](CLOUD_CONTINUOUS_TRIAL.md)全部供应商、controller、Voice、预算和持久化保护；缺少电话配置不会自动进入网页模式。

网页模式固定 `callsEnabled:false`，独立构建网页与登录服务，不创建电话 SessionManager、OpenAI/Twilio provider、controller、Voice signer 或 budget journal，不读取或要求电话供应商秘密、目标号码、四项 `CONFIRMED` 标记、费率、通话预留或卷配置。它不通过占位付费凭据或虚假能力确认启动，也不提供通话、语音回调、媒体或任何 WebSocket 升级路径。页面显示的禁用状态和服务端拒绝共同约束此模式。

## 可审阅的最小配置

仅在主线程协调的已授权服务中独立注入下面这一组；空白值由用户安全填写，不能把真实邮箱、Google subject、secret 或私密号码写入 Git。完整[变量样例](cloud-trial.env.sample)仍以 `phone` 为默认，下方网页模式配置须单独准备。

```dotenv
CLOUD_SERVICE_MODE=web-verification
AI_PHONE_RUNTIME_MODE=cloud
PORT=8080
CLOUD_WARM_INSTANCES=1
CLOUD_PUBLIC_ORIGIN=https://ai-phone-test-staging.up.railway.app
PUBLIC_BASE_URL=https://ai-phone-test-staging.up.railway.app
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_ALLOWED_EMAIL=
# 非 Gmail 安全填写至少一项已核实的身份约束；未使用的变量须省略。
# GOOGLE_HOSTED_DOMAIN=
# GOOGLE_SUBJECT=
CLOUD_TEST_DEADLINE=
```

Google 邮箱只允许已批准的单一、精确且 verified 的身份。非 Gmail 身份须配置经过核实的预期 `GOOGLE_HOSTED_DOMAIN` 或固定 `GOOGLE_SUBJECT`，填写至少一项并移除该行的注释；Gmail 精确 verified email 可不配置 hd/sub。不得用猜测身份补值。未使用的变量必须省略，不能声明空值。Google redirect URI 精确为 `https://ai-phone-test-staging.up.railway.app/auth/google/callback`，两个 public origin 值必须完全一致，不带尾斜杠、路径、查询或片段。`CLOUD_TEST_DEADLINE` 使用规范 UTC ISO 字符串，包含毫秒，格式为 `YYYY-MM-DDTHH:mm:ss.sssZ`，启动时须在未来且不超过一小时；由主线程按同一授权窗口生成，不能复制旧截止时间或每次重启延长窗口。

`CLOUD_TRANSLATION_CAPABILITY_CONFIRMED`、`CLOUD_PUBLIC_CALLBACK_CONFIRMED`、`CLOUD_TRIAL_RATE_BOUND_CONFIRMED`、`CLOUD_JOURNAL_VOLUME_CONFIRMED` 均不参与网页模式。网页验证不需要将它们设为 true。切回默认电话模式时，这些真实核验门槛和其余原有配置全部恢复要求。

## HTTP 与认证边界

| 路径或能力                                      | 网页模式行为                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/controlled` 及明确允许的页面资产              | 公开登录壳，显示通话已禁用                                                                    |
| 精确 `GET /api/health`                          | 应用健康标识，不授予认证或控制权限                                                            |
| 既有 `/auth/*` 登录路由                         | 保留 Google OIDC 验签、issuer/audience、state/nonce/PKCE、单身份校验及严格 Origin/cookie/CSRF |
| `/api/status`                                   | 仅已认证浏览器可读，返回固定网页验证状态及 `callsEnabled:false`                               |
| 通话/controller、`/voice/*`、媒体与所有 WS 升级 | 服务端拒绝，无电话或媒体组件可调用                                                            |

公网入口仍固定 Host 与 HTTPS 代理边界，内部应用仍经同进程 loopback 连接；原 `buildSoloServer()` 的 cloud 拒绝保护继续保留。浏览器请求不能改模式或启用通话。截止到期关闭登录与服务监听，不接受新登录或状态准入，不把应用退出当成平台资源计费已停止。

网页模式 `check:cloud` 的 `--check` 输出明确 `serviceMode:web-verification` 与 `callsEnabled:false`；它只验证配置，不执行真实 Google 登录、供应商连通或部署验证。入口与编译启动命令保持同一 cloud entry，模式由上述显式环境变量决定。本文件只提供审阅配置，不运行启动命令或平台变更。

## 已批准资源与当前阶段

两个 Railway 测试服务的资源操作预算合计 **0.50 美元、最多一小时**，计时、启动、停止和平台回读由主线程统一协调；网页模式没有获得独立的新一小时或额外资源额度。应用期限不构成 Railway 账单硬封顶。

用户已同意 **5 GB 持久卷保留至验收**。当前卷仍为 **STAGED，尚未 provisioned**；网页模式不要求持久卷，也不创建 journal。卷的当前标价为实际使用量 **0.15 美元/GB/月**；空卷也包含文件系统元数据，不按“无业务文件”视为零占用。规格与计费依据见[官方卷参考](https://docs.railway.com/volumes/reference)和[官方资源价格](https://docs.railway.com/pricing/plans)。主线程负责后续资源落地与保留期限，本源码任务不修改平台状态或自动删卷。

固定域名已由主线程分配。Railway 暂存源码仍指向旧提交 `004f7ee62c2960db296880bfa987bdac9d57b0aa`；本轮网页模式源码尚未更新该暂存来源或部署。审阅备注见[cloud-service-settings.json](../deploy/cloud-service-settings.json)，其中原电话配置保持，模式与阶段备注不自动应用。

## 验收证据与停止点

离线回归用于验证网页模式无需电话配置、仍严格验证 Google 配置和期限、认证前后路由权限、通话/语音/媒体/WS 拒绝，以及默认电话保护保持。模拟 Google 交换只在测试注入，生产不能由 env 或 HTTP 开启模拟身份。

后续真实验收分别记录公网页面/健康、允许身份的实际 Google 登录、其他身份拒绝、登出及期限停止。平台 OAuth 只读连接成功、配置检查通过、离线测试或 HTTP 存活均不能证明应用 Google 登录成功，更不能证明麦克风、模型或手机电话接通。当前未取得这些实际验收结果；本轮不访问付费 API、不改 Twilio 回调、不拨号、不更新 Railway 源码来源、不创建资源或部署。
