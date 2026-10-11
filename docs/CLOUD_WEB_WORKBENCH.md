# 日常网页工作台

2026-10-11；显式 `CLOUD_SERVICE_MODE=web-workbench` 提供可持续运行的个人登录工作台，不要求、读取或应用 `CLOUD_TEST_DEADLINE`。继承过期的试验变量也不会让此模式按旧试验时间停止。服务本身没有一小时截止，并不代表获得持续托管或日常收费电话的预算授权。

| 模式 | 服务期限 | 电话与 WebSocket |
| --- | --- | --- |
| 缺省 `phone` | 原最多一小时试验期限及完整电话配置/收费门槛 | 原受保护电话能力 |
| 显式 `web-verification` | 原最多一小时验证期限 | 全部关闭 |
| 显式 `web-workbench` | 没有试验服务截止时间 | 全部关闭 |

模式只在启动时从运行配置选择；网页请求、URL 和后来修改的环境不能切换权限。`/controlled` 返回本模式固定的工作台页面，共享登录 JS 严格核验固定 HTML 模式与服务端状态。页面明确显示电话关闭和无通话记录，当前不能拨号、接收字幕或打开媒体流。

## 最小独立配置

```dotenv
CLOUD_SERVICE_MODE=web-workbench
AI_PHONE_RUNTIME_MODE=cloud
PORT=8080
CLOUD_WARM_INSTANCES=1
CLOUD_PUBLIC_ORIGIN=https://ai-phone-test-staging.up.railway.app
PUBLIC_BASE_URL=https://ai-phone-test-staging.up.railway.app
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_ALLOWED_EMAIL=
# 非 Gmail 配置至少一项已核实约束；省略未使用的变量，不能声明空值。
# GOOGLE_HOSTED_DOMAIN=
# GOOGLE_SUBJECT=
```

配置含真实秘密的值只保留在批准的运行环境，不能写 Git、示例或日志。精确 origin、Google redirect URI、已验证精确邮箱、预期 hosted domain 或已核实 subject 的校验与[限时网页模式](CLOUD_WEB_VERIFICATION.md)完全相同，不提供注册或身份猜测。此模式不读取或要求 OpenAI/Twilio 凭据、号码、四个电话确认标记、费率、通话预留或持久卷，也不创建 provider、controller、Voice signer、电话 manager、模型或 journal。

现有 `check:cloud` / `start:cloud` 入口按上述显式模式分流。`--check` 输出固定 `serviceMode:web-workbench`、`callsEnabled:false`，仅证明配置检查通过，不执行 Google 交换、供应商请求或部署。

## 登录期限与安全边界

服务可持续运行，会话仍 **15 分钟空闲到期、最长 8 小时**。读取页面、状态或健康不续权；只有用户手动续期且通过当前 Origin/CSRF 校验才能更新空闲期限，不能超过绝对上限。退出、取消授权、关闭服务及迟到 OAuth 结果均不能复活旧权限。会话与登录流程只在有界内存中保存；进程重启后旧 cookie 无效，需要重新 Google 登录，没有新增持久身份或自动续权。

保留 Google RS256 验签、issuer/audience、state/nonce/PKCE、verified email、cookie、Origin/CSRF 和发送最终响应前的授权复核。时钟非法或服务关闭时拒绝新权限。固定 HTTPS Host 与代理边界、单进程 loopback 上游及精确路径白名单保持；匿名仅允许登录壳、明确资产、健康与既有登录流程，状态和 session bootstrap 仍须认证。电话创建、controller、Voice、回调、媒体和全部 WebSocket 升级从入口及服务端拒绝。原本机 cloud 启动保护不变。

## 交付与运行状态

### Google 登录失败诊断（2026-10-11）

实际浏览器报告选择账号后返回 `401 LOGIN_FAILED`；02:06:24 UTC start 200，02:06:33 callback 401。平台HTTP日志没有查询参数，应用原实现将多个失败合并且不记录原因；不能据此确认 cookie、flow、身份约束或提供方失败。服务在线没有重启，日常模式不使用旧试验截止。

本次授权仅在服务端输出固定 JSON `{ "event": "GOOGLE_LOGIN_FAILURE", "reason": "…" }`。reason 经过运行时白名单，只能为 `CALLBACK_INPUT_REJECTED`、`BINDING_MISSING`、`FLOW_MISSING`、`FLOW_INVALID_OR_EXPIRED`、`CALLBACK_PARAMS_REJECTED`、`GOOGLE_PROVIDER_UNAVAILABLE`、`GOOGLE_AUTH_BUSY`、`GOOGLE_TOKEN_INVALID`、`GOOGLE_IDENTITY_REJECTED`、`POST_EXCHANGE_REJECTED`、`FINAL_COMMIT_REJECTED`。不携带请求、URL/query、code、token、cookie、状态随机值、身份或异常原文；同步或异步日志失败不能改变响应。Fastify请求日志仍关闭，既有HTTP响应和flow消费、JWT、state/nonce/PKCE、精确身份、最终会话提交均保持。

[Google 官方OIDC文档](https://developers.google.com/identity/openid-connect/openid-connect)要求客户端忽略未知响应参数；当前回调严格拒绝未知项，存在兼容风险，但本次没有真实参数证据，未放宽现有规则。离线回归明确保证未知 `iss` / `session_state` 与重复已知参数仍401且不兑换token。固定 `CALLBACK_PARAMS_REJECTED` 只能证明参数分支，不能单独证明未知参数是根因；同样 `GOOGLE_IDENTITY_REJECTED` 不包含被拒绝身份，也不能称为已验签的具体hd不匹配。

仅部署此AI服务，由主线程可访问的浏览器重新开启一次登录，取得固定分类后做最小修复。最终需实际Google授权成功、鉴权状态读取、手动续期及退出；模拟提供方和平台health不替代真实登录。

固定诊断版本 `5df779c7388046468c89da54f15f3583d764b6b0` 已实际部署，`d0a87550-1b0e-4fd5-86e8-6c69ac353554` 于 **02:17:35.025 UTC SUCCESS**，health通过、AI单副本Online；Portal部署没有变更，原资源/卷/凭据/权限保持。进程替换使旧flow/session失效，浏览器重现须重新从页面开始，不能刷新先前OAuth回调来定位新登录。实际完整Google登录仍待主线程验收，费用仍两服务合计资源4美元、3美元提醒。

实际重现于02:21:26 UTC记录 `CALLBACK_PARAMS_REJECTED`，已定位在token兑换前参数分支；不能猜具体字段或归咎设备确认/浏览器工具。主线程无法从错误协议标签取得参数名，授权第二版固定细分：`CALLBACK_PARAMS_UNKNOWN_ISS`、`CALLBACK_PARAMS_UNKNOWN_SESSION_STATE`、`CALLBACK_PARAMS_UNKNOWN_OTHER`、`CALLBACK_PARAMS_DUPLICATE`、`CALLBACK_PARAMS_GOOGLE_ERROR`、`CALLBACK_PARAMS_CODE_FORMAT`。只有前两个来自写死的名称Map，其余未知名统归OTHER；不打印任意query名称，更不打印值/URL。原粗reason仍保留观察器兼容，实际参数分支改记录对应细分类；缺/非canonical/重复state仍在原前置INPUT拒绝。允许参数、duplicate/error/code原边界及Google OIDC全部校验不变，重现拿到明确类别后才做最小修复。

第二诊断版本的允许名称为 `state/code/scope/authuser/prompt/hd/error/error_description/error_uri`。[Google示例](https://developers.google.com/identity/openid-connect/openid-connect#3.-confirm-anti-forgery-state-token)包含code/state/scope且明确未知响应项规则；`iss`来自[RFC9207授权响应issuer扩展](https://www.rfc-editor.org/rfc/rfc9207.html#section-2.4)，若支持须精确比较预期issuer；`session_state`来自[OIDC Session Management扩展](https://openid.net/specs/openid-connect-session-1_0.html#CreatingUpdatingSessions)。这些规范不能证明Google本次实际返回它们，固定名称分类不是授权白名单，不扩大真实允许项。

### 已证明的 iss 兼容问题与最小修复

02:32:15 UTC新版真实回调日志明确 `CALLBACK_PARAMS_UNKNOWN_ISS`，旧拒绝分支已被具体定位。[Google当前Discovery](https://accounts.google.com/.well-known/openid-configuration)实际声明固定issuer `https://accounts.google.com` 与 `authorization_response_iss_parameter_supported:true`，不是从用户回调猜的来源。新增允许名称仅 `iss`，按URLSearchParams标准表单解码后必须精确等于上述固定issuer；不接受bare/http/slash/case/port/query/hash变体，不跟随它获取metadata/key或向它发请求。错误iss固定记录 `CALLBACK_PARAMS_ISS_MISMATCH`，重复iss仍DUPLICATE，二者401/无cookie/无token兑换且flow不能重放。

本轮保留原无iss响应兼容策略，不把absence称为RFC9207对已知支持方的要求；Google实际带iss的流程严格比较，IDtoken原issuer/audience/签名/nonce与身份限制仍全校验。state/绑定/PKCE、code边界、其他unknown参数拒绝、会话最终提交/期限/CSRF均保持。真实Google完整登录、鉴权状态、续期及退出仍须在新部署后验收；代码修复不代替实际验收。

本轮仅实现代码并在云端 Linux 用虚拟时钟、离线假 Google 提供方和实际 Chromium 验证；不更新 Railway 源码来源、部署、变量、容量或卷，不访问付费 API 或拨号。上一轮主线程的限时部署已于 2026-10-10 23:55–23:57 UTC 停止，两服务 Offline，5 GB 卷保留；平台源码仍固定此前 `5159ce3`。持续托管的预算与启动由主线程另行决定，本模式取消应用试验截止不构成平台账单硬封顶。

上述为代码交付时状态。2026-10-11 01:58 UTC 新授权已恢复 AI，部署 `af306eb3-dce9-4861-acc5-09449168052f` 固定已验收 `5b6047f31b4f5470b2e7cfa99c9f639ce5b44cc5`，SUCCESS、1/1 Online、平台 `/api/health` 通过；启动日志固定 calls disabled，资源和原卷保持，旧 deadline 未改。最新费用是两测试服务合计资源最多4美元、3美元提醒，不升级Hobby，30美元/月范围撤回，主线程负责持续监控。真实公网页面单次访问仍被本环境proxy tunnel阻断，未取得页面或实际应用登录证据，留给主线程可用浏览器/用户手动验收；无真实电话或模型调用。

真实公网页面/Google 应用 OAuth、真实麦克风/手机、数字否定、长讲话积压、自然度和耳听延迟仍未通过本轮验收。离线假登录与健康不能代替这些证据。后续开启日常电话还需独立费用准入、每通生命周期及结算设计，本轮不将单通试验计数改成多通。
