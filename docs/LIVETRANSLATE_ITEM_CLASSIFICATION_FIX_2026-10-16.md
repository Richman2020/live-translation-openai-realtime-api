# LiveTranslate 首轮后停译：句段身份分类修复

本轮仅本地修复及离线验收，不推送、部署、拨号、启麦、上传录音或调用模型。未安装依赖，未读取密钥，未改 Railway/Twilio 或供应商配置。保留 Andre、英文原音直通、OpenAI 与阿里三段路径。

## 版本与保全

- 父提交：`b0d7d81230a83d717d47af21416d1e351a206f5a`。
- 本地修复分支：`codex/ai-phone-livetranslate-item-conflict-20261016`。
- 只读回读线上：上述 SHA，部署 `8752d205-4d9d-47ee-b776-e1033e14f29c`，状态 SUCCESS。本轮没有发布操作。
- 原分支和原提交保留；原未提交 `PROGRESS.md`、补丁和全文哈希已另存。`node_modules` 是既有依赖链接，不纳入提交。
- 本文随代码同一提交；最终完整候选 SHA 以交付回执和 `git log -1` 为准。

## 同一次实通可确认的证据

通话 ID：`12d46269-f186-48c8-bb94-432f126aa485`。只读取得该部署 UTC 02:24:30–02:27:15 的 387 行既有日志，386 行关联此 call ID；日志 JSON 在 attributes 内，message 为空，不能仅按 message 搜索误报没有日志。

以下是应用记录的 `at` / `observedAtMs`，不是日志摄取时间，也不是耳端播放时间。日期为 2026-10-16；北京时间比 UTC 晚八小时。

| UTC | 北京时间 | 已记录事实 |
| --- | --- | --- |
| 02:25:38.643 | 10:25:38.643 | local 第一个 response 完成，sourceSequence=1 |
| 02:25:39.905 | 10:25:39.905 | local 播放队列清空；不等于耳端播放已实测 |
| 02:25:50.072 | 10:25:50.072 | remote response 完成，sourceSequence=2 |
| 02:25:58.786 | 10:25:58.786 | local 新 source 开始，全局 sourceSequence=3 |
| 02:25:58.938 | 10:25:58.938 | 152ms 后出现 `LIVETRANSLATE_ITEM_CONFLICT`，此后没有翻译诊断 |
| 02:26:35.839 | 10:26:35.839 | 后续观测到 remote 媒体停止；最终清理记录不证明最先由谁挂断 |

没有第 257 响应触发的证据。错误前两方向已有完成结果，第三个 source 后没有可见的 response-created 诊断，但这不能补成未保存的原始事件。

**仍缺**：故障帧的 event.type、source/item/response ID 关系、实际触发的冲突分支、当时浏览器收到的事件和显示状态、终止发起者。因此不能把下述已复现的代码缺陷直接写成这次实通的唯一或精确根因，也不能声称完整重放了缺失的事故帧。

## 确定缺陷、协议依据及可复现范围

历史 B28 成功试听的真实脱敏日志包含 120 个 provider frame，但仅有一个 source、一个 output、一个 response：

- frame 4（原日志151行）：源项是 `assistant / message / in_progress`，content 包含 `input_audio`，无 previous_item_id。
- frame 7（154行）：译项也使用 assistant，content 为空，其 previous_item_id 指向该源项。
- 首个音频样本在 frame 13，ASR final 在 frame 114；不能等 ASR 定稿或 response.done 才放音。

该真实日志 SHA256：`3c69ee7c4fa6d7c3ad77039c83d0a83cfa53efe722ad1a0dca7db202a98770ee`。它证明源项也能是 assistant，不能证明多轮一定采用哪一种前驱关系。

本轮重新读取[阿里官方服务端事件说明](https://help.aliyun.com/zh/model-studio/live-translator-server-events)：conversation.item.created 包含输入音频簿记和翻译结果两类；**对已确定的翻译结果项**，previous_item_id 可关联 speech_started 的源项。该语义不适用于所有 assistant 创建记录，更不能递归追前驱猜最近的原文。

b0 只按 assistant + 有效 previous_item_id 建立译文绑定。若后续输入创建记录带前驱：

- VAD 先到：新源已存在，创建记录被错当 output，当即 ITEM_CONFLICT。
- 创建记录先到：输入 ID 被写进待译文绑定表，后续 VAD/ASR 又因该污染报冲突。

使用真实第一轮的**结构**、合成的第二轮前驱和到达顺序，在精确 b0 上验证：新增最初16项中4通过、12失败。多轮 ID、第二轮前驱、冲突和时序均明确标为合成，不伪装成此次实通原帧。反向还发现：已确认为 output 后的同 ID input_audio 创建记录原先未被识别为真实冲突。

## 最小修改与保留的不变量

1. `input_audio` 创建、VAD 或 ASR 确证输入身份。仅确认其类型，不替代电话所需 VAD offset、来源顺序和播放准入。
2. 空 assistant 创建项只暂存有界元数据，不先写入 associations/pendingAssociations。仅 response 文本/音频事件或最终 output 确证译项后，才使用其前驱绑定源项；首个有效输出分片即可确认，不等待完整译文。
3. 未分类元数据最多256项；确证输入时丢弃其前驱候选，确证输出时消费候选，退休/取消/关闭时清理。未知前驱变化先保留歧义，若后来确认为 output 则仍拒绝；不最后写入覆盖来源。
4. 真正输入/输出同 ID、output slot 换 ID、跨 response 占用、已确认译项换源及终态撤回已见 output 仍失败。已有 FIFO、事件去重、音频队列上限、VAD/frontier/tombstone 和挂断封口保持。
5. 新增首个 fatal 的固定分支、事件类型、验证路径、值类型和本地收帧序号；经 bridge 和 owner/log sink 两层白名单投影。没有 provider 原 ID、正文、音频、原始错误、认证头或凭据。
6. 电话生命周期不扩改。真正协议失败仍停止两个模型和译音队列，防止错配继续发声；不触发电话自动挂断，不自动重连或换模型。英文原声、手动挂断及真实媒体断开清理保留。

旧七个触发位置（b0 行号）全部审查：665 ensureSource、812 output 撞 source、819 slot 换 ID、825 output 换 response、1697 VAD 撞 output、1840 role-only 创建项误分类、2075 final output 缺失。新代码将1840误判改成正面 input_audio 与已确认 output 的冲突守卫，并为七种真实身份冲突设置固定分支枚举。

页面原有明确提示“翻译已停止，电话仍在进行；可听对方原声。请手动挂断后检查，系统不会自动重连或切换模型。”本轮没有改生产页面，新增实际浏览器回归验证该提示和刷新后的持久状态。**现场用户是否收到提示仍无记录。**

## 离线验证与所有尝试

依赖复用现有锁定版本；Node v24.19.0，Chromium 151.0.7922.173。测试使用内存供应商和受控 loopback，加载拒绝外网的防护；浏览器的外部请求单独断言。没有电话、模型连接或费用。

- 初始分类用例在 b0：16项，4通过/12失败，保留完整失败日志；修复后16/16，再补边界21/21；最终含七分支诊断断言的22项包含在最终专项和全量中。
- 最终专项：`node --import tsx --test tests/livetranslate*.test.ts`，289/289通过，0跳过。
- 全量：`npm test`，2215项，2210通过、5项既有 Windows 专用测试在 Linux 跳过，0失败。
- `npm run typecheck`、额外覆盖修改过的 `.mts` 夹具的 tsc 检查、`npm run build`、`public/*.js` 语法和 `git diff --check` 通过。
- 诊断开发阶段第一次 typecheck 因新增测试夹具缺少必需回调/参数失败，已修正；第二次通过。专项先22/22，补边界后23/23，全部日志保留。
- 生命周期单测两次均2/2：真实 client 构造跨响应 output 冲突，穿过 bridge → SessionManager → owner SSE/刷新快照；电话 active、原声继续、两方向模型均封口，手动挂断清理两腿。测试 owner 投影不冒称真实 Google 登录。
- 页面新增场景是**合成 bridge failed 状态**进入真实 manager/CloudPhoneAccess/SSE/生产 DOM；与上述真实 client 的构造冲突单测互补，不冒称同一现场事件贯穿浏览器。开发阶段首轮 continuous 浏览器123项通过；冻结后完整七组也全部通过，具体如下。
- 独立审查另运行分类和生命周期24/24，并用受控探针确认 output promotion 释放未知元数据槽，以及相同原始 ID 字符串在两方向会话内仍隔离。独审发现一处测试注释把合法 assistant 角色复用误写成合法 source/output ID 复用，已仅更正注释；执行代码不变，不因此重复整套测试。

覆盖：中英交替、同方连续、四种 created/VAD/ASR 到达顺序、未知项分类、真正冲突、重复及迟到、静音后继续、ASR final 前首包释放、退休后不复活、手动结束与真实断线清理。既有 Andre/Tina 窄兼容和旧真实五帧声线事件回放仍通过。

| 完整浏览器组（各一次，未重跑） | 通过检查数 |
| --- | ---: |
| conversation | 43 |
| controlled | 107 |
| continuous | 123 |
| continuous / 出程配对字幕关闭 | 120 |
| Google 登录 | 29 |
| web-verification | 50 |
| daily web-workbench | 84 |

七组均 exit=0、exceptions=[]、externalRequests=0；有供应商计数字段的六组 realSupplierCalls=0，静态 conversation 组没有供应商入口。没有失败、取消或跳过的浏览器组；新增停译页面断言不替代严格媒体断开/只读/静音不可用等原断言。

GitHub CI、Docker 镜像构建与真实通话本轮未执行；没有推送授权，也未安装 Docker 构建内依赖。不得将本地通过称为新 SHA 已过 GitHub CI 或已通过实通。

## 剩余限制与下一步

- 本次实通具体冲突帧和七分支中的哪一支仍未知；新诊断只能为之后另行批准的人工实通补足证据，不能追溯补造旧帧。
- 第257响应停止翻译的既有限制保留为未解决；本轮没有改变或宣称解决容量问题。
- 真冲突仍停止双向翻译，原声和手动挂断保留；用户需手动结束后检查，系统不会自动切换供应商或恢复模型。
- 不改声线、识别/翻译质量、字幕体验、旧三段延迟或其他体验问题。真实长通话、耳端音色/延迟、静音恢复实效仍待单独授权后由用户验证。
- 下一步需先获新候选的推送/CI授权；通过后另行确认发布和用户亲自拨号，本轮旧授权不复用。

## 可核查原件

当前工作区独立审计目录：`/workspace/ai-phone-reference/livetranslate-item-conflict-20261016`。保留所有旧证据，不覆盖历史日志。核心原件：

| 文件 | SHA256 |
| --- | --- |
| `RAILWAY_EXISTING_DEPLOY_ATTRIBUTES.json` | `f4ebde5fe225a129f1c5a58770fc76a04bca1b9d291a43fd98605a57ae7e99d4` |
| `INCIDENT_TIMELINE_AND_LIMITS.json` | `7e4a96574c9739a3f0381561bbc5062b20464896639b37f737fba864671c1a0e` |
| `BASE_CLIENT.ts` | `ca388187a5652a72a481e6a2ee3ba103304e771cf31750df54e367b627f9397f` |
| `PREEXISTING_PROGRESS.md` | `00d55977f1b147fc91d8376a78fee8166306116fa93767fb42ae722dc9daef2a` |

`classification-tests/`、`diagnostics-tests/`、`ui-lifecycle-review/` 和 `independent-review/` 保留各次运行、基线失败、审查与哈希回执。最终根目录 `FINAL_RECEIPT.json`、`BROWSER_RESULTS.json` 和 `EVIDENCE_SHA256.json` 记录精确候选、完整七组结果及证据哈希；这些是本次实际成绩，不沿用历史 CI 数量。
