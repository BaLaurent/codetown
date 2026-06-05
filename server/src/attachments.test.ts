import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { attachmentDir, sanitizeFilename, reserveAttachmentPath, ATTACHMENT_ROOT } from './attachments.js';

describe('attachmentDir', () => {
  it('namespaces by agent id under /tmp/codetown-attachments', () => {
    expect(attachmentDir('abc')).toBe(path.join(ATTACHMENT_ROOT, 'abc'));
  });

  it('strips traversal attempts from the agent id', () => {
    // basename('../evil') === 'evil' on posix; on win32 it stays '..\\evil',
    // but the test runs in node which uses posix semantics here.
    const id = '../evil';
    expect(attachmentDir(id).startsWith(ATTACHMENT_ROOT)).toBe(true);
  });
});

describe('sanitizeFilename', () => {
  it('keeps a normal name and extension', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('drops directory components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('falls back to "file" when nothing is usable', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('///')).toBe('file');
  });

  it('strips control characters and forbidden punctuation', () => {
    expect(sanitizeFilename('na\x00me<>.txt')).toBe('name.txt');
  });
});

describe('reserveAttachmentPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetown-attach-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the requested name when nothing exists', () => {
    const p = reserveAttachmentPath(dir, 'hello.txt');
    expect(path.basename(p)).toBe('hello.txt');
  });

  it('suffixes -2, -3 … on collisions, before the extension', () => {
    fs.writeFileSync(reserveAttachmentPath(dir, 'a.txt'), '1');
    fs.writeFileSync(reserveAttachmentPath(dir, 'a.txt'), '2');
    const third = reserveAttachmentPath(dir, 'a.txt');
    expect(path.basename(third)).toBe('a-3.txt');
  });

  it('handles extensionless names', () => {
    fs.writeFileSync(reserveAttachmentPath(dir, 'README'), 'x');
    const next = reserveAttachmentPath(dir, 'README');
    expect(path.basename(next)).toBe('README-2');
  });

  it('creates the destination directory if missing', () => {
    const nested = path.join(dir, 'fresh');
    const p = reserveAttachmentPath(nested, 'x.bin');
    expect(fs.existsSync(nested)).toBe(true);
    expect(p).toBe(path.join(nested, 'x.bin'));
  });
});
