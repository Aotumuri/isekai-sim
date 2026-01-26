import type { Vec2 } from "../../utils/vector";
import type { Renderer } from "../renderer";

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const ZOOM_INTENSITY = 0.0015;

export function attachViewControls(renderer: Renderer): void {
  const view = renderer.app.view as HTMLCanvasElement;
  view.style.touchAction = "none";

  let isDragging = false;
  let lastPointer: Vec2 | null = null;

  const isWorldPointer = (screenX: number): boolean => {
    const worldWidth = renderer.app.screen.width - renderer.uiRightWidth;
    return screenX <= worldWidth;
  };

  const stopDrag = (): void => {
    isDragging = false;
    lastPointer = null;
  };

  renderer.app.stage.eventMode = "static";
  renderer.app.stage.hitArea = renderer.app.screen;

  renderer.app.stage.on("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    if (!isWorldPointer(event.global.x)) {
      return;
    }

    isDragging = true;
    lastPointer = { x: event.global.x, y: event.global.y };
  });

  renderer.app.stage.on("pointerup", stopDrag);
  renderer.app.stage.on("pointerupoutside", stopDrag);
  renderer.app.stage.on("pointermove", (event) => {
    if (!isDragging || !lastPointer) {
      return;
    }

    const current = { x: event.global.x, y: event.global.y };
    const dx = current.x - lastPointer.x;
    const dy = current.y - lastPointer.y;
    renderer.worldContainer.position.x += dx;
    renderer.worldContainer.position.y += dy;
    lastPointer = current;
  });

  view.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();

      const rect = view.getBoundingClientRect();
      const screenPos = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (!isWorldPointer(screenPos.x)) {
        return;
      }
      const currentScale = renderer.worldContainer.scale.x;
      const zoomFactor = Math.exp(-event.deltaY * ZOOM_INTENSITY);
      const nextScale = clamp(currentScale * zoomFactor, MIN_SCALE, MAX_SCALE);
      if (nextScale === currentScale) {
        return;
      }

      const worldX = (screenPos.x - renderer.worldContainer.position.x) / currentScale;
      const worldY = (screenPos.y - renderer.worldContainer.position.y) / currentScale;

      renderer.worldContainer.scale.set(nextScale);
      renderer.worldContainer.position.set(
        screenPos.x - worldX * nextScale,
        screenPos.y - worldY * nextScale,
      );
    },
    { passive: false },
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
