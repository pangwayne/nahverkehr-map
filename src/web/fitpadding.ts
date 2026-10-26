// The padding for fitting the map around the panel. Pure (no DOM), so it is unit tested; mapfit.ts measures.

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// Room around the fitted things, at most this much, less when the free part of the map is small.
const MARGIN_PX = 40;
const MIN_MARGIN_PX = 8;
// MapLibre needs some room left between the paddings, or it cannot fit and jumps to a world view.
export const MIN_ROOM_PX = 40;
// Less free map than this above a tall phone sheet: the sheet goes back to its normal size first.
export const MIN_FREE_PX = 120;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Padding for a map of `width` x `height` whose bottom `cover.bottom` px (phones) or left `cover.left` px
// (wide screens) the panel covers. Never more than the map can give: always MIN_ROOM_PX left in each direction.
export function fitPadding(width: number, height: number, cover: { bottom: number; left: number }): Padding {
  const freeH = Math.max(0, height - cover.bottom);
  const freeW = Math.max(0, width - cover.left);
  const my = clamp(freeH / 6, MIN_MARGIN_PX, MARGIN_PX);
  const mx = clamp(freeW / 6, MIN_MARGIN_PX, MARGIN_PX);
  const top = Math.min(my, Math.max(0, height - MIN_ROOM_PX));
  const right = Math.min(mx, Math.max(0, width - MIN_ROOM_PX));
  const bottom = Math.max(0, Math.min(cover.bottom + my, height - top - MIN_ROOM_PX));
  const left = Math.max(0, Math.min(cover.left + mx, width - right - MIN_ROOM_PX));
  return { top, right, bottom, left };
}
