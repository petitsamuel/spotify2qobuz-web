"""
Qobuz API client using token-based authentication.

This approach uses session tokens from browser cookies instead of app_id/password,
which works with Google login accounts and bypasses 2025 API restrictions.
"""

import time
from functools import wraps
from typing import Dict, List, Optional, Callable
import requests
from src.utils.logger import get_logger


logger = get_logger()


class AdaptiveRateLimiter:
    """Adaptive rate limiter that slows down when rate limited."""

    def __init__(self, initial_delay: float = 0.1, max_delay: float = 5.0):
        self.delay = initial_delay
        self.initial_delay = initial_delay
        self.max_delay = max_delay
        self.consecutive_successes = 0
        self.rate_limited_count = 0

    def wait(self):
        """Wait for the current delay period."""
        if self.delay > 0:
            time.sleep(self.delay)

    def on_success(self):
        """Called after a successful request."""
        self.consecutive_successes += 1
        # Speed up after 10 consecutive successes
        if self.consecutive_successes >= 10 and self.delay > self.initial_delay:
            self.delay = max(self.initial_delay, self.delay * 0.8)
            self.consecutive_successes = 0
            logger.debug(f"Rate limiter: speeding up to {self.delay:.2f}s delay")

    def on_rate_limit(self):
        """Called when rate limited."""
        self.consecutive_successes = 0
        self.rate_limited_count += 1
        self.delay = min(self.max_delay, self.delay * 2)
        logger.warning(f"Rate limited! Slowing down to {self.delay:.2f}s delay")

    def get_stats(self) -> Dict:
        """Get rate limiter statistics."""
        return {
            "current_delay": self.delay,
            "rate_limited_count": self.rate_limited_count
        }


def retry_with_backoff(max_retries: int = 3, initial_delay: float = 1.0):
    """Decorator for retrying requests with exponential backoff."""
    def decorator(func: Callable):
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            delay = initial_delay

            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except requests.exceptions.HTTPError as e:
                    last_exception = e
                    status_code = e.response.status_code if e.response else 0

                    # Don't retry client errors (except rate limit)
                    if 400 <= status_code < 500 and status_code != 429:
                        raise

                    # Rate limited - wait longer
                    if status_code == 429:
                        retry_after = int(e.response.headers.get('Retry-After', delay * 2))
                        logger.warning(f"Rate limited (429). Waiting {retry_after}s...")
                        time.sleep(retry_after)
                        delay = retry_after
                    else:
                        if attempt < max_retries:
                            logger.warning(f"Request failed (attempt {attempt + 1}/{max_retries + 1}): {e}")
                            time.sleep(delay)
                            delay *= 2
                except requests.exceptions.RequestException as e:
                    last_exception = e
                    if attempt < max_retries:
                        logger.warning(f"Request failed (attempt {attempt + 1}/{max_retries + 1}): {e}")
                        time.sleep(delay)
                        delay *= 2

            raise last_exception
        return wrapper
    return decorator


class QobuzClient:
    """
    Client for interacting with Qobuz API using session token authentication.
    
    Get your token from browser cookies after logging in to https://play.qobuz.com
    See GET_TOKEN_INSTRUCTIONS.md for detailed instructions.
    """
    
    BASE_URL = "https://www.qobuz.com/api.json/0.2"
    
    def __init__(self, user_auth_token: str):
        """
        Initialize Qobuz client with session token.

        Args:
            user_auth_token: Session token from browser cookies (user_auth_token or X-User-Auth-Token)
        """
        self.user_auth_token = user_auth_token
        self.user_id: Optional[int] = None
        self.user_name: Optional[str] = None

        # Adaptive rate limiter
        self.rate_limiter = AdaptiveRateLimiter(initial_delay=0.05, max_delay=5.0)

        # Create session with required headers
        self._session = requests.Session()
        self._session.headers.update({
            "X-App-Id": "798273057",  # App ID used by web player
            "X-User-Auth-Token": self.user_auth_token,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Origin": "https://play.qobuz.com",
            "Referer": "https://play.qobuz.com/",
        })
    
    def authenticate(self) -> None:
        """
        Validate the session token by fetching user favorites (doesn't require app_id).
        
        Raises:
            Exception: If token is invalid or expired
        """
        try:
            # Use an endpoint that works with just the token (no app_id needed)
            # Try to get user favorites which validates the token
            url = f"{self.BASE_URL}/favorite/getUserFavorites"
            params = {"type": "albums", "limit": 1}
            
            response = self._session.get(url, params=params, timeout=10)
            
            if response.status_code == 401 or response.status_code == 400:
                logger.error(f"Token validation failed with status {response.status_code}")
                logger.error(f"Response: {response.text}")
                logger.info("Your token may be expired. Please get a fresh one from:")
                logger.info("https://play.qobuz.com → DevTools → Application → Cookies → qobuz.com")
                logger.info("See GET_TOKEN_INSTRUCTIONS.md for help")
                raise Exception(f"Invalid or expired Qobuz token (status {response.status_code})")
            
            # If we got here, the token works!
            # Extract user info from the response if available
            data = response.json()
            
            # Try to get user ID from the response
            if 'user' in data and 'id' in data['user']:
                self.user_id = data['user']['id']
                self.user_name = data['user'].get('display_name', 'Qobuz User')
            else:
                # If user info not in this response, set defaults
                # The token is valid, we just don't have the user details yet
                self.user_id = 1  # Placeholder
                self.user_name = "Qobuz User"
            
            logger.info(f"✅ Authenticated with Qobuz successfully")
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Network error during token validation: {e}")
            raise Exception(f"Qobuz authentication failed: {e}")
    
    def _make_request(self, endpoint: str, params: Dict = None, method: str = "GET", max_retries: int = 3) -> Dict:
        """
        Make authenticated request to Qobuz API with retry and rate limiting.

        Args:
            endpoint: API endpoint (without base URL)
            params: Query parameters or request body
            method: HTTP method (GET or POST)
            max_retries: Maximum number of retry attempts

        Returns:
            Response JSON

        Raises:
            Exception: If request fails after retries
        """
        if not self.user_auth_token:
            raise Exception("Not authenticated. Call authenticate() first.")

        url = f"{self.BASE_URL}/{endpoint}"
        last_exception = None
        delay = 1.0

        for attempt in range(max_retries + 1):
            try:
                # Apply rate limiting
                self.rate_limiter.wait()

                if method == "GET":
                    response = self._session.get(url, params=params, timeout=15)
                else:  # POST
                    response = self._session.post(url, json=params, timeout=15)

                # Check for rate limiting
                if response.status_code == 429:
                    self.rate_limiter.on_rate_limit()
                    retry_after = int(response.headers.get('Retry-After', delay * 2))
                    logger.warning(f"Rate limited on {endpoint}. Waiting {retry_after}s...")
                    time.sleep(retry_after)
                    delay = retry_after
                    continue

                response.raise_for_status()
                self.rate_limiter.on_success()
                return response.json()

            except requests.exceptions.HTTPError as e:
                last_exception = e
                status_code = e.response.status_code if e.response else 0

                # Don't retry client errors (except rate limit already handled)
                if 400 <= status_code < 500:
                    logger.error(f"Client error on {endpoint}: {status_code}")
                    if e.response is not None:
                        logger.error(f"Response: {e.response.text}")
                    raise Exception(f"Qobuz API error: {status_code}")

                # Server error - retry
                if attempt < max_retries:
                    logger.warning(f"Server error on {endpoint} (attempt {attempt + 1}): {e}")
                    time.sleep(delay)
                    delay *= 2

            except requests.exceptions.RequestException as e:
                last_exception = e
                if attempt < max_retries:
                    logger.warning(f"Request failed for {endpoint} (attempt {attempt + 1}): {e}")
                    time.sleep(delay)
                    delay *= 2

        logger.error(f"Qobuz API request failed for {endpoint} after {max_retries + 1} attempts")
        raise Exception(f"Qobuz API request failed: {last_exception}")
    
    def search_by_isrc(self, isrc: str, title_hint: Optional[str] = None, artist_hint: Optional[str] = None) -> Optional[Dict]:
        """
        Search for a track by ISRC code with fallback strategies.

        Args:
            isrc: ISRC code
            title_hint: Optional track title to help with fallback search
            artist_hint: Optional artist name to help with fallback search

        Returns:
            Track dictionary with keys: id, title, artist, album, duration
            or None if not found
        """
        try:
            # Strategy 1: Direct ISRC search with larger result set
            params = {
                'query': isrc,
                'limit': 25  # Increased from 5 to catch more results
            }

            data = self._make_request('track/search', params)

            if data.get('tracks', {}).get('items'):
                # Find exact ISRC match in results
                for item in data['tracks']['items']:
                    track_isrc = item.get('isrc')
                    if track_isrc and track_isrc.upper() == isrc.upper():
                        track = {
                            'id': item['id'],
                            'title': item['title'],
                            'artist': item['performer']['name'],
                            'album': item['album']['title'],
                            'duration': item['duration'] * 1000  # Convert to milliseconds
                        }
                        logger.debug(f"Found track by ISRC {isrc}: {track['title']} by {track['artist']}")
                        return track

            # Strategy 2: If title/artist hints provided, search by metadata
            # and verify ISRC matches (catches cases where ISRC search doesn't return the track)
            if title_hint and artist_hint:
                metadata_params = {
                    'query': f"{title_hint} {artist_hint}",
                    'limit': 15
                }
                metadata_data = self._make_request('track/search', metadata_params)

                if metadata_data.get('tracks', {}).get('items'):
                    for item in metadata_data['tracks']['items']:
                        track_isrc = item.get('isrc')
                        if track_isrc and track_isrc.upper() == isrc.upper():
                            track = {
                                'id': item['id'],
                                'title': item['title'],
                                'artist': item['performer']['name'],
                                'album': item['album']['title'],
                                'duration': item['duration'] * 1000
                            }
                            logger.debug(f"Found track by ISRC {isrc} via metadata fallback: {track['title']}")
                            return track

            logger.debug(f"No exact ISRC match found for: {isrc}")
            return None

        except Exception as e:
            logger.error(f"Error searching by ISRC {isrc}: {e}")
            return None
    
    def search_by_metadata(self, title: str, artist: str, duration: int) -> Optional[Dict]:
        """
        Search for a track by metadata (title, artist, duration).
        
        Args:
            title: Track title
            artist: Artist name
            duration: Duration in milliseconds
        
        Returns:
            Track dictionary with keys: id, title, artist, album, duration
            or None if not found
        """
        try:
            query = f"{title} {artist}"
            params = {
                'query': query,
                'limit': 10
            }
            
            data = self._make_request('track/search', params)
            
            if data.get('tracks', {}).get('total', 0) == 0:
                logger.debug(f"No tracks found for query: {query}")
                return None
            
            # Return first result (fuzzy matching will be done by matcher.py)
            items = data['tracks']['items']
            if items:
                item = items[0]
                track = {
                    'id': item['id'],
                    'title': item['title'],
                    'artist': item['performer']['name'],
                    'album': item['album']['title'],
                    'duration': item['duration'] * 1000  # Convert to milliseconds
                }
                logger.debug(f"Found track by metadata: {track['title']} by {track['artist']}")
                return track
            
            return None
            
        except Exception as e:
            logger.error(f"Error searching by metadata {title} - {artist}: {e}")
            return None
    
    def create_playlist(self, name: str, description: str = "") -> Optional[str]:
        """
        Create a new playlist.
        
        Args:
            name: Playlist name
            description: Playlist description
        
        Returns:
            Playlist ID or None if creation fails
        """
        try:
            url = f"{self.BASE_URL}/playlist/create"
            
            # Use form data instead of query params to handle special characters
            data = {
                'name': name,
                'is_public': 'false',
                'is_collaborative': 'false'
            }
            
            if description:
                data['description'] = description
            
            # POST with form data
            response = self._session.post(url, data=data, timeout=10)
            response.raise_for_status()
            
            result = response.json()
            playlist_id = str(result['id'])
            
            logger.info(f"Created Qobuz playlist: {name} (ID: {playlist_id})")
            return playlist_id
            
        except Exception as e:
            logger.error(f"Error creating playlist {name}: {e}")
            if hasattr(e, 'response') and e.response is not None:
                logger.error(f"Response: {e.response.text}")
            return None
    
    def add_track(self, playlist_id: str, track_id: int) -> bool:
        """
        Add a track to a playlist.
        
        Args:
            playlist_id: Playlist ID
            track_id: Track ID
        
        Returns:
            True if successful, False otherwise
        """
        try:
            import time
            url = f"{self.BASE_URL}/playlist/addTracks"
            
            # Use form data for POST
            data = {
                'playlist_id': playlist_id,
                'track_ids': str(track_id)
            }
            
            response = self._session.post(url, data=data, timeout=10)
            
            # Add small delay to avoid rate limiting
            time.sleep(0.1)
            
            response.raise_for_status()
            
            logger.debug(f"Added track {track_id} to playlist {playlist_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error adding track {track_id} to playlist {playlist_id}: {e}")
            if hasattr(e, 'response') and e.response is not None:
                try:
                    error_detail = e.response.json()
                    logger.error(f"Response details: {error_detail}")
                except:
                    logger.error(f"Response text: {e.response.text}")
            return False
    
    def get_playlist(self, playlist_id: str) -> Optional[Dict]:
        """
        Get playlist details.
        
        Args:
            playlist_id: Playlist ID
        
        Returns:
            Playlist data or None if not found
        """
        try:
            params = {'playlist_id': playlist_id}
            data = self._make_request('playlist/get', params)
            return data
        except Exception as e:
            logger.error(f"Error getting playlist {playlist_id}: {e}")
            return None
    
    def list_user_playlists(self) -> List[Dict]:
        """
        Get all user playlists.
        
        Returns:
            List of playlist dictionaries with keys: id, name, tracks_count
        """
        try:
            params = {'limit': 500}  # Get up to 500 playlists
            data = self._make_request('playlist/getUserPlaylists', params)
            
            playlists = []
            if data.get('playlists', {}).get('items'):
                for item in data['playlists']['items']:
                    playlists.append({
                        'id': str(item['id']),
                        'name': item['name'],
                        'tracks_count': item.get('tracks_count', 0)
                    })
                    
            logger.info(f"Found {len(playlists)} Qobuz playlists")
            return playlists
            
        except Exception as e:
            logger.error(f"Error listing user playlists: {e}")
            return []
    
    def get_playlist_tracks(self, playlist_id: str) -> List[int]:
        """
        Get all track IDs in a playlist (handles pagination).

        Args:
            playlist_id: Playlist ID

        Returns:
            List of track IDs
        """
        try:
            track_ids = []
            offset = 0
            limit = 500

            while True:
                params = {
                    'playlist_id': playlist_id,
                    'extra': 'tracks',
                    'limit': limit,
                    'offset': offset
                }
                data = self._make_request('playlist/get', params)

                if not data or 'tracks' not in data:
                    break

                tracks_data = data['tracks']
                items = tracks_data.get('items', [])

                if not items:
                    break

                track_ids.extend(track['id'] for track in items)

                total = tracks_data.get('total', 0)
                if len(track_ids) >= total:
                    break

                offset += limit

            logger.debug(f"Found {len(track_ids)} tracks in playlist {playlist_id}")
            return track_ids

        except Exception as e:
            logger.error(f"Error getting playlist tracks {playlist_id}: {e}")
            return []
    
    def find_playlist_by_name(self, name: str) -> Optional[Dict]:
        """
        Find a playlist by exact name match.
        
        Args:
            name: Playlist name to search for
            
        Returns:
            Playlist dict with keys: id, name, tracks_count, or None if not found
        """
        playlists = self.list_user_playlists()
        for playlist in playlists:
            if playlist['name'] == name:
                logger.debug(f"Found existing playlist: {name} (ID: {playlist['id']})")
                return playlist
        return None
    
    def get_favorite_tracks(self, limit: int = 5000) -> List[int]:
        """
        Get all favorite/liked track IDs for the authenticated user.

        Args:
            limit: Maximum number of favorites to retrieve (default: 5000)

        Returns:
            List of track IDs that are favorited

        Raises:
            Exception: If API call fails
        """
        try:
            url = f"{self.BASE_URL}/favorite/getUserFavorites"
            params = {
                "type": "tracks",
                "limit": limit,
                "offset": 0
            }

            response = self._session.get(url, params=params, timeout=30)
            response.raise_for_status()

            data = response.json()
            track_ids = []

            if 'tracks' in data and 'items' in data['tracks']:
                for item in data['tracks']['items']:
                    if 'id' in item:
                        track_ids.append(item['id'])

            logger.info(f"Retrieved {len(track_ids)} favorite tracks from Qobuz")
            return track_ids

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get favorite tracks: {e}")
            raise Exception(f"Failed to get favorite tracks: {e}")

    def get_favorites_count(self) -> int:
        """Get total count of favorite tracks without fetching all."""
        try:
            url = f"{self.BASE_URL}/favorite/getUserFavorites"
            params = {
                "type": "tracks",
                "limit": 1,
                "offset": 0
            }

            response = self._session.get(url, params=params, timeout=10)
            response.raise_for_status()

            data = response.json()
            return data.get('tracks', {}).get('total', 0)

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get favorites count: {e}")
            return 0

    def get_favorite_tracks_with_isrc(self, limit: int = 5000) -> Dict[str, int]:
        """
        Get favorite tracks with their ISRCs for pre-matching.

        Returns:
            Dict mapping ISRC → Qobuz track ID
        """
        try:
            url = f"{self.BASE_URL}/favorite/getUserFavorites"
            params = {
                "type": "tracks",
                "limit": limit,
                "offset": 0
            }

            response = self._session.get(url, params=params, timeout=60)
            response.raise_for_status()

            data = response.json()
            isrc_map = {}

            if 'tracks' in data and 'items' in data['tracks']:
                for item in data['tracks']['items']:
                    isrc = item.get('isrc')
                    track_id = item.get('id')
                    if isrc and track_id:
                        isrc_map[isrc] = track_id

            logger.info(f"Retrieved {len(isrc_map)} favorite tracks with ISRCs from Qobuz")
            return isrc_map

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get favorite tracks with ISRC: {e}")
            return {}

    def get_favorite_albums_with_upc(self, limit: int = 5000) -> Dict[str, str]:
        """
        Get favorite albums with their UPCs for pre-matching.

        Returns:
            Dict mapping UPC → Qobuz album ID
        """
        try:
            url = f"{self.BASE_URL}/favorite/getUserFavorites"
            params = {
                "type": "albums",
                "limit": limit,
                "offset": 0
            }

            response = self._session.get(url, params=params, timeout=60)
            response.raise_for_status()

            data = response.json()
            upc_map = {}

            if 'albums' in data and 'items' in data['albums']:
                for item in data['albums']['items']:
                    upc = item.get('upc')
                    album_id = item.get('id')
                    if upc and album_id:
                        upc_map[upc] = album_id

            logger.info(f"Retrieved {len(upc_map)} favorite albums with UPCs from Qobuz")
            return upc_map

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get favorite albums with UPC: {e}")
            return {}

    def add_favorite_track(self, track_id: int) -> bool:
        """
        Add a track to user's favorites.

        Args:
            track_id: Qobuz track ID to favorite

        Returns:
            True if successful, False otherwise

        Raises:
            Exception: If API call fails
        """
        try:
            url = f"{self.BASE_URL}/favorite/create"
            params = {
                "track_ids": str(track_id)
            }

            response = self._session.post(url, params=params, timeout=10)

            # Qobuz may return 400 if already favorited, which is fine
            if response.status_code == 400:
                logger.debug(f"Track {track_id} is already favorited")
                return True

            response.raise_for_status()
            logger.debug(f"Added track {track_id} to favorites")
            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to add track {track_id} to favorites: {e}")
            return False

    def add_favorite_tracks_batch(self, track_ids: List[int]) -> bool:
        """
        Add multiple tracks to user's favorites in a single API call.

        Args:
            track_ids: List of Qobuz track IDs to favorite

        Returns:
            True if successful, False otherwise
        """
        if not track_ids:
            return True

        try:
            url = f"{self.BASE_URL}/favorite/create"
            params = {
                "track_ids": ",".join(str(tid) for tid in track_ids)
            }

            response = self._session.post(url, params=params, timeout=30)

            # Qobuz may return 400 if already favorited, which is fine
            if response.status_code == 400:
                logger.debug(f"Some tracks already favorited")
                return True

            response.raise_for_status()
            logger.debug(f"Added {len(track_ids)} tracks to favorites in batch")
            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to batch add favorites: {e}")
            return False
    
    def is_track_favorited(self, track_id: int) -> bool:
        """
        Check if a track is in user's favorites.

        Args:
            track_id: Qobuz track ID to check

        Returns:
            True if track is favorited, False otherwise
        """
        try:
            favorites = self.get_favorite_tracks()
            return track_id in favorites
        except Exception:
            return False

    # --- Album Methods ---

    def search_album(self, title: str, artist: str) -> List[Dict]:
        """
        Search for albums by title and artist.

        Args:
            title: Album title
            artist: Artist name

        Returns:
            List of album dictionaries with keys: id, title, artist, release_year, tracks_count
        """
        try:
            query = f"{title} {artist}"
            params = {
                'query': query,
                'limit': 10
            }

            data = self._make_request('album/search', params)

            albums = []
            if data.get('albums', {}).get('items'):
                for item in data['albums']['items']:
                    album = {
                        'id': item['id'],
                        'title': item.get('title', ''),
                        'artist': item.get('artist', {}).get('name', 'Unknown'),
                        'release_year': str(item.get('released_at', ''))[:4] if item.get('released_at') else None,
                        'tracks_count': item.get('tracks_count', 0),
                        'upc': item.get('upc')
                    }
                    albums.append(album)

            logger.debug(f"Found {len(albums)} albums for query: {query}")
            return albums

        except Exception as e:
            logger.error(f"Error searching albums for {title} - {artist}: {e}")
            return []

    def search_album_by_upc(self, upc: str) -> Optional[Dict]:
        """
        Search for an album by UPC code.

        Args:
            upc: UPC barcode

        Returns:
            Album dictionary or None if not found
        """
        try:
            params = {
                'query': upc,
                'limit': 5
            }

            data = self._make_request('album/search', params)

            if data.get('albums', {}).get('items'):
                for item in data['albums']['items']:
                    # Check for exact UPC match
                    if item.get('upc') and item['upc'] == upc:
                        return {
                            'id': item['id'],
                            'title': item.get('title', ''),
                            'artist': item.get('artist', {}).get('name', 'Unknown'),
                            'release_year': str(item.get('released_at', ''))[:4] if item.get('released_at') else None,
                            'tracks_count': item.get('tracks_count', 0),
                            'upc': item.get('upc')
                        }

            logger.debug(f"No exact UPC match found for: {upc}")
            return None

        except Exception as e:
            logger.error(f"Error searching by UPC {upc}: {e}")
            return None

    def get_favorite_albums(self, limit: int = 5000) -> List[int]:
        """
        Get all favorite/liked album IDs for the authenticated user.

        Args:
            limit: Maximum number of favorites to retrieve

        Returns:
            List of album IDs that are favorited
        """
        try:
            url = f"{self.BASE_URL}/favorite/getUserFavorites"
            params = {
                "type": "albums",
                "limit": limit,
                "offset": 0
            }

            response = self._session.get(url, params=params, timeout=30)
            response.raise_for_status()

            data = response.json()
            album_ids = []

            if 'albums' in data and 'items' in data['albums']:
                for item in data['albums']['items']:
                    if 'id' in item:
                        album_ids.append(item['id'])

            logger.info(f"Retrieved {len(album_ids)} favorite albums from Qobuz")
            return album_ids

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get favorite albums: {e}")
            return []

    def get_favorite_albums_count(self) -> int:
        """Get total count of favorite albums without fetching all."""
        try:
            url = f"{self.BASE_URL}/favorite/getUserFavorites"
            params = {
                "type": "albums",
                "limit": 1,
                "offset": 0
            }

            response = self._session.get(url, params=params, timeout=10)
            response.raise_for_status()

            data = response.json()
            return data.get('albums', {}).get('total', 0)

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get favorite albums count: {e}")
            return 0

    def add_favorite_album(self, album_id: int) -> bool:
        """
        Add an album to user's favorites.

        Args:
            album_id: Qobuz album ID to favorite

        Returns:
            True if successful, False otherwise
        """
        try:
            url = f"{self.BASE_URL}/favorite/create"
            params = {
                "album_ids": str(album_id)
            }

            response = self._session.post(url, params=params, timeout=10)

            # Qobuz may return 400 if already favorited
            if response.status_code == 400:
                logger.debug(f"Album {album_id} is already favorited")
                return True

            response.raise_for_status()
            logger.debug(f"Added album {album_id} to favorites")
            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to add album {album_id} to favorites: {e}")
            return False

    def add_favorite_albums_batch(self, album_ids: List[int]) -> bool:
        """
        Add multiple albums to user's favorites in a single API call.

        Args:
            album_ids: List of Qobuz album IDs to favorite

        Returns:
            True if successful, False otherwise
        """
        if not album_ids:
            return True

        try:
            url = f"{self.BASE_URL}/favorite/create"
            params = {
                "album_ids": ",".join(str(aid) for aid in album_ids)
            }

            response = self._session.post(url, params=params, timeout=30)

            if response.status_code == 400:
                logger.debug(f"Some albums already favorited")
                return True

            response.raise_for_status()
            logger.debug(f"Added {len(album_ids)} albums to favorites in batch")
            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to batch add favorite albums: {e}")
            return False
