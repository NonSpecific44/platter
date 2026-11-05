// Test builds only (see tests/mock-plex.mjs): sign in to the mock server automatically.
const testServer = import.meta.env.VITE_TEST_PLEX as string | undefined;
if (testServer && import.meta.env.VITE_TEST_AUTOPLAY) {
  localStorage.setItem("tonearm.playback", JSON.stringify({ muted: true }));
  setTimeout(() => void import("./player").then((p) => p.player.shuffleLibrary()), 5000);
  void import("@tauri-apps/plugin-http").then(({ fetch }) =>
    fetch(testServer + "/__css").then(async (r) => {
      const st = document.createElement("style");
      st.textContent = await r.text();
      document.head.appendChild(st);
    }),
  );
}
if (testServer && !localStorage.getItem("tonearm.session")) {
  localStorage.setItem(
    "tonearm.session",
    JSON.stringify({
      token: "test",
      user: { title: "Test User", username: "test", uuid: "test" },
      server: { uri: testServer, token: "test", machineId: "mock", name: "Mock", local: true, connections: [{ uri: testServer, local: true, relay: false, protocol: "http" }] },
      section: { key: "1", title: "Music" },
    }),
  );
}

export {};
