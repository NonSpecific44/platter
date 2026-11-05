import { Disc3, Home, ListMusic, ListOrdered, PanelLeftClose, PanelLeftOpen, Search, Settings, User, Heart, ChevronLeft, ChevronRight, RefreshCw, HardDrive, Inbox } from "lucide-react";
import { refreshLibrary, useLibrary } from "../live";
import { useNav, useSession, useSettings, View } from "../store";
import { usePlaylists } from "../actions";

const NAV: [View, string, typeof Home][] = [
  [{ kind: "home" }, "Home", Home],
  [{ kind: "artists" }, "Artists", User],
  [{ kind: "albums" }, "Albums", Disc3],
  [{ kind: "playlists" }, "Playlists", ListMusic],
  [{ kind: "queue" }, "Queue", ListOrdered],
  [{ kind: "local" }, "On this device", HardDrive],
];

export function Sidebar() {
  const { stack, go, back, fwd, forward, setPalette } = useNav();
  const cur = stack[stack.length - 1];
  const playlists = usePlaylists((s) => s.list);
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const set = useSettings((s) => s.set);
  const server = useSession((s) => s.server);
  const section = useSession((s) => s.section);
  const scanning = useLibrary((s) => s.scanning);
  const lidarr = useSettings((x) => !!(x.lidarrUrl && x.lidarrKey));
  // On a phone the queue/lyrics panel covers the page, so navigating closes it.
  const navTo = (v: View) => {
    if (window.innerWidth <= 700) useNav.getState().setPanel("none");
    go(v);
  };
  const is = (v: View) => cur.kind === v.kind && JSON.stringify(cur) === JSON.stringify(v);

  return (
    <nav className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="side-brand">
        <img src="/icon.png" alt="" />
        <span className="side-label">Platter</span>
      </div>
      <div className="side-top">
        <button className="icon-btn" onClick={back} disabled={stack.length < 2} title="Back (Alt+←)">
          <ChevronLeft size={18} />
        </button>
        <button className="icon-btn" onClick={fwd} disabled={!forward.length} title="Forward (Alt+→)">
          <ChevronRight size={18} />
        </button>
        <div className="grow" />
        <button
          className={`icon-btn ${scanning ? "spinning" : ""}`}
          onClick={() => refreshLibrary(true)}
          title="Refresh library and scan for new music (F5)"
        >
          <RefreshCw size={16} />
        </button>
        <button className="icon-btn" onClick={() => set({ sidebarCollapsed: !collapsed })} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
      <button className="side-search" onClick={() => setPalette(true)} title="Search (Ctrl+K)">
        <Search size={16} />
        <span className="side-label">Search</span>
        <kbd className="side-label">Ctrl K</kbd>
      </button>
      {NAV.map(([v, label, Icon]) => (
        <button key={label} className={`side-item ${cur.kind === v.kind ? "active" : ""}`} onClick={() => navTo(v)} title={label}>
          <Icon size={18} />
          <span className="side-label">{label}</span>
        </button>
      ))}
      {lidarr && (
        <button className={`side-item ${cur.kind === "requests" ? "active" : ""}`} onClick={() => navTo({ kind: "requests" })} title="Request music">
          <Inbox size={18} />
          <span className="side-label">Requests</span>
        </button>
      )}
      <div className="side-sep" />
      <div className="side-playlists">
        <button className={`side-item small ${is({ kind: "playlist", id: "loved" }) ? "active" : ""}`} onClick={() => go({ kind: "playlist", id: "loved" })} title="Loved tracks">
          <Heart size={16} />
          <span className="side-label">Loved tracks</span>
        </button>
        {playlists.map((p) => (
          <button
            key={p.ratingKey}
            className={`side-item small ${is({ kind: "playlist", id: p.ratingKey }) ? "active" : ""}`}
            onClick={() => go({ kind: "playlist", id: p.ratingKey })}
            title={p.title}
          >
            <ListMusic size={16} />
            <span className="side-label">{p.title}</span>
          </button>
        ))}
      </div>
      <button className={`side-item ${cur.kind === "settings" ? "active" : ""}`} onClick={() => navTo({ kind: "settings" })} title="Settings (Ctrl+,)">
        <Settings size={18} />
        <span className="side-label">
          Settings
          <span className="side-server">
            {server?.name} · {section?.title}
          </span>
        </span>
      </button>
    </nav>
  );
}
