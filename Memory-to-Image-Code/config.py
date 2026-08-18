import os
import glob
from dotenv import load_dotenv

load_dotenv()

IMAGE_DISPLAY_SECONDS = 10
PROMPT_PHASE_SECONDS = 60

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key")

CF_MODEL = "@cf/black-forest-labs/flux-1-schnell"
CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"

TEAMS = {
    "alpha": "hunt2026",
    "bravo": "hunt2026",
    "charlie": "hunt2026",
    "delta": "hunt2026",
}

IMAGE_DIR = "static/images"
IMAGE_POOL = sorted(
    p.replace("\\", "/") for p in
    glob.glob(os.path.join(IMAGE_DIR, "*.jpg"))
    + glob.glob(os.path.join(IMAGE_DIR, "*.jpeg"))
    + glob.glob(os.path.join(IMAGE_DIR, "*.png"))
)

SCORES_FILE = "scores.json"
