// Smooth horizontal scrolling for shelves, paced by requestAnimationFrame so it runs at the
// monitor's refresh rate.

interface Anim {
  pos: number;
  target: number;
  last: number;
  raf: number;
}

const anims = new WeakMap<HTMLElement, Anim>();

/** Where the element is heading (its current position if it isn't animating). */
export function scrollTarget(el: HTMLElement) {
  const a = anims.get(el);
  return a?.raf ? a.target : el.scrollLeft;
}

export function stopScroll(el: HTMLElement) {
  const a = anims.get(el);
  if (a?.raf) cancelAnimationFrame(a.raf);
  if (a) a.raf = 0;
}

/** Eases towards scrollLeft + dx; repeated calls extend the target, like a browser's smooth wheel. */
export function smoothScrollBy(el: HTMLElement, dx: number) {
  let a = anims.get(el);
  if (!a) anims.set(el, (a = { pos: 0, target: 0, last: 0, raf: 0 }));
  if (!a.raf) a.pos = a.target = el.scrollLeft;
  a.target = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, a.target + dx));
  if (a.raf) return;
  const anim = a;
  anim.last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(now - anim.last, 100);
    anim.last = now;
    // Exponential ease with a ~65 ms time constant, independent of frame rate.
    anim.pos += (anim.target - anim.pos) * (1 - Math.exp(-dt / 65));
    if (Math.abs(anim.target - anim.pos) < 0.5) anim.pos = anim.target;
    el.scrollLeft = anim.pos;
    anim.raf = anim.pos === anim.target ? 0 : requestAnimationFrame(step);
  };
  anim.raf = requestAnimationFrame(step);
}

// ---- vertical wheel → horizontal shelf scroll ----------------------------------------
//
// A wheel gesture stays with whatever started it: if the page is mid-scroll when the pointer
// passes over a shelf, the page keeps scrolling. Only a fresh gesture over a shelf moves it,
// and at either end of the shelf the wheel falls through to the page.

const LATCH_MS = 250;
let latch: { owner: HTMLElement | null; at: number } = { owner: null, at: -Infinity };
const handled = new WeakSet<Event>();

window.addEventListener(
  "wheel",
  (e) => {
    if (!handled.has(e)) latch = { owner: null, at: e.timeStamp };
  },
  { passive: true },
);

function itemStride(el: HTMLElement) {
  const first = el.firstElementChild as HTMLElement | null;
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  return first ? first.offsetWidth + gap : 200;
}

export function attachShelfWheel(el: HTMLElement) {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // native horizontal
    if (e.timeStamp - latch.at < LATCH_MS && latch.owner !== el) return;
    const max = el.scrollWidth - el.clientWidth;
    const at = scrollTarget(el);
    if (max <= 0 || (e.deltaY < 0 && at <= 0) || (e.deltaY > 0 && at >= max - 1)) return;
    e.preventDefault();
    handled.add(e);
    latch = { owner: el, at: e.timeStamp };
    const notched = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40;
    if (notched) {
      // Mouse wheel: one card per notch, eased.
      smoothScrollBy(el, Math.sign(e.deltaY) * itemStride(el));
    } else {
      // Touchpad: deltas already arrive smoothly every frame.
      stopScroll(el);
      el.scrollLeft += e.deltaY;
    }
  };
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => el.removeEventListener("wheel", onWheel);
}

/** One "page" of cards, rounded to whole cards. */
export function pageStride(el: HTMLElement) {
  const stride = itemStride(el);
  return Math.max(1, Math.floor(el.clientWidth / stride) - 1) * stride;
}

/** Average requestAnimationFrame rate over `ms`, i.e. how fast the UI is actually drawing. */
export function measureFrameRate(ms = 1000): Promise<number> {
  return new Promise((resolve) => {
    let start = 0;
    let frames = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      else frames++;
      if (now - start < ms) requestAnimationFrame(tick);
      else resolve(Math.round((frames * 1000) / (now - start)));
    };
    requestAnimationFrame(tick);
  });
}
