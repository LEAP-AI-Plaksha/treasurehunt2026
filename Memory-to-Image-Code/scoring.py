"""
Multi-metric image similarity scoring engine for the Memory to Image game.
Scores images across three dimensions:
  1. Content   (CLIP cosine similarity)  — Are the right objects/scenes present?
  2. Structure (SSIM)                    — Is the layout/composition similar?
  3. Color     (Histogram correlation)   — Are the colors/tones similar?
"""

import warnings
import numpy as np
import torch
from PIL import Image
from transformers import CLIPProcessor, CLIPModel
from skimage.metrics import structural_similarity as ssim

import config

warnings.filterwarnings("ignore", category=UserWarning)

WEIGHT_CONTENT = 0.40
WEIGHT_STRUCTURE = 0.35
WEIGHT_COLOR = 0.25

print(f"[scoring] Loading CLIP model: {config.CLIP_MODEL_NAME} ...")
try:
    _model = CLIPModel.from_pretrained(config.CLIP_MODEL_NAME)
    _processor = CLIPProcessor.from_pretrained(config.CLIP_MODEL_NAME)
    _model.eval()
    print("[scoring] CLIP model ready.")
except Exception as exc:
    print(f"[scoring] ERROR loading CLIP model: {exc}")
    _model = None
    _processor = None


def compute_clip_similarity(image_path1: str, image_path2: str) -> float:
    if _model is None or _processor is None:
        return 0.0

    try:
        img1 = Image.open(image_path1).convert("RGB")
        img2 = Image.open(image_path2).convert("RGB")
        with torch.no_grad():
            inputs1 = _processor(images=img1, return_tensors="pt")
            inputs2 = _processor(images=img2, return_tensors="pt")

            features1 = _model.get_image_features(**inputs1)
            features2 = _model.get_image_features(**inputs2)

            if not isinstance(features1, torch.Tensor):
                features1 = getattr(features1, "pooler_output", features1)
            if not isinstance(features2, torch.Tensor):
                features2 = getattr(features2, "pooler_output", features2)

            features1 = features1 / features1.norm(p=2, dim=-1, keepdim=True)
            features2 = features2 / features2.norm(p=2, dim=-1, keepdim=True)
            similarity = (features1 @ features2.T).item()

        return max(0.0, min(1.0, similarity))
    except Exception as exc:
        print(f"[scoring] CLIP error: {exc}")
        return 0.0


def compute_ssim(image_path1: str, image_path2: str) -> float:
    try:
        size = (256, 256)
        img1 = Image.open(image_path1).convert("L").resize(size, Image.LANCZOS)
        img2 = Image.open(image_path2).convert("L").resize(size, Image.LANCZOS)
        arr1 = np.array(img1, dtype=np.float64) / 255.0
        arr2 = np.array(img2, dtype=np.float64) / 255.0
        return max(0.0, min(1.0, float(ssim(arr1, arr2, data_range=1.0))))
    except Exception as exc:
        print(f"[scoring] SSIM error: {exc}")
        return 0.0


def _rgb_to_hsv(rgb: np.ndarray):
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    maxc = np.maximum(np.maximum(r, g), b)
    minc = np.minimum(np.minimum(r, g), b)
    diff = maxc - minc

    h = np.zeros_like(maxc)
    mask = diff > 0
    idx = (maxc == r) & mask
    h[idx] = (60 * ((g[idx] - b[idx]) / diff[idx]) % 360) / 360.0
    idx = (maxc == g) & mask
    h[idx] = (60 * ((b[idx] - r[idx]) / diff[idx]) + 120) / 360.0
    idx = (maxc == b) & mask
    h[idx] = (60 * ((r[idx] - g[idx]) / diff[idx]) + 240) / 360.0

    s = np.zeros_like(maxc)
    s[maxc > 0] = diff[maxc > 0] / maxc[maxc > 0]
    return h, s, maxc


def _hist_corr(a: np.ndarray, b: np.ndarray, bins: int = 32) -> float:
    ha, _ = np.histogram(a.ravel(), bins=bins, range=(0.0, 1.0))
    hb, _ = np.histogram(b.ravel(), bins=bins, range=(0.0, 1.0))
    ha = ha.astype(np.float64) - ha.mean()
    hb = hb.astype(np.float64) - hb.mean()
    denom = np.sqrt(np.sum(ha ** 2) * np.sum(hb ** 2))
    if denom < 1e-10:
        return 1.0
    return float(np.sum(ha * hb) / denom)


def compute_color_similarity(image_path1: str, image_path2: str) -> float:
    try:
        size = (256, 256)
        img1 = Image.open(image_path1).convert("RGB").resize(size, Image.LANCZOS)
        img2 = Image.open(image_path2).convert("RGB").resize(size, Image.LANCZOS)

        arr1 = np.array(img1, dtype=np.float64) / 255.0
        arr2 = np.array(img2, dtype=np.float64) / 255.0

        h1, s1, v1 = _rgb_to_hsv(arr1)
        h2, s2, v2 = _rgb_to_hsv(arr2)

        corr = (
            0.45 * _hist_corr(h1, h2)
            + 0.25 * _hist_corr(s1, s2)
            + 0.30 * _hist_corr(v1, v2)
        )
        return max(0.0, min(1.0, (corr + 1.0) / 2.0))
    except Exception as exc:
        print(f"[scoring] Color similarity error: {exc}")
        return 0.0


def compute_combined_score(image_path1: str, image_path2: str) -> dict:
    content = compute_clip_similarity(image_path1, image_path2)
    structure = compute_ssim(image_path1, image_path2)
    color = compute_color_similarity(image_path1, image_path2)

    combined = (
        WEIGHT_CONTENT * content
        + WEIGHT_STRUCTURE * structure
        + WEIGHT_COLOR * color
    )

    floor, ceiling = 0.25, 0.85
    raw = (combined - floor) / (ceiling - floor) * 10
    score = int(max(0, min(10, round(raw))))

    return {
        "content": round(content, 4),
        "structure": round(structure, 4),
        "color": round(color, 4),
        "combined": round(combined, 4),
        "content_pct": round(content * 100, 1),
        "structure_pct": round(structure * 100, 1),
        "color_pct": round(color * 100, 1),
        "combined_pct": round(combined * 100, 1),
        "score": score,
    }
