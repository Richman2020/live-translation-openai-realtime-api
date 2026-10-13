# AI 电话稳定性、字幕阅读与分段修复（2026-10-13）

本轮从 `22c81aba16055d950c6049162d40dad36e8ab8d0` 在原恢复工作树继续，只修改通话身份维护、必要故障诊断和字幕文字/布局。未推送、触发新 CI、部署、拨号、连接付费模型、安装依赖、改变供应商或账户配置；不含休眠优化。最终完整本地候选 SHA 由本轮提交回执和 PROGRESS 记录。

## 线上与本通证据

- Railway 只读回读：`ai-phone-portal-trial / staging / ai-phone-test`，部署 `83536c9b-c8d3-4f17-a84f-16a1460459fa`，SUCCESS，部署 meta 和 source pin 均为完整 `22c81aba16055d950c6049162d40dad36e8ab8d0`，无待应用变更。此次回读不涉及 portal-test。
- 2026-10-13 北京时间：14:38:53 容器启动；14:39:52 Google callback 返回 200；14:43:06 创建电话；14:46:10.515/.525 两条 `/voice/media` HTTP 连接结束（176.259/181.217 秒）；14:46:10.708 最后一次控制续约仍 200；14:46:10.739 才收到页面 hangup。18 次续约全部 200，相关 Voice callbacks 无 4xx/5xx，通话窗运行日志无可用首因。
- hangup 请求可由页面故障清理自动发送，**不证明用户手动挂断**。媒体先关闭也不证明对端、浏览器或 OpenAI 是故障发起方。按 14:39:52 登录和当前默认 15 分钟 idle，不能把这通结束归因为“拨号时身份只剩三分钟”；当时未记录实际 JWT 数值期限或供应商关闭原因。
- 该通 Twilio Call Details / Request Inspector / 错误事件尚未取得；当前工具没有 Twilio 通话详情入口，不创建凭据或重复要求用户提供接口读不到的配置。供应商 session expiry、具体媒体 close code 和最初终止事件仍未确认。新增诊断供后续同次通话对齐，不能倒推本通根因。

## 已核查的应用限制

| 检查 | 个人云 phone 当前执行路径 | 本轮处理 |
| --- | --- | --- |
| 金额/测试预算 | `createCloudService` 不装配 budget journal / providerUsage，个人 admission 只占用一通 | 保持；未重加金额闸门 |
| 固定总通话时间 | `SessionManager.maxCallMs = null`；无 journal 时不发送 Twilio `timeLimit`；两腿接通后清除 setup timer | 保持；**未发现或声称删除不存在的 180 秒计时器** |
| 测试截止时间 | `createCloudTestDeadline` 是未装配的历史 helper；phone 配置不读取 `CLOUD_TEST_DEADLINE` | personal 服务不使用它。平台只返回变量名，现值未读到，不能把“存在”当生效 |
| 旧 180 秒维护租约 | local 空闲 connection-maintenance，活动通话不能进入，cloud controlled 路径不开放 | 不属于本通时长上限，不扩展处理 |
| 身份/JWT | 旧 idle 未由健康通话维持、SDK warning 未刷新令牌，是确定静态缺口 | 正确续期，保留鉴权与有限凭据；不是这通 181 秒根因证据 |

真实断线、媒体匹配 pong 失联、授权撤销、用户/对端挂断、供应商错误仍清理两腿。15 分钟 idle 可由原 owner 的已验证健康本通维护；原 **8 小时绝对认证边界保留**，达到它仍安全清理，不能承诺任意时长永不结束。Railway 3 美元提醒/接近 4 美元由用户决定关停的资源约定保持独立；供应商账户限额、Hobby、凭据和权限未变。

## 修改清单

1. `google-login.ts / cloud-phone-access.ts / cloud-voice-join.ts / cloud-service.ts / server.ts`：显式拨号前复用 CSRF 保护的身份 renew；服务器仅以原身份仍有效、当前本通 owner/controller/SID 与匹配媒体 pong 维护 idle；新增 `/api/calls/:id/voice/refresh`，同 identity/application、`incomingAllow:false`、有限 JWT、原单次 join/nonce/SID 和 occupancy 不变。签名后、最终 onSend 和前端代际均重验；初次 pong 尚未收到只返回可重试 409。
2. `controller-client.js / controlled-workbench.js / voice-token-maintenance.js / cloud-ingress.ts`：当前 accepted Device 内 `updateToken`，单请求合并、有限重试、隐藏/节流恢复检查；不重新注册、接通、拨号或复活已退休媒体。手动挂断/退出中的迟到响应丢弃。SDK 文档提示 updateToken 可能短暂影响音频，离线替身不能证明实际无缝。
3. `call-termination-diagnostics.ts / session-manager.ts / continuous-translation-client.ts / remote-caption-client.ts / continuous-translation-bridge.ts`：首次结束意图只记录一次固定原因、层、方向、数值时间/elapsed/WS close code及可用 session expiry；区分 native、字幕 ASR/文字连接关闭及超时，非致命字幕失败不污染后来的结束。生产 signer 仅记数值 JWT/auth 期限。无密钥、号码、SID、原异常、close reason、语音或正文；日志 sink 失败不阻断清理。`CALL_END_REQUESTED` 为中性应用请求，不能标为用户手动。
4. `styles.css`：仅 controlled 标记页面的字幕主区加高、中文 17px/英文 13px，非核心拨号/状态压缩，挂断 44px 目标保持可见。原 scroll 节点和历史阅读/回到最新保留，非 controlled 页面尺寸不变。
5. `caption-sections.ts / remote-caption-client.ts / continuous-translation-bridge.ts`：原先每个 400ms VAD ASR item 的 completed 直接生成一条 final，并按碎片翻译；现在 completed 只是稳定识别片段，累计同来源草稿、可靠自然句终/长发言分段后定稿，中文是对应原文的增量修订。普通字幕 idle 1.6 秒；≤3词或尚需后文的尾词保留 draft 到 4 秒或明确来源/结束边界。稳定片段立即申请中文 draft，delta 节流 350ms；这些是文字分段窗口，不是通话限制。长 source 按真实子句 substring 拆分，保留全文；旧整段中文清除并按准确子段重译。`ection` 不猜补字。只实现 local/remote 来源隔离，没有经验证的多人声纹/远端多说话人 diarization。

原 native 音频模型、声音、三会话默认供应商方案、400ms VAD、audio send/play/流控及故障清理策略保留。字幕累计翻译的请求文本可能变长/修订增加，不能将离线测试当真实费用或延迟保证。

## 本轮验证

| 命令/检查 | 最终结果 |
| --- | --- |
| `npm test` | 1397 total；1392 pass、5 Windows 条件 skip、0 fail/cancel |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm run test:controlled:browser` | 84项通过 |
| `npm run test:controlled:continuous:browser` | 90项通过 |
| `CONTROLLED_BROWSER_OUTGOING_PAIRED_CAPTIONS=false npm run test:controlled:continuous:browser` | 87项通过；三组外部请求/真实供应商调用/浏览器异常均0，Chrome151 |
| `npm run test:google:browser` | 29项通过；合成OAuth/RSA全部截获，真实供应商调用/外部请求/异常均0 |
| 收口 ingress 格式与检查 | 新 refresh regexp 仅参数换行/尾逗号；前后规范化AST一致，`tests/cloud-ingress.test.ts`15/15复跑通过；其余30项冻结输入不变 |
| 三视口同稿布局/历史条/展开状态/挂断命中/无 zoom 检查 | 通过；桌面 1280×900 净高 178.6875→518px、面积 3.4944倍；1366×768 46.6875→386px、面积 9.7498倍；mobile 首屏原0→464px，不除以0计算倍率 |
| 本轮 server/SDK 回归 | 健康本通 260 秒跨181秒/初始JWT及idle期限、后台不靠浏览器续租、观察页不续权；身份绝对到期/手动挂断/真实失联仍清理；旧响应与第二标签不能抢占 |
| 字幕回归 | `for the` 真实暂停2050ms仍draft，续接同ID；A→B→A修订、长source自然子段、中文旧稿清空、不同来源和finish清理 |

独立审查找到本轮 A→B→A final 与旧 active revision 不匹配的 P2：旧 A 请求错误升级后被 revision fence 丢弃，可能缺最终中文/finish超时。已增加 active revision 相等条件及回归；修前红、修后绿证据保留，非本通线上22已证实原因。独立最终审查、音频 AST 边界及冻结哈希由资料报告绑定，不把实现方自检称独立审查。

5 个 skip 为 Windows PowerShell/process identity 与 ACL/原子 env 文件专用用例；本云 Linux 未执行。中途字幕路由/认证测试断言和独立 P2 红用例的失败保留，修复后对应检查通过；不引用旧包、旧1324测试或旧CI数量作为本轮成绩。

定向 ESLint 最初有新增 ingress 行排版错误，已只在该行修复并验证AST相等，ingress定向lint通过。全组仍有 bridge 原 `++providerConnectionSequence` 的1个既有 no-plusplus error 和2个安全production console warning；未顺带改变旧音频/提供方序号逻辑。此lint限制不写成测试全失败，也不隐藏为全组lint已通过。初始冻结清单保留；最终31项清单 `verification-inputs.final.json` SHA-256为 `cb390d4f021bd8272faad19fedd729673a59b69c2ba558edffa32d9b99e1c40e`，只有上述非功能格式差异及独立复核说明。

## 待 dot 核对

最终候选仅本地；本轮未推送、未触发CI、未发布，线上仍22。dot 核对候选、测试和页面截图后再安排新发布授权及用户亲自试打；不重复本地 Codex 验收，不用旧发布授权部署本候选。真实181秒断线原因、实际刷新音频连续性、长英文分段/中文质量与媒体挂断效果仍需供应商记录和随后用户实测，离线通过不构成真实通话验收。

资料目录：`/workspace/ai-phone-reference/phone-stability-captions-20261013`。保留旧 PROGRESS 副本、原附件/ZIP/审计及旧浏览器产物；原工作区44文件、受保护附件/需求资料19文件与锁文件/AGENTS 哈希独立复算不变。`runtime-evidence.json` / `startup-auth-evidence.json` 只含脱敏事件路径和时间；`verification-inputs.json` 绑定本轮代码测试输入。当前 cloud 模式布局截图为离线样例，无真实电话或模型。
