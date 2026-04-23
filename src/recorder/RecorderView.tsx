import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  CheckCircle2,
  Circle,
  Mic,
  Monitor,
  Square,
  XCircle,
} from 'lucide-react';
import { platform } from '@/platform';
import { cn } from '@/lib/utils';
import { PreviewTile } from './PreviewTile';
import { PhonePreviewTile } from './PhonePreviewTile';
import { useInputDevices } from './useInputDevices';
import { useRecordingSession } from './useRecordingSession';
import { useCompanion } from './useCompanion';
import { CompanionPanel } from './CompanionPanel';
import { usePhonePreview } from './usePhonePreview';
import { ScreenPickerDialog } from './ScreenPickerDialog';

interface Props {
  onExit: () => void;
  /** Called when the user clicks "Open in editor" on a saved recording. */
  onOpenInEditor?: (projectId: string) => void;
}

function defaultProjectName(): string {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'short' });
  const day = now.getDate();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `Recording · ${month} ${day}, ${hh}:${mm}`;
}

/**
 * Riverside-style studio: source pickers on the left, preview tiles center,
 * big round record button pinned at the bottom. The camera tile supports
 * a toggle — the laptop webcam is never mandatory.
 */
export function RecorderView({ onExit, onOpenInEditor }: Props) {
  const { devices, error: deviceError, requestPermissions } = useInputDevices();
  const companion = useCompanion();
  const [projectName, setProjectName] = useState<string>(defaultProjectName);
  const session = useRecordingSession({
    getReadyCompanionIds: () =>
      companion.devices.filter((d) => d.phase === 'ready').map((d) => d.id),
    getProjectName: () => projectName,
  });

  const [screenId, setScreenId] = useState<string>('');
  const [camId, setCamId] = useState<string>('');
  const [micId, setMicId] = useState<string>('');
  const [camEnabled, setCamEnabled] = useState(true);

  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);

  // Which phone (if any) is currently mirrored into the main preview grid.
  // The hook owns the RTCPeerConnection lifecycle — we just hand it the id.
  const [previewDeviceId, setPreviewDeviceId] = useState<string | null>(null);
  const phonePreview = usePhonePreview(previewDeviceId);

  // Drop the preview target if the phone disappears or leaves a camera-
  // ready phase. The hook also notices `left` events, but clearing the id
  // here keeps CompanionPanel's toggle state consistent with reality.
  const previewDevice = useMemo(
    () => companion.devices.find((d) => d.id === previewDeviceId) ?? null,
    [companion.devices, previewDeviceId],
  );
  useEffect(() => {
    if (!previewDeviceId) return;
    if (!previewDevice) {
      setPreviewDeviceId(null);
      return;
    }
    const phase = previewDevice.phase;
    if (phase !== 'ready' && phase !== 'recording' && phase !== 'uploading') {
      setPreviewDeviceId(null);
    }
  }, [previewDevice, previewDeviceId]);

  const togglePhonePreview = useCallback(
    (id: string) =>
      setPreviewDeviceId((cur) => (cur === id ? null : id)),
    [],
  );

  // Seed default selections when devices become known.
  useEffect(() => {
    if (!screenId && devices.screens[0]) setScreenId(devices.screens[0].id);
    if (!camId && devices.cams[0]) setCamId(devices.cams[0].deviceId);
    if (!micId && devices.mics[0]) setMicId(devices.mics[0].deviceId);
  }, [devices, screenId, camId, micId]);

  // Cam preview — respects the "enabled" toggle.
  useEffect(() => {
    if (!camEnabled || !camId) {
      setCamStream((prev) => {
        prev?.getTracks().forEach((t) => t.stop());
        return null;
      });
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        video: { deviceId: camId ? { exact: camId } : undefined },
        audio: false,
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        setCamStream((prev) => {
          prev?.getTracks().forEach((t) => t.stop());
          return s;
        });
      })
      .catch((err) => {
        console.error('[recorder] camera getUserMedia failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [camId, camEnabled]);

  // Mic preview — independent of cam.
  useEffect(() => {
    if (!micId) return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: { deviceId: micId ? { exact: micId } : undefined },
        video: false,
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        setMicStream((prev) => {
          prev?.getTracks().forEach((t) => t.stop());
          return s;
        });
      })
      .catch((err) => {
        console.error('[recorder] microphone getUserMedia failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [micId]);

  // Stop all preview streams on unmount. Recording session owns its own streams.
  useEffect(
    () => () => {
      screenStream?.getTracks().forEach((t) => t.stop());
      camStream?.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Screen picker dialog open state. The Chrome-style grid lives here —
  // the legacy name-only dropdown was useless for multi-monitor setups.
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);

  const pickScreen = useCallback(async (sourceId: string | null) => {
    try {
      const s = await platform.captureScreen(sourceId);
      setScreenStream((prev) => {
        prev?.getTracks().forEach((t) => t.stop());
        return s;
      });
      if (sourceId) setScreenId(sourceId);
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Any video source is enough to start a recording. We no longer require
  // the screen — a camera-only or phone-only capture is a valid use case
  // (talking-head vlog, phone-as-webcam). Mic is optional too; a silent
  // screencast is fine.
  const hasReadyPhone = companion.devices.some((d) => d.phase === 'ready');
  const hasAnySource =
    !!screenStream ||
    (camEnabled && !!camStream) ||
    !!micStream ||
    hasReadyPhone;
  const canStart = hasAnySource && session.state === 'idle';

  // Countdown state: `null` = not counting, `3..0` = current displayed digit.
  // We show 3 → 2 → 1 → 0 at 1 s ticks, then fire `session.start()` on the
  // 0 beat so the UI doesn't hang on a dead frame. Clicking the record
  // button during the countdown cancels it.
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTickRef = useRef<number | null>(null);

  const clearCountdownTicker = useCallback(() => {
    if (countdownTickRef.current !== null) {
      window.clearInterval(countdownTickRef.current);
      countdownTickRef.current = null;
    }
  }, []);

  const doStartSession = useCallback(async () => {
    // Hand the previewed streams to the session — but we need fresh clones
    // because MediaRecorder can't share a stream with a preview <video>
    // element if we want the recorder to own track lifetimes. Clone by
    // constructing a new MediaStream from each track.
    const clone = (s: MediaStream | null) =>
      s ? new MediaStream(s.getTracks()) : null;
    await session.start({
      screenStream: clone(screenStream),
      screenSourceId: screenStream ? screenId || null : null,
      camStream: camEnabled ? clone(camStream) : null,
      micStream: clone(micStream),
    });
  }, [session, screenStream, screenId, camStream, micStream, camEnabled]);

  const start = useCallback(() => {
    if (countdown !== null) {
      // User clicked the record button during the countdown — cancel.
      clearCountdownTicker();
      setCountdown(null);
      return;
    }
    setCountdown(3);
    let n = 3;
    countdownTickRef.current = window.setInterval(() => {
      n -= 1;
      if (n < 0) {
        clearCountdownTicker();
        setCountdown(null);
        void doStartSession();
        return;
      }
      setCountdown(n);
    }, 1000);
  }, [countdown, clearCountdownTicker, doStartSession]);

  // Make sure a dangling timer doesn't fire after unmount.
  useEffect(() => clearCountdownTicker, [clearCountdownTicker]);

  const stop = useCallback(async () => {
    // If we're still in the countdown, just cancel that — nothing has
    // actually started recording yet.
    if (countdown !== null) {
      clearCountdownTicker();
      setCountdown(null);
      return;
    }
    await session.stop();
    // Drop our preview references so tiles go blank after save.
    setScreenStream(null);
  }, [session, countdown, clearCountdownTicker]);

  // Auto-jump to the editor as soon as the recording is finalized. Using a
  // ref so the navigation only fires once per session even if React re-runs
  // the effect.
  const navigatedRef = useRef(false);
  useEffect(() => {
    if (session.state !== 'saved') {
      navigatedRef.current = false;
      return;
    }
    if (navigatedRef.current) return;
    if (!onOpenInEditor || !session.project) return;
    navigatedRef.current = true;
    onOpenInEditor(session.project.id);
  }, [session.state, session.project, onOpenInEditor]);

  const timer = useMemo(() => formatElapsed(session.elapsedMs), [session.elapsedMs]);

  return (
    <main className="min-h-screen flex flex-col bg-background">
      <header
        className={cn(
          'py-4 flex items-center gap-4 border-b border-border/60',
          // Clear the macOS traffic-light region on Electron.
          platform.kind === 'electron' ? 'pl-[84px] pr-6' : 'px-6',
        )}
      >
        <button
          type="button"
          onClick={onExit}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Home
        </button>
        <div className="h-5 w-px bg-border/60" />
        <div className="font-medium">Studio</div>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className={cn('flex items-center gap-1.5', session.state === 'recording' && 'text-red-400')}>
            <StatusDot state={session.state} />
            {stateLabel(session.state)}
          </span>
          {session.state === 'recording' && (
            <span className="font-mono text-sm text-foreground">{timer}</span>
          )}
          <span className="font-mono">
            {platform.kind === 'electron' ? 'Desktop' : 'Browser'}
          </span>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-[320px_1fr] gap-0">
        <aside className="border-r border-border/60 p-5 space-y-6 overflow-y-auto">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1.5">
              Project name
            </label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Untitled recording"
              className={cn(
                'w-full px-3 py-2 text-sm rounded-md bg-secondary text-foreground',
                'border border-border focus:outline-none focus:border-foreground/50',
              )}
              disabled={session.state === 'recording' || session.state === 'saving'}
            />
          </div>

          {!devices.permissionsGranted && (
            <button
              type="button"
              onClick={requestPermissions}
              className="w-full px-3 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90"
            >
              Grant camera & mic access
            </button>
          )}

          <SourceGroup icon={<Monitor className="size-4" />} title="Screen">
            <button
              type="button"
              onClick={() => setScreenPickerOpen(true)}
              disabled={session.state === 'recording'}
              className={cn(
                'w-full px-3 py-2 text-sm rounded-md border text-left truncate',
                'border-border hover:border-foreground/40',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
              title={
                screenStream
                  ? devices.screens.find((s) => s.id === screenId)?.name ??
                    'Selected screen'
                  : 'Choose screen / window'
              }
            >
              {screenStream
                ? devices.screens.find((s) => s.id === screenId)?.name ??
                  'Screen selected'
                : 'Choose screen / window'}
            </button>
          </SourceGroup>

          <SourceGroup
            icon={camEnabled ? <Camera className="size-4" /> : <CameraOff className="size-4" />}
            title="Camera"
            right={
              <button
                type="button"
                onClick={() => setCamEnabled((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {camEnabled ? 'Turn off' : 'Turn on'}
              </button>
            }
          >
            <Select
              value={camId}
              onChange={setCamId}
              disabled={!camEnabled}
              options={devices.cams.map((d) => ({ id: d.deviceId, label: d.label }))}
            />
          </SourceGroup>

          <SourceGroup icon={<Mic className="size-4" />} title="Microphone">
            <Select
              value={micId}
              onChange={setMicId}
              options={devices.mics.map((d) => ({ id: d.deviceId, label: d.label }))}
            />
          </SourceGroup>

          <div className="pt-4 border-t border-border/40">
            <CompanionPanel
              available={companion.available}
              info={companion.info}
              devices={companion.devices}
              starting={companion.starting}
              error={companion.error}
              onStart={companion.start}
              previewDeviceId={previewDeviceId}
              onTogglePreview={togglePhonePreview}
            />
          </div>

          {(deviceError || session.error) && (
            <div className="text-xs text-destructive-foreground bg-destructive/20 border border-destructive/30 rounded-md p-2">
              {deviceError || session.error}
            </div>
          )}

          {session.state === 'saved' && session.project && (
            <div className="rounded-md border border-green-400/30 bg-green-400/10 p-3">
              <div className="flex gap-2 items-start text-xs text-green-400">
                <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="font-medium text-green-300">Saved — opening editor…</div>
                  <div className="text-muted-foreground break-all">
                    {session.project.location}
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>

        <section className="p-8 flex flex-col gap-6 relative">
          {/* Screen + Camera tiles flex to fill the row (landscape). The
              Phone tile, when mirrored, uses portrait aspect (9:16) and is
              sized by the row's height so it only claims as much width as
              it actually needs — landscape tiles shouldn't shrink just
              because a portrait sibling joined the row. Mic's level meter
              gets its own full-width row below. */}
          <div className="relative flex flex-col gap-4 flex-1">
            {/* Column widths sized so every tile ends up the same height:
                Screen/Camera (16:9) height = colW × 9/16, Phone (9:16)
                height = colW × 16/9. Setting Screen:Camera:Phone widths
                proportional to 256:256:81 makes those two expressions
                equal (256 × 9 = 81 × 16 × 16 / 9 ... i.e. 256/16² =
                81/9² = 1). Doing this in grid rather than flex lets the
                grid assign definite widths up front, so the tiles' own
                aspect-ratios can derive height without a chicken-and-
                egg problem. */}
            <div
              className={cn(
                'grid gap-4',
                previewDeviceId
                  ? 'grid-cols-[256fr_256fr_81fr]'
                  : 'grid-cols-2',
              )}
            >
              <PreviewTile
                stream={screenStream}
                label="Screen"
                kind="video"
                className="min-w-0"
              />
              <PreviewTile
                stream={camEnabled ? camStream : null}
                label="Camera"
                kind="video"
                className="min-w-0"
              />
              {previewDeviceId && (
                <PhonePreviewTile
                  videoRef={phonePreview.videoRef}
                  state={phonePreview.state}
                  label={previewDevice?.label ?? 'Phone'}
                  className="min-w-0"
                />
              )}
            </div>
            <PreviewTile
              stream={micStream}
              label="Microphone"
              kind="audio"
              className="aspect-[8/1]"
            />
            {countdown !== null && <CountdownOverlay value={countdown} />}
          </div>

          <div className="flex items-center justify-center gap-6 pt-2">
            {session.state === 'recording' ? (
              <button
                type="button"
                onClick={stop}
                className="size-16 rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center shadow-lg shadow-red-500/30 transition"
                aria-label="Stop recording"
              >
                <Square className="size-6 fill-white text-white" />
              </button>
            ) : countdown !== null ? (
              <button
                type="button"
                onClick={start}
                className="size-16 rounded-full bg-red-500/80 hover:bg-red-400 flex items-center justify-center shadow-lg shadow-red-500/30 transition"
                aria-label="Cancel countdown"
              >
                <Square className="size-6 fill-white text-white" />
              </button>
            ) : (
              <button
                type="button"
                onClick={start}
                disabled={!canStart}
                className="size-16 rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center shadow-lg shadow-red-500/30 disabled:opacity-40 disabled:shadow-none transition"
                aria-label="Start recording"
              >
                <Circle className="size-10 fill-white text-white" />
              </button>
            )}
          </div>
          {!canStart && session.state === 'idle' && countdown === null && (
            <p className="text-center text-xs text-muted-foreground -mt-3">
              Pick a source — screen, camera, microphone, or phone
            </p>
          )}
          {countdown !== null && (
            <p className="text-center text-xs text-muted-foreground -mt-3">
              Starting in {countdown}… click to cancel
            </p>
          )}
        </section>
      </div>
      {screenPickerOpen && (
        <ScreenPickerDialog
          selectedId={screenId}
          onPick={(id) => {
            setScreenPickerOpen(false);
            void pickScreen(id);
          }}
          onClose={() => setScreenPickerOpen(false)}
        />
      )}
    </main>
  );
}

function SourceGroup({
  icon,
  title,
  right,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {icon}
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled || options.length === 0}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'w-full text-sm rounded-md bg-secondary text-foreground px-3 py-2 border border-border',
        'disabled:opacity-50',
      )}
    >
      {options.length === 0 && <option>—</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function StatusDot({ state }: { state: string }) {
  if (state === 'recording') {
    return (
      <span className="relative flex size-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-red-500" />
      </span>
    );
  }
  if (state === 'error') return <XCircle className="size-3 text-red-500" />;
  if (state === 'saved') return <CheckCircle2 className="size-3 text-green-500" />;
  return <span className="size-2 rounded-full bg-muted-foreground/40" />;
}

function stateLabel(state: string) {
  switch (state) {
    case 'idle':
      return 'Ready';
    case 'preparing':
      return 'Preparing';
    case 'recording':
      return 'Recording';
    case 'saving':
      return 'Saving';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Error';
    default:
      return state;
  }
}

/**
 * Giant, translucent digit over the preview grid during the pre-roll.
 * Positioned absolutely over the row so it floats on top of every tile
 * without affecting layout. Keyed on `value` so React remounts the node
 * on each tick — lets the CSS animation replay and gives the user a
 * visible heartbeat instead of a static number.
 */
function CountdownOverlay({ value }: { value: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span
        key={value}
        className="text-[14rem] leading-none font-bold text-white/25 tabular-nums animate-[pulse_1s_ease-out]"
        style={{ textShadow: '0 4px 30px rgba(0,0,0,0.4)' }}
      >
        {value}
      </span>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
