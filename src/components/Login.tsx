import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, ExternalLink, Library, Loader2, Server as ServerIcon, Wifi, Globe } from "lucide-react";
import { authUrl, checkPin, createPin, getServers, getUser, Resource, Server } from "../plex";
import { bestConnection } from "../connection";
import { useSession } from "../store";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="login">
      <div className="login-card">
        <img src="/icon.png" className="login-logo" alt="" />
        <h1>Platter</h1>
        {children}
      </div>
    </div>
  );
}

export function SignIn() {
  const set = useSession((s) => s.set);
  const [pin, setPin] = useState<{ id: number; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const start = async () => {
    setError(null);
    try {
      const p = await createPin();
      setPin(p);
      await openUrl(authUrl(p.code));
    } catch (e) {
      setError(`Couldn't reach plex.tv: ${e}`);
    }
  };

  useEffect(() => {
    if (!pin) return;
    let alive = true;
    const started = Date.now();
    const poll = async () => {
      if (!alive) return;
      try {
        const token = await checkPin(pin.id);
        if (token) {
          const user = await getUser(token).catch(() => undefined);
          set({ token, user });
          return;
        }
      } catch {
        /* keep polling */
      }
      if (Date.now() - started > 10 * 60_000) {
        setError("Sign-in timed out. Try again.");
        setPin(null);
        return;
      }
      setTimeout(poll, 1500);
    };
    poll();
    return () => {
      alive = false;
    };
  }, [pin, set]);

  return (
    <Shell>
      <p className="dim">Your Plex music, everywhere you are.</p>
      {!pin ? (
        <button className="btn primary big" onClick={start}>
          Sign in with Plex
        </button>
      ) : (
        <div className="pin-wait">
          <Loader2 className="spin" size={22} />
          <p>Finish signing in with Plex in your browser.</p>
          <div className="row gap">
            <button className="btn" onClick={() => openUrl(authUrl(pin.code))}>
              <ExternalLink size={15} /> Open again
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                navigator.clipboard.writeText(authUrl(pin.code));
                setCopied(true);
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />} Copy link
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <p className="dim small">Platter never sees your password. Sign-in happens on plex.tv.</p>
    </Shell>
  );
}

export function PickServer() {
  const { token, set, signOut } = useSession();
  const [servers, setServers] = useState<Resource[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = async (r: Resource) => {
    setBusy(r.clientIdentifier);
    setError(null);
    try {
      const c = await bestConnection(r.connections, r.clientIdentifier, r.accessToken);
      if (!c) throw new Error(`Couldn't reach ${r.name} on any of its addresses`);
      set({
        server: { uri: c.uri, token: r.accessToken, machineId: r.clientIdentifier, name: r.name, local: c.local, connections: r.connections },
        section: undefined,
      });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(null);
    }
  };

  useEffect(() => {
    getServers(token!)
      .then((s) => {
        setServers(s);
        const online = s.filter((x) => x.presence !== false);
        if (online.length === 1) connect(online[0]);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <Shell>
      <p className="dim">Choose a server</p>
      {!servers && !error && <Loader2 className="spin" />}
      <div className="pick-list">
        {servers?.map((r) => (
          <button key={r.clientIdentifier} className="pick" disabled={!!busy} onClick={() => connect(r)}>
            <ServerIcon size={18} />
            <span className="grow">
              {r.name}
              {!r.owned && <span className="badge">shared</span>}
            </span>
            {busy === r.clientIdentifier ? <Loader2 className="spin" size={16} /> : r.presence ? <span className="dot online" /> : <span className="dot" />}
          </button>
        ))}
        {servers?.length === 0 && <p className="dim">No Plex Media Servers found on this account.</p>}
      </div>
      {error && <p className="error-text">{error}</p>}
      <button className="btn ghost" onClick={signOut}>
        Sign out
      </button>
    </Shell>
  );
}

export function PickSection() {
  const { server: info, set } = useSession();
  const [sections, setSections] = useState<{ key: string; title: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    new Server(info!)
      .musicSections()
      .then((s) => {
        setSections(s);
        if (s.length === 1) set({ section: s[0] });
      })
      .catch((e) => setError(String(e)));
  }, [info, set]);

  return (
    <Shell>
      <p className="dim">
        {info?.local ? <Wifi size={14} /> : <Globe size={14} />} {info?.name}: choose a music library
      </p>
      {!sections && !error && <Loader2 className="spin" />}
      <div className="pick-list">
        {sections?.map((s) => (
          <button key={s.key} className="pick" onClick={() => set({ section: s })}>
            <Library size={18} />
            <span className="grow">{s.title}</span>
          </button>
        ))}
        {sections?.length === 0 && <p className="dim">This server has no music libraries.</p>}
      </div>
      {error && <p className="error-text">{error}</p>}
      <button className="btn ghost" onClick={() => set({ server: undefined })}>
        Choose another server
      </button>
    </Shell>
  );
}
