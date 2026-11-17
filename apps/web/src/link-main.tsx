import { createRoot } from "react-dom/client";
import LinkApp from "./LinkApp";
import { createLinkRuntime } from "./runtime";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <LinkApp runtime={createLinkRuntime()} />,
);
