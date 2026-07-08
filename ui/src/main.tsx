import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app";
import { apiReady } from "./lib/api";

function configureWindowChrome() {
  const tauriWindow = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  const isTauri =
    tauriWindow.__TAURI__ !== undefined ||
    tauriWindow.__TAURI_INTERNALS__ !== undefined;
  const isMac = navigator.platform.toLowerCase().includes("mac");

  if (isTauri && isMac) {
    document.documentElement.dataset.windowChrome = "macos-overlay";
  }
}

const render = () =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

configureWindowChrome();
void apiReady.then(render);
