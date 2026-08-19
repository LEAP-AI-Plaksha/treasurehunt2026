# AGENTS.md

Single-file computer-vision game: `louvre_laser_game.py`. The player runs a gauntlet of **10 yoga poses**, holding each one for `POSE_HOLD_DURATION` (10s) while simulated laser grids sweep the webcam feed. Clearing `REQUIRED_POSES` (7) of the 10 wins; anything less is a lockdown.

Per-pose flow, repeated for all 10 poses:

`COUNTDOWN` (5s, reference shown) → `TRACKING` (accumulate a 10s hold) → `POSE_PASSED` / `POSE_FAILED` (2s card) → next pose. After the last pose: `SUMMARY` with a per-pose scorecard. `IDLE` is the pre-game screen (click START / press SPACE).

## Running

Deps are already installed in `.venv` (cv2 5.0, numpy 2.5, ultralytics 8.4):

```bash
cd Leap-Louvre-Game
source .venv/bin/activate
python louvre_laser_game.py
```

- `yolov8n-pose.pt` is present in the repo; no download needed.
- Requires a webcam — `cv2.VideoCapture(0)`, forced to 1280x720, frame is mirrored.
- Keys: `SPACE`/`ENTER` or click START = begin/replay, `N` = skip the current pose (counts as broken), `R` = restart the sequence, `Q` = quit. There is no CLI, no lint config, no CI.
- Stand far enough back that ankles and wrists are in frame; every check needs its keypoints above `CONF_THRESHOLD`.

## The pose library

`POSE_LIBRARY` holds the 10 poses in play order: Five-Pointed Star, Goddess, Warrior II, Reverse Warrior, Extended Triangle, Wide-Legged Forward Fold, Standing Crescent Moon, Tree, Standing Figure Four, Dancer's Pose.

Each entry authors a **front-view skeleton** as normalised COCO keypoints in a square space (`x`, `y` in 0..1, y grows downward, index → `(x, y)`). Everything else is derived from those points at startup by `build_pose_sequence`:

- `build_targets` produces the joint-angle targets (`JOINTS`) and limb-direction targets (`AXES`).
- `make_thumb` draws the reference stick figure the player copies — so **the picture on screen is exactly what the matcher checks**.
- `mirror_keypoints` builds a left/right-swapped copy, giving each pose a second target set.

Author coordinates as they should *appear on screen*. The feed is mirrored, so YOLO's "left" labels track the player's right side; matching is mirror-tolerant (`evaluate_pose` scores both target sets and keeps the better), so either side of a one-sided pose is accepted.

Optional per-pose image fields:

- `"photo": "file.jpg"` — show the photo as the reference thumbnail, but still judge against the authored skeleton. Tree Pose uses `Vrikshasana.jpeg` this way; deriving targets from that photo instead gave one person's quirks (standing knee at 148° rather than straight).
- `"image": "file.jpg"` — run YOLOv8-pose on the photo at startup and use **its** joint angles as the targets (`keypoints_from_image`), falling back to the authored skeleton with a `[WARN]` if the file is unreadable or no confident person is found. Useful for adding poses straight from photos.

## Pose matching

`evaluate_pose` → `score_targets` runs 15 checks per pose and requires `POSE_MATCH_RATIO` (0.8, i.e. 12 of 15) to pass:

| Check family | Count | What it compares | Tolerance |
|---|---|---|---|
| Joint angles (`JOINTS`) | 6 | elbow / armpit / knee angles | `ANGLE_TOLERANCE` 30° |
| Limb directions (`AXES`) | 9 | absolute screen angle of torso, upper arms, forearms, thighs, shins | `AXIS_TOLERANCE` 35° |

The axis checks exist because joint angles alone are rotation-invariant — a forward fold and a stand have identical elbow/knee angles. Both families are scale- and position-invariant, so the player's distance from the camera does not matter.

Stillness: `compute_frame_motion` averages landmark drift over `STILLNESS_ANCHORS` and divides by torso length, so `MOTION_LIMIT` (0.055) is a fraction of body size rather than pixels.

Tuning notes, measured against the authored skeletons:

- At the shipped settings every pose scores 100% against itself and survives heavy keypoint noise (≥83% pass rate with 3%-of-body-height jitter on every landmark).
- A few visually similar pairs (Star/Reverse Warrior, Star/Crescent Moon, Reverse Warrior/Triangle) cross-match at 80–87%, so doing the neighbouring pose can also register. Raising `POSE_MATCH_RATIO` to 13/15 removes that but drops real-body pass rates to ~42–66%, which is why the lenient setting ships. If you add or re-author poses, re-check the cross-pose matrix before trusting the score.

## Hold timing

Inside `TRACKING`:

- `held_time` accumulates only while the pose matches *and* motion is under the limit; the timer pauses rather than resets when the player wobbles.
- `hold_started` gates the failure clock: before the first successful match the player is still settling in ("MATCH THE POSE TO START THE CLOCK") and cannot fail on grace — only `POSE_TIME_LIMIT` (30s) bounds them.
- Once the hold has begun, breaking it for longer than `BREAK_GRACE` (1s) fails that pose; shorter wobbles are forgiven.

## Working in this file

- Everything lives in the single file: `POSE_LIBRARY`, geometry helpers (`calculate_angle`, `direction_angle`, `angle_delta`, `compute_frame_motion`), target building, `score_targets`/`evaluate_pose`, HUD rendering (`draw_hud` and its `draw_*` helpers), and the state machine in `run_game()`.
- Behaviour-changing constants are module-level in the `# CONSTANTS` block, not inline.
- Keypoint indices are COCO 17 (`kpts[idx][0]=x, [1]=y, [2]=confidence`); the index legend sits above `JOINTS`. Only the most prominent detected person is used (`results[0].keypoints.data[0]`).
- The HUD re-reads the pose to draw *after* the state machine runs (`pose_on_screen()`), so a transition frame never pairs a new state with the previous pose's reference.
- `draw_hud` is the single render entry point; it returns early for `SUMMARY` so the scorecard owns the frame.
