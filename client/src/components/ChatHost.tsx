// Owns the agent chat UI ABOVE the building view, so the panel and its transcript
// survive town<->building navigation (the panel used to live in HabboRoom, which
// unmounts). openChat/closeChat are exposed via useChat() so the canvas (sprite
// click, spawn) and the roster can drive it.
//
// Multiple chats coexist as dock panels (chat:<agentId>). ChatProvider is a thin
// mapper that delegates open/close to DockHost and renders one ChatPanelContainer
// per open chat. Per-chat effects and state live in ChatPanelContainer.
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { ChatPanelContainer } from './ChatPanelContainer';
import { useDock } from './DockHost';
import { clearPanelColor } from '../utils/panel-colors';

interface ChatControl {
  openChatIds: string[];
  openChat: (agentId: string) => void;
  closeChat: (agentId: string) => void;
}

const ChatContext = createContext<ChatControl | null>(null);

export function useChat(): ChatControl {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within a ChatProvider');
  return ctx;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const dock = useDock();
  const { openPanel, closePanel, openKeysByKind } = dock;

  const openChatIds = useMemo(() => openKeysByKind('chat'), [openKeysByKind]);

  const openChat = useCallback((agentId: string) => openPanel('chat', agentId), [openPanel]);
  const closeChat = useCallback((agentId: string) => {
    clearPanelColor(`chat:${agentId}`);
    closePanel('chat', agentId);
  }, [closePanel]);

  const control = useMemo<ChatControl>(
    () => ({ openChatIds, openChat, closeChat }),
    [openChatIds, openChat, closeChat],
  );

  return (
    <ChatContext.Provider value={control}>
      {children}
      {/* All open chats are mounted with stable key=agentId.
          Evicted panels (placement === undefined → active=false) stay mounted
          with visibility:hidden so their transcript/caps/graph are not re-fetched
          on overflow flaps. */}
      {openChatIds.map(agentId => {
        const key = `chat:${agentId}`;
        const placement = dock.placementFor(key);
        return (
          <ChatPanelContainer
            key={agentId}
            agentId={agentId}
            placement={placement}
            active={placement !== undefined}
            isMaximized={dock.maximizedKey === key}
            onClose={() => closeChat(agentId)}
            onResizeWidth={w => dock.setWidth(key, w)}
            onToggleMaximize={() => (dock.maximizedKey === key ? dock.restore() : dock.maximize(key))}
          />
        );
      })}
    </ChatContext.Provider>
  );
}
