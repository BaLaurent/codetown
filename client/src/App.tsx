// Main App component - CodeMap visualization application
// Provides two views: Tree (force graph) and Hotel (isometric room)
import { useState } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { FileGraph } from './components/FileGraph';
import { ActivityLegend } from './components/ActivityLegend';
import { TownView } from './components/TownView';
import { AgentRosterPanel, type AgentFocusRequest, type FocusRequest, type ActionRequest } from './components/AgentRosterPanel';
import { AgentStreamProvider } from './hooks/AgentStream';
import { ChatProvider, useChat } from './components/ChatHost';
import { TtyProvider } from './components/TtyHost';
import { DockProvider, useDock } from './components/DockHost';
import { getMuted, setMuted } from './sounds';

// Mute button component
function MuteButton() {
  const [muted, setMutedState] = useState(getMuted());

  const toggle = () => {
    const newState = !muted;
    setMuted(newState);
    setMutedState(newState);
  };

  return (
    <button
      onClick={toggle}
      style={{
        ...navLinkStyle,
        cursor: 'pointer',
        background: muted ? 'rgba(239, 68, 68, 0.9)' : 'rgba(17, 24, 39, 0.9)',
      }}
      title={muted ? 'Unmute sounds' : 'Mute sounds'}
    >
      {muted ? 'Muted' : 'Sound'}
    </button>
  );
}

// TreeView - Shows files as a force-directed graph
function TreeView() {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      backgroundColor: '#1f2937',
      overflow: 'hidden',
      position: 'relative'
    }}>
      <FileGraph />
      <ActivityLegend />
      <NavLinks />
    </div>
  );
}

// NavLinks - Navigation buttons to switch between Tree and Hotel views
function NavLinks() {
  return (
    <div style={{
      position: 'absolute',
      top: 16,
      right: 16,
      zIndex: 20,
      display: 'flex',
      gap: 8
    }}>
      <Link to="/" style={navLinkStyle}>Tree</Link>
      <Link to="/hotel" style={navLinkStyle}>Hotel</Link>
      <MuteButton />
    </div>
  );
}

const navLinkStyle: React.CSSProperties = {
  color: '#e5e7eb',
  textDecoration: 'none',
  padding: '10px 20px',
  backgroundColor: 'rgba(17, 24, 39, 0.95)',
  borderRadius: '8px',
  fontSize: '14px',
  fontWeight: 500,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
};

// HotelView - Shows the town of projects (each a building); drill into one for the interior.
// Owns the selected-building state (needed by AgentStreamProvider) and wraps the
// interior in the providers that keep the WS stream + chat panel alive across
// town<->building navigation. The actual UI is in HotelViewInner (it consumes useChat).
function HotelView() {
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  return (
    <AgentStreamProvider projectId={selectedProject ?? undefined}>
      <DockProvider>
        <ChatProvider>
          <TtyProvider>
            <HotelViewInner selectedProject={selectedProject} onSelectProject={setSelectedProject} />
          </TtyProvider>
        </ChatProvider>
      </DockProvider>
    </AgentStreamProvider>
  );
}

function HotelViewInner({ selectedProject, onSelectProject }: {
  selectedProject: string | null;
  onSelectProject: (p: string | null) => void;
}) {
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [actionRequest, setActionRequest] = useState<ActionRequest | null>(null);
  const { openChat } = useChat();
  const { mode, toggleMode, dockHeight } = useDock();

  // Clicking an agent in the roster: enter its building (if known) and stamp a
  // fresh focus request so HabboRoom flies the camera to it.
  const handleSelectAgent = ({ projectId, agentId }: AgentFocusRequest) => {
    if (projectId) onSelectProject(projectId);
    setFocusRequest({ projectId, agentId, ts: Date.now() });
  };

  // Roster chat button: open the panel directly (it lives above the building view,
  // so this works even from the town overview or for an agent in another building).
  // Respond opens the in-building modal without moving the camera.
  const handleRespond = (agentId: string) => setActionRequest({ agentId, action: 'respond', ts: Date.now() });

  return (
    <>
      <div style={{
        width: '100vw',
        height: mode === 'docked' ? `calc(100vh - ${dockHeight}px)` : '100vh',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <TownView selected={selectedProject} onSelect={onSelectProject} focusRequest={focusRequest} actionRequest={actionRequest} />
      </div>
      <AgentRosterPanel onSelectAgent={handleSelectAgent} onOpenChat={openChat} onRespond={handleRespond} />
      <div style={{
        position: 'absolute',
        top: 16,
        right: 16,
        zIndex: 20,
        display: 'flex',
        gap: 8
      }}>
        <Link to="/" style={navLinkStyle}>Tree</Link>
        <Link to="/hotel" style={navLinkStyle}>Hotel</Link>
        {selectedProject && (
          <button
            onClick={() => onSelectProject(null)}
            style={{ ...navLinkStyle, cursor: 'pointer' }}
            title="Back to the town overview"
          >
            ← Town
          </button>
        )}
        <button
          onClick={toggleMode}
          style={{ ...navLinkStyle, cursor: 'pointer' }}
          title={mode === 'docked' ? 'Repasser les panneaux en flottant' : 'Docker les panneaux en bas'}
        >⬓ {mode === 'docked' ? 'Float' : 'Dock'}</button>
        <MuteButton />
      </div>
    </>
  );
}

// App - Main routing component
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TreeView />} />
        <Route path="/hotel" element={<HotelView />} />
      </Routes>
    </BrowserRouter>
  );
}
