import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { SimClock, SimTime } from "../sim/time";
import { getSpeedMultiplier } from "../sim/time";
import type { Renderer } from "./renderer";

const HUD_BG = 0x0f1826;
const HUD_BORDER = 0x1f2d43;
const HUD_TEXT = 0xe6edf3;
const HUD_PADDING = 8;
const HUD_MARGIN = 10;

const FONT_FAMILY = "Fira Sans, Noto Sans, Helvetica Neue, Helvetica, Arial, sans-serif";
const FONT_SIZE = 12;

export interface TimeHud {
  update: (time: SimTime, clock: SimClock) => void;
}

export function attachTimeHud(renderer: Renderer): TimeHud {
  const container = new Container();
  container.name = "TimeHud";
  container.position.set(HUD_MARGIN, HUD_MARGIN);
  renderer.uiContainer.addChild(container);

  const background = new Graphics();
  const textStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fill: HUD_TEXT,
    lineHeight: Math.round(FONT_SIZE * 1.4),
  });
  const text = new Text("", textStyle);
  text.resolution = renderer.app.renderer.resolution;
  container.addChild(background);
  container.addChild(text);

  let lastText = "";

  const update = (time: SimTime, clock: SimClock): void => {
    const nextText = [
      `Time ${formatClock(time.elapsedMs)}`,
      `Speed x${formatSpeed(getSpeedMultiplier(clock))}`,
      "Keys [ ] or 1-8",
    ].join("\n");
    if (nextText === lastText) {
      return;
    }
    lastText = nextText;
    text.text = nextText;
    layoutHud(container, background, text);
  };

  return { update };
}

function layoutHud(container: Container, background: Graphics, text: Text): void {
  const bounds = text.getLocalBounds();
  const width = bounds.width + HUD_PADDING * 2;
  const height = bounds.height + HUD_PADDING * 2;

  text.position.set(HUD_PADDING, HUD_PADDING);
  background.clear();
  background.beginFill(HUD_BG, 0.9);
  background.lineStyle(1, HUD_BORDER, 0.9);
  background.drawRoundedRect(0, 0, width, height, 6);
  background.endFill();

  container.hitArea = null;
}

function formatClock(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function formatSpeed(speed: number): string {
  if (Number.isInteger(speed)) {
    return `${speed}`;
  }
  return speed.toFixed(1).replace(/\.0$/, "");
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
