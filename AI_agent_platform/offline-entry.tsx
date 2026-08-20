import React from "react";
import { createRoot } from "react-dom/client";
import Home from "./app/page";
import "./app/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("找不到離線展示頁面的根節點");
}

createRoot(root).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
);
