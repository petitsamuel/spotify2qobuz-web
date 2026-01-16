"""FastAPI application for Spotify to Qobuz migration web interface."""

import os
import uuid
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, Form
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
    # Clean up any stale "running" tasks from previous crashes
    await storage.cleanup_stale_tasks()
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


async def get_valid_spotify_token(creds: Dict) -> str:
    """Get a valid Spotify access token, refreshing if expired."""
    import httpx
    from datetime import datetime

    expires_at = creds.get('expires_at', 0)
    # Refresh if token expires in less than 5 minutes
    if datetime.now().timestamp() < expires_at - 300:
        return creds['access_token']

    # Token expired or expiring soon, refresh it
    refresh_token = creds.get('refresh_token')
    if not refresh_token:
        raise HTTPException(
            status_code=401,
            detail="Spotify session expired and no refresh token available. Please reconnect Spotify."
        )

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": creds['client_id'],
                "client_secret": creds['client_secret']
            }
        )

        if response.status_code != 200:
            raise HTTPException(
                status_code=401,
                detail="Failed to refresh Spotify token. Please reconnect Spotify."
            )

        token_data = response.json()

    # Update stored credentials with new token
    new_creds = {
        **creds,
        "access_token": token_data['access_token'],
        "expires_at": datetime.now().timestamp() + token_data.get('expires_in', 3600)
    }
    # If Spotify returned a new refresh token, use it
    if 'refresh_token' in token_data:
        new_creds['refresh_token'] = token_data['refresh_token']

    await storage.save_credentials("spotify", new_creds)

    return token_data['access_token']


async def get_authenticated_spotify_client() -> SpotifyClient:
    """Get a SpotifyClient with a valid, refreshed access token."""
    import spotipy

    creds = await storage.get_credentials("spotify")
    if not creds:
        raise HTTPException(status_code=401, detail="Spotify not connected")

    access_token = await get_valid_spotify_token(creds)

    client = SpotifyClient(
        client_id=creds['client_id'],
        client_secret=creds['client_secret'],
        redirect_uri=creds['redirect_uri']
    )
    client.sp = spotipy.Spotify(auth=access_token)

    return client


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

    try:
        client = await get_authenticated_spotify_client()
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
    migration_id = await storage.create_migration(sync_type, dry_run=dry_run)
    await storage.create_task(task_id, migration_id)

    active_tasks[task_id] = {
        "status": "starting",
        "sync_type": sync_type,
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
    progress_saver_task = None

    try:
        active_tasks[task_id]["status"] = "running"
        await storage.update_task(task_id, "running")

        # Get credentials
        qobuz_creds = await storage.get_credentials("qobuz")

        # Create clients
        spotify_client = await get_authenticated_spotify_client()

        qobuz_client = QobuzClient(qobuz_creds['user_auth_token'])
        qobuz_client.authenticate()

        # Progress callback - just update in-memory dict (no async calls from thread)
        def on_progress(progress: Dict):
            active_tasks[task_id]["progress"] = progress

        progress_callback = ProgressCallback(on_progress)

        # Start background task to periodically save progress to migration table
        async def save_progress_periodically():
            while True:
                await asyncio.sleep(2)  # Save every 2 seconds
                progress = active_tasks.get(task_id, {}).get("progress", {})
                if progress:
                    await storage.update_migration(
                        migration_id,
                        tracks_matched=progress.get("tracks_matched", 0),
                        tracks_not_matched=progress.get("tracks_not_matched", 0),
                        isrc_matches=progress.get("isrc_matches", 0),
                        fuzzy_matches=progress.get("fuzzy_matches", 0)
                    )

        progress_saver_task = asyncio.create_task(save_progress_periodically())

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

            # Save unmatched tracks to DB for review
            for missing in report.get("missing_tracks", []):
                await storage.save_unmatched_track(
                    spotify_id=missing.get("spotify_id", ""),
                    title=missing.get("title", ""),
                    artist=missing.get("artist", ""),
                    album=missing.get("album", ""),
                    sync_type="favorites",
                    suggestions=missing.get("suggestions", [])
                )
        elif sync_type == "albums":
            # Load already synced albums for resume support
            already_synced = await storage.get_synced_track_ids("albums")

            report = await sync_service.sync_albums(
                dry_run=dry_run,
                already_synced=already_synced
            )

            # Persist newly synced albums for resume
            if not dry_run:
                for synced in report.get("synced_albums", []):
                    await storage.mark_track_synced(
                        synced["spotify_id"],
                        synced["qobuz_id"],
                        "albums"
                    )

            # Save unmatched albums to DB for review
            for missing in report.get("missing_albums", []):
                await storage.save_unmatched_track(
                    spotify_id=missing.get("spotify_id", ""),
                    title=missing.get("title", ""),
                    artist=missing.get("artist", ""),
                    album="",  # Albums don't have an album field
                    sync_type="albums",
                    suggestions=missing.get("suggestions", [])
                )

            # Map album-specific keys to generic keys for display
            report["tracks_matched"] = report.get("albums_matched", 0)
            report["tracks_not_matched"] = report.get("albums_not_matched", 0)
            report["isrc_matches"] = report.get("upc_matches", 0)
        else:
            report = await sync_service.sync_playlists(
                playlist_ids=playlist_ids,
                dry_run=dry_run
            )

        # Stop the progress saver
        if progress_saver_task:
            progress_saver_task.cancel()
            try:
                await progress_saver_task
            except asyncio.CancelledError:
                pass

        # Update storage with final results
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
        # Stop the progress saver on error
        if progress_saver_task:
            progress_saver_task.cancel()
            try:
                await progress_saver_task
            except asyncio.CancelledError:
                pass

        # Save final progress before marking failed
        progress = active_tasks.get(task_id, {}).get("progress", {})
        if progress:
            await storage.update_migration(
                migration_id,
                tracks_matched=progress.get("tracks_matched", 0),
                tracks_not_matched=progress.get("tracks_not_matched", 0),
                isrc_matches=progress.get("isrc_matches", 0),
                fuzzy_matches=progress.get("fuzzy_matches", 0)
            )

        active_tasks[task_id]["status"] = "failed"
        active_tasks[task_id]["error"] = str(e)
        await storage.update_task(task_id, "failed", {"error": str(e)})
        await storage.update_migration(migration_id, status="failed", completed_at=datetime.now().isoformat())


@app.get("/sync/active")
async def get_active_sync():
    """Get currently running sync task, if any."""
    for task_id, task in active_tasks.items():
        if task.get("status") == "running":
            return {"task_id": task_id, **task}
    return {"task_id": None}


@app.get("/sync/status/{task_id}")
async def get_sync_status(task_id: str):
    """Get sync task status."""
    if task_id in active_tasks:
        return active_tasks[task_id]

    task = await storage.get_task(task_id)
    if task:
        return task

    raise HTTPException(status_code=404, detail="Task not found")


@app.post("/api/qobuz/favorite")
async def add_qobuz_favorite(qobuz_id: int = Form(...), spotify_id: str = Form(None)):
    """Manually add a track to Qobuz favorites."""
    auth_status = await get_auth_status()
    if not auth_status["qobuz"]:
        raise HTTPException(status_code=401, detail="Qobuz not connected")

    creds = await storage.get_credentials("qobuz")
    try:
        client = QobuzClient(creds['user_auth_token'])
        client.authenticate()
        success = client.add_favorite_track(qobuz_id)

        if success and spotify_id:
            # Mark as synced so it won't appear in missing tracks next time
            await storage.mark_track_synced(spotify_id, str(qobuz_id), "favorites")

        return {"success": success, "qobuz_id": qobuz_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to add favorite: {e}")


@app.get("/history", response_class=HTMLResponse)
async def migration_history(request: Request):
    """Show migration history."""
    migrations = await storage.get_migrations(limit=50)
    return templates.TemplateResponse("history.html", {
        "request": request,
        "migrations": migrations
    })


@app.get("/review", response_class=HTMLResponse)
async def review_page(request: Request):
    """Review unmatched tracks page."""
    auth_status = await get_auth_status()
    favorites_count = await storage.get_unmatched_count(sync_type="favorites", status="pending")
    albums_count = await storage.get_unmatched_count(sync_type="albums", status="pending")

    return templates.TemplateResponse("review.html", {
        "request": request,
        "auth_status": auth_status,
        "favorites_count": favorites_count,
        "albums_count": albums_count
    })


@app.get("/api/unmatched")
async def get_unmatched_tracks(
    sync_type: str = None,
    status: str = "pending",
    limit: int = 50,
    offset: int = 0
):
    """Get unmatched tracks for review."""
    tracks = await storage.get_unmatched_tracks(
        sync_type=sync_type,
        status=status,
        limit=limit,
        offset=offset
    )
    total = await storage.get_unmatched_count(sync_type=sync_type, status=status)

    return {
        "tracks": tracks,
        "total": total,
        "limit": limit,
        "offset": offset
    }


@app.post("/api/unmatched/{spotify_id}/resolve")
async def resolve_unmatched(
    spotify_id: str,
    qobuz_id: int = Form(...),
    sync_type: str = Form(...)
):
    """Resolve an unmatched track by adding it to Qobuz favorites."""
    auth_status = await get_auth_status()
    if not auth_status["qobuz"]:
        raise HTTPException(status_code=401, detail="Qobuz not connected")

    creds = await storage.get_credentials("qobuz")
    try:
        client = QobuzClient(creds['user_auth_token'])
        client.authenticate()

        # Add to favorites based on sync type
        if sync_type == "albums":
            success = client.add_favorite_album(qobuz_id)
        else:
            success = client.add_favorite_track(qobuz_id)

        if success:
            # Mark as resolved in DB
            await storage.resolve_unmatched_track(spotify_id, sync_type, str(qobuz_id))
            # Also mark as synced so it won't appear again
            await storage.mark_track_synced(spotify_id, str(qobuz_id), sync_type)

        return {"success": success, "qobuz_id": qobuz_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to resolve: {e}")


@app.post("/api/unmatched/{spotify_id}/dismiss")
async def dismiss_unmatched(spotify_id: str, sync_type: str = Form(...)):
    """Dismiss an unmatched track (user chose to skip)."""
    await storage.dismiss_unmatched_track(spotify_id, sync_type)
    return {"success": True}


@app.post("/api/unmatched/clear")
async def clear_unmatched(sync_type: str = Form(None)):
    """Clear all unmatched tracks."""
    await storage.clear_unmatched_tracks(sync_type)
    return {"success": True}


@app.get("/compare", response_class=HTMLResponse)
async def compare_page(request: Request):
    """Compare libraries page."""
    auth_status = await get_auth_status()
    return templates.TemplateResponse("compare.html", {
        "request": request,
        "auth_status": auth_status
    })


@app.get("/api/compare/favorites")
async def compare_favorites():
    """Compare Spotify saved tracks with Qobuz favorites."""
    auth_status = await get_auth_status()
    if not auth_status["both_connected"]:
        raise HTTPException(status_code=400, detail="Both services must be connected")

    qobuz_creds = await storage.get_credentials("qobuz")

    # Get Spotify saved tracks
    spotify_client = await get_authenticated_spotify_client()

    # Get Qobuz favorites
    qobuz_client = QobuzClient(qobuz_creds['user_auth_token'])
    qobuz_client.authenticate()

    # Fetch data
    spotify_tracks = []
    for track, spotify_id, offset, total in spotify_client.iter_saved_tracks():
        spotify_tracks.append({
            "id": spotify_id,
            "title": track['title'],
            "artist": track['artist'],
            "album": track['album'],
            "isrc": track.get('isrc')
        })

    # Get Qobuz favorite tracks with details
    qobuz_favorites = []
    try:
        url = f"{qobuz_client.BASE_URL}/favorite/getUserFavorites"
        params = {"type": "tracks", "limit": 5000}
        response = qobuz_client._session.get(url, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()

        if 'tracks' in data and 'items' in data['tracks']:
            for item in data['tracks']['items']:
                qobuz_favorites.append({
                    "id": item['id'],
                    "title": item.get('title', ''),
                    "artist": item.get('performer', {}).get('name', ''),
                    "album": item.get('album', {}).get('title', ''),
                    "isrc": item.get('isrc')
                })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch Qobuz favorites: {e}")

    # Compare by ISRC first, then by title+artist
    spotify_by_isrc = {t['isrc']: t for t in spotify_tracks if t.get('isrc')}
    qobuz_by_isrc = {t['isrc']: t for t in qobuz_favorites if t.get('isrc')}

    matched = []
    only_spotify = []
    only_qobuz = []

    matched_spotify_ids = set()
    matched_qobuz_ids = set()

    # ISRC matching
    for isrc, spotify_track in spotify_by_isrc.items():
        if isrc in qobuz_by_isrc:
            matched.append({
                "spotify": spotify_track,
                "qobuz": qobuz_by_isrc[isrc],
                "match_type": "isrc"
            })
            matched_spotify_ids.add(spotify_track['id'])
            matched_qobuz_ids.add(qobuz_by_isrc[isrc]['id'])

    # Fuzzy matching for remaining tracks
    from rapidfuzz import fuzz

    def normalize(s):
        return s.lower().strip() if s else ""

    for spotify_track in spotify_tracks:
        if spotify_track['id'] in matched_spotify_ids:
            continue

        best_match = None
        best_score = 0

        for qobuz_track in qobuz_favorites:
            if qobuz_track['id'] in matched_qobuz_ids:
                continue

            title_score = fuzz.ratio(normalize(spotify_track['title']), normalize(qobuz_track['title']))
            artist_score = fuzz.ratio(normalize(spotify_track['artist']), normalize(qobuz_track['artist']))
            combined = (title_score + artist_score) / 2

            if combined > best_score and combined >= 85:
                best_score = combined
                best_match = qobuz_track

        if best_match:
            matched.append({
                "spotify": spotify_track,
                "qobuz": best_match,
                "match_type": "fuzzy",
                "score": round(best_score, 1)
            })
            matched_spotify_ids.add(spotify_track['id'])
            matched_qobuz_ids.add(best_match['id'])
        else:
            only_spotify.append(spotify_track)

    # Find Qobuz tracks not matched
    for qobuz_track in qobuz_favorites:
        if qobuz_track['id'] not in matched_qobuz_ids:
            only_qobuz.append(qobuz_track)

    return {
        "matched": len(matched),
        "only_spotify": len(only_spotify),
        "only_qobuz": len(only_qobuz),
        "spotify_total": len(spotify_tracks),
        "qobuz_total": len(qobuz_favorites),
        "matched_tracks": matched[:100],  # Limit for response size
        "missing_from_qobuz": only_spotify[:100],
        "extra_in_qobuz": only_qobuz[:100]
    }


@app.get("/api/compare/albums")
async def compare_albums():
    """Compare Spotify saved albums with Qobuz favorite albums."""
    auth_status = await get_auth_status()
    if not auth_status["both_connected"]:
        raise HTTPException(status_code=400, detail="Both services must be connected")

    qobuz_creds = await storage.get_credentials("qobuz")

    # Get Spotify saved albums
    spotify_client = await get_authenticated_spotify_client()

    # Get Qobuz favorites
    qobuz_client = QobuzClient(qobuz_creds['user_auth_token'])
    qobuz_client.authenticate()

    # Fetch Spotify albums
    spotify_albums = []
    for album, spotify_id, offset, total in spotify_client.iter_saved_albums():
        spotify_albums.append({
            "id": spotify_id,
            "title": album['title'],
            "artist": album['artist'],
            "upc": album.get('upc')
        })

    # Get Qobuz favorite albums with details
    qobuz_albums = []
    try:
        url = f"{qobuz_client.BASE_URL}/favorite/getUserFavorites"
        params = {"type": "albums", "limit": 5000}
        response = qobuz_client._session.get(url, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()

        if 'albums' in data and 'items' in data['albums']:
            for item in data['albums']['items']:
                qobuz_albums.append({
                    "id": item['id'],
                    "title": item.get('title', ''),
                    "artist": item.get('artist', {}).get('name', ''),
                    "upc": item.get('upc')
                })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch Qobuz albums: {e}")

    # Compare by UPC first, then by title+artist
    spotify_by_upc = {a['upc']: a for a in spotify_albums if a.get('upc')}
    qobuz_by_upc = {a['upc']: a for a in qobuz_albums if a.get('upc')}

    matched = []
    only_spotify = []
    only_qobuz = []

    matched_spotify_ids = set()
    matched_qobuz_ids = set()

    # UPC matching
    for upc, spotify_album in spotify_by_upc.items():
        if upc in qobuz_by_upc:
            matched.append({
                "spotify": spotify_album,
                "qobuz": qobuz_by_upc[upc],
                "match_type": "upc"
            })
            matched_spotify_ids.add(spotify_album['id'])
            matched_qobuz_ids.add(qobuz_by_upc[upc]['id'])

    # Fuzzy matching for remaining albums
    from rapidfuzz import fuzz

    def normalize(s):
        return s.lower().strip() if s else ""

    for spotify_album in spotify_albums:
        if spotify_album['id'] in matched_spotify_ids:
            continue

        best_match = None
        best_score = 0

        for qobuz_album in qobuz_albums:
            if qobuz_album['id'] in matched_qobuz_ids:
                continue

            title_score = fuzz.ratio(normalize(spotify_album['title']), normalize(qobuz_album['title']))
            artist_score = fuzz.ratio(normalize(spotify_album['artist']), normalize(qobuz_album['artist']))
            combined = (title_score + artist_score) / 2

            if combined > best_score and combined >= 85:
                best_score = combined
                best_match = qobuz_album

        if best_match:
            matched.append({
                "spotify": spotify_album,
                "qobuz": best_match,
                "match_type": "fuzzy",
                "score": round(best_score, 1)
            })
            matched_spotify_ids.add(spotify_album['id'])
            matched_qobuz_ids.add(best_match['id'])
        else:
            only_spotify.append(spotify_album)

    # Find Qobuz albums not matched
    for qobuz_album in qobuz_albums:
        if qobuz_album['id'] not in matched_qobuz_ids:
            only_qobuz.append(qobuz_album)

    return {
        "matched": len(matched),
        "only_spotify": len(only_spotify),
        "only_qobuz": len(only_qobuz),
        "spotify_total": len(spotify_albums),
        "qobuz_total": len(qobuz_albums),
        "matched_albums": matched[:100],
        "missing_from_qobuz": only_spotify[:100],
        "extra_in_qobuz": only_qobuz[:100]
    }


@app.get("/api/spotify/stats")
async def get_spotify_stats():
    """Get Spotify library statistics."""
    auth_status = await get_auth_status()
    if not auth_status["spotify"]:
        raise HTTPException(status_code=401, detail="Spotify not connected")

    try:
        client = await get_authenticated_spotify_client()

        # Get playlist count
        playlists = client.sp.current_user_playlists(limit=1)
        playlist_count = playlists.get('total', 0)

        # Get saved tracks count
        saved = client.sp.current_user_saved_tracks(limit=1)
        saved_count = saved.get('total', 0)

        # Get saved albums count
        saved_albums = client.sp.current_user_saved_albums(limit=1)
        saved_albums_count = saved_albums.get('total', 0)

        return {
            "playlists": playlist_count,
            "savedTracks": saved_count,
            "savedAlbums": saved_albums_count
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

        # Count playlists from Spotify (those with "(from Spotify)" in name)
        from_spotify = sum(1 for p in all_playlists
                          if '(from Spotify)' in p.get('name', '') or
                             '[Spotify]' in p.get('name', ''))

        # Get favorites count (fast - just gets total, doesn't fetch all)
        favorites_count = client.get_favorites_count()

        # Get favorite albums count
        favorite_albums_count = client.get_favorite_albums_count()

        return {
            "playlists": playlist_count,
            "fromSpotify": from_spotify,
            "favorites": favorites_count,
            "favoriteAlbums": favorite_albums_count
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch Qobuz stats: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
