import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCursorTrack } from '../recorder/cursor';

/**
 * Project discovery on disk. Scans ~/Movies/Threelane for folders
 * containing a manifest.json. Projects that don't parse are skipped
 * silently — we don't want a corrupt manifest to hide the others.
 *
 * Track media is delivered to the renderer via the custom `threelane-file`
 * protocol (see editor/protocol.ts) so that the web origin's security model
 * doesn't block direct file:// access.
 */

export function projectsRoot(): string {
  return path.join(app.getPath('home'), 'Movies', 'Threelane');
}

function projectUrl(projectId: string, file: string): string {
  // URL encode to handle any weird characters in filenames.
  return `threelane-file://${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`;
}

export async function listProjects() {
  const root = projectsRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const out: {
      id: string;
      name?: string;
      location: string;
      createdAtMs: number;
    }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const manifestPath = path.join(root, e.name, 'manifest.json');
      try {
        const stat = await fs.stat(manifestPath);
        const raw = await fs.readFile(manifestPath, 'utf8');
        const m = JSON.parse(raw);
        out.push({
          id: m.id ?? e.name,
          name: typeof m.name === 'string' ? m.name : undefined,
          location: path.join(root, e.name),
          createdAtMs: m.createdAtMs ?? stat.mtimeMs,
        });
      } catch {
        // missing or invalid manifest — skip
      }
    }
    out.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return out;
  } catch {
    return [];
  }
}

export async function deleteProject(id: string): Promise<void> {
  // Guard against id traversal — only accept the bare folder name we
  // generated. `path.basename` strips any "../" the renderer might smuggle.
  const safeId = path.basename(id);
  if (!safeId || safeId === '.' || safeId === '..') {
    throw new Error(`invalid project id: ${id}`);
  }
  const dir = path.join(projectsRoot(), safeId);
  await fs.rm(dir, { recursive: true, force: true });
}

export async function openProject(id: string) {
  const dir = path.join(projectsRoot(), id);
  const manifestPath = path.join(dir, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const trackUrls: Record<string, string> = {};
  for (const t of manifest.tracks) {
    trackUrls[t.id] = projectUrl(id, t.file);
  }
  // Best-effort cursor track load — missing file is fine for older recordings.
  const cursorTrack = (await loadCursorTrack(dir)) ?? undefined;
  return {
    manifest,
    trackUrls,
    location: dir,
    cursorTrack,
  };
}
