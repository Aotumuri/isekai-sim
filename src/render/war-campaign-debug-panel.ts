import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { Renderer } from "./renderer";
import type { WorldState } from "../sim/world-state";
import { formatCampaignDebugLines } from "./war-campaign-debug-summary";

const NAME = "WarCampaignDebugPanel";

/** Screen-space detail stays visible when the normal map is panned or zoomed. */
export function drawCampaignDebugPanel(renderer: Renderer, world: WorldState, shown: boolean): void {
  const previous = renderer.uiContainer.getChildByName(NAME);
  if (previous) { renderer.uiContainer.removeChild(previous); previous.destroy({ children: true }); }
  if (!shown || !world.settings?.warCampaignEnabled) return;
  const lines = formatCampaignDebugLines(world, 1);
  if (!lines.length) lines.push("NATIONAL WAR CAMPAIGNS", "No active war plan.");
  const text = new Text(["Experimental strategy · evaluation in progress", ...lines].join("\n"), new TextStyle({
    fontFamily: "Fira Sans, Noto Sans, Helvetica Neue, Helvetica, Arial, sans-serif",
    fontSize: 11, fill: 0xe6edff, wordWrap: true, wordWrapWidth: 480,
  }));
  text.resolution = renderer.app.renderer.resolution;
  text.position.set(8, 6);
  const bounds = text.getLocalBounds();
  const background = new Graphics();
  background.beginFill(0x081018, 0.94);
  background.lineStyle(1, 0xb388ff, 0.95);
  background.drawRoundedRect(0, 0, bounds.width + 16, bounds.height + 12, 5);
  background.endFill();
  const panel = new Container(); panel.name = NAME; panel.eventMode = "none";
  panel.position.set(8, 140); panel.addChild(background, text);
  renderer.uiContainer.addChild(panel);
}
