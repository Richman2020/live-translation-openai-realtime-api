# Pocket 官方云端材料审计

日期：2026-10-09；工作基线 `3d4660b`，环境为当前云端工作区、Linux x86_64。
用户已授权从官方来源重新取得必要材料，不读取用户电脑。此次只下载公开文件、
读取包元数据与解析依赖；没有安装包、执行下载的代码、启动模型、创建云资源或
调用付费服务。原有固定 Michael、引擎版本、模型哈希和离线 worker 边界未修改。

**已取得官方软件包、配置和许可；三个 Pocket 模型资产均未取得。**
`huggingface.co` 在当前环境代理的 HTTPS CONNECT 阶段返回 `403 Forbidden`。
标准额外网络权限及自动审查后的升级执行也得到相同结果；自动审查没有拒绝执行。
请求尚未到 Hugging Face 或其 CDN，不代表模型需付费或账号授权。没有换镜像、
清除代理、关闭 TLS 校验或申请其它服务凭据，已停止反复重试。

## 官方来源与固定版本

- Pocket：官方 [Kyutai GitHub 固定提交](https://github.com/kyutai-labs/pocket-tts/tree/3dbee45d343d7dddd0d105468d17f8dcba14db3e)。
  `pyproject.toml` 标明 3.3.0；该提交的实现和 English 配置分别与
  [PyPI 3.3.0](https://pypi.org/project/pocket-tts/3.3.0/) wheel 及现有 worker 哈希一致。
  GitHub API 的 tag 请求也被代理拒绝，所以此次没有重新取得 tag 对象。
  [固定提交许可](https://raw.githubusercontent.com/kyutai-labs/pocket-tts/3dbee45d343d7dddd0d105468d17f8dcba14db3e/LICENSE)
  是 MIT，wheel 内 LICENSE 字节相同。PyPI JSON 中的 license 字段为空，不能用它替代 LICENSE。
- Torch：锁定 `2.6.0+cpu`，CPython 3.12、Linux x86_64 CPU wheel。来源为
  [官方 CPU 索引](https://download.pytorch.org/whl/cpu/torch/)，符合
  [官方 2.6.0 CPU 安装说明](https://pytorch.org/get-started/previous-versions/#v260)。
  本次取得并核对 PEP 658 metadata，未下载或安装 Torch wheel。
  [v2.6.0 许可](https://raw.githubusercontent.com/pytorch/pytorch/v2.6.0/LICENSE)
  和 metadata 标明 BSD-3-Clause；打包时仍须保留 wheel 中全部第三方 notices。
- NumPy：锁定 [官方 PyPI 2.2.6](https://pypi.org/project/numpy/2.2.6/)，核对
  CPython 3.12 manylinux x86_64 wheel 的大小和 SHA256。未下载或安装该 wheel。
  [v2.2.6 LICENSE](https://raw.githubusercontent.com/numpy/numpy/v2.2.6/LICENSE.txt)
  是 BSD 3-Clause；wheel 中另有捆绑库的许可，不能用源码顶层许可替代完整审查。
- 模型：保留 [Kyutai 官方无声音克隆仓库](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning)
  的三项历史固定 revision。当前官方 model card 标记 CC BY 4.0，但固定 revision
  的 card/LFS 元数据此次未能重新下载；恢复官方访问后仍须核对再使用。
- Michael：只使用官方预计算 preset。历史出处为 VCTK p360，归属保留
  CSTR VCTK Corpus 0.92、Yamagishi、Veaux、MacDonald 与 Kyutai/ai-coustics 增强说明；
  [官方固定版本声音说明](https://huggingface.co/kyutai/tts-voices/blob/a0de156151266cf8eb27ac8f27312f7aff2ef7b8/README.md)
  说明 VCTK 为 CC BY 4.0。没有下载 Nano 参考 WAV 或其它声音，不使用个人录音。

所有已成功下载请求仅使用官方 HTTPS 主机 `pypi.org`、`files.pythonhosted.org`、
`raw.githubusercontent.com` 和 `download.pytorch.org`。PyTorch 索引另列官方
`download-r2.pytorch.org` 的同一 wheel，其 metadata 请求返回 403；之后从原
`download.pytorch.org` 官方路径取得 metadata，哈希与索引一致。Hugging Face
下载尚未进入重定向，因此没有将未知 CDN 设为受信来源。以后须逐项审核实际
官方重定向主机和文件哈希；Xet ETag 不能代替 LFS SHA256。

## 当前已取得的文件

公开材料缓存位于 ignored 目录
`.runtime/pocket-tts-lab/audit-2026-10-09/`。未将 wheel、模型或大型报告提交 GitHub。
下表记录实际读取的响应体文件；SHA256 为本次本地计算。软件包哈希另与官方
PyPI release JSON 校验，Torch metadata 与官方索引校验，实现/配置与 worker 校验。

| 文件 | bytes | SHA256 |
| --- | ---: | --- |
| `packages/pocket_tts-3.3.0-py3-none-any.whl` | 86452 | `77b2eb5554cb710e92888f84e28816f2361dba075e0ace47108458794db99111` |
| `packages/pocket_tts-3.3.0.tar.gz` | 802539 | `997b3dd39d43c0555cdd9b8efd72ac926dbfcd250fb5f3575aa29c33db5b6621` |
| `pocket-tts-3.3.0.pypi.json` | 29133 | `c1fd9d943c0ac64a93c17eb0f6a7d3760f1fac6ca8ce0617af204f98c3951c8f` |
| `upstream-pyproject.toml` | 2520 | `93fb22a52332da4d6d6edfccb00c3d42a7fdea5c91b18786cbfe1fd6a099ef00` |
| `upstream-LICENSE` | 1023 | `23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3` |
| `upstream-README.md` | 25722 | `c9259eeacd23eb55d6275eec7edbb9c9909437bae0a56cd1f24a74632df82417` |
| `upstream-tts_model.py` | 44883 | `7abdbb4c47615c7b8c04359d13be4cabf3ece7d226205cd5556fb5ff4c06dd22` |
| `upstream-english.yaml` | 1544 | `1b06236b6a4405a4010c731da097745c23d3d5c543e712e31086b6293fd1124a` |
| `numpy-2.2.6.pypi.json` | 110602 | `161349496c9aa02ec136064b242b66678574fd197214be82b1007dcfff95e6b0` |
| `numpy-v2.2.6-LICENSE.txt` | 1543 | `01fb016849aa427edb1bbbbd55f91c26ca6cadb32a5b20e7f000655dd05b0760` |
| `torch-cpu-index.html` | 414325 | `aa158bbf7da8595ebd8519ab8766804175944ddc2226687863bd551abb607fcd` |
| `torch-2.6.0+cpu-cp312-linux.METADATA` | 26693 | `05d5e2f9aec5224a4e8e6d661125da8159b11e4a301cd5c0658ff8c5b7842b80` |
| `torch-v2.6.0-LICENSE` | 3384 | `47a26beb94e3f6b333a3677fc85d546f1fdfd2f0b3686c26d2fb5b10e0134165` |

以上 13 项响应体合计 **1,550,363 bytes**，其中 Pocket wheel 与 sdist 合计
**888,991 bytes**。解包只读取 ZIP 成员，不运行代码；两个 wheel 成员的大小和
SHA256 与表中 `upstream-tts_model.py`、`upstream-english.yaml` 完全相同。

另生成本地 `model/english-public-local.yaml`，1356 bytes，SHA256
`c18861fe338b911216094eee6f841ec36bf4bf6f48d53cd470a7e92131ebc443`。
只替换固定官方配置的模型/tokenizer 本地绝对路径并删除远端 fallback，保留其它
内容和 temperature 0.3。它绑定当前工作区路径，迁移须重新生成和验证。
配置文件已存在不代表其引用的模型已存在，当前 worker 仍应拒绝就绪。

本地审计 manifest 为 `audit-2026-10-09/obtained-materials.manifest.json`；
记录缓存文件、哈希和代理阻塞。环境目录/缓存是当前工作区材料，不是跨环境
持久存储承诺。本文件中的来源、版本和哈希作为共享交接依据。

## 尚未取得的模型及大 wheel

下面模型的大小、SHA256/Git blob 是仓库历史固定值，本次没有新的文件字节或
上游 LFS 元数据可作独立确认。三项合计预期 **226,550,560 bytes**，实际收到 **0 bytes**。

| 资产 | 固定 revision / 官方路径 | 预期校验 | 本次状态 |
| --- | --- | --- | --- |
| `model.safetensors` | [`e7205b6…/languages/english/model.safetensors`](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/e7205b6ee50e654a5ea19f0e9df2b0813b05e921/languages/english/model.safetensors) | 219029196 bytes；SHA256 `916ccd2686e9311cb40054893a3c4284393d658825ffc714a276f3e9b152344f` | CONNECT 403；未创建目标文件 |
| `michael.safetensors` | [`4e1e0a3…/languages/english/embeddings/michael.safetensors`](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/michael.safetensors) | 7276344 bytes；SHA256 `401711f60394aa6085627f7050c1b3f97b31aa7138784811bc6c6ec7d7eaad0c` | CONNECT 403；未创建目标文件 |
| `tokenizer.json` | [`00eac05…/languages/english/tokenizer.json`](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/00eac05ed3d16bdc3f6b5d598874019c34a89214/languages/english/tokenizer.json) | 245020 bytes；Git blob SHA1 `fe3e7fe6185e4a3bc218fa8f5ed993ecb098201c` | CONNECT 403；未创建目标文件 |

Torch CPU wheel 仅核对官方索引中的 SHA256
`59e78aa0c690f70734e42670036d6b541930b8eabbaa18d94e090abf14cc4d91`，
未取得 wheel 大小或文件。NumPy Linux cp312 wheel 的官方 metadata 为
16527618 bytes、SHA256
`fd83c01228a688733f1ded5201c678f0c53ecc1006ffbc404db9f7a899ac6249`，
未取得文件。没有用 Windows wheel 哈希替代 Linux wheel 哈希。

## 新 Linux 环境候选与依赖缺口

历史本机完整 Python freeze 仍不存在；此次不从用户电脑补取，也不将少数主版本
冒称完整 freeze。改为准备一个**新的、须重新验证的官方 binary 依赖候选**。
现有 Python 是 CPython **3.12.14 / Linux x86_64**，现有 pip **26.2.1**；
只读取 `importlib.metadata`，没有导入下载的 Pocket、Torch 或模型。

| 当前环境 | 只读结果 | 与候选的关系 |
| --- | --- | --- |
| Pocket / Torch | 未安装 | 必須在单独隔离环境安装已审核完整闭合清单 |
| NumPy | 2.3.5 | 与固定 2.2.6 不符，不能直接复用当前环境 |
| SymPy | 1.14.0 | Torch 固定要求 1.13.1，与当前环境不符 |
| PyYAML | 6.0.3 | worker 直接使用；显式纳入候选，不依赖碰巧已安装 |
| 其它缺失包 | einops、huggingface-hub、requests、safetensors、sentencepiece、tokenizers、typer、filelock、networkx、Jinja2、fsspec | 尚未安装；完整候选见附录 |

使用**已安装的** pip 执行 `--dry-run --ignore-installed --only-binary=:all:`，
索引限定 `https://pypi.org/simple`。输入为已验证 Pocket 与 Torch METADATA 的
有效基础依赖，固定 NumPy 2.2.6、PyYAML 6.0.3，不启用 audio/quantize extras。
Torch 大 wheel 未参与下载；组合其已验证 METADATA 和官方 wheel digest 作审计。
解析结果共有 **49 包**；检查 CPython 3.12 Linux 下 **71 条适用依赖关系**，
所有名称与版本约束闭合，全部候选为官方 PyPI wheel，Torch 单独来自官方 CPU 索引。

这证明的是发布 metadata 层面的依赖闭合，**不证明运行兼容或软件已审核/安装**。
例如 huggingface-hub 2.2.0、httpx2/httpcore2 2.13.1、tokenizers 0.23.3 等是
当日官方解析出的新候选，不能把版本约束满足当作 Pocket 行为兼容。
安装前需审核每个 wheel、完整第三方许可/来源及 transitive 差异；不采用未知
镜像或 sdist/build fallback，不升级仓库 Node 依赖，不修改当前共享 Python 环境。

本地输出 `new-linux-closure.report.json` 为 747831 bytes、SHA256
`0de19e09fc2838905bed24acc28aae9713fbb90d661c6ab17dc1767f8185d3da`。
它是 pip 生成的报告体积，不是网络传输量；此次没有计量 resolver 逐项 metadata
流量。候选 requirements 为 5088 bytes、SHA256
`3fa62e8ec3ca8ed32eddfd09807d2849d7711bb9275348ad0a266727fe283a06`。
未实际取得其中除 Pocket 外的大部分 wheel；报告和附录不是现成离线 wheelhouse。

## Linux warm 验证前提与下一步

1. 解除当前云环境对**原始官方 Hugging Face 入口**的网络阻塞，取得固定 revision
   的许可/card/LFS 元数据、三项资产并验证大小与官方 LFS/Git 哈希，另记录 tokenizer
   SHA256。未知来源或权限失败时停止；不从用户电脑取材料，不换镜像。
2. 审核下方新的 49 包候选与许可；获准安装后，在确定的 Linux/CPython 3.12 镜像
   或隔离 venv 中取得全部对应 binary wheel，逐项验证官方 SHA256，固定基础镜像、
   Python/包管理器版本、CPU ABI/glibc、wheel 来源与 notices。完整 wheelhouse 准备好后
   才允许严格 hashes 的离线安装；不把当前系统环境或候选锁称为旧本机 freeze。
3. 重新生成本地 YAML 并通过现有模型、实现、配置和 runtime 版本校验；保持
   `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`、固定 Michael/种子/温度/CPU 线程，
   配合 OS 出站限制。先单进程/单 warm worker，独立测冷加载、真实预热、峰值内存、
   连续长句生成、取消/迟到结果和进程回收。就绪必须等待校验、加载和真实预热完成。
4. 当前没有 Railway CPU/内存/区域、固定域名或持久化输入，不创建资源或部署。
   warm 通过后再按独立真实通话授权验证手机耳听、数字/否定、自然度、积压和延迟；
   离线依赖解析或历史 Windows 数据均不代表 Linux warm 或真实电话已验收。

## 完整候选版本与 wheel 哈希

下方是此次新 Linux x86_64 / CPython 3.12 的候选，不是执行命令或已获安装授权。
除 Torch 的显式官方 CPU URL 外，仅可配合官方 PyPI 的对应 wheel 使用。
不启用 extras；全部 49 项必须一起审核，不能只截取三个引擎版本。

```text
# NEW Linux x86_64 CPython 3.12 candidate. Not historical freeze; not installed or warm-validated.
# All versions/hashes from official release metadata. No extras; PyYAML covers the repository worker.
# Torch source is the official CPU index URL, never an unqualified PyPI CUDA fallback.
annotated-doc==0.0.5 --hash=sha256:117bac03a25ede5df5440e855b32d556049ca169ead221505badf432fed4b101
annotated-types==0.8.0 --hash=sha256:f072f4d804ea359e4eaf198b1af7a8b0943881a87f31bb764f8bf219bb9419e0
anyio==4.15.1 --hash=sha256:6152fdbbf9a77fdec97731721bebf7c4c44f7c29b424b0065826173efc7ed101
certifi==2026.7.22 --hash=sha256:62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775
charset-normalizer==3.5.2 --hash=sha256:3d31298449090ab8d47b7b1b2a555ff73cac7ed438a08b7ac160980c7ebed649
click==8.5.0 --hash=sha256:255bc9599cf7748b4b1a446ccc735421bd08a2ae529a8b88597d3de5664ee360
einops==0.8.2 --hash=sha256:54058201ac7087911181bfec4af6091bb59380360f069276601256a76af08193
fastapi==0.143.0 --hash=sha256:3e9395fd35276425b61b516a31fdd7c77fe2af83e41b4da22e30696fb1304c5d
filelock==4.0.12 --hash=sha256:5f17ee83ecee8a6f3e389c75822fb70a1c2f0506b99438a6dffa1d56793588c8
fsspec==2026.9.0 --hash=sha256:8dd6e646e99ea382bd85f97a45e6b526a442d79423a7dc673f1e2756d05fcb5f
h11==0.16.0 --hash=sha256:63cf8bbe7522de3bf65932fda1d9c2772064ffb3dae62d55932da54b31cb6c86
hf-xet==1.7.0 --hash=sha256:2814a6e999d13464c4d679b788cc5d784eb5a4edfc638a31f10e9a11ab531ef8
httpcore2==2.13.1 --hash=sha256:e1e05d4f25f7d7d496bfb96748f6f4b67657b03da069b3a68c36069f3db73d0a
httpx2==2.13.1 --hash=sha256:6dff50fabc270ee5fd25d845d0b078ed20564579744d6d962850975996d2f9a4
huggingface-hub==2.2.0 --hash=sha256:1667f145dc56dc210d60966069397df9ecfca9607a5d43db88b308c89dae56b3
idna==3.20 --hash=sha256:ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c
jinja2==3.1.6 --hash=sha256:85ece4451f492d0c13c5dd7c13a64681a86afae63a5f347908daf103ce6d2f67
markdown-it-py==4.2.0 --hash=sha256:9f7ebbcd14fe59494226453aed97c1070d83f8d24b6fc3a3bcf9a38092641c4a
markupsafe==3.0.4 --hash=sha256:8e124f974786f831d6043728e38296969d3579db8896fe004682f5758e613581
mdurl==0.1.2 --hash=sha256:84008a41e51615a49fc9966191ff91509e3c40b939176e643fd50a5c2196b8f8
mpmath==1.3.0 --hash=sha256:a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c
networkx==3.7 --hash=sha256:e3fd2c13a7814cee3746340d8d7f8598a67f16a58bf47fb7f8793fab6efca1b0
numpy==2.2.6 --hash=sha256:fd83c01228a688733f1ded5201c678f0c53ecc1006ffbc404db9f7a899ac6249
opentelemetry-api==1.45.1 --hash=sha256:b31553efa588ae44bc306f863c785c5333a9ecc091248c6ee68b4b6c87fdedfb
packaging==26.3 --hash=sha256:d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c
pocket-tts==3.3.0 --hash=sha256:77b2eb5554cb710e92888f84e28816f2361dba075e0ace47108458794db99111
pydantic==2.14.0 --hash=sha256:15fab1bea6f1dc5003b54fc2ecab230c1fd1dbade2acd4addc52d81e32416d4b
pydantic-core==2.50.0 --hash=sha256:f187030fc3d62c668feb0f09e92852e0eb414d7fcefc4748f2e67d245aade37e
pygments==2.21.0 --hash=sha256:2363c69b61c4a97c838da3b130dcd6468f4848992b21a82f2a63ec34377137d9
python-multipart==0.0.32 --hash=sha256:ff6d3f776f16878c894e52e107296ffc890e913c611b1a4ec6c44e2821fe2e23
pyyaml==6.0.3 --hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc
requests==2.34.2 --hash=sha256:2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0
rich==15.0.0 --hash=sha256:33bd4ef74232fb73fe9279a257718407f169c09b78a87ad3d296f548e27de0bb
safetensors==0.8.0 --hash=sha256:fd6f3f93c9a0a7cc2788ee63fb763353d4bd2e89b0751bc78fcf7dda00bea774
scipy==1.18.1 --hash=sha256:f55fa87b6c612ecd6b058f167c53231b1d14e412efe361d3d6e38b3631c73218
sentencepiece==0.2.2 --hash=sha256:c8a168b040bc61681293f79a949b5d911c8e25086f4260285b8d97ab5f1195da
setuptools==84.0.0 --hash=sha256:51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670
shellingham==1.5.4 --hash=sha256:7ecfff8f2fd72616f7481040475a65b2bf8af90a56c89140852d1120324e8686
starlette==1.7.0 --hash=sha256:67f8e99895493dd2911a03f11314af6ceebeae4e704bb9f43dfc6a9db151c93e
sympy==1.13.1 --hash=sha256:db36cdc64bf61b9b24578b6f7bab1ecdd2452cf008f34faa33776680c26d66f8
tokenizers==0.23.3 --hash=sha256:376851d22bcf9d650a5c3090bb83e6cf9e895fbf0595369fa4cd43c1f69b5f87
torch @ https://download.pytorch.org/whl/cpu/torch-2.6.0%2Bcpu-cp312-cp312-linux_x86_64.whl --hash=sha256:59e78aa0c690f70734e42670036d6b541930b8eabbaa18d94e090abf14cc4d91
tqdm==4.70.1 --hash=sha256:c293e525e6fef9c20e8728fd4612df02a0aa31bb5fe91ecd93e123b1b7bffa73
truststore==0.10.4 --hash=sha256:adaeaecf1cbb5f4de3b1959b42d41f6fab57b2b1666adb59e89cb0b53361d981
typer==0.27.3 --hash=sha256:e50022f28b82a86313e54501317a1db64bf8f8d036ff8cfe5ca7e47675454aff
typing-extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8
typing-inspection==0.4.4 --hash=sha256:65b8397ba37ccbce054456aaccddfc91e6e3083c92824df348d96ca832f3f147
urllib3==2.8.0 --hash=sha256:0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3
uvicorn==0.54.0 --hash=sha256:505bdb0f318731d45f1f712071fc781a8981f6847a31c902c9f5e652d4f67faf
```
