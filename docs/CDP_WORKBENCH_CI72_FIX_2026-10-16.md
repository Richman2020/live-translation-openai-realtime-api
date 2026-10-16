# CI #72 浏览器夹具：生命周期防护及可追踪诊断

父提交：`5e3f494de78ffb75221f76f4e10fc799f5f56c84`。本轮仅本地提交，不推送、建PR、发布、拨号或调用模型，不安装或操作平台/凭据。电话、模型、音色及第257响应限制均未修改。

## 原事故与证据边界

CI #72（run `38829933953` / job `116746124438`）的 daily web-workbench 失败：同源XHR拦截的 `Fetch.continueRequest` 返回 `Invalid InterceptionId/-32602`，异常进入faults，旧脚本第1712行严格断言失败。原日志没有命令编号、FetchID、NetworkID、具体XHR和请求终止顺序，**不能确认原事故首因或认定无害竞态**。

原完整脱敏日志SHA256为 `47a20b3158ffc32be90f336796f2e5a6f16e27a3b26376c6f3828d084e4aa85b`，原回执与独立诊断一起只读保全。资料目录：`/workspace/ai-phone-reference/livetranslate-cdp-fix-20261016`，原档前缀`ORIGINAL_`，包含真实哈希清单。

证据分为三类，不能互相替代：

| 类型 | 能证明什么 |
| --- | --- |
| CI #72真实失败日志 | 指令分支及严格断言确实失败；具体请求首因仍缺证据 |
| 人工调度的真实本地Chromium/HTTP | 同ID重复continue，以及明确AbortController取消后继续旧请求，均可实际产生-32602；并非原CI请求重放 |
| 人工构造CDP事件单测 | 窄分类、去重、未知错误与清理边界符合约定；并非供应商、电话或历史根因验收 |

最终run06的实际编号示例（均为人为调度的本地请求）：重复continue为command `13` / Fetch `interception-job-2.0` / Network `130188.2`；明确abort后旧continue为command `10` / Fetch `interception-job-4.0` / Network `130206.2`，均返回-32602。完整关联与时间在`local-browser-run-06/receipt.json`。原CI的对应编号仍未知，不能用这些本地编号替代。

真实本地对照中，页面导航后没有该XHR的终态，旧continue仍成功；target关闭产生传输关闭错误而非-32602。因此导航/关闭意图不能用作吞错依据。故意无效FetchID、人工重复pause的用例明确是注入，不称为Chrome自行重复事件。

## 最小实现范围

- 新增测试专属`CdpInterceptionLifecycle`，每页独立关联FetchID/NetworkID、页面代际、指令与编号、单调时间和固定路径类别。私有不可逆URL指纹只判定重复事件是否完全一致，不进入日志；不保存查询串、headers、cookies、正文或原始错误内容。
- 每个pause最多一个Fetch终结动作；相同重复不重发，冲突重复严格失败。缺失终结动作、未知错误、超时和关闭错误继续失败，无命令自动重试。
- 仅同页同请求、同源、唯一无重定向歧义的`loadingFailed(canceled=true)`能证明取消。已明确取消则不发旧命令；已发指令返回确切-32602+InvalidInterceptionId时，最多等待150ms取得同请求取消证据，证据不足继续失败。这是等待证据，不是重试。
- 非取消loadingFailed、loadingFinished、其他请求/页面、provider、只有导航/关闭及普通-32602不能借用该例外。记录硬上限1024，达到即夹具失败而非淘汰ID后重新处理；这不是电话容量设置。
- 夹具等待全部拦截并有界观察新事件；截图和所有功能检查完成后停止JS请求生产、stopLoading、排空、关闭socket、再次排空。未关闭Fetch拦截。socket关闭立即reject未决命令并清计时器。
- 最终严格faults、外站阻断与供应商零调用断言在收尾之后执行；成功回执最后才写。启动删除旧成功文件，避免本轮失败误读旧成绩。
- 新增可重复的本地Chromium对照入口及26项纯事件回归。没有修改生产src/public、工作流、依赖或锁文件。

## 运行方式（已有依赖和Chromium）

```bash
node --import tsx --test tests/cdp-interception-lifecycle.test.ts
node --import tsx scripts/verify-cdp-interception-browser.mts --evidence-dir /absolute/new-evidence-directory
npm run test:web-verification:browser
npm run test:web-workbench:browser
npm run typecheck
npm run build
node --import tsx --test --test-concurrency=4 tests/*.test.ts
git diff --check
```

本地验证由独立loopback网络守卫约束Node外连，浏览器逐请求继续拦截外站；只用合成身份、假供应商与本地HTTP，未读实际密钥。新增诊断JSON为`.runtime/<mode>-browser/cdp-lifecycle.json`；发生错误时也把有界脱敏时间线输出到CI日志。

## 验证及全部中间结果

最终固定四个测试文件哈希见`FROZEN_VALIDATION_SOURCE_HASHES.json`，完整命令、每次exit和运行前后哈希见`VALIDATION_RUNS.jsonl`。

- 新专项第1轮19/22（3失败：分类断言位置与容量约定不一致），第2轮23/23，第3轮24/24，第4轮26/26；没有删测试，完整演进说明`UNIT_ATTEMPTS.md`，前三轮只有真实终端摘要、不伪造完整日志。独立作者另跑26/26，四文件前后hash相同。
- 真实Chromium对照run01失败（过强resolver阻断本地页、ready误认错误页），run02失败（工具错误预设导航必有取消）；修正工具后run03四项通过、run04/05十项通过。最终固定版本run06十项通过，sourceHashes与冻结清单吻合，不覆盖前次结果。全部是有明确改动/验证目的的开发运行，无自动重试。
- 初始项目typecheck通过；额外fixture类型检查首次失败（新入口及既有target JSON为unknown，且临时检查配置未纳入Fastify类型增补），修正测试元数据类型并纳入现有src/tests后通过，没有改业务类型或关闭检查。初始daily夹具一次通过，三页无fault/in-flight残留。
- 首轮全量2168项：2161通过、2失败、5 Windows跳过；该轮启动后才补入缺失终结动作防护，使用修改前后混合文件，不作为最终成绩。冻结文件后重新全量：**2168 total / 2163 pass / 5 skip / 0 fail/cancel**，同glob仅限制并行度4；保留两轮完整日志。
- 冻结版本build、完整typecheck及额外fixture类型检查通过。浏览器JS语法通过；7组浏览器全部通过：对话模拟、controlled84、continuous91、关闭paired88、Google29、web-verification50、daily web-workbench84。daily最终三页inFlight/fault/cancellation/duplicate均0，没有依靠取消例外通过。`git diff --check`通过；新文件在stage后另验完整提交差异。详细命令/exit见`VALIDATION_RUNS.jsonl`，不使用旧CI成功项替代。
- 本地Docker引擎可用但镜像列表为空；本轮禁止安装，未拉取基础镜像/执行镜像内npm安装，因此Docker重建/容器检查**未执行**，留待新SHA完整CI。旧CI Docker通过不算本轮成绩。

独立审查见资料目录`INDEPENDENT_IMPLEMENTATION_REVIEW.md`与`INDEPENDENT_HELPER_TEST_RECEIPT.json`；初审发现的私有URL判等、清理后安全计数和空handler问题均修复，最终未发现剩余确定阻塞。该结论不等于新GitHub CI通过。

## 仍待验证及下一次范围

本候选修复可证实的夹具缺口并补足诊断，**不宣称已证实或彻底解决CI #72原始XHR首因**。取消证据晚于150ms仍保守失败；新CI若失败，按同请求时间线进一步定位，不自动重试、放宽或跳过。

用户确认后才可非强推本轮精确新SHA到`codex/cloud-phone-conversation-livetranslate-ci-20261015`。须重新核对远端仍5e3及部署关联；若不同先停。只更新一个分支ref，无tag/PR/merge/部署，跟进新SHA的既有完整workflow（含Docker、全部浏览器及格式检查）。目前未执行该推送。

生产与OpenAI/阿里路径保持不变。单来源第257响应停止翻译仍是未解决限制，原声和手动挂断须保留；不把本轮测试夹具修复当电话验收或新发布/付费授权。
