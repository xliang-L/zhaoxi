# 朝夕 for OpenClaw

根据用户具体请求提供课表与作业提醒、考研计划跟进、健身计划执行。普通聊天不主动推荐或开启这些功能；加载插件、保存计划均不创建通知。只有用户要求提醒且时间安排明确时，Agent 才通过 OpenClaw 原生 `automations` 设置通知。

本插件针对本仓库 OpenClaw **2026.10.7**，使用公开 Plugin SDK。`zhaoxi_plan` 保存已确认的计划和按日期的完成、部分完成或跳过情况；原生任务负责定时和投递，插件没有独立调度循环。私有数据需要宿主提供已验证的 memory audience，缺少作用域时明确拒绝操作。

配置时启用 `plugins.entries.zhaoxi-planner.enabled`，并在该 Agent 的工具 allowlist 中加入 `zhaoxi_plan`；需要提醒时加入 `automations`，技能读取可使用 `skills_search` 和 `skills_read`。不要顺带开放 shell、任意文件或设备控制。

随附 `openclaw.example.json` 是三类提醒技能的精简配置，仅开放 `automations`、`skills_read`；底层模型查询保留在后台运维诊断中，不向角色开放。上述技能以各自原生任务的 `payload.message` 保存执行计划和按日期的反馈，普通聊天通过任务所有者的 `get`、`update` 更新所有受影响的任务。它们不依赖 `zhaoxi_plan`，也不会自动同步该工具的独立计划记录。需要保存尚未安排提醒的独立计划时，再按上述要求开放该工具。

开发验证使用独立 `OPENCLAW_STATE_DIR`、回环 Gateway 端口和 `delivery.mode: "none"`，不向微信发送测试消息。原生任务保存成功不代表手机已经收到；正式触达仍须经过渠道实测。

作业讲解、专业课题库与期末复习按用户决定暂不接入：没有注册对应工具或技能，也不随插件构建、加载。相关草稿保留在本机被 Git 忽略的 `.local/drafts/study/`，不属于当前启用的产品能力。

架构基于 [OpenClaw](https://github.com/openclaw/openclaw)，沿用仓库 MIT 许可。
