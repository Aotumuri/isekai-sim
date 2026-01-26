import { Application, Container } from "pixi.js";
import type { WorldConfig } from "../data/world-config";
import { createWorldLayers } from "./layers/world-layers";

export interface Renderer {
  app: Application;
  worldContainer: Container;
  uiContainer: Container;
  worldLayers: ReturnType<typeof createWorldLayers>;
  uiRightWidth: number;
}

export function createRenderer(root: HTMLElement, config: WorldConfig): Renderer {
  const app = new Application({
    resizeTo: window,
    background: 0x000000,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  root.appendChild(app.view as HTMLCanvasElement);

  const worldContainer = new Container();
  const uiContainer = new Container();
  const worldLayers = createWorldLayers();

  worldContainer.addChild(worldLayers.root);
  app.stage.addChild(worldContainer);
  app.stage.addChild(uiContainer);

  worldLayers.root.position.set(0, 0);
  worldContainer.position.set(0, 0);
  uiContainer.position.set(0, 0);
  app.renderer.resize(config.width, config.height);

  return { app, worldContainer, uiContainer, worldLayers, uiRightWidth: 0 };
}
