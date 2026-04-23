# Contributing to Threelane

Thanks for your interest in Threelane. This doc explains how the project is
structured for contributors — how to report issues, propose changes, and
get your work merged.

If anything here is unclear, open a
[discussion](../../discussions) or ask in
[Slack](https://join.slack.com/t/myfractionalcto/shared_invite/zt-3vswpelsn-OUyLH0Wf5s_jscxTlIo~yA).

---

## Ways to contribute

- **Report a bug** — open a GitHub Issue with reproduction steps, macOS
  version, and (if relevant) which camera/mic/screen source was in use.
- **Suggest a feature** — open a Discussion first so we can align on scope
  before anyone writes code.
- **Fix a bug or build a feature** — see [Proposing a change](#proposing-a-change).
- **Improve docs** — PRs against `README.md`, `PLAN.md`, or this file are
  always welcome.
- **Test a pre-release** — grab a `.dmg` from the latest
  [Release](../../releases/latest) and file what breaks.

---

## Getting started

Prerequisites:
- macOS 13+ (we don't build for Windows/Linux yet)
- Node.js 20+
- Xcode Command Line Tools (`xcode-select --install`) — needed by some
  native modules
- `ffmpeg` is bundled via `ffmpeg-static`, no system install required

Clone, install, run:

```bash
git clone https://github.com/myfractionalcto/threelane.git
cd threelane
npm install
npm run dev        # Vite + Electron with hot reload
```

Other useful scripts:

```bash
npm run typecheck  # tsc --noEmit on both renderer and electron configs
npm run build      # typecheck + vite build (no packaging)
npm run dist       # build + electron-builder → release/*.dmg
npm run dev:web    # renderer in a plain browser (no Electron, for UI iteration)
```

See [PLAN.md](PLAN.md) for the architecture overview before diving in.

---

## Branching strategy

Threelane uses **GitHub Flow**: one long-lived branch (`main`) plus
short-lived feature branches. No `develop` branch, no release branches.

### The rules

1. **`main` is always releasable.** Every commit on `main` should build
   cleanly (`npm run typecheck && npm run build` passes) and the app
   should launch. If you break `main`, fix it fast or revert.
2. **All real work happens on a branch.** Don't commit directly to `main`
   except for trivial doc typos.
3. **Branches are short-lived.** Aim to merge within days, not weeks.
   Long branches drift and create painful merges.
4. **Releases are tags on `main`**, not branches. See
   [Releasing](#releasing-maintainers-only).

### Branch naming

Use a prefix that signals intent:

| Prefix     | For                                     | Example                         |
|------------|-----------------------------------------|---------------------------------|
| `feat/`    | New user-facing feature                 | `feat/timeline-zoom`            |
| `fix/`     | Bug fix                                 | `fix/seek-to-frame-zero`        |
| `refactor/`| Internal restructure, no behavior change| `refactor/split-compositor`     |
| `docs/`    | Documentation-only                      | `docs/contributing-guide`       |
| `chore/`   | Tooling, deps, CI                       | `chore/bump-electron-32`        |
| `test/`    | Adding or fixing tests                  | `test/protocol-range-handler`   |

Branches are cut from the latest `main`:

```bash
git checkout main
git pull
git checkout -b feat/your-feature
```

### Merging

- **Small, focused PRs** — one concern per PR. Easier to review, easier
  to revert.
- **Squash-merge** is the default for feature PRs (keeps history linear
  and readable).
- **Merge commits** (`--no-ff`) are fine for larger feature branches where
  preserving the individual commits has real value.
- **Rebase vs. merge when updating your branch**: either is fine. Prefer
  `git rebase main` for branches you haven't pushed a PR for yet, and
  `git merge main` once your PR is under review (so reviewers don't see
  history rewrites).

---

## Proposing a change

1. **For anything non-trivial, open an Issue or Discussion first.** Describe
   the problem, your proposed approach, and any alternatives. This saves
   you writing code for something that might get rejected on scope.
2. **Fork** the repo (external contributors) or cut a branch (maintainers).
3. **Build it.** Follow [Commit messages](#commit-messages) and keep
   commits atomic.
4. **Check locally** before opening a PR:
   ```bash
   npm run typecheck
   npm run build
   ```
   And smoke-test the actual app — launch it, exercise the change.
5. **Open a PR against `main`.** Fill in the template: what, why, how
   you tested.
6. **Address review feedback** with additional commits (don't force-push
   once review starts — it makes re-review hard). A maintainer will
   squash on merge.

---

## Commit messages

Short, imperative, present tense. The first line is a summary (under
~70 chars). Blank line, then a body explaining *why*, not *what* (the
diff shows what).

Good:
```
Fix seek-to-frame-0 by serving Range requests from custom protocol

The `threelane-file://` handler was delegating to net.fetch(file://),
which doesn't forward Range headers. Chromium saw an unseekable stream
and clamped every seek to 0. Switch to fs.createReadStream and return
206 Partial Content with Accept-Ranges: bytes.
```

Less good:
```
fix bug
```

Don't worry about matching a strict format like Conventional Commits —
the branch prefix (`feat/`, `fix/`) already signals intent, and we
squash-merge anyway so the merge commit is the one that matters.

---

## Code style & quality gates

- **TypeScript strict mode** is on. No `any` without a comment explaining
  why.
- **No new ESLint/Prettier config yet** — match the existing style in the
  file you're touching. If you want to add formatters, open a separate
  PR for that.
- **Comments earn their place.** Write comments that explain *why* (the
  non-obvious trade-off, the browser quirk, the reason for a workaround).
  Don't write comments that narrate *what* the code already says.
- **No dependencies added casually.** Every dependency is weight — app
  size, audit surface, update burden. If you need a library, justify it
  in the PR description.
- **Keep Electron/renderer separation clean.** Main-process code lives in
  `electron/`, renderer in `src/`. The boundary crosses via `electron/ipc.ts`
  and `electron/preload.ts` only.

### Before pushing

```bash
npm run typecheck   # must pass
npm run build       # must pass
```

If you're touching the recorder, test on actual hardware — emulators
won't surface camera/mic/screen permission issues.

---

## Pull request checklist

- [ ] Branch name uses a prefix (`feat/`, `fix/`, etc.)
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] Manually tested the change (say what you did in the PR body)
- [ ] Commit messages are clear
- [ ] No unrelated changes mixed in
- [ ] `README.md` / `PLAN.md` updated if behavior changed

---

## Releasing (maintainers only)

Releases are tags on `main`, built locally, published via `gh`.

```bash
# 1. Bump version
# edit package.json "version"
git commit -am "Bump version to 0.2.0"

# 2. Tag
git tag -a v0.2.0 -m "v0.2.0"
git push origin main v0.2.0

# 3. Build DMGs
npm run dist

# 4. Create the GitHub release + upload artifacts
gh release create v0.2.0 \
  release/Threelane-0.2.0-arm64.dmg \
  release/Threelane-0.2.0.dmg \
  --title "Threelane 0.2.0" \
  --generate-notes
```

Release notes should call out any breaking changes, new permission prompts,
or migration behavior (e.g. the `~/Movies/Threelane` folder migration).

### Hotfixes

For urgent patches on an already-released version:

```bash
git checkout -b fix/critical-something main
# fix, commit
git checkout main && git merge --no-ff fix/critical-something
git tag -a v0.2.1 -m "v0.2.1 — hotfix for …"
git push origin main v0.2.1
npm run dist
gh release create v0.2.1 release/Threelane-0.2.1-*.dmg --generate-notes
```

---

## Code of Conduct

Be respectful. No harassment, discrimination, or bad-faith contributions.
Maintainers reserve the right to close issues or PRs and remove people
from the Slack for behavior that harms the community.

If something feels off, email the maintainer (see the GitHub profile) or
DM in Slack.

---

## Questions?

- **Project direction & big-picture questions** — open a
  [Discussion](../../discussions).
- **Chat & quick questions** — [Slack](https://join.slack.com/t/myfractionalcto/shared_invite/zt-3vswpelsn-OUyLH0Wf5s_jscxTlIo~yA).
- **Bugs & concrete feature requests** — [Issues](../../issues).

Thanks for contributing.
