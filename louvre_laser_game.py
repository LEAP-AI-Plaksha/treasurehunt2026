import os
import cv2
import numpy as np
import time
from ultralytics import YOLO

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

def draw_skeleton(canvas, kp, color=(0, 220, 255), thickness=3, pad=0.1):
    """Draws a keypoint dict as a stick figure, fitted to the canvas."""
    h, w = canvas.shape[:2]
    xs = [p[0] for p in kp.values()]
    ys = [p[1] for p in kp.values()]
    span = max(max(xs) - min(xs), max(ys) - min(ys)) or 1.0
    scale = (1.0 - 2 * pad) * min(w, h) / span
    cx, cy = (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0

    def to_px(p):
        return int(w / 2 + (p[0] - cx) * scale), int(h / 2 + (p[1] - cy) * scale)

    for a, b in SKELETON_EDGES:
        if a in kp and b in kp:
            cv2.line(canvas, to_px(kp[a]), to_px(kp[b]), color, thickness, cv2.LINE_AA)
    if 0 in kp:
        cv2.circle(canvas, to_px(kp[0]), max(4, int(0.05 * span * scale)), color, thickness, cv2.LINE_AA)
    for idx, p in kp.items():
        if idx in (0, 1, 2, 3, 4):
            continue
        cv2.circle(canvas, to_px(p), 3, (255, 255, 255), -1, cv2.LINE_AA)

def make_thumb(kp, photo=None, size=(240, 260)):
    """Reference thumbnail: the source photo when there is one, else a stick figure."""
    tw, th = size
    if photo is not None:
        scale = min(tw / photo.shape[1], th / photo.shape[0])
        resized = cv2.resize(photo, (max(1, int(photo.shape[1] * scale)),
                                     max(1, int(photo.shape[0] * scale))))
        canvas = np.full((th, tw, 3), 20, np.uint8)
        y0 = (th - resized.shape[0]) // 2
        x0 = (tw - resized.shape[1]) // 2
        canvas[y0:y0 + resized.shape[0], x0:x0 + resized.shape[1]] = resized
        return canvas

    canvas = np.full((th, tw, 3), 20, np.uint8)
    draw_skeleton(canvas, kp)
    return canvas

def draw_laser_grid(frame, t, alarm=False):
    h, w, _ = frame.shape
    overlay = frame.copy()
    color = (0, 0, 255)
    thickness = 4 if alarm else 2

    for i in range(4):
        y = int((h / 5) * (i + 1) + np.sin(t * 2 + i) * 30)
        cv2.line(overlay, (0, y), (w, y), color, thickness)

    for i in range(5):
        x = int((w / 6) * (i + 1) + np.cos(t * 1.5 + i) * 40)
        cv2.line(overlay, (x, 0), (x, h), color, thickness)

    cv2.addWeighted(overlay, 0.4, frame, 0.6, 0, frame)

def start_button_rect(w, h):
    return (w - 260, h - 90, w - 30, h - 40)

def draw_reference_thumb(frame, pose):
    thumb = pose["thumb"]
    _, w, _ = frame.shape
    th, tw = thumb.shape[0], thumb.shape[1]
    x0, y0 = w - tw - 20, 110
    cv2.rectangle(frame, (x0 - 4, y0 - 4), (x0 + tw + 4, y0 + th + 4), (0, 220, 255), 2)
    cv2.putText(frame, f"TARGET {pose['index']}/{len(POSE_LIBRARY)}", (x0, y0 - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 220, 255), 1)
    frame[y0:y0 + th, x0:x0 + tw] = thumb
    cv2.putText(frame, pose["name"][:24], (x0, y0 + th + 22),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    cv2.putText(frame, pose["sanskrit"][:30], (x0, y0 + th + 42),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (170, 170, 170), 1)

def draw_progress_dots(frame, results, current_index):
    h = frame.shape[0]
    n = len(POSE_LIBRARY)
    r = 11
    gap = 33
    x0 = 20
    y = h - 62
    cv2.putText(frame, f"SEQUENCE - CLEAR {REQUIRED_POSES} OF {n}", (x0, y - 22),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1)
    for i in range(n):
        cx = x0 + r + i * gap
        outcome = results[i] if i < len(results) else None
        if outcome is True:
            color, fill = (0, 255, 120), -1
        elif outcome is False:
            color, fill = (0, 0, 255), -1
        elif i == current_index:
            color, fill = (0, 220, 255), 2
        else:
            color, fill = (110, 110, 110), 1
        cv2.circle(frame, (cx, y), r, color, fill)
        label_col = (0, 0, 0) if fill == -1 else color
        cv2.putText(frame, str(i + 1), (cx - 7 if i >= 9 else cx - 4, y + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, label_col, 1)

def draw_check_panel(frame, score, grace_left, waiting=False):
    if score is None:
        return
    y = 120
    for res in score["angle_results"]:
        txt = f"{res['name']}: {int(res['actual'])} deg (ref {int(res['target'])})"
        col = (0, 255, 0) if res["matched"] else (0, 0, 255)
        cv2.putText(frame, txt, (20, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1)
        y += 24

    axis_col = (0, 255, 0) if score["axis_matched"] == score["axis_total"] else (0, 165, 255)
    cv2.putText(frame, f"ALIGNMENT: {score['axis_matched']}/{score['axis_total']} limbs",
                (20, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, axis_col, 1)
    y += 30

    pct = int(round(score["ratio"] * 100))
    bar_w, bar_h = 240, 14
    cv2.rectangle(frame, (20, y), (20 + bar_w, y + bar_h), (40, 40, 40), -1)
    fill = int(bar_w * min(score["ratio"], 1.0))
    col = (0, 255, 0) if score["ok"] else (0, 165, 255)
    cv2.rectangle(frame, (20, y), (20 + fill, y + bar_h), col, -1)
    thresh_x = 20 + int(bar_w * POSE_MATCH_RATIO)
    cv2.line(frame, (thresh_x, y - 3), (thresh_x, y + bar_h + 3), (255, 255, 255), 1)
    cv2.rectangle(frame, (20, y), (20 + bar_w, y + bar_h), (200, 200, 200), 1)
    cv2.putText(frame, f"POSE MATCH: {pct}%", (20 + bar_w + 12, y + bar_h - 1),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1)

    if grace_left is not None:
        cv2.putText(frame, f"POSE BROKEN - RECOVER ({grace_left:.1f}s)", (20, y + 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2)
    elif waiting:
        cv2.putText(frame, "MATCH THE POSE TO START THE CLOCK", (20, y + 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 220, 255), 2)

def draw_motion_meter(frame, motion_val):
    h = frame.shape[0]
    meter_w, meter_h = 240, 14
    meter_x, meter_y = 20, h - 26
    ratio = min(motion_val / (MOTION_LIMIT * 2.0), 1.0)
    cv2.rectangle(frame, (meter_x, meter_y), (meter_x + meter_w, meter_y + meter_h), (30, 30, 30), -1)
    meter_col = (0, 255, 0) if motion_val <= MOTION_LIMIT else (0, 0, 255)
    cv2.rectangle(frame, (meter_x, meter_y), (meter_x + int(ratio * meter_w), meter_y + meter_h), meter_col, -1)
    cv2.rectangle(frame, (meter_x, meter_y), (meter_x + meter_w, meter_y + meter_h), (200, 200, 200), 1)
    cv2.putText(frame, f"SEISMIC MOTION: {motion_val * 100:.1f}%", (meter_x + meter_w + 12, meter_y + meter_h - 1),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 220), 1)

def draw_summary(frame, poses, results):
    h, w, _ = frame.shape
    cleared = sum(1 for r in results if r)
    won = cleared >= REQUIRED_POSES
    panel = frame.copy()
    cv2.rectangle(panel, (w // 2 - 340, 90), (w // 2 + 340, h - 50), (12, 12, 16), -1)
    cv2.addWeighted(panel, 0.85, frame, 0.15, 0, frame)
    cv2.rectangle(frame, (w // 2 - 340, 90), (w // 2 + 340, h - 50),
                  (0, 255, 128) if won else (0, 0, 255), 2)

    headline = "HEIST COMPLETE" if won else "SECURITY LOCKDOWN"
    cv2.putText(frame, headline, (w // 2 - 250, 115), cv2.FONT_HERSHEY_SIMPLEX, 1.2,
                (0, 255, 128) if won else (0, 0, 255), 3)
    cv2.putText(frame, f"POSES HELD: {cleared}/{len(poses)}   (needed {REQUIRED_POSES})",
                (w // 2 - 250, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    y = 190
    for pose, outcome in zip(poses, results):
        col = (0, 255, 120) if outcome else (0, 0, 255)
        mark = "HELD " if outcome else "BROKE"
        cv2.putText(frame, f"{pose['index']:2d}. {pose['name']:<26s} {mark}", (w // 2 - 250, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 1)
        y += 28

    cv2.putText(frame, "SPACE / CLICK START to run the sequence again   -   Q to quit",
                (w // 2 - 300, h - 90), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

def draw_hud(frame, state, pose, score, motion_val, timer_remaining, hold_remaining,
             grace_left, results, poses, waiting=False):
    h, w, _ = frame.shape

    cv2.rectangle(frame, (0, 0), (w, 100), (15, 15, 20), -1)
    cv2.line(frame, (0, 100), (w, 100), (0, 220, 255), 2)
    cleared = sum(1 for r in results if r)
    failed = sum(1 for r in results if r is False)
    cv2.putText(frame, "LOUVRE SECURITY // 10-POSE LASER GAUNTLET", (20, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 220, 255), 2)
    if pose is not None:
        cv2.putText(frame, f"POSE {pose['index']}/{len(poses)}: {pose['name']} - {pose['cue']}", (20, 58),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 220), 1)
    else:
        cv2.putText(frame, f"Hold {len(poses)} yoga poses for {POSE_HOLD_DURATION:.0f}s each. "
                           f"Clear {REQUIRED_POSES} to beat the lasers.", (20, 58),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 220), 1)
    cv2.putText(frame, f"HELD: {cleared}   BROKEN: {failed}   TARGET: {REQUIRED_POSES}", (20, 84),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (170, 170, 170), 1)

    if state == "IDLE":
        status_text, status_color = "READY - CLICK START", (0, 165, 255)
    elif state == "COUNTDOWN":
        status_text, status_color = "GET INTO POSE...", (0, 220, 255)
    elif state == "TRACKING":
        if waiting:
            status_text, status_color = "MATCH THE POSE", (0, 220, 255)
        else:
            status_text, status_color = f"HOLD: {hold_remaining:.1f}s", (0, 255, 0)
    elif state == "POSE_FAILED":
        status_text, status_color = "! ALARM - POSE LOST !", (0, 0, 255)
    elif state == "POSE_PASSED":
        status_text, status_color = "POSE SECURED", (0, 255, 128)
    else:
        status_text, status_color = "SEQUENCE OVER", (0, 255, 128)

    cv2.rectangle(frame, (w - 330, 12), (w - 20, 76), (25, 25, 30), -1)
    cv2.rectangle(frame, (w - 330, 12), (w - 20, 76), status_color, 2)
    cv2.putText(frame, status_text, (w - 315, 52), cv2.FONT_HERSHEY_SIMPLEX, 0.6, status_color, 2)

    if state == "SUMMARY":
        draw_summary(frame, poses, results)
        return

    if pose is not None:
        draw_reference_thumb(frame, pose)

    if state == "TRACKING":
        draw_check_panel(frame, score, grace_left, waiting)
    elif state == "COUNTDOWN":
        draw_check_panel(frame, score, None)

    draw_motion_meter(frame, motion_val)
    draw_progress_dots(frame, results, pose["index"] - 1 if pose else -1)

    if state == "IDLE":
        bx0, by0, bx1, by1 = start_button_rect(w, h)
        cv2.rectangle(frame, (bx0, by0), (bx1, by1), (0, 220, 255), -1)
        cv2.rectangle(frame, (bx0, by0), (bx1, by1), (0, 0, 0), 2)
        cv2.putText(frame, "CLICK START", (bx0 + 35, by0 + 27), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
        cv2.putText(frame, "or press SPACE", (bx0 + 45, by0 + 45), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (30, 30, 30), 1)
        cv2.putText(frame, "10 POSES - HOLD EACH FOR 10s", (w // 2 - 340, h // 2 - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 220, 255), 3)
        cv2.putText(frame, f"Match the target skeleton, stay still. {REQUIRED_POSES}/{len(poses)} clears the gauntlet.",
                    (w // 2 - 330, h // 2 + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1)
        cv2.putText(frame, "Stand back so your whole body is in frame. N = skip pose, R = restart, Q = quit.",
                    (w // 2 - 330, h // 2 + 50), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 150, 150), 1)
    elif state == "COUNTDOWN":
        secs = max(1, int(np.ceil(timer_remaining)))
        cv2.putText(frame, f"{secs}", (w // 2 - 45, h // 2 + 50),
                    cv2.FONT_HERSHEY_SIMPLEX, 4.5, (255, 220, 0), 11)
        cv2.putText(frame, f"GET INTO: {pose['name'].upper()}", (w // 2 - 290, h // 2 + 120),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    elif state == "TRACKING":
        cv2.putText(frame, f"{hold_remaining:.1f}", (w // 2 - 90, h // 2 + 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 3.5, (0, 255, 0), 9)
        frac = 1.0 - hold_remaining / POSE_HOLD_DURATION
        bx, by, bw, bh = w // 2 - 200, h // 2 + 80, 400, 18
        cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), (60, 60, 60), -1)
        cv2.rectangle(frame, (bx, by), (int(bx + bw * frac), by + bh), (0, 255, 0), -1)
        cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), (255, 255, 255), 1)
    elif state == "POSE_FAILED":
        cv2.putText(frame, "POSE BROKEN", (w // 2 - 220, h // 2),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 255), 4)
        cv2.putText(frame, "Next pose coming up...", (w // 2 - 150, h // 2 + 45),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
    elif state == "POSE_PASSED":
        cv2.putText(frame, "HELD - POSE SECURED", (w // 2 - 300, h // 2),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.3, (0, 255, 128), 4)
        cv2.putText(frame, "Next pose coming up...", (w // 2 - 150, h // 2 + 45),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)

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
        draw_hud(frame, state, hud_pose, score if hud_pose is active_pose else None,
                 motion, max(timer_remaining, 0.0), hold_remaining, grace_left, results, poses,
                 waiting=waiting)

        cv2.imshow(WINDOW_NAME, frame)

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    run_game()
