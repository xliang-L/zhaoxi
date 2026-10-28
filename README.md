# 朝夕 · Zhaoxi

[English](README.en.md)

朝夕是一个基于 OpenClaw、可以自己部署的微信个人助理。平时在微信里聊天、记事、安排提醒；需要调整时，打开网页管理台。

## 能做什么

- **微信聊天**：扫码绑定，支持文字、图片与文件。同一个管理员可以连接多个独立机器人，各自保留人设、记忆和计划。
- **调整人设**：在网页编辑名字、身份、性格、说话方式、生活背景和 SOUL 原文，预览后保存。
- **记忆与主动关心**：经本人授权，记录明确说出的城市、兴趣和回复偏好；结合聊天上下文、角色近况和活跃习惯，在允许时段择机联系。可以调整次数、间隔、安静时段，也可以暂停。
- **计划与资料**：转发通知、截图或文件，整理要求、截止时间、准备步骤和提醒，保留原件。先自然语言确认，再保存；后续可以更正、改期或标记完成。
- **故事包**：导入、导出、启用或移除 JSON 素材包。故事按需检索，支持开头、续讲和整篇，不把虚构内容记成用户事实。
- **模型与额度**：网页配置接口地址、API Key、模型、上下文和输出上限，以及所有机器人共享的月 Token 额度。

只有一个管理员，没有公开注册、会员订阅或安卓客户端。聊天通过腾讯的 OpenClaw 微信通道接入，不能读取其他微信对话或自动获取群消息。

## 本机运行

推荐使用 **Python 3.12+、Node.js 24.22.1、Git 和 pnpm 12.15.0**。支持 macOS 和 Linux。首次安装需要下载并构建 OpenClaw，预留几 GB 磁盘和几分钟构建时间。

```bash
git clone https://github.com/xliang-L/zhaoxi.git
cd zhaoxi
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
npm install --global pnpm@12.15.0
python scripts/install_runtime.py
zhaoxi
```

打开 <http://127.0.0.1:8787>：

1. 设置管理员名和密码。
2. 在「模型与额度」填写 API 地址、模型名和密钥，保存。
3. 到「微信连接」生成二维码，用自己的微信扫码并在手机确认。
4. 在微信里发一句话，确认收到回复。需要自动记忆或日常问候时，到「计划与记忆」单独开启。

接口地址一般填写到 `/v1`，不要包含 `/responses` 或 `/chat/completions`。支持 OpenAI 兼容的 Responses 和 Chat Completions；主动消息生成还需要服务支持 JSON Schema 格式输出。网页搜索使用 Responses 的 `web_search`，服务商不支持时不能使用搜索。无需密钥的本地服务可将 API Key 留空。

macOS 使用系统 Vision 和 PDFKit 读取截图与 PDF，需要可用的 Swift 命令行工具。Linux 可安装 Tesseract（含 `chi_sim`、`eng`）和 Poppler：

```bash
sudo apt-get install tesseract-ocr tesseract-ocr-chi-sim poppler-utils
```

Linux 的 PDF 当前提取前20页文本；扫描 PDF 可以转成图片识别。Office 文件读取正文和单元格原始值，不重新计算公式。

## Docker 部署

```bash
docker compose up -d --build
```

同样访问 <http://127.0.0.1:8787>。首次构建会准备运行包；数据保存在 `zhaoxi-data` 卷，重新构建镜像不会清空设置和记忆。镜像构建与本机运行使用同一份运行包安装脚本。

需要域名访问时，在前面配置 HTTPS 反向代理，并把域名加入 `ZHAOXI_ALLOWED_HOSTS`，例如：

```bash
ZHAOXI_ALLOWED_HOSTS=localhost,127.0.0.1,fish.example.com docker compose up -d
```

先在受控网络完成管理员初始化，再开放访问。不要将 OpenClaw 网关端口直接映射到公网。

## 配置和数据

网页保存的模型配置优先于环境变量。部署参数可参考 [.env.example](.env.example)，复制成 `.env` 后调整。密钥仅保存在服务器的私有数据文件中，接口只返回是否已配置，不回显密钥。月额度可直接调整，不清空已发生用量或预留。更换模型配置会重连本应用的机器人；仍有调用或待核对用量时，可稍后保存，或先在网页暂停连接再修改。

```text
src/zhaoxi/          网页服务、单管理员认证、配置与运行管理
extensions/         微信、计划与记忆、陪聊、搜索与额度插件
resources/personas/ 默认人设
runtime/            OpenClaw 固定版本信息、源码补丁和上游许可
scripts/            安装运行包、构建插件
tests/             自动化测试
docs/              故事包格式
data/              本机私有数据，自动创建，不进 Git
```

`data/settings.json` 保存部署配置；`data/accounts/` 保存各机器人的凭证、工作区和记忆；`data/story-packs/` 保存安装的故事包；`data/runtime/` 是独立运行包。备份私有数据前先停止这份部署，完整保留数据目录。不要把它、`.env` 或日志上传到公开仓库。此版本使用新的单管理员数据格式，不自动导入旧会员服务的数据。

开源版不附带开发者的个人记忆、聊天记录或用户画像。每次新部署、每个新机器人的用户资料和记忆文件都从空白开始，结构化事实也为空；开启自动记忆需要本人单独授权。之后只积累这个使用者自己的记录，不继承其他人的城市、偏好、计划或角色近况。人设和虚构故事素材可以复用，个人记忆始终保存在各自的私有数据目录。重启、更新和重新绑定原机器人会保留本人已有记录。代码中的测试样例不会导入实际记忆。

人设修改从下一轮对话开始使用；原来的聊天仍在。故事包的关闭或移除立即停止后续检索，新导入的包默认关闭。格式及示例见 [故事包说明](docs/story-packs.md)。

月额度按北京时间统计，使用模型实际返回的用量；它是本应用的限制，不是模型服务商余额。已指定时间的提醒与日常问候分别授权。日常联系的现有范围为北京时间09:00–24:00，并继续遵守安静时段、次数与间隔设置。服务需要持续运行，电脑休眠、网络故障、微信授权失效都可能影响提醒送达。天气与自动资讯推送暂未开放。

## 开发

```bash
pip install -e '.[test]'
npm ci --ignore-scripts
npm run build
pytest -q
npm test
```

Node 测试使用 `data/runtime/openclaw` 的公开 SDK，也可通过 `ZHAOXI_TEST_OPENCLAW_ROOT` 指定单独构建的运行包。运行包固定到 `runtime/upstream.json` 中的上游版本，安装时应用记忆与人设相关补丁，不使用全局 OpenClaw 配置。升级前应停止这份部署并备份数据；不要在运行中的安装目录重建。

## 许可

[MIT](LICENSE)。底层使用 [OpenClaw](https://github.com/openclaw/openclaw)，微信插件基于 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)。保留的上游许可和修改范围见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
