"""
Generates a synthetic architect-style floor plan PNG so blueprint_to_grid.py can be
proven end-to-end before a real scanned/drawn blueprint is available.

Deliberately includes the kinds of clutter a real plan has, so the cleanup stages in
blueprint_to_grid.py (blob removal, morphological close) are actually exercised:
  - three rooms with door GAPS cut into the interior walls (not just solid boxes)
  - room label text ("LIVING ROOM", etc.) -- must NOT survive as walls
  - a dimension line + tick marks + measurement text below the building -- must NOT
    survive as walls either

Walls are drawn solid/poché-style (filled, not thin double lines) since that is the
easiest case for the threshold-based converter -- see the plan's "Set honest
expectations" section for why thin double-line walls are harder.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WALL = (20, 20, 20)
BG = (255, 255, 255)
WALL_THICKNESS = 10


def rect_wall(draw, x0, y0, x1, y1):
    draw.rectangle([x0, y0, x1, y1], fill=WALL)


def h_wall_with_gap(draw, x0, x1, y, thickness, gap_x0, gap_x1):
    """Horizontal wall centered on y, with a door gap between gap_x0 and gap_x1."""
    half = thickness // 2
    rect_wall(draw, x0, y - half, gap_x0, y + half)
    rect_wall(draw, gap_x1, y - half, x1, y + half)


def v_wall_with_gap(draw, x, y0, y1, thickness, gap_y0, gap_y1):
    """Vertical wall centered on x, with a door gap between gap_y0 and gap_y1."""
    half = thickness // 2
    rect_wall(draw, x - half, y0, x + half, gap_y0)
    rect_wall(draw, x - half, gap_y1, x + half, y1)


def label(draw, text, cx, cy, size=26):
    font = ImageFont.load_default(size=size)
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - w / 2, cy - h / 2), text, fill=(60, 60, 60), font=font)


def build(out_path: Path):
    W, H = 1200, 950
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Building footprint
    bx0, by0, bx1, by1 = 100, 100, 1100, 800
    t = WALL_THICKNESS

    # Exterior wall (rectangle outline)
    draw.rectangle([bx0, by0, bx1, by1], outline=WALL, width=t)

    # Interior wall #1: vertical split at x=600, full height, door gap near y=385-475.
    # (90px gap, not 60 -- morphological closing in blueprint_to_grid.py eats ~2-3
    # grid cells off each gap's edges to seal double-line walls elsewhere, so a
    # gap needs real margin above the player's diameter to survive as passable.)
    v_wall_with_gap(draw, 600, by0, by1, t, 385, 475)

    # Interior wall #2: horizontal split in the right half at y=450, door gap near x=785-875
    h_wall_with_gap(draw, 600, bx1, 450, t, 785, 875)

    # Room labels -- pure noise from the converter's point of view
    label(draw, "LIVING ROOM", (bx0 + 600) // 2, (by0 + by1) // 2)
    label(draw, "BEDROOM", (600 + bx1) // 2, (by0 + 450) // 2)
    label(draw, "KITCHEN", (600 + bx1) // 2, (450 + by1) // 2)

    # Dimension line + ticks + measurement text below the building -- more noise
    dim_y = by1 + 30
    draw.line([(bx0, dim_y), (bx1, dim_y)], fill=(80, 80, 80), width=2)
    draw.line([(bx0, dim_y - 8), (bx0, dim_y + 8)], fill=(80, 80, 80), width=2)
    draw.line([(bx1, dim_y - 8), (bx1, dim_y + 8)], fill=(80, 80, 80), width=2)
    label(draw, "12.0 m", (bx0 + bx1) // 2, dim_y + 25, size=18)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f"Wrote sample blueprint: {out_path} ({W}x{H})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="blueprints/sample_plan.png",
                         help="Output PNG path (default: blueprints/sample_plan.png)")
    args = parser.parse_args()
    build(Path(args.out))
