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
import re


logger = get_logger()


# Common album edition suffixes to strip when searching for base albums
EDITION_PATTERNS = [
    r'\s*\(Deluxe\s*Edition?\)',
    r'\s*\(Super\s*Deluxe\)',
    r'\s*\(Deluxe\)',
    r'\s*\(Expanded\s*Edition?\)',
    r'\s*\(Special\s*Edition?\)',
    r'\s*\(Anniversary\s*Edition?\)',
    r'\s*\(\d+(?:th|st|nd|rd)?\s*Anniversary[^)]*\)',
    r'\s*\(Remaster(?:ed)?\)',
    r'\s*\(Remastered\s*\d{4}\)',
    r'\s*\(Acoustic\)',
    r'\s*\(Instrumentals?\)',
    r'\s*\(Live[^)]*\)',
    r'\s*\(Bonus\s*Track[^)]*\)',
    r'\s*\(Complete[^)]*\)',
    r'\s*\(Music\s+for[^)]*\)',
    r'\s*-\s*Deluxe\s*$',
    r'\s*-\s*Remastered\s*$',
]
EDITION_REGEX = re.compile('|'.join(EDITION_PATTERNS), re.IGNORECASE)


def strip_edition_suffix(title: str) -> str:
    """Strip common edition suffixes from album titles."""
    return EDITION_REGEX.sub('', title).strip()


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
        self.recent_missing: List[Dict] = []  # Last N missing tracks for live display
        self.max_recent_missing = 20  # Keep last 20 missing tracks

    def update(self, **kwargs):
        """Update progress and call callback."""
        for key, value in kwargs.items():
            if hasattr(self, key):
                setattr(self, key, value)
        if self.callback:
            self.callback(self.to_dict())

    def add_missing_track(self, track: Dict):
        """Add a missing track to recent list (includes suggestions if available)."""
        # Track can include: title, artist, album, spotify_id, suggestions
        self.recent_missing.append(track)
        if len(self.recent_missing) > self.max_recent_missing:
            self.recent_missing.pop(0)

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
            "recent_missing": self.recent_missing,
        }

    def _calculate_percent(self) -> float:
        """Calculate overall completion percentage."""
        if self.total_playlists == 0:
            return 0.0

        # For single playlist (favorites), just use track progress
        if self.total_playlists == 1:
            if self.total_tracks > 0:
                return (self.current_track_index / self.total_tracks) * 100
            return 0.0

        # For multiple playlists, weight by playlist + track progress
        completed_playlists = max(0, self.current_playlist_index - 1)
        playlist_percent = (completed_playlists / self.total_playlists) * 100

        # Add current playlist's track progress
        if self.total_tracks > 0:
            track_percent = (self.current_track_index / self.total_tracks) * 100
            current_playlist_contrib = track_percent / self.total_playlists
            return min(playlist_percent + current_playlist_contrib, 100.0)

        return playlist_percent


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
        """Sync a single playlist with parallel matching."""
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

        # Parallel matching
        BATCH_SIZE = 25

        def match_track(track):
            return self.matcher.match_track(track)

        tracks_to_add = []

        with ThreadPoolExecutor(max_workers=BATCH_SIZE) as executor:
            for i in range(0, len(spotify_tracks), BATCH_SIZE):
                batch = spotify_tracks[i:i + BATCH_SIZE]
                futures = [executor.submit(match_track, track) for track in batch]
                results = [f.result() for f in futures]

                for j, (track, match_result) in enumerate(zip(batch, results)):
                    self.progress.update(current_track_index=i + j + 1)

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
                        if qobuz_track_id not in existing_track_ids:
                            tracks_to_add.append(qobuz_track_id)
                            existing_track_ids.add(qobuz_track_id)
                    else:
                        report["tracks_not_matched"] += 1
                        self.progress.update(tracks_not_matched=report["tracks_not_matched"])
                        report["missing_tracks"].append({
                            "playlist": playlist_name,
                            "title": track['title'],
                            "artist": track['artist'],
                            "album": track['album']
                        })

        # Batch add tracks to playlist
        if not dry_run and qobuz_playlist_id and tracks_to_add:
            for track_id in tracks_to_add:
                self.qobuz_client.add_track(qobuz_playlist_id, track_id)

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
        """High-performance parallel favorites sync."""
        report = {
            "started_at": datetime.now().isoformat(),
            "completed_at": None,
            "tracks_matched": 0,
            "tracks_not_matched": 0,
            "tracks_skipped": 0,
            "tracks_already_in_qobuz": 0,
            "isrc_matches": 0,
            "fuzzy_matches": 0,
            "missing_tracks": [],
            "synced_tracks": [],
            "errors": []
        }

        # Tuning parameters
        MATCH_WORKERS = 25  # Parallel matching threads
        BATCH_SIZE = 50     # Tracks per batch
        FAVORITE_BATCH = 25 # Tracks per Qobuz favorite API call

        try:
            # Pre-fetch Qobuz favorites with ISRCs for fast pre-matching
            # This avoids expensive API calls for tracks already in Qobuz
            logger.info("Pre-fetching Qobuz favorites for diff computation...")
            qobuz_isrc_map = self.qobuz_client.get_favorite_tracks_with_isrc()
            existing_favorites = set(qobuz_isrc_map.values())

            self.progress.update(
                total_playlists=1,
                current_playlist="Saved Tracks",
                current_playlist_index=1,
                total_tracks=0
            )

            # Use a persistent thread pool for the entire sync
            with ThreadPoolExecutor(max_workers=MATCH_WORKERS) as executor:
                track_index = 0
                batch = []
                pending_favorites = []  # Batch up favorites to add

                def process_track(item):
                    """Process a single track - runs in thread pool."""
                    track, spotify_id = item
                    if spotify_id in already_synced:
                        return ('skipped', spotify_id, track, None, [])

                    # Fast path: check if ISRC already exists in Qobuz favorites
                    isrc = track.get('isrc')
                    if isrc and isrc in qobuz_isrc_map:
                        # Already in Qobuz - no need to match or add
                        return ('already_in_qobuz', spotify_id, track, qobuz_isrc_map[isrc], [])

                    match_result, suggestions = self.matcher.match_track_with_suggestions(track)
                    status = 'matched' if match_result else 'not_matched'
                    return (status, spotify_id, track, match_result, suggestions)

                def flush_favorites():
                    """Batch add pending favorites to Qobuz."""
                    nonlocal pending_favorites
                    if pending_favorites and not dry_run:
                        track_ids = [f['qobuz_id'] for f in pending_favorites]
                        self.qobuz_client.add_favorite_tracks_batch(track_ids)
                        # Call individual callbacks
                        for f in pending_favorites:
                            if on_track_synced:
                                on_track_synced(f['spotify_id'], str(f['qobuz_id']))
                        pending_favorites = []

                # Stream tracks from Spotify
                for track, spotify_id, offset, total in self.spotify_client.iter_saved_tracks():
                    if self._cancelled:
                        logger.info("Sync cancelled by user")
                        report["errors"].append("Cancelled by user")
                        break

                    # Update total on first iteration
                    if track_index == 0:
                        self.progress.update(total_tracks=total)

                    track_index += 1
                    batch.append((track, spotify_id))

                    # Process batch when full
                    if len(batch) >= BATCH_SIZE:
                        # Submit all tracks in parallel
                        futures = [executor.submit(process_track, item) for item in batch]
                        results = [f.result() for f in futures]

                        # Process results and queue favorites
                        for status, sid, trk, match_result, suggestions in results:
                            self._process_single_result(
                                status, sid, trk, match_result, suggestions,
                                report, existing_favorites, pending_favorites
                            )

                        # Flush favorites in batches
                        if len(pending_favorites) >= FAVORITE_BATCH:
                            flush_favorites()

                        self.progress.update(current_track_index=track_index)
                        batch = []

                # Process remaining tracks
                if batch:
                    futures = [executor.submit(process_track, item) for item in batch]
                    results = [f.result() for f in futures]

                    for status, sid, trk, match_result, suggestions in results:
                        self._process_single_result(
                            status, sid, trk, match_result, suggestions,
                            report, existing_favorites, pending_favorites
                        )

                    self.progress.update(current_track_index=track_index)

                # Flush any remaining favorites
                flush_favorites()

            report["completed_at"] = datetime.now().isoformat()

        except Exception as e:
            logger.error(f"Favorites sync failed: {e}")
            report["errors"].append(str(e))
            report["completed_at"] = datetime.now().isoformat()

        return report

    def _process_single_result(
        self,
        status: str,
        spotify_id: str,
        track: Dict,
        match_result,
        suggestions: List,
        report: Dict,
        existing_favorites: set,
        pending_favorites: List
    ):
        """Process a single match result."""
        if status == 'skipped':
            report["tracks_skipped"] += 1
            return

        if status == 'already_in_qobuz':
            # Track already exists in Qobuz favorites (matched by ISRC)
            report["tracks_already_in_qobuz"] += 1
            report["tracks_matched"] += 1
            report["isrc_matches"] += 1
            self.progress.update(
                tracks_matched=report["tracks_matched"],
                isrc_matches=report["isrc_matches"]
            )
            return

        if status == 'matched' and match_result:
            report["tracks_matched"] += 1
            self.progress.update(tracks_matched=report["tracks_matched"])

            if match_result.match_type == 'isrc':
                report["isrc_matches"] += 1
                self.progress.update(isrc_matches=report["isrc_matches"])
            else:
                report["fuzzy_matches"] += 1
                self.progress.update(fuzzy_matches=report["fuzzy_matches"])

            qobuz_track_id = match_result.qobuz_track['id']

            if qobuz_track_id not in existing_favorites:
                # Queue for batch addition
                pending_favorites.append({
                    'spotify_id': spotify_id,
                    'qobuz_id': qobuz_track_id
                })
                existing_favorites.add(qobuz_track_id)

            report["synced_tracks"].append({
                "spotify_id": spotify_id,
                "qobuz_id": str(qobuz_track_id)
            })
        else:
            report["tracks_not_matched"] += 1
            self.progress.update(tracks_not_matched=report["tracks_not_matched"])
            missing_track = {
                "spotify_id": spotify_id,
                "title": track['title'],
                "artist": track['artist'],
                "album": track['album'],
                "suggestions": suggestions
            }
            report["missing_tracks"].append(missing_track)
            # Add to live progress for real-time display (with full suggestions)
            self.progress.add_missing_track(missing_track)
            self.progress.update()  # Trigger callback with updated missing tracks

    async def sync_albums(
        self,
        dry_run: bool = False,
        already_synced: set = None,
        on_album_synced: Callable = None
    ) -> Dict:
        """
        Sync saved albums from Spotify to Qobuz favorites.

        Args:
            dry_run: If True, don't make any changes
            already_synced: Set of Spotify album IDs that are already synced (for resume)
            on_album_synced: Callback(spotify_id, qobuz_id) called after each album is synced
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync_albums_streaming,
            dry_run,
            already_synced or set(),
            on_album_synced
        )

    def _sync_albums_streaming(
        self,
        dry_run: bool,
        already_synced: set,
        on_album_synced: Callable
    ) -> Dict:
        """High-performance parallel album sync."""
        report = {
            "started_at": datetime.now().isoformat(),
            "completed_at": None,
            "albums_matched": 0,
            "albums_not_matched": 0,
            "albums_skipped": 0,
            "albums_already_in_qobuz": 0,
            "upc_matches": 0,
            "fuzzy_matches": 0,
            "missing_albums": [],
            "synced_albums": [],
            "errors": []
        }

        # Tuning parameters
        MATCH_WORKERS = 25
        BATCH_SIZE = 50
        FAVORITE_BATCH = 25

        try:
            # Pre-fetch Qobuz favorite albums with UPCs for fast pre-matching
            logger.info("Pre-fetching Qobuz favorite albums for diff computation...")
            qobuz_upc_map = self.qobuz_client.get_favorite_albums_with_upc()
            existing_favorites = set(qobuz_upc_map.values())

            self.progress.update(
                total_playlists=1,
                current_playlist="Saved Albums",
                current_playlist_index=1,
                total_tracks=0
            )

            with ThreadPoolExecutor(max_workers=MATCH_WORKERS) as executor:
                album_index = 0
                batch = []
                pending_favorites = []

                def match_album(item):
                    """Match a single album - runs in thread pool."""
                    album, spotify_id = item
                    if spotify_id in already_synced:
                        return ('skipped', spotify_id, album, None, [])

                    # Fast path: check if UPC already exists in Qobuz favorites
                    upc = album.get('upc')
                    if upc and upc in qobuz_upc_map:
                        # Already in Qobuz - no need to match or add
                        return ('already_in_qobuz', spotify_id, album, {'id': qobuz_upc_map[upc]}, [])

                    # Try UPC match via search API (for albums not in favorites but on Qobuz)
                    if upc:
                        qobuz_album = self.qobuz_client.search_album_by_upc(upc)
                        if qobuz_album:
                            return ('matched_upc', spotify_id, album, qobuz_album, [])

                    # Fuzzy match by title and artist
                    candidates = self.qobuz_client.search_album(album['title'], album['artist'])
                    if candidates:
                        # Find best match using fuzzy matching
                        best_match = self._find_best_album_match(album, candidates)
                        if best_match:
                            return ('matched_fuzzy', spotify_id, album, best_match, [])

                    # Fallback: try searching with stripped edition suffix
                    suggestions = []
                    base_title = strip_edition_suffix(album['title'])
                    if base_title != album['title']:
                        logger.debug(f"Trying base title: '{base_title}' (was: '{album['title']}')")
                        base_candidates = self.qobuz_client.search_album(base_title, album['artist'])
                        if base_candidates:
                            # Check if any is a good match
                            best_base_match = self._find_best_album_match(
                                {**album, 'title': base_title}, base_candidates
                            )
                            if best_base_match:
                                # Found a match with base title - use it
                                return ('matched_fuzzy', spotify_id, album, best_base_match, [])
                            # Otherwise add as suggestions
                            suggestions = self._build_album_suggestions(album, base_candidates[:5])

                    # If no match, try artist-only search for suggestions
                    if not suggestions:
                        artist_candidates = self.qobuz_client.search_album('', album['artist'])
                        if artist_candidates:
                            suggestions = self._build_album_suggestions(album, artist_candidates[:5])

                    return ('not_matched', spotify_id, album, None, suggestions)

                def flush_favorites():
                    """Batch add pending favorites to Qobuz."""
                    nonlocal pending_favorites
                    if pending_favorites and not dry_run:
                        album_ids = [f['qobuz_id'] for f in pending_favorites]
                        self.qobuz_client.add_favorite_albums_batch(album_ids)
                        for f in pending_favorites:
                            if on_album_synced:
                                on_album_synced(f['spotify_id'], str(f['qobuz_id']))
                        pending_favorites = []

                # Stream albums from Spotify
                for album, spotify_id, offset, total in self.spotify_client.iter_saved_albums():
                    if self._cancelled:
                        logger.info("Album sync cancelled by user")
                        report["errors"].append("Cancelled by user")
                        break

                    if album_index == 0:
                        self.progress.update(total_tracks=total)

                    album_index += 1
                    batch.append((album, spotify_id))

                    # Process batch when full
                    if len(batch) >= BATCH_SIZE:
                        futures = [executor.submit(match_album, item) for item in batch]
                        results = [f.result() for f in futures]

                        for status, sid, alb, qobuz_album, suggestions in results:
                            self._process_album_result(
                                status, sid, alb, qobuz_album, suggestions,
                                report, existing_favorites, pending_favorites
                            )

                        if len(pending_favorites) >= FAVORITE_BATCH:
                            flush_favorites()

                        self.progress.update(current_track_index=album_index)
                        batch = []

                # Process remaining albums
                if batch:
                    futures = [executor.submit(match_album, item) for item in batch]
                    results = [f.result() for f in futures]

                    for status, sid, alb, qobuz_album, suggestions in results:
                        self._process_album_result(
                            status, sid, alb, qobuz_album, suggestions,
                            report, existing_favorites, pending_favorites
                        )

                    self.progress.update(current_track_index=album_index)

                # Flush any remaining favorites
                flush_favorites()

            report["completed_at"] = datetime.now().isoformat()

        except Exception as e:
            logger.error(f"Album sync failed: {e}")
            report["errors"].append(str(e))
            report["completed_at"] = datetime.now().isoformat()

        return report

    def _find_best_album_match(self, spotify_album: Dict, candidates: List[Dict]) -> Optional[Dict]:
        """Find the best matching Qobuz album from candidates using fuzzy matching."""
        try:
            from rapidfuzz import fuzz
        except ImportError:
            # Fallback to first candidate if rapidfuzz not available
            return candidates[0] if candidates else None

        best_match = None
        best_score = 0

        spotify_title = spotify_album['title'].lower()
        spotify_artist = spotify_album['artist'].lower()

        for candidate in candidates:
            title_score = fuzz.ratio(spotify_title, candidate['title'].lower())
            artist_score = fuzz.ratio(spotify_artist, candidate['artist'].lower())

            # Weighted average favoring title
            combined_score = (title_score * 0.6) + (artist_score * 0.4)

            # Bonus for matching release year
            if spotify_album.get('release_year') and candidate.get('release_year'):
                if spotify_album['release_year'] == candidate['release_year']:
                    combined_score += 10

            # Bonus for similar track count
            if spotify_album.get('total_tracks') and candidate.get('tracks_count'):
                track_diff = abs(spotify_album['total_tracks'] - candidate['tracks_count'])
                if track_diff == 0:
                    combined_score += 5
                elif track_diff <= 2:
                    combined_score += 2

            if combined_score > best_score and combined_score >= 70:
                best_score = combined_score
                best_match = candidate

        return best_match

    def _build_album_suggestions(self, spotify_album: Dict, candidates: List[Dict]) -> List[Dict]:
        """Build suggestion list from album candidates with match scores."""
        try:
            from rapidfuzz import fuzz
        except ImportError:
            return []

        suggestions = []
        spotify_title = spotify_album['title'].lower()
        spotify_artist = spotify_album['artist'].lower()
        base_title = strip_edition_suffix(spotify_album['title']).lower()

        for candidate in candidates:
            candidate_title = candidate['title'].lower()
            candidate_artist = candidate['artist'].lower()

            # Score against both original and base title, take best
            title_score = max(
                fuzz.ratio(spotify_title, candidate_title),
                fuzz.ratio(base_title, candidate_title)
            )
            artist_score = fuzz.ratio(spotify_artist, candidate_artist)

            suggestions.append({
                'qobuz_id': candidate['id'],
                'title': candidate['title'],
                'artist': candidate['artist'],
                'album': candidate.get('title', ''),
                'title_score': title_score,
                'artist_score': artist_score,
                'score': round((title_score + artist_score) / 2)
            })

        # Sort by combined score descending
        suggestions.sort(key=lambda x: x['score'], reverse=True)
        return suggestions[:5]

    def _process_album_result(
        self,
        status: str,
        spotify_id: str,
        album: Dict,
        qobuz_album: Optional[Dict],
        suggestions: List[Dict],
        report: Dict,
        existing_favorites: set,
        pending_favorites: List
    ):
        """Process a single album match result."""
        if status == 'skipped':
            report["albums_skipped"] += 1
            return

        if status == 'already_in_qobuz':
            # Album already exists in Qobuz favorites (matched by UPC)
            report["albums_matched"] += 1
            report["upc_matches"] += 1
            report["albums_already_in_qobuz"] += 1
            self.progress.update(
                tracks_matched=report["albums_matched"],
                isrc_matches=report["upc_matches"]
            )
            return

        if status.startswith('matched') and qobuz_album:
            report["albums_matched"] += 1
            self.progress.update(tracks_matched=report["albums_matched"])

            if status == 'matched_upc':
                report["upc_matches"] += 1
                self.progress.update(isrc_matches=report["upc_matches"])
            else:
                report["fuzzy_matches"] += 1
                self.progress.update(fuzzy_matches=report["fuzzy_matches"])

            qobuz_album_id = qobuz_album['id']

            if qobuz_album_id not in existing_favorites:
                pending_favorites.append({
                    'spotify_id': spotify_id,
                    'qobuz_id': qobuz_album_id
                })
                existing_favorites.add(qobuz_album_id)

            report["synced_albums"].append({
                "spotify_id": spotify_id,
                "qobuz_id": str(qobuz_album_id)
            })
        else:
            report["albums_not_matched"] += 1
            self.progress.update(tracks_not_matched=report["albums_not_matched"])
            missing_album = {
                "spotify_id": spotify_id,
                "title": album['title'],
                "artist": album['artist'],
                "suggestions": suggestions
            }
            report["missing_albums"].append(missing_album)
            self.progress.add_missing_track({
                "spotify_id": spotify_id,
                "title": album['title'],
                "artist": album['artist'],
                "suggestions": suggestions
            })
            self.progress.update()

