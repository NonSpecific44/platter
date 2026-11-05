// Older Android system WebViews (for example on music players stuck on an early Android 12 build)
// lack these. Must be imported before anything else.
const c = crypto as Crypto & { randomUUID?: () => string };
if (!c.randomUUID) {
  c.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}
if (!("timeout" in AbortSignal)) {
  (AbortSignal as any).timeout = (ms: number) => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return ctl.signal;
  };
}
if (!Array.prototype.at) {
  Array.prototype.at = function (this: unknown[], i: number) {
    return this[i < 0 ? this.length + i : i];
  };
}
export {};
