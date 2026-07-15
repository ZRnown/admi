import argparse
from pathlib import Path

import cv2
import numpy as np


def read_image(path: str, flags: int):
    # cv2.imread cannot reliably open non-ASCII Windows paths.
    data = np.fromfile(path, dtype=np.uint8)
    return cv2.imdecode(data, flags)


def write_image(path: Path, image) -> None:
    extension = path.suffix or ".png"
    success, encoded = cv2.imencode(extension, image)
    if not success:
        raise RuntimeError(f"Unable to encode output image: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded.tofile(str(path))


def warm_hybrid_repair(image, binary_mask):
    height, width = image.shape[:2]
    scale = max(height, width)
    dilation_radius = int(np.clip(round(scale / 470), 2, 8))
    dilation_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (dilation_radius * 2 + 1, dilation_radius * 2 + 1),
    )
    repair_mask = cv2.dilate(binary_mask, dilation_kernel) > 0

    median_size = int(np.clip(round(scale / 23.5), 31, 151))
    if median_size % 2 == 0:
        median_size += 1
    background = cv2.medianBlur(image, median_size)
    result = image.copy()
    result[repair_mask] = background[repair_mask]

    blue, green, red = cv2.split(image)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    safe_red = np.maximum(red.astype(np.float32), 1)
    neutral_dark = (
        (gray < 190)
        & ((blue.astype(np.float32) / safe_red) > 0.50)
        & ((green.astype(np.float32) / safe_red) > 0.68)
        & (binary_mask == 0)
        & repair_mask
    )
    result[neutral_dark] = image[neutral_dark]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Inpaint a masked image with OpenCV.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--mask", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", choices=("inpaint", "warm-hybrid"), default="inpaint")
    args = parser.parse_args()

    image = read_image(args.image, cv2.IMREAD_COLOR)
    mask = read_image(args.mask, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RuntimeError(f"Unable to read image: {args.image}")
    if mask is None:
        raise RuntimeError(f"Unable to read mask: {args.mask}")

    if mask.shape[:2] != image.shape[:2]:
        mask = cv2.resize(mask, (image.shape[1], image.shape[0]), interpolation=cv2.INTER_NEAREST)
    _, binary_mask = cv2.threshold(mask, 1, 255, cv2.THRESH_BINARY)
    result = (
        warm_hybrid_repair(image, binary_mask)
        if args.mode == "warm-hybrid"
        else cv2.inpaint(image, binary_mask, 5, cv2.INPAINT_TELEA)
    )

    output = Path(args.output)
    write_image(output, result)


if __name__ == "__main__":
    main()
