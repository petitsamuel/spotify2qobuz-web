"""FastAPI application for Spotify to Qobuz migration web interface."""

import os
import uuid
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from src.storage import Storage
from src.spotify_client import SpotifyClient
from src.qobuz_client import QobuzClient
from src.async_sync import AsyncSyncService, ProgressCallback

# Global state
storage: Storage = None
active_tasks: Dict[str, Dict] = {}
spotify_oauth_state: Dict[str, str] = {}

# Paths
BASE_DIR = Path(__file__).parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    global storage
    storage = Storage()
    await storage.init_db()
    yield


app = FastAPI(
    title="Spotify to Qobuz Migration",
    description="Migrate your playlists and saved songs from Spotify to Qobuz",
    lifespan=lifespan
)

# Mount static files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Templates
templates = Jinja2Templates(directory=TEMPLATES_DIR)


# Helper functions
async def get_auth_status() -> Dict:
    """Get authentication status for both services."""
    spotify_connected = await storage.has_credentials("spotify")
    qobuz_connected = await storage.has_credentials("qobuz")

    # Validate Qobuz token if we have one
    if qobuz_connected:
        creds = await storage.get_credentials("qobuz")
        if creds:
            try:
                client = QobuzClient(creds['user_auth_token'])
                client.authenticate()
            except Exception:
                qobuz_connected = False
                await storage.delete_credentials("qobuz")

    return {
        "spotify": spotify_connected,
        "qobuz": qobuz_connected,
        "both_connected": spotify_connected and qobuz_connected
    }


def get_spotify_client_from_env() -> Optional[tuple]:
    """Get Spotify credentials from environment."""
    client_id = os.environ.get('SPOTIFY_CLIENT_ID')
    client_secret = os.environ.get('SPOTIFY_CLIENT_SECRET')
    redirect_uri = os.environ.get('SPOTIFY_REDIRECT_URI', 'http://127.0.0.1:8000/auth/spotify/callback')

    if client_id and client_secret:
        return client_id, client_secret, redirect_uri
    return None


# Routes
@app.get("/", response_class=HTMLResponse)
async def home(request: Request, code: str = None, state: str = None, error: str = None):
    """Home page - also handles Spotify OAuth callback."""

    # Check if this is a Spotify OAuth callback
    if code and state:
        return await spotify_auth_callback_handler(request, code, state, error)

    if error:
        return templates.TemplateResponse("auth_error.html", {
            "request": request,
            "service": "Spotify",
            "error": error
        })

    auth_status = await get_auth_status()
    migrations = await storage.get_migrations(limit=5)

    return templates.TemplateResponse("index.html", {
        "request": request,
        "auth_status": auth_status,
        "migrations": migrations
    })


async def spotify_auth_callback_handler(request: Request, code: str, state: str, error: str = None):
    """Handle Spotify OAuth callback."""
    if error:
        return templates.TemplateResponse("auth_error.html", {
            "request": request,
            "service": "Spotify",
            "error": error
        })

    if not state or state not in spotify_oauth_state:
        return templates.TemplateResponse("auth_error.html", {
            "request": request,
            "service": "Spotify",
            "error": "Invalid state parameter"
        })

    del spotify_oauth_state[state]

    creds = get_spotify_client_from_env()
    if not creds:
        raise HTTPException(status_code=400, detail="Spotify credentials not configured")

    client_id, client_secret, redirect_uri = creds

    # Exchange code for token
    import httpx
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": client_id,
                "client_secret": client_secret
            }
        )

        if response.status_code != 200:
            return templates.TemplateResponse("auth_error.html", {
                "request": request,
                "service": "Spotify",
                "error": f"Token exchange failed: {response.text}"
            })

        token_data = response.json()

    # Save credentials
    await storage.save_credentials("spotify", {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "access_token": token_data['access_token'],
        "refresh_token": token_data.get('refresh_token'),
        "expires_at": datetime.now().timestamp() + token_data.get('expires_in', 3600)
    })

    return RedirectResponse("/?spotify_connected=true")


@app.get("/auth/spotify")
async def spotify_auth_start(request: Request):
    """Start Spotify OAuth flow."""
    creds = get_spotify_client_from_env()
    if not creds:
        raise HTTPException(
            status_code=400,
            detail="Spotify credentials not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables."
        )

    client_id, client_secret, redirect_uri = creds

    # Generate state for CSRF protection
    state = str(uuid.uuid4())
    spotify_oauth_state[state] = datetime.now().isoformat()

    # Build authorization URL
    scope = "playlist-read-private playlist-read-collaborative user-library-read"
    auth_url = (
        f"https://accounts.spotify.com/authorize"
        f"?client_id={client_id}"
        f"&response_type=code"
        f"&redirect_uri={redirect_uri}"
        f"&scope={scope}"
        f"&state={state}"
    )

    return RedirectResponse(auth_url)


@app.get("/auth/spotify/callback")
async def spotify_auth_callback(request: Request, code: str = None, state: str = None, error: str = None):
    """Handle Spotify OAuth callback."""
    return await spotify_auth_callback_handler(request, code, state, error)


@app.get("/auth/qobuz", response_class=HTMLResponse)
async def qobuz_auth_page(request: Request):
    """Qobuz authentication page."""
    return templates.TemplateResponse("qobuz_auth.html", {"request": request})


@app.post("/auth/qobuz/token")
async def qobuz_auth_token(request: Request):
    """Save Qobuz token submitted by user."""
    form = await request.form()
    token = form.get("token", "").strip()

    if not token:
        raise HTTPException(status_code=400, detail="Token is required")

    # Validate token
    try:
        client = QobuzClient(token)
        client.authenticate()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid token: {e}")

    # Save credentials
    await storage.save_credentials("qobuz", {
        "user_auth_token": token
    })

    return RedirectResponse("/?qobuz_connected=true", status_code=303)


@app.post("/auth/qobuz/browser")
async def qobuz_auth_browser():
    """Start browser-based Qobuz authentication."""
    from src.qobuz_auth import extract_qobuz_token_from_browser

    token_data = await extract_qobuz_token_from_browser(headless=False)

    if not token_data:
        raise HTTPException(status_code=400, detail="Failed to extract token from browser")

    # Save credentials
    await storage.save_credentials("qobuz", token_data)

    return {"success": True, "message": "Qobuz connected successfully"}


@app.post("/auth/{service}/disconnect")
async def disconnect_service(service: str):
    """Disconnect a service."""
    if service not in ["spotify", "qobuz"]:
        raise HTTPException(status_code=400, detail="Invalid service")

    await storage.delete_credentials(service)
    return RedirectResponse("/", status_code=303)


@app.get("/playlists", response_class=HTMLResponse)
async def list_playlists(request: Request):
    """List Spotify playlists."""
    auth_status = await get_auth_status()
    if not auth_status["spotify"]:
        return RedirectResponse("/")

    creds = await storage.get_credentials("spotify")
    try:
        client = SpotifyClient(
            client_id=creds['client_id'],
            client_secret=creds['client_secret'],
            redirect_uri=creds['redirect_uri']
        )
        # Use stored token
        import spotipy
        client.sp = spotipy.Spotify(auth=creds['access_token'])
        playlists = client.list_playlists()
    except Exception as e:
        return templates.TemplateResponse("error.html", {
            "request": request,
            "error": f"Failed to fetch playlists: {e}"
        })

    return templates.TemplateResponse("playlists.html", {
        "request": request,
        "playlists": playlists,
        "auth_status": auth_status
    })


@app.post("/sync/start")
async def start_sync(request: Request, background_tasks: BackgroundTasks):
    """Start a sync task."""
    auth_status = await get_auth_status()
    if not auth_status["both_connected"]:
        raise HTTPException(status_code=400, detail="Both services must be connected")

    form = await request.form()
    sync_type = form.get("type", "playlists")
    playlist_ids = form.getlist("playlist_ids")
    dry_run = form.get("dry_run") == "true"

    # Create task
    task_id = str(uuid.uuid4())
    migration_id = await storage.create_migration(sync_type)
    await storage.create_task(task_id, migration_id)

    active_tasks[task_id] = {
        "status": "starting",
        "progress": {},
        "migration_id": migration_id
    }

    # Start background sync
    background_tasks.add_task(
        run_sync_task,
        task_id,
        migration_id,
        sync_type,
        playlist_ids if playlist_ids else None,
        dry_run
    )

    return {"task_id": task_id}


async def run_sync_task(
    task_id: str,
    migration_id: int,
    sync_type: str,
    playlist_ids: list,
    dry_run: bool
):
    """Run sync task in background."""
    try:
        active_tasks[task_id]["status"] = "running"
        await storage.update_task(task_id, "running")

        # Get credentials
        spotify_creds = await storage.get_credentials("spotify")
        qobuz_creds = await storage.get_credentials("qobuz")

        # Create clients
        spotify_client = SpotifyClient(
            client_id=spotify_creds['client_id'],
            client_secret=spotify_creds['client_secret'],
            redirect_uri=spotify_creds['redirect_uri']
        )
        import spotipy
        spotify_client.sp = spotipy.Spotify(auth=spotify_creds['access_token'])

        qobuz_client = QobuzClient(qobuz_creds['user_auth_token'])
        qobuz_client.authenticate()

        # Progress callback - just update in-memory dict (no async calls from thread)
        def on_progress(progress: Dict):
            active_tasks[task_id]["progress"] = progress

        progress_callback = ProgressCallback(on_progress)

        # Run sync
        sync_service = AsyncSyncService(
            spotify_client=spotify_client,
            qobuz_client=qobuz_client,
            progress_callback=progress_callback
        )

        if sync_type == "favorites":
            # Load already synced tracks for resume support
            already_synced = await storage.get_synced_track_ids("favorites")

            report = await sync_service.sync_favorites(
                dry_run=dry_run,
                already_synced=already_synced
            )

            # Persist newly synced tracks for resume
            if not dry_run:
                for synced in report.get("synced_tracks", []):
                    await storage.mark_track_synced(
                        synced["spotify_id"],
                        synced["qobuz_id"],
                        "favorites"
                    )
        else:
            report = await sync_service.sync_playlists(
                playlist_ids=playlist_ids,
                dry_run=dry_run
            )

        # Update storage
        await storage.update_migration(
            migration_id,
            completed_at=datetime.now().isoformat(),
            status="completed",
            tracks_matched=report.get("tracks_matched", 0),
            tracks_not_matched=report.get("tracks_not_matched", 0),
            isrc_matches=report.get("isrc_matches", 0),
            fuzzy_matches=report.get("fuzzy_matches", 0),
            report_json=str(report)
        )

        active_tasks[task_id]["status"] = "completed"
        active_tasks[task_id]["report"] = report
        await storage.update_task(task_id, "completed", report)

    except Exception as e:
        active_tasks[task_id]["status"] = "failed"
        active_tasks[task_id]["error"] = str(e)
        await storage.update_task(task_id, "failed", {"error": str(e)})
        await storage.update_migration(migration_id, status="failed", completed_at=datetime.now().isoformat())


@app.get("/sync/status/{task_id}")
async def get_sync_status(task_id: str):
    """Get sync task status."""
    if task_id in active_tasks:
        return active_tasks[task_id]

    task = await storage.get_task(task_id)
    if task:
        return task

    raise HTTPException(status_code=404, detail="Task not found")


@app.get("/history", response_class=HTMLResponse)
async def migration_history(request: Request):
    """Show migration history."""
    migrations = await storage.get_migrations(limit=50)
    return templates.TemplateResponse("history.html", {
        "request": request,
        "migrations": migrations
    })


@app.get("/api/spotify/stats")
async def get_spotify_stats():
    """Get Spotify library statistics."""
    auth_status = await get_auth_status()
    if not auth_status["spotify"]:
        raise HTTPException(status_code=401, detail="Spotify not connected")

    creds = await storage.get_credentials("spotify")
    try:
        client = SpotifyClient(
            client_id=creds['client_id'],
            client_secret=creds['client_secret'],
            redirect_uri=creds['redirect_uri']
        )
        import spotipy
        client.sp = spotipy.Spotify(auth=creds['access_token'])

        # Get playlist count
        playlists = client.sp.current_user_playlists(limit=1)
        playlist_count = playlists.get('total', 0)

        # Get saved tracks count
        saved = client.sp.current_user_saved_tracks(limit=1)
        saved_count = saved.get('total', 0)

        return {
            "playlists": playlist_count,
            "savedTracks": saved_count
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch Spotify stats: {e}")


@app.get("/api/qobuz/stats")
async def get_qobuz_stats():
    """Get Qobuz library statistics."""
    auth_status = await get_auth_status()
    if not auth_status["qobuz"]:
        raise HTTPException(status_code=401, detail="Qobuz not connected")

    creds = await storage.get_credentials("qobuz")
    try:
        client = QobuzClient(creds['user_auth_token'])
        client.authenticate()

        # Get user playlists
        all_playlists = client.list_user_playlists()
        playlist_count = len(all_playlists)

        # Count playlists from Spotify (those with "[Spotify]" in name)
        from_spotify = sum(1 for p in all_playlists
                          if '[Spotify]' in p.get('name', ''))

        # Get favorites count
        favorites = client.get_favorite_tracks()
        favorites_count = len(favorites)

        return {
            "playlists": playlist_count,
            "fromSpotify": from_spotify,
            "favorites": favorites_count
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch Qobuz stats: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
