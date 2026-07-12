import React from "react";
import { createRoot } from "react-dom/client";
import CandorApp from "./CandorApp";
import "./tokens.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CandorApp />
  </React.StrictMode>,
);
