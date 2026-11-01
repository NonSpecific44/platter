// In-app updates from the GitHub releases.
//
// Desktop AppImages update themselves through Tauri's updater: the release's latest.json points
// at the new AppImage and its signature, which is checked against the public key built into the
// app. Android downloads the new APK and hands it to the system installer. Package-manager
// installs (pacman) just get a link to the release page.
//
// While the repository is private, GitHub only serves releases to requests with a token that
// can read it (Settings → Updates).
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast, useSettings } from "./store";

const REPO = "NonSpecific44/tonearm-plex-music-player";
const CHECK_EVERY_MS = 6 * 60 * 60_000;

interface Asset {
  name: string;
  url: string; // API url; needs Accept: application/octet-stream
}

interface Release {
  version: string;
  notes: string;
  page: string;
  assets: Asset[];
}

interface UpdateState {
  current: string;
  latest: Release | null;
  checking: boolean;
  installing: boolean;
  error: string | null;
}

export const useUpdates = create<UpdateState>(() => ({ current: "", latest: null, checking: false, installing: false, error: null }));

function newer(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

const token = () => useSettings.getState().githubToken.trim() || null;

export async function checkForUpdates(manual = false) {
  useUpdates.setState({ checking: true, error: null });
  try {
    const current = await getVersion();
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (r.status === 404 || r.status === 401) {
      throw new Error(t ? "GitHub didn't accept the token, or it can't read the repository" : "The release repository is private: add a GitHub token below");
    }
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const rel = await r.json();
    const latest: Release = {
      version: String(rel.tag_name ?? "").replace(/^v/, ""),
      notes: rel.body ?? "",
      page: rel.html_url,
      assets: (rel.assets ?? []).map((a: any) => ({ name: a.name, url: a.url })),
    };
    const available = newer(latest.version, current);
    useUpdates.setState({ current, latest: available ? latest : null });
    if (available) {
      toast(`Platter ${latest.version} is available`, { action: { label: "Update", run: () => void installUpdate() } });
    } else if (manual) {
      toast(`Platter ${current} is up to date`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useUpdates.setState({ error: msg });
    if (manual) toast(`Couldn't check for updates: ${msg}`, { error: true });
  } finally {
    useUpdates.setState({ checking: false });
  }
}

export async function installUpdate() {
  const rel = useUpdates.getState().latest;
  if (!rel) return;
  useUpdates.setState({ installing: true });
  try {
    const kind = await invoke<string>("update_kind");
    if (kind === "android") {
      const apk = rel.assets.find((a) => a.name.endsWith(".apk"));
      if (!apk) throw new Error("this release has no Android build");
      toast("Downloading update…");
      await invoke("update_install_apk", { url: apk.url, token: token() });
    } else if (kind === "appimage") {
      const manifest = rel.assets.find((a) => a.name === "latest.json");
      if (!manifest) throw new Error("this release has no update manifest");
      toast("Downloading update… Platter will restart when it's ready");
      await invoke("update_install", { manifestUrl: manifest.url, token: token() });
    } else {
      // Installed by a package manager: it has to be updated the same way.
      await openUrl(rel.page);
    }
  } catch (e) {
    toast(`Update failed: ${e}`, { error: true });
  } finally {
    useUpdates.setState({ installing: false });
  }
}

export function startUpdateChecks() {
  if (!useSettings.getState().autoUpdateCheck) return;
  setTimeout(() => void checkForUpdates(), 15_000);
  setInterval(() => useSettings.getState().autoUpdateCheck && void checkForUpdates(), CHECK_EVERY_MS);
}
