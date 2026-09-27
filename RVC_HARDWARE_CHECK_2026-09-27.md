# RVC 本机硬件验证（2026-09-27）

用户批准只用现有电脑先验证承载能力，不新增硬件或订阅。本轮为独立实验，不修改电话配置、号码、回调、默认翻译引擎，不拨号、不训练本人声线、不上传录音。

**结论：现有 GTX 980 可继续进行单路 RVC 声音小样验证，无需在此阶段新增硬件。** 固定兼容环境下，官方基础模型完成约 10 分钟真实时钟推理，4,000 块中的一次轻微超时随后恢复，没有持续积压或显存不足。此结论只适用于本轮单路计算链；训练本人模型、克隆听感、完整音频拼接和电话新增等待尚未验收。

## 已核实的环境

- Windows，Intel i3-12100F，4 核 8 线程，约 15.8 GiB 系统内存。
- NVIDIA GeForce GTX 980，4,096 MiB 显存，计算能力 5.2，驱动 581.63。
- 开始时显存约占 3,516 MiB；桌面和浏览器照常运行，未强制关闭用户程序。
- 独立 Python 3.12.14 环境在忽略的 `.runtime/rvc-hardware-lab/venv`。PyTorch / Torchaudio 2.7.1+cu118，核心依赖见 `scripts/rvc-probe-requirements.txt`；未修改 Codex 自带 Python 包。
- PyTorch CUDA 可见、实际 FP32 卷积执行且结果有限值，设备是 GTX 980。此项仅证明基础计算兼容。

## 上游与权重来源

- [官方 RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)，固定提交 `81eed5e8f68b6bed1789f682fe78cdd324495afc`。
- [官方权重仓库](https://huggingface.co/lj1995/VoiceConversionWebUI)，元数据修订 `e6d0c1a17da07c33557852f9dfa2bd44cc75737d`。
- 当前官方设备选择默认排除 SM < 5.3，RMVPE 还会再次检查。GTX 980 的测试若指定 `--force-legacy-cuda`，只在测试进程内改为 FP32 CUDA，并读取三阶段实际模型参数设备，不能称为官方支持或悄悄回退 CPU。
- PyTorch Windows wheel 通过官方 SHA256 核验：`80855ec840b7b06372ff43535d01393a8ec101842618d1f9ed629572b52aed71`。

| 公开模型文件 | 官方 SHA256 |
|---|---|
| `hubert_base/pytorch_model.bin` | `cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5` |
| `rmvpe.pt` | `6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193` |
| `pretrained_v2/f0G32k.pth` | `2332611297b8d88c7436de8f17ef5f07a2119353e962cd93cda5806d59a1133d` |

只使用公开未定制底模进行负载测试；底模输出不代表用户声音或克隆质量。权重只在本地保存，不进入 Git。

## 可重复的计算探针

1. 将上述官方 checkout、HuBERT 三个配置/权重文件、RMVPE 和 v2 32k 底模放在 `.runtime/rvc-hardware-lab/upstream` 的官方 `assets` 布局。`rmvpe.pt` 放在 `assets/rmvpe/rmvpe.pt`。
2. 在独立环境安装匹配的 PyTorch/Torchaudio CUDA 11.8 wheel 和 `scripts/rvc-probe-requirements.txt`。不能用安装成功代替实际 CUDA 运算检查。
3. `scripts/prepare-rvc-probe.py --upstream <checkout> --output <新文件.pth>` 核验官方基础权重 SHA256，再按上游布局提取推理格式。不训练，不载入未经校验的 pickle 对象，拒绝覆盖。
4. `scripts/benchmark-rvc-local.py` 执行 HuBERT → RMVPE → v2 F0 decoder。读取已存在的本机 WAV，循环使用，无麦克风或联网操作。

示例（仓库根目录，文件名需按实际准备情况填写）：

```powershell
$probePython = '.runtime/rvc-hardware-lab/venv/Scripts/python.exe'
& $probePython scripts/prepare-rvc-probe.py --upstream .runtime/rvc-hardware-lab/upstream --output .runtime/rvc-hardware-lab/base-v2-32k.pth
& $probePython scripts/benchmark-rvc-local.py --upstream .runtime/rvc-hardware-lab/upstream --checkpoint .runtime/rvc-hardware-lab/base-v2-32k.pth --input <本机测试WAV> --output .runtime/rvc-hardware-lab/new-result.json --device cuda --force-legacy-cuda --block-ms 200 --context-ms 1000 --crossfade-ms 40 --iterations 20 --threads 4
```

CPU 对照使用 `--device cpu` 并去掉 `--force-legacy-cuda`。通过短时筛选后，`--seconds 600 --pace` 才表示约 10 分钟墙钟持续负载；不带 `--pace` 的 600 秒只表示输入音频量。

## 统计口径与验收边界

- 记录同步墙钟每块 p50/p95/p99、计算 RTF、计算超时次数、模拟队列、显存峰值。GPU 计时包含同步与主机块传输。
- `--pace` 另记录按真实时钟到达的开始迟到、完成期限迟到，包含调度影响；计算队列模拟不能冒充这些真实时钟指标。
- 固定历史上下文会增加计算量，但不是每次额外等完整上下文。块长、交叠和搜索窗口单独列出，不把模型耗时当作电话等待。
- 本探针关闭检索索引，不包括输入重采样、SOLA 拼接、电话编解码、网络、翻译引擎和播放设备。RTF < 1 只是可继续评估的必要条件。
- 本轮是单路推理。本人模型训练、两个方向同时转换的承载能力尚未验证，不由单路成绩外推。
- 通过算力筛选不代表翻译准确、声线稳定、本人克隆相似或电话新增等待小于 300 ms；后者仍是后续实验目标。

## 本轮结果

三个模型文件均已完成 SHA256 校验。基础生成模型的 457 个推理参数键通过严格加载检查，实际计算使用官方学习权重；三阶段均核实运行设备与 FP32 类型。

### 完整模型短测

输入为本项目之前保存在本机的 55.8 秒英文译音 WAV，先离线转换为 16 kHz，再按实时入口的滚动历史窗口计算。声音不上传，不播放，不保存转换结果，不用于训练。以下均为预热后的计算耗时，非电话等待。

| 设备 / 分块 / 历史上下文 | 实测块数 | 计算中位 | p95 | 最大值 | 超出分块期限 | 计算 RTF |
|---|---:|---:|---:|---:|---:|---:|
| GPU / 200 ms / 1,000 ms | 40 | 65.02 ms | 68.85 ms | 71.41 ms | 0 | 0.327 |
| CPU / 200 ms / 1,000 ms | 20 | 345.91 ms | 365.68 ms | 366.53 ms | 20 | 1.727 |
| GPU / 100 ms / 2,500 ms | 100 | 78.36 ms | 82.55 ms | 126.77 ms | 1 | 0.792 |
| GPU / 150 ms / 2,500 ms | 100 | 79.69 ms | 83.34 ms | 93.22 ms | 0 | 0.533 |

- CPU 的 4 秒输入形成约 2.91 秒模拟计算积压，当前默认回退 CPU 的配置不适合作为此场景的实时路线。
- 100 ms 分块有一次 26.77 ms 的模拟积压，随后恢复；尚不能说始终按时。
- 150 ms 分块保留 2.5 秒历史上下文，短测无计算超时，选作持续负载候选，不更改电话配置。
- 150 ms 的名义块/交叠/搜索缓冲为 200 ms，仍不能把该数字或与计算耗时相加的估算称为实际电话新增等待。
- 150 ms 短测第一次预热计算约 3.56 秒，预热 30 次共约 5.97 秒；模型加载另计。将来必须预加载并保持模型驻留，不能每一句话重新加载。

### 持续运行

使用 GPU、FP32、150 ms 分块、2.5 秒历史上下文、40 ms 交叠，显式 `--pace --seconds 600`。执行时间 2026-09-27 05:57:58–06:08:12 UTC，包含启动/预热；预热后的真实时钟负载为 599.93 秒，输入音频量 600 秒，共 4,000 块。

| 指标 | 实测 |
|---|---:|
| 计算中位 / p95 / p99 | 82.15 / 88.89 / 95.35 ms |
| 最慢一次计算 | 173.22 ms |
| 计算 RTF | 0.552 |
| 计算超出 150 ms 期限 | 1 / 4,000 |
| 真实时钟完成期限迟到 | 1 / 4,000，最多 23.60 ms |
| 结束时真实时钟完成迟到 / 模拟积压 | 0 / 0 ms |
| PyTorch 显存保留峰值 | 918 MiB |

三阶段均核实为 `cuda:0`、`torch.float32`；无显存不足、无非有限输出、无推理异常。不能写成“零超时”：确实出现过一次轻微超时，但没有持续积压。该块后续一块计算为 79.68 ms，积压随即恢复；前后半段的计算中位分别为 82.04 / 82.24 ms。桌面和浏览器仍运行，后半段抽样的全卡显存占用约 3,746 MiB；这不是只有测试进程的占用，也不是连续采样得到的全卡峰值。

模型常驻且先完成预热是上述成绩的前提。本轮首个预热块约 3.50 秒，30 次预热合计约 5.84 秒，HuBERT/解码器加载另计约 0.78 秒；完整进程启动还包括导入和校验。不能把预热后 82 ms 当成每次冷启动的等待。

本轮通过的是继续做单路声音小样的硬件筛选。下一阶段再验证本人模型训练是否装得下、声音相似度、英文清晰度/声线稳定性，然后才能决定是否开发电话候选；不由计算成绩推断这些已通过。

### 辅助架构预检

公开权重下载较慢时，另做了明确标记 `UNTRAINED_ARCHITECTURE_ONLY` 的随机权重预检。三模型同时驻留 GPU，PyTorch 显存保留峰值约 928 MiB；三个单独阶段中位约 15.97 / 23.11 / 34.64 ms。它只用于排除基础兼容/容量问题，不能替代上表学习权重计算链，更不是声音质量证据。两个早期预检分别因缺少可选内存统计包、Windows 内存统计调用的 HANDLE 类型问题失败，改用修正的系统调用后完成；这些不是模型/GPU 不支持的证据。

### 证据与检查

- 私密目录：`.runtime/rvc-hardware-lab/`，包括 `cuda-smoke.json`、各 `gpu-*-short.json`、`cpu-200ms-context1000-short.json`、持续负载报告及环境版本清单。JSON 只在本地，公开仓库只保存程序与脱敏汇总。
- 独立环境 `pip check` 通过；两个脚本语法检查通过；损坏底模在反序列化前被拒绝；既有基准报告的拒绝覆盖检查通过；差异检查通过。
- 上游日志中的“索引检索失败或未启用”来自本轮明确设置的 `index_rate=0`，不是本轮模型推理失败；个人检索索引尚未建立。
- 代码审查核对实际 GPU/FP32、同步计时、真实时钟迟到与模拟队列的区别；未将未完成的电话、声线或训练验收写成通过。
- 实验期间本机电话 `/api/health` 返回 200；此处只证明原服务仍响应，不替代真实通话检查。
