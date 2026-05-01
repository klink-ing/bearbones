// Bearbones demo entry point. The styled-system import pulls in Panda's
// generated atomic CSS (which includes everything bearbones extracted) so the
// classes referenced by Demo.tsx have rules to apply.
import "../styled-system/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Demo } from "./Demo.tsx";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app root");
createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
