# 逐句对话第一里程碑

日期：2026-10-09。功能起点：`codex/local-phone-workbench` / PR #2，
`df3c4474013e0612e0d5b20a21d673c0af6489e1`。开发与浏览器验收均在云端
Linux 工作区，不连接用户电脑。

## 可复现离线验收

使用仓库现有锁文件与当前匹配 Node/npm，不升级依赖：

```bash
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
npm run build
npm test
npm run test:conversation:browser
```

浏览器检查复用已安装的 Chromium/Chrome，可用 `CHROME_BIN` 指定 executable。
脚本只在 loopback 临时端口提供静态页面，使用现有 `ws` 依赖通过 DevTools
执行真实浏览器断言；结束关闭浏览器与临时服务。它没有电话 API、供应商连接或
麦克风操作。结果及截图保存在忽略提交的
`.runtime/conversation-browser/acceptance.json` / `acceptance.png`。

人工查看可运行一个静态服务（不是电话服务）：

```bash
python3 -m http.server 5082 --bind 127.0.0.1 --directory public
```

打开该环境的 `http://127.0.0.1:5082/conversation-demo.html`，逐步或自动重放
24 个合成事件，也可追加 30 句检验阅读历史。静态页面不拨号、不播放声音、不访问
供应商。真实工作台复用相同 reducer 和 view，但通话需原有认证与供应商配置。

## 事件与显示

每通电话有独立 `ConversationEventAdapter`，发布兼容旧 `transcript` 流的新
`conversation` 事件。`sessionId` 隔离通话，`utteranceId` 稳定关联语义单元，
`role` 标明说话者；源时间与 sequence 决定双方统一时间顺序，不按说话者堆成两段。
这里的源时间为已有 ASR turn 时间或该语义小节首次被应用观察的时间，不是跨设备
精确声学时间，也不能用于推导口到耳延迟。

`text` 事件包含 `kind`（original / translation）、完整当前 `text`、`final`、
独立 `revision`、`pairing` 与 `boundary`。更早修订、已确定之后的草稿和其他
session 的事件不能覆盖当前文本。译文先到或晚到均更新同一卡片；英文与中文
各自确定，不靠标点数量猜对应关系。长句使用已有 prefix/caption 适配器给出的
可靠语义小节；仅显示上的句界不能用来建立跨语言关联。

`playback` 事件独立包含 delivery ID、revision 和证据类型。queued、sent、
played、cancelled、unconfirmed 分别显示。只有 seal 给出的全部预期 delivery
均收到匹配 mark，才显示该语义小节的线路播放确认；缺失或乱序 delivery 不能
提前显示 played。线路 mark 不证明真人听到、听清或译文正确。

UI 每个卡片固定两个文字位置；草稿标为临时，确定文字标为已确定。迟到修订保留
卡片 DOM，阅读历史时保留可见锚点；回到最新按钮恢复跟随。历史与导出也按配对
语义单元排列。特殊字符按纯文本渲染。

## 实际浏览器检查

自动化断言覆盖：临时状态、迟到译文及卡片身份、源时间交替、确定文字仍排队、
已送出尚未确认、模拟 mark 独立确认、迟到插话位于长句两小节之间、旧草稿无法
覆盖数字/否定、取消状态、译文先到、HTML 文本安全、自动跟随、阅读历史暂停、
追加时位置保持与回到最新。另由离线回归覆盖服务端配对、修订、取消及流控。

本轮生产构建与730项运行回归通过（725通过、5项Windows专属检查在Linux跳过）。
额外的全仓测试源码 `tsc --noEmit -p tsconfig.json` 尚有14个既有类型错误，位于
`outbound-readiness.test.ts` / `solo-security.test.ts` 及浏览器测试的原有
`deferred.resolve()` 行。同依赖的独立基线worktree也有14个，按文件、错误内容与
数量比对一致；本轮没有新增错误，该历史检查没有被写成通过。

## 边界与后续

- 连续直出的累计译文没有可靠原文对应关系，保留为未配对诊断；不将其到达次序
  包装成逐句准确对齐。引擎和声音未替换。
- 英文回程继续传原声，中文字幕是旁路，字幕失败不阻塞原声；未新增中文回译音频。
- Pocket 参数化与严格离线运行见 [运行说明](CLOUD_POCKET_RUNTIME.md)。当前云环境
  没有模型，也没有历史完整 Python freeze，真实 Linux 合成仍待独立置备与验收。
- [云模式配置与独立认证设计](CLOUD_MODE_DESIGN.md)保留 local-only 安全检查；
  cloud 尚未实现认证/owner 隔离，当前明确拒绝启动，不具备可部署云电话能力。
- [原生翻译 ADR](ADR_REALTIME_TRANSLATION.md)仅记录候选，不调用付费接口。
- 数字、否定、修订、长句持续跟随和尾部播放积压仍需之后用相同材料分别评价
  字幕含义、流控与耳听。模拟句子准确只是 fixture 重放正确，不能作为翻译质量证据。
- 本轮没有真实麦克风、普通手机通话、API 实连、云部署、Twilio 回调变更或人耳
  延迟验收，不能沿用历史 Windows 成绩作为本环境的结果。

草稿 PR 以 `codex/local-phone-workbench` 为基线，便于单独审阅本里程碑；
依赖 PR #2 的功能基础，未合入 `main`。
