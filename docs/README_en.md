<h1 align="center">🏢 AgentRD</h1>

<p align="center">
  <strong>One person, an entire R&D department</strong>
</p>

<p align="center">
  A fully automated delivery pipeline for the One-Person Company (OPC)<br>
  You say what you want; AI writes, reviews, verifies and delivers · Three review gates · Thirteen mechanical guards
</p>

<p align="center">
  <a href="../LICENSE"><img src="https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/PowerShell-5.1%2B-5391FE.svg?style=for-the-badge&logo=powershell&logoColor=white" alt="PowerShell 5.1+">
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6.svg?style=for-the-badge&logo=windows&logoColor=white" alt="Windows">
  <a href="https://github.com/bluesxu/agentrd/stargazers"><img src="https://img.shields.io/github/stars/bluesxu/agentrd?style=for-the-badge" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="../README.md">简体中文</a> ·
  <b>English</b> ·
  <a href="README_ja.md">日本語</a> ·
  <a href="README_ko.md">한국어</a>
</p>

<p align="center">
  <a href="#quickstart">🚀 Quick Start</a> ·
  <a href="#gates">🚧 Three Gates</a> ·
  <a href="#guards">🛡️ Guards</a> ·
  <a href="#routes">🧭 Seven Routes</a> ·
  <a href="#design">🧠 Core Design</a> ·
  <a href="#boundary">⚠️ Limitations</a>
</p>

---

## 🧩 What a one-person company lacks was never "someone who can code"

Tools that let AI write code for you are everywhere. Coding alone stopped being the bottleneck long ago.

**The real bottleneck: when you're alone, nobody keeps watch for you.**

At a big company, before one line of code reaches main branch, it goes through: review by another engineer, a QA pass, and product sign-off.
Starting a company alone, all three seats are empty — and AI writes code far faster than you could ever backfill them yourself.

So three things are guaranteed to happen:

### 🟢 Tests all green, the feature is fake

To make tests pass, AI adds fake data, adds fallback branches, loosens assertions.
The tests are green; the code is broken. You see a wall of green and assume all is well.

### 🗯️ "I'm done" — and nobody can push back

Because the acceptance criteria were never written in a checkable form. It says "the UX should be good" —
so when AI says it's done, on what grounds do you say it isn't? You're the boss, and also the only acceptor.

### 📑 Two AIs edit the same file; the later one overwrites the earlier

The resulting problem is invisible even to automated review — the reviewer gets the post-overwrite code,
and it looks perfectly normal.

**AgentRD exists to fill these three empty seats.**

It's not yet another AI that writes code for you. It's a **system of governance**:
code written by AI must first pass review and acceptance by another set of AIs before it ever reaches you.

---

<a id="quickstart"></a>
## 🗣️ You only need to say one sentence

```
/rd I want a login feature with lockout policy
```

**After that, your part is over.**

```
Break down →  Design   →  Slice   →  Code in  →  Three    →  Auto-fix  →  Deliver
requirements            tasks      parallel     reviews
   AI        3 AIs        AI       many AIs     3 AIs       AI          ✅
```

- 🤖 **Three AIs each produce a technical design**; the orchestrator AI compares them and picks one
- ✂️ **Tasks are sliced along file boundaries so they never collide**; multiple AIs work in parallel
- 🚧 **Three gates review automatically**; on failure a new AI is dispatched to fix, then the whole flow reruns from the top
- 🔁 **At most three rounds** — if it still fails, it stops and tells you where it's stuck

From one sentence to running code, you never need to nod once in between.

**This is what a one-person company should look like: you only appear at decision points, never on the assembly line.**

---

## 👥 Your org chart

A one-person company isn't "one person doing every job" — it's **one person managing every seat**.
AgentRD fills out your R&D department's headcount:

| Role | Who does it | What you do |
|---|---|---|
| 📋 Product Manager | AI asks about your requirements, writes checkable acceptance criteria | Answer questions |
| 🏗️ Architect | 3 AIs each draft a design; the orchestrator compares and selects | — |
| 📊 Project Manager | AI slices tasks along file boundaries, checks for conflicts | — |
| 👨‍💻 Engineers ×N | Multiple AIs work in parallel | — |
| ⚙️ CI / Build | Scripts run type checks and tests — no AI tokens spent | — |
| 🔍 Code Reviewer | A different AI reviews; it can look but not touch | — |
| 🧑‍💼 QA / Acceptance | An AI that has never seen the code uses the product like a real user | — |
| 📚 Knowledge Manager | AI records the pitfalls from this round as lessons, auto-loaded next round | Confirm what to record |
| 👑 **CEO** | **You** | **Decide what's wanted, make the calls, take responsibility** |

**Nine seats. Eight are worked by AI.**

---

<a id="gates"></a>
## 🚧 Three automated review gates

```
Gate 1  Checks that spend no AI tokens
        Run type checks, run tests. Cheapest — put it first: fail early, save money
           ↓ pass
Gate 2  AI reviews the code
        A different AI reviews. Snapshot before review, diff afterward to detect tampering
        It can only look, not edit — and it can't dispatch anyone else
           ↓ no must-fix issues
Gate 3  AI accepts as a user
        An AI that has never seen the code uses the product like a real user would
           ↓ everything passes
        ✅ Delivered
```

**The third gate is the killer move.** 🎯

It can't see the code, can't see the tests, and doesn't know how anything is implemented.
All it holds is the "what counts as done" checklist and a program that runs.

**So it has no choice but to actually use the thing.**

The first two gates look at code; "runs fine but miserable to use" problems only surface when someone plays user for real.
This is the accident one-person companies are most prone to — you know your own product too well to see
how awkward it has become.

---

## 🎯 What it has actually caught

Not theory. Every one of these has a report file to back it up.

| Gate | What it caught |
|---|---|
| 🥇 **Gate 1** | **The configured check command itself was broken.** All 8 coding AIs missed it — they ran against specific files, while the config pointed at an entire directory. |
| 🥈 **Gate 2** | **The anti-tampering feature itself was broken.** The fingerprints recorded by the snapshot feature didn't match the actual files. The security mechanism had been spinning idle all along. |
| 🥈 **Gate 2** | **A module was broken in 6 places and tests didn't flag a single one.** All green. Just reading the code, you couldn't tell the tests weren't watching anything. |
| 🥉 **Gate 3** | **9 UX annoyances — one of which was a genuine calculation error.** The ranking algorithm broke on crashing coins, pushing the truly valuable candidates to the back. |

**Every gate caught something only it could catch.**

Had any of these four slipped to production, a one-person company has no second person to save you.

---

<a id="guards"></a>
## 🛡️ What it mechanically blocks

A one-person company's most expensive cost is **rework** — with nobody re-checking your work,
errors keep rolling downstream.

**So it doesn't rely on exhorting the AI — it relies on scripts that hard-block.** Every row below is enforced by code:

| What could go wrong | How it's blocked |
|---|---|
| The command returns success without running a single test case | Require success **and** a specified marker string in the output |
| A criterion has several requirements but only one got checked | One checkpoint per requirement; all must hit to pass |
| Tech stack gets locked in during the requirements phase | Error if requirement text names a language or framework |
| Preconditions for a judgment have nowhere to live | Human-judged criteria must state "under what conditions the comparison counts" |
| The same command flips its result in a different terminal | Error on nested quotes in commands |
| Code gets changed while it's being reviewed | Snapshot before review, diff after |
| The code to review is swamped by dependency directories | Only review files declared in the task list; extra edits listed separately |
| After an interruption, no idea where things stood | The script reports current progress, what's missing, and where it last stopped |
| Interruptions leave orphaned screenshots and logs | Files not referenced by any report are named |
| Progress that should be recorded isn't | Two-way reconciliation between records and files on disk |
| Rules quietly changed mid-check | A rules fingerprint is stored at kickoff and re-verified every time |
| "I alone said it's fine" going unnoticed | Every run prints who issued the conclusion |
| The orchestrator AI freelances outside the process | Seven classes of actions require asking you first; unlogged = violation |

**Thirteen mechanical guards. Not one relies on self-discipline.**

In a company of one, **the system must be written as scripts** — write it as rules, and nobody follows them once things get busy.

---

<a id="install"></a>
## 🚀 Installed in three minutes

```powershell
# See what it plans to do first — this step changes nothing
powershell -ExecutionPolicy Bypass -File install.ps1

# Once satisfied, actually install
powershell -ExecutionPolicy Bypass -File install.ps1 -Apply -EnableAgentTeams

# Initialize inside your project directory
cd D:\your\project
powershell -ExecutionPolicy Bypass -File <agentrd>\scripts\init-rd.ps1
```

Restart Claude Code after installing, then type `/rd` to begin.

**Runs on Windows — no tmux, no WSL, no extra CLI tools to install.** 💻

The init script is incremental and won't overwrite existing files. It auto-detects your project's language,
wires up the matching check commands, creates a `.gitignore`, then actually runs the configured commands once to confirm they work.

**No server to rent, no account to register, no monthly fee. Once installed, it's yours.** 🆓

---

<a id="routes"></a>
## 🧭 Seven routes — small tasks skip the full pipeline

A one-person company pays its own token bills. So it checks how big the task is first, then picks a route:

| Route | When to use |
|---|---|
| `direct` | A one-or-two-line tweak; just do it |
| `guarded` | Medium change; add one review |
| `full` | A complete feature; all three gates |
| `refactor-safe` | Refactoring existing code; serial by default |
| `diagnose` | Troubleshooting; reproduce first, then fix |
| `research-only` | Research only; no code |
| `review-only` | Code review only |

**No cannons pointed at mosquitoes.** 🦟

---

<a id="design"></a>
## 🧠 Core design

### 📋 The acceptance checklist is the starting point of the whole flow

To skip human review, the prerequisite is **acceptance criteria that a machine can judge before work begins**.

- **Machine-judged**: first pin down "given what input, expect what output, by what standard of equality",
  translated into concrete commands once the technical design is set
- **AI-judged**: must spell out "which interface to look at", "under what preconditions the comparison counts",
  "what evidence to hand back"

A criterion you can't explain how to check isn't an acceptance criterion — it's a wish. The script blocks it outright.

**This is the foundation on which the whole one-person-company model stands.**
You can't read the code line by line; you can only read conclusions — so those conclusions must be trustworthy.

### 🧪 Passing tests alone don't count

Passing tests only prove "the code matches the tests" — not that the code is right.

So one thing is required: **deliberately break the code and see whether the tests scream.**
Change `>` to `>=`, delete a condition, add one to a constant — break one spot, run once, then revert.
If the tests stay silent, that spot was never covered to begin with.

Measured comparison — same repo, same review round:

```
One module: 6 breaks introduced, 6 caught by tests
Another module: 6 breaks introduced, 0 caught by tests
```

The only difference: the first module's task card said "you must do this"; the second's didn't.

### 📂 Tasks in the same batch may not touch the same file

Two AIs editing the same file, the later overwriting the earlier — automated review can't see that kind of problem.

So tasks are sliced by **file**, not by feature. A script checks whether the file lists of tasks in the same batch overlap.

---

## 🙋 When you need to step in

What a one-person CEO should save most is attention. In the entire flow, only four moments need you:

| When | Notes |
|---|---|
| 1️⃣ Requirements at step one | Requirements can only come from you; no way around it |
| 2️⃣ The orchestrator AI wants to act outside the flow | Killing a working AI mid-task, changing flow rules, skipping a check — it must ask you first |
| 3️⃣ Confirming which lessons to record at wrap-up | Low-cost confirmation; if you don't respond, it records by its own judgment |
| 4️⃣ Three rounds without passing | Abnormal; a healthy run never triggers this |

**The rest of the time, go do what only you can do — think about the product, meet customers, collect money.** 💰

---

<a id="boundary"></a>
## ⚠️ Limitations

Said up front, to save you time:

- 💻 **Windows only.** Check commands are PowerShell-based; they run incompletely on Mac and Linux.
- 🖥️ **Pure codebases get diminished results.** With no runnable interface or command, gate 3 degrades into an ordinary integration test.
- 💸 **Parallel AIs cost roughly 5× the tokens.** A single AI is more economical for simple CRUD — hence the seven routes.
- 🧪 **Agent Teams is an experimental Claude Code feature**; on Windows, only single-window mode works.
  If unavailable, it automatically degrades to one-at-a-time execution, and the flow doesn't break.

---

## 📁 Directory structure

```
AgentRD/
├── README.md                  This file in Chinese (简体中文)
├── docs/                      Multi-language READMEs
│   ├── README_en.md           English
│   ├── README_ja.md           日本語
│   └── README_ko.md           한국어
├── install.ps1                Install the workflow into Claude Code
├── skills/                    The seven workflow files
│   ├── rd/                    Entry point; sizes the task and picks a route
│   ├── rd-spec/               Step 1: gather requirements
│   ├── rd-plan/               Step 2: design and slice tasks
│   ├── rd-build/              Step 3: write code + three checks
│   ├── rd-review/             Gate 2: AI reviews code
│   ├── rd-eval/               Gate 3: AI accepts as a user
│   └── rd-keep/               Step 4: record lessons
├── templates/                 Templates for the various files
├── examples/lessons/          What a qualified lesson entry looks like
└── scripts/
    ├── init-rd.ps1      Initialize inside a project
    ├── gate-l1.ps1            Gate 1 checks
    ├── check-ac.ps1           Prevents "command succeeded but tested nothing"
    ├── check-artifacts.ps1    Checks progress, interruptions, and rule tampering
    ├── freeze-target.ps1      Snapshot + tamper comparison
    └── validate-plan.ps1      Validates acceptance & task list quality
```

What gets generated inside your project:

```
.rd/
├── attention.md              Read first at every kickoff; kept under 30 lines
├── gates.json                Which commands gate 1 runs
├── bin/check-ac.ps1          Guard script; travels with the project
├── lessons/                  Accumulated lessons
└── features/{feature-name}/
    ├── dispatch.md           Why this route was chosen
    ├── spec.md               Requirements
    ├── spec-internal.md      Internal notes (invisible to the gate-3 AI)
    ├── acceptance.json       Acceptance checklist
    ├── design.md             Technical design
    ├── tasks.json            Task list
    ├── run.json              Run records
    ├── review-target.json    Review snapshot
    └── reports/              Reports and evidence from the three gates
```

**These files should all be committed to git.** They are evidence — when you need to prove
"what exactly was verified back then", this is what you point to.

**A one-person company has no coworker to vouch for you.** These files are your quality archive:
when a customer asks, a partner asks, or you-yourself-six-months-later asks, the answers are all in `reports/`.

---

## ⚙️ Notes for editing the code

The `.ps1` files under `scripts` **must be saved as UTF-8 with BOM**.

Windows PowerShell 5.1 decodes BOM-less files using the system default codepage:
CJK comments turn into mojibake, quotes stop pairing, and the whole script fails with syntax errors.

In VS Code, pick "UTF-8 with BOM" in the encoding selector at bottom right. From the command line:

```powershell
$enc = New-Object System.Text.UTF8Encoding($true)
Get-ChildItem .\scripts -Filter *.ps1 | ForEach-Object {
    $t = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($_.FullName, $t, $enc)
}
```

**Why JSON instead of YAML for configuration**: so the check scripts run on Windows PowerShell 5.1
with nothing installed — 5.1 can't parse YAML.
Whether the check scripts can run at all directly decides whether this workflow can automate.

---

## 💡 In one sentence

**Others give you an AI employee. AgentRD gives you a company system that can manage AI employees.**

```
/rd I want to build a ...
```

---

<sub>Keywords: AgentRD, AI R&D department, One Person Company, OPC, solopreneur, indie hacker, Claude Code, autonomous coding,
AI code review, multi-agent workflow, fully automated programming, prompt-to-product, AI development pipeline,
multi-agent collaboration, automated acceptance, code review automation, acceptance criteria,
mutation testing, Claude Code skills, PowerShell.</sub>

---

## 📜 License

[PolyForm Noncommercial License 1.0.0](../LICENSE)

Free for personal use, study, research, and nonprofits. **Any commercial use requires prior written permission** —
including shipping it in a commercial product, offering paid services built on it, or using it inside a company.
For commercial licensing, open an [issue](https://github.com/bluesxu/agentrd/issues) on GitHub.
