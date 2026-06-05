import { describe, it, expect } from 'vitest';
import { ProjectRegistry } from './project-registry.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('multi-project isolation', () => {
  it('keeps two projects file trees separate', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'codetown-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'codetown-b-'));
    fs.writeFileSync(path.join(a, 'only-a.ts'), '');
    fs.writeFileSync(path.join(b, 'only-b.ts'), '');
    const reg = new ProjectRegistry();
    const wa = reg.getOrCreate(a, a, path.basename(a));
    const wb = reg.getOrCreate(b, b, path.basename(b));
    const namesA = wa.store.getGraphData().nodes.map(n => n.name);
    const namesB = wb.store.getGraphData().nodes.map(n => n.name);
    expect(namesA).toContain('only-a.ts');
    expect(namesA).not.toContain('only-b.ts');
    expect(namesB).toContain('only-b.ts');
    reg.dispose();
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
});
