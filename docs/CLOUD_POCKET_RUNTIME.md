# Pocket 云端运行兼容基础

日期：2026-10-09。既有里程碑实现运行路径与进程清理兼容，在云端用假 worker 和离线材料验证。最新授权允许在现有云端环境从官方来源重新取得 Pocket 必要材料，结果见 [官方材料审计](POCKET_CLOUD_MATERIALS_2026-10-09.md)：已取得固定软件包/配置/许可并解析新的依赖候选，模型入口被环境代理阻塞。未安装 Pocket Python 环境、部署服务、改 Twilio 回调或拨打电话；不能据此宣称 Linux 上真实合成、浏览器麦克风或手机通话已通过。

## 运行路径

| 服务端环境变量 | 用途 | 未设置时 |
| --- | --- | --- |
| `POCKET_RUNTIME_DIR` | 已预置的本地模型与 Python runtime 目录，绝对路径 | 仓库内 `.runtime/pocket-tts-lab` |
| `POCKET_PYTHON_EXECUTABLE` | 单个 Python 可执行文件，绝对路径；不接受命令或额外参数 | Windows：runtime 内 `venv/Scripts/python.exe`；Linux/macOS：`venv/bin/python` |

变量只能由运行环境管理者设置，不通过网页设置 API 接受。`PocketVoiceWorkerOptions.runtimeDir` / `pythonExecutable` 可供程序显式覆盖环境变量。空的环境变量采用默认值；相对路径、URL、控制字符及首尾空白会在启动前拒绝，错误只返回固定代码。带空格的合法绝对路径通过 `spawn` 独立参数传入，`shell: false`。

参考 [不含密钥的变量模板](pocket-runtime.env.sample)。模板不会自动加载；以后由服务进程环境或现有 `.env` 注入真实路径，不能将模板中的示例目录当作已有安装。

目录仍须包含：

```text
<POCKET_RUNTIME_DIR>/
  venv/                         # 仅默认 Python 路径使用，可用独立 executable 覆盖
  model/
    model.safetensors
    michael.safetensors
    tokenizer.json
    english-public-local.yaml
```

`english-public-local.yaml` 中的模型和 tokenizer 路径必须对应当前 runtime 的绝对路径。搬迁 Windows 的 YAML 到 Linux 时不能沿用旧 Windows 路径；worker 将其与已校验的 wheel 内官方配置逐项比较，只允许这两个本地路径替换及原有远端 fallback 删除。路径配置没有放宽配置、模型或声音的校验。

## 固定引擎与离线边界

沿用 [既有固定男声对照](../FIXED_US_VOICE_AB_2026-10-02.md) 的 Python 3.12、Pocket TTS 3.3.0、Torch 2.6.0+cpu 和 NumPy 2.2.6；本轮没有更改 Node 锁文件、引擎版本、模型、随机种子、温度、CPU 线程或声音。worker 保留 Pocket/Torch 版本及 Pocket 实现、官方配置哈希检查。完整历史 Python freeze 不在当前仓库，不从用户电脑提取。最新改为官方来源的全新 Linux binary 依赖候选：49 项精确版本/哈希，metadata 层面闭合但尚未安装和运行验证，不能称为旧 freeze 或 warm-ready 环境。制作 Linux runtime 前须审核候选及许可并另行获准安装，不能用非锁定 `pip install` 冒充可复现环境。

| 本地资产 | 固定校验 |
| --- | --- |
| `model.safetensors` | 219029196 bytes；SHA256 `916ccd2686e9311cb40054893a3c4284393d658825ffc714a276f3e9b152344f` |
| `michael.safetensors` | 7276344 bytes；SHA256 `401711f60394aa6085627f7050c1b3f97b31aa7138784811bc6c6ec7d7eaad0c` |
| `tokenizer.json` | 245020 bytes；Git blob SHA1 `fe3e7fe6185e4a3bc218fa8f5ed993ecb098201c` |

Michael 是既有公开固定英语预设。worker 不接受 URL、下载、个人录音、克隆声音或引擎切换参数。缺失/篡改资产立即失败，不下载补齐；worker 环境继续强制 `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1` 并启用既有 Python socket 审计拦截。这是应用内约束，后续真实运行仍应采用限制出站网络的环境。OpenAI/Twilio 密钥、代理凭据、HF token、`PYTHONPATH` 等不继承到 Pocket 子进程，只额外传入已验证的 runtime 目录和必要系统变量。

## 当前材料取得状态与阻塞

2026-10-09 以 `3d4660b` 为基线按最新授权取得官方 Pocket 3.3.0 wheel（86452
bytes）和 sdist（802539 bytes），校验 PyPI SHA256；wheel 实现和 English 配置
与现有 worker 锁定哈希完全一致。取得固定源码/许可、Torch CPU metadata 和
NumPy metadata，并只读解析 49 包的新 Linux 候选，未安装/执行下载代码。
已在 ignored `.runtime/pocket-tts-lab` 创建审计缓存和仅替换本地路径的 YAML。

`model.safetensors`、`michael.safetensors`、`tokenizer.json` 仍不存在；三项实际
收到 0 bytes。原始 `huggingface.co` 的 HTTPS CONNECT 被当前环境代理以 403
拒绝，标准网络权限和自动审查升级执行也无法通过；未到供应方/CDN，未换镜像
或绕过代理。完整来源、大小、哈希、候选清单及下一步见 [材料审计](POCKET_CLOUD_MATERIALS_2026-10-09.md)。

历史完整 freeze 缺失不再要求用户电脑补取，但新候选必须独立审查/安装/运行
验证；当前系统没有 Pocket/Torch、NumPy 版本也不匹配。官方访问、资产、完整
wheelhouse 与安装许可齐备后才可验收真实 Linux warm。`package-lock.json` 和
另一项 RVC probe requirements 都不能替代此 Python 环境。持久预算/恢复与最少
部署输入见 [事务与恢复门槛](CLOUD_TRANSACTION_RECOVERY.md)。

## 常驻与清理

`pocket-runtime.ts` 每个 Node 进程只创建一个 Pocket worker；状态查询不会启动模型。就绪检查等待严格校验、加载和一次预热后才成功；后续通话复用该 worker。推理保持串行，原有待处理作业、PCM 和输出时长上限保留。取消后丢弃迟到音频，仍等待 active 作业已验证结束，防止下一通串入上一通输出。

Linux/macOS 子进程通过 `detached: true` 创建本服务独占进程组，仍由父服务持有 IPC。启动/作业超时或父进程正常退出只清理该组，不按进程名扫描全机。空闲关闭先发送 stdin EOF，最长保留五秒宽限；此期间父进程退出钩子仍有效，worker 退出后继续清掉其遗留子进程。Windows 保留已有 `taskkill /PID /T` 身份限定清理。操作系统强制杀死 Node（如 SIGKILL）无法执行退出钩子，真实云运行需由容器/进程监督器共同回收该实例的进程。

后续首个云实例宜固定单个 Node 进程与一个 warm worker，先独立测冷加载、峰值内存及连续长句处理能力；不启用 cluster、多副本或并发电话，不能把历史 Windows 的速度当作云资源承诺。HTTP/SSE/WS 鉴权、`PORT`、HTTPS/WSS 入口和电话线路停机清理属于主服务边界，本文件没有开放任何控制 API。

## 本轮离线验证与剩余验收

```bash
node --import tsx --test tests/pocket-voice-worker.test.ts tests/pocket-phone-bridge.test.ts tests/pocket-prefix-bridge.test.ts
python3 scripts/test-pocket-voice-worker.py
```

测试包括跨平台默认路径、显式目录/executable、无 shell 注入、无凭据继承、路径拒绝、缺模型失败且目录未产生下载、串行复用/取消、协议哈希、有限队列，以及真实 Linux 假进程 EOF 清理其子进程并保留旁边无关进程。假 worker 不加载模型、不访问供应商。

真实 Linux Pocket 预置、真实云服务、麦克风/普通手机双向通话尚未验收。下一轮需在取得锁定依赖与已审核资产后独立验证 warm readiness，再用长句、数字、否定、插话、取消及播放积压材料验证持续流控；队列指标或 Twilio mark 不等于真人听到时间。
