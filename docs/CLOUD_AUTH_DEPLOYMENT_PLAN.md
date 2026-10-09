# 云电话认证、会话隔离与部署准备方案

日期：2026-10-09。状态：**推荐待确认，仅文档；当前 cloud 仍拒绝启动 `CLOUD_AUTH_NOT_IMPLEMENTED`**。配置齐全不等于 ready。本轮不实现公网 API、不生成密码/凭据、不增加依赖、不部署、不改 Twilio 回调、不调用付费接口；本机 loopback 安全边界继续保留。

后续获批里程碑实现了 [独立会话/通话授权组件](CLOUD_ACCESS_BOUNDARY.md)、[实际应用的离线接线](CLOUD_PHONE_APPLICATION_INTEGRATION.md)及[控制租约与Voice许可](CLOUD_CONTROLLER_VOICE.md)。它们要求服务端同步查询当前已验证会话，没有选择或实现本文推荐的登录方案，也没有启用生产入口；cloud guard 保持不变。GET/HEAD无Origin时采用严格same-origin Fetch Metadata，写操作/WS继续要求Origin；真实Chromium已观察同源fetch/EventSource头。owner SSE和租约/join有模拟依赖证据，生产签名器、持久预算/intent及异步后端事务仍未实现。

## 推荐身份方案与现有基础

第一版只支持用户自己的一个账号，推荐 **Node 内置异步 `crypto.scrypt` 验证独立密码 + 随机 opaque 服务端会话 cookie**。无需新登录供应商、订阅、邮件发送或第三方账号。公网密码与现有 `LOCAL_ACCESS_TOKEN` 完全独立，不能复用本机启动链接或 token。外部 IdP、多用户注册、MFA、找回邮件作为以后另行授权的选项；当前建议不提供公开注册/重置接口，忘记密码由运行环境管理者安全替换验证材料并撤销所有登录。

该密码方案不具备 MFA 或抗钓鱼认证保证，第一版限定本人使用；增加身份方案要另行审查，不能称为已有多因素保护。

代码基线仍是单人本机服务：`server.ts` 使用固定 `ai-phone` identity、全局 SSE；`session-manager.ts` 有共享 presence / activeSession、角色 nonce、媒体 call SID 绑定与清理确认。它们不能直接作为公网认证。锁文件现有 Fastify 4.28.1、Twilio 5.3.1、WS 8.18.0、dotenv 16.4.5、`@fastify/websocket` 10.0.1；没有锁定 cookie/session/rate-limit 插件。推荐先使用内置 crypto 和既有 Fastify hooks，范围限定于一种固定 cookie 格式与服务端会话，不升级库。若实现审查认为需要成熟 cookie 插件，再单独审查依赖与锁文件，不能把自写解析的复杂度隐藏掉。

| 项目         | 推荐参数与实现门槛（尚未实现）                                                                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 密码验证     | `scrypt`：`N=131072`、`r=8`、`p=1`、`keylen=64`；每次设置密码使用至少 16 字节随机 salt，保存算法版本/参数/salt/摘要，不保存明文。Verifier 启动时严格验证版本、固定参数与字段长度，不能允许请求指定 KDF 参数。采用独立长随机密码，不 trim 或截断；请求密码最多 1024 UTF-8 字节，超限拒绝。 |
| 内存与比较   | 显式 `maxmem=256*1024*1024`，不使用 Node 默认 32 MiB；该参数的主要内存约 128 MiB，256 MiB 是校验余量而非整个服务上限。使用异步接口及等长 `timingSafeEqual` 比较，未知账号仍执行相同验证路径并返回相同登录失败码；不能声称整个 handler 因此天然恒定时间。                                  |
| 会话         | `randomBytes(32)` 生成会话值，只在 HTTPS cookie 交付；服务器存其 SHA-256 摘要与会话记录。随机高熵会话的摘要索引不替代密码的 scrypt。登录成功轮换并撤销当前浏览器旧会话，不自动撤销另一设备的会话；建议绝对到期 8 小时、闲置到期 30 分钟。退出撤销当前会话，改密码/重启撤销全部会话。      |
| Cookie       | 推荐 `__Host-ai-phone-session`，`Secure; HttpOnly; SameSite=Strict; Path=/`，无 `Domain`，不持久写入 localStorage、不放 URL 或日志。浏览器关闭不保证 cookie 或电话清理，服务器仍执行到期及 lease 规则。                                                                                   |
| 登录资源限制 | 验证前限制来源 IP 与账号的尝试；建议每 IP/账号每 15 分钟 5 次失败、全局每分钟 10 次尝试，scrypt 并发 1、排队最多 2，超过返回 429。IP 只作为限流，不作为身份；只信任明确代理。参数需在目标实例上测资源与可用性，不自动降低 scrypt 强度。                                                   |

scrypt 的 salt、`maxmem` 和比较限制按 [Node 24 crypto 文档](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)及 [timingSafeEqual](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b)核验；工作因子采用 [OWASP scrypt 建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)。Cookie/会话控制参考 [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。到期、字节限制及限流数字是本项目待测建议，不是官方保证或当前行为；不据此升级本环境 Node。

## principal、owner、控制租约与电话归属

| 层级              | 服务端职责                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `principalId`     | 单账户稳定身份；改密码、登录轮换不变。不以用户名、手机号码、本机 token 或浏览器传入的 ID 替代它。                                                                                                                                                                       |
| `authSession`     | 一次已验证登录，保存摘要、principal、认证 epoch、到期与撤销状态。不同设备登录创建不同会话；重启全部失效。建议最多两个有效登录。                                                                                                                                         |
| `browserOwnerId`  | 服务端在登录后签发并绑定 authSession；同一登录内轮换 cookie 可延续该 owner。状态、字幕账本、事件重放和电话均归属 owner；不同登录默认互相不可见，即使是同一 principal。                                                                                                  |
| `controllerLease` | owner 下唯一控制标签页的短期随机票据与递增 epoch。Cookie 被同源标签页共享，不能代表控制权；`tabId`/sessionStorage 仅标识提示，不授权。控制票据保留页面内存，其他标签页默认只读同 owner 的状态，不能续控制 lease 或拨号；显式接管原子更换 epoch、废止旧票据及 identity。 |
| `callSessionId`   | 电话创建时绑定 principal、owner、lease epoch、选定引擎及两腿 nonce/SID。只从已验证上下文建立归属，body/query 中的 `ownerId` 无权改变它。                                                                                                                                |

建议控制心跳每 15 秒、服务器 lease 60 秒；SSE 短暂断线不立即挂断，控制心跳失联到期才清理该 owner 电话。页面刷新/接管要明确取得新 lease，废止旧票据；接管活动电话应先挂断并确认，再允许新控制者拨号，不自动接管原媒体线路。后台标签页定时器延迟和临时断网要做模拟及真实 Chrome 验收，不能保证不会断话。退出、账号撤销及登录绝对到期立即撤销 lease，进入两腿清理。

`status`、`events`、`presence`、`token`、拨号、挂断、字幕导出/重放均从 authSession→owner 做授权；修改电话还要验证 controllerLease/epoch。号码、其他 owner 的存在与会话内容不因可猜的 call ID 泄露。全局只允许一通电话；其他 owner 得到统一 busy。单账户仍需至少两个模拟 owner 的越权读、写、订阅和回调绑定测试。

## 浏览器、SSE 与 Twilio 入口分离

| 入口                | 验证与限制                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器登录/修改请求 | 目标 origin 固定为 `CLOUD_PUBLIC_ORIGIN`，状态修改采用 POST + JSON；严格匹配非 `null` 的 Origin，并验证 session 绑定的独立 CSRF token。登录页先取短期、仅可登录的预会话 CSRF token，登录成功废止它并换正式 token；退出、token 签发、拨号、presence/lease 续约也受保护。不得用当前允许无 Origin 的本机规则直接代替。       |
| 浏览器读取/SSE      | 同源 cookie 鉴权，拒绝跨域；GET 无副作用，SSE 不使用 `?token=`。每 owner 最多两个只读事件订阅，不能仅靠 SSE 活跃续控制 lease；重放游标受 owner/call 约束，不从全局历史取数据。失效会话立即关闭流；关闭时清除 heartbeat/subscriber，慢客户端保留现有 256 KiB 缓冲上限并断开，日志不保存正文。                              |
| 浏览器 WebSocket    | 当前字幕使用 SSE，首版不新增浏览器控制 WS。将来若新增，独立路径在 upgrade 前校验 cookie、固定 Origin；短期一次性 ticket 绑定 owner/lease，用同源 CSRF 请求取得，在受限首次消息中验证，无权时不处理业务；到期/撤销立即关闭。它与 Twilio 的 `/voice/media` 是两种认证边界，不能共用 cookie 或签名检查。                     |
| Twilio `/voice/*`   | 供应商不具备浏览器 cookie/CSRF/Origin，采用既有 Twilio SDK 签名验证、配置 AccountSid、电话/session/role/nonce 绑定。`/voice/media` WSS 握手仍验签，首次 start 再验证 accountSid、已绑定 callSid、streamSid、nonce、格式，禁止未 start 音频和重复/跨腿 socket；不能要求它提供浏览器 Origin，也不能因缺 Origin 就绕过签名。 |

CSRF 与固定代理目标按 [OWASP CSRF 指南](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#using-standard-headers-to-verify-origin)；浏览器 WS 的 upgrade/Origin/会话撤销参考 [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)。`SameSite` 和 Origin 不能替代服务端身份、CSRF 与归属校验。

现有浏览器 Voice SDK 的 WSS/WebRTC 连接到 Twilio，浏览器对本后端使用 HTTP/SSE；它不是上述未来的浏览器后端 WS。Twilio 再通过 `/voice/client` 与 `/voice/media` 接入后端。

Twilio 验签 URL 必须是同一固定 HTTPS origin + 原始精确 path/query，POST 使用所有收到的表单参数；代理不改写 path/query/编码，不根据任意 Host/forwarded 拼 URL。保留当前只在配置 origin 范围内验证 HTTPS/WSS 握手签名的兼容行为，用固定 fixture 验收，不能用多个任意候选绕过错误。Media Streams 按 [Twilio 官方要求](https://www.twilio.com/docs/voice/media-streams#communicate-with-twilios-media-servers)验证 `X-Twilio-Signature`；HTTP 签名输入按 [Twilio Security](https://www.twilio.com/docs/usage/security#validating-requests-are-coming-from-twilio)核验。签名证明供应商来源，不证明浏览器仍获授权，也不自动防重放。

每 lease epoch 使用新的 Twilio voice identity，签发短 TTL（建议 5 分钟、按需续期）的最小 voice grant。首版只做网页外呼，建议关闭 `incomingAllow` 并安全拒绝普通来电，待确认后再实现接听。`/voice/client` 必须要求服务器事先授权的 callSession + 短期一次性 join ticket，绑定 identity、owner、epoch、role；重试仅对同一已绑定 CallSid 幂等。回调里的任意 `To` 不得创建手机腿。注销/接管后拒绝旧 identity/ticket；不能假设已发 Voice JWT 能被立即撤回。cookie/租约/预算都通过后才允许创建手机腿。

## 防收费滥用与秘密存储

首版建议仅允许既有 `pocket-prefix` 外呼候选，真实云路径仍未验证；全局一通、每 owner 一通，服务端固定号码 E.164 allowlist、caller number 与 TwiML App，禁止客户端提供任意供应商 URL、引擎、转接、号码购买或录音选项。号码、预算或控制 lease 未配置时禁止拨号，不能沿用本机“任意格式合法号码”作为公网授权。

建议拨号尝试每 owner 每分钟 1 次；相同 idempotency key 重放只返回原结果，provider 创建结果未知不重拨。将来首次云端真人验收可提议一通不超过五分钟，**云电话/API 具体费用额度尚未授权**，旧本机测试额度不自动转成云调用授权；失败、刷新、重启或多个短测不能重新获得额度。建议设独立的总建立时限（现有 75 秒可作待测起点）、媒体接通后 300 秒上限，以及从最早电话资源创建开始的总墙钟上限；所有引擎都执行，不能只依赖 Pocket 当前接通后的 timer。

拨号前原子预留并持久化尝试数、两腿最大可计费时间及收尾余量、OpenAI 用量预算；结束后按可靠结果结算，未知结果保留预留并阻止新拨。额度默认禁止，具体每日次数、金额、目标国家/号码与费率由用户确认，不把历史剩余“免费额度”当现余额。两腿和 API 均可能产生费用；应用记账不是准确账户账单或绝对硬封顶。Twilio 已锁定 SDK 的 Call 类型支持 `timeLimit`，后续对适用腿设供应商侧时限并核验账户支持；[Call Resource](https://www.twilio.com/docs/voice/api/call-resource#create-a-call)说明具体约束取决于账户配置。供应商用量告警只能补充监控，[UsageTrigger](https://www.twilio.com/docs/usage/api/usage-trigger#callbackurl-requests)触发的是回调，不能当作自动停止收费的保证。

部署时登录 verifier、Twilio Auth Token/API secret、OpenAI key 放在运行平台受限 secret store 或只读私密文件，仅 Node 主服务可读；不进入镜像构建层、Git、CI artifact、页面设置、SSE、URL 或 stdout。opaque 会话无需新增 JWT 签名密钥。公网不提供当前 `/api/settings`、`/api/verify`、`/api/shutdown` 和桌面维护/恢复 API；运行管理通过独立受限管理面。Pocket 子进程继续不继承供应商秘密，模型与 YAML 仅按现有哈希校验和离线策略读取。

“仅 Node 可读”是部署隔离目标；当前只证明子进程未继承秘密环境变量，不证明同 UID 的文件/挂载或父进程环境已隔离。后续需以运行身份与 OS 权限控制，并实际验收 worker 无法读取这些秘密来源。

应用、代理、平台访问日志全部屏蔽 Cookie/Authorization/Set-Cookie、密码/verifier、CSRF/join ticket、nonce、完整 URL query、手机号码、CallSid、字幕及音频。只保留固定事件码、去敏关联号、聚合次数/用量和清理状态；需要真实 CallSid/nonce 的清理 journal 是私密运行数据，不是普通日志。设定权限、保留期与安全删除，不能靠 `logger:false` 假设入口代理也不记录。

## 失联、停机与重启后清理

SSE 断开只释放订阅；控制 lease 到期、Twilio media 断开、退出或总时限到期时，停止新音频/翻译/TTS，取消有界队列、拒绝晚到结果、关闭两腿并等待现有 provider cleanup 确认。挂断 API 的成功回应与 `safeToStop` 只有确认后给出；失败保留 `cleanupUnconfirmed`，不自动放开 busy。

私密持久 journal 必须先写入 principal/owner/call/role、创建 intent、预算预留、固定 callback origin 与受限 nonce，并原子提交/fsync 后，才允许任何电话资源创建。浏览器腿由 Voice SDK 在 Twilio 创建，因此 `/api/calls` 要在返回 join ticket/nonce 等连接许可前落盘 intent/预算，不能只记录 Node 的 REST `provider.create`。`/voice/client` 验证后先持久绑定浏览器 CallSid，再允许创建手机腿；手机腿同样先落盘 intent 再发 provider create，获得 CallSid 立即持久化。

网络超时可能是已创建但未收到 SID，保留 uncertain intent，接收经签名/账户/nonce/ticket 绑定验证的迟到回调并挂断，不再创建第二腿。重启/退出后旧 identity/ticket 不得接入活跃媒体或创建手机腿，但匹配已持久 intent 的旧浏览器回调仍走 cleanup-only，捕获 CallSid 并挂断；不能仅因 lease 已撤销就丢弃该回调、永久遗失未知 SID。回调终态、重复/乱序、重试与预算结算均幂等。

`SIGTERM` 先禁止新拨/新 lease，有限期尝试清理两腿，再关闭 SSE/worker；平台终止宽限需覆盖实际清理，不保证应用在 SIGKILL/OOM 时能执行。Pocket 是独占 detached 进程组，容器/监督器还须回收整个实例的进程树，不能只终止 Node PID。重启立即撤销旧登录和 lease，先进入 cleanup-only，通过 journal 处理已知/未知创建结果，不恢复通话、不重播旧 TTS；清空旧队列并重新离线校验/warm 模型。只能清理 journal 绑定的本应用电话，不能广泛挂断同账户其他通话。journal/预算存储丢失、损坏或恢复未确认时拒绝新拨，保留管理提示；不能用临时磁盘承担恢复保证。无法确认时人工核对，不能写“进程已停所以手机已挂断”。

## 单实例 warm 与分步验收

固定 HTTPS 域名与 WSS，cloud origin 与 `PUBLIC_BASE_URL` 一致；平台 `PORT` 绑定服务，公网仅通过明确 ingress，代理覆写客户伪造 forwarded、保留验签所需 URL，支持长 WS/SSE 并禁 SSE 缓冲。一个常驻 Node 进程 + 一个 Pocket worker，关闭 scale-to-zero/多副本、禁止滚动更新时两实例同时拨号，使用持久私密 journal/预算卷。双进程或卷锁冲突时 fail closed；公共 health 仅应用标识，内网 readiness 另含认证、存储恢复及 warm 状态。

资源只能先提待测起点：CPU-only 单实例 2 vCPU / 4 GiB RAM，是 Pocket、Node 与 scrypt 共同使用的实例/cgroup 总预算；scrypt 的 maxmem 不是额外独占或预分配内存。这不是采购规格或性能保证。取得历史完整 Python freeze 与审核资产后，测冷加载、warm、峰值 RSS、CPU 饱和、连续长句及 scrypt 登录与语音并行竞争，再确定资源/容器限制与终止宽限。Torch 的 intra-op 线程限制不代表整个 Pocket 进程只有一个线程。当前缺完整 freeze、真实 Linux 模型验证仍是部署阻塞；保留固定 Michael、版本/哈希、串行和队列上限，详见 [Pocket 云运行基础](CLOUD_POCKET_RUNTIME.md)。

| 阶段                      | 可审查完成条件                                                                                                                                                     | 当前状态                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1. 方案确认               | 确认本推荐身份方案、外呼范围、号码/预算、secret 管理与云资源边界                                                                                                   | 本文待确认；未生成配置                                       |
| 2. 独立实现与离线验收     | 模拟验证登录/到期/撤销、Origin/CSRF、两个 owner 越权、tabs/lease 接管、SSE 慢客户端、被盗旧 Voice JWT/ticket、伪造/乱序/迟到 Twilio 回调                           | 仅独立授权组件与 HTTP/浏览器 WS 离线测试；登录/lease/SSE/供应商接线尚未实现，继续保留 cloud guard |
| 3. 故障与资源验收         | fake provider 模拟 create 成功但超时、未知 SID、挂断失败、断线/后台页、SIGTERM/SIGKILL、重启/journal 损坏、持久预算、播放积压；已审核 Linux 资产离线 warm/资源实测 | freeze/资产材料及真实 Linux warm 验证缺失                    |
| 4. 授权后部署检查         | 仅在具体环境注入秘密，回读单实例/HTTPS/WSS/代理/存储，验证公网未授权401/403；先不拨号，不自动改既有回调                                                            | 未授权实际部署/秘密配置操作                                  |
| 5. 授权后供应商与真人验收 | 明确 API/费用额度后验证并安全迁移已有回调；再由用户操作 Chrome 麦克风与一通普通手机测试，记录两向、数字否定、持续跟随、积压、清理及耳听                            | 尚未验证；不以字幕模拟、mark 或配置代替                      |

## 后续执行前需要用户确定的具体配置

以下只是清单，不是新的环境变量实现或本轮权限请求。已授权的锁定开发依赖、云端代码工作、开发分支推送和草稿 PR 不重复询问；实际操作超出本轮时再针对具体目标确认。

| 决定/材料        | 具体范围与授权目标                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份与密码       | 是否采用此单账户 scrypt 方案；稳定账号标识/登录名、独立密码 verifier 的生成与写入位置、管理者、轮换/撤销方法。不在聊天或仓库提供明文密码/hash/salt。                                     |
| 运行秘密         | 哪个已批准云服务可读取现有 Twilio/OpenAI 凭据、从哪里安全注入、是否需要新 key/新增平台访问权限。没有默认授权创建 key 或把秘密搬到任意平台。                                              |
| 允许电话与预算   | 已有 caller number/TwiML App、接收号码 allowlist、外呼候选、提议首次一通不超过五分钟及需单独批准的 API/电话费用预算、后续每日上限/金额、未知清理时人工处置。新增来电/录音/转接另行确认。 |
| 云入口与资源     | 云平台/项目、地域、固定 HTTPS 域名或既有域名 DNS/TLS 操作、`PORT`、可信 ingress/proxy 范围、单实例 warm、经实测后的资源、费用上限与部署时段。任何付费资源或生产发布另行授权。            |
| 私密持久数据     | journal/预算存储位置与权限、加密/保留期、故障恢复方式；需要平台卷/secret 功能及其费用时先确认。                                                                                          |
| Pocket 材料      | 已有完整 freeze 和模型资产的安全来源/交付边界；不得连接用户电脑提取，不即时下载模型或猜版本。审核后才确定可复现 Linux 镜像。                                                             |
| 供应商迁移与验收 | 具体已有号码/App 的当前与目标 callback URL、空闲窗口、备份/回读/回退方案，及明确的一通/API费用额度；本轮不沿用历史桌面改绑授权实际执行云迁移。                                           |

本文推荐不包含零延迟、本人声音克隆或长期生产可用性承诺；保持中文→自然英文、英文原声→电脑加中文旁路字幕，实际通话与费用须分别验收。
