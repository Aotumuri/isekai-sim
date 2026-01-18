import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { Vec2 } from "../../utils/vector";

const PANEL_BG = 0x0f1826;
const PANEL_BORDER = 0x1f2d43;
const PANEL_TEXT = 0xe6edf3;
const PANEL_ACCENT = 0x7aa2ff;
const PANEL_PADDING = 10;
const PANEL_OFFSET = 12;

const FONT_FAMILY = "Fira Sans, Noto Sans, Helvetica Neue, Helvetica, Arial, sans-serif";
const FONT_SIZE = 13;

export interface RegionHoverPanel {
  container: Container;
  setText: (value: string) => void;
  position: (screenPos: Vec2, screenSize: { width: number; height: number }) => void;
  show: () => void;
  hide: () => void;
}

export function createRegionHoverPanel(resolution: number): RegionHoverPanel {
  const panel = new Container();
  const background = new Graphics();
  const textStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fill: PANEL_TEXT,
    lineHeight: Math.round(FONT_SIZE * 1.4),
  });
  const text = new Text("", textStyle);
  text.resolution = resolution;
  panel.addChild(background);
  panel.addChild(text);
  panel.visible = false;

  const setText = (value: string): void => {
    text.text = value;
    layoutPanel(panel, background, text);
  };

  const position = (screenPos: Vec2, screenSize: { width: number; height: number }): void => {
    const bounds = panel.getLocalBounds();
    const desiredX = screenPos.x + PANEL_OFFSET;
    const desiredY = screenPos.y + PANEL_OFFSET;
    const maxX = screenSize.width - bounds.width - PANEL_OFFSET;
    const maxY = screenSize.height - bounds.height - PANEL_OFFSET;
    const x = Math.min(maxX, Math.max(PANEL_OFFSET, desiredX));
    const y = Math.min(maxY, Math.max(PANEL_OFFSET, desiredY));
    panel.position.set(x, y);
  };

  return {
    container: panel,
    setText,
    position,
    show: () => {
      panel.visible = true;
    },
    hide: () => {
      panel.visible = false;
    },
  };
}

function layoutPanel(panel: Container, background: Graphics, text: Text): void {
  const bounds = text.getLocalBounds();
  const width = bounds.width + PANEL_PADDING * 2;
  const height = bounds.height + PANEL_PADDING * 2;

  text.position.set(PANEL_PADDING, PANEL_PADDING);
  background.clear();
  background.beginFill(PANEL_BG, 0.94);
  background.lineStyle(1, PANEL_BORDER, 0.9);
  background.drawRoundedRect(0, 0, width, height, 8);
  background.endFill();
  background.lineStyle(1, PANEL_ACCENT, 0.8);
  background.moveTo(PANEL_PADDING, PANEL_PADDING + bounds.height + 4);
  background.lineTo(width - PANEL_PADDING, PANEL_PADDING + bounds.height + 4);

  panel.hitArea = null;
}
