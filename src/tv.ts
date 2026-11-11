// Google TV / Android TV: everything reachable with the remote's D-pad. Arrow keys move focus to the
// nearest thing in that direction, OK (Enter) activates it, and Back goes back (backButton.ts).
// The desktop layout is used, since a TV is a wide screen.

/** Things that act when clicked but aren't buttons or links, so need making focusable. */
const CLICKABLE = ".card, .lrow, .recent-tile, .pick, .dev-row, .track, .qrow, .pal-item, .side-item, .chip";
const FOCUSABLE = `a[href], button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea, [tabindex]:not([tabindex="-1"])`;
/** Overlays that keep focus inside them while open, topmost last. */
const LAYERS = ".menu-backdrop, .modal-backdrop, .sheet-backdrop, .now-playing, .pnp";

function markClickable(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>(CLICKABLE)) {
    if (el.tabIndex < 0 && !el.matches(FOCUSABLE)) el.tabIndex = 0;
  }
}

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.opacity !== "0";
}

function scope(): ParentNode {
  const layers = [...document.querySelectorAll<HTMLElement>(LAYERS)].filter(visible);
  return layers[layers.length - 1] ?? document;
}

type Dir = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** The nearest focusable thing from `from` in direction `dir`, favouring ones straight ahead. */
function nearest(from: DOMRect | null, dir: Dir, candidates: HTMLElement[]) {
  if (!from) return candidates[0] ?? null;
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let along: number;
    let across: number;
    if (dir === "ArrowDown") (along = r.top - from.bottom), (across = Math.max(0, Math.abs(x - fx) - r.width / 2));
    else if (dir === "ArrowUp") (along = from.top - r.bottom), (across = Math.max(0, Math.abs(x - fx) - r.width / 2));
    else if (dir === "ArrowRight") (along = r.left - from.right), (across = Math.max(0, Math.abs(y - fy) - r.height / 2));
    else (along = from.left - r.right), (across = Math.max(0, Math.abs(y - fy) - r.height / 2));
    // Allow a little overlap: neighbours often touch.
    if (along < -4) continue;
    const score = Math.max(0, along) + across * 3;
    if (score < bestScore) (bestScore = score), (best = el);
  }
  return best;
}

/** Keys the focused control needs for itself, like left/right on a slider. */
function ownsKey(el: Element | null, key: string) {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement && el.type === "range") return key === "ArrowLeft" || key === "ArrowRight";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return key === "ArrowLeft" || key === "ArrowRight";
  return el.tagName === "SELECT" && (key === "ArrowUp" || key === "ArrowDown");
}

export function startTvNavigation() {
  document.documentElement.classList.add("tv");
  markClickable(document);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement) markClickable(n.parentNode ?? n);
  }).observe(document.body, { childList: true, subtree: true });

  window.addEventListener(
    "keydown",
    (e) => {
      const active = document.activeElement as HTMLElement | null;
      if (e.key === "Enter" && active && active !== document.body && !active.matches("button, a, input, select, textarea")) {
        e.preventDefault();
        active.click();
        // Track rows play on double-click with a mouse.
        if (active.matches(".track")) active.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        return;
      }
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) || ownsKey(active, e.key)) return;
      const root = scope();
      const inside = active && active !== document.body && active.isConnected && root.contains(active) ? active : null;
      const candidates = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el !== inside && visible(el));
      // Nothing focused, e.g. just after opening a page: start at the top of the page itself.
      const page = root === document ? candidates.filter((el) => el.closest(".main")) : [];
      const next = inside ? nearest(inside.getBoundingClientRect(), e.key as Dir, candidates) : (page[0] ?? candidates[0] ?? null);
      if (!next) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    },
    true,
  );
}
