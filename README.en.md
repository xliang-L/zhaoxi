# Zhaoxi · 朝夕

[简体中文](README.md)

Zhaoxi is a self-hosted WeChat personal agent built on OpenClaw. Chat, save information and arrange reminders in WeChat. Use the web console to configure the agent.

## Features

- **WeChat conversations.** Scan a QR code to connect. Supports text, images and files. One administrator can connect several independent bots, each with its own persona, memory and plans.
- **Editable personas.** Change the name, identity, personality, speaking style, background and SOUL text in the web console. Preview the result before saving.
- **Memory and proactive messages.** With consent, retain explicitly stated cities, interests and reply preferences. Choose contact opportunities using conversation context, character continuity and observed activity hours, subject to quiet hours, frequency limits and cooldowns.
- **Plans and source documents.** Forward a notice, screenshot or file to extract requirements, deadlines and preparation steps. Confirm in natural language before saving or scheduling. Keep the original source, handle changes and mark work complete.
- **Story packs.** Import, export, enable or remove JSON packs. Retrieve relevant opening, continuation or full-story material when invited. Fiction is kept separate from user facts.
- **Model configuration and budgets.** Set the endpoint, API key, model, context length, output limit and shared monthly token budget in the browser.

There is one administrator, with no public registration, membership billing or Android client. WeChat connectivity uses Tencent's OpenClaw channel. It does not read unrelated conversations or automatically collect group messages.

## Run locally

Requires **Python 3.12+, Node.js 24.22.1, Git and pnpm 12.15.0**. Supports macOS and Linux. The first installation downloads and builds OpenClaw; allow several GB of disk space and a few minutes for the build.

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

Open <http://127.0.0.1:8787>:

1. Set the administrator name and password.
2. Enter the API endpoint, model ID and key under **模型与额度** (Model and budget).
3. Generate a QR code under **微信连接** (WeChat connection), then scan and confirm on your phone.
4. Send a message in WeChat and confirm the reply arrives. Enable memory or daily greetings separately under **计划与记忆** (Plans and memory).

The interface is currently in Chinese. Endpoint URLs usually end in `/v1`; do not append `/responses` or `/chat/completions`. OpenAI-compatible Responses and Chat Completions are supported. Proactive generation also requires JSON Schema output support. Web search uses the Responses `web_search` tool and requires provider support. Leave the key blank for a local service that does not require one.

On macOS, screenshots and PDFs use Vision and PDFKit through the Swift command-line tools. On Linux, install Tesseract with the Chinese and English language data, plus Poppler:

```bash
sudo apt-get install tesseract-ocr tesseract-ocr-chi-sim poppler-utils
```

Linux PDF extraction currently reads text from the first 20 pages. Convert scanned PDFs to images for OCR. Office documents provide body text and raw cell values; formulas are not recalculated.

## Docker deployment

```bash
docker compose up -d --build
```

Open <http://127.0.0.1:8787>. The image build prepares the runtime using the same installer as the local setup. Private data is stored in the `zhaoxi-data` volume and survives image rebuilds.

For access through a domain, place an HTTPS reverse proxy in front of the service and allow the hostname:

```bash
ZHAOXI_ALLOWED_HOSTS=localhost,127.0.0.1,fish.example.com docker compose up -d
```

Complete administrator setup on a trusted network before exposing the service. Do not publish the internal OpenClaw Gateway ports.

## Configuration and data

Saved web settings take precedence over environment variables. Copy [.env.example](.env.example) to `.env` for deployment parameters. Keys are stored in private server-side files. HTTP responses return only whether a key is configured. Budgets can be changed without resetting usage or reservations. Applying model changes reconnects this deployment's bots. When calls or reservations remain, wait or pause the connection in the console before changing the model.

```text
src/zhaoxi/          Web service, single-admin authentication and runtime management
extensions/         WeChat, plans, memory, companion, search and quota plugins
resources/personas/ Default personas
runtime/            Pinned OpenClaw revision, source patches and upstream license
scripts/            Runtime installation and extension builds
tests/              Automated tests
docs/               Story pack format
data/               Generated private state, excluded from Git
```

`data/settings.json` holds deployment settings. `data/accounts/` holds each bot's credentials, workspace and memory. Installed packs live in `data/story-packs/`; the isolated OpenClaw installation lives in `data/runtime/`. Stop this deployment before backing up its complete data directory. Never publish private data, `.env` or logs. This edition uses a new single-admin data format and does not automatically import the previous membership service's data.

The source release includes no developer memories, conversations or user profiles. Every new deployment and bot starts with empty profile files, memory files and structured facts. Automatic recording requires the user's own consent. Each user builds their own history without inheriting another person's city, preferences, plans or character continuity. Personas and fictional story material can be shared; personal memories stay in private, separate data directories. Restarting, updating or reconnecting an existing bot preserves its own saved records. Test fixtures are never imported into live memory.

Persona changes apply from the next turn; previous conversations remain. Disabling or removing a story pack stops subsequent retrieval immediately. Newly imported packs are disabled by default. See the [story pack format](docs/story-packs.md).

Monthly budgets use Beijing calendar months and measured provider usage. They are application limits, not provider account balances. Scheduled reminders and daily greetings have separate authorization. The current proactive contact window is 09:00–24:00 Beijing time, further constrained by quiet hours, frequency limits and cooldowns. The service must stay running; sleep, network failures or expired WeChat authorization can affect delivery. Weather and automatic news notifications are not enabled.

## Development

```bash
pip install -e '.[test]'
npm ci --ignore-scripts
npm run build
pytest -q
npm test
```

Node tests use the public SDK from `data/runtime/openclaw`. Set `ZHAOXI_TEST_OPENCLAW_ROOT` to test a separate runtime build. The installer uses the revision in `runtime/upstream.json` and applies the included memory and persona patches. It does not use the global OpenClaw configuration. Stop this deployment and back up data before upgrades; do not rebuild a running installation.

## License

[MIT](LICENSE). Built on [OpenClaw](https://github.com/openclaw/openclaw), with a WeChat plugin based on [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin). See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for retained licenses and local modifications.
