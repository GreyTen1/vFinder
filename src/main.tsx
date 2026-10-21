import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

window.addEventListener("error", (event) => {
  console.error("[window error]", event.error?.stack || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[unhandled rejection]", event.reason?.stack || event.reason);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
