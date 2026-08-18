"""Flask backend for the Memory to Image treasure hunt game."""

import os
import json
import uuid
import base64
import random
from datetime import datetime, timezone
from functools import wraps

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import requests as http_requests
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv

import config
import scoring

load_dotenv()

app = Flask(__name__)
app.secret_key = config.FLASK_SECRET_KEY

os.makedirs("static/generated", exist_ok=True)

sessions: dict[str, dict] = {}
_active_teams: dict[str, str] = {}


def get_session(token: str) -> dict | None:
    return sessions.get(token)


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"success": False, "error": "Missing or invalid Authorization header"}), 401
        token = auth_header.split(" ", 1)[1].strip()
        session = get_session(token)
        if session is None:
            return jsonify({"success": False, "error": "Invalid or expired token"}), 401
        kwargs["token"] = token
        kwargs["session"] = session
        return f(*args, **kwargs)
    return decorated


def _load_scores() -> list[dict]:
    if not os.path.exists(config.SCORES_FILE):
        return []
    try:
        with open(config.SCORES_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []


def _save_scores(scores: list[dict]) -> None:
    with open(config.SCORES_FILE, "w", encoding="utf-8") as fh:
        json.dump(scores, fh, indent=2, ensure_ascii=False)


def _pick_image_pair() -> dict:
    """Pick 2 random images from the pool, return as {left, right}."""
    pool = list(config.IMAGE_POOL)
    if len(pool) < 2:
        raise ValueError(f"Need at least 2 images in {config.IMAGE_DIR}, found {len(pool)}")
    pair = random.sample(pool, 2)
    return {"left": pair[0], "right": pair[1]}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    team_name = data.get("team_name", "").strip().lower()
    password = data.get("password", "")

    if team_name not in config.TEAMS or config.TEAMS[team_name] != password:
        return jsonify({"success": False, "error": "Invalid credentials"}), 401

    if team_name in _active_teams:
        existing_token = _active_teams[team_name]
        if existing_token in sessions:
            del sessions[existing_token]
            del _active_teams[team_name]

    image_set = _pick_image_pair()

    token = str(uuid.uuid4())
    sessions[token] = {
        "team_name": team_name,
        "image_set": image_set,
        "game_state": "logged_in",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    _active_teams[team_name] = token

    return jsonify({
        "success": True,
        "token": token,
        "team_name": team_name,
        "display_seconds": config.IMAGE_DISPLAY_SECONDS,
        "prompt_seconds": config.PROMPT_PHASE_SECONDS,
    })


@app.route("/api/game/images", methods=["POST"])
@require_auth
def game_images(*, token: str, session: dict):
    image_set = session["image_set"]
    return jsonify({
        "success": True,
        "left": "/" + image_set["left"],
        "right": "/" + image_set["right"],
    })


@app.route("/api/game/generate", methods=["POST"])
@require_auth
def game_generate(*, token: str, session: dict):
    data = request.get_json(silent=True) or {}
    prompt_left = data.get("prompt_left", "").strip()
    prompt_right = data.get("prompt_right", "").strip()

    if not prompt_left and not prompt_right:
        return jsonify({"success": False, "error": "Please enter at least one prompt"}), 400

    prompt_left = prompt_left or "a random abstract colorful image"
    prompt_right = prompt_right or "a random abstract colorful image"

    cf_url = (
        f"https://api.cloudflare.com/client/v4/accounts/"
        f"{config.CF_ACCOUNT_ID}/ai/run/{config.CF_MODEL}"
    )
    cf_headers = {
        "Authorization": f"Bearer {config.CF_API_TOKEN}",
        "Content-Type": "application/json",
    }

    generated_paths = {}
    for side, prompt in [("left", prompt_left), ("right", prompt_right)]:
        try:
            resp = http_requests.post(
                cf_url,
                headers=cf_headers,
                json={"prompt": prompt},
                timeout=60,
            )

            if resp.status_code != 200:
                error_detail = resp.text[:300]
                print(f"[app] Cloudflare error ({side}): {resp.status_code} {error_detail}")
                return jsonify({"success": False, "error": f"Generation failed for {side}: {error_detail}"}), 502

            result = resp.json()
            img_b64 = None
            if isinstance(result.get("result"), dict):
                img_b64 = result["result"].get("image")

            if not img_b64:
                return jsonify({"success": False, "error": f"No image data for {side}"}), 502

            filename = f"{token}_{side}.png"
            save_path = os.path.join("static", "generated", filename)
            with open(save_path, "wb") as fh:
                fh.write(base64.b64decode(img_b64))

            # Resize to match original dimensions
            try:
                from PIL import Image as PILImage
                orig_img = PILImage.open(session["image_set"][side])
                gen_img = PILImage.open(save_path)
                if gen_img.size != orig_img.size:
                    gen_img = gen_img.resize(orig_img.size, PILImage.LANCZOS)
                    gen_img.save(save_path)
            except Exception as e:
                print(f"[app] Resize warning ({side}): {e}")

            generated_paths[side] = f"/static/generated/{filename}"

        except Exception as exc:
            print(f"[app] Cloudflare error ({side}): {exc}")
            return jsonify({"success": False, "error": f"Generation failed for {side}: {str(exc)}"}), 502

    session["generated_left"] = generated_paths["left"]
    session["generated_right"] = generated_paths["right"]
    session["game_state"] = "generated"

    return jsonify({
        "success": True,
        "generated_left": generated_paths["left"],
        "generated_right": generated_paths["right"],
    })


@app.route("/api/game/score", methods=["POST"])
@require_auth
def game_score(*, token: str, session: dict):
    image_set = session["image_set"]
    original_left = image_set["left"]
    original_right = image_set["right"]
    generated_left = session.get("generated_left", "")
    generated_right = session.get("generated_right", "")

    if not generated_left or not generated_right:
        return jsonify({"success": False, "error": "No generated images found."}), 400

    gen_left_path = generated_left.lstrip("/")
    gen_right_path = generated_right.lstrip("/")

    result_left = scoring.compute_combined_score(original_left, gen_left_path)
    result_right = scoring.compute_combined_score(original_right, gen_right_path)

    total_score = result_left["score"] + result_right["score"]

    entry = {
        "team_name": session["team_name"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "left": result_left,
        "right": result_right,
        "total_score": total_score,
        "max_score": 20,
    }
    scores = _load_scores()
    scores.append(entry)
    _save_scores(scores)

    session["game_state"] = "scored"

    return jsonify({
        "success": True,
        "results": {
            "left": {
                "original": "/" + original_left,
                "generated": generated_left,
                "content_pct": result_left["content_pct"],
                "structure_pct": result_left["structure_pct"],
                "color_pct": result_left["color_pct"],
                "combined_pct": result_left["combined_pct"],
                "score": result_left["score"],
            },
            "right": {
                "original": "/" + original_right,
                "generated": generated_right,
                "content_pct": result_right["content_pct"],
                "structure_pct": result_right["structure_pct"],
                "color_pct": result_right["color_pct"],
                "combined_pct": result_right["combined_pct"],
                "score": result_right["score"],
            },
        },
        "total_score": total_score,
        "max_score": 20,
    })


@app.route("/api/scores", methods=["GET"])
def get_scores():
    return jsonify(_load_scores())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
