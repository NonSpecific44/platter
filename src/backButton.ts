// Android back button: Tauri sends it to the webview's history, so keep one history entry armed
// and turn each back press into "close the top overlay" or "previous page" inside the app.
// With nothing left to go back to, the next press leaves the app.
import { useMenu, useNav, toast } from "./store";
import { useDevicesSheet } from "./components/Devices";

function arm() {
  history.pushState({ tonearm: true }, "");
}

function handleBack(): boolean {
  if (useMenu.getState().items) {
    useMenu.getState().close();
    return true;
  }
  if (useDevicesSheet.getState().open) {
    useDevicesSheet.getState().set(false);
    return true;
  }
  const nav = useNav.getState();
  if (nav.palette) {
    nav.setPalette(false);
    return true;
  }
  if (nav.nowPlaying) {
    nav.setNowPlaying(false);
    return true;
  }
  if (nav.stack.length > 1) {
    nav.back();
    return true;
  }
  const cur = nav.stack[0];
  if (cur.kind !== "home") {
    useNav.setState({ stack: [{ kind: "home" }], forward: [] });
    return true;
  }
  return false;
}

export function initBackButton() {
  arm();
  window.addEventListener("popstate", () => {
    if (handleBack()) arm();
    else toast("Press back again to exit");
  });
  // Opening something new re-arms the guard after an "exit" warning.
  useNav.subscribe((s, p) => {
    if (s.stack.length !== p.stack.length || s.nowPlaying !== p.nowPlaying) {
      if (!history.state?.tonearm) arm();
    }
  });
}
