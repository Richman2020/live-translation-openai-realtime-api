# AI 电话旧回调修复恢复与验证报告

记录时间：2026-10-12 17:11，北京时间。执行人：本云端聊天。接收验收方：dot。

旧修复中获准的六个 tracked 文件和一个原 untracked 文档已在精确基线恢复，补丁适用性与七个全文哈希/大小均通过。现有项目依赖缺失，回调专项、typecheck、build 和相关运行回归未执行。此次交付不代表真实403已消除或通话功能验收通过。

## 基线与实际工作目录

- 仓库：`Richman2020/live-translation-openai-realtime-api`。
- 精确基线：`4f34fa313173e62d370e5f78c0780e4506848420`。
- 新分支：`codex/ai-phone-cloud-recovery-20261012`。
- 新独立工作目录：`/workspace/ai-phone-cloud-recovery-20261012`。
- 创建前分支与目录均不存在；从上述精确SHA新建，没有覆盖旧名称。
- 原工作目录：`/workspace/live-translation-openai-realtime-api`，保持 `work` / `5fabf51cd6976131ac829b1b95c87f7239096184`。
- 原附件、需求资料与完整需求审计报告保持原位置与内容，保护前校验清单保存在 `/workspace/ai-phone-reference/recovery-20261012/protection-before.json`。
- PROJECT_BRIEF.md 按包原样恢复，属于历史需求/状态来源；其历史文字不覆盖用户最新的本云端执行、dot协调验收与并行分工。未同时重构字幕、声音、登录或来电功能。

## 补丁适用性与恢复操作

旧ZIP：22,127字节，SHA-256 `e1398424b13ac9d2bf6c435eed99dba2df72041f8933dc05eea2a2d0f376b76b`。原ZIP未改。原patch：46,564字节，SHA-256 `dfde557b793275037569d910adf226d390d909b35180f4f047b04617125721a8`。

先核对新工作目录HEAD、分支、清洁状态、patch校验、七条tracked路径与一个文档路径、无重命名/路径越界/符号链接，以及每个基线全文哈希。文档目标不存在。随后实际执行：

```bash
git apply --check --exclude=AGENTS.md --verbose /workspace/ai-phone-reference/recovery-20261012/tracked-changes.binary.patch
git apply --exclude=AGENTS.md /workspace/ai-phone-reference/recovery-20261012/tracked-changes.binary.patch
```

两条命令 exit 0。未使用 --3way、--reject、--unsafe-paths、强制覆盖或修改patch。文档从原ZIP以排他创建方式原样恢复，路径为 `docs/CLOUD_PHONE_CALLBACK_CHAIN_FIX_2026-10-12.md`，没有覆盖现有文件。

AGENTS.md 的旧patch被排除。工作目录中的该文件保持基线27,523字节，SHA-256 `915651d9c86ea2a7e4bdbd64291f65bc76b71a312c19370fddfd23888d0862c7`。历史AGENTS差异只供审查，不传递安装、推送、部署、付费或凭据操作许可。

## 恢复后逐文件全文校验

下表SHA-256均由新工作目录实际文件重新计算，逐项等于原MANIFEST的 worktree_sha256，大小也一致。每个实际路径等于新工作目录加下表相对路径；详细expected/actual路径见外部证据 `restore-evidence.json`。

| 文件 | 字节数 | 恢复后 SHA-256 | 清单核对 |
|---|---:|---|---|
| `PROJECT_BRIEF.md` | 75280 | `485510e4e6e49c75e6fbc14819f9b1e53ba408070214dc89a35bc4e07a8bd60d` | 匹配 |
| `src/solo/cloud-ingress.ts` | 20508 | `ca1efcbbb33828aaebd05966a4c1ba6c63fecfd90cd9d91d1f98fe163a0622a2` | 匹配 |
| `src/solo/cloud-voice-diagnostics.ts` | 2529 | `c1a5070e213d9dac22c5f7747d1630c42bc8da8f880c31f54c235efdb11dc3e5` | 匹配 |
| `src/solo/server.ts` | 33867 | `71a80901add2aa587ceee8adf47befde42e0d9a6abfcebe562fddb476ea8cec7` | 匹配 |
| `tests/cloud-phone-login-http.test.ts` | 61821 | `a0d3103e0432d50432bbecf0d7a3905020b7fc7d1aed4930372c038f35d969a5` | 匹配 |
| `tests/cloud-voice-diagnostics.test.ts` | 3442 | `d35f4fb0e85acca99337a43f81bd7697c7f459fe5387a8f75b7a3a7d335a29bc` | 匹配 |
| `docs/CLOUD_PHONE_CALLBACK_CHAIN_FIX_2026-10-12.md` | 3512 | `2fac6488d9f7383f13d102c0384e2b08bf4e347e5ccee9a17e8a235b0db68be8` | 匹配 |

恢复本体tracked差异：6个文件，944行新增、43行删除；原untracked文档全文另计。包含这七个文件的完整差异保存为：

`/workspace/ai-phone-reference/recovery-20261012/restored-seven-files.full.diff`

该完整差异SHA-256为 `79ac490c42d5ecfde2a4e024c28c51bfcb4b0df23f4df6baadc912b536d396be`。本轮新PROGRESS和此验证报告是另外的交付记录，不属于原包恢复文件，未改动上述七个已匹配全文。

## 安全边界审查

- ingress仅把普通传输头兼容扩展至固定Voice表单回调和精确media WS；非空签名只选择传输处理，不构成认证通过。
- Host、签名、消息边界/认证相关头及 x-phone-/sec-重复头检查保留；浏览器/API/来电权限没有扩张。
- server仍调用官方Twilio验签，完整URL含query与表单参与校验；账户、session/role/nonce/SID、owner/controller与Voice许可边界未解除。
- 新诊断仅输出固定 event/route/reason，不输出请求、query、nonce、SID或原始异常。
- 新增完整链测试使用本地127.0.0.1、假Google提供方、假电话provider和假模型bridge，没有真实供应商调用。
- 静态审查未发现通过放宽授权或供应商签名消除403；运行负例仍须正常依赖就绪后复验。真实Railway失败分类、媒体握手与手机音频没有本轮验证。

## 本轮实际执行的检查

| 检查命令或校验 | 本轮结果 | 证据范围 |
|---|---|---|
| git apply --check --exclude=AGENTS.md --verbose ... | exit 0 | 六个tracked补丁适用性 |
| git apply --exclude=AGENTS.md ... | exit 0 | 六个tracked恢复 |
| 七个恢复文件SHA-256与大小、AGENTS基线SHA | 全部匹配 | 恢复完整性，不代表业务通过 |
| git diff --check | exit 0 | 差异空白检查 |
| node --check src/solo/cloud-ingress.ts | exit 0 | Node24原生语法检查 |
| node --check src/solo/cloud-voice-diagnostics.ts | exit 0 | Node24原生语法检查 |
| node --check src/solo/server.ts | exit 0 | Node24原生语法检查 |
| node --check tests/cloud-phone-login-http.test.ts | exit 0 | 仅解析测试源码，未执行测试 |
| node --check tests/cloud-voice-diagnostics.test.ts | exit 0 | 仅解析测试源码，未执行测试 |

交付记录的 `git diff --cached --check` 首次 exit2，原因仅为本报告末尾多一个空行；已清除该空行并保留首次失败证据，未修改七个恢复文件。复检结果见外部 `delivery-diff-check.json`。

语法检查不是TypeScript类型检查、build、callback测试或端到端回归。此次运行测试没有启动，未产生新的pass/fail/skip数量；原包的旧1290/1285/5、24/24及浏览器359等历史数字不是本轮结果。

## 未执行命令与准确阻塞

Node `v24.19.0`、npm `11.9.0` 可运行；新旧工作目录及上级均没有项目 node_modules。实际解析所有42个直接依赖均不可用，关键 tsx、typescript、tsc-alias、fastify、@fastify/formbody、@fastify/websocket、dotenv、twilio、ws 返回 ERR_MODULE_NOT_FOUND。既有Chromium或运行时自带Playwright不能代替项目锁依赖。本轮未创建替代loader、改导入或用无关测试补成绩。

以下命令**未执行，原因均为项目依赖缺失**：

```bash
node --import tsx --test tests/cloud-phone-login-http.test.ts tests/cloud-ingress.test.ts tests/cloud-voice-diagnostics.test.ts tests/cloud-access.test.ts tests/cloud-access-transport.test.ts tests/cloud-voice-join.test.ts
node --import tsx --test tests/cloud-personal-call.test.ts tests/cloud-phone-access.test.ts tests/cloud-voice-join.test.ts
npm run typecheck
npm run build
npm test
npm run test:google:browser
npm run test:controlled:continuous:browser
```

没有将未启动的检查列为运行失败或既有Windows跳过；它们是依赖阻塞的未执行项。正常build的prebuild会删除本独立目录的dist，此目录目前没有dist；未运行该脚本。start:cloud、verify:providers、configure:twilio和quality调用不属于本轮离线检查，不启动应用或连接真实供应商。

## 锁文件来源与安装脚本

已读取package.json、完整解析v3锁文件并审阅相关测试脚本。依赖文件未改：

- package.json SHA-256：`ed4288589d54bb7383de5c21898d216e52fa960f92fd1801200ef400340a3c4e`。
- package-lock.json SHA-256：`3577eb5548e3f44086b3a8db7fb2483751f9af3dc7792a0728e145e025c13267`。
- 22个直接生产依赖、20个直接开发依赖，609个锁定安装位置、581个不同tarball。
- 全部609项resolved均为HTTPS官方 `registry.npmjs.org`，全部有integrity，无Git/file或其他来源。
- 关键锁版本：tsx4.19.1、TypeScript5.6.2、tsc-alias1.8.10、Fastify4.28.1、Twilio5.3.1、Voice SDK2.18.5、ws8.18.0。
- root安装生命周期有 `prepare: husky`，没有声明root preinstall/install/postinstall。
- 锁文件标记安装脚本的依赖有 esbuild0.23.1、vite下esbuild0.21.5、protobufjs7.4.0，以及仅Darwin可用的optional fsevents2.3.3。未安装包没有脚本正文，因此不能声称已审核其所有实际动作。

若dot下发安装任务，所需准确命令如下；**本轮没有运行**：

```bash
cd /workspace/ai-phone-cloud-recovery-20261012
npm ci --include=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
```

此命令使用现有锁文件且跳过root/transitive安装脚本。安装后还须核对esbuild平台二进制与tsx可用，再按上述离线命令实际复验；不能预先写成安装后必定通过。

## 已关闭的状态哈希元数据说明

旧包的八条状态记录共257字节。LF全文哈希 `9846b97cba7f5bd8f1084a1c0558e597d16d45bf430d84941f05ef57239a0fb9`；将八个LF替换为NUL仍257字节，哈希 `4a60f7ff786b3ac249c89a3407c680b41b6a5760a81539569a8f64bf03ddd0f5` 精确匹配清单。原异常记录保留，依据HASH_NOTE关闭为“分隔符校验口径未注明”。原ZIP不修改，此转换不证明原导出命令。

## 交付范围与剩余阻塞

恢复七文件，加上PROGRESS和此报告在本分支留本地版本。完整交付差异及本地commit回执放在外部恢复证据目录；没有推送、部署或外部同步，GitHub和Railway不能看到此次本地交付。

剩余阻塞是项目锁依赖尚未安装，正常专项/类型/构建/运行回归尚未执行。即使之后离线通过，真实403回调、Google/模型连接、普通手机双向音频、声音质量和实验延迟仍需独立有效批准与验收。dot可据此先验收恢复完整性与边界，再派发依赖置备和复验；本轮不重构字幕、声音、登录或来电、不改Railway/凭据、不新增费用、不试打。
