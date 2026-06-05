import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { deriveProjectFromPath, deriveProjectFromDir } from './project-identity.js';

describe('deriveProjectFromPath', () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }));
    dirs.length = 0;
  });

  it('derives the git root from an absolute file path (foreign/old-hook events)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codetown-git-'));
    dirs.push(repo);
    execFileSync('git', ['-C', repo, 'init', '-q']);
    const sub = path.join(repo, 'src');
    fs.mkdirSync(sub);
    const file = path.join(sub, 'x.ts');
    fs.writeFileSync(file, '');

    const fields = deriveProjectFromPath(file, false);
    // git toplevel may be symlink-resolved on macOS; compare via realpath.
    expect(fields).toBeDefined();
    expect(fs.realpathSync(fields!.projectRoot)).toBe(fs.realpathSync(repo));
    expect(fields!.projectName).toBe(path.basename(fields!.projectRoot));
  });

  it('returns undefined for search patterns and relative paths', () => {
    expect(deriveProjectFromPath('src:TODO', true)).toBeUndefined();
    expect(deriveProjectFromPath('relative/path.ts', false)).toBeUndefined();
    expect(deriveProjectFromPath(undefined, false)).toBeUndefined();
  });

  it('never turns the ~/.claude tooling dir into a building', () => {
    const p = path.join(os.homedir(), '.claude', 'projects', 'x', 'memory', 'note.md');
    expect(deriveProjectFromPath(p, false)).toBeUndefined();
  });
});

describe('deriveProjectFromDir', () => {
  it('resolves a git repo to its toplevel', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-')));
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    const sub = path.join(tmp, 'src');
    fs.mkdirSync(sub);
    const f = deriveProjectFromDir(sub);
    expect(f).toEqual({ projectId: tmp, projectRoot: tmp, projectName: path.basename(tmp) });
  });

  it('falls back to the directory itself when not a git repo', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-plain-')));
    const f = deriveProjectFromDir(tmp);
    expect(f).toEqual({ projectId: tmp, projectRoot: tmp, projectName: path.basename(tmp) });
  });

  it('rejects a non-project root (~/.claude)', () => {
    expect(deriveProjectFromDir(path.join(os.homedir(), '.claude'))).toBeUndefined();
  });

  it('rejects a relative path', () => {
    expect(deriveProjectFromDir('relative/dir')).toBeUndefined();
  });
});
