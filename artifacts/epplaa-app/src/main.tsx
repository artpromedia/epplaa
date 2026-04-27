import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Apply persisted/system theme before React renders to prevent a flash of the wrong theme.
(function applyInitialTheme() {
  try {
    const stored = window.localStorage.getItem("epplaa-theme");
    const theme =
      stored === "dark" || stored === "light" || stored === "system"
        ? stored
        : "system";
    const resolved =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolved);
  } catch {
    // ignore — provider will reconcile on mount
  }
})();

createRoot(document.getElementById("root")!).render(<App />);
