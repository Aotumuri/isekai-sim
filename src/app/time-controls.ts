import {
  SPEED_MULTIPLIERS,
  decreaseSpeed,
  increaseSpeed,
  setSpeedIndex,
  type SimClock,
} from "../sim/time";

const DIGIT_PREFIX = "Digit";

export function attachTimeControls(clock: SimClock): void {
  window.addEventListener("keydown", (event) => {
    if (event.code === "BracketRight") {
      if (increaseSpeed(clock)) {
        event.preventDefault();
      }
      return;
    }

    if (event.code === "BracketLeft") {
      if (decreaseSpeed(clock)) {
        event.preventDefault();
      }
      return;
    }

    if (event.code.startsWith(DIGIT_PREFIX)) {
      const digit = Number(event.code.slice(DIGIT_PREFIX.length));
      if (!Number.isNaN(digit)) {
        const index = digit - 1;
        if (index >= 0 && index < SPEED_MULTIPLIERS.length) {
          if (setSpeedIndex(clock, index)) {
            event.preventDefault();
          }
        }
      }
    }
  });
}
