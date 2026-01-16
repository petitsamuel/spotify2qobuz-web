"""Async wrapper for sync service with progress callbacks."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Callable, Dict, List, Optional
from src.spotify_client import SpotifyClient
from src.qobuz_client import QobuzClient
# Use improved matcher by default
try:
    from src.matcher_v2 import TrackMatcherV2 as TrackMatcher
except ImportError:
    from src.matcher import TrackMatcher
from src.utils.logger import get_logger


logger = get_logger()


class ProgressCallback:
    """Progress callback for tracking sync progress."""

    def __init__(self, callback: Callable[[Dict], None] = None):
        self.callback = callback
        self.current_playlist = ""
        self.current_playlist_index = 0
        self.total_playlists = 0
        self.current_track_index = 0
        self.total_tracks = 0
        self.tracks_matched = 0
        self.tracks_not_matched = 0
        self.isrc_matches = 0
        self.fuzzy_matches = 0

    def update(self, **kwargs):
        """Update progress and call callback."""
        for key, value in kwargs.items():
            if hasattr(self, key):
                setattr(self, key, value)
        if self.callback:
            self.callback(self.to_dict())

    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "current_playlist": self.current_playlist,
            "current_playlist_index": self.current_playlist_index,
            "total_playlists": self.total_playlists,
            "current_track_index": self.current_track_index,
            "total_tracks": self.total_tracks,
            "tracks_matched": self.tracks_matched,
            "tracks_not_matched": self.tracks_not_matched,
            "isrc_matches": self.isrc_matches,
            "fuzzy_matches": self.fuzzy_matches,
            "percent_complete": self._calculate_percent(),
        }

    def _calculate_percent(self) -> float:
        """Calculate overall completion percentage."""
        if self.total_playlists == 0:
            return 0.0
        playlist_progress = (self.current_playlist_index / self.total_playlists) * 100
        if self.total_tracks > 0:
            track_progress = (self.current_track_index / self.total_tracks) * 100
            playlist_contrib = playlist_progress * 0.9
            track_contrib = (track_progress / self.total_playlists) * 0.1
            return min(playlist_contrib + track_contrib, 100.0)
        return playlist_progress


class AsyncSyncService:
    """Async wrapper for sync operations."""

    def __init__(
        self,
        spotify_client: SpotifyClient,
        qobuz_client: QobuzClient,
        progress_callback: ProgressCallback = None
    ):
        self.spotify_client = spotify_client
        self.qobuz_client = qobuz_client
        self.matcher = TrackMatcher(qobuz_client)
        self.progress = progress_callback or ProgressCallback()
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._cancelled = False

    def cancel(self):
        """Cancel the running sync."""
        self._cancelled = True
        logger.info("Sync cancellation requested")

    async def sync_playlists(
        self,
        playlist_ids: List[str] = None,
        dry_run: bool = False
    ) -> Dict:
        """
        Sync playlists from Spotify to Qobuz.

        Args:
            playlist_ids: Optional list of playlist IDs to sync. If None, syncs all.
            dry_run: If True, don't make any changes.

        Returns:
            Sync report dictionary.
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync_playlists_sync,
            playlist_ids,
            dry_run
        )

    def _sync_playlists_sync(
        self,
        playlist_ids: List[str],
        dry_run: bool
    ) -> Dict:
        """Synchronous implementation of playlist sync."""
        report = {
            "started_at": datetime.now().isoformat(),
            "completed_at": None,
            "playlists_synced": 0,
            "tracks_matched": 0,
            "tracks_not_matched": 0,
            "isrc_matches": 0,
            "fuzzy_matches": 0,
            "missing_tracks": [],
            "errors": []
        }

        try:
            playlists = self.spotify_client.list_playlists()

            if playlist_ids:
                playlists = [p for p in playlists if p['id'] in playlist_ids]

            self.progress.update(total_playlists=len(playlists))

            for i, playlist in enumerate(playlists):
                self.progress.update(
                    current_playlist=playlist['name'],
                    current_playlist_index=i + 1,
                    current_track_index=0,
                    total_tracks=playlist['tracks_count']
                )

                try:
                    self._sync_single_playlist(playlist, report, dry_run)
                    report["playlists_synced"] += 1
                except Exception as e:
                    logger.error(f"Error syncing playlist {playlist['name']}: {e}")
                    report["errors"].append(f"Playlist {playlist['name']}: {str(e)}")

            report["completed_at"] = datetime.now().isoformat()
            self.progress.update(current_playlist_index=len(playlists))

        except Exception as e:
            logger.error(f"Sync failed: {e}")
            report["errors"].append(str(e))
            report["completed_at"] = datetime.now().isoformat()

        return report

    def _sync_single_playlist(
        self,
        playlist: Dict,
        report: Dict,
        dry_run: bool
    ):
        """Sync a single playlist."""
        playlist_name = playlist['name']
        playlist_id = playlist['id']

        spotify_tracks = self.spotify_client.list_tracks(playlist_id)
        if not spotify_tracks:
            return

        qobuz_playlist_name = f"{playlist_name} (from Spotify)"
        qobuz_playlist_id = None
        existing_track_ids = set()

        if not dry_run:
            existing_playlist = self.qobuz_client.find_playlist_by_name(qobuz_playlist_name)
            if existing_playlist:
                qobuz_playlist_id = existing_playlist['id']
                existing_track_ids = set(
                    self.qobuz_client.get_playlist_tracks(qobuz_playlist_id)
                )
            else:
                qobuz_playlist_id = self.qobuz_client.create_playlist(
                    name=qobuz_playlist_name,
                    description=f"Synced from Spotify on {datetime.now().strftime('%Y-%m-%d')}"
                )

        for j, track in enumerate(spotify_tracks):
            self.progress.update(current_track_index=j + 1)

            match_result = self.matcher.match_track(track)

            if match_result:
                report["tracks_matched"] += 1
                self.progress.update(tracks_matched=report["tracks_matched"])

                if match_result.match_type == 'isrc':
                    report["isrc_matches"] += 1
                    self.progress.update(isrc_matches=report["isrc_matches"])
                else:
                    report["fuzzy_matches"] += 1
                    self.progress.update(fuzzy_matches=report["fuzzy_matches"])

                if not dry_run and qobuz_playlist_id:
                    qobuz_track_id = match_result.qobuz_track['id']
                    if qobuz_track_id not in existing_track_ids:
                        self.qobuz_client.add_track(qobuz_playlist_id, qobuz_track_id)
            else:
                report["tracks_not_matched"] += 1
                self.progress.update(tracks_not_matched=report["tracks_not_matched"])
                report["missing_tracks"].append({
                    "playlist": playlist_name,
                    "title": track['title'],
                    "artist": track['artist'],
                    "album": track['album']
                })

    async def sync_favorites(
        self,
        dry_run: bool = False,
        already_synced: set = None,
        on_track_synced: Callable = None
    ) -> Dict:
        """
        Sync saved tracks from Spotify to Qobuz favorites.

        Args:
            dry_run: If True, don't make any changes
            already_synced: Set of Spotify track IDs that are already synced (for resume)
            on_track_synced: Callback(spotify_id, qobuz_id) called after each track is synced
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync_favorites_streaming,
            dry_run,
            already_synced or set(),
            on_track_synced
        )

    def _sync_favorites_streaming(
        self,
        dry_run: bool,
        already_synced: set,
        on_track_synced: Callable
    ) -> Dict:
        """Streaming implementation of favorites sync - processes as it goes."""
        report = {
            "started_at": datetime.now().isoformat(),
            "completed_at": None,
            "tracks_matched": 0,
            "tracks_not_matched": 0,
            "tracks_skipped": 0,
            "isrc_matches": 0,
            "fuzzy_matches": 0,
            "missing_tracks": [],
            "synced_tracks": [],
            "errors": []
        }

        try:
            # Get existing Qobuz favorites once
            existing_favorites = set()
            if not dry_run:
                existing_favorites = set(self.qobuz_client.get_favorite_tracks())

            self.progress.update(
                total_playlists=1,
                current_playlist="Saved Tracks",
                current_playlist_index=1,
                total_tracks=0  # Will be updated on first batch
            )

            track_index = 0

            # Stream tracks from Spotify - process as we go
            for track, spotify_id, offset, total in self.spotify_client.iter_saved_tracks():
                # Check for cancellation
                if self._cancelled:
                    logger.info("Sync cancelled by user")
                    report["errors"].append("Cancelled by user")
                    break

                # Update total on first iteration
                if track_index == 0:
                    self.progress.update(total_tracks=total)

                track_index += 1
                self.progress.update(current_track_index=track_index)

                # Skip if already synced (resume support)
                if spotify_id in already_synced:
                    report["tracks_skipped"] += 1
                    continue

                match_result = self.matcher.match_track(track)

                if match_result:
                    report["tracks_matched"] += 1
                    self.progress.update(tracks_matched=report["tracks_matched"])

                    if match_result.match_type == 'isrc':
                        report["isrc_matches"] += 1
                        self.progress.update(isrc_matches=report["isrc_matches"])
                    else:
                        report["fuzzy_matches"] += 1
                        self.progress.update(fuzzy_matches=report["fuzzy_matches"])

                    qobuz_track_id = match_result.qobuz_track['id']

                    if not dry_run:
                        if qobuz_track_id not in existing_favorites:
                            self.qobuz_client.add_favorite_track(qobuz_track_id)
                            existing_favorites.add(qobuz_track_id)

                        # Track this sync for resume support
                        report["synced_tracks"].append({
                            "spotify_id": spotify_id,
                            "qobuz_id": str(qobuz_track_id)
                        })

                        # Callback to persist progress
                        if on_track_synced:
                            on_track_synced(spotify_id, str(qobuz_track_id))
                else:
                    report["tracks_not_matched"] += 1
                    self.progress.update(tracks_not_matched=report["tracks_not_matched"])
                    report["missing_tracks"].append({
                        "spotify_id": spotify_id,
                        "title": track['title'],
                        "artist": track['artist'],
                        "album": track['album']
                    })

            report["completed_at"] = datetime.now().isoformat()

        except Exception as e:
            logger.error(f"Favorites sync failed: {e}")
            report["errors"].append(str(e))
            report["completed_at"] = datetime.now().isoformat()

        return report
