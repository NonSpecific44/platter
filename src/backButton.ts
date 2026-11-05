// Android's back button: closes whatever's on top, then steps back through pages. Only from the
// home screen does it leave the app, and music keeps playing when it does.
import { invoke } from "@tauri-apps/api/core";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { onNative } from "./player";
import { useMenu, useNav, useSession } from "./store";
import { useDevicesSheet } from "./components/Devices";
import { useMetadataEditor, usePrompt } from "./actions";
import { ensureConnection } from "./connection";
import { clientId } from "./plex";
import { setOutputName } from "./remote";

function handleBack(): boolean {
  const pending = usePrompt.getState().resolve;
  if (pending) {
    pending(null);
    usePrompt.setState({ resolve: null });
    return true;
  }
  if (useMenu.getState().items) {
    useMenu.getState().close();
    return true;
  }
  if (useMetadataEditor.getState().track) {
    useMetadataEditor.getState().edit(null);
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
  if (nav.stack[0].kind !== "home") {
    useNav.setState({ stack: [{ kind: "home" }], forward: [] });
    return true;
  }
  return false;
}

export function initBackButton() {
  void onBackButtonPress(() => {
    if (!handleBack()) void invoke("app_background");
  });
}

/** Tells the Android side what it needs to run without the UI (Android Auto) and listens to it. */
export function initAndroid() {
  onNative("network", () => void ensureConnection());
  onNative<string>("output", setOutputName);
  const push = () => {
    const { server, section } = useSession.getState();
    if (!server || !section) return;
    void invoke("auto_config", {
      json: JSON.stringify({
        uri: server.uri,
        uris: (server.connections ?? []).map((c) => c.uri),
        token: server.token,
        section: section.key,
        clientId: clientId(),
      }),
    }).catch(() => undefined);
  };
  push();
  useSession.subscribe((s, p) => (s.server !== p.server || s.section !== p.section) && push());
}
