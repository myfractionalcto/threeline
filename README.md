# Threelane

Local screen + multi-cam recorder and reels/shorts editor for macOS.

> **Status:** milestone 1 — app shell only. No recording or editing logic yet.

## Install

Grab the latest `.dmg` from the [Releases page](../../releases/latest):

- **Apple Silicon (M1/M2/M3/M4)** → `Threelane-<version>-arm64.dmg`
- **Intel Mac** → `Threelane-<version>.dmg`

Open the `.dmg` and drag **Threelane.app** to **Applications**.

### If macOS blocks the app

Threelane is not yet signed with an Apple Developer certificate, so macOS
Gatekeeper may refuse to open it on first launch ("damaged" or "cannot
verify developer"). Clear the quarantine flag with one Terminal command
after installing:

```bash
xattr -rd com.apple.quarantine /Applications/Threelane.app
```

Then launch Threelane normally. Alternatively, right-click Threelane.app
in Applications → **Open**, then click **Open** in the dialog
(double-clicking won't show the override button).

## Develop

```bash
npm install
npm run dev      # starts Vite + Electron with hot reload
```

## Build an unsigned .dmg

```bash
npm run dist     # writes release/Threelane-<version>-<arch>.dmg
```

### Opening the unsigned .dmg on another Mac

Because we don't code-sign yet, macOS Gatekeeper will refuse to open the app
on first launch:

1. Open the `.dmg` and drag `Threelane.app` to `Applications`.
2. In Finder, **right-click → Open**, then click **Open** in the dialog.
   (Double-clicking will only show "can't be opened" and won't expose the
   override button.)
3. After the first launch, it opens normally like any other app.

We'll add real code signing when you have an Apple Developer account —
it's a flag-flip in `electron-builder.yml`.

## Layout

See [PLAN.md](PLAN.md) for the full architecture and milestone plan.
