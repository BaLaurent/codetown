import { useEffect, useRef, useState, useCallback } from 'react';
import { useAgentStream } from '../hooks/AgentStream';
import { useChat } from './ChatHost';
import { useTty } from './TtyHost';
import { useFloorNavigation } from '../hooks/useFloorNavigation';
import { FloorNavBar } from './FloorNavBar';
import { InteractionModal, formatAnswers, type QuestionAnswer } from './InteractionModal';
import { FilePreviewModal } from './FilePreviewModal';
import { SpawnPanel, type SpawnRequest } from './SpawnPanel';
import { GraphNode, FolderScore, type AgentQuestion, type AgentCapabilities, type ModelOption, type SubagentOption } from '../types';
import { playReadSound, playWriteSound, playWaitingSound, initAudio } from '../sounds';
import { findMatchingFileId } from '../utils/screen-flash';
import { resolveFocus } from '../utils/focus-resolver';
import type { FocusRequest, ActionRequest } from './AgentRosterPanel';

const API_URL = 'http://localhost:5174/api';

const HOT_FOLDERS_LIMIT = 12;

// Gore palette + lifetime for the agent death animation.
const BLOOD_COLORS = ['#c0241f', '#e23b2e', '#9b1414', '#7a0c0c', '#ff4d3d'];
const BLOOD_LIFESPAN_MS = 950;
import { buildFloorsByDepth, FloorModel, findFloorForFile, floorNumbers } from '../layout/floor-by-depth';
import {
  TILE_SIZE,
  RoomLayout,
  AgentCharacter,
  ScreenFlash,
  seededRandom,
  drawFloor,
  drawWalls,
  drawWindows,
  drawLightFixtures,
  drawRoomLighting,
  drawDesk,
  drawLabel,
  drawRug,
  drawCableRuns,
  drawFloorVents,
  drawScatter,
  drawRoomSign,
  drawRoomThemedDecorations,
  drawOutdoor,
  drawAgentCharacter,
  drawCoffeeShop,
} from '../drawing';

function SpawnTtyButton({ projectId }: { projectId?: string }) {
  const { spawnTty } = useTty();
  return (
    <button
      style={{
        background: '#0d3b2e', border: '3px solid #1a6b50', color: '#5af78e',
        fontFamily: 'monospace', fontSize: 13, fontWeight: 700,
        padding: '8px 14px', cursor: 'pointer',
        boxShadow: '4px 4px 0 rgba(0,0,0,0.4)',
      }}
      onClick={() => spawnTty(projectId)}
      title="Ouvrir un terminal dans ce projet"
    >
      💻 Spawn TTY
    </button>
  );
}

export function HabboRoom({ projectId, focusRequest, actionRequest }: { projectId?: string; focusRequest?: FocusRequest | null; actionRequest?: ActionRequest | null } = {}) {
  // All data comes via refs - NO STATE, NO RE-RENDERS
  const {
    graphDataRef,
    recentActivityRef,
    thinkingAgentsRef,
    activityVersionRef,
    thinkingVersionRef,
    layoutVersionRef,
    pendingRequestsRef,
    chatVersionRef,
    killedAgentsRef,
    connectionStatusRef
  } = useAgentStream();

  // Chat state/UI now lives in ChatProvider (above this view, so it survives
  // town<->building navigation). HabboRoom only opens chats and reads which agent
  // is focused to auto-open its permission modal.
  const { openChatIds, openChat } = useChat();

  const nav = useFloorNavigation();

  // The floors that currently exist, as React state so the FloorNavBar
  // re-renders (and its ▲▼ buttons enable) when floors first appear or change.
  // Without this the list would live only in floorsRef (a render-loop ref that
  // never re-renders React), leaving the buttons stuck disabled with no agent
  // activity to force a render.
  const [availableFloors, setAvailableFloors] = useState<number[]>([]);
  const availableFloorsRef = useRef<number[]>([]);

  // The interaction modal target (React state, not a ref, so the DOM overlay
  // re-renders on open/close). Snapshotted on click; it doesn't change while the
  // agent waits. Either an AskUserQuestion answer or a tool permission.
  type ModalTarget = { agentId: string; displayName: string; requestId?: string } & (
    | { mode: 'question'; question: AgentQuestion }
    | { mode: 'permission'; toolName?: string; toolInput?: string; title?: string; description?: string; plan?: string }
  );
  const [modalTarget, setModalTarget] = useState<ModalTarget | null>(null);

  // Click-to-preview: relative path of the file currently shown in the
  // FilePreviewModal. Local state (not a ref) so the modal mounts/unmounts on
  // open/close. Cleared on floor/project change because HabboRoom unmounts then.
  const [filePreviewPath, setFilePreviewPath] = useState<string | null>(null);

  // chatTick advances (via the render loop) when a permission-request arrives for
  // the focused chat agent, re-running the auto-open effect below.
  const [chatTick, setChatTick] = useState(0);
  const lastChatVersionRef = useRef(0);
  // Permission requests already shown, so closing the modal without deciding
  // doesn't immediately re-open it (a new tool call has a new requestId → fires).
  const shownPermReqRef = useRef<Set<string>>(new Set());
  const [spawnOpen, setSpawnOpen] = useState(false);
  // Model/subagent options for the spawn form, from the project's cached
  // capabilities (empty on a cold start → SpawnPanel shows just "Défaut").
  const [spawnModels, setSpawnModels] = useState<ModelOption[]>([]);
  const [spawnAgents, setSpawnAgents] = useState<SubagentOption[]>([]);

  // Open an agent's pending interaction modal from global state (works without
  // tracking it or even viewing its building). Reads thinkingAgentsRef (question
  // + name) and pendingRequestsRef (permission), both global.
  const openInteractionFor = useCallback((agentId: string) => {
    const agent = thinkingAgentsRef.current.find(a => a.agentId === agentId);
    if (!agent) return;
    const pending = pendingRequestsRef.current.get(agentId);
    if (pending?.kind === 'permission') {
      setModalTarget({
        agentId, displayName: agent.displayName, requestId: pending.requestId,
        mode: 'permission', toolName: pending.toolName, toolInput: pending.toolInput,
        title: pending.title, description: pending.description, plan: pending.plan,
      });
    } else if (agent.question?.questions?.length) {
      setModalTarget({
        agentId, displayName: agent.displayName, requestId: pending?.requestId,
        mode: 'question', question: agent.question,
      });
    }
  }, [thinkingAgentsRef, pendingRequestsRef]);

  // Roster "respond" button: open the permission/question modal without moving
  // the camera. ("chat" is routed straight to ChatProvider.openChat, above.)
  useEffect(() => {
    if (!actionRequest) return;
    if (actionRequest.action === 'respond') openInteractionFor(actionRequest.agentId);
  }, [actionRequest, openInteractionFor]);

  // Auto-open the permission modal for ANY open chat agent that asks (tool prompts
  // fire often, so click-to-respond would be painful). Scans all open chats — not
  // just the most recent — so a non-focused open chat's request still surfaces.
  // chatTick advances on each permission-request; the shown-set guard keeps ✕ as
  // an escape hatch. One modal at a time: the next request rises on the next tick.
  useEffect(() => {
    if (modalTarget) return;
    for (const agentId of openChatIds) {
      const pending = pendingRequestsRef.current.get(agentId);
      if (pending?.kind === 'permission' && !shownPermReqRef.current.has(pending.requestId)) {
        shownPermReqRef.current.add(pending.requestId);
        openInteractionFor(agentId);
        break;
      }
    }
  }, [openChatIds, chatTick, modalTarget, openInteractionFor, pendingRequestsRef]);

  // Load the project's cached model/subagent options when the spawn form opens.
  useEffect(() => {
    if (!spawnOpen || !projectId) { setSpawnModels([]); setSpawnAgents([]); return; }
    let cancelled = false;
    fetch(`${API_URL}/projects/${encodeURIComponent(projectId)}/capabilities`)
      .then(r => (r.ok ? r.json() : null))
      .then((caps: AgentCapabilities | null) => {
        if (cancelled || !caps) return;
        setSpawnModels(caps.models);
        setSpawnAgents(caps.agents);
      })
      .catch(() => { /* cold start → just "Défaut" */ });
    return () => { cancelled = true; };
  }, [spawnOpen, projectId]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const agentCharactersRef = useRef<Map<string, AgentCharacter>>(new Map());
  const filePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const screenFlashesRef = useRef<Map<string, ScreenFlash>>(new Map());
  const animationRef = useRef<number>();
  const layoutInitializedRef = useRef(false);
  const agentColorCounterRef = useRef(0);
  const coffeeShopPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const layoutRef = useRef<RoomLayout | null>(null);
  const lastActivityByAgentRef = useRef<Map<string, { filePath: string; timestamp: number }>>(new Map());
  const lastProjectRootRef = useRef<string | null>(null);
  const lastNodeCountRef = useRef<number>(0);
  const lastRenderedFloorRef = useRef(-1);
  const lastActivityVersionRef = useRef(0);
  const lastThinkingVersionRef = useRef(0);
  const lastLayoutVersionRef = useRef(0);
  const hotFoldersRef = useRef<FolderScore[]>([]);
  const floorsRef = useRef<FloorModel[]>([]);
  const prevAgentCommandsRef = useRef<Map<string, string | undefined>>(new Map());

  // Agent trails - stores recent footprint positions
  const agentTrailsRef = useRef<Array<{
    x: number; y: number; timestamp: number; colorIndex: number;
  }>>([]);
  const lastTrailPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Blood splatter from killed agents: a short-lived burst of red particles.
  const bloodParticlesRef = useRef<Array<{
    x: number; y: number; vx: number; vy: number; size: number; color: string; bornAt: number;
  }>>([]);

  // Room activity tracking for pulse effect
  const roomActivityRef = useRef<Map<string, number>>(new Map());  // roomName -> lastActivityTimestamp

  // Performance metrics tracking. lastDrawTimeRef holds the time of the last
  // scene draw and is the basis for the displayed FPS.
  const lastDrawTimeRef = useRef<number>(0);
  const frameTimesRef = useRef<number[]>([]);
  const fpsRef = useRef<number>(0);

  // Static scene cache: floors, walls, windows, rugs, scatter, cables,
  // wall art and door frames are deterministic and only change when the layout
  // is rebuilt. They are pre-rendered once into an offscreen canvas (in world
  // pixels) and blitted each frame instead of being repainted tile-by-tile.
  // staticCacheBuiltRef is cleared on every layout rebuild to force a refresh;
  // originRef holds the offscreen's top-left world position so it can be placed
  // correctly inside the zoom/pan transform.
  const staticCacheRef = useRef<HTMLCanvasElement | null>(null);
  const staticCacheOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const staticCacheBuiltRef = useRef(false);

  // Zoom and pan state
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const lastDragPosRef = useRef({ x: 0, y: 0 });
  const keysDownRef = useRef<Set<string>>(new Set());

  // Agent tracking mode - follow a specific agent
  const trackedAgentIdRef = useRef<string | null>(null);
  const trackingZoom = 2; // Zoom snapped to on selection; the user can then freely zoom in/out
  const trackingZoomDoneRef = useRef(false); // One-shot: stop forcing zoom once snapped
  const lastTrackedRef = useRef<string | null>(null); // Detects selection changes to re-arm the snap
  const baseOffsetsRef = useRef({ x: 0, y: 0 }); // Store base offsets for coordinate conversion

  // Externally requested focus (from the agent roster panel). Held until the
  // agent materializes on the canvas, then applied in the render loop.
  const pendingFocusRef = useRef<string | null>(null);
  useEffect(() => {
    // Re-runs even for the same agentId because focusRequest.ts changes per click.
    if (focusRequest) pendingFocusRef.current = focusRequest.agentId;
  }, [focusRequest]);

  // Build floors by folder depth. Returns a single RoomLayout wrapping the
  // rooms of ALL floors (gating to one floor happens in a later task).
  const buildLayout = (nodes: GraphNode[]): RoomLayout | null => {
    const floors = buildFloorsByDepth(nodes, hotFoldersRef.current);
    floorsRef.current = floors;
    if (floors.length === 0) return null;

    const root = nodes.find(n => n.depth === -1);
    const rootName = root?.name || 'Project';

    // Select the floor by its depth (FloorModel.floor), NOT by array position.
    // buildFloorsByDepth omits empty floors, so array index != depth. If the
    // requested depth has no floor (e.g. ▲▼ stepped onto an omitted depth),
    // fall back to the nearest existing depth.
    const target = nav.snapshotRef.current.currentFloorIndex;
    const fm =
      floors.find(f => f.floor === target) ??
      floors.reduce(
        (best, f) =>
          Math.abs(f.floor - target) < Math.abs(best.floor - target) ? f : best,
        floors[0]
      );

    filePositionsRef.current.clear();
    const children: RoomLayout[] = [];
    let maxWidth = 1;
    let maxHeight = 1;
    for (const [id, pos] of fm.filePositions) {
      filePositionsRef.current.set(id, pos);
    }
    for (const room of fm.rooms) {
      children.push(room);
      maxWidth = Math.max(maxWidth, room.x + room.width);
      maxHeight = Math.max(maxHeight, room.y + room.height);
    }

    return {
      x: 1,
      y: 1,
      width: maxWidth + 1,
      height: maxHeight + 1,
      name: rootName,
      files: [],
      children,
      depth: -1,
      floorStyle: 'wood',
    };
  };

  // Center of the first room of the layout, in pixels; falls back to layout center.
  const layoutSpawnPoint = (layout: RoomLayout): { x: number; y: number } => {
    const first = layout.children[0];
    if (first) {
      return {
        x: (first.x + first.width / 2) * TILE_SIZE,
        y: (first.y + first.height / 2) * TILE_SIZE,
      };
    }
    return { x: (layout.x + layout.width / 2) * TILE_SIZE, y: (layout.y + layout.height / 2) * TILE_SIZE };
  };

  // Draw wall art/posters based on room type
  const drawWallArt = (ctx: CanvasRenderingContext2D, room: RoomLayout) => {
    const px = room.x * TILE_SIZE;
    const py = room.y * TILE_SIZE;
    const w = room.width * TILE_SIZE;
    const wallH = 16;
    const seed = room.x * 73 + room.y * 137;
    if (room.width < 8) return;
    const roomName = room.name.toLowerCase();
    let artType: 'technical' | 'colorful' | 'corporate' | 'minimal' = 'minimal';
    if (roomName.includes('server') || roomName.includes('api')) artType = 'technical';
    else if (roomName.includes('component') || roomName.includes('ui')) artType = 'colorful';
    else if (room.depth === 0) artType = 'corporate';
    const artX = px + 12 + seededRandom(seed + 50) * 20;
    const artY = py - wallH + 2;
    if (artType === 'technical') {
      ctx.fillStyle = '#404040';
      ctx.fillRect(artX - 1, artY - 1, 18, 14);
      ctx.fillStyle = '#F0F0E8';
      ctx.fillRect(artX, artY, 16, 12);
      ctx.strokeStyle = '#C0C0B8';
      ctx.lineWidth = 1;
      for (let gx = 0; gx < 16; gx += 4) {
        ctx.beginPath();
        ctx.moveTo(artX + gx, artY);
        ctx.lineTo(artX + gx, artY + 12);
        ctx.stroke();
      }
      ctx.fillStyle = '#E8A830';
      ctx.fillRect(artX, artY + 10, 16, 2);
    } else if (artType === 'colorful') {
      ctx.fillStyle = '#303030';
      ctx.fillRect(artX - 1, artY - 1, 14, 14);
      ['#E85050', '#50A8E8', '#E8C850', '#50C878'].forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(artX + (i % 2) * 6, artY + Math.floor(i / 2) * 6, 6, 6);
      });
    } else if (artType === 'corporate') {
      const clockX = px + w - 30;
      const clockY = py - wallH + 3;
      ctx.fillStyle = '#F8F8F0';
      ctx.beginPath();
      ctx.arc(clockX, clockY + 5, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#8B7355';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = '#404040';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(clockX, clockY + 5);
      ctx.lineTo(clockX + 3, clockY + 3);
      ctx.moveTo(clockX, clockY + 5);
      ctx.lineTo(clockX, clockY + 2);
      ctx.stroke();
      ctx.fillStyle = '#606060';
      ctx.fillRect(artX - 1, artY - 1, 14, 12);
      ctx.fillStyle = '#4080C0';
      ctx.fillRect(artX, artY, 12, 10);
      ctx.fillStyle = '#F8F8F0';
      ctx.fillRect(artX + 3, artY + 3, 6, 4);
    }
    ctx.lineWidth = 1;
  };

  // Draw door frames where child rooms connect
  const drawDoorFrames = (ctx: CanvasRenderingContext2D, room: RoomLayout) => {
    room.children.forEach(child => {
      const gapX = child.x * TILE_SIZE + (child.width * TILE_SIZE) / 2 - 12;
      const gapY = child.y * TILE_SIZE - 4;
      ctx.fillStyle = '#D4C4A8';
      ctx.fillRect(gapX, gapY, 24, 6);
    });
  };

  // Get room furniture density based on importance
  const getRoomDensity = (room: RoomLayout): 'low' | 'medium' | 'medium-high' | 'high' => {
    const name = room.name.toLowerCase();
    if (name.includes('client') || name.includes('app')) return 'high';
    if (name.includes('component') || name.includes('ui')) return 'medium-high';
    if (name.includes('server') || name.includes('api')) return 'medium';
    if (name.includes('hook') || name.includes('util')) return 'low';
    return room.depth === 0 ? 'medium' : 'medium';
  };

  // Static structures only (floors, walls, windows, fixtures, wall art, rug,
  // scatter, cables, door frames). These are deterministic — no `now`/`frame`
  // dependency — so they are what gets pre-rendered into the offscreen cache.
  // Rooms are spatially disjoint siblings under the root (see buildFloorsByDepth
  // → children: []), so painting all statics before any dynamics never inverts
  // z-order between rooms.
  const drawRoomStatic = (ctx: CanvasRenderingContext2D, room: RoomLayout) => {
    drawFloor(ctx, room);
    drawFloorVents(ctx, room);
    drawCableRuns(ctx, room);
    drawRoomLighting(ctx, room);
    drawWalls(ctx, room);
    drawWindows(ctx, room);
    drawLightFixtures(ctx, room);
    drawWallArt(ctx, room);
    drawRug(ctx, room);
    drawScatter(ctx, room, getRoomDensity(room));
    room.children.forEach(child => drawRoomStatic(ctx, child));
    drawDoorFrames(ctx, room);
  };

  // Per-frame room content drawn on top of the blitted static cache: themed
  // decorations (animated), desks + labels (screens flash on activity) and the
  // room activity pulse. Drawn in the same relative order as the original
  // structure pass (decorations under desks, pulse over both).
  const drawRoomDynamic = (ctx: CanvasRenderingContext2D, room: RoomLayout, now: number, frame: number) => {
    drawRoomThemedDecorations(ctx, room, frame);

    room.files.forEach(file => {
      drawDesk(ctx, file, now, frame, screenFlashesRef.current);
      drawLabel(ctx, file);
    });

    // Room activity pulse - glow effect for recently active rooms
    const lastActivity = roomActivityRef.current.get(room.name);
    if (lastActivity) {
      const timeSince = now - lastActivity;
      const pulseDuration = 3000;  // Pulse fades over 3 seconds
      if (timeSince < pulseDuration) {
        const pulseProgress = timeSince / pulseDuration;
        const pulseAlpha = (1 - pulseProgress) * 0.15;
        const pulsePhase = Math.sin(frame * 0.1) * 0.5 + 0.5;  // Oscillating pulse
        const finalAlpha = pulseAlpha * (0.7 + pulsePhase * 0.3);

        const px = room.x * TILE_SIZE;
        const py = room.y * TILE_SIZE;
        const pw = room.width * TILE_SIZE;
        const ph = room.height * TILE_SIZE;

        ctx.fillStyle = `rgba(100, 200, 255, ${finalAlpha})`;
        ctx.fillRect(px, py, pw, ph);
      }
    }

    room.children.forEach(child => drawRoomDynamic(ctx, child, now, frame));
  };

  // Draw all room signs (separate pass so they render on top of all floors)
  const drawAllRoomSigns = (ctx: CanvasRenderingContext2D, room: RoomLayout) => {
    drawRoomSign(ctx, room);
    room.children.forEach(child => drawAllRoomSigns(ctx, child));
  };

  // Pre-render the static layer into an offscreen canvas sized to the layout
  // bounding box (plus a margin for wall overhang). Returns null when the scene
  // is pathologically large (beyond the canvas dimension cap) so the caller can
  // fall back to direct drawing. World→offscreen mapping is a single translate.
  const buildStaticCache = (layout: RoomLayout): HTMLCanvasElement | null => {
    const MARGIN = 40; // px, covers walls drawn outside the room rect
    const MAX_DIM = 16384; // conservative canvas side cap
    const originX = layout.x * TILE_SIZE - MARGIN;
    const originY = layout.y * TILE_SIZE - MARGIN;
    const w = Math.ceil(layout.width * TILE_SIZE + MARGIN * 2);
    const h = Math.ceil(layout.height * TILE_SIZE + MARGIN * 2);
    if (w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM) return null;

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const offCtx = off.getContext('2d');
    if (!offCtx) return null;

    offCtx.translate(-originX, -originY);
    drawRoomStatic(offCtx, layout);
    staticCacheOriginRef.current = { x: originX, y: originY };
    return off;
  };

  // Draw a complete room: blit the cached static layer, then the per-frame
  // dynamic content, then signs on top (matching the original z-order).
  const drawRoom = (ctx: CanvasRenderingContext2D, room: RoomLayout, now: number, frame: number) => {
    if (!staticCacheBuiltRef.current) {
      staticCacheRef.current = buildStaticCache(room);
      staticCacheBuiltRef.current = true;
    }

    const cache = staticCacheRef.current;
    if (cache) {
      const prevSmoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false; // keep pixel art crisp when zoomed
      ctx.drawImage(cache, staticCacheOriginRef.current.x, staticCacheOriginRef.current.y);
      ctx.imageSmoothingEnabled = prevSmoothing;
    } else {
      // Oversized scene or no 2D context: draw statics directly this frame.
      drawRoomStatic(ctx, room);
    }

    drawRoomDynamic(ctx, room, now, frame);
    drawAllRoomSigns(ctx, room);
  };

  // Animation loop - ALL logic runs here, no useEffects that trigger re-renders
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    // Fetch hot folders - includes git history + live activity
    const fetchHotFolders = () => {
      const projectQuery = projectId ? `&projectId=${encodeURIComponent(projectId)}` : '';
      fetch(`${API_URL}/hot-folders?limit=${HOT_FOLDERS_LIMIT}${projectQuery}`)
        .then(res => res.json())
        .then((data: FolderScore[]) => {
          // Check if data actually changed to avoid unnecessary rebuilds
          const oldJson = JSON.stringify(hotFoldersRef.current.map(f => ({ folder: f.folder, files: f.recentFiles })));
          const newJson = JSON.stringify(data.map(f => ({ folder: f.folder, files: f.recentFiles })));
          if (oldJson !== newJson) {
            hotFoldersRef.current = data;
            layoutRef.current = null;  // Force layout rebuild
            layoutInitializedRef.current = false;
          }
        })
        .catch(err => console.error('Failed to fetch hot folders:', err));
    };

    // Fetch on mount
    fetchHotFolders();

    // Refresh every 5 seconds to pick up live file activity
    const hotFoldersInterval = setInterval(fetchHotFolders, 5000);

    let running = true;
    let frame = 0;

    const render = () => {
      if (!running) return;
      const now = performance.now();
      frame++;

      // Rebuild the layout when nodes change OR the displayed floor changes.
      // Reads graphDataRef/snapshotRef directly so it is correct from any
      // call site within the frame (single source of rebuild logic).
      const ensureLayoutForCurrentFloor = () => {
        const graphData = graphDataRef.current;
        const nodeCount = graphData.nodes.length;
        const cur = nav.snapshotRef.current.currentFloorIndex;
        if (
          nodeCount !== lastNodeCountRef.current ||
          !layoutRef.current ||
          cur !== lastRenderedFloorRef.current
        ) {
          lastNodeCountRef.current = nodeCount;
          lastRenderedFloorRef.current = cur;
          layoutRef.current = buildLayout(graphData.nodes);
          // Structures changed → the static cache must be re-rendered.
          staticCacheBuiltRef.current = false;

          // buildLayout just repopulated floorsRef; surface the floor set into
          // React state when it actually changed, so the nav bar re-renders.
          const nextFloors = floorNumbers(floorsRef.current);
          const prevFloors = availableFloorsRef.current;
          if (
            nextFloors.length !== prevFloors.length ||
            nextFloors.some((v, i) => v !== prevFloors[i])
          ) {
            availableFloorsRef.current = nextFloors;
            setAvailableFloors(nextFloors);
          }

          const projectRoot = graphData.nodes.find(n => n.depth === -1)?.id || null;
          if (projectRoot !== lastProjectRootRef.current) {
            lastProjectRootRef.current = projectRoot;
            layoutInitializedRef.current = false;
          }
        }
      };

      // FPS is measured per actual draw (after the throttle gate below), not per
      // rAF callback, so the on-screen metric reflects the real repaint cadence.

      // Arrow key panning (smooth, runs every frame)
      const panSpeed = 8;
      const keys = keysDownRef.current;
      if (keys.has('ArrowLeft')) panRef.current.x += panSpeed;
      if (keys.has('ArrowRight')) panRef.current.x -= panSpeed;
      if (keys.has('ArrowUp')) panRef.current.y += panSpeed;
      if (keys.has('ArrowDown')) panRef.current.y -= panSpeed;

      // === CHECK FOR LAYOUT UPDATE (git commit) ===
      if (layoutVersionRef.current !== lastLayoutVersionRef.current) {
        lastLayoutVersionRef.current = layoutVersionRef.current;
        console.log('Git commit detected - refreshing layout');
        fetchHotFolders();
      }

      // Re-render the chat panel when a new chat line arrives (data is in a ref).
      if (chatVersionRef.current !== lastChatVersionRef.current) {
        lastChatVersionRef.current = chatVersionRef.current;
        setChatTick(t => t + 1);
      }

      // === SYNC AGENTS (replaces useEffect) ===
      if (thinkingVersionRef.current !== lastThinkingVersionRef.current) {
        lastThinkingVersionRef.current = thinkingVersionRef.current;
        const agents = agentCharactersRef.current;
        // When scoped to a building, only materialize that project's agents.
        const thinkingAgents = projectId
          ? thinkingAgentsRef.current.filter(a => a.projectId === projectId)
          : thinkingAgentsRef.current;

        // CLIENT-SIDE PROTECTION: Hard limit on agents
        const MAX_CLIENT_AGENTS = 10;

        // CLIENT-SIDE PROTECTION: Validate agent ID format (must be UUID)
        const isValidAgentId = (id: string): boolean => {
          if (!id || typeof id !== 'string') return false;
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          return uuidRegex.test(id);
        };

        // Filter to only valid agents
        const validAgents = thinkingAgents.filter(a => isValidAgentId(a.agentId));

        // Add new agents or update existing ones
        for (const agent of validAgents) {
          // Skip if we're at max capacity and this is a new agent
          if (agents.size >= MAX_CLIENT_AGENTS && !agents.has(agent.agentId)) {
            console.warn(`Client: Rejecting agent ${agent.agentId} - at max capacity`);
            continue;
          }

          const existing = agents.get(agent.agentId);
          if (existing) {
            existing.currentCommand = agent.currentCommand;
            existing.toolInput = agent.toolInput;
            existing.question = agent.question;
            existing.currentFile = agent.currentFile;
            existing.displayName = agent.displayName;
            existing.lastActivity = agent.lastActivity;
            existing.lastSeen = now;  // Mark as seen
            existing.isThinking = agent.isThinking;
            // Cursor-specific fields
            existing.model = agent.model;
            existing.lastDuration = agent.lastDuration;
            existing.status = agent.status;
            existing.statusTimestamp = agent.statusTimestamp;
            // Play sound when agent starts waiting for input
            const newWaitingState = agent.waitingForInput ?? false;
            if (newWaitingState && !existing.waitingForInput) {
              playWaitingSound();
            }
            existing.waitingForInput = newWaitingState;
          } else {
            const index = agents.size;
            const layout = layoutRef.current;
            const colorIndex = agentColorCounterRef.current++;
            let baseX: number, baseY: number;
            let spawnedAtFile = false;

            const lastActivity = lastActivityByAgentRef.current.get(agent.agentId);
            if (lastActivity && Date.now() - lastActivity.timestamp < 5000) {
              const filePos = filePositionsRef.current.get(lastActivity.filePath);
              if (filePos) {
                const xOffset = ((colorIndex % 3) - 1) * 10;
                const yOffset = Math.floor(colorIndex / 3) * 8;
                baseX = filePos.x + xOffset;
                baseY = filePos.y - 28 + yOffset;
                spawnedAtFile = true;
              }
            }

            if (!spawnedAtFile) {
              if (layout) {
                const spawn = layoutSpawnPoint(layout);
                baseX = spawn.x + ((index % 4) * 2 - 2) * TILE_SIZE;
                baseY = spawn.y + (-Math.floor(index / 4) * 2) * TILE_SIZE;
              } else {
                baseX = 300 + (index % 4) * 50;
                baseY = 400 + Math.floor(index / 4) * 50;
              }
            }

            agents.set(agent.agentId, {
              agentId: agent.agentId,
              displayName: agent.displayName,
              x: baseX!,
              y: baseY!,
              targetX: baseX!,
              targetY: baseY!,
              isMoving: false,
              frame: 0,
              colorIndex,
              currentCommand: agent.currentCommand,
              toolInput: agent.toolInput,
              question: agent.question,
              currentFile: agent.currentFile,
              waitingForInput: agent.waitingForInput ?? false,
              lastActivity: agent.lastActivity,
              lastSeen: now,
              isThinking: agent.isThinking,
              // Cursor-specific fields
              model: agent.model,
              lastDuration: agent.lastDuration,
              status: agent.status,
              statusTimestamp: agent.statusTimestamp,
            });
          }
        }

        // Seed each located agent's floor from its server-authoritative currentFile.
        // agentFloorsRef is a pure projection of currentFile, so selecting an agent
        // (roster/focus) jumps to the right floor even right after mount, before any
        // live activity arrives. Bash-only agents (no currentFile) keep no entry and
        // stay on the current floor when selected — the best we can know about them.
        for (const agent of validAgents) {
          if (agent.currentFile) {
            nav.agentFloorsRef.current.set(agent.agentId, findFloorForFile(agent.currentFile));
          }
        }

        // Gore: an explicitly killed agent bursts into red particles at its last
        // spot, then its character is removed immediately (no grace wait).
        if (killedAgentsRef.current.size) {
          const blood = bloodParticlesRef.current;
          for (const id of killedAgentsRef.current) {
            const victim = agents.get(id);
            if (!victim) continue;
            for (let i = 0; i < 24; i++) {
              const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.7;
              const speed = 2 + Math.random() * 4.5;
              blood.push({
                x: victim.x, y: victim.y - 8,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: 2 + Math.random() * 3,
                color: BLOOD_COLORS[Math.floor(Math.random() * BLOOD_COLORS.length)],
                bornAt: now,
              });
            }
            agents.delete(id);
            // killAgent (not removeAgent) releases the camera in place so the
            // death animation stays in view instead of hopping to another agent.
            nav.killAgent(id);
            // The chat panel (now hoisted into ChatProvider) stays open and flips
            // to its "dead" state via the terminal system line, so the transcript
            // remains readable instead of vanishing on kill.
          }
          killedAgentsRef.current.clear();
        }

        // Remove agents only after grace period (30 seconds of not being seen)
        // This prevents flicker from brief network issues or timing gaps
        const AGENT_GRACE_PERIOD_MS = 30000;
        for (const [id, agent] of agents) {
          if (now - agent.lastSeen > AGENT_GRACE_PERIOD_MS) {
            console.log(`Removing agent ${agent.displayName} after ${AGENT_GRACE_PERIOD_MS / 1000}s grace period`);
            agents.delete(id);
            nav.removeAgent(id);
          }
        }

        // Detect Bash command starts and flash all screens white
        for (const agent of validAgents) {
          const prevCommand = prevAgentCommandsRef.current.get(agent.agentId);
          const currCommand = agent.currentCommand;

          // If command just changed TO Bash, flash all screens
          if (currCommand === 'Bash' && prevCommand !== 'Bash' && agent.isThinking) {
            for (const fileId of filePositionsRef.current.keys()) {
              screenFlashesRef.current.set(fileId, {
                type: 'bash',
                startTime: now
              });
            }
          }

          prevAgentCommandsRef.current.set(agent.agentId, currCommand);
        }
      }

      // === HANDLE ACTIVITY (replaces useEffect) ===
      if (activityVersionRef.current !== lastActivityVersionRef.current) {
        lastActivityVersionRef.current = activityVersionRef.current;
        const recentActivity = recentActivityRef.current;

        if (recentActivity) {
          // Find matching file in layout (handles absolute vs relative path mismatch)
          const knownFileIds = Array.from(filePositionsRef.current.keys());
          const matchingFileId = findMatchingFileId(recentActivity.filePath, knownFileIds);

          // Handle screen flashes for operation end events
          if (recentActivity.type === 'read-end') {
            if (matchingFileId) {
              screenFlashesRef.current.set(matchingFileId, {
                type: 'read',
                startTime: now
              });
            }
            playReadSound();
          }
          if (recentActivity.type === 'write-end') {
            if (matchingFileId) {
              screenFlashesRef.current.set(matchingFileId, {
                type: 'write',
                startTime: now
              });
            }
            playWriteSound();
          }

          // Handle search flashes - pattern format is "searchPath:pattern"
          if (recentActivity.type === 'search-end') {
            const colonIndex = recentActivity.filePath.indexOf(':');
            if (colonIndex > 0) {
              const searchPath = recentActivity.filePath.slice(0, colonIndex);
              const pattern = recentActivity.filePath.slice(colonIndex + 1);

              // Determine if this is a glob pattern (filename match) or content search
              const isGlobPattern = pattern.includes('*') || pattern.includes('?');

              // Hoist invariants out of the per-file loop: the normalized search
              // path and the glob→regex depend only on the search query, not on
              // the file being tested. Compiling the regex once (instead of once
              // per file) keeps search-end O(files) instead of O(files × regex).
              const normalizedSearchPath = searchPath.replace(/^\.\//, '');
              let globRegex: RegExp | null = null;
              if (isGlobPattern) {
                try {
                  const regexPattern = pattern
                    .replace(/\*\*/g, '.*')
                    .replace(/\*/g, '[^/]*')
                    .replace(/\?/g, '.');
                  globRegex = new RegExp(regexPattern, 'i');
                } catch {
                  globRegex = null; // Invalid pattern → matches nothing
                }
              }

              // Flash all files in the search path
              for (const fileId of filePositionsRef.current.keys()) {
                // Check if file is in the search path
                const inSearchPath = searchPath === '.' ||
                                     searchPath === '' ||
                                     normalizedSearchPath === '' ||
                                     fileId.startsWith(normalizedSearchPath + '/') ||
                                     fileId.startsWith(normalizedSearchPath);

                if (inSearchPath) {
                  // For glob patterns, also check if filename matches
                  if (isGlobPattern) {
                    if (!globRegex) continue;
                    const fileName = fileId.split('/').pop() || fileId;
                    if (globRegex.test(fileName) || globRegex.test(fileId)) {
                      screenFlashesRef.current.set(fileId, {
                        type: 'search',
                        startTime: now
                      });
                    }
                  } else {
                    // Content search (Grep) - flash all files in path
                    screenFlashesRef.current.set(fileId, {
                      type: 'search',
                      startTime: now
                    });
                  }
                }
              }
            }
          }

          // Move agents on ALL activity events (both start and end)
          // This ensures agents run to files on reads AND writes
          const agentId = recentActivity.agentId;
          if (agentId) {
            lastActivityByAgentRef.current.set(agentId, {
              filePath: recentActivity.filePath,
              timestamp: Date.now()
            });
            nav.noteAgentActivity(agentId, findFloorForFile(recentActivity.filePath));

            // The activity may have switched the active floor (follow mode).
            // Rebuild now so filePositionsRef reflects the new floor BEFORE
            // we compute this agent's target below.
            ensureLayoutForCurrentFloor();

            // Resolve the desk AGAINST the floor we just rebuilt. follow mode may
            // have switched floors right above, so the matchingFileId computed
            // earlier (against the previous floor) can be stale — reusing it would
            // miss and drop the agent at the room centre via the folder fallback.
            // Recomputing here lets the agent reach the exact desk cross-floor.
            let filePos: { x: number; y: number } | undefined;

            const targetFileId = findMatchingFileId(
              recentActivity.filePath,
              Array.from(filePositionsRef.current.keys())
            );
            if (targetFileId) {
              filePos = filePositionsRef.current.get(targetFileId);
            }

            // Fall back to folder-based routing if file not in layout
            if (!filePos) {
              const pathParts = recentActivity.filePath.split('/');
              pathParts.pop(); // Remove filename
              while (pathParts.length > 0 && !filePos) {
                const folderPath = pathParts.join('/') || '.';
                filePos = filePositionsRef.current.get(folderPath);
                if (!filePos) pathParts.pop();
              }
              // Try root folder
              if (!filePos) filePos = filePositionsRef.current.get('.');
            }

            // Get character and update its activity timestamp + target
            const char = agentCharactersRef.current.get(agentId);
            if (char) {
              // Update last activity to prevent premature return to coffee shop
              char.lastActivity = Date.now();

              if (filePos) {
                const xOffset = ((char.colorIndex % 3) - 1) * 10;
                const yOffset = Math.floor(char.colorIndex / 3) * 8;
                char.targetX = filePos.x + xOffset;
                char.targetY = filePos.y - 28 + yOffset;
                char.isMoving = true;
              }
            }
          }

          // Track room activity for pulse effect
          const filePath = recentActivity.filePath;
          const pathParts = filePath.split('/');
          // Get parent folder name (second to last part of path)
          if (pathParts.length >= 2) {
            const folderName = pathParts[pathParts.length - 2];
            roomActivityRef.current.set(folderName, now);
          }
        }
      }

      // Update all agent characters - frame and movement
      const MOVE_SPEED = 6;
      for (const [, char] of agentCharactersRef.current) {
        char.frame = frame;

        // Freeze off-floor agents: skip movement/idle retargeting so they
        // don't drift or get pulled to the current floor's coffee shop.
        const agentFloor = nav.agentFloorsRef.current.get(char.agentId);
        if (agentFloor !== undefined && agentFloor !== nav.snapshotRef.current.currentFloorIndex) {
          continue;
        }

        // Check if agent should go to coffee shop (inactive for 30+ seconds)
        const timeSinceActivity = Date.now() - char.lastActivity;

        const shouldGoToCoffeeShop = timeSinceActivity > 30000 && !char.isThinking && !char.waitingForInput;

        // Set target to coffee shop if inactive
        if (shouldGoToCoffeeShop && coffeeShopPosRef.current.x !== 0) {
          const coffeeOffsetX = (char.colorIndex % 3 - 1) * 20;
          const coffeeOffsetY = Math.floor(char.colorIndex / 3) * 15;
          const coffeeX = coffeeShopPosRef.current.x + coffeeOffsetX;
          const coffeeY = coffeeShopPosRef.current.y + coffeeOffsetY;

          if (Math.abs(char.targetX - coffeeX) > 5 || Math.abs(char.targetY - coffeeY) > 5) {
            char.targetX = coffeeX;
            char.targetY = coffeeY;
          }
        }

        // Grid-based movement
        const dx = char.targetX - char.x;
        const dy = char.targetY - char.y;

        if (Math.abs(dx) > MOVE_SPEED || Math.abs(dy) > MOVE_SPEED) {
          char.isMoving = true;

          // Record trail footprint every ~20 pixels of movement
          const lastPos = lastTrailPosRef.current.get(char.agentId);
          if (!lastPos || Math.abs(char.x - lastPos.x) > 20 || Math.abs(char.y - lastPos.y) > 20) {
            agentTrailsRef.current.push({
              x: char.x, y: char.y, timestamp: now, colorIndex: char.colorIndex
            });
            lastTrailPosRef.current.set(char.agentId, { x: char.x, y: char.y });
            // Keep only last 100 footprints
            if (agentTrailsRef.current.length > 100) {
              agentTrailsRef.current = agentTrailsRef.current.slice(-100);
            }
          }

          if (Math.abs(dx) > MOVE_SPEED) {
            char.x += dx > 0 ? MOVE_SPEED : -MOVE_SPEED;
          } else if (Math.abs(dy) > MOVE_SPEED) {
            char.y += dy > 0 ? MOVE_SPEED : -MOVE_SPEED;
          }
        } else if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          char.x = char.targetX;
          char.y = char.targetY;
          char.isMoving = false;
        } else {
          char.isMoving = false;
        }

        // Only show idle/sleep animation when at coffee shop (not moving)
        char.isIdle = shouldGoToCoffeeShop && !char.isMoving;
      }

      // Rebuild layout if nodes or displayed floor changed (top-of-frame site)
      ensureLayoutForCurrentFloor();

      // The full-scene repaint below runs on every rAF tick — the browser caps
      // this at the display's native refresh rate, so there is no manual frame
      // throttle. Update the FPS metric from the real inter-draw interval.
      if (lastDrawTimeRef.current > 0) {
        frameTimesRef.current.push(now - lastDrawTimeRef.current);
        if (frameTimesRef.current.length > 60) frameTimesRef.current.shift();
        const avgFrameTime = frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length;
        fpsRef.current = Math.round(1000 / avgFrameTime);
      }
      lastDrawTimeRef.current = now;

      // Draw sky background
      ctx.fillStyle = '#C8E8F8';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const layout = layoutRef.current;
      if (layout) {
        const hotelW = layout.width * TILE_SIZE;
        const hotelH = layout.height * TILE_SIZE;

        const borderSize = 4;
        const waterWidth = 6;
        const totalSceneW = hotelW + (borderSize * 2 + waterWidth) * TILE_SIZE;
        const totalSceneH = hotelH + borderSize * 2 * TILE_SIZE;

        const baseOffsetX = (canvas.width - totalSceneW) / 2 + borderSize * TILE_SIZE;
        const baseOffsetY = (canvas.height - totalSceneH) / 2 + borderSize * TILE_SIZE;

        // Store base offsets for click detection
        baseOffsetsRef.current = {
          x: baseOffsetX - layout.x * TILE_SIZE,
          y: baseOffsetY - layout.y * TILE_SIZE
        };

        // Apply zoom (centered on canvas) and pan transforms
        const zoom = zoomRef.current;
        const pan = panRef.current;
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;

        // Apply a pending external focus request once that agent exists on the
        // canvas. selectAgent picks its floor (and sets follow=true, so the view
        // catches up to the agent's floor on its next activity); tracking then
        // centers/zooms the camera.
        if (pendingFocusRef.current) {
          const focusId = resolveFocus(pendingFocusRef.current, new Set(agentCharactersRef.current.keys()));
          if (focusId) {
            nav.selectAgent(focusId);
            trackedAgentIdRef.current = focusId;
            pendingFocusRef.current = null;
          }
        }

        // Agent tracking mode - smoothly follow the tracked agent
        if (trackedAgentIdRef.current) {
          const trackedAgent = agentCharactersRef.current.get(trackedAgentIdRef.current);
          if (trackedAgent) {
            // A newly selected agent re-arms the one-shot zoom snap.
            if (lastTrackedRef.current !== trackedAgentIdRef.current) {
              lastTrackedRef.current = trackedAgentIdRef.current;
              trackingZoomDoneRef.current = false;
            }

            // Snap zoom toward trackingZoom ONCE; afterwards the user is free to
            // zoom in/out (wheel/keys set trackingZoomDoneRef to take control).
            if (!trackingZoomDoneRef.current) {
              const zoomDiff = trackingZoom - zoomRef.current;
              if (Math.abs(zoomDiff) > 0.01) {
                zoomRef.current += zoomDiff * 0.1;
              } else {
                zoomRef.current = trackingZoom;
                trackingZoomDoneRef.current = true;
              }
            }

            // To center agent on screen, we need:
            // screenCenter = (agentPos + baseOffsets - canvasCenter + pan) * zoom + canvasCenter
            // Solving for pan when screenCenter = canvasCenter:
            // 0 = (agentPos + baseOffsets - canvasCenter + pan) * zoom
            // pan = canvasCenter - agentPos - baseOffsets
            const targetPanX = centerX - trackedAgent.x - baseOffsetsRef.current.x;
            const targetPanY = centerY - trackedAgent.y - baseOffsetsRef.current.y;

            // Smooth pan towards target
            panRef.current.x += (targetPanX - panRef.current.x) * 0.08;
            panRef.current.y += (targetPanY - panRef.current.y) * 0.08;
          } else {
            // Tracked agent no longer exists, exit tracking mode
            trackedAgentIdRef.current = null;
          }
        } else {
          lastTrackedRef.current = null;
        }

        ctx.save();
        // Translate to center, scale, translate back - this zooms from center
        ctx.translate(centerX, centerY);
        ctx.scale(zoom, zoom);
        ctx.translate(-centerX + pan.x, -centerY + pan.y);
        // Apply the base offset to position the hotel
        ctx.translate(baseOffsetX - layout.x * TILE_SIZE, baseOffsetY - layout.y * TILE_SIZE);

        const hotelPxX = layout.x * TILE_SIZE;
        const hotelPxY = layout.y * TILE_SIZE;

        // Update coffee shop position for idle agents (right side near the cafe table)
        coffeeShopPosRef.current = {
          x: hotelPxX + hotelW * 0.68 + 100,  // Right side, near cafe table
          y: hotelPxY + hotelH * 0.84 + 25,
        };

        // Draw outdoor environment
        drawOutdoor(ctx, hotelPxX, hotelPxY, hotelW, hotelH, frame);

        // Initialize or reposition agents - NEVER teleport, only update target
        if (agentCharactersRef.current.size > 0) {
          let index = 0;
          for (const [, char] of agentCharactersRef.current) {
            const spawn = layoutSpawnPoint(layout);
            const lobbyX = spawn.x + ((index % 4) * 2 - 2) * TILE_SIZE;
            const lobbyY = spawn.y + (-Math.floor(index / 4) * 2) * TILE_SIZE;

            // Check if agent has never been positioned (new agent or first layout)
            const isUninitialized = char.x === 0 && char.y === 0 && !char.isMoving;

            // Check if agent is way outside bounds (safety check for broken positions)
            const isOutsideBounds = char.x < hotelPxX - TILE_SIZE * 10 ||
                                   char.x > hotelPxX + hotelW + TILE_SIZE * 10 ||
                                   char.y < hotelPxY - TILE_SIZE * 10 ||
                                   char.y > hotelPxY + hotelH + TILE_SIZE * 10;

            if (isUninitialized) {
              // Only teleport brand new agents to lobby
              char.x = lobbyX;
              char.y = lobbyY;
              char.targetX = lobbyX;
              char.targetY = lobbyY;
              char.isMoving = false;
            } else if (!layoutInitializedRef.current || isOutsideBounds) {
              // Layout changed or agent out of bounds - walk to lobby, don't teleport
              char.targetX = lobbyX;
              char.targetY = lobbyY;
              char.isMoving = true;
            }
            index++;
          }
          layoutInitializedRef.current = true;
        }

        // Draw hotel rooms
        drawRoom(ctx, layout, now, frame);

        // Draw coffee shop
        drawCoffeeShop(ctx, layout, hotelPxX, hotelPxY, hotelW, hotelH);

        // Draw agent trails (fading footprints)
        const trailMaxAge = 5000;  // Trails fade over 5 seconds
        const trails = agentTrailsRef.current;
        for (let i = trails.length - 1; i >= 0; i--) {
          const trail = trails[i];
          const age = now - trail.timestamp;
          if (age > trailMaxAge) {
            trails.splice(i, 1);  // Remove old trails
            continue;
          }
          const alpha = 0.3 * (1 - age / trailMaxAge);
          const palette = ['#C83030', '#3070C8', '#30A830', '#C8C8C8', '#D8A010'];
          const color = palette[trail.colorIndex % palette.length];
          ctx.fillStyle = color;
          ctx.globalAlpha = alpha;
          // Draw small footprint dots
          ctx.beginPath();
          ctx.ellipse(trail.x - 3, trail.y + 4, 3, 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.ellipse(trail.x + 3, trail.y + 4, 3, 2, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        // Draw all agent characters (only those on the current floor)
        for (const [, char] of agentCharactersRef.current) {
          const agentFloor = nav.agentFloorsRef.current.get(char.agentId);
          if (agentFloor !== undefined && agentFloor !== nav.snapshotRef.current.currentFloorIndex) {
            continue;
          }
          drawAgentCharacter(ctx, char);
        }

        // Blood splatter from killed agents — advance physics + draw on top.
        const blood = bloodParticlesRef.current;
        if (blood.length) {
          const survivors: typeof blood = [];
          for (const p of blood) {
            const age = now - p.bornAt;
            if (age > BLOOD_LIFESPAN_MS) continue;
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.45;   // gravity
            p.vx *= 0.98;   // air drag
            survivors.push(p);
            ctx.globalAlpha = Math.max(0, 1 - age / BLOOD_LIFESPAN_MS);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          bloodParticlesRef.current = survivors;
        }

        ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for file activity...', canvas.width / 2 + 1, canvas.height / 2 + 1);
        ctx.fillStyle = '#6A7A8A';
        ctx.fillText('Waiting for file activity...', canvas.width / 2, canvas.height / 2);
      }

      // Draw performance metrics in top left
      const fps = fpsRef.current;
      const avgFrameTime = frameTimesRef.current.length > 0
        ? (frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length).toFixed(1)
        : '0.0';
      const agentCount = agentCharactersRef.current.size;
      const roomCount = layoutRef.current?.children?.length ?? 0;

      const metricsX = 12;
      const metricsY = 92;

      // Background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(metricsX - 6, metricsY - 12, 130, 76);

      // Text
      ctx.fillStyle = fps >= 55 ? '#4ADE80' : fps >= 30 ? '#FACC15' : '#F87171';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`FPS: ${fps}`, metricsX, metricsY);

      ctx.fillStyle = '#E5E5E5';
      ctx.font = '10px monospace';
      ctx.fillText(`Frame: ${avgFrameTime}ms`, metricsX, metricsY + 14);
      ctx.fillText(`Agents: ${agentCount}`, metricsX, metricsY + 28);
      ctx.fillText(`Rooms: ${roomCount}`, metricsX, metricsY + 42);

      // Connection status
      const connStatus = connectionStatusRef.current;
      const connColor = connStatus === 'connected' ? '#4ADE80' :
                        connStatus === 'connecting' ? '#FACC15' : '#F87171';
      ctx.fillStyle = connColor;
      ctx.fillText(`● ${connStatus}`, metricsX, metricsY + 56);


      // Draw zoom indicator when zoomed or panned (below stats panel on left)
      const zoom = zoomRef.current;
      const pan = panRef.current;
      const hasPan = Math.abs(pan.x) > 1 || Math.abs(pan.y) > 1;
      if (zoom !== 1 || hasPan) {
        const indicatorX = metricsX;
        const indicatorY = metricsY + 74;

        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(indicatorX - 6, indicatorY - 4, 130, 36);

        // Zoom text
        ctx.fillStyle = '#E5E5E5';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`Zoom: ${Math.round(zoom * 100)}%`, indicatorX, indicatorY + 10);

        // Reset hint
        ctx.fillStyle = '#9CA3AF';
        ctx.font = '10px monospace';
        ctx.fillText('⌘0 reset', indicatorX, indicatorY + 24);
      }

      // Draw tracking indicator when following an agent
      if (trackedAgentIdRef.current) {
        const trackedAgent = agentCharactersRef.current.get(trackedAgentIdRef.current);
        if (trackedAgent) {
          const trackingY = canvas.height - 60;
          const trackingX = canvas.width / 2;

          // Background pill
          ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
          const pillWidth = 200;
          const pillHeight = 44;
          ctx.beginPath();
          ctx.roundRect(trackingX - pillWidth / 2, trackingY, pillWidth, pillHeight, 22);
          ctx.fill();

          // Pulsing border
          const pulseAlpha = 0.5 + Math.sin(frame * 0.1) * 0.3;
          ctx.strokeStyle = `rgba(74, 222, 128, ${pulseAlpha})`;
          ctx.lineWidth = 2;
          ctx.stroke();

          // Icon and text
          ctx.fillStyle = '#4ADE80';
          ctx.font = 'bold 13px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`👁 Tracking: ${trackedAgent.displayName}`, trackingX, trackingY + 18);

          ctx.fillStyle = '#9CA3AF';
          ctx.font = '10px monospace';
          ctx.fillText('Click elsewhere or ESC to exit', trackingX, trackingY + 34);
        }
      }

      animationRef.current = requestAnimationFrame(render);
    };

    const resize = () => {
      const parent = canvas.parentElement;
      canvas.width = parent ? parent.clientWidth : window.innerWidth;
      canvas.height = parent ? parent.clientHeight : window.innerHeight;
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener('resize', resize);

    // Zoom with mouse wheel (zooms toward mouse position)
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomSpeed = 0.1;
      const delta = e.deltaY > 0 ? -zoomSpeed : zoomSpeed;
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(0.5, Math.min(4, oldZoom + delta));

      if (newZoom !== oldZoom) {
        // Manual zoom takes control: stop the tracking snap from overriding it.
        trackingZoomDoneRef.current = true;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Convert mouse position to be relative to canvas center
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const mouseFromCenterX = mouseX - centerX;
        const mouseFromCenterY = mouseY - centerY;

        // Adjust pan to keep point under mouse stationary
        const zoomRatio = newZoom / oldZoom;
        panRef.current.x -= mouseFromCenterX * (zoomRatio - 1) / newZoom;
        panRef.current.y -= mouseFromCenterY * (zoomRatio - 1) / newZoom;

        zoomRef.current = newZoom;
      }
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    // Keyboard controls
    const handleKeyDown = (e: KeyboardEvent) => {
      // Zoom with Cmd/Ctrl + / -
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        trackingZoomDoneRef.current = true; // manual zoom takes control
        zoomRef.current = Math.min(4, zoomRef.current + 0.25);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault();
        trackingZoomDoneRef.current = true; // manual zoom takes control
        zoomRef.current = Math.max(0.5, zoomRef.current - 0.25);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault();
        zoomRef.current = 1;
        panRef.current = { x: 0, y: 0 };
        trackedAgentIdRef.current = null; // Also exit tracking mode on reset
      } else if (e.key === 'Escape') {
        // Exit agent tracking mode
        if (trackedAgentIdRef.current) {
          trackedAgentIdRef.current = null;
        }
      }
      // Track arrow keys for smooth panning
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        keysDownRef.current.add(e.key);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      keysDownRef.current.delete(e.key);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Drag to pan
    const handleMouseDown = (e: MouseEvent) => {
      initAudio(); // Initialize audio on first user interaction
      isDraggingRef.current = true;
      lastDragPosRef.current = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    };

    // Click to track agent
    let mouseDownPos = { x: 0, y: 0 };
    const handleMouseDownForClick = (e: MouseEvent) => {
      mouseDownPos = { x: e.clientX, y: e.clientY };
    };
    canvas.addEventListener('mousedown', handleMouseDownForClick);

    const handleClick = (e: MouseEvent) => {
      // Ignore if this was a drag (mouse moved significantly from mousedown)
      const dragThreshold = 10;
      const dragDist = Math.abs(e.clientX - mouseDownPos.x) + Math.abs(e.clientY - mouseDownPos.y);
      if (dragDist > dragThreshold) {
        return; // This was a drag, not a click
      }

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      // Convert screen coordinates to world coordinates
      const zoom = zoomRef.current;
      const pan = panRef.current;
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const baseOffsets = baseOffsetsRef.current;

      // Invert the transform chain:
      // Forward: world -> +baseOffsets -> +(-center+pan) -> *zoom -> +center = screen
      // Inverse: screen -> -center -> /zoom -> -(-center+pan) -> -baseOffsets = world
      const worldX = (screenX - centerX) / zoom + centerX - pan.x - baseOffsets.x;
      const worldY = (screenY - centerY) / zoom + centerY - pan.y - baseOffsets.y;

      // Check if click is on any agent (agents are ~30x50 pixels at scale 1.5)
      const agentHitRadius = 40; // Generous hit area for easier clicking
      let clickedAgentId: string | null = null;

      for (const [agentId, char] of agentCharactersRef.current) {
        const dx = worldX - char.x;
        const dy = worldY - (char.y - 20); // Offset for agent center (head area)
        const withinHead = Math.sqrt(dx * dx + dy * dy) < agentHitRadius;

        // Clicking the speech bubble counts as clicking the agent. bubbleBounds
        // is recorded in the same world space during draw.
        const b = char.bubbleBounds;
        const withinBubble = !!b &&
          worldX >= b.x && worldX <= b.x + b.w && worldY >= b.y && worldY <= b.y + b.h;

        if (withinHead || withinBubble) {
          clickedAgentId = agentId;
          break;
        }
      }

      if (clickedAgentId) {
        // Start tracking this agent
        trackedAgentIdRef.current = clickedAgentId;
        // Hotel-spawned agents are chattable: open their (server-seeded) panel.
        const clicked = thinkingAgentsRef.current.find(a => a.agentId === clickedAgentId);
        if (clicked?.spawned) openChat(clickedAgentId);
        // If it's waiting on the user, open its interaction modal (permission or
        // question — openInteractionFor decides from global state).
        const char = agentCharactersRef.current.get(clickedAgentId);
        if (char?.waitingForInput) openInteractionFor(clickedAgentId);
        return;
      }

      // No agent under the cursor → hit-test the desks (files). Agent always
      // wins, per the design: clicking an agent at its desk opens the chat,
      // not the file preview. The radius is roughly one tile; clicking on
      // empty floor closes nothing and does nothing.
      const DESK_HIT_RADIUS = 22;
      let bestFile: { path: string; dist: number } | null = null;
      for (const [id, pos] of filePositionsRef.current) {
        // Folder entries (room-level positions) are stored alongside files in
        // the same map; the server will 400 on directories, but we skip the
        // root marker '.' here so a click on empty room space does nothing.
        if (id === '.' || id.endsWith('/')) continue;
        const dx = worldX - pos.x;
        const dy = worldY - pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= DESK_HIT_RADIUS * DESK_HIT_RADIUS) {
          const dist = Math.sqrt(d2);
          if (!bestFile || dist < bestFile.dist) bestFile = { path: id, dist };
        }
      }
      if (bestFile) {
        setFilePreviewPath(bestFile.path);
        return;
      }

      if (trackedAgentIdRef.current) {
        // Clicked elsewhere while tracking - exit tracking mode
        trackedAgentIdRef.current = null;
      }
    };
    canvas.addEventListener('click', handleClick);
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) {
        const dx = e.clientX - lastDragPosRef.current.x;
        const dy = e.clientY - lastDragPosRef.current.y;
        panRef.current.x += dx / zoomRef.current;
        panRef.current.y += dy / zoomRef.current;
        lastDragPosRef.current = { x: e.clientX, y: e.clientY };
      }
    };
    const handleMouseUp = () => {
      isDraggingRef.current = false;
      canvas.style.cursor = 'grab';
    };
    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);

    render();

    return () => {
      running = false;
      clearInterval(hotFoldersInterval);
      ro.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseUp);
      canvas.removeEventListener('click', handleClick);
      canvas.removeEventListener('mousedown', handleMouseDownForClick);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send the user's decision back to the waiting agent and drop the pending entry.
  type Outcome =
    | { outcome: 'answer'; text: string }
    | { outcome: 'allow' }
    | { outcome: 'deny'; reason?: string };
  const postOutcome = (agentId: string, requestId: string, outcome: Outcome) => {
    fetch(`${API_URL}/agent/${agentId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, outcome }),
    }).catch(console.error);
    pendingRequestsRef.current.delete(agentId);
  };

  // Spawn a Claude agent from the hotel and open its chat; send/stop turns.
  const spawnAgentFromHotel = (req: SpawnRequest) => {
    fetch(`${API_URL}/agent/spawn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req, projectId }),
    })
      .then(r => r.json())
      .then((d: { agentId?: string }) => { if (d.agentId) openChat(d.agentId); })
      .catch(console.error);
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', backgroundColor: '#C8E8F8' }}>
      <div style={{
        position: 'absolute', top: 16, left: 16, zIndex: 10,
        color: '#4A5A6A', fontSize: '16px', fontWeight: 'bold',
        textShadow: '1px 1px 2px rgba(255,255,255,0.6)',
        backgroundColor: 'rgba(255, 252, 248, 0.85)',
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(160, 150, 140, 0.3)'
      }}>
        CodeMap
      </div>
      <FloorNavBar
        currentFloor={nav.state.currentFloorIndex}
        availableFloors={availableFloors}
        follow={nav.state.follow}
        focusAgentId={nav.state.focusAgentId}
        focusAgentName={
          nav.state.focusAgentId
            ? thinkingAgentsRef.current.find(a => a.agentId === nav.state.focusAgentId)?.displayName
            : undefined
        }
        onSelectFloor={nav.selectFloor}
      />
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          imageRendering: 'pixelated'
        }}
      />
      {modalTarget && (
        <InteractionModal
          agentName={modalTarget.displayName}
          mode={modalTarget.mode}
          question={modalTarget.mode === 'question' ? modalTarget.question : undefined}
          toolName={modalTarget.mode === 'permission' ? modalTarget.toolName : undefined}
          toolInput={modalTarget.mode === 'permission' ? modalTarget.toolInput : undefined}
          title={modalTarget.mode === 'permission' ? modalTarget.title : undefined}
          description={modalTarget.mode === 'permission' ? modalTarget.description : undefined}
          plan={modalTarget.mode === 'permission' ? modalTarget.plan : undefined}
          onClose={() => setModalTarget(null)}
          onSubmitAnswers={(answers: QuestionAnswer[]) => {
            // Route the answer back to the agent if a blocking hook is waiting.
            if (modalTarget.requestId && modalTarget.mode === 'question') {
              postOutcome(modalTarget.agentId, modalTarget.requestId, {
                outcome: 'answer', text: formatAnswers(modalTarget.question, answers),
              });
            }
            setModalTarget(null);
          }}
          onDecide={(allow: boolean, feedback?: string) => {
            if (modalTarget.requestId) {
              postOutcome(modalTarget.agentId, modalTarget.requestId,
                allow ? { outcome: 'allow' } : { outcome: 'deny', reason: feedback ?? 'Refusé via CodeMap' });
            }
            setModalTarget(null);
          }}
        />
      )}

      {filePreviewPath && (
        <FilePreviewModal
          projectId={projectId}
          filePath={filePreviewPath}
          onClose={() => setFilePreviewPath(null)}
        />
      )}

      {/* Spawn-an-agent control (bottom-left) */}
      <div style={{ position: 'absolute', left: 16, bottom: 16, zIndex: 25, fontFamily: 'monospace', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        {spawnOpen ? (
          <SpawnPanel
            models={spawnModels}
            agents={spawnAgents}
            onSpawn={req => { spawnAgentFromHotel(req); setSpawnOpen(false); }}
            onClose={() => setSpawnOpen(false)}
          />
        ) : (
          <button
            style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, padding: '8px 14px', color: '#3A2E12', background: '#FFE040', border: '3px solid #4A3B1A', boxShadow: '3px 3px 0 rgba(0,0,0,0.3)', cursor: 'pointer' }}
            onClick={() => setSpawnOpen(true)}
            title="Invoquer un agent Claude depuis l'hôtel"
          >🪄 Spawn agent</button>
        )}
        <SpawnTtyButton projectId={projectId} />
      </div>

    </div>
  );
}
