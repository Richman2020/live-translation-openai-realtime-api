# ai-phone-test 阿里电话候选发布准备（未执行）

仅用户核对新的集成SHA后，再安排CI/发布及本人试打。本轮没有Git推送/PR/CI、Railway暂存/发布、变量写入、凭据/网络改动、拨号或其他项目操作。

## 精确目标与只读回退点

- 项目 ai-phone-portal-trial：`145aa27a-3a84-4e4d-91f9-b97f33bf6d42`。
- staging：`c5db5ddb-26b6-48ce-b920-dc1ebbe30fa8`。
- ai-phone-test：`407bede7-11b6-4260-b055-a8045dc71588`。
- 2026-10-15 10:23北京时间只读describe-service：live、无staged，来源完整 `d7a395e7ddc7d8a253500ab6d12310c9f8a9cf6a`，部署 `e90e8959-e8c8-4f9a-a8e5-6a069a25ef0f` SUCCESS。
- 公网测试入口：`https://ai-phone-test-staging.up.railway.app/controlled`。本轮未请求线上页面或模型。

这是真实平台回读快照，不是未来发布前保证。届时若线上、暂存或费用已有未知变化，先核对，不覆盖。Hobby及原两服务费用提醒约定保持，不恢复已停止portal-test、不新建资源或修改账号消费限制。

候选完整祖先为 d7→8f→320→e106→108f→eb10→本次集成。本次必要改动比较范围是eb10到新SHA；与线上d7相比还包含此前已离线核验的上下文字幕修复及默认关闭的A/试听/Plan B代码。未来PR必须说明实际base/head及完整发布差异，不能把窄范围PR当作线上全部差异，或声称d7到本候选的OpenAI字幕代码完全未改。

## 部署变量：仅核对名称，未读密钥值

此次使用只返回变量名称的describe-service；未调用可能返回明文值的list-variables，不读环境key值。Codex试听配置不等于Railway配置。

| 名称 | 此指定服务名称清单 | 拟发布Plan B要求 |
| --- | --- | --- |
| CLOUD_PHONE_TRANSLATION_PROVIDER | 未列出 | 显式aliyun-plan-b；缺省仍OpenAI |
| ALIYUN_PLAN_B_REGION | 未列出 | beijing |
| ALIYUN_BEIJING_API_KEY | 未列出，无该服务配置证据 | 北京已有授权key，由用户安全配置，不在聊天发送 |
| ALIYUN_PLAN_B_PROXY_URL | 未列出 | 可选，沿运行平台已有获准代理；不要求直连绕过 |
| ALIYUN_PLAN_B_ASR_MODEL | 未列出 | 可省略，代码固定fun-asr-realtime |
| ALIYUN_PLAN_B_MT_MODEL | 未列出 | 可省略，代码固定qwen-mt-flash |
| ALIYUN_PLAN_B_TTS_MODEL | 未列出 | 可省略，代码固定cosyvoice-v3-flash |
| ALIYUN_PLAN_B_VOICE | 未列出 | 可省略，代码固定loongandy_v3 |
| ALIYUN_PLAN_B_SAMPLE_RATE | 未列出 | 可省略，代码固定24000 |
| AI_PHONE_RUNTIME_MODE / CLOUD_SERVICE_MODE | 已列出 | 保持既有cloud / phone；本轮仅名字证据不宣称值已核 |
| CLOUD_PUBLIC_ORIGIN / PUBLIC_BASE_URL | 已列出 | 保持既有上述HTTPS域；未读值 |
| CLOUD_PUBLIC_CALLBACK_CONFIRMED | 已列出 | 保持既有配置，不当真实回调通过证据 |
| CLOUD_OUTGOING_PAIRED_CAPTIONS_ENABLED | 已列出 | Plan B同源字幕由选择路径提供，不创建额外OpenAI字幕任务；不自动改该变量 |

API目的地固定 `dashscope.aliyuncs.com`：WSS `/api-ws/v1/inference`，MT HTTPS `/compatible-mode/v1/chat/completions`。只用北京key，不借新加坡key，不更换模型/voice、不扩大权限。实际Railway出网/账户三型号权限未验收，不能拿Codex已放行为通过。Twilio/Google/主叫/目标/签名和控制权配置保持，不重新写回调或凭据。

## 后续单次发布顺序

1. 用户/dot核对RECEIPT中的最终完整集成SHA（来源da3b，实际父基线eb10），再另行授权推送独立分支、PR/必要CI与指定staging发布。先检查该分支/PR不会意外自动部署，不合并main、不强推、不包含未提交内容。
2. 复核指定AI服务当前运行/暂存/回退点和费用；用户安全配置上述最小三项，确认地域/域名与权限，不展示key值。本轮缺配置不能声称已具备可通话发布条件。
3. 仅指定服务固定集成SHA，一次发布；未知其他变更停止核对。必要CI失败不继续，工具执行确认若取消不绕过。
4. 记录实际部署ID、完整运行SHA、启动日志和模型/voice的固定非秘密配置。`/api/health`、`/controlled`及登录/耳麦页面做无模型无拨号检查；没有恢复手动控制倒计时。部署SUCCESS/HTTP200不是电话通过。
5. 用户另行明确一次电话目标（脱敏）、次数/时长和电话/阿里费用授权，由用户亲自发起。重点英文ASR→中文/原音直通、中文译音不读JSON/历史、真实重复/更正/数字否定、长于原3:04连续播放、正常挂断清理。按同通时间和匿名pipelineId关联各阶段；实际播放开始仍未知，用户实听与服务器首PCM/排空分开记录。异常先停止，不自动重拨。

## 回退方案（准备，不执行）

第一层是在本次候选代码上将供应商选择恢复openai（或去掉该选择），经另行批准重启/发布，使下一通走原OpenAI；当前通话不切换。保留原OpenAI key及原配置，不删除任何方案。

若新版本服务异常，先报告后按获准操作恢复部署 `e90e8959-e8c8-4f9a-a8e5-6a069a25ef0f`、完整d7，并恢复其已核配置；仅回滚代码而仍保留aliyun选择不能算完整回退。任何变量回退/重启也需要当轮授权，不能沿用旧发布批准。

代码审查/重试在独立目录选择父候选eb10或原OpenAI备份，不reset现有开发/原资料。附件失败b072不作生产fallback，已消费试听审批/锁不迁移重置复用。
