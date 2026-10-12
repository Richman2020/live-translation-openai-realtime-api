# AI 电话回调验证与今晚试打发布方案

记录：2026-10-12 17:43，北京时间。主执行：本云端聊天；dot协调与验收。

当前优先目标是今晚让用户进行一次真实外呼翻译测试，先恢复可测试通话链路。完整28条需求保持，字幕、声音、页面保持登录、来电等未完项不被删除，也不作为此次回调候选的等待条件。

锁定依赖已安装，回调/安全109项、全套1285项通过且5项既有Windows专属跳过，类型与构建通过，三个相关离线浏览器场景通过。独立审查没有发现此次补丁引入的阻塞问题，未追加业务修复。真实电话、模型握手与线上403恢复仍未验；下一步是审批远端同步和仅AI staging发布，完成配置/供应商核验后由用户发起一通试打。

## 精确版本与成果保护

- 实际目录：`/workspace/ai-phone-cloud-recovery-20261012`。
- 分支：`codex/ai-phone-cloud-recovery-20261012`。
- 复验业务/测试提交：`109977e2e317b1fd640ce59101f5047ca891454f`。
- 独立审查基线：`4f34fa313173e62d370e5f78c0780e4506848420`。
- 检查前目录/分支/HEAD正确且干净；安装和全部运行检查后350个原tracked文件内容都不变，没有源码/测试/锁文件修复。
- 本次PROGRESS与此报告是后续记录提交；最终交付SHA见 `/workspace/ai-phone-reference/verification-20261012-109977e/final-candidate-receipt.json`。最终仅记录变化，业务/测试树仍与上述已复验提交一致，并需审查代理最终确认。
- 原工作区、原附件、需求审计和旧恢复报告均保留；不reset/覆盖旧成果，不应用AGENTS历史差异。

## 安装结果

实际执行并exit0：

```bash
npm ci --include=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
```

npm输出added549packages；锁定v3文件609个安装位置受平台optional条件筛选。未升级依赖/npm、未安装全局工具、未启用生命周期脚本。tsx4.19.1、TypeScript5.6.2、esbuild0.23.1实际可用，esbuild TypeScript转换成功，不需另开安装脚本。

package-lock SHA-256保持 `3577eb5548e3f44086b3a8db7fb2483751f9af3dc7792a0728e145e025c13267`；所有resolved均官方registry.npmjs.org HTTPS且含integrity。弃用/新版npm提示只是安装日志，没有执行建议的升级。

运行 `npm run prepare:desktop` 仅从已经安装的锁定Voice SDK复制浏览器资产，不是开启安装生命周期或操作用户电脑。生成资产303272字节，SHA-256 `35d3cb1b22e309f9884724a89250aecd2de4f1556ad7b67a7bc5e06c73dcb74a`，与锁定官方SDK一致。

## 本环境本轮验证

环境：托管云端Linux，Node24.19.0/npm11.9.0；离线Chrome151.0.7922.173。日志和JSON摘要在 `/workspace/ai-phone-reference/verification-20261012-109977e`。以下均本轮实际运行，未沿用旧包成绩。

| 命令/场景 | 结果 | 证据 |
|---|---|---|
| callback/security六文件专项 | 109/109，通过；0失败/跳过 | callback-security.log |
| npm run typecheck | exit0 | typecheck.log |
| npm run build | exit0 | build.log |
| npm test | 1290 total，1285 pass，5 skip，0 fail/取消 | npm-test.log、npm-test-summary.json |
| npm run test:google:browser | 27项通过，externalRequests=0、realSupplierCalls=0、异常0 | google-browser.log、browser-google |
| npm run test:controlled:continuous:browser | 65项通过，配对旁路true；外部/真实供应商/异常0 | continuous-paired-browser.log、browser-paired |
| 同上，CONTROLLED_BROWSER_OUTGOING_PAIRED_CAPTIONS=false | 62项通过，默认三会话；外部/真实供应商/异常0 | continuous-default-browser.log、browser-default |

专项命令：

```bash
node --import tsx --test tests/cloud-phone-login-http.test.ts tests/cloud-ingress.test.ts tests/cloud-voice-diagnostics.test.ts tests/cloud-access.test.ts tests/cloud-access-transport.test.ts tests/cloud-voice-join.test.ts
npm run typecheck
npm run build
npm test
CHROME_BIN=/usr/bin/chromium npm run test:google:browser
CHROME_BIN=/usr/bin/chromium npm run test:controlled:continuous:browser
CHROME_BIN=/usr/bin/chromium CONTROLLED_BROWSER_OUTGOING_PAIRED_CAPTIONS=false npm run test:controlled:continuous:browser
```

全套包含授权/控制权、个人云任一模型失败双腿清理、未知create/迟到SID、挂断失败重试、清理后第二通等既有回归；新增HTTP测试不被单独说成这些所有失败场景的证明。所有供应商/模型为fake，本地HTTP/WS为loopback。没有真实模型、电话或生产操作。

5项实际skip：Windows PowerShell与PowerShell7停止进程身份时间戳两项；Windows继承config ACL；仅当前用户/SYSTEM秘密临时文件与原子env替换；Windows ACL失败保留原env。当前Linux不执行这些平台专属检查。

未执行：本地Docker镜像构建/完整远端CI，以及其他非此次必要的离线浏览器场景；实际Google身份、本人耳麦、公网Twilio/模型握手、手机音频/译意/真实延迟。没有把它们记为通过，0.5–1秒实验期望没有达标承诺。

## 一次独立针对性审查

审查入口为另一审查代理read_progress及其独立清理子审查，均只读；不是主执行自检。证据见外部 `independent-review.md`。

- cloud-ingress.ts:199：仅固定签名表单回调/精确media WS剥离普通传输头；Host/签名/framing/认证相关头/x-phone-/sec-仍唯一。
- security.ts:63：官方SDK仍校固定PUBLIC_BASE_URL+原req.raw.url完整query及表单，未从代理头重建URL；文件未改。
- session-manager.ts:808/988/1030：SID、session/role/nonce、账户/StreamSid、格式、owner/controller和Voice许可继续绑定；文件未改。
- session-manager.ts:1282/1406/1467/1534：create去重、迟到SID只清理、双腿独立清理、失败保留责任，未知结果继续占槽。
- cloud-voice-diagnostics.ts:57：只固定event/route/reason，不输出query/nonce/SID/请求或异常原文。
- HTTP测试554/683/720覆盖重复/代理头及完整链；796/918/977覆盖假签、漏query、Host/账户/nonce/SID错配、关键重复头及错误媒体start；652/1031覆盖重复清理与终态去重。

没有发现新阻塞缺陷。记录一项原有容量限制：同进程累计100条已清理记录后，第101通可能FORBIDDEN；cloud-phone-access.ts:123/299/344/589及cloud-access.ts:416保留Map。第二通测试307不证明无限多通。旧PROGRESS已记录，此次一通目标不扩修该项。真实403和听感未由独立审查验证。

## 现有 Railway 只读核验

仅既有AI服务，portal-test未被操作。完整只读摘要见外部 `railway-readonly-summary.md`。

| 对象 | 核验结果 |
|---|---|
| 项目 | ai-phone-portal-trial，145aa27a-3a84-4e4d-91f9-b97f33bf6d42 |
| 环境 | staging，c5db5ddb-26b6-48ce-b920-dc1ebbe30fa8 |
| 服务 | ai-phone-test，407bede7-11b6-4260-b055-a8045dc71588 |
| 线上SHA | 4f34fa313173e62d370e5f78c0780e4506848420 |
| 部署/回退点 | 922a6a82-1039-41ec-9356-4a1f6ab547ce；SUCCESS、Online、canRollback=true |
| 实例 | 1/1，us-east4-eqdc4a，1CPU/500MB |
| 源码 | 交接duplicate-header-fix分支及上述commitSha |
| pending | staged=null，pendingWork=[] |
| 构建/启动 | Dockerfile.cloud，dist/solo/cloud-index.js，/api/health |
| 排空/资源 | overlap0/drain40，restart NEVER，原/data卷；不改 |

线上成功时间2026-10-12 10:55:23北京时间，平台本次8小时范围无失败/警告。这不证明可以通话。独立autoDeploy开关未在工具中展示，不能断言自动部署关闭。

## 各项试打就绪状态

| 项目 | 已验证 | 未验证/发布前条件 |
|---|---|---|
| 公网HTTPS | 现有Railway管理域名ai-phone-test-staging.up.railway.app；服务Online | 本轮未独立实测公网TLS/应用访问；发布后核实际SHA、健康和登录壳 |
| 公网WSS | /voice/media精确路径和官方签名/媒体start本地回归通过 | 未做生产公网WSS握手，真实账号/线路仍待试打验证 |
| Twilio回调 | 完整query/签名/nonce/SID与代理头本地链通过 | 没有Twilio读工具；既有App的/voice/client POST、动态connect/status/stream-status及主叫/目标由现有授权者核对 |
| 登录 | 生产组件+假Google完整离线Chrome27通过 | 当前真实Google帐号/会话需用户登录，不能用历史成功代替 |
| 控制权 | 直接点击安全acquire、别页只读、单call、重复点击、清理/晚到SDK离线通过 | 生产实际controller/join尚未试打；网页宜保持前台，不让失联租约终止试验 |
| 耳麦 | 合成设备与SDK生命周期离线通过 | 用户实际耳麦输入/输出、麦克风许可与声音需本人核验 |
| 模型/语音 | 默认三会话、故障终止/首次native失败不拨远端离线通过 | 实际OpenAI实时权限/WS、手机译音与原声未知 |
| 当前配置 | 所需变量名存在；未读取秘密 | serviceMode/paired/origins等值未知，不能根据变量名猜配置 |

一次有界AI runtime查询serviceMode返回0条，未扩大/重试。没有safe单变量值工具，因此不读取完整变量值或新建凭据/权限。没有Twilio读取能力，已一次发现并明确缺项，不再寻替代入口。

发布前由既有授权操作人确认以下非秘密配置；如已正确，不需改变：

- AI_PHONE_RUNTIME_MODE=cloud，CLOUD_SERVICE_MODE=phone。
- CLOUD_WARM_INSTANCES=1，原实际单副本/资源/卷保持。
- 今晚建议默认三会话，CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED=false；不默开额外付费字幕会话。如当前不同，任何更改须列入批准。
- CLOUD_PUBLIC_ORIGIN及PUBLIC_BASE_URL精确同源 https://ai-phone-test-staging.up.railway.app。
- CLOUD_PUBLIC_CALLBACK_CONFIRMED=true仅能依据既有实际回调核验，不能虚填通过。
- 既有Google/Twilio/OpenAI身份、号码和凭据保持，只核合法/归属，不输出清值，不新建/换key，不改来电或短信。

## 待批准的发布与一次试打范围

1. **远端同步**：允许推送本恢复分支的最终候选SHA；可创建草稿PR以交接分支为base触发现有CI，不合并。当前分支不匹配offline.yml的push分支模式codex/cloud-phone-conversation-*，不能只push就声称CI已运行。发布前确认PR/CI与候选的对应关系，源码仍固定批准SHA。
2. **仅AI staging一次更新**：允许现有项目/环境/ai-phone-test服务从线上4f34更新到最终候选SHA。确认必要配置值；若已是phone/default3正确配置，可只改源码SHA。禁止操作portal-test、其他项目、资源、套餐、凭据或供应商路由。
3. **发布后核验与回退**：回读实际SHA和SUCCESS、/api/health与登录壳。失败时使用原部署922a6a82…/4f34作为回退点，但恢复Online仍不代表旧电话可用；对活跃/清理未知电话先处理线路责任，不盲目回退或强杀。
4. **一次真实测试批准**：只允许用户自行点拨打当前已授权本人目标；建议1通、最多5分钟、Twilio/OpenAI合计操作预算5美元，首次错误立即挂断并确认两腿清理，不自动重拨。目标脱敏表示为预期美国格式 `+1 *** *** ****`，实际清值与末四位没有从安全接口核验，发布前由既有授权者确认；不让用户在聊天重复提供清值。此预算/时长是此次操作建议，不恢复应用内$5/journal/maxCallMs代码，也不是供应商账单硬封顶。
5. **费用边界**：保持Hobby，不升级、不新建付费资源。Railway AI+portal本轮合计3美元提醒/最多4美元由用户决定关停，提醒不是硬封顶；电话与模型另算。平台套餐/账单没有工具证据，本轮未改提醒或创建关停自动化。

所有这些外部操作均未执行；此方案等待用户批准，dot核对后下发。没有真实电话或付费模型握手。

## 责任与今晚剩余步骤

本云端执行者已完成安装/离线验证，dot验收候选与范围。用户需批准上述同步/仅AI发布及一次试打费用、次数/时长；取得批准后由获准执行者同步精确SHA、完成必要配置和回调核验、发布与回读。用户本人随后Google登录、戴耳机核输入/输出并接听，只发起一通中文→手机英文/手机英文→原声+中文字幕测试，结束确认两腿关闭。

缺少的是上述发布授权与生产配置/供应商核验、用户真实设备和受控试打，不是等待完整字幕/声音/登录/来电功能完善。未经真实结果，不承诺今晚链路已经打通。
