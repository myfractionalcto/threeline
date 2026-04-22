<p align="center">
  <img src="public/favicon.svg" alt="Threelane" width="128" height="128" />
</p>

<h1 align="center">Threelane</h1>

<p align="center">
  Local screen + multi-cam recorder and reels/shorts editor for macOS.
</p>

<p align="center">
  <a href="https://threeline.myfractionalcto.com">Website</a> &nbsp;·&nbsp;
  <a href="../../releases/latest">Download</a> &nbsp;·&nbsp;
  <a href="https://myfractionalcto.slack.com">Slack</a> &nbsp;·&nbsp;
  <a href="PLAN.md">Architecture</a>
</p>

---

> **Status:** milestone 1 — app shell only. No recording or editing logic yet.

## About

Threelane is a Mac app that captures your screen, webcam, and a phone-as-camera
simultaneously over the same WiFi network, then edits the tracks into
portrait or landscape reels with per-scene layouts and exports to MP4.

Everything runs locally on your laptop. Nothing is uploaded. The mobile
companion is an installable PWA served by the laptop, so there's no app
store install on the phone either.

More on the [website](https://threeline.myfractionalcto.com).

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

## Community

Questions, feedback, bug reports? Join the Slack:
[myfractionalcto.slack.com](https://myfractionalcto.slack.com)

Or open an issue on this repo.

## Develop

```bash
npm install
npm run dev      # starts Vite + Electron with hot reload
```

## Build an unsigned .dmg

```bash
npm run dist     # writes release/Threelane-<version>-<arch>.dmg
```

We'll add real code signing when there's an Apple Developer account on
the project — it's a flag-flip in `electron-builder.yml`.

## Layout

See [PLAN.md](PLAN.md) for the full architecture and milestone plan.
