import { useEffect, useState } from "react";

export const isAndroid = () => /Android/i.test(navigator.userAgent);

const PHONE = "(max-width: 700px)";

/** True on phones and very narrow windows, where the mobile layout is used. */
export function isPhone() {
  return window.matchMedia(PHONE).matches;
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}
