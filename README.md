# Website Building Workflow

Build a full modern website with one command.

## Quick Start

1. Clone the repo
2. Install dependencies
3. Run one command

```bash
npm install
npm run site:build
```

## What this includes

- Claude Code workflow scaffold
- UI/UX prompt templates
- 21st.dev-style component workflow guidance
- Framer Motion integration
- Modern React + Vite structure

## Available commands

- `npm run dev` - Start local dev server
- `npm run build` - Production build
- `npm run site:build` - One-command guided website generation workflow

## Browser automation

`.claude/hooks/session-start.sh` runs on every Claude Code session start. It
installs `@playwright/cli` globally if it is missing and writes
`.playwright/cli.config.json`, so `playwright-cli` is ready without any manual
setup:

```bash
npm run dev                      # in one shell
playwright-cli open http://localhost:5173
playwright-cli snapshot
playwright-cli screenshot
playwright-cli close
```

In Claude Code on the web the hook pins the container's pre-installed Chromium
(`/opt/pw-browsers/chromium`) and disables the Chromium sandbox, because browser
downloads are blocked by the network policy and the container runs as root. On a
local machine it writes an empty config and lets Playwright resolve its own
browsers — run `playwright-cli install-browser` once if you have none.

