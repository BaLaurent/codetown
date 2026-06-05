// Filesystem layout for user-uploaded chat attachments. One subfolder per agent
// under /tmp/codetown-attachments so the agent only "sees" its own drops, and
// names that collide get a -N suffix instead of clobbering the previous file.
//
// Pure functions live here; the route handler in index.ts owns multer and HTTP.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const ATTACHMENT_ROOT = path.join(os.tmpdir(), 'codetown-attachments');

// Per-agent subfolder. Validated as a UUID upstream, but we still basename()
// defensively so a malicious id can never escape the root.
export function attachmentDir(agentId: string): string {
  return path.join(ATTACHMENT_ROOT, path.basename(agentId));
}

// Sanitise an uploaded filename: keep only the basename, strip control chars,
// fall back to 'file' if there's nothing usable left. Preserves the extension
// so the agent can still tell .png from .txt at a glance.
export function sanitizeFilename(name: string): string {
  const base = path.basename(name || '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '').trim();
  return base || 'file';
}

// Return a path inside `dir` that doesn't already exist on disk, by appending
// -2, -3, … before the extension when the original name is taken. Creates the
// directory if needed. Caller writes the bytes.
export function reserveAttachmentPath(dir: string, requestedName: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const safe = sanitizeFilename(requestedName);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  return candidate;
}
