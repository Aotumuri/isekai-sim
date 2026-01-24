import { type Container } from "pixi.js";

export function clearLayer(layer: Container): void {
  const children = layer.removeChildren();
  for (const child of children) {
    child.destroy({ children: true });
  }
}
