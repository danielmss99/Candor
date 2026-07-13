import React from "react";
import { createRoot } from "react-dom/client";
import { VisualEvidenceApp } from "./VisualEvidenceApp";
import "../../v3/renderer/src/tokens.css";
import "../../v3/renderer/src/styles.css";
import "./visual.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VisualEvidenceApp />
  </React.StrictMode>,
);
