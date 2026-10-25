# Code Review Helper

A macOS desktop app that walks you through a pull request the way its author would on a screen share. Claude finds where the change really starts, puts the changes in a logical order, and explains each step. The code stays fixed in its own pane, and you can ask questions beside it.

Built for reviewing large, often agent-written PRs, where reading the diff file by file doesn't tell you the story.

## What it does

- **Opens a PR** from a GitHub pull request (number or URL) or a local branch, in a separate git worktree. Your own checkout is never touched.
- **Generates a walkthrough** with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). The agent explores the repo with read-only tools (Read, Grep, Glob) and returns ordered steps:
  - The walkthrough starts at the core idea of the change, not the entry point. The exception is when where the entry point sits took real thought.
  - Each step follows from the one before. Side trips, such as a type or helper the previous step relies on, are labelled `1a`, `1b`, … under their main step.
  - Small changes like lockfiles, renames and formatting go into a final **Everything else** step. Any change the agent misses also lands there, so nothing is left out.
- **Three-column screen:**
  - **Left:** every step, always visible.
  - **Center:** the code for the current step, in **Diff** or **Plain** mode. It shows the changed lines plus a few lines around them, and unchanged code from elsewhere in the repo when it helps, marked as context.
  - **Right:** the explanation for the step, and a chat for questions about it. Answers can refer back to earlier steps and earlier questions.
- **Tracks usage.** Every generation and chat question is logged with its cost, turns, duration and tokens. The **Usage** screen shows totals for today, this month, and each PR. Open it from the Open screen, or mid-review from the walkthrough's top bar, which also shows what the current review has cost so far.

## Requirements

- macOS (Apple Silicon)
- Node.js (developed on v24)
- git
- [GitHub CLI](https://cli.github.com/) (`gh`), logged in, if you want to open GitHub PRs: `brew install gh && gh auth login`
- An Anthropic API key, which you enter in the app's Setup screen. The key is stored encrypted in the macOS Keychain.

### Getting an API key

Create a key in the [Claude Console](https://platform.claude.com). Claude **Max** and **Team** plans include monthly API credits you can link to a Console organization from claude.ai under **Settings › Billing › API credits**. See [Monthly API credits for Max and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans).

## Running it

```sh
npm install
npm run dev
```

1. **Setup:** paste your API key. The defaults are model `claude-opus-5-5`, up to 60 agent turns, and a $3 cap per run, and you can change all three.
2. **Open:** pick a local clone. Then either enter a branch name, with an optional base (the default is where the branch split from the main branch), or enter a GitHub PR number or URL.
3. **Generate:** this takes a few minutes, and you can cancel it. PRs over 1,300 changed lines get a warning but still run.

In dev mode, changes to the screens reload on their own. Changes under `src/main/` (agent instructions, git, walkthrough logic) need a restart of `npm run dev`.

**Try the UI without spending API credit.** This opens a sample walkthrough built from this repo's own history:

```sh
npm run dev -- -- --fixture tests/fixtures/walkthrough.json
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app with hot reload for the screens |
| `npm test` | Run the test suite (vitest) |
| `npm run typecheck` | Type-check the main process and the screens |
| `npm run lint` | ESLint |
| `npm run build:unpack` | Build an unsigned `.app` into `dist/` |
| `npm run build:mac` | Build the `.app` and a `.dmg` |

Local builds are unsigned. The first launch may ask for Keychain access to "Code Review Helper Safe Storage". Choose **Always Allow**.

## Where data lives

Everything is stored under the app's data folder: `~/Library/Application Support/Code Review Helper/` for the packaged app, or `…/code-review-helper/` in dev.

- `settings.json`: settings, with the API key encrypted
- `runs.log`: one JSON line per generation or chat question, with cost, turns, duration and tokens
- `worktrees/`: checkouts of the PRs you've opened

## How it fits together

```
src/
  main/            Electron main process: everything with side effects
    git/           diff reading, worktrees, GitHub via gh
    agent/         Agent SDK options, walkthrough generation, per-step chat, prompts
    walkthrough/   validates agent output, fixes line ranges, coverage fill, detour nesting
    settings.ts    settings store and run log
    ipc.ts         handlers behind the preload API
  preload/         exposes window.api to the screens
  renderer/src/    React UI: Setup, Open, Generating, Walkthrough, Usage
  shared/          types and logic shared by both sides (walkthrough schema, step labels, usage totals)
tests/             vitest: main/, renderer/ (jsdom), shared/
```

The agent runs with only read-only tools and doesn't load your Claude Code settings, skills or hooks. Each run is capped by turns and budget. The walkthrough comes back as JSON checked against a schema, and the main process cleans it up before anything is shown.
