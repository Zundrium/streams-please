import type { VideoMarginRatio } from 'tauri-plugin-libmpv-api';

export type ViewportRect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

export type InlinePlacement = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export const HIDDEN_VIDEO_MARGINS = { left: 0, right: 0, top: 1, bottom: 0 } as const satisfies VideoMarginRatio;

export function viewportMargins(rect: ViewportRect, width: number, height: number): VideoMarginRatio {
  return {
    left: Math.max(0, rect.left / width),
    right: Math.max(0, (width - rect.right) / width),
    top: Math.max(0, rect.top / height),
    bottom: Math.max(0, (height - rect.bottom) / height)
  };
}

export function relativePlacement(
  anchor: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  host: Pick<DOMRect, 'left' | 'top'>
): InlinePlacement {
  return {
    left: anchor.left - host.left,
    top: anchor.top - host.top,
    width: anchor.width,
    height: anchor.height
  };
}

export const PLAYER_EDGE_PX = 6;

export function isPointerAtEdge(
  rect: ViewportRect,
  x: number,
  y: number,
  edge = PLAYER_EDGE_PX
): boolean {
  return (
    x - rect.left <= edge ||
    rect.right - x <= edge ||
    y - rect.top <= edge ||
    rect.bottom - y <= edge
  );
}
