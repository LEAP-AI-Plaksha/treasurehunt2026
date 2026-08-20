import os
import cv2
import numpy as np
import time
from ultralytics import YOLO
from PIL import Image

from hud_theme import Canvas, BLUE, BLUE_LIGHT, GREEN, RED, AMBER, WHITE, GREY, DIM, BG_BLACK

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ==========================================
# CONSTANTS
# ==========================================
# A session is a fixed sequence of poses. Each pose must be held (matched and
# still) for POSE_HOLD_DURATION seconds; clearing REQUIRED_POSES of them wins.
REQUIRED_POSES = 7         # poses that must be cleared for the heist to succeed
POSE_HOLD_DURATION = 10.0  # how long each pose must be held
COUNTDOWN_DURATION = 5.0   # "get into the pose" wait before each pose
POSE_TIME_LIMIT = 30.0     # wall-clock budget per pose before it is marked failed
BREAK_GRACE = 1.0          # pose may be broken this long before the pose fails
RESULT_DISPLAY = 2.0       # how long the per-pose PASS/FAIL card stays up

CONF_THRESHOLD = 0.4
ANGLE_TOLERANCE = 30.0     # deg tolerance around each reference joint angle
AXIS_TOLERANCE = 35.0      # deg tolerance around each reference limb direction
POSE_MATCH_RATIO = 0.8     # fraction of checks that must pass to count as matched
MOTION_LIMIT = 0.055       # per-frame landmark drift, as a fraction of torso length

# Photo shown as the Tree Pose reference. A pose entry can carry either
# "photo" (picture only, targets still come from its authored skeleton) or
# "image" (YOLOv8-pose runs on the picture at startup and *its* joint angles
# become the targets).
REFERENCE_IMAGE = os.path.join(BASE_DIR, "Vrikshasana.jpeg")

# Keypoints are COCO 17 format: kpts[idx][0]=x, [1]=y, [2]=confidence
# 5: L-Shoulder, 6: R-Shoulder, 7: L-Elbow, 8: R-Elbow
# 9: L-Wrist, 10: R-Wrist, 11: L-Hip, 12: R-Hip
# 13: L-Knee, 14: R-Knee, 15: L-Ankle, 16: R-Ankle
JOINTS = [
    ("L-Elbow",  (5, 7, 9)),
    ("R-Elbow",  (6, 8, 10)),
    ("L-Armpit", (11, 5, 7)),
    ("R-Armpit", (12, 6, 8)),
    ("L-Knee",   (11, 13, 15)),
    ("R-Knee",   (12, 14, 16)),
]
# Limb directions, checked as absolute screen angles. Joint angles alone are
# rotation-invariant (a forward fold and a stand have identical elbow/knee
# angles), so these pin the pose's orientation down.
AXES = [
    ("Torso",   (11, 12), (5, 6)),   # hip midpoint -> shoulder midpoint
    ("L-Upper-Arm", (5,), (7,)),
    ("R-Upper-Arm", (6,), (8,)),
    ("L-Forearm", (7,), (9,)),
    ("R-Forearm", (8,), (10,)),
    ("L-Thigh", (11,), (13,)),
    ("R-Thigh", (12,), (14,)),
    ("L-Shin", (13,), (15,)),
    ("R-Shin", (14,), (16,)),
]
STILLNESS_ANCHORS = [0, 5, 6, 9, 10, 11, 12]
SKELETON_EDGES = [
    (5, 6), (5, 7), (7, 9), (6, 8), (8, 10),
    (5, 11), (6, 12), (11, 12),
    (11, 13), (13, 15), (12, 14), (14, 16),
]
MIRROR_PAIRS = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16)]

WINDOW_NAME = "The Louvre: Pose Tracker"

# ==========================================
# POSE LIBRARY
# ==========================================
# Ten medium-difficulty standing yoga poses, each authored as a normalised
# (0..1, square space, y grows downward) front-view skeleton. Angle and limb
# direction targets are derived from these points, so the stick figure the
# player sees is exactly what the matcher checks. Left/right are anatomical
# (the player's left appears on the right of a mirrored feed) but matching is
# mirror-tolerant, so either side of a one-sided pose is accepted.
POSE_LIBRARY = [
    {
        "name": "Five-Pointed Star",
        "sanskrit": "Utthita Tadasana",
        "cue": "Feet wide, arms out and up on a strong diagonal, legs straight.",
        "keypoints": {
            0: (0.500, 0.100),
            5: (0.585, 0.225), 6: (0.415, 0.225),
            7: (0.700, 0.120), 8: (0.300, 0.120),
            9: (0.820, 0.030), 10: (0.180, 0.030),
            11: (0.555, 0.510), 12: (0.445, 0.510),
            13: (0.700, 0.715), 14: (0.300, 0.715),
            15: (0.820, 0.915), 16: (0.180, 0.915),
        },
    },
    {
        "name": "Goddess Pose",
        "sanskrit": "Utkata Konasana",
        "cue": "Wide stance, knees bent out over the toes, arms in a cactus.",
        "keypoints": {
            0: (0.500, 0.130),
            5: (0.590, 0.250), 6: (0.410, 0.250),
            7: (0.730, 0.255), 8: (0.270, 0.255),
            9: (0.755, 0.120), 10: (0.245, 0.120),
            11: (0.560, 0.560), 12: (0.440, 0.560),
            13: (0.710, 0.710), 14: (0.290, 0.710),
            15: (0.755, 0.930), 16: (0.245, 0.930),
        },
    },
    {
        "name": "Warrior II",
        "sanskrit": "Virabhadrasana II",
        "cue": "Wide stance, front knee bent, arms straight out at shoulder height.",
        "keypoints": {
            0: (0.530, 0.115),
            5: (0.585, 0.235), 6: (0.415, 0.235),
            7: (0.730, 0.240), 8: (0.270, 0.240),
            9: (0.875, 0.245), 10: (0.125, 0.245),
            11: (0.555, 0.525), 12: (0.445, 0.525),
            13: (0.700, 0.700), 14: (0.310, 0.740),
            15: (0.745, 0.930), 16: (0.180, 0.930),
        },
    },
    {
        "name": "Reverse Warrior",
        "sanskrit": "Viparita Virabhadrasana",
        "cue": "From Warrior II: front arm sweeps overhead, back hand slides down the thigh.",
        "keypoints": {
            0: (0.475, 0.130),
            5: (0.555, 0.245), 6: (0.400, 0.225),
            7: (0.610, 0.120), 8: (0.355, 0.360),
            9: (0.645, 0.020), 10: (0.330, 0.480),
            11: (0.560, 0.525), 12: (0.450, 0.525),
            13: (0.700, 0.700), 14: (0.315, 0.740),
            15: (0.745, 0.930), 16: (0.185, 0.930),
        },
    },
    {
        "name": "Extended Triangle",
        "sanskrit": "Utthita Trikonasana",
        "cue": "Legs wide and straight, tilt right over the front leg, bottom hand to the shin, top arm straight up.",
        "keypoints": {
            0: (0.640, 0.310),
            5: (0.665, 0.400), 6: (0.585, 0.330),
            7: (0.700, 0.575), 8: (0.550, 0.200),
            9: (0.740, 0.755), 10: (0.520, 0.075),
            11: (0.535, 0.520), 12: (0.465, 0.480),
            13: (0.680, 0.715), 14: (0.300, 0.690),
            15: (0.780, 0.925), 16: (0.190, 0.920),
        },
    },
    {
        "name": "Wide-Legged Forward Fold",
        "sanskrit": "Prasarita Padottanasana",
        "cue": "Feet wide, hinge at the hips, hands down between the feet, legs straight.",
        "keypoints": {
            0: (0.500, 0.640),
            5: (0.545, 0.545), 6: (0.455, 0.545),
            7: (0.560, 0.680), 8: (0.440, 0.680),
            9: (0.555, 0.810), 10: (0.445, 0.810),
            11: (0.560, 0.300), 12: (0.440, 0.300),
            13: (0.680, 0.610), 14: (0.320, 0.610),
            15: (0.790, 0.910), 16: (0.210, 0.910),
        },
    },
    {
        "name": "Standing Crescent Moon",
        "sanskrit": "Indudalasana",
        "cue": "Feet together, arms overhead, bend the whole torso deeply to one side.",
        "keypoints": {
            0: (0.430, 0.155),
            5: (0.520, 0.265), 6: (0.390, 0.240),
            7: (0.440, 0.140), 8: (0.320, 0.135),
            9: (0.340, 0.060), 10: (0.230, 0.085),
            11: (0.575, 0.515), 12: (0.465, 0.515),
            13: (0.560, 0.720), 14: (0.445, 0.720),
            15: (0.560, 0.930), 16: (0.445, 0.930),
        },
    },
    {
        "name": "Tree Pose",
        "sanskrit": "Vrikshasana",
        "cue": "One foot to the inner thigh, knee out to the side, arms overhead.",
        "photo": REFERENCE_IMAGE,
        "keypoints": {
            0: (0.500, 0.135),
            5: (0.580, 0.250), 6: (0.420, 0.250),
            7: (0.560, 0.130), 8: (0.440, 0.130),
            9: (0.510, 0.040), 10: (0.490, 0.040),
            11: (0.555, 0.520), 12: (0.445, 0.520),
            13: (0.560, 0.725), 14: (0.310, 0.640),
            15: (0.560, 0.935), 16: (0.520, 0.640),
        },
    },
    {
        "name": "Standing Figure Four",
        "sanskrit": "Eka Pada Utkatasana",
        "cue": "Cross one ankle over the standing thigh, knee out, hands at the chest.",
        "keypoints": {
            0: (0.500, 0.135),
            5: (0.580, 0.260), 6: (0.420, 0.260),
            7: (0.615, 0.430), 8: (0.385, 0.430),
            9: (0.515, 0.345), 10: (0.485, 0.345),
            11: (0.555, 0.560), 12: (0.445, 0.560),
            13: (0.575, 0.755), 14: (0.330, 0.665),
            15: (0.585, 0.945), 16: (0.520, 0.690),
        },
    },
    {
        "name": "Dancer's Pose",
        "sanskrit": "Natarajasana",
        "cue": "Balance on one leg, catch the lifted foot behind you, other arm reaches up and forward.",
        "keypoints": {
            0: (0.520, 0.140),
            5: (0.585, 0.255), 6: (0.435, 0.245),
            7: (0.640, 0.150), 8: (0.375, 0.320),
            9: (0.700, 0.060), 10: (0.330, 0.430),
            11: (0.560, 0.520), 12: (0.460, 0.520),
            13: (0.575, 0.730), 14: (0.395, 0.610),
            15: (0.585, 0.930), 16: (0.320, 0.450),
        },
    },
]

# ==========================================
# GEOMETRY & MOTION ENGINES
# ==========================================

def calculate_angle(a, b, c):
    """Calculates angle (in degrees) at vertex b between ba and bc."""
    a, b, c = np.array(a, float), np.array(b, float), np.array(c, float)
    radians = np.arctan2(c[1] - b[1], c[0] - b[0]) - np.arctan2(a[1] - b[1], a[0] - b[0])
    angle = np.abs(radians * 180.0 / np.pi)
    if angle > 180.0:
        angle = 360.0 - angle
    return angle

def direction_angle(a, b):
    """Absolute screen direction (deg) of the vector a -> b. 0 = right, 90 = down."""
    return float(np.degrees(np.arctan2(b[1] - a[1], b[0] - a[0])))

def angle_delta(a, b):
    """Smallest absolute difference between two directions, in degrees."""
    return abs((a - b + 180.0) % 360.0 - 180.0)

def midpoint(points):
    pts = np.array(points, float)
    return pts[:, 0].mean(), pts[:, 1].mean()

def torso_length(kpts):
    """Shoulder-to-hip distance, used to make motion scale-independent."""
    usable = [i for i in (5, 6, 11, 12) if kpts[i][2] > CONF_THRESHOLD]
    if 5 not in usable and 6 not in usable:
        return None
    if 11 not in usable and 12 not in usable:
        return None
    sho = midpoint([kpts[i][:2] for i in usable if i in (5, 6)])
    hip = midpoint([kpts[i][:2] for i in usable if i in (11, 12)])
    d = float(np.hypot(sho[0] - hip[0], sho[1] - hip[1]))
    return d if d > 1e-6 else None

def compute_frame_motion(curr_keypoints, prev_keypoints, anchor_indices):
    """Landmark drift between frames, normalised by torso length (0 = perfectly still)."""
    if prev_keypoints is None or curr_keypoints is None:
        return 0.0

    displacements = []
    for idx in anchor_indices:
        if idx < len(curr_keypoints) and idx < len(prev_keypoints):
            c = curr_keypoints[idx]
            p = prev_keypoints[idx]
            if c[2] > CONF_THRESHOLD and p[2] > CONF_THRESHOLD:
                displacements.append(np.hypot(c[0] - p[0], c[1] - p[1]))

    if not displacements:
        return 0.0
    scale = torso_length(curr_keypoints)
    if scale is None:
        return 0.0
    return float(np.mean(displacements) / scale)

# ==========================================
# REFERENCE POSE EXTRACTION
# ==========================================

def mirror_keypoints(kp):
    """Flips a keypoint dict horizontally and swaps the left/right labels."""
    xs = [p[0] for p in kp.values()]
    axis = (min(xs) + max(xs)) / 2.0
    flipped = {idx: (2 * axis - x, y) for idx, (x, y) in kp.items()}
    swapped = dict(flipped)
    for a, b in MIRROR_PAIRS:
        if a in flipped and b in flipped:
            swapped[a], swapped[b] = flipped[b], flipped[a]
    return swapped

def build_targets(kp, label=""):
    """Derives joint-angle and limb-direction targets from a keypoint dict."""
    angle_checks = []
    for name, (i1, i2, i3) in JOINTS:
        if not all(i in kp for i in (i1, i2, i3)):
            continue
        target = calculate_angle(kp[i1], kp[i2], kp[i3])
        angle_checks.append({"name": name, "points": (i1, i2, i3), "target": round(target, 1)})

    axis_checks = []
    for name, from_idx, to_idx in AXES:
        if not all(i in kp for i in from_idx + to_idx):
            continue
        a = midpoint([kp[i] for i in from_idx])
        b = midpoint([kp[i] for i in to_idx])
        axis_checks.append({"name": name, "from": from_idx, "to": to_idx,
                            "target": round(direction_angle(a, b), 1)})

    if not angle_checks:
        raise SystemExit(f"[ERROR] No usable joints in reference pose {label or '?'}.")
    return {"angle_checks": angle_checks, "axis_checks": axis_checks}

def keypoints_from_image(model, path):
    """Runs YOLOv8-pose on a reference photo and returns a confident keypoint dict."""
    img = cv2.imread(path)
    if img is None:
        print(f"[WARN] Could not read '{path}'; falling back to the authored skeleton.")
        return None, None
    results = model(img, verbose=False)
    if not results or results[0].keypoints is None or len(results[0].keypoints.data) == 0:
        print(f"[WARN] No person detected in '{path}'; falling back to the authored skeleton.")
        return None, None

    kpts = results[0].keypoints.data[0].cpu().numpy()
    kp = {i: (float(kpts[i][0]), float(kpts[i][1]))
          for i in range(len(kpts)) if kpts[i][2] > CONF_THRESHOLD}
    needed = {i for _, pts in JOINTS for i in pts}
    if not needed.issubset(kp):
        missing = sorted(needed - set(kp))
        print(f"[WARN] '{path}' is missing confident keypoints {missing}; using the authored skeleton.")
        return None, None
    return kp, img

def build_pose_sequence(model):
    """Turns POSE_LIBRARY into runtime poses with targets, mirrored targets and a thumbnail."""
    print("[INFO] Building pose sequence ...")
    poses = []
    for i, spec in enumerate(POSE_LIBRARY, start=1):
        kp = dict(spec["keypoints"])
        thumb_img = None
        source = "authored skeleton"
        if spec.get("image"):
            # "image": run YOLO on the photo and judge the player against *that* pose.
            derived, img = keypoints_from_image(model, spec["image"])
            if derived is not None:
                kp, thumb_img = derived, img
                source = f"targets from {spec['image']}"
        elif spec.get("photo"):
            # "photo": show the photo, but keep the authored skeleton as the target, so
            # one person's proportions and camera angle do not skew the joint targets.
            thumb_img = cv2.imread(spec["photo"])
            if thumb_img is None:
                print(f"[WARN] Could not read '{spec['photo']}'; showing the stick figure instead.")
            else:
                source = f"authored skeleton, photo {spec['photo']}"

        pose = {
            "index": i,
            "name": spec["name"],
            "sanskrit": spec["sanskrit"],
            "cue": spec["cue"],
            "keypoints": kp,
            "targets": build_targets(kp, spec["name"]),
            "mirrored": build_targets(mirror_keypoints(kp), spec["name"] + " (mirrored)"),
            "thumb": make_thumb(kp, thumb_img),
        }
        poses.append(pose)
        angles = ", ".join(f"{c['name']}={c['target']:.0f}" for c in pose["targets"]["angle_checks"])
        print(f"[INFO] {i:2d}. {spec['name']:26s} [{source}]  {angles}")
    return poses

# ==========================================
# POSE EVALUATION
# ==========================================

def score_targets(kpts, targets):
    """Scores live keypoints against one set of targets."""
    angle_results = []
    matched = 0
    total = 0

    for check in targets["angle_checks"]:
        i1, i2, i3 = check["points"]
        confident = all(kpts[i][2] > CONF_THRESHOLD for i in (i1, i2, i3))
        if confident:
            actual = calculate_angle(kpts[i1][:2], kpts[i2][:2], kpts[i3][:2])
            ok = abs(actual - check["target"]) <= ANGLE_TOLERANCE
        else:
            actual, ok = 0.0, False
        total += 1
        matched += int(ok)
        angle_results.append({"name": check["name"], "actual": actual,
                              "target": check["target"], "matched": ok})

    axis_matched = 0
    axis_total = 0
    for check in targets["axis_checks"]:
        idxs = check["from"] + check["to"]
        axis_total += 1
        total += 1
        if all(kpts[i][2] > CONF_THRESHOLD for i in idxs):
            a = midpoint([kpts[i][:2] for i in check["from"]])
            b = midpoint([kpts[i][:2] for i in check["to"]])
            if angle_delta(direction_angle(a, b), check["target"]) <= AXIS_TOLERANCE:
                axis_matched += 1
                matched += 1

    ratio = matched / total if total else 0.0
    return {"ratio": ratio, "matched": matched, "total": total,
            "angle_results": angle_results,
            "axis_matched": axis_matched, "axis_total": axis_total}

def evaluate_pose(kpts, pose):
    """Best score across the pose and its mirror image, so either side counts."""
    direct = score_targets(kpts, pose["targets"])
    flipped = score_targets(kpts, pose["mirrored"])
    best = flipped if flipped["ratio"] > direct["ratio"] else direct
    best["mirrored"] = best is flipped
    best["ok"] = best["ratio"] >= POSE_MATCH_RATIO
    return best

# ==========================================
# GRAPHICS & HUD RENDERING
# ==========================================

def draw_skeleton(canvas_bgr, kp, color=BLUE, thickness=3, pad=0.1):
    """Draws a keypoint dict as a stick figure, fitted to the canvas."""
    h, w = canvas_bgr.shape[:2]
    xs = [p[0] for p in kp.values()]
    ys = [p[1] for p in kp.values()]
    span = max(max(xs) - min(xs), max(ys) - min(ys)) or 1.0
    scale = (1.0 - 2 * pad) * min(w, h) / span
    cx, cy = (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0

    def to_px(p):
        return int(w / 2 + (p[0] - cx) * scale), int(h / 2 + (p[1] - cy) * scale)

    for a, b in SKELETON_EDGES:
        if a in kp and b in kp:
            cv2.line(canvas_bgr, to_px(kp[a]), to_px(kp[b]), color[::-1], thickness, cv2.LINE_AA)
    if 0 in kp:
        cv2.circle(canvas_bgr, to_px(kp[0]), max(4, int(0.05 * span * scale)), color[::-1], thickness, cv2.LINE_AA)
    for idx, p in kp.items():
        if idx in (0, 1, 2, 3, 4):
            continue
        cv2.circle(canvas_bgr, to_px(p), 3, WHITE[::-1], -1, cv2.LINE_AA)

def make_thumb(kp, photo=None, size=(240, 260)):
    """Reference thumbnail: the source photo when there is one, else a stick figure."""
    tw, th = size
    if photo is not None:
        scale = min(tw / photo.shape[1], th / photo.shape[0])
        resized = cv2.resize(photo, (max(1, int(photo.shape[1] * scale)),
                                     max(1, int(photo.shape[0] * scale))))
        canvas = np.full((th, tw, 3), BG_BLACK[::-1], np.uint8)
        y0 = (th - resized.shape[0]) // 2
        x0 = (tw - resized.shape[1]) // 2
        canvas[y0:y0 + resized.shape[0], x0:x0 + resized.shape[1]] = resized
        return canvas

    canvas = np.full((th, tw, 3), BG_BLACK[::-1], np.uint8)
    draw_skeleton(canvas, kp)
    return canvas

def draw_laser_grid(frame, t, alarm=False):
    """Sweeping security-laser lines. Blue during a normal hold, red once an
    alarm trips - the room's own accent color doubles as the "all clear" state,
    matching the LASER GRID room's blue branding in the kiosk.
    """
    h, w, _ = frame.shape
    overlay = frame.copy()
    color = (RED if alarm else BLUE)[::-1]
    thickness = 4 if alarm else 2

    for i in range(4):
        y = int((h / 5) * (i + 1) + np.sin(t * 2 + i) * 30)
        cv2.line(overlay, (0, y), (w, y), color, thickness)

    for i in range(5):
        x = int((w / 6) * (i + 1) + np.cos(t * 1.5 + i) * 40)
        cv2.line(overlay, (x, 0), (x, h), color, thickness)

    cv2.addWeighted(overlay, 0.35, frame, 0.65, 0, frame)

def start_button_rect(w, h):
    return (w - 260, h - 90, w - 30, h - 40)

def draw_reference_thumb(c, pose, x0, y0):
    """Bordered target-pose panel: thumbnail, pose name, and Sanskrit name -
    the same bordered-panel-plus-label pattern as the kiosk's KioskBadge.
    """
    thumb = pose["thumb"]
    th, tw = thumb.shape[0], thumb.shape[1]
    c.panel((x0 - 6, y0 - 34, x0 + tw + 6, y0 + th + 54), fill=BG_BLACK, fill_alpha=190, outline=BLUE, width=2)
    c.text((x0, y0 - 24), f"TARGET {pose['index']}/{len(POSE_LIBRARY)}", size=13, color=BLUE, weight="Bold", tracking=2)
    thumb_rgb = cv2.cvtColor(thumb, cv2.COLOR_BGR2RGB)
    c.image.paste(Image.fromarray(thumb_rgb), (x0, y0))
    c.text((x0, y0 + th + 8), pose["name"][:24].upper(), size=14, color=WHITE, weight="Bold", tracking=1)
    c.text((x0, y0 + th + 28), pose["sanskrit"][:30], size=12, color=GREY, weight="Regular")

def draw_progress_dots(c, results, current_index, x0, y):
    n = len(POSE_LIBRARY)
    r = 11
    gap = 33
    c.text((x0, y - 26), f"SEQUENCE - CLEAR {REQUIRED_POSES} OF {n}", size=12, color=GREY, weight="Medium", tracking=1)
    for i in range(n):
        cx = x0 + r + i * gap
        outcome = results[i] if i < len(results) else None
        if outcome is True:
            color, fill = GREEN, True
        elif outcome is False:
            color, fill = RED, True
        elif i == current_index:
            color, fill = BLUE, False
        else:
            color, fill = DIM, False
        if fill:
            c.ellipse((cx - r, y - r, cx + r, y + r), fill=color)
            label_col = BG_BLACK
        else:
            c.ellipse((cx - r, y - r, cx + r, y + r), outline=color, width=2)
            label_col = color
        digit = str(i + 1)
        dw, _ = c.text_size(digit, size=11, weight="Bold")
        c.text((cx - dw / 2, y - 7), digit, size=11, color=label_col, weight="Bold")

def draw_check_panel(c, score, grace_left, x0, y0, waiting=False):
    if score is None:
        return y0
    y = y0
    c.text((x0, y - 20), "POSE ALIGNMENT", size=12, color=BLUE_LIGHT, weight="Bold", tracking=2)
    for res in score["angle_results"]:
        txt = f"{res['name'].upper()}: {int(res['actual'])} DEG (REF {int(res['target'])})"
        col = GREEN if res["matched"] else RED
        c.text((x0, y), txt, size=13, color=col, weight="Medium")
        y += 22

    axis_col = GREEN if score["axis_matched"] == score["axis_total"] else AMBER
    c.text((x0, y), f"ALIGNMENT: {score['axis_matched']}/{score['axis_total']} LIMBS", size=13, color=axis_col, weight="Medium")
    y += 28

    pct = int(round(score["ratio"] * 100))
    bar_w, bar_h = 240, 12
    c.rect((x0, y, x0 + bar_w, y + bar_h), fill=DIM)
    fill_w = int(bar_w * min(score["ratio"], 1.0))
    col = GREEN if score["ok"] else AMBER
    if fill_w > 0:
        c.rect((x0, y, x0 + fill_w, y + bar_h), fill=col)
    thresh_x = x0 + int(bar_w * POSE_MATCH_RATIO)
    c.line((thresh_x, y - 3, thresh_x, y + bar_h + 3), fill=WHITE, width=1)
    c.rect((x0, y, x0 + bar_w, y + bar_h), outline=GREY, width=1)
    c.text((x0 + bar_w + 12, y - 2), f"MATCH: {pct}%", size=13, color=col, weight="Bold")
    y += bar_h + 24

    if grace_left is not None:
        c.text((x0, y), f"POSE BROKEN - RECOVER ({grace_left:.1f}S)", size=15, color=RED, weight="Bold", tracking=1)
    elif waiting:
        c.text((x0, y), "MATCH THE POSE TO START THE CLOCK", size=15, color=BLUE, weight="Bold", tracking=1)
    return y + 26

def draw_motion_meter(c, motion_val, x0, y):
    meter_w, meter_h = 240, 12
    ratio = min(motion_val / (MOTION_LIMIT * 2.0), 1.0)
    c.rect((x0, y, x0 + meter_w, y + meter_h), fill=DIM)
    meter_col = GREEN if motion_val <= MOTION_LIMIT else RED
    fill_w = int(ratio * meter_w)
    if fill_w > 0:
        c.rect((x0, y, x0 + fill_w, y + meter_h), fill=meter_col)
    c.rect((x0, y, x0 + meter_w, y + meter_h), outline=GREY, width=1)
    c.text((x0 + meter_w + 12, y - 2), f"STILLNESS: {motion_val * 100:.1f}%", size=12, color=GREY, weight="Medium")

def draw_summary(c, poses, results):
    w, h = c.w, c.h
    cleared = sum(1 for r in results if r)
    won = cleared >= REQUIRED_POSES
    accent = GREEN if won else RED

    x0, y0, x1, y1 = w // 2 - 340, 90, w // 2 + 340, h - 50
    c.panel((x0, y0, x1, y1), fill=BG_BLACK, fill_alpha=225, outline=accent, width=2, corner_len=16)

    headline = "HEIST COMPLETE" if won else "SECURITY LOCKDOWN"
    c.centered_text((x0 + x1) // 2, y0 + 24, headline, size=34, color=accent, weight="ExtraBold", tracking=3)
    c.centered_text((x0 + x1) // 2, y0 + 66, f"POSES HELD: {cleared}/{len(poses)}  (NEEDED {REQUIRED_POSES})",
                     size=15, color=WHITE, weight="Medium", tracking=1)

    y = y0 + 100
    for pose, outcome in zip(poses, results):
        col = GREEN if outcome else RED
        mark = "HELD" if outcome else "BROKE"
        c.text((x0 + 30, y), f"{pose['index']:>2}. {pose['name'].upper():<26} {mark}", size=14, color=col, weight="Medium")
        y += 26

    c.centered_text((x0 + x1) // 2, y1 - 34, "SPACE / CLICK START TO RUN AGAIN  -  Q TO QUIT",
                     size=12, color=GREY, weight="Medium", tracking=1)

def draw_hud(frame, state, pose, score, motion_val, timer_remaining, hold_remaining,
             grace_left, results, poses, waiting=False):
    """Composites the whole HUD in a single PIL pass over `frame` and returns
    the finished BGR frame - callers must use the return value, this no longer
    mutates `frame` in place (a PIL round trip cannot write back into a numpy
    buffer for free the way raw cv2 calls could).
    """
    c = Canvas(frame)
    w, h = c.w, c.h

    # -- top status bar ---------------------------------------------------
    c.panel((0, 0, w, 100), fill=BG_BLACK, fill_alpha=210, outline=None, corners=False)
    c.line((0, 100, w, 100), fill=BLUE, width=2)
    cleared = sum(1 for r in results if r)
    failed = sum(1 for r in results if r is False)
    c.text((20, 16), "LOUVRE SECURITY // 10-POSE LASER GAUNTLET", size=19, color=BLUE, weight="Bold", tracking=2)
    if pose is not None:
        c.text((20, 52), f"POSE {pose['index']}/{len(poses)}: {pose['name'].upper()} - {pose['cue'].upper()}",
               size=13, color=GREY, weight="Medium")
    else:
        c.text((20, 52), f"HOLD {len(poses)} YOGA POSES FOR {POSE_HOLD_DURATION:.0f}S EACH. "
                         f"CLEAR {REQUIRED_POSES} TO BEAT THE LASERS.", size=13, color=GREY, weight="Medium")
    c.text((20, 76), f"HELD: {cleared}   BROKEN: {failed}   TARGET: {REQUIRED_POSES}", size=12, color=DIM, weight="Medium")

    # -- status badge, top right -------------------------------------------
    if state == "IDLE":
        status_text, status_color = "READY - CLICK START", AMBER
    elif state == "COUNTDOWN":
        status_text, status_color = "GET INTO POSE", BLUE
    elif state == "TRACKING":
        status_text, status_color = ("MATCH THE POSE" if waiting else f"HOLD: {hold_remaining:.1f}S"), (BLUE if waiting else GREEN)
    elif state == "POSE_FAILED":
        status_text, status_color = "ALARM - POSE LOST", RED
    elif state == "POSE_PASSED":
        status_text, status_color = "POSE SECURED", GREEN
    else:
        status_text, status_color = "SEQUENCE OVER", GREEN

    badge = (w - 330, 12, w - 20, 76)
    c.panel(badge, fill=BG_BLACK, fill_alpha=210, outline=status_color, width=2)
    c.centered_text((badge[0] + badge[2]) // 2, 33, status_text, size=17, color=status_color, weight="ExtraBold", tracking=2)

    if state == "SUMMARY":
        draw_summary(c, poses, results)
        return c.finish()

    if pose is not None:
        draw_reference_thumb(c, pose, w - pose["thumb"].shape[1] - 20, 116)

    panel_bottom = 116
    if state == "TRACKING":
        panel_bottom = draw_check_panel(c, score, grace_left, 20, 140, waiting)
    elif state == "COUNTDOWN":
        panel_bottom = draw_check_panel(c, score, None, 20, 140)

    draw_motion_meter(c, motion_val, 20, h - 26)
    draw_progress_dots(c, results, pose["index"] - 1 if pose else -1, 20, h - 62)

    if state == "IDLE":
        bx0, by0, bx1, by1 = start_button_rect(w, h)
        c.panel((bx0, by0, bx1, by1), fill=BLUE, fill_alpha=255, outline=BG_BLACK, width=2, corners=False)
        c.centered_text((bx0 + bx1) // 2, by0 + 12, "CLICK START", size=20, color=BG_BLACK, weight="ExtraBold", tracking=2)
        c.centered_text((bx0 + bx1) // 2, by0 + 34, "or press SPACE", size=12, color=BG_BLACK, weight="Medium")
        c.centered_text(w // 2, h // 2 - 60, "10 POSES - HOLD EACH FOR 10s", size=36, color=BLUE, weight="ExtraBold", tracking=3)
        c.centered_text(w // 2, h // 2 - 10,
                         f"MATCH THE TARGET SKELETON, STAY STILL. {REQUIRED_POSES}/{len(poses)} CLEARS THE GAUNTLET.",
                         size=15, color=GREY, weight="Medium", tracking=1)
        c.centered_text(w // 2, h // 2 + 20,
                         "STAND BACK SO YOUR WHOLE BODY IS IN FRAME. N = SKIP POSE, R = RESTART, Q = QUIT.",
                         size=13, color=DIM, weight="Medium")
    elif state == "COUNTDOWN":
        secs = max(1, int(np.ceil(timer_remaining)))
        c.centered_text(w // 2, h // 2 - 10, str(secs), size=140, color=AMBER, weight="ExtraBold")
        c.centered_text(w // 2, h // 2 + 130, f"GET INTO: {pose['name'].upper()}", size=24, color=WHITE, weight="Bold", tracking=2)
    elif state == "TRACKING":
        c.centered_text(w // 2, h // 2 - 10, f"{hold_remaining:.1f}", size=110, color=GREEN, weight="ExtraBold")
        frac = 1.0 - hold_remaining / POSE_HOLD_DURATION
        bx, by, bw, bh = w // 2 - 200, h // 2 + 90, 400, 16
        c.rect((bx, by, bx + bw, by + bh), fill=DIM)
        if frac > 0:
            c.rect((bx, by, int(bx + bw * frac), by + bh), fill=GREEN)
        c.rect((bx, by, bx + bw, by + bh), outline=WHITE, width=1)
    elif state == "POSE_FAILED":
        c.centered_text(w // 2, h // 2 - 30, "POSE BROKEN", size=42, color=RED, weight="ExtraBold", tracking=3)
        c.centered_text(w // 2, h // 2 + 30, "NEXT POSE COMING UP...", size=16, color=WHITE, weight="Medium", tracking=1)
    elif state == "POSE_PASSED":
        c.centered_text(w // 2, h // 2 - 30, "POSE SECURED", size=42, color=GREEN, weight="ExtraBold", tracking=3)
        c.centered_text(w // 2, h // 2 + 30, "NEXT POSE COMING UP...", size=16, color=WHITE, weight="Medium", tracking=1)

    return c.finish()

# ==========================================
# MAIN GAME LOOP
# ==========================================

def run_game():
    print("[INFO] Loading YOLOv8-Pose model...")
    model_path = os.path.join(BASE_DIR, "yolov8n-pose.pt")
    model = YOLO(model_path)
    poses = build_pose_sequence(model)

    # Force DirectShow backend on Windows to prevent MSMF from hanging for 10+ seconds
    import sys
    backend = cv2.CAP_DSHOW if sys.platform.startswith('win') else cv2.CAP_ANY
    cap = cv2.VideoCapture(0, backend)
    if not cap.isOpened():
        print("[ERROR] Could not open local webcam.")
        return
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_AUTOSIZE)
    # Force the OpenCV window to be on top of the browser
    cv2.setWindowProperty(WINDOW_NAME, cv2.WND_PROP_TOPMOST, 1)
    
    ui = {"click": None}
    def on_mouse(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN:
            ui["click"] = (x, y)
    cv2.setMouseCallback(WINDOW_NAME, on_mouse)

    state = "IDLE"
    phase_start = None
    pose_idx = 0
    results = []          # True = held, False = broken, one entry per finished pose
    held_time = 0.0       # accumulated in-pose time for the current pose
    hold_started = False  # True once the player has matched the pose at least once
    break_start = None    # when the pose stopped matching, or None while matching
    last_tick = time.time()
    prev_keypoints = None
    start_game_time = time.time()

    def begin_session():
        nonlocal state, phase_start, pose_idx, results, held_time, break_start
        nonlocal hold_started, prev_keypoints
        state, phase_start = "COUNTDOWN", time.time()
        pose_idx, results = 0, []
        held_time, break_start, hold_started = 0.0, None, False
        prev_keypoints = None

    def finish_pose(passed):
        nonlocal state, phase_start, results, held_time, break_start, hold_started
        results.append(passed)
        held_time, break_start, hold_started = 0.0, None, False
        state, phase_start = ("POSE_PASSED" if passed else "POSE_FAILED"), time.time()
        print(f"[INFO] Pose {pose_idx + 1} ({poses[pose_idx]['name']}): "
              f"{'HELD' if passed else 'BROKEN'}  "
              f"({sum(1 for r in results if r)} secured, need {REQUIRED_POSES})")

    def advance():
        nonlocal state, phase_start, pose_idx
        pose_idx += 1
        if pose_idx >= len(poses):
            state, phase_start = "SUMMARY", time.time()
            cleared = sum(1 for r in results if r)
            print(f"[INFO] Sequence over: {cleared}/{len(poses)} poses held - "
                  f"{'SUCCESS' if cleared >= REQUIRED_POSES else 'FAILED'}")
        else:
            state, phase_start = "COUNTDOWN", time.time()

    print(f"[INFO] Game launched! {len(poses)} poses, {POSE_HOLD_DURATION:.0f}s hold each, "
          f"{REQUIRED_POSES} needed to win.")
    print("[INFO] SPACE/ENTER or CLICK START to begin. N = skip pose, R = restart, Q = quit.")

    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            break

        frame = cv2.flip(frame, 1)
        h, w, _ = frame.shape
        now = time.time()
        dt = min(now - last_tick, 0.5)
        last_tick = now
        t = now - start_game_time

        def pose_on_screen():
            if state == "IDLE":
                return poses[0]
            if state == "SUMMARY" or pose_idx >= len(poses):
                return None
            return poses[pose_idx]

        active_pose = pose_on_screen()
        score = None
        motion = 0.0

        detection = model(frame, verbose=False)
        if detection and detection[0].keypoints is not None and len(detection[0].keypoints.data) > 0:
            kpts = detection[0].keypoints.data[0].cpu().numpy()
            motion = compute_frame_motion(kpts, prev_keypoints, STILLNESS_ANCHORS)
            prev_keypoints = kpts
            if active_pose is not None:
                score = evaluate_pose(kpts, active_pose)
            for x, y, conf in kpts:
                if conf > CONF_THRESHOLD:
                    cv2.circle(frame, (int(x), int(y)), 4, (0, 255, 255), -1)
        else:
            prev_keypoints = None

        key = cv2.waitKey(1) & 0xFF
        clicked_start = False
        if ui["click"] is not None:
            mx, my = ui["click"]
            ui["click"] = None
            bx0, by0, bx1, by1 = start_button_rect(w, h)
            clicked_start = (bx0 <= mx <= bx1 and by0 <= my <= by1)
        pressed_start = key in (13, 32)

        if key == ord('q'):
            break
        if key == ord('r') and state != "IDLE":
            begin_session()
        elif state in ("IDLE", "SUMMARY") and (clicked_start or pressed_start):
            begin_session()
        elif state in ("COUNTDOWN", "TRACKING") and key == ord('n'):
            finish_pose(False)

        timer_remaining = 0.0
        hold_remaining = POSE_HOLD_DURATION
        grace_left = None
        waiting = False

        if state == "COUNTDOWN":
            timer_remaining = COUNTDOWN_DURATION - (now - phase_start)
            if timer_remaining <= 0:
                state, phase_start = "TRACKING", now
                held_time, break_start, hold_started = 0.0, None, False
        elif state == "TRACKING":
            holding = score is not None and score["ok"] and motion <= MOTION_LIMIT
            if holding:
                held_time += dt
                hold_started = True
                break_start = None
            elif hold_started:
                # Only once the hold has begun does breaking it start the grace clock;
                # before that the player is still settling in and has until POSE_TIME_LIMIT.
                if break_start is None:
                    break_start = now
                grace_left = max(0.0, BREAK_GRACE - (now - break_start))

            waiting = not hold_started
            hold_remaining = max(0.0, POSE_HOLD_DURATION - held_time)
            if held_time >= POSE_HOLD_DURATION:
                finish_pose(True)
            elif break_start is not None and now - break_start > BREAK_GRACE:
                finish_pose(False)
            elif now - phase_start > POSE_TIME_LIMIT:
                finish_pose(False)
        elif state in ("POSE_PASSED", "POSE_FAILED"):
            if now - phase_start >= RESULT_DISPLAY:
                advance()

        if state in ("COUNTDOWN", "TRACKING"):
            draw_laser_grid(frame, t, alarm=False)
        elif state == "POSE_FAILED":
            draw_laser_grid(frame, t, alarm=True)
            cv2.addWeighted(np.full_like(frame, (0, 0, 200)), 0.4, frame, 0.6, 0, frame)
        elif state == "POSE_PASSED":
            cv2.addWeighted(np.full_like(frame, (0, 200, 0)), 0.3, frame, 0.7, 0, frame)
        elif state == "SUMMARY":
            won = sum(1 for r in results if r) >= REQUIRED_POSES
            tint = (0, 200, 0) if won else (0, 0, 200)
            cv2.addWeighted(np.full_like(frame, tint), 0.25, frame, 0.75, 0, frame)
            
            # Webhook on win
            if won and not hasattr(run_game, 'webhook_sent'):
                run_game.webhook_sent = True
                import sys, requests
                if len(sys.argv) >= 3:
                    token = sys.argv[1]
                    room_id = sys.argv[2]
                    try:
                        # Reports pass/fail only. The ML service forwards this to
                        # Supabase, which stamps the completion time, so the run is
                        # timed by the same clock as every other room.
                        requests.post(
                            "http://127.0.0.1:5000/api/ml/report",
                            headers={"Authorization": f"Bearer {token}"},
                            json={
                                "roomId": room_id,
                                "passed": True,
                                "detail": {
                                    "posesCleared": sum(1 for r in results if r),
                                    "posesRequired": REQUIRED_POSES,
                                    "holdSeconds": POSE_HOLD_DURATION,
                                },
                            },
                            timeout=10,
                        )
                    except: pass
                # Auto-close after 3 seconds of winning
                if now - phase_start > 3.0:
                    break
        hud_pose = pose_on_screen()
        frame = draw_hud(frame, state, hud_pose, score if hud_pose is active_pose else None,
                          motion, max(timer_remaining, 0.0), hold_remaining, grace_left, results, poses,
                          waiting=waiting)

        cv2.imshow(WINDOW_NAME, frame)

    cap.release()
    cv2.destroyAllWindows()



# =============================================================================
# Kiosk streaming mode
# =============================================================================
# The kiosk browser cannot embed a native cv2.imshow() window, so this is a
# second entry point that reuses every bit of the detection/scoring/HUD logic
# above but yields MJPEG frames instead of opening a desktop window. Flask
# wraps this generator in a multipart/x-mixed-replace response and the browser
# displays it with a plain <img> tag - no video-streaming library needed on
# either side.
#
# run_game() above is left completely untouched: `python louvre_laser_game.py`
# still opens a native window for standalone development and testing per
# AGENTS.md. This function is only ever called from inside the Flask process.
#
# Differences from run_game(), all forced by having no keyboard/mouse and no
# native window:
#   - Starts immediately in COUNTDOWN. There is no IDLE/click-to-start state -
#     the kiosk's own "launch" click is what causes the browser to open this
#     stream in the first place.
#   - No key-driven skip/restart/quit. The sequence runs start to finish or
#     until the viewer disconnects, at which point the generator is torn down
#     and the camera is released in the `finally` block.
# =============================================================================

def _report_pose_result(token, room_id, passed, detail):
    """Tell the Flask backend how the sequence went, exactly as run_game() does.

    A plain loopback POST back into the same Flask process - safe only because
    the server is run with threaded=True, so this request does not block the
    stream's own still-open response.
    """
    import requests
    try:
        requests.post(
            "http://127.0.0.1:5000/api/ml/report",
            headers={"Authorization": f"Bearer {token}"},
            json={"roomId": room_id, "passed": passed, "detail": detail},
            timeout=10,
        )
    except Exception as exc:
        print(f"[WARN] Could not report pose result: {exc}")


def stream_game_frames(token, room_id):
    """Generator of MJPEG frame chunks for one crew's pose sequence.

    Mirrors run_game()'s state machine and drawing calls one-for-one; the only
    changes are the output sink (yield a JPEG instead of cv2.imshow) and the
    absence of keyboard/mouse control (auto-start, no skip/restart).
    """
    print("[INFO] (stream) Loading YOLOv8-Pose model...")
    model_path = os.path.join(BASE_DIR, "yolov8n-pose.pt")
    model = YOLO(model_path)
    poses = build_pose_sequence(model)

    import sys as _sys
    backend = cv2.CAP_DSHOW if _sys.platform.startswith('win') else cv2.CAP_ANY
    cap = cv2.VideoCapture(0, backend)
    if not cap.isOpened():
        print("[ERROR] (stream) Could not open local webcam.")
        return
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    state, phase_start = "COUNTDOWN", time.time()
    pose_idx = 0
    results = []
    held_time, hold_started, break_start = 0.0, False, None
    last_tick = time.time()
    prev_keypoints = None
    start_game_time = time.time()
    webhook_sent = False

    def finish_pose(passed):
        nonlocal state, phase_start, results, held_time, break_start, hold_started
        results.append(passed)
        held_time, break_start, hold_started = 0.0, None, False
        state, phase_start = ("POSE_PASSED" if passed else "POSE_FAILED"), time.time()

    def advance():
        nonlocal state, phase_start, pose_idx
        pose_idx += 1
        if pose_idx >= len(poses):
            state, phase_start = "SUMMARY", time.time()
        else:
            state, phase_start = "COUNTDOWN", time.time()

    try:
        while cap.isOpened():
            success, frame = cap.read()
            if not success:
                break

            frame = cv2.flip(frame, 1)
            now = time.time()
            dt = min(now - last_tick, 0.5)
            last_tick = now
            t = now - start_game_time

            def pose_on_screen():
                if state == "SUMMARY" or pose_idx >= len(poses):
                    return None
                return poses[pose_idx]

            active_pose = pose_on_screen()
            score, motion = None, 0.0

            detection = model(frame, verbose=False)
            if detection and detection[0].keypoints is not None and len(detection[0].keypoints.data) > 0:
                kpts = detection[0].keypoints.data[0].cpu().numpy()
                motion = compute_frame_motion(kpts, prev_keypoints, STILLNESS_ANCHORS)
                prev_keypoints = kpts
                if active_pose is not None:
                    score = evaluate_pose(kpts, active_pose)
                for x, y, conf in kpts:
                    if conf > CONF_THRESHOLD:
                        cv2.circle(frame, (int(x), int(y)), 4, (0, 255, 255), -1)
            else:
                prev_keypoints = None

            timer_remaining, hold_remaining, grace_left, waiting = 0.0, POSE_HOLD_DURATION, None, False

            if state == "COUNTDOWN":
                timer_remaining = COUNTDOWN_DURATION - (now - phase_start)
                if timer_remaining <= 0:
                    state, phase_start = "TRACKING", now
                    held_time, break_start, hold_started = 0.0, None, False
            elif state == "TRACKING":
                holding = score is not None and score["ok"] and motion <= MOTION_LIMIT
                if holding:
                    held_time += dt
                    hold_started = True
                    break_start = None
                elif hold_started:
                    if break_start is None:
                        break_start = now
                    grace_left = max(0.0, BREAK_GRACE - (now - break_start))

                waiting = not hold_started
                hold_remaining = max(0.0, POSE_HOLD_DURATION - held_time)
                if held_time >= POSE_HOLD_DURATION:
                    finish_pose(True)
                elif break_start is not None and now - break_start > BREAK_GRACE:
                    finish_pose(False)
                elif now - phase_start > POSE_TIME_LIMIT:
                    finish_pose(False)
            elif state in ("POSE_PASSED", "POSE_FAILED"):
                if now - phase_start >= RESULT_DISPLAY:
                    advance()

            if state in ("COUNTDOWN", "TRACKING"):
                draw_laser_grid(frame, t, alarm=False)
            elif state == "POSE_FAILED":
                draw_laser_grid(frame, t, alarm=True)
                cv2.addWeighted(np.full_like(frame, (0, 0, 200)), 0.4, frame, 0.6, 0, frame)
            elif state == "POSE_PASSED":
                cv2.addWeighted(np.full_like(frame, (0, 200, 0)), 0.3, frame, 0.7, 0, frame)
            elif state == "SUMMARY":
                won = sum(1 for r in results if r) >= REQUIRED_POSES
                tint = (0, 200, 0) if won else (0, 0, 200)
                cv2.addWeighted(np.full_like(frame, tint), 0.25, frame, 0.75, 0, frame)

                if won and not webhook_sent:
                    webhook_sent = True
                    _report_pose_result(token, room_id, True, {
                        "posesCleared": sum(1 for r in results if r),
                        "posesRequired": REQUIRED_POSES,
                        "holdSeconds": POSE_HOLD_DURATION,
                    })

                if now - phase_start > 3.0:
                    break

            hud_pose = pose_on_screen()
            frame = draw_hud(frame, state, hud_pose, score if hud_pose is active_pose else None,
                              motion, max(timer_remaining, 0.0), hold_remaining, grace_left, results, poses,
                              waiting=waiting)

            ok, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            if not ok:
                continue
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
    finally:
        cap.release()


if __name__ == "__main__":
    run_game()