# 单中文Tina一次试听候选

用户本轮目标改为先取得完整英文译音，暂不要求固定男声；本候选基于精确a66fd3f5881f0258ee704988592ea5640a3d0559，原Aiden候选、失败证据及已消费锁保留。

仅single-local audition固定选择Tina并使用新的Tina授权scope，parent绑定a66。可信client选项显式传入Tina，默认client、dual和duplex仍保持Aiden。请求session.voice=Tina，session.enable_voice_clone=false；必须确认session.audio.output.voice=Tina，若顶层voice有返回也须一致。没有切换音色回退、模型或协议字段层级。

固定北京qwen3.8-livetranslate-flash-realtime、英文、16k输入PCM/24k输出PCM。同会话配置匹配而仅缺复刻回显时按用户已批准策略警告后就绪，保留null/未知；明确true或存在但类型异常仍停止，其他已有检查保留。

使用原21.097375秒中文录音，WAV SHA256为58419fda20d4b0062e5ede15b289fdd052c3a5b4c789b6e195a22f9fa4f8af1f；参考译文不读取或上传。本轮新授权一次、最多人民币5元，1会话、0重试、0重连、24秒输入、6响应、36秒保存输出、90秒总时限。规划预留3.96760359元，仅为本地估算，非平台账单硬封顶。

候选先以现有离线依赖和网络阻断保护验证，再由独立一次执行包装器启动。真实结果保存在/workspace/ai-phone-livetranslate-tina-once-20261015/result及相邻回执；未执行或未返回的项目不作成功声明。英文WAV优先交付，失败保留已有输出；捕获首音不等于播放开始，短试听不代表长通话稳定性验收。

不安装、不拨号、不接Twilio、不推送、不部署，不修改密钥或网络。完整类型检查仍为既有集成验收缺项，本次不重复查找编译器。

本候选离线验证：相关7个测试文件168项通过、0失败，网络阻断保护开启；git diff --check通过。未补装编译器，完整类型检查仍留作集成缺项。
