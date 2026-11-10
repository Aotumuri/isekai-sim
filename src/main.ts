import "./style.css";
import { createGame } from "./app/create-game";

const appRoot = document.getElementById("app");
if (!appRoot) {
  throw new Error("Missing #app root element");
}

const preset = new URLSearchParams(window.location.search).get("map");
if (preset === "japan-scale" || preset === "world-map") {
  appRoot.replaceChildren();
  createGame(appRoot, { preset });
}
