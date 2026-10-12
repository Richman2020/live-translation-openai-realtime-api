# Nano 本机加速筛选：已快于播放，尚未接入电话

日期：2026-09-28。用户批准沿用现有电脑，先验证认可的 B 声线能否提速，再决定电话候选；不新增硬件、收费服务或本人声音上传。此前 B 的听感确认保留，见 [PROGRESS](PROGRESS.md) 和 [Nano 实验](CHATTERBOX_NANO_PILOT_2026-09-27.md)。

## 结论

单独加速文字转声音 token 不够；将 **T3、flow、HiFT 声码器**一起放到 GTX 980、参考编码和官方水印留 CPU 后，本轮六组文字的合成吞吐都快于音频播放。短语生成中位数约 0.70–0.99 秒，连贯三句约 2.14 秒。现有电脑值得继续做候选，无需先购买显卡。

这些时间从完整文字交给 `generate()` 到完整波形返回，**不是开口到对方耳朵的电话延迟，也不是流式首块时间**。模型/参考加载、翻译、短语确认、编码、网络、播放缓冲均另算。短语合成本身仍超过先前提出的 300 ms 筛选目标；该目标未达成，不将其改写成已通过。

本轮停止在“加速样本待本人复听”。由于运行时和计算设备发生变化，原 B 的声音认可不能自动延伸至新样本。电话接入、实际有节奏的增量输入重放和端到端时延均未完成。

## 实际环境与改法

- i3-12100F / 16 GB RAM / GTX 980 4 GB，驱动 581.63、计算能力 5.2。
- 新建 `.runtime/chatterbox-nano-gpu-lab/venv`，旧 CPU 和 RVC 环境版本保持不变，不更改驱动。
- Python 3.12.14、Torch/Torchaudio 2.7.1+cu118、Transformers 5.2.0，CPU 4 线程、interop 1，FP32 / SDPA；无混合精度、量化、编译或减小模型。相较原 CPU 环境，84 个 distribution 仅 Torch、Audio、Sympy 三项版本变化。
- 官方 Torch/Audio wheel SHA 与官方索引相符；Perth 37 源文件校验、固定模型与上游提交校验通过。环境来源和完整冻结清单保存在本机。
- `pip check` **不是全绿**：保留旧环境已有的 Gradio / pykakasi / spacy-pkuseg 缺项，并有上游 Torch/Audio 2.6 pin 与本轮 2.7.1 的有意冲突。Nano 导入、实际完整生成通过；不宣称该环境支持上游全部应用。
- 固定 Chatterbox 提交 `5de7a54aa4e5e2baadb0182dde554908b48b85c2`、Nano 模型 revision `71ccd1d0081b430592cea481f4307e764e07bc64`、Perth 提交 `ff1c8ac55a976971245cdd53c18d6131ca00d993`；未修改上游或权重。
- 本人参考、temperature 0.75、文字、seed 及完整生成参数与 B 绑定。先在 CPU 准备本人条件，再移动实际参与推理的模块，保留未使用的 T3 text head 和参考编码器在 CPU。
- flow / HiFT 的调用边界显式迁移张量，保留整数类型，返回波形到 CPU，继续原来的淡入与官方 Perth 水印。没有默认回退掩盖 CUDA 失败。

## 三组真实测量

每组单一常驻模型：1 次预热＋6 组文字各重复 3 次，共 19 次生成。预热排除在中位数和加权吞吐之外。三个进程顺序运行，没有并行跑模型。下面均为完整波形返回时间，中位数，单位秒。

| 文字 | 新环境 CPU 对照 | 仅 T3 CUDA | T3＋音频解码 CUDA |
|---|---:|---:|---:|
| 连贯三句 | 12.931 | 6.460 | **2.140** |
| 询问时间 | 4.946 | 2.807 | **0.793** |
| 否定与预约时间 | 7.566 | 4.231 | **1.328** |
| 短语：问候 | 4.123 | 3.192 | **0.699** |
| 短语：下班后交流 | 5.747 | 3.740 | **0.990** |
| 短语：请告知时间 | 4.862 | 3.315 | **0.734** |

- 全部正式样本的总生成时间 / 总音频长度（RTF）：CPU **1.948**，仅 T3 CUDA **1.147**，完整合成 CUDA **0.329**。RTF 小于 1 说明这个有限工作负载的吞吐快于播放，不等于电话低延迟或无限长稳定性。
- 完整合成 CUDA 三句输出 7.44 秒；旧已认可 CPU B 为 7.16 秒，新环境 CPU 对照为 7.92 秒。模型权重和显式参数相同，但 Torch 版本、设备与随机数路径影响实际采样；不要把三个不同波形当作同一音频的纯算力对比。
- 完整合成 CUDA：模型加载 5.13 秒、本人参考准备 2.62 秒、首次预热生成 4.53 秒，均不算入正式合成中位数。后续电话候选必须在通话就绪前完成加载和预热。
- 完整合成 CUDA 的 Torch allocator 峰值已分配约 **1302 MiB**，峰值保留约 **1614 MiB**，本轮无 OOM。这不是 Windows WDDM 专用显存驻留值；CUDA 可用内存与 `nvidia-smi` 显示可能不同。
- 第一份正式三句样本：T3 约 1.61 秒、flow 0.33 秒、HiFT 0.20 秒、水印 0.05 秒。保留官方水印，下一阶段的首音问题不能靠去掉水印解决。

## 队列与流式边界

分析器将 whole / phrase 分别放进理想单路 FIFO 模型，各自从零开始；复用真实生成耗时和真实音频时长，但文字到达时刻是人工设定，播放也仅计算时刻，没有实际电话或声卡输出。

- 短语场景：CPU 模拟最大合成等待约 20.92 秒，仅 T3 CUDA 约 8.05 秒，完整合成 CUDA 为 0。最后一项只说明给定到达间隔下算得过来。
- 完整合成 CUDA 短语模拟最大播放积压 3.16 秒；整句模拟达到 **8.065 秒**，仍可能触碰现有电话 8 秒积压上限。合成提速不能替代有界队列、播放节奏和取消处理。
- 没有把模拟的文字到播放时间作为真实延迟，也没有把分开生成的三个短语拼起来冒充流式。
- 固定上游 `generate()` 最后才返回完整波形。T3 内部有 KV cache，但不导出 token callback；`S3GenStreamer` 仅出现在注释中，仓库没有实现。旧 flow-cache 路径未实现，Nano attention 的全上下文与随机噪声也使简单前缀拼接不具备无损保证。因此本轮不添加伪流式开关。

## 本轮实现与验证

- `scripts/benchmark-nano-realtime.py`：三种显式设备策略、固定输入/模型/来源校验、GPU 同步计时、分组件耗时、预热隔离、实际音频和错误留存。生成期间 HF offline＋Python socket guard，已知本机 IPv6 能力探测仍被拦截并单独计数；不等同于 OS 防火墙隔离。
- `scripts/analyze-nano-realtime-probe.py`：从实际 WAV 核对哈希、格式、数值、帧数和固定输入，拒绝失败/缺失/疑似截断样本；分别计算真实完整文件耗时和理想队列。音频唯一数使用 WAV data 块，避免将 PEAK 时间戳误当波形变化。
- `scripts/test-nano-realtime-analysis.py`：22/22 通过，覆盖缺文件/哈希损坏/参数与 seed 变更/截断/非有限数/预热冒充正式样本/跨场景污染/时间戳与 PCM 身份等。
- 三组真实运行均完成，模型与参考校验通过，未报告未知联网尝试、近 token 上限、静音或数字满幅削波。文件完整与 token 未触上限不能证明英文内容正确、尾词完整、声线稳定；这些需实际试听。
- 独立复核 171 个新输出＋9 个旧 B 输出的 SHA、尺寸和格式通过；用独立 `audioop` 回解 μ-law 与电话 WAV PCM 完全相同，重新从 native 重采样/编码也一致。试听页另核对 18 份复制 WAV 与源、2 份来源报告，均匹配。
- CPU 与仅 T3 CUDA 在每个 fixture 内重复三次的 PCM 相同。完整合成 CUDA 的 native 重复不逐字节相同，但最大绝对差仅约 2.53e-7–1.02e-6、差值 RMS 2.77e-8–5.57e-8；电话 PCM 每对最多 5 个采样点不同。未将这种细微数值差异称为声线不稳。每组 token 数相同，原报告未保存 token 序列或 digest，不能追认 token 序列完全一致。

## 本机证据与重现

所有个人音频、模型、报告和试听页均在 Git 忽略的 `.runtime`，不上传 GitHub。

| 内容 | 本机相对路径 |
|---|---|
| 环境/来源 | `.runtime/chatterbox-nano-gpu-lab/environment-manifest.private.json` |
| 仅 T3 CUDA | `.runtime/chatterbox-nano-gpu-lab/probe-20260928T090323-t3-cuda/` |
| 新环境 CPU 对照 | `.runtime/chatterbox-nano-gpu-lab/probe-20260928T090551-cpu-control/` |
| 完整合成 CUDA | `.runtime/chatterbox-nano-gpu-lab/probe-20260928T090916-synthesis-cuda/` |
| 已认可 B | `.runtime/chatterbox-nano-lab/probe-clarity-20260928T082702-candidate075/` |
| 试听对照 | `.runtime/chatterbox-nano-gpu-lab/review-20260928-gpu/index.html` |

每个测量目录都有 `report.private.json`、`analysis.private.json` 及 19 组 native WAV / 电话 WAV / μ-law，旁边保留 stdout/stderr 日志。脚本拒绝覆盖旧目录；重跑使用新时间戳。模型实验串行运行。

```powershell
$python = '.runtime/chatterbox-nano-gpu-lab/venv/Scripts/python.exe'
$output = '.runtime/chatterbox-nano-gpu-lab/probe-' + (Get-Date -Format 'yyyyMMddTHHmmss') + '-synthesis-cuda'
& $python scripts/benchmark-nano-realtime.py `
  --model-dir .runtime/chatterbox-nano-lab/model `
  --reference .runtime/chatterbox-nano-lab/reference-10s.wav `
  --upstream-dir .runtime/chatterbox-nano-gpu-lab/upstream `
  --accepted-report .runtime/chatterbox-nano-lab/probe-clarity-20260928T082702-candidate075/report.private.json `
  --output-dir $output --mode synthesis-cuda --threads 4 --repeats 3 --fixture-set both
& $python scripts/analyze-nano-realtime-probe.py `
  --report ($output + '/report.private.json') --output ($output + '/analysis.private.json')
```

## 下一关

1. 本人对照旧 B 和加速三句、问句、否定/时间与 8 kHz 版本，确认自然度、相似度、咬字和完整性。短语需要单独听，不能以长句认可覆盖。
2. 声音通过后，先实现独立常驻 worker、稳定译文短语提交、有界合成/播放队列、取消和迟到结果丢弃，做实际有节奏的文本重放。不能把会改写的字幕 delta 直接朗读，也不能同时播放原译音和克隆声。
3. 在真实重放及新增等待门槛明确后，再做可切换的电脑中文→手机英文候选；反向中文维持原路线。最后才测真实双向电话。翻译准确度另验收，声线合成不负责修复错译。

本轮没有改电话默认、拨号或调用收费服务；既有夜间自动跟进保持暂停。
