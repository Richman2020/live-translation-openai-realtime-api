# AI 电话自动控制修复与新版发布方案

2026-10-13；执行位置为本云端，dot 负责协调和验收。用户本轮只授权修复、离线回归及新版发布方案；旧候选的一次发布已由用户完成，不授权本候选上线。

## 版本与真实通话证据

- 修复基线：`95ab05593863c004abbf2d355c4bcaa4f8caaf0e`，原交接基线 `4f34fa313173e62d370e5f78c0780e4506848420` 不变。
- 工作目录：`/workspace/ai-phone-cloud-recovery-20261012`；新分支 `codex/ai-phone-auto-control-fix-20261013`。沿用现有依赖，保护此前未提交的 PROGRESS、附件、原工作区和审计报告。候选完整 SHA 以提交后的外部验收回执为准，避免在同一提交内自引用。
- 只读核对实际运行部署仍为 `887f89bd-1c1a-449b-a545-d92f7641942a` / 完整 SHA `95ab05593863c004abbf2d355c4bcaa4f8caaf0e`，SUCCESS。用户于北京时间约 11:48 实际接通，开头中文与英文已使用且对声音、翻译满意，随后中断。这是初步实测成功，不是完整通话验收。
- 日志读取范围为 UTC 03:47:00–03:51:30；部署日志 0 条、HTTP 27 条，没有达到读取上限。仅保留固定路径、时间、状态，不保存查询参数、SID、完整号码、身份或转写。

| 北京时间 | 观察到的事件 | 结果 |
| --- | --- | --- |
| 11:48:00.157 | `/api/controller/acquire` | 200 |
| 11:48:01.169 | `/api/calls/:id/voice` | 200 |
| 11:48:04.975 | `/voice/client` | 200 |
| 11:48:10.460 | `/api/controller/renew` | 200 |
| 11:48:20.758 | `/api/controller/renew` | 200 |
| 11:48:30.438 / .441 | `/voice/media` 两条长连接日志 | 平台状态 0，不能解释为标准 HTTP 成败 |
| 11:48:30.525 | `/api/calls/:id/hangup` | 200 |
| 11:48:30.815 | `/api/controller/revoke` | 200 |

两次续约成功，挂断响应也完成原来的最终控制授权复核，因此不能将“没有续约、最初 30 秒控制租约自然到期”写成已证实原因。若身份期限不更早，第二次续约按源码应延至约 11:48:50；日志没有身份期限或响应体，不能据此断言实际到期时间。窗口内没有上述回调的 403，回调 body 缺失，204 不能还原具体终态。

旧界面的“浏览器电话连接失败，正在确认线路清理”对应 SDK Device 错误清理路径。锁定 SDK 2.18.5 的信令 31205 会产生 AccessTokenExpired（20104）并发出 Device error；旧实际 JWT 与一次入场票据均使用约 30 秒期限，控制续约不会刷新 JWT。这是已确认的代码缺陷和本次中断的候选解释，缺少本次浏览器 SDK 错误码，尚不能确证它先于租约、媒体断开或供应商终态。部署日志为空也不证明没有事件：该入口没有独立输出这些生命周期事件。

## 最小修改与保留边界

| 修改 | 实现 | 验证边界 |
| --- | --- | --- |
| 拨号自动控制 | 登录后显式拨号沿用自动 acquire→权威状态复核→开始通话；移除手动取得、续约、保持开关及控制倒计时 | 登录、普通 GET 不授予控制；无需用户续约 |
| 接通后不依赖浏览器续约 | 原调用、标签页、lease/epoch/私密证明全部匹配的 SDK accepted 状态不因旧本地 expiresAt、页面隐藏、SSE 重连或浏览器计时暂停自挂断 | 接通前入场仍有期限；不能凭公开状态恢复私密证明 |
| 服务端有限自动维持 | 已通过原媒体身份/nonce/SID 校验的 local stream 才绑定控制；每 10 秒私有随机 ping，匹配 pong 更新有限 30 秒连接期限 | 不以 OPEN、静音模型输出、浏览器 GET/SSE 或客户端声称在线续命；迟到/错误 pong、超时、倒退时钟、关闭连接不能复活 |
| 区分入场与信令期限 | 一次入场票据仍约 30 秒且一次使用/SID 绑定；实际 SDK JWT 单独有界，最多 15 分钟且不超过已有认证期限，发送前再次校验 | 不开放 incoming、不新增刷新令牌端点、不忽略 SDK 错误、不扩大账号权限 |
| 挂断与失败重试 | 用户挂断先停媒体和模型，再清理两腿；未确认时仅原身份、CSRF、call ownership 和私密 tab/lease/epoch 证明可重试已接受结束的原通话 | cleanup-only 不恢复控制、不授权拨号/加入/续约；迟到旧清理不能结束下一通；清理未确认继续阻止新通话 |
| 状态竞态 | 新鲜权威 idle 可结束遗漏终态的旧 accepted SDK；接通前发出的旧读取不能影响后来接通的通话。接通后的同归属状态/续约成功响应仅旧期限已过时，重新读取权威状态而不误清连接 | 身份/控制不匹配、鉴权拒绝、服务器终态仍有效；不凭旧回复获得新通话准入 |
| 取消准备后的页面状态 | 返回工作台时只读刷新权威状态，清除服务端已经确认空闲而页面残留的准备/清理投影 | 不取得或续约控制，不手动清除忙碌/未确认标志；服务端尚未空闲仍拒绝拨号 |

身份认证、CSRF、所有权、跨标签页防抢占、供应商签名、正常远端终态、真实浏览器/媒体错误、手动挂断均保留。个人 cloud phone 继续不装配应用金额预算、预算 journal 或应用通话时长限制，`maxCallMs:null` 与个人准入不变；仅保持既有 legacy 路径兼容和供应商技术边界，不读取、写入或删除旧预算账本。没有恢复已撤销的 5 美元/300 秒门槛。未改变语音、翻译、字幕算法、供应商或号码配置。

现有登录仍约 15 分钟闲置、8 小时绝对期限；没有在本轮修改。信令 JWT 上限也不是新的通话时长承诺。cloud↔Twilio 的 ping/pong 只证明该段传输存活，不证明浏览器音频或翻译正常；浏览器↔Twilio 真正断开仍依靠 SDK、签名终态/流停止及有限超时清理。清理与供应商停止计费均不能保证瞬时完成，不能把拒绝迟到浏览器加入写成供应商零费用。

## 本轮离线验证

使用既有 Node/npm、锁定依赖及 Chromium 151，无安装或锁文件变更。所有供应商/Google/媒体测试均为本地离线替身，真实电话及付费模型调用为 0。最终冻结后的命令、实际数量和日志索引在 PROGRESS 最新记录及外部候选回执中列明；中间成功与失败日志分别保留，不沿用旧包或旧 CI 数量。

| 实际命令 | 结果 |
| --- | --- |
| `npm test` | 最终 1324 总、1319 通过、5 个既有 Windows 跳过、0 失败/取消 |
| `npm run typecheck` | 通过；源码及测试 |
| `npm run build` | 最后导航修订后重新通过 |
| `node --import tsx --test tests/controller-lease.test.ts tests/cloud-phone-access.test.ts tests/cloud-phone-integration.test.ts tests/controlled-browser-entry.test.ts` | 后端专项 95/95 |
| `node --import tsx --test tests/controller-client.test.ts tests/controlled-browser-entry.test.ts` | 最终前端专项 87/87 |
| `node --import tsx --test tests/cloud-service.test.ts tests/cloud-voice-join.test.ts tests/cloud-budget-journal.test.ts tests/cloud-call-cost-bound.test.ts` | 信令/入场及 legacy fixture 66/66 |
| `node --import tsx --test tests/cloud-personal-call.test.ts tests/cloud-provider-usage-integration.test.ts tests/continuous-cloud-session.test.ts tests/session-journal-integration.test.ts` | 既有准入兼容 48/48 |
| `npm run test:google:browser` | 29/29；外部请求、真实供应商调用及异常均 0 |
| `npm run test:controlled:browser` | 最后导航版 Pocket DOM 82/82，外部请求/真实供应商/异常均 0 |
| `npm run test:controlled:continuous:browser` | 最后五会话 DOM 88/88，外部请求/真实供应商/异常均 0 |
| `CONTROLLED_BROWSER_TRANSLATION_ENGINE=continuous-captions CONTROLLED_BROWSER_OUTGOING_PAIRED_CAPTIONS=false npm run test:controlled:browser` | 最后导航版默认三会话 DOM 85/85，外部请求/真实供应商/异常均 0 |

浏览器脚本的 `CONTROLLED_BROWSER_OUTGOING_PAIRED_CAPTIONS` 是离线测试开关，不能与生产变量 `CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED=false` 混同。另两份修改 JS 的 `node --check`、两份浏览器脚本的独立 TypeScript 检查、六个修改 TS 源文件 ESLint/Prettier 及 `git diff --check` 通过。完整 argv 和日志哈希存外部回执。各专项包含重复覆盖，不相加为全量数量。

收尾将前端单测及 controlled browser harness 中语法树完全未改的旧语句恢复为基线排版，避免整文件格式差异。恢复前后完整 AST 的节点顺序、标识符/字面量、声明及 type-only 标记一致；八产品源码全文不变。恢复后重跑 87 项前端专项、typecheck 和两浏览器脚本编译通过。DOM 输出对应同一最终产品及相同 harness 逻辑，未把排版恢复冒充另一次 DOM 执行；证明及前后副本保存到资料目录。

未执行新版本 Docker 镜像构建/Hosted CI、新版本公网运行/供应商实际信令、耳麦与手机复验；它们不以旧 CI 或旧真实通话替代，交后续新版发布及本人实测阶段。

专项包含健康静音跨原控制期限、无需手动续约、真实浏览器后台冻结超过 30 秒、错误或缺失 pong、跨标签页拒绝、用户挂断、超期清理失败重试、正常远端挂断、SDK 通用及过期错误、迟到状态/Device/创建结果、登录注销/CSRF/epoch 和回调身份签名回归。

独立审查由另一个代理执行，区别于实现者自检。发现的迟到旧 bootstrap、接通后同通旧 deadline 投影问题已修复并补边界回归；同时闭合迟到 renew 同类问题。最终八份产品源码独立审查无未解决阻塞；cleanup-only 只结束原通、导航只读刷新以及 SDK/JWT 有界性均已复核，源码哈希及候选提交绑定单独保存。独立 SDK 审查记录本次真实 SDK 错误码缺失。没有问题的审查结论也不等于真实通话验收。

过程中失败/修正单独保留：浏览器虚拟时间与服务端墙钟不一致改为真实后台冻结；立即撤销导致失败挂断不能重试，已用 cleanup-only 修复；签名终态实际 HTTP 204，纠正旧测试期待 200；新鲜 idle 必须清理遗漏终态，同时旧投影不能误杀新接通；Google harness 的旧按钮引用改为新契约。默认三会话曾在 history→workspace 的“New controller after navigation”等待拨号超时：取消未发布的准备通话时旧读取可留下 busy，返回工作台现在只读刷新，仍由后端确认 idle。另一次 Pocket 最后 observer 拨号等待 active 超时没有稳定确证原因，不能把复跑通过写成已经解释该偶发超时。

五会话 final3/final4 在同一 observer-close 场景得到真实 `CONTROLLER_BUSY`，没有进入 `/api/calls`。失败后的公开 idle 不能还原拒绝瞬间的具体忙碌来源；仅等待 manager 空闲或一次公开 idle 不足以排除独立预约释放尚未完成。离线 harness 最终等待真实 injected reserve/release 完成记录、controller available、busy=false、activeSession=null，再刷新测试页面；只观测原 acquire 的 busy 入参，不改变其决定，不强制释放，不延长/关闭产品校验。产品代码未变，唯一必要的五会话 final5 完整 88/88 通过；原失败保留。格式检查初次指出两份新增测试的格式，修正后复查。所有结果及限制同时交 dot。

## 未完成与新版发布方案（交 dot 验收）

1. dot 审阅本次精确本地候选、相对 95ab055 的完整差异、独立审查和离线结果；旧 PR #4 / CI 38329410460 只覆盖旧版本，不能作为新候选 CI。
2. 获得新候选推送/草稿 PR/CI 范围后，非强制推送专属新分支，比较 base 为原恢复分支的精确 95ab055；先核实际 base/head/tree，避免夹入 main 的历史差异或他人提交。触发并等待新候选必要 CI，不重复旧 CI。
3. 新版发布需要本轮候选的单独授权；只限项目 `ai-phone-portal-trial` / `145aa27a-3a84-4e4d-91f9-b97f33bf6d42`，staging `c5db5ddb-26b6-48ce-b920-dc1ebbe30fa8`，`ai-phone-test` / `407bede7-11b6-4260-b055-a8045dc71588`。核当前线上及暂存无他人变化，精确 pin 新候选且只发布一次；不合并 main、不操作 portal-test、不新增资源/升级 Hobby。原配置沿用，没有本修复要求的变量、权限或供应商调整。
4. 回退参考为现已实际通话的 `887f89bd-1c1a-449b-a545-d92f7641942a` / 95ab055；保留更早 `922a6a82-1039-41ec-9356-4a1f6ab547ce` / 4f34 的历史记录。回退也需说明影响并获得对应授权，不自动重发/回滚。新发布前重新核对平台可回退状态，不能把旧 canRollback 当未来保证。
5. 部署后核 actual deployment/SHA、phone 启动日志、健康及 `https://ai-phone-test-staging.up.railway.app/controlled` 页面。公共网页若仍受本云网络限制由本地检查，不能写成云端实际 GET 已通过。部署/健康不代替通话验收。
6. 真实复验由用户本人点击拨号，目标末四位 1406 已获本人确认，不再重复问号码。拟验前台与后台跨旧 30 秒、双向原声/翻译/字幕、手动及远端挂断清理；次数/时长/Twilio+OpenAI 预算应另行确认，旧“1 通、≤2 分钟、$2”仍只是建议。发生异常先结束并保存同一次通话时间与脱敏事件，避免连续重拨。

两服务资源预算仍 $3 提醒、最多 $4 由用户决定关停，提醒非硬封顶；电话/模型另算。既有配置核验保留，不退回已完成的配置等待。本轮无新推送、PR、CI、Railway 写入或真实电话。
