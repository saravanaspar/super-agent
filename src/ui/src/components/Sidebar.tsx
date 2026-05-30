import { useEffect, useRef, useState } from "react";
import type { ChatSession } from "@shared/types";

interface SidebarProps {
  collapsed: boolean;
  sessions: ChatSession[];
  activeSessionId: string | null;
  searchOpen: boolean;
  searchQuery: string;
  onToggleCollapse: () => void;
  onNewChat: () => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  onToggleSearch: () => void;
  onSearchChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string, pinned: boolean) => void;
}

type IconName =
  | "sidebar"
  | "plus"
  | "search"
  | "library"
  | "settings"
  | "dots"
  | "pin"
  | "rename"
  | "delete";

const projectNameFromPath = (workspaceDirectory?: string | null): string | null => {
  if (!workspaceDirectory) return null;

  const parts = workspaceDirectory.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
};

function Icon({ name }: { name: IconName }) {
  if (name === "plus") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 5v14M5 12h14"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (name === "search") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle
          cx="11"
          cy="11"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M16 16l3.5 3.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (name === "library") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M6 5.5h10a2 2 0 0 1 2 2v11H8a2 2 0 0 0-2 2v-15Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <path d="M8 20.5h10" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }

  if (name === "settings") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <path
          d="M12 3.5v2M12 18.5v2M4.6 7l1.7 1M17.7 16l1.7 1M4.6 17l1.7-1M17.7 8l1.7-1"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (name === "dots") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6.5" cy="12" r="1.5" fill="currentColor" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
        <circle cx="17.5" cy="12" r="1.5" fill="currentColor" />
      </svg>
    );
  }

  if (name === "pin") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M8 4h8l-1 5 3 3v2H6v-2l3-3-1-5ZM12 14v6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === "rename") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4 16.5V20h3.5L18.2 9.3l-3.5-3.5L4 16.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M13.7 6.8l3.5 3.5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (name === "delete") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M5 7h14M10 11v6M14 11v6M9 7l1-3h4l1 3M7 7l1 13h8l1-13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="3.5"
        y="5"
        width="17"
        height="14"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M9 5v14" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function Sidebar(props: SidebarProps) {
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpenMenuSessionId(null);
      }
    };

    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  const renameSession = (session: ChatSession) => {
    const nextTitle = window.prompt("Rename chat", session.title);

    if (nextTitle && nextTitle.trim() && nextTitle.trim() !== session.title) {
      props.onRenameSession(session.id, nextTitle.trim());
    }

    setOpenMenuSessionId(null);
  };

  const deleteSession = (session: ChatSession) => {
    const confirmed = window.confirm(`Delete "${session.title}"?`);

    if (confirmed) {
      props.onDeleteSession(session.id);
    }

    setOpenMenuSessionId(null);
  };

  return (
    <aside
      className={props.collapsed ? "sidebar collapsed" : "sidebar"}
      aria-label="Chat navigation"
    >
      <div className="sidebar-header">
        {!props.collapsed ? <div className="product-name">Super Agent</div> : null}
        <button
          className="icon-button"
          aria-label={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={props.onToggleCollapse}
        >
          <Icon name="sidebar" />
        </button>
      </div>

      <div className={props.collapsed ? "sidebar-actions collapsed-actions" : "sidebar-actions"}>
        {props.collapsed ? (
          <>
            <button
              className="icon-button"
              aria-label="New Chat"
              title="New Chat"
              onClick={props.onNewChat}
            >
              <Icon name="plus" />
            </button>
            <button
              className="icon-button"
              aria-label="Search Chat"
              title="Search Chat"
              onClick={props.onToggleSearch}
            >
              <Icon name="search" />
            </button>
            <button
              className="icon-button"
              aria-label="Library"
              title="Library"
              onClick={props.onOpenLibrary}
            >
              <Icon name="library" />
            </button>
          </>
        ) : (
          <>
            <button className="button primary full" onClick={props.onNewChat}>
              New Chat
            </button>
            <button className="button secondary full" onClick={props.onToggleSearch}>
              Search Chat
            </button>
            {props.searchOpen ? (
              <input
                className="search-input"
                aria-label="Search persisted chats"
                value={props.searchQuery}
                onChange={(event) => props.onSearchChange(event.target.value)}
                placeholder="Search chats"
              />
            ) : null}
            <button className="button secondary full" onClick={props.onOpenLibrary}>
              Library
            </button>
          </>
        )}
      </div>

      {!props.collapsed ? <div className="sidebar-label">Chat history</div> : null}

      <div className="history-list">
        {props.sessions.length === 0 && !props.collapsed ? (
          <div className="empty-note">No saved chats yet.</div>
        ) : null}

        {props.sessions.map((session) => {
          const pinned = Boolean(session.pinnedAt);
          const menuOpen = openMenuSessionId === session.id;
          const projectName = projectNameFromPath(session.workspaceDirectory);
          const itemTitle = projectName
            ? `${session.title} — Project: ${projectName}`
            : session.title;

          return (
            <div
              className={[
                "history-row",
                session.id === props.activeSessionId ? "active" : "",
                props.collapsed ? "compact" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              key={session.id}
            >
              <button
                className={[
                  "history-item",
                  session.id === props.activeSessionId ? "active" : "",
                  props.collapsed ? "compact" : "",
                  projectName ? "has-project" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => props.onSelectSession(session.id)}
                title={itemTitle}
                aria-label={itemTitle}
              >
                {props.collapsed ? (
                  <span className="history-initial">
                    {session.title.slice(0, 1).toUpperCase()}
                  </span>
                ) : (
                  <>
                    {pinned ? <span className="pin-marker">Pinned</span> : null}
                    <span className="session-title">{session.title}</span>
                    {projectName ? (
                      <span
                        className="session-project"
                        title={`Project: ${session.workspaceDirectory ?? projectName}`}
                      >
                        {`Project: ${projectName}`}
                      </span>
                    ) : null}
                  </>
                )}
              </button>

              {!props.collapsed ? (
                <div className="history-menu-shell" ref={menuOpen ? menuRef : null}>
                  <button
                    className="history-menu-button"
                    aria-label={`Open actions for ${session.title}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuSessionId(menuOpen ? null : session.id);
                    }}
                  >
                    <Icon name="dots" />
                  </button>

                  {menuOpen ? (
                    <div className="chat-action-menu" role="menu">
                      <button
                        role="menuitem"
                        onClick={() =>
                          props.onTogglePinSession(session.id, !pinned)
                        }
                      >
                        <Icon name="pin" />
                        {pinned ? "Unpin chat" : "Pin chat"}
                      </button>
                      <button role="menuitem" onClick={() => renameSession(session)}>
                        <Icon name="rename" />
                        Rename
                      </button>
                      <div className="chat-action-divider" />
                      <button
                        className="danger"
                        role="menuitem"
                        onClick={() => deleteSession(session)}
                      >
                        <Icon name="delete" />
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button
          className={props.collapsed ? "icon-button" : "button secondary full"}
          aria-label="Settings"
          title="Settings"
          onClick={props.onOpenSettings}
        >
          {props.collapsed ? <Icon name="settings" /> : "Settings"}
        </button>
      </div>
    </aside>
  );
}