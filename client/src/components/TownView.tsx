import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useProjects } from '../hooks/useProjects';
import { layoutTown, streetGeometry, BUILDING_SIZE, PlacedBuilding } from '../layout/town-layout';
import { drawBuilding, drawTownScene } from '../drawing';
import { HabboRoom } from './HabboRoom';
import type { FocusRequest, ActionRequest } from './AgentRosterPanel';
import { hitTownAt, closeBadgeRect, removeAction } from '../layout/town-hit-test';
import { FolderBrowser } from './FolderBrowser';

// "Add a folder" button, pinned to the top-LEFT corner. Buildings start at the
// layout margin (80px) and the nav/roster DOM lives at the top-right, so this
// corner is always clear. One source of truth for draw and hit-test.
const ADD_BTN = { x: 12, y: 12, w: 32, h: 32 };

// Stable numeric seed from a project id → picks a deterministic facade variant.
const seedFromId = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
};

// Controlled by the parent: `selected` is the project being viewed (null = town
// overview), `onSelect` flips it. The "Town" back control lives in the parent's
// nav cluster, so this component only renders the town canvas or the interior.
// `focusRequest` is forwarded to the interior so the roster panel can fly the
// camera to a specific agent.
export function TownView({ selected, onSelect, focusRequest, actionRequest }: {
  selected: string | null;
  onSelect: (projectId: string | null) => void;
  focusRequest?: FocusRequest | null;
  actionRequest?: ActionRequest | null;
}) {
  const { projectsRef } = useProjects();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const placedRef = useRef<PlacedBuilding[]>([]);
  const hoverRef = useRef<string | null>(null);

  const API_URL = 'http://localhost:5174/api';
  const [browsing, setBrowsing] = useState(false);
  const [confirmKill, setConfirmKill] = useState<{ projectId: string; name: string; agents: number } | null>(null);

  useEffect(() => {
    if (selected) return; // interior takes over
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    let raf = 0;
    let frame = 0;
    const resize = () => {
      const parent = canvas.parentElement;
      canvas.width = parent ? parent.clientWidth : window.innerWidth;
      canvas.height = parent ? parent.clientHeight : window.innerHeight;
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener('resize', resize);

    const render = () => {
      frame++;
      placedRef.current = layoutTown(projectsRef.current);
      // Backdrop: grass map + sidewalks + roads + trees + lampposts.
      drawTownScene(ctx, {
        width: canvas.width,
        height: canvas.height,
        geometry: streetGeometry(placedRef.current, canvas.width),
        frame,
      });
      for (const b of placedRef.current) {
        drawBuilding(ctx, {
          x: b.x, y: b.y, w: BUILDING_SIZE.w, h: BUILDING_SIZE.h,
          name: b.projectName,
          agentCount: b.agentCount,
          active: Date.now() - b.lastActivity < 60000,
          hovered: hoverRef.current === b.projectId,
          seed: seedFromId(b.projectId),
        });
      }
      // Close (✕) badge on pinned buildings.
      for (const b of placedRef.current) {
        if (!b.isPinned) continue;
        const r = closeBadgeRect(b);
        ctx.fillStyle = '#B00020';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('✕', r.x + r.w / 2, r.y + r.h - 4);
        ctx.textAlign = 'left';
      }
      // "+" button to add a folder (top-left corner — see ADD_BTN).
      ctx.fillStyle = '#FFE040';
      ctx.fillRect(ADD_BTN.x, ADD_BTN.y, ADD_BTN.w, ADD_BTN.h);
      ctx.fillStyle = '#3A2E12';
      ctx.font = 'bold 24px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('+', ADD_BTN.x + ADD_BTN.w / 2, ADD_BTN.y + 25);
      ctx.textAlign = 'left';
      if (placedRef.current.length === 0) {
        const msg = 'Aucun projet — lance Claude/Cursor dans un repo, ou clique « + » pour ajouter un dossier.';
        ctx.font = '18px monospace';
        ctx.textAlign = 'center';
        const tw = ctx.measureText(msg).width;
        const cx = canvas.width / 2, cy = canvas.height / 2;
        ctx.fillStyle = '#FFF8E6';
        ctx.fillRect(cx - tw / 2 - 16, cy - 22, tw + 32, 36);
        ctx.strokeStyle = '#4A3B1A';
        ctx.lineWidth = 3;
        ctx.strokeRect(cx - tw / 2 - 16, cy - 22, tw + 32, 36);
        ctx.fillStyle = '#3A2E12';
        ctx.fillText(msg, cx, cy + 2);
        ctx.textAlign = 'left';
      }
      raf = requestAnimationFrame(render);
    };
    render();

    const onMove = (e: MouseEvent) => {
      const h = hitTownAt(placedRef.current, e.clientX, e.clientY);
      hoverRef.current = h ? h.building.projectId : null;
      canvas.style.cursor = h ? 'pointer' : 'default';
    };
    const onClick = (e: MouseEvent) => {
      // "+" button (top-left corner) opens the folder browser.
      if (e.clientX >= ADD_BTN.x && e.clientX <= ADD_BTN.x + ADD_BTN.w && e.clientY >= ADD_BTN.y && e.clientY <= ADD_BTN.y + ADD_BTN.h) {
        setBrowsing(true);
        return;
      }
      const h = hitTownAt(placedRef.current, e.clientX, e.clientY);
      if (!h) return;
      if (h.region === 'close') {
        if (removeAction(h.building) === 'confirm') {
          setConfirmKill({ projectId: h.building.projectId, name: h.building.projectName, agents: h.building.agentCount });
        } else {
          fetch(`${API_URL}/projects/${encodeURIComponent(h.building.projectId)}`, { method: 'DELETE' }).catch(() => {});
        }
        return;
      }
      onSelect(h.building.projectId);
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('click', onClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('click', onClick);
    };
  }, [selected, projectsRef, onSelect]);

  if (selected) {
    // key={selected} forces a fresh HabboRoom when jumping straight from one
    // building to another (e.g. via the roster panel). Without it React reuses
    // the instance and its refs stay pinned to the previous building, so the
    // target agent never materializes and the camera never moves. Re-mounting
    // gives a clean scene; focusRequest (a prop) is read on mount and applied
    // once the agent appears.
    return <HabboRoom key={selected} projectId={selected} focusRequest={focusRequest} actionRequest={actionRequest} />;
  }

  const overlay: CSSProperties = {
    position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.4)', zIndex: 50,
  };

  return (
    <>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {browsing && (
        <div style={overlay} onClick={e => { if (e.target === e.currentTarget) setBrowsing(false); }}>
          <FolderBrowser onClose={() => setBrowsing(false)} />
        </div>
      )}
      {confirmKill && (
        <div style={overlay}>
          <div style={{ background: '#FFF8E6', border: '4px solid #4A3B1A', boxShadow: '6px 6px 0 rgba(0,0,0,0.35)', padding: 16, fontFamily: 'monospace', color: '#3A2E12', width: 340 }}>
            <div style={{ marginBottom: 12 }}>
              {confirmKill.agents} agent(s) tournent dans « {confirmKill.name} ». Les tuer et retirer le bâtiment ?
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={{ fontFamily: 'monospace', padding: '6px 12px', border: '3px solid #4A3B1A', background: '#fff', cursor: 'pointer' }} onClick={() => setConfirmKill(null)}>Non</button>
              <button style={{ fontFamily: 'monospace', fontWeight: 700, padding: '6px 12px', border: '3px solid #4A3B1A', background: '#B00020', color: '#fff', cursor: 'pointer' }}
                onClick={() => { fetch(`${API_URL}/projects/${encodeURIComponent(confirmKill.projectId)}?kill=true`, { method: 'DELETE' }).catch(() => {}); setConfirmKill(null); }}>Oui, tuer</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
