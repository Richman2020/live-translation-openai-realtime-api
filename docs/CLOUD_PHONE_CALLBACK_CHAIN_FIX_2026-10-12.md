# 固定 Twilio HTTP 与媒体回调链修复（2026-10-12）

精确基线 `4f34fa313173e62d370e5f78c0780e4506848420`，分支
`codex/cloud-phone-conversation-callback-chain-fix-20261012`。
用户自行发布deployment `922a6a82-1039-41ec-9356-4a1f6ab547ce`，
02:55:23 UTC SUCCESS。父线程报告02:56:10真实 `/voice/client` 200，
随后同一通电话的 `/voice/stream-status`、`/voice/status`、
`/voice/connect` 403，02:56:39挂断200。具体后三路响应分类尚未提供，
不能直接宣称真实拒绝全部也是重复头；不复制真实session/nonce/join等参数。

## 确定代码缺口与最小边界

上一版头兼容只分类精确POST `/voice/client`。后三个带query的HTTP
回调和media升级仍使用旧的全头唯一/代理元数据校验。这是确定代码缺口，
真实HTTP红例已证明实际生成的stream-status URL及官方签名media握手遇
普通重复头或代理链都会403；这些样本不冒充真实原请求头。

现在只分类既有POST `/voice/client`、`/voice/connect`、`/voice/status`、
`/voice/stream-status` 的form+非空签名候选，以及独立的真实upgrade+GET
精确 `/voice/media`+非空签名候选。普通头及代理元数据完全剥离；Host、
签名、framing、所有sec-/x-phone-及原认证相关头仍严格唯一/规范化。
现有Connection/Upgrade/Key/Version/Accept检查、head与body大小/超时保持。

原validTarget不变：client不能query，后三路保留既有query，media禁止query
且只能升级。incoming不开放，浏览器API/本地管理/未知HTTP和WS不豁免。
不能startsWith('/voice/')泛化或用UA授权。分类只提取固定path枚举；转发
仍使用原req.url，官方HMAC仍为PUBLIC_BASE_URL+完整req.raw.url（含原始
query）+完整form。media保持固定HTTPS/WSS两个既有URL候选+{}验签。

媒体101不是通话授权。原start仍检查AccountSid、session/role/nonce、已绑定
CallSid、StreamSid、8kHz单声道μ-law、无重复socket、session有效与当前
admission，之后才attach bridge。SessionManager/security.ts不修改，迟到
签名状态仍参与终止与清理，不因为控制权失效直接丢弃。

## 固定诊断

各固定路由的入口、签名和业务403分类及媒体start失败均只记录固定event、
五个固定path之一和固定reason。client原事件保持；其他路由使用
CLOUD_VOICE_CALLBACK_REJECTED。未知reason变固定fallback，未知route不记，
运行时错误类型和日志sink失败不影响处理。不记录req.url/query、任意header
名/值、签名、token、nonce、join、SID、号码、身份或原始异常。

## 验证与交付

完整生产parser/createCloudService/Google RSA与PKCE/实际client.dial/
public ingress及private媒体upstream组合由明确fake provider/bridge验收。
要求local start→fake bridge ready→fake remote create（捕获真实生成的
callback URL）→签名connect/status→remote start→双方stream-status及
terminal/end清理；不以clientTwiML、unsigned403或仅connected后关闭替代。
关键头、完整URL/query/form签名、account/nonce/SID与媒体start负向继续拒绝。
最终结果见 [PROGRESS](../PROGRESS.md) 与交付记录。

本任务不stage/deploy、不建Railway patch、不实际拨号/付费调用、不改资源/
凭据/依赖；父线程协调已授权AI发布，portal/商机保持暂停。新版真实
回调、真人双方音频与译音仍需父线程验收，隔离通过不替代。
