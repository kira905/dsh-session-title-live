# dsh-session-title-live

A **DeepSeek Harness (DSH) plugin** that makes session titles **update live as the conversation goes**.

> **Status**: published (Gitee + GitHub)
> **Repository**: <https://github.com/kira905/dsh-session-title-live> ｜ <https://gitee.com/kira905/dsh-session-title-live>
> **License**: AGPL-3.0 (pending a final decision) — see [License](#license) and [`LICENSE`](./LICENSE)
> **中文**: [README.md](./README.md)

## Why it is needed

DSH's built-in title mechanism generates a title exactly once, from **the first user message of a session** (`automatic: "first-prompt"`).
Once a long session has gone a dozen turns, the sidebar still shows that opening line, completely detached from what the session is actually about —
and the session list is the only entry point you have for finding a session.

This plugin registers an `automatic: "all-prompts"` title provider: **after every human message** it regenerates the title from
"the most recent human messages that fit the byte budget". It does **not** replace the core `session-title` service;
it registers into it (the same extension point the official provider uses).

It also solves a related problem along the way: **automatic state prefixes at turn boundaries**. If a team convention says "mark running work with [running] and finished work with [done]", relying on the agent to do it voluntarily means that, in practice, almost no session ever gets marked; this plugin applies the prefix automatically at the `turn/start` / `turn/end` boundaries (the prefix text is configurable, and the whole thing can be turned off).

- **Zero third-party dependencies**: only `node:fs` / `node:os` / `node:path` (`node:zlib` is used only by a verification script).
- **Zero host-package imports**: the plugin is deployed with the profile and cannot resolve the `@deepseek-ai/*` packages in the global npm tree at runtime,
  so event names and service names are **inlined** in a single file, `lib/host-protocol.js` (a host upgrade means checking that one place).
- **It does not read session files**: it only subscribes to session events and only appends `session/title` events (writing a title is a public event contract of the host).

---

## Design basis

This component is one implementation of the operations system described in
[ops-handoff-design](https://github.com/kira905/ops-handoff-design).
The design basis follows the fixed four questions agreed with that documentation repository:

- **Why it exists and where its boundary is** → see *Autonomous Operations Steward* **§2 session lifecycle coverage matrix**, and *System Panorama and House Rules* **§3.8 autonomy of the session lifecycle**
- **Its compatibility window with the host** → see *Multi-machine Handoff and Cloud Relay* **§4.5 "compatibility requirements"** (see also section 6, "Compatibility", of this README)
- **This component's own pitfalls and measurements** → the "Known limitations" section of this README
- **Documentation repository** → Gitee (mirror) <https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub (primary) <https://github.com/kira905/ops-handoff-design>
  (the component index table in the documentation repository points back to this repository; the two repositories link to each other and version independently)

> Design documents do not carry concrete repository addresses (a hard-coded address becomes a dead link), so the implementation list is collected in the documentation repository's component index table — this repository only owns the back-link section.

---

## 1. Capabilities

| Feature | Description |
|---|---|
| Live title regeneration | Regenerated after every human message; the source material is the basis of the previous title (the **theme anchor**) plus the most recent messages, packed down to fit the byte budget |
| Manual renames are never overwritten | Once you have renamed a title by hand in the GUI, this plugin leaves it alone (**pin**, judged by the same rule the prefix path uses) |
| Turn-boundary state prefix | `turn/start` → `【运行】`, `turn/end` → `【完成】` (the text is configurable and can be turned off) |
| Pre-set title protection | A title already written during session creation (task card / external flow): only its prefix is swapped, it is never displaced by a summary |
| Self-managed scheduling | The host's automatic scheduling cannot get a launch opportunity after the first turn (see the file header of `lib/index.js`), so this plugin triggers from the `llm/stream` hook itself; the two routes are de-duplicated by **turn claim**, so a turn generates at most once |
| Minimum-information threshold | When a title already exists and this turn added too little text (default: fewer than 20 characters), it does not regenerate, so short noise such as "ok" or "got it" cannot drag the title off course |
| Kill switch | One JSON file or one environment variable stops it (**without a restart**); once off, zero writes and zero tokens |
| Sub-agent sessions are skipped | Sub-agent / derived sessions are neither prefixed nor summarised |

---

## 2. Prerequisites

- DSH host package `>= 0.2.0-rc.2 < 0.3.0` (compatibility details in section 6)
- Node.js `>= 18`
- A DSH installation in which you can modify `profiles/<name>/` (the default profile name is `web`)

---

## 3. Install (from scratch)

### 0. Back up first

Before touching the profile, make a copy of `cordis.patch.yml` (essential) and of `package.json` and `.package-map.json` (if you are going to modify them).

### 1. Put the package in place

The package is published on npm as **`@kira905/dsh-session-title-live`**.

**Route 0 (recommended, since 0.2.5) — install it through the DSH plugin manager; the bundle layer mounts it for you**:

```bash
dsh plugin --profile web add @kira905/dsh-session-title-live
```

The package ships its own `cordis.patch.yml` (`package.json#dsh.bundle`), so installing it hands the profile a layer and **you do not edit the profile's `cordis.patch.yml` at all** (skip step 2 below).

Routes A/B/C are the three manual variants; after those you still need step 2.

**Route A (recommended, declarative)** — add an entry to `dependencies` in `profiles/<name>/package.json`, then install:

```jsonc
"dependencies": {
  "@kira905/dsh-session-title-live": "^0.2.5"
}
```

```bash
cd <DSH_HOME>/profiles/<name>
# install with whatever command you normally use to add a plugin to this profile (pnpm / npm both work)
```

**Route B (install straight into the profile with npm)**:

```bash
npm install @kira905/dsh-session-title-live --prefix <DSH_HOME>/profiles/<name>
```

**Route C (clone from git — offline / editing the source)** — simply copy the package directory in as a real directory:

```bash
git clone <repository-url> dsh-session-title-live
cp -r dsh-session-title-live <DSH_HOME>/profiles/<name>/node_modules/@kira905/dsh-session-title-live
```

> The only difference between the three is who is responsible for putting the files under `node_modules`; the plugin behaves identically.

### 2. Register the plugin (manual routes only)

**Skip this step when you used Route 0** — the bundle layer already inserted the plugin. What follows is for the manual routes (A/B/C) only.

Append the `insert` block from [`cordis.patch.yml.example`](./cordis.patch.yml.example) to the end of
`profiles/<name>/cordis.patch.yml`:

```yaml
- insert:
    - id: session-title-live
      name: '@kira905/dsh-session-title-live'
```

You **must** also disable the official first-turn provider (`session-title-llm`): both register
the same provider id, so leaving both mounted makes the later one fail with
`session-title provider "dsh-session-title-live" is already registered` and the entry does not
activate (measured on an isolated instance). Manual routes therefore need:

```yaml
- id: session-title-llm
  disabled: true
```

> Syntax note: the host reads an **id-targeted override** (`id` + `disabled: true`); a `disable:`
> list is **not** part of the loader patch format and is silently skipped (it only shows up as
> `patch: id is required for non-insert patches` in `--dump-config`).

⚠️ The `id` of an `insert` entry must not duplicate an existing entry (a duplicate crashes with `duplicate loader entry id`); when you add both blocks, do not add `insert` twice. Check before adding:

```bash
grep -n "id:" <DSH_HOME>/profiles/<name>/cordis.patch.yml
```

> Since 0.2.5 this package declares `dsh.bundle` (root `cordis.patch.yml`), so it can be installed as a profile layer (Route 0, recommended) **or** registered by hand as above — **do not mix the two**, because registering the same id twice crashes startup.

### 3. Restart and verify

Restart DSH (or let its guardian process bring up the new configuration), then in the GUI:

1. Open any session and send a message → the sidebar title should become relevant to the new content within a few seconds;
2. Send a few more unrelated messages → the title follows along (it does not stay on the first one);
3. Rename the title by hand → from then on this plugin never overwrites it;
4. To confirm the plugin really loaded: the log should contain a line
   `[dsh-session-title-live] registered: all-prompts live title provider｜route=… selfSchedule=true …`.

---

## 4. Configuration

Three layers merge, and **the later one overrides the earlier one**:

1. The defaults in `lib/config.js` (that is, the values in the [example file](./examples/session-title-live.config.example.json));
2. The JSON file that `SESSION_TITLE_LIVE_CONFIG` points at (**if this environment variable is not set, no file is read at all**);
3. The plugin's `config:` section in the host's `cordis.patch.yml`.

Object sections (`marks` / `killSwitch`) are **deep-merged** (only the keys you write are overridden); invalid values are cleaned up to their defaults
and logged as a `warn` (they will not stop the plugin from starting).

Directory resolution (`home`) goes `SESSION_TITLE_LIVE_HOME` > `DSH_HOME` > `~/.dsh`, is cross-platform, and contains **no hard-coded machine path**.

| Key | Default | Description |
|---|---|---|
| `targetWords` | `5` | Target word count for titles in non-CJK languages (prompt text only) |
| `targetCjkCharacters` | `10` | Target character count for CJK titles (prompt text only) |
| `maxInputBytes` | `32768` | Byte budget for the input sent to the model (when exceeded, packing starts from the newest message and walks back) |
| `maxOutputTokens` | `128` | Token cap for the title output |
| `maxTitleBytes` | `80` | UTF-8 byte cap for the title written to disk (matches the host's title limit) |
| `timeoutMs` | `30000` | Timeout for a single generation |
| `provider` / `model` | not set | If configured **as a pair**, titles are generated through a dedicated route; if neither is set, the session's main request route is followed |
| `promptIntro` | see example | The lead-in sentence placed before the JSON array sent to the model |
| `systemPrompt` | not set | Custom system prompt (a string or an array of strings); omitted means the built-in one |
| `selfSchedule` | `true` | Master switch for self-managed scheduling (`false` = fall back to the host's scheduler as it was; in most cases titles then stop refreshing) |
| `selfScheduleMaxHumans` | `32` | Cap on the number of human messages kept in memory per session |
| `minIncrementChars` | `20` | Minimum-information threshold: below this many newly added characters, the title is not regenerated (`0` = off) |
| `themeAnchorMax` | `6` | Cap on how many messages are kept as the theme anchor (the basis of the previous title) (`0` = no anchor) |
| `turnMarks` | `true` | Master switch for automatic prefixes at turn boundaries |
| `markBaseBudgetBytes` | `64` | Byte budget for the base name before the prefix is added |
| `markProvider` | `dsh-session-title-live#turn-mark` | The `source.provider` name used when writing a prefix back (used to recognise "this line was written by us") |
| `marks.prefix` | `{running:'【运行】', done:'【完成】'}` | State → prefix text |
| `marks.textToState` | `{运行:running, 完成:done, 待命:idle, 已中断:interrupted}` | Prefix text → state (**the keys carry no brackets**) |
| `marks.baseFallback` | `session` | Fallback base name when only a prefix remains |
| `killSwitch.file` | `dsh-session-title-live.json` | Kill-switch file name (relative to `home`) or an absolute path |
| `killSwitch.moduleId` | `session-title-live` | The id used in `modules.<id>.enabled` inside the switch file |
| `killSwitch.cacheMs` | `3000` | Disk-read cache (a manual edit takes effect within this many milliseconds) |
| `killSwitch.enabled` | `true` | Disable directly (equivalent to writing `enabled:false` in the switch file) |
| `killSwitch.resumeHint` | see source | The recovery hint logged / reported in errors after it is switched off |

> ⚠️ If you change `marks.prefix`, remember to keep `marks.textToState` able to recognise the shape of the prefix you write out.
> This plugin **merges both sources** into one recognition table (the literal values of `prefix` plus the keys of `textToState`), so a custom prefix
> such as `[RUN]` is still recognised and will not be stacked again on the next turn; but if you change the prefix to a bare, unwrapped word
> (for example `running `), consider adding it to `textToState` as well so that ordinary body text is not caught by mistake.

### Kill switch

```jsonc
// <home>/dsh-session-title-live.json
{ "modules": { "session-title-live": { "enabled": false, "why": "debugging something else, hold off on title refreshes" } } }
```

A top-level shorthand `{ "enabled": false }` is also supported. `enabled:true` = on.

- **fail-safe**: if the file cannot be read / holds broken JSON / has no key for this module → **keep working** (a missing file is not a request to switch off).
- **Environment variable**: `SESSION_TITLE_LIVE_DISABLED=1` stops it immediately (it takes precedence over the file; useful in containers / CI).
- Once off: no prefixes, no generation, **zero writes and zero tokens** (read fresh at every turn / before every generation, effective within ≤3s, no restart needed).

---

## 5. State prefixes (turn boundaries)

- `turn/start` → the title becomes `【运行】<base name>`; `turn/end` → `【完成】<base name>` (those are the shipped default prefix strings — `running` and `done` in CJK brackets — and they are configurable).
- Only the prefix is swapped, the base name is left alone; if the prefix already matches the current state it is not written again (idempotent).
- **`rename` is never used**: `rename` pins the title (the host takes it for a manual rename) and automatic titles are never scheduled again.
  This plugin uses `append('session/title', { source: { kind: 'provider' } })` — it only overrides the displayed value of the "current title".
- After a manual rename (`source.kind === 'user'`) no prefix is applied and the base name is not regenerated.
- Three sources are known (checked against a real instance): `user` (manual rename / external pre-set), `provider` (generated automatically, including by this plugin),
  and `fallback` (the host's deterministic fallback before a title exists). Only `user` counts as a pin; `fallback` is overwritten normally.

---

## 6. Compatibility

| Host version | Status |
|---|---|
| **`0.2.0-rc.2`** | ✅ **Measured end-to-end (2026-10-16)**: installed and exercised for real on an isolated instance (separate data root + port 3090, host `0.2.0-rc.2`) — no `skipping profile bundle`, no `failed to import`, and all three injected services (`sessionTitle` / `llm` / `sessions`) resolved; **functional proof** = after creating a session and sending one message, the title became **`【完成】…`**, and `【完成】` is exactly this plugin's turn-state prefix (its `MARK_RE` contract) |
| later `0.2.x` | ⚠️ **Not measured; no promise** (the declared upper bound is `<0.3.0`) |
| the `0.1.1-rc.2` – `0.1.5` lines | ⚠️ **Not end-to-end tested** (the declared baseline of `v0.2.3` and earlier; **this version no longer declares a 0.1.x range**) |
| Its own diagnostic event `session/title-llm-request` | A diagnostic event written by this plugin itself; no event of the same name was found in the official 0.1.5 / 0.2.0 lines (it does not affect functionality, it exists only for reconciliation) |
| `>= 0.3.0` | ❌ Not assessed (it breaks if the host changes the title events or the provider contract) |

When upgrading the host, review `lib/host-protocol.js` first (the single place where this plugin's inlined protocol constants live):
search the new host sources for every name in it — if a name is still there, fine; if not, something must change.

---

## 7. Known limitations

1. **It depends on the host's private event and service names.** This plugin is not an official plugin, and a host rename breaks it (the symptom: titles stop refreshing,
   and the log may be entirely silent). There is exactly one file to review: `lib/host-protocol.js`.
2. **A failed title generation keeps the old title** (no retry): an LLM timeout / error / empty output all take the "failure" path,
   the host keeps the previous title, and the next human message naturally tries again.
3. **The minimum-information threshold leaves some turns unrefreshed**: when you only send a short message such as "ok", the title keeps the previous version (this is deliberate,
   so that noise cannot drag it off course). To go back to the old behaviour, set `minIncrementChars` to `0`.
4. **After a manual rename there are no more automatic updates** (a pin is the design, not a bug). To restore automation: there is no direct entry point in the GUI
   for putting a title back to "provider source" — switching to another session is the simplest way.
5. **Self-managed scheduling is on by default** (`selfSchedule: true`). It exists to work around the timing limits of the host's scheduler;
   switching it off means no live refresh in most cases, so switch it off only for troubleshooting comparisons.
6. **The `bundles` loading route is now measured (since 0.2.5)**: the package ships its own `cordis.patch.yml` (`dsh.bundle`); on an isolated instance (separate `DSH_HOME`, port 3090, host `0.2.0-rc.2`) `dsh plugin --profile bundlecheck add <tgz>` installed the local tarball and the startup log held only the `dsh web: http://…` line — no `declares no dsh.bundle`, no inactive entry; `--dump-config` lists this plugin's row and marks the official `session-title-llm` as `patched by @kira905/dsh-session-title-live`.
7. **Group chat / multi-user scenarios are not assessed**: this plugin takes its text on the basis that "a human message = `source.kind==='user'`";
   if your deployment has messages from several sources, the selection rule needs to be checked by you.
8. **The `0.1.5` line has only had a static check, not an end-to-end measurement** (see section 6).

---

## 8. Repository layout

```
lib/
  index.js           the plugin itself: provider registration, self-managed scheduling, turn prefixes, pin ledger, kill switch
  config.js          configuration layer: defaults ⊕ config file ⊕ host config + validation + text dictionary
  host-protocol.js   host protocol constants (event names / service names) — the only file to review when upgrading the host
examples/
  session-title-live.config.example.json   configuration example (every entry is its default value)
cordis.patch.yml                           the bundle patch `dsh.bundle` points at (Route 0 mounts it; includes the official-provider disable)
cordis.patch.yml.example                   the manual registration fragment, with every config key spelled out
scripts/
  verify-source.mjs  static verification: syntax + configuration-layer behaviour + sanitization scan (BUILD_* can inject local identifiers)
  test-e2e.mjs       end to end: clean temporary paths + non-default configuration + a fake host through the whole flow
  verify-live.mjs    **read-only** check against a running real instance (whether the protocol constants are out of date)
  probe.mjs          read-only probe (RPC / session-log deframing / event analysis), used by the two scripts above
_test/
  test-mark.mjs            offline unit test for turn-boundary prefixes
  test-self-schedule.mjs   offline unit test for self-managed scheduling + the selectors (theme anchor / minimum-information threshold)
  test-kill-switch.mjs     offline unit test for the kill switch (parsing / fail-safe / caching / end to end)
```

---

## 9. Development and testing

```bash
# 1) Static verification (syntax + configuration-layer behaviour + sanitization scan; inject BUILD_* as described at the top of the script
#    if you need to cover locally known real identifiers)
#    Note: all six categories — machine name / user name / directory name / sync product / internal proper noun / personal form of address —
#    are injected through BUILD_*, because the scanner source itself ships in the public repository and therefore contains no real identifier.
node scripts/verify-source.mjs .

# 2) Clean-path end to end (its own temporary home + non-default configuration; cleaned up automatically afterwards, --keep retains it for troubleshooting)
node scripts/test-e2e.mjs

# 3) The three offline unit tests (fake host, sub-second, zero side effects)
node _test/test-mark.mjs && node _test/test-self-schedule.mjs && node _test/test-kill-switch.mjs

# 4) Read-only check against a **running isolated instance** (whether the protocol constants / event shapes still hold; read-only, sends no messages)
node scripts/verify-live.mjs --base http://127.0.0.1:3090 --home <isolated instance home>
```

The release process (version-number policy / changelog conventions / pre-release checklist) is in [`docs/RELEASING.md`](./docs/RELEASING.md).

---

## 10. Related components

Sibling components in the same DSH ecosystem — separate repositories, separate versions, separate licenses. They all link back to the same documentation repository,
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
(Gitee mirror: <https://gitee.com/kira905/ops-handoff-design>):

| Repository | What it does | How it relates to this one |
|---|---|---|
| `dsh-session-title-live` | Live session titles that follow the conversation | **this repo** |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | Session archiving (physically moves old sessions out of the `sessions` directory; list / preview / restore / delete) | Two sides of the same problem: this repository treats "the title no longer matches what the session is about", that one treats "old sessions occupy startup and load cost" — both keep **the sidebar, the only entry point, usable** |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | Read-only ecosystem overview panel (plugin loading / patches / skill frontmatter / upgrade risk) | Its first check, "load state", reads the boot manifest of the host's home page — **whether this plugin actually loaded is visible there at a glance** (this plugin has no browser half, and its only loading route is the `cordis.patch.yml` insert, see item 6 of section 7) |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | Diagnostic toolkit: dependency-closure checks + chat image attachment reconciliation | Run its `closure/` before and after a host upgrade; this plugin keeps the host contracts in a single file (`lib/host-protocol.js`), and that list is exactly the input to check item by item during an upgrade |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | Self-maintained task board (a card = one real session + a human acceptance gate) | **The immediate beneficiary of this plugin**: the execution session of a board card is an ordinary session, and where a card got to — and whether it closed — is read off the title state prefixes here — **if titles cannot be trusted, progress on the board is just a sentence** |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | Zero-dependency incident toolkit: four on-site scenarios (cannot start / frozen / need to undo a change / data deleted) behind one entry point | The fallback when something goes wrong: once this plugin (or the host) **cannot start** or the interface freezes, run it to produce a health report before deciding whether to act |

> There are **no code dependencies** between these components and they share no runtime — they point at each other because they answer the same batch of questions
> for the same kind of person (running an agent on your own machine for months: install it, find it, see it, diagnose it). Installing one does not affect the others.

---

## 11. License

**Decided (2026-10-16): `AGPL-3.0-only plus a commercial license` (dual licensing).**

- This repository's `LICENSE` is the official full text of GNU AGPL-3.0, and the `license` field in `package.json` is likewise `AGPL-3.0-only`;
- ⚠️ **AGPL-3.0 does not forbid commercial use by itself**: you may use, modify and redistribute it freely (commercial use included), provided that **if you make a modified version available to others over a network, you must offer the corresponding source under the AGPL as well**;
- "+ a commercial license" = **dual licensing**: either open-source your derivative under the AGPL (**the derivative must stay open**), or obtain a **commercial license**. If you need it in a **closed-source** or **commercial** setting (where AGPL's copyleft obligations do not apply), **please reach out by opening an issue**.
