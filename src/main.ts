import "./style.css";
import { createGame } from "./app/create-game";

const appRoot = document.getElementById("app");
if (!appRoot) {
  throw new Error("Missing #app root element");
}

createGame(appRoot);
