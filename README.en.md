[中文说明 →](README.md)

# dsh-engramory-recall

[![npm](https://img.shields.io/npm/v/dsh-engramory-recall?color=blue)](https://www.npmjs.com/package/dsh-engramory-recall)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Fyffo__dsh-engramory-recall.json)](https://unstone.github.io/dsh-xray/registry.html#yffo__dsh-engramory-recall)

> **Your memory store is already on disk. Your model just never opens it** — not unless you
> remember to say "go read your memory first." This plugin makes the relevant old notes
> resurface on their own, once per turn (at most 4 pointers, 480 characters total), so you
> stop hand-feeding them.

One command installs it (a host restart picks it up): `dsh plugin --profile desktop add dsh-engramory-recall`

A local memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
The store is an ordinary folder of markdown files (default `~/memory/engramory`) laid out in
**Format v1** ([`docs/format.md`](docs/format.md)) — a spec this repo maintains and freezes. It
borrows the *shape* of the [Engramory protocol](https://github.com/tinqiao-oss/engramory) (MIT):
one fact per file, an index as a cheat sheet, a hard cap on that index. No code is shared with
upstream, and the mechanism is ours; see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Everything is built on `node:` built-ins: **zero third-party dependencies, zero network calls,**
**zero model calls by default, zero daemon** (`package.json` has no `dependencies` key at all).

## Why this exists

Anyone accumulating long-term memory in markdown hits the same wall: **the notes get written, but
the agent never goes looking for them.** You say "read your memory first" every session — and if
nobody says it, the notes may as well not exist. The obvious fix, "just capture everything
automatically," has a cost you never see: every paragraph shoved into context is paid for on every
turn it survives, and a system that never says what it spent is one you cannot evaluate. So
retrieval here is an explicit, budgeted, accounted event.

## What it is

Install it, keep talking normally, and three things happen:

1. **You stop flipping through your own notes.** When a turn is relevant to something in the
   store, that turn gains a block of *possibly relevant existing entries*: the filename, the
   matched line from the body, and a note that the model should `read` the original for detail.
2. **It shows up only when it should, and never without a ceiling.** No hits, no tokens injected;
   on a hit, at most 4 pointers and 480 characters. Greetings like "continue" or "ok" pass
   straight through with zero retrieval.
3. **You can see whether any of it was used.** A **Memory** tab appears next to the conversation.
   It opens with **three answers**, not a wall of gauges — what the latest turn was nudged with
   (and whether each note was ever opened since), how much of what it hands out actually gets used,
   and whether the write guard had to block anything. Detail lives in eight tabs below.

Three words used throughout: an **injection** is a nudge block appended to a turn, a **pointer** is
one line of it (a note's filename plus the matched snippet from its body), and the **open rate** is
the share of injected pointers that were later read.

## What it is not

- **Not a writer.** It never adds notes to your store, never deletes or merges them: writing is a
  decision you or the model make under the Engramory discipline. A plugin that can seed its own
  store turns your notes into the model's scratch paper.
- **Not a second store.** No SQLite, no vector database, no generated index files — markdown is
  the only source of truth, and it stays readable, diffable, hand-editable, shareable.
- **Not a semantic engine by default.** No bundled embeddings, no vector store: Chinese is
  segmented into single characters plus adjacent bigrams, and the only bridge across paraphrases
  is a hand-built table of 177 synonym entries. A pluggable seam (`semanticProvider`) exists for
  a provider you choose; by default it stays lexical and never sends a request behind your back.
- **Not a sandbox.** The write gate intercepts the `write` / `edit` tools; shell redirection
  (`bash` `>`) is invisible to it, and the doctor is the backstop.

## Features

| | Feature | What it actually does |
|---|---|---|
| 🧠💸 | Recall every turn, free when irrelevant | One retrieval at the start of each user turn; on a hit the model is told which notes look relevant. No hit means zero tokens injected, and greetings skip retrieval entirely |
| 🎯 | It injects the sentence, not an echo of your question | Injected lines are picked from the body by IDF; titles and descriptions, which tend to parrot the question, are discounted. Foundation-sentence retention 39.6% → **85.4%** |
| 🖼️ | One human-readable panel | The **Memory** tab: **three answers first** (what was nudged, how much was used, what got blocked), then eight detail tabs — read-only, refreshed every 3s, plus a glossary and a "which switch do I need?" list. A dashboard nobody can read is not a dashboard |
| 🔒 | Data stays on this machine | Needs file read/write only, never network. No database, no index files, plain markdown you can read and diff |
| 🎚️ | Hard ceilings | Per-turn characters, pointer count, and index size all have limits — and exceeding one is a **refusal**, not a silent truncation |
| 🛡️🩺 | Write gate + doctor | Non-conforming filenames, missing frontmatter, or suspected real credentials are rejected at write time with an audit line; 20 static checks report orphans, index duplicates, broken paths, stale todos, notes carried into context 20 times without ever being read, and **which index lines to compress before the cap refuses your next write** |
| 🧹 | Consumption-side gate | Notes carried into context many times and never opened get demoted (default). Only well-evidenced ones leave the injection set; "old" merely demotes, it never blocks |
| 📊 | Open-rate ledger + memory report | Every injection and every open lands as a JSONL line. `npm run recall:stats` shows the ledger, `npm run recall:report` prints a one-page report |
| 🧩 | Usable from other hosts | `mcp.js` is a zero-dependency stdio MCP server, so the same store can be mounted read-only into Claude Code / Codex / Cursor |

## Install

Requires DeepSeek Harness with the `dsh` command available.

```bash
# 1) install (profile name depends on your setup: "desktop" for the app, "web" for dsh web)
dsh plugin --profile desktop add dsh-engramory-recall

# 2) restart the host once (re-run dsh web, or quit and reopen the desktop app)
#    config is hot-reloaded; code is not

# 3) after using it for a while, read the ledger, then the human-readable report
cd ~/.dsh/profiles/desktop/node_modules/dsh-engramory-recall && npm run recall:stats
npm run recall:report -- --days 30
```

Installing from a checkout works the same way, with a path instead of a package name:
`dsh plugin --profile desktop add /path/to/dsh-engramory-recall`. To remove it:
`dsh plugin --profile desktop remove dsh-engramory-recall`.

**What you should see once it's installed:**

- A **Memory** tab appears beside the conversation/trace tabs: three answers up top, eight detail tabs below.
- Say something related to a note in your store and that turn gains a "possibly relevant existing
  entries" block; say "continue" or "ok" and **nothing is added** — the design working, not a fault.

If instead nothing happens at all, check that the symlink under your profile's
`node_modules/dsh-engramory-recall` points at a real directory: a broken link makes the host print
one line (`skipping profile bundle`) and skip the plugin entirely without any other error. More
details, plus a second install trap, in [docs/release.md](docs/release.md).

## What the panel looks like

![The Memory panel's first screen](docs/images/panel-first-screen.png)

> An off-screen render of the real panel (1120px wide, light theme) — not a mockup; the dark theme follows the host.

The first screen answers three questions before it shows any detail:

1. **What was the latest turn nudged with?** — the notes, their relevance, and whether each one has
   been **opened since** (the status dot comes from the same ledger the usage tab reads, not a guess).
2. **How much of it gets used?** — the open rate plus a bar chart of "which pointer position gets
   opened", with the median marked. It says out loud that this is a *proxy*: it proves a note was
   opened, never that it was written into the answer.
3. **Did anything get blocked?** — how many writes the guard rejected, how many doctor findings
   need attention, and how much of the index cap is used (the cap comes from your config) with a
   plain-language verdict.

The eight tabs hold the detail: **recall log**, **usage**, **notes**, **doctor**, **index**,
**archive**, **write audit** and **help** (glossary, "which switch do I need?", and where every
number comes from). The panel only reads: the numbers come from local files — the ledger
(`.engramory-recall.jsonl`), the write audit (`.engramory-audit.jsonl`), the index and the notes
themselves. When that read-only route isn't available (Electron runs over `file://` + IPC), recall
keeps working and the panel just stays on "reading the memory store…" plus "host route unavailable".

## Configuration

Edit your profile's `cordis.patch.yml` and restart once, as above. Full table, including the keys
not listed here (query budget, rotation demotion, dedup, semantic switches, …):
[docs/how-it-works.md](docs/how-it-works.md#配置) (Chinese).

```yaml
- insert:
    - id: engramory-recall
      name: dsh-engramory-recall
      config:
        enabled: true
        storePath: ~/memory/engramory    # empty = plugin does nothing (a deliberate safe default)
        maxPointers: 4                   # max pointers per turn
        maxChars: 480                    # character ceiling for one turn's pointers
        nudge: true                      # ask whether to record something, after finishing work
        guardWrites: true                # write gate
        autoArchive: false               # automatic archiving (off by default)
```

| Key | Default | What it does |
|---|---|---|
| `maxPointers` | `4` | Max pointers injected per turn. Measured: 4→5 buys 1.7 points, 4→6 buys none |
| `recallMode` | `push` | What goes into context once something matches: `push` injects up to `maxPointers` pointers (unchanged) / `hybrid` injects only the top 1 / `pull` injects **no pointers at all**, just one line saying "the store has N possibly related leads — run `engramory_search` yourself if you need them". In `pull`, a turn with no match stays silent. The default has now been measured with the 7.1 scorer over the **four tool-loop arms** (`none`/`push`/`hybrid`/`pull`; `hybrid` was measured on 2026-10-17); **the conclusion is to keep `push`**: `hybrid` halves the injection (110 → 57 tokens) but **deterministically loses 22.6 points of pointer recall** (86.8% → 64.2%), and its tool-call rate (34–38%) stays in `push`'s band (24–30%) instead of recovering `pull`'s (96–98%) — numbers and reasoning in [docs/measuring.md](docs/measuring.md) |
| `maxChars` | `480` | Hard character ceiling for pointer text. When something doesn't fit it collapses to filename-only, never a silent drop |
| `gate` | `assist` | Consumption-side gate. `off` does nothing / `shadow` records only / `assist` demotes (default) / `enforce` drops well-evidenced notes from injection |
| `nudge` | `true` | "Remember this long-term" intent hint; also fires once in a long session that has written nothing (`sedimentMinTurns`, default 12 turns) |
| `guardWrites` | `true` | Rejects non-conforming filenames, missing frontmatter, and suspected real credentials, and writes an audit line |
| `autoArchive` | `false` | Runs archiving automatically instead of waiting for a click (still two-phase). Off by default because archiving modifies the store |
| `storePath` | `~/memory/engramory` | Supports `~`. **Empty disables the plugin** — it does not guess a path |
| `indexMaxLines` / `indexMaxBytes` | `200` / `25600` | `MEMORY.md` beyond this is **refused a write** (the index is read every turn; the part past the cap would silently stop being recalled) |
| `maxNotes` / `maxBytes` | `2000` / `4194304` | How many notes / bytes a single recall pass may read (a guard against pathological directories). Notes past the cap **never enter search** — when a store grows that large, the doctor, the panel, and `engramory_status` all report the shortfall |

## FAQ

**Q: I installed it and nothing seems to happen.**
Check whether the **Memory** tab exists. If it does, the plugin loaded and the silence is
probably correct (see the next question). If it doesn't: verify the symlink isn't broken (a
broken one prints only `skipping profile bundle` and fails silently), restart the host, then run
`npm run check` to see what it reports about config keys, store path, and which copy is loaded.

**Q: Why wasn't I nudged this turn?**
Three silences are all normal: **greeting / empty / shorter than 4 characters** ("continue", "ok",
"好的") is passed through without retrieval; **retrieval ran and found nothing**; or **something
was found but didn't clear `minScore`** (default `0`). To find out which, look at the **recall log** tab
in the Memory tab or at the reason breakdown from `npm run recall:stats` (`chitchat` / `too-short`
/ `duplicate` / `store-not-configured` / `index-empty` / `no-hits` / `below-min-score`). If the
store genuinely has nothing relevant, it does not invent a hit.

**Q: Does my memory leave this machine, and where does it live?**
It doesn't. The plugin needs file read/write and no network, reads your markdown, creates no
database and no index files, and makes **zero model calls by default**; a semantic option you
enable explicitly uses the model your host already has configured, and the plugin never configures
a key itself. The store is just a folder: version it with git, edit it by hand.

**Q: Why won't my `MEMORY.md` accept a write?**
Past 200 lines or 25KB it is **refused outright** — the refusal message quotes the numbers
("203 lines > 200") and the file on disk is untouched, zero bytes changed. That is deliberate: the
index is read in full every turn, so the part past the cap would silently stop being recalled. A
rewrite that shortens the index goes through, and the doctor reports the overflow.

**Q: The index is nearly full — what do I do?**
Three steps, all doable yourself: ① in the panel, open **Memory → Archive** and run the archive pass
(it backs up first, then moves long notes' history blocks into `<note>-history.md`); ② compress long
lines — an index line should be "one short hook + a link", and the doctor's `index-long-lines` names
the worst offenders by length; ③ rewrite the whole file shorter — **a shrinking rewrite always goes
through**, so you can compress step by step. The doctor also speaks up *before* the refusal:
`index-near-cap` (warn) at 90%, `index-over-cap` (error) once you are over. Watch the panel header's
"index used x / cap" line afterwards.

**Q: What does the write gate actually stop?**
`write` and `edit` only: malformed filenames, missing frontmatter, and suspected real credentials
(private key blocks, `sk-`, `ghp_`, `AKIA`, `xox`, JWTs) are rejected on the spot, the reason goes
back to the model, and later listeners cannot undo it. It is **not a sandbox** — it cannot see
`bash` redirection, where the doctor's periodic scan is the backstop.

**Q: Will automatic archiving delete my history, and does the panel's open rate prove my memory is being used?**
No on both counts. Archiving only moves append-style sections (like `## Batch N`) into
`<note>-history.md` in the same directory — still in the store, still recallable — after backing
up to `.archive-backup/<timestamp>/`, and it is two-phase: it proposes a plan, and the store
changes only when you click execute. `autoArchive` defaults to off so you can click through a few
rounds manually first. The open rate is a **proxy metric**, not causal proof: deduplicated opened
notes ÷ injected pointers (reading one pointer several times in a turn counts once, so numerator
and denominator share a unit). It answers "was a nudge followed up on?" It cannot answer "did
reading it help?" — which is why the panel prints four caveats alongside it.

**Q: Should I turn on semantic retrieval / semantic enhancement?**
Both default to off. Off means purely lexical: Chinese segmented into single characters plus
adjacent bigrams, plus a hand-built table of 177 synonym entries — **rephrase it and retrieval
will miss**, which is its known weak spot. The two semantic tiers either spend model tokens or add
an external dependency per query, so they are explicit switches; installing the plugin never
causes it to call a model to modify your notes. If you want them, see the two optional sections in
[docs/limits.md](docs/limits.md) (Chinese).

**Q: I only use Claude Code / Codex / Cursor. Can I use this?**
Yes, but **read-only**. `mcp.js` is a zero-dependency stdio MCP server (the `engramory-recall-mcp`
command) that exposes retrieval and note reading over the same store. Other hosts don't have the
guard interfaces, and faking them would replace a fail-closed gate with a verbal promise. See
[docs/release.md](docs/release.md#别的宿主mcp-服务器只读) (Chinese).

**Q: `dsh plugin add` failed, but the error is about an unrelated package?**
`dsh plugin` is **all or nothing**: it reinstalls the profile's whole dependency set, so if any
single spec fails to resolve (a version yanked, blocked by supply-chain policy, pointing at a
deleted path), adding or removing *any* plugin fails together — and the error names the unrelated
package. Look in `.plugin-manager/logs/operation-*/pnpm.log`, not at the package you were
operating on.

## How it works

One-line data flow: **your message → retrievability gate → BM25 over the store (synonym
expansion, IDF term selection) → on a hit, one plugin message with `role: user` (filename +
matched snippet) → one ledger line per injection and per open.** Retrieval is local lexical
arithmetic and touches no model by default. Injection volume is bounded by `maxPointers` /
`maxChars`, and anything that doesn't fit collapses to a filename-only line.

The Memory tab is served by a **read-only** route the plugin registers,
`GET /api/engramory-recall/state` (polled every 3 seconds; the doctor and archive plans are cached
for 30 seconds rather than recomputing the whole store). Executing an archive is a separate route
that must be `POST`, and when that route is unreachable (Electron over `file://` plus IPC, for
instance) recall keeps working — you just don't get panel data.

| File | Role |
|---|---|
| `index.js` | Plugin entry: per-turn pre-step recall, tool and read-only route registration |
| `bm25.js` | Lexical retrieval: Chinese segmentation, IDF term selection, 177 synonym entries, bucketing for oversized notes, length normalization |
| `store.js` · `render.js` | Reads the store and index (markdown is the only source of truth); renders the pointer block, including the rank-weighted snippet budget |
| `guard.js` · `audit.js` · `index-guard.js` | Write gate (fail-closed), `.engramory-audit.jsonl`, and the index ceiling gate (refuses writes past 200 lines / 25KB) |
| `doctor.js` · `confidence.js` | 20 static checks, report-only; consumption-side gate, whose thresholds are derived from this store's own base open rate |
| `archive.js` | Append-style sections → `<note>-history.md`, backup first, two-phase |
| `usage.js` + `scripts/recall-stats.mjs` / `scripts/recall-report.mjs` | Open-rate ledger, `npm run recall:stats` detail, `npm run recall:report` report |
| `client/client.js` · `mcp.js` · `skill.js` | The Memory tab (hand-written bundle, no build tooling); a zero-dependency stdio MCP server for other hosts (read-only); and the `engramory` skill (when to record, and when not to) |

### 🔍 How others vet us

[dsh-xray](https://github.com/unStone/dsh-xray) statically scans every repo under the `dsh-plugin`
topic — more than eighteen thousand of them, daily. It reads code, never runs it, and publishes a
**capability card** per plugin with `file:line` evidence. Ours is
[**C2 · 3 flags**](https://unstone.github.io/dsh-xray/registry.html#yffo__dsh-engramory-recall),
and each flag maps to something you can check yourself:

| What the scanner saw | What it is |
|---|---|
| `runtime_patch · cordis.patch.yml` | A sample config file (defaults), not a runtime rewrite |
| `exec_tooling ×18` | All of it in `bench/` — the benchmark rulers spawn subprocesses, and **those files are not published to npm** |
| `net_server_tooling ×2` | Same, in `bench/embed-live.mjs` (the live test of real semantic retrieval) |
| outbound domains: `api.openai.com` / `api.mistral.ai` / … | Addresses of the **optional** semantic backend: off by default, and nothing leaves the machine unless you turn it on |
| env: `ENGRAMORY_STORE` / `ENGRAMORY_SEMANTIC_PROVIDER` | Our two knobs: where the store lives, and which semantic backend to use |

The principle is one line: **our capability surface is meant to be read.** You can run the scanner
yourself (it's open source, `scanner/`), or start with the limitations we list in
[docs/limits.md](docs/limits.md) (Chinese).

## Development

```bash
git clone https://github.com/yffo/dsh-engramory-recall.git && cd dsh-engramory-recall
npm test            # full suite: tokenizer / BM25 / gate / write guard / doctor / archive / panel / MCP / dirty-data fuzz
npm run check       # wiring self-check: config keys, store path, which copy is loaded, missing package files
npm run bench:check # synthetic benchmark reconciliation (what CI runs, compared against bench/expectations.json)
npm run probe       # recall-quality probe: 3 query groups plus three controls, run against a real store
npm run recall:report -- --days 30   # memory report: who's working, how much context was spent, which turns spent nothing
```

These must run **in a clone**: the npm package ships only the runtime files plus
`scripts/recall-stats.mjs` and `scripts/recall-report.mjs`; `test/` and `bench/` are not published,
so only `npm run recall:stats` and `npm run recall:report` work from an installed plugin directory.
The full command list — a dozen or so benchmark rulers, including
`npm run bench:foundation -- --check` — is in [docs/release.md](docs/release.md#测试与自检) (Chinese).

## Docs

All docs are in Chinese; the English gloss explains what each one covers.

| Doc | What it covers |
|---|---|
| [docs/format.md](docs/format.md) | **Format v1 spec**: directory layout, note fields, caps and governance, differences from the upstream spec |
| [docs/how-it-works.md](docs/how-it-works.md) | How it runs internally, what every knob means (full configuration table), cost comparisons |
| [docs/measuring.md](docs/measuring.md) | The numbers: four disqualification lines for tool selection, comparison with similar plugins, and **four recomputable rulers** — including the 39.6% → 85.4% foundation-sentence ablation, and on LongMemEval-S (500 questions) RecallAny@1 **89.2%** vs textbook BM25 at 86.2% (synthetic benchmark hit@1 50.4% vs 43.2%) |
| [docs/limits.md](docs/limits.md) | **The one to read**: the floor, the real weak spots, the roadmap, and fourteen approaches that were measured and disproved |
| [docs/release.md](docs/release.md) | Install/uninstall traps, every test and self-check command, the release process, MCP from other hosts |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | Relationship to the upstream Engramory protocol, scope of borrowing and alignment, upstream license text |

## License

[MIT](LICENSE)
