// Compact always-on-top "mini player" mode for the main window.
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useNav } from "./store";
import { isAndroid } from "./platform";

const SIZE_KEY = "tonearm.miniSize";

/** The mini player's window can be resized; it opens at the size it last had. */
function miniSize() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "");
    if (saved.w >= 260 && saved.h >= 80) return saved as { w: number; h: number };
  } catch {
    /* first use */
  }
  return { w: 440, h: 104 };
}

let previous: { w: number; h: number } | null = null;

export async function toggleMini() {
  if (isAndroid()) return;
  const win = getCurrentWindow();
  const nav = useNav.getState();
  try {
    if (!nav.mini) {
      const size = await win.innerSize();
      const scale = await win.scaleFactor();
      previous = { w: size.width / scale, h: size.height / scale };
      nav.setMini(true);
      await win.setAlwaysOnTop(true);
      const mini = miniSize();
      await win.setSize(new LogicalSize(mini.w, mini.h));
    } else {
      const size = await win.innerSize();
      const scale = await win.scaleFactor();
      localStorage.setItem(SIZE_KEY, JSON.stringify({ w: size.width / scale, h: size.height / scale }));
      nav.setMini(false);
      await win.setAlwaysOnTop(false);
      await win.setSize(new LogicalSize(previous?.w ?? 1280, previous?.h ?? 820));
    }
  } catch (e) {
    console.warn("mini mode", e);
  }
}

/** If the app was closed while in mini mode, the saved window size is tiny; undo that. */
export async function restoreSaneSize() {
  if (isAndroid()) return;
  try {
    const win = getCurrentWindow();
    const size = await win.innerSize();
    const scale = await win.scaleFactor();
    if (size.width / scale < 700 || size.height / scale < 480) await win.setSize(new LogicalSize(1280, 820));
  } catch {
    /* ignore */
  }
}
