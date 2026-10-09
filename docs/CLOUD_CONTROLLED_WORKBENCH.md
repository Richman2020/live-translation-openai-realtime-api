# 实际工作台的受控电话接入

日期：2026-10-09；继续基线 `bda4697b081cb940772ec601b97dadc563922042`。
本轮把既有控制协议接到 `public/index.html` 工作台，使用真实 Fastify 路由与
原生浏览器请求验收。身份、Voice SDK、签名器、预算许可及供应商仍由离线测试
显式注入；没有真实登录、JWT、麦克风、付费接口或普通手机电话。

## 页面入口与权限

只有 `buildSoloServer({ browserControl })` 的显式依赖分支提供 `/controlled`。
返回真实工作台 HTML 的受控标记，`app.js` 据此加载独立页面适配器；默认 `/`
及本机 token/presence/设置流程保持。注入分支的 `/`、`/index.html` 不提供本机
入口。生产主入口没有注入该对象，两个 cloud 启动保护仍无条件拒绝。

非秘密 HTML 和明确列出的静态依赖仍检查实际 loopback socket、固定 public
Host、歧义/转发头和错误 Origin。它们不返回认证能力。`GET /api/browser-session`
须经过原来的当前 cookie 会话和来源验证，返回当前 CSRF、只读 controller
提示、本人活动电话、完整 busy gate 与 Pocket 策略；无登录凭证、leaseId、
供应商配置或 Voice token。读取上下文不能升为写能力。每次写仍使用新 POST
上下文、精确 Origin、当前 CSRF 和独立控制凭证。

每个 document 生成新 tabId，leaseId/CSRF/Voice 许可只留在闭包，不写入 URL、
localStorage 或 sessionStorage。刷新不会恢复旧控制凭证；其他标签可读取本人
状态和字幕。已有控制、活动电话或清理未确认时不能接管。

## 电话与退出

页面依次领取控制权、准备麦克风、创建服务器 reservation、准备每通 Voice
许可、调用 SDK 加入。每通只有当前操作可继续，重复点击、取消、超时及迟到
返回经过代际检查；迟到麦克风、SDK 或设备会回收。SDK accept 仅确认浏览器
加入，实际对方连接和译音就绪分别使用服务器状态，不把准备成功当作接通。
最初 join 票据期限不代替已经加入电话的当前 lease/预算生命周期。

续约由持有控制的页面显式 POST；可见且状态连接时定时续约。隐藏或状态中断
暂停自动续约，读取、SSE 重连和返回页面不会续权；恢复后须显式续约。
准备期间的隐藏或断连会退休该次操作，稍后恢复不能继续旧加入；已经加入的
电话在有效期限内仍由当前授权控制，SDK 终止回调不因隐藏或状态断连而被忽略。
普通挂断可保留未到期租约用于安全重试，但暂停自动续租，须显式续约恢复。
挂断、导航离开工作台和退出立即退休本页媒体，线路清理由服务器独立继续。
pagehide 的通知只能尽力发送，未收到结束确认不能宣称两腿已挂断；租约到期
及服务器生命周期作为独立保护。bfcache 恢复不复活旧凭证或 SDK。

服务端 busy gate 包括准备、活动电话、线路和预算未知状态。页面只能在当前
授权与 gate 均允许时拨下一通；清理失败保留待确认提示。网络恢复不是控制
恢复，也不是挂断成功证据。

## 翻译与验证

页面固定 Pocket-prefix/Michael，保留英文原声回程及旁路中文字幕，不增加
中文回译配音。继续使用既有逐句模型和 view：双方按源时间交替、每句原译文
配对、迟到就地修订、临时/确定和待播放/线路确认分开；历史阅读暂停滚动。
当前页面记录只留内存，刷新不会伪装恢复尚未持久化的字幕历史。

执行 `npm run test:controlled:browser` 会启动临时 loopback HTTPS 测试代理、
真实应用及隔离 Chromium profile；SDK/provider/身份/事务许可仅在该脚本中
显式 fake。测试证书为一次性容器材料，不是部署凭据。验收结果、截图与
计数与配对字幕 `conversation.png`、撤销状态 `acceptance.png` 写入忽略的
`.runtime/controlled-browser/`，精确结果见 `PROGRESS.md` 和
草稿 PR #3 对应提交 CI。既有 `test:conversation:browser` 继续独立运行。

真实登录与存储尚未选择，最小事务和恢复要求见
[CLOUD_TRANSACTION_RECOVERY.md](CLOUD_TRANSACTION_RECOVERY.md)。完整 Python
freeze、预置模型和 Linux warm 仍缺材料，见
[CLOUD_POCKET_RUNTIME.md](CLOUD_POCKET_RUNTIME.md)。本轮完成后停在这些部署
输入，不自行选择 provider/store、创建权限、下载模型、部署或改 Twilio 回调。
