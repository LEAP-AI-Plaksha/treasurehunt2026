"""Bridge between the Flask ML service and the Supabase backend.

Supabase owns auth, riddles, route order and all timing. This module gives Flask
the two things it still needs:

  require_team_jwt  - verify the crew's Supabase access token and recover which
                      team is calling, replacing the old in-memory ACTIVE_SESSIONS
  record_ml_result  - report a pose hold / CLIP match / sketch verdict back to
                      Supabase, which stamps the completion time server-side

Flask is deliberately NOT allowed to decide when a room is complete on its own:
it reports a pass/fail and Supabase does the timing, so every room in the event
is timed by the same clock.
"""

import os
from functools import wraps

import jwt
import requests as http_requests
from flask import jsonify, request
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
# Legacy shared-secret projects only. Modern Supabase projects (including any
# local stack started with a recent CLI) sign access tokens asymmetrically
# (ES256) instead, verified below via the project's published JWKS - this
# variable is kept only as a fallback for older HS256-only projects.
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
TEAM_EMAIL_DOMAIN = os.getenv("TEAM_EMAIL_DOMAIN", "louvre.local")

_jwks_client: "jwt.PyJWKClient | None" = None


class SupabaseNotConfigured(RuntimeError):
    pass


def _require_config() -> None:
    missing = [
        name for name, value in (
            ("SUPABASE_URL", SUPABASE_URL),
            ("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY),
        ) if not value
    ]
    if missing:
        raise SupabaseNotConfigured(
            "Missing environment variables: " + ", ".join(missing)
        )


def _jwks_client_for_project() -> "jwt.PyJWKClient":
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = jwt.PyJWKClient(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json")
    return _jwks_client


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def team_code_from_token(token: str) -> str:
    """Verify a Supabase access token and return the crew's team code.

    Crews sign in as <team>@<TEAM_EMAIL_DOMAIN>, so the team code is the local
    part of the email in the verified claims. Raises jwt exceptions on a bad,
    expired or wrong-audience token.

    Tries the project's JWKS first (ES256 - what every current Supabase project
    issues, local or hosted), falling back to the legacy HS256 shared secret for
    an older project still configured that way.
    """
    _require_config()

    claims = None
    jwks_error: Exception | None = None
    try:
        signing_key = _jwks_client_for_project().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token, signing_key.key, algorithms=["ES256"], audience="authenticated", leeway=120
        )
    except jwt.PyJWKClientError as exc:
        jwks_error = exc

    if claims is None:
        if not SUPABASE_JWT_SECRET:
            raise jwt.InvalidTokenError(f"Could not verify token via JWKS: {jwks_error}")
        claims = jwt.decode(
            token, SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated", leeway=120
        )

    email = claims.get("email") or ""
    local_part, _, domain = email.partition("@")
    if not local_part or domain != TEAM_EMAIL_DOMAIN:
        raise jwt.InvalidTokenError(f"Token is not a crew login: {email!r}")
    return local_part.upper()


def require_team_jwt(f):
    """Validate the Supabase Bearer token and inject the team code."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"success": False, "error": "Missing authorization token"}), 401

        token = auth_header.split(" ", 1)[1].strip()
        try:
            team_code = team_code_from_token(token)
        except SupabaseNotConfigured as exc:
            return jsonify({"success": False, "error": str(exc)}), 500
        except jwt.ExpiredSignatureError:
            return jsonify({"success": False, "error": "Session expired, sign in again"}), 401
        except jwt.InvalidTokenError as exc:
            return jsonify({"success": False, "error": f"Invalid token: {exc}"}), 401

        return f(team_code, *args, **kwargs)
    return decorated


# ---------------------------------------------------------------------------
# Reporting results
# ---------------------------------------------------------------------------

def record_ml_result(team_code: str, room_code: str, passed: bool, detail: dict | None = None) -> dict:
    """Tell Supabase how a machine-graded room went.

    Calls the record_ml_result RPC with the service role key. Supabase stamps
    completed_at, awards the points and enforces the attempt limit, so this
    function never decides scoring itself.
    """
    _require_config()
    response = http_requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/record_ml_result",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "p_team_code": team_code,
            "p_room_code": room_code,
            "p_passed": passed,
            "p_detail": detail or {},
        },
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def fetch_room_config(room_code: str) -> dict:
    """Read a room's rules from Supabase, so timers live in one place."""
    _require_config()
    response = http_requests.get(
        f"{SUPABASE_URL}/rest/v1/rooms",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        },
        params={"code": f"eq.{room_code}", "select": "*", "limit": "1"},
        timeout=15,
    )
    response.raise_for_status()
    rows = response.json()
    if not rows:
        raise LookupError(f"Unknown room: {room_code}")
    return rows[0]
