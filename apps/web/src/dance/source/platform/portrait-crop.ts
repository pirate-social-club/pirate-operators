/** The camera preview and the recorded file use the same centered 9:16 cover. */
export const PORTRAIT_WIDTH = 720;
export const PORTRAIT_HEIGHT = 1280;

export interface PortraitCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function isPortraitFrame(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width * 16 === height * 9
  );
}

export function portraitCoverCrop(width: number, height: number): PortraitCrop {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("Camera frame dimensions are unavailable");
  }
  const targetRatio = PORTRAIT_WIDTH / PORTRAIT_HEIGHT;
  if (width / height > targetRatio) {
    const cropWidth = height * targetRatio;
    return { x: (width - cropWidth) / 2, y: 0, width: cropWidth, height };
  }
  const cropHeight = width / targetRatio;
  return { x: 0, y: (height - cropHeight) / 2, width, height: cropHeight };
}
