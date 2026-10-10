# Google单账号登录代码与真实配置门槛

日期：2026-10-09；继续基线 `3d4660bcaac1beddc5c74f574329b383b8827dc5`。
用户已选择Google和一个工作身份。真实邮箱、测试电话、客户端和秘密均不写入
仓库；示例与测试使用合成身份。此文档描述代码和离线验证，不能代替真实
OAuth客户端创建、账号授权、secret注入或持续访问扩展的单独确认。

## 提供方验证

`GoogleOidcClient`仅使用固定Google授权、token与JWKS端点；不接受请求提供的
issuer/discovery/jku/x5u地址。只请求`openid email`、在线authorization-code
流程，不请求refresh/offline或其它Google API权限，也不保存access/refresh token。

使用既有Node内置crypto/fetch，无新增依赖。token交换和RSA签名验证异步进行，
有并发、请求时间、响应体、JWKS数量/缓存/刷新上限。JWT严格校验RS256、kid、
规范base64url/UTF-8、重复JSON键、issuer、单client audience/azp、iat/exp/nbf、
nonce及明确配置的唯一邮箱，`email_verified`必须是布尔true。principal使用
规范issuer和稳定sub，不能把浏览器提交的邮箱当身份。只接受本client原始的
当前验证结果对象，普通JSON或复制字段不能签发会话。

官方依据：[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)、
[Google ID token验证](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)、
[OIDC ID token规则](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)。
Google明确区分其对邮箱的权威性：非Gmail工作邮箱仅有`email_verified`不足以
证明当前邮箱所有权。代码要求实际signed `hd`匹配明确配置的Workspace域，或
匹配事先由用户核验的固定Google subject；两项都配置时两项都须满足。不猜测
此工作账号是否Workspace，也不把邮箱后缀当作组织成员验证。

## 浏览器事务和当前会话

`GoogleBrowserLogin`通过显式依赖拥有同一个`CloudAccessPolicy`，仅当真实应用
`browserControl.policy`与其完全同实例时可接线。默认生产入口不创建或注入
Google客户端；缺配置不提供可用登录。两个cloud启动保护和实际loopback要求
保留，不以模拟登录通过解除公网拒绝。

| 路径 | 边界与作用 |
| --- | --- |
| `GET /auth/status` | 固定来源的非秘密能力提示，不返回clientID、邮箱或凭据 |
| `POST /auth/google/start` | 精确Origin与同源自定义header，服务器生成一次state、nonce与PKCE S256；短期HttpOnly/Secure/Lax的`__Host`绑定cookie |
| `GET /auth/google/callback` | 固定callback顶层导航，唯一参数、浏览器绑定与一次state；先消费，再异步交换；最终当前flow/代际/期限同步检查后才提交会话 |
| `POST /auth/google/cancel` | 同源显式取消该浏览器flow，迟到验证/响应不能恢复 |
| `POST /auth/logout` | 当前cookie/精确Origin/CSRF，同步撤销及epoch失效，旧cookie、proof和准备中旧登录失效 |
| `POST /auth/session/renew` | 当前cookie/来源/CSRF的显式闲置期限续约，受绝对期限限制；只读/SSE不会续登录 |

正式opaque随机`__Host`会话cookie为Secure、HttpOnly、SameSite=Strict、Path=/，
不设Domain或持久Max-Age；服务端默认绝对期限8小时、闲置15分钟，配置仍须在
真实启用时确认。跨站callback落到固定、无密、禁缓存/禁脚本HTML，再进入
无query的`/controlled`，避免跨站redirect链遗漏Strict cookie。新登录轮换凭据
和CSRF；完整验证结果不会交给网页。失败只返回固定代码，不显示提供方文本、
code、token或secret。

当前registry有界、仅内存。同步resolver只查已建立的当前记录，不执行异步
Google交换或网络；每次policy检查重新查询，logout立即生效。登录重启全部
失效，不恢复旧浏览器权限。它不是持久预算或电话journal，也不证明崩溃后
线路责任已恢复；该门槛继续见[事务恢复](CLOUD_TRANSACTION_RECOVERY.md)。

## 本轮与后续输入

源码与假提供方测试使用实际RSA/JWKS、真实应用路由及浏览器cookie/导航，
测试中的提供方均为显式离线fake，未创建真实OAuth客户端、向真实token端点
交换身份或授权实际账号。另只读核对了Google公开discovery/JWKS的当前形状。
`GoogleOidcClient`不注入fake时使用原生HTTPS fetch；真实接线将联网，仍须
单独确认真实客户端和账号授权。
现有Pocket Michael、英文原声回程、逐句字幕与默认local流程继续。精确结果
见`PROGRESS.md`及当前提交CI；官方Pocket材料现状见
[本轮下载审计](POCKET_CLOUD_MATERIALS_2026-10-09.md)。

后续最小操作：确认该工作账号的Workspace域或核验固定sub；确定固定HTTPS
云域名和完整callback；单独批准创建Google Web OAuth客户端、所需同意屏设置
和运行环境secret注入；确认持久事务/恢复及Railway Hobby单实例运行输入。
区域、域名、资源额度和持久化尚未选择，不创建资源或部署。

当前不拨号或调用付费API。后续首次真人测试仅本人已提供的美国号码，
Twilio+OpenAI本轮合计最多5美元、不自动充值；该数字是批准上限，尚不表示
持久费用预算代码或费用核对已经实现，真实调用前必须完成它们。
