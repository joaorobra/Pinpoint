import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { checkForUpdates } from "./lib/updater";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Quietly check for a new desktop release a few seconds after launch (no-op on web,
// and silent if already current or offline). A user-triggered check can call
// checkForUpdates() with no args to always surface the result.
setTimeout(() => {
  void checkForUpdates({ silent: true });
}, 4000);
