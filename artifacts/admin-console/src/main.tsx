import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initSentryBrowser } from "./lib/sentry";

initSentryBrowser();

createRoot(document.getElementById("root")!).render(<App />);
