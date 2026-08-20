import os

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "fonts")

# ---------------------------------------------------------------------------
# Palette - exact RGB values of the kiosk's Tailwind hex classes, so a color
# picked up from a frame here matches one picked up from the browser.
# ---------------------------------------------------------------------------
BG_BLACK   = (0, 3, 7)        # #000307 - kiosk page background
BLUE       = (51, 125, 255)   # #337DFF - primary accent / borders
BLUE_LIGHT = (102, 158, 255)  # #669EFF - secondary text on dark panels
GREEN      = (0, 255, 136)    # #00FF88 - success / secured / online dot
RED        = (255, 51, 51)    # #FF3333 - alarm / failure
AMBER      = (255, 184, 92)   # warning tone in the same family as the reds/blues
WHITE      = (255, 255, 255)
GREY       = (170, 189, 221)  # #aabddd - kiosk body text on dark panels
DIM        = (90, 105, 130)   # low-emphasis labels / inactive dots


_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def _font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    key = (weight, size)
    cached = _FONT_CACHE.get(key)
    if cached is None:
        path = os.path.join(FONT_DIR, f"JetBrainsMono-{weight}.ttf")
        cached = ImageFont.truetype(path, size)
        _FONT_CACHE[key] = cached
    return cached


class Canvas:
    """One PIL drawing pass over a single BGR video frame.

    Shapes needing translucency (panels) draw into an RGBA overlay composited
    once at the end; opaque shapes (borders, dots, lines, text) draw straight
    onto the base image. `finish()` returns a plain BGR numpy frame, ready for
    cv2.imencode or cv2.imshow exactly like the frame that came in.
    """

    def __init__(self, frame_bgr: np.ndarray):
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        self.image = Image.fromarray(rgb).convert("RGBA")
        self.draw = ImageDraw.Draw(self.image)
        self.w, self.h = self.image.size

    # -- panels ---------------------------------------------------------
    def panel(self, xy, fill=BG_BLACK, fill_alpha=170, outline=BLUE, width=1, corners=True, corner_len=10):
        """Bordered translucent panel with small corner accent brackets -
        mirrors the `border border-[#337DFF] bg-[#000307]/80` + corner-accent
        pattern used throughout the React kiosk (KioskBadge, AuthModal, ...).

        Blended into `self.image` immediately (a scratch overlay the size of
        the panel, alpha-composited right here) rather than deferred to a
        single overlay resolved at the very end - deferring it would put every
        panel visually on top of everything else regardless of the order
        callers actually drew things in, which is what caused an opaque button
        fill to silently erase the label drawn "after" it in code but doomed to
        sit underneath the same end-of-frame overlay.
        """
        x0, y0, x1, y1 = xy
        if fill is not None:
            scratch = Image.new("RGBA", self.image.size, (0, 0, 0, 0))
            ImageDraw.Draw(scratch).rectangle(xy, fill=(*fill, fill_alpha))
            self.image = Image.alpha_composite(self.image, scratch)
            self.draw = ImageDraw.Draw(self.image)
        if outline is not None:
            self.draw.rectangle(xy, outline=outline, width=width)
        if corners and outline is not None:
            cl = corner_len
            for cx, cy, dx, dy in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
                self.draw.line([(cx, cy), (cx + dx * cl, cy)], fill=outline, width=max(1, width + 1))
                self.draw.line([(cx, cy), (cx, cy + dy * cl)], fill=outline, width=max(1, width + 1))

    def rect(self, xy, fill=None, outline=None, width=1):
        if fill is not None:
            self.draw.rectangle(xy, fill=fill)
        if outline is not None:
            self.draw.rectangle(xy, outline=outline, width=width)

    def line(self, xy, fill, width=1):
        self.draw.line(xy, fill=fill, width=width)

    def ellipse(self, xy, fill=None, outline=None, width=1):
        self.draw.ellipse(xy, fill=fill, outline=outline, width=width)

    # -- text -------------------------------------------------------------
    def text(self, xy, text, size=16, color=WHITE, weight="Regular", tracking=0, anchor="la"):
        """Draws `text` as given - callers decide case. Tracking (extra pixels
        between glyphs) has no PIL equivalent, so a tracked string is placed
        glyph-by-glyph by hand; untracked strings use PIL's own layout.
        """
        font = _font(weight, size)
        if tracking == 0:
            self.draw.text(xy, text, font=font, fill=color, anchor=anchor)
            return
        x, y = xy
        va = anchor[1] if len(anchor) > 1 else "a"
        for ch in text:
            self.draw.text((x, y), ch, font=font, fill=color, anchor="l" + va)
            x += self.draw.textlength(ch, font=font) + tracking

    def text_size(self, text, size=16, weight="Regular", tracking=0):
        font = _font(weight, size)
        if tracking == 0:
            l, t, r, b = self.draw.textbbox((0, 0), text, font=font)
            return r - l, b - t
        width = sum(self.draw.textlength(ch, font=font) + tracking for ch in text)
        return (width - tracking if text else 0), size

    def centered_text(self, cx, y, text, size=16, color=WHITE, weight="Regular", tracking=0):
        w, _ = self.text_size(text, size, weight, tracking)
        self.text((cx - w / 2, y), text, size=size, color=color, weight=weight, tracking=tracking)

    # -- output -------------------------------------------------------------
    def finish(self) -> np.ndarray:
        rgb = self.image.convert("RGB")
        return cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)
