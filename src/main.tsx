import "./polyfills";
import "./testboot";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { isAndroid } from "./platform";

if (isAndroid()) document.documentElement.classList.add("android");

// No browser context menu, except in text fields.
window.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement;
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
