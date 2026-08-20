import cv2
import numpy as np
from collections import deque
import urllib.request
import os

# ── Download the YuNet face detector model (only once) ───────────────────────
# Note: this replaces the original MediaPipe FaceLandmarker pipeline, which
# crashes at graph-init time on this machine (native "DrishtiMetalHelper /
# Service is unavailable" abort inside mediapipe's TensorsToDetectionsCalculator
# regardless of CPU/GPU delegate settings). YuNet is a lightweight OpenCV DNN
# face detector that also reports a nose-tip landmark directly, so it's a
# drop-in replacement for the one landmark this script needs.
MODEL_PATH = os.path.join(os.path.dirname(__file__), "face_detection_yunet_2023mar.onnx")
MODEL_URL  = (
    "https://github.com/opencv/opencv_zoo/raw/main/"
    "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
if not os.path.exists(MODEL_PATH):
    print("Downloading YuNet face detector model (~230 KB) …")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    print("Download complete.")

face_detector = cv2.FaceDetectorYN_create(
    MODEL_PATH, "", (320, 320), score_threshold=0.6
)

# ── Trail / state ─────────────────────────────────────────────────────────────
trail          = deque(maxlen=120)   # longer trail so you can draw the M
current_state  = "DRAWING"
smoothed_nose  = None   # (x, y) exponential moving average of the raw detection
SMOOTHING      = 0.4    # lower = smoother/laggier, higher = snappier/jitterier


# ── Cat-shape guide to draw on screen ────────────────────────────────────────
def cat_guide_points(cx, cy, w=220, h=130):
    r"""
    Returns a list of (x,y) points that form a simplified cat-head
    outline: two ear peaks (M shape).
         *       *
        / \     / \
       /   \   /   \
      /     ---     \
    left    dip    right
    """
    lx = cx - w // 2    # left base
    rx = cx + w // 2    # right base
    le = cx - w // 4    # left ear tip
    re = cx + w // 4    # right ear tip
    dip_y = cy          # centre dip y
    ear_y = cy - h      # ear tip y (up on screen = smaller y)

    pts = []
    # left base → left ear tip → centre dip → right ear tip → right base
    segments = [
        (lx, dip_y), (le, ear_y), (cx, dip_y), (re, ear_y), (rx, dip_y)
    ]
    for i in range(len(segments) - 1):
        x0, y0 = segments[i]
        x1, y1 = segments[i + 1]
        for t in np.linspace(0, 1, 40):
            pts.append((int(x0 + t * (x1 - x0)), int(y0 + t * (y1 - y0))))
    return pts


def detect_cat_shape(points):
    """
    Detect an "M" / cat-ear shape:
      - two upward peaks separated by a downward valley
      - big enough span in both axes
      - peaks are clearly higher (smaller y) than start/end/middle
    """
    if len(points) < 40:
        return False

    ys = np.array([p[1] for p in points])
    xs = np.array([p[0] for p in points])

    # Span checks
    if xs.max() - xs.min() < 80:   # not wide enough
        return False
    if ys.max() - ys.min() < 50:   # not tall enough
        return False

    # Smooth the y signal to reduce noise
    kernel = np.ones(7) / 7
    ys_smooth = np.convolve(ys, kernel, mode='valid')

    n = len(ys_smooth)

    # Find local minima in smoothed y (= peaks on screen, since y↓ = up)
    peaks = []
    for i in range(1, n - 1):
        if ys_smooth[i] < ys_smooth[i - 1] and ys_smooth[i] < ys_smooth[i + 1]:
            peaks.append(i)

    if len(peaks) < 2:
        return False

    # Keep the two most prominent peaks (lowest y values = highest on screen)
    peaks.sort(key=lambda i: ys_smooth[i])
    peak1, peak2 = sorted(peaks[:2])   # sort by position (left → right)

    # The two peaks must be separated by at least 20% of the path
    if (peak2 - peak1) < n * 0.15:
        return False

    # There must be a valley BETWEEN the two peaks
    valley_y = ys_smooth[peak1:peak2].max()
    if valley_y < ys_smooth[peak1] + 20 or valley_y < ys_smooth[peak2] + 20:
        return False  # no real dip between the ears

    # Both peaks should be meaningfully above the overall mean
    mean_y = ys_smooth.mean()
    if ys_smooth[peak1] > mean_y - 20 or ys_smooth[peak2] > mean_y - 20:
        return False

    return True


# ── Webcam ────────────────────────────────────────────────────────────────────
cap = cv2.VideoCapture(0)

if not cap.isOpened():
    print(
        "\nCouldn't open the webcam.\n"
        "This is almost always a macOS camera-permission issue, not a bug:\n"
        "  1. Open System Settings -> Privacy & Security -> Camera\n"
        "  2. Make sure the app you're running this from (Terminal, iTerm, "
        "VS Code, etc.) is toggled ON\n"
        "  3. If it's not listed at all, run this script again -- macOS "
        "should prompt you the first time it tries to access the camera\n"
        "  4. Then re-run this script\n"
    )
    raise SystemExit(1)

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break

    frame   = cv2.flip(frame, 1)
    h, w, _ = frame.shape

    face_detector.setInputSize((w, h))
    _, faces = face_detector.detect(frame)

    if faces is not None:
        face         = faces[0]     # highest-scoring face
        raw_nx, raw_ny = face[8], face[9]   # nose-tip landmark (x, y)

        if smoothed_nose is None:
            smoothed_nose = (raw_nx, raw_ny)
        else:
            smoothed_nose = (
                SMOOTHING * raw_nx + (1 - SMOOTHING) * smoothed_nose[0],
                SMOOTHING * raw_ny + (1 - SMOOTHING) * smoothed_nose[1],
            )
        nx, ny = int(smoothed_nose[0]), int(smoothed_nose[1])

        if current_state == "DRAWING":
            trail.append((nx, ny))

        # Draw the fading trail
        for i in range(1, len(trail)):
            alpha     = i / len(trail)
            thickness = max(1, int(alpha * 6))
            color     = (0, int(255 * alpha), int(100 * alpha))
            cv2.line(frame, trail[i - 1], trail[i], color, thickness)

        # Nose tip dot
        cv2.circle(frame, (nx, ny), 8, (0, 220, 255), -1)
        cv2.circle(frame, (nx, ny), 8, (255, 255, 255), 1)

        # Check cat shape
        if current_state == "DRAWING" and detect_cat_shape(list(trail)):
            current_state = "FORWARD"
            trail.clear()

    # ── Draw ghost cat-ear guide ──────────────────────────────────────────────
    guide_pts = cat_guide_points(w // 2, h // 2 + 30)
    for i in range(1, len(guide_pts)):
        cv2.line(frame, guide_pts[i - 1], guide_pts[i], (80, 80, 200), 1)

    # Label the guide
    cv2.putText(frame, "CAT EARS", (w // 2 - 45, h // 2 - 110),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 80, 200), 1)

    # ── UI text ───────────────────────────────────────────────────────────────
    if current_state == "DRAWING":
        cv2.putText(frame,
                    "Draw CAT EARS (M shape) with your nose!",
                    (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2)
        cv2.putText(frame,
                    "Follow the blue guide: left ear UP, dip, right ear UP",
                    (20, 72), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 255), 1)
    elif current_state == "FORWARD":
        cv2.putText(frame, "MEOW!  CAT RECOGNISED!",
                    (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 200, 255), 3)
        # draw a little ASCII cat
        for idx, line in enumerate(["  /\\_/\\  ", " ( ^.^ ) ", "  > ^ <  "]):
            cv2.putText(frame, line, (20, 100 + idx * 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 200, 100), 2)
        cv2.putText(frame, "Press R to reset",
                    (20, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (200, 200, 200), 1)

    cv2.putText(frame, "Q: quit   R: reset",
                (20, h - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (120, 120, 120), 1)

    cv2.imshow("Cat Drawing Challenge", frame)

    key = cv2.waitKey(1) & 0xFF
    if key == ord("q"):
        break
    elif key == ord("r"):
        current_state = "DRAWING"
        trail.clear()

cap.release()
cv2.destroyAllWindows()