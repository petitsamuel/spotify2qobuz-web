"""Spotify API client for retrieving playlists and tracks."""

from typing import Dict, List, Optional
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from src.utils.logger import get_logger


logger = get_logger()


class SpotifyClient:
    """Client for interacting with Spotify Web API."""
    
    def __init__(self, client_id: str, client_secret: str, redirect_uri: str):
        """
        Initialize Spotify client.
        
        Args:
            client_id: Spotify application client ID
            client_secret: Spotify application client secret
            redirect_uri: OAuth redirect URI
        """
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.sp: Optional[spotipy.Spotify] = None
    
    def authenticate_user(self) -> None:
        """
        Authenticate user with Spotify using OAuth.
        
        Raises:
            Exception: If authentication fails
        """
        try:
            scope = "playlist-read-private playlist-read-collaborative user-library-read"
            auth_manager = SpotifyOAuth(
                client_id=self.client_id,
                client_secret=self.client_secret,
                redirect_uri=self.redirect_uri,
                scope=scope,
                open_browser=True
            )
            self.sp = spotipy.Spotify(auth_manager=auth_manager)
            
            # Test authentication
            user = self.sp.current_user()
            logger.info(f"Authenticated as Spotify user: {user['display_name']}")
            
        except Exception as e:
            logger.error(f"Spotify authentication failed: {e}")
            raise
    
    def list_playlists(self) -> List[Dict]:
        """
        List all playlists for the authenticated user.
        
        Returns:
            List of playlist dictionaries with keys: id, name, tracks_count
        
        Raises:
            Exception: If not authenticated or API call fails
        """
        if not self.sp:
            raise Exception("Not authenticated. Call authenticate_user() first.")
        
        playlists = []
        offset = 0
        limit = 50
        
        while True:
            results = self.sp.current_user_playlists(limit=limit, offset=offset)
            
            for item in results['items']:
                playlist = {
                    'id': item['id'],
                    'name': item['name'],
                    'tracks_count': item['tracks']['total']
                }
                playlists.append(playlist)
                logger.debug(f"Found playlist: {playlist['name']} ({playlist['tracks_count']} tracks)")
            
            if not results['next']:
                break
            
            offset += limit
        
        logger.info(f"Retrieved {len(playlists)} playlists from Spotify")
        return playlists
    
    def list_tracks(self, playlist_id: str) -> List[Dict]:
        """
        List all tracks in a playlist.
        
        Args:
            playlist_id: Spotify playlist ID
        
        Returns:
            List of normalized track dictionaries with keys:
            - title: Track title
            - artist: Primary artist name
            - album: Album name
            - duration: Duration in milliseconds
            - isrc: ISRC code (if available)
        
        Raises:
            Exception: If not authenticated or API call fails
        """
        if not self.sp:
            raise Exception("Not authenticated. Call authenticate_user() first.")
        
        tracks = []
        offset = 0
        limit = 100
        
        while True:
            results = self.sp.playlist_tracks(
                playlist_id,
                offset=offset,
                limit=limit,
                fields='items(track(name,artists,album,duration_ms,external_ids)),next'
            )
            
            for item in results['items']:
                track_data = item.get('track')
                if not track_data:
                    continue
                
                # Extract ISRC if available
                isrc = None
                external_ids = track_data.get('external_ids', {})
                if external_ids and 'isrc' in external_ids:
                    isrc = external_ids['isrc']
                
                # Get primary artist
                artist = track_data['artists'][0]['name'] if track_data['artists'] else "Unknown"
                
                track = {
                    'title': track_data['name'],
                    'artist': artist,
                    'album': track_data['album']['name'],
                    'duration': track_data['duration_ms'],
                    'isrc': isrc
                }
                tracks.append(track)
            
            if not results['next']:
                break
            
            offset += limit
        
        logger.info(f"Retrieved {len(tracks)} tracks from playlist {playlist_id}")
        return tracks
    
    def get_saved_tracks(self) -> List[Dict]:
        """
        Get all saved/liked tracks for the authenticated user.
        
        Returns:
            List of normalized track dictionaries with keys:
            - title: Track title
            - artist: Primary artist name
            - album: Album name
            - duration: Duration in milliseconds
            - isrc: ISRC code (if available)
        
        Raises:
            Exception: If not authenticated or API call fails
        """
        if not self.sp:
            raise Exception("Not authenticated. Call authenticate_user() first.")
        
        tracks = []
        offset = 0
        limit = 50
        
        while True:
            results = self.sp.current_user_saved_tracks(
                limit=limit,
                offset=offset
            )
            
            for item in results['items']:
                track_data = item.get('track')
                if not track_data:
                    continue
                
                # Extract ISRC if available
                isrc = None
                external_ids = track_data.get('external_ids', {})
                if external_ids and 'isrc' in external_ids:
                    isrc = external_ids['isrc']
                
                # Get primary artist
                artist = track_data['artists'][0]['name'] if track_data['artists'] else "Unknown"
                
                track = {
                    'title': track_data['name'],
                    'artist': artist,
                    'album': track_data['album']['name'],
                    'duration': track_data['duration_ms'],
                    'isrc': isrc
                }
                tracks.append(track)
            
            if not results['next']:
                break
            
            offset += limit
        
        logger.info(f"Retrieved {len(tracks)} saved tracks from Spotify")
        return tracks

    def get_saved_albums(self) -> List[Dict]:
        """
        Get all saved/liked albums for the authenticated user.

        Returns:
            List of normalized album dictionaries with keys:
            - title: Album title
            - artist: Primary artist name
            - upc: UPC code (if available)
            - release_year: Year of release

        Raises:
            Exception: If not authenticated or API call fails
        """
        if not self.sp:
            raise Exception("Not authenticated. Call authenticate_user() first.")

        albums = []
        offset = 0
        limit = 50

        while True:
            results = self.sp.current_user_saved_albums(
                limit=limit,
                offset=offset
            )

            for item in results['items']:
                album_data = item.get('album')
                if not album_data:
                    continue

                # Extract UPC if available
                upc = None
                external_ids = album_data.get('external_ids', {})
                if external_ids and 'upc' in external_ids:
                    upc = external_ids['upc']

                # Get primary artist
                artist = album_data['artists'][0]['name'] if album_data['artists'] else "Unknown"

                # Get release year
                release_date = album_data.get('release_date', '')
                release_year = release_date[:4] if release_date else None

                album = {
                    'id': album_data['id'],
                    'title': album_data['name'],
                    'artist': artist,
                    'upc': upc,
                    'release_year': release_year,
                    'total_tracks': album_data.get('total_tracks', 0)
                }
                albums.append(album)

            if not results['next']:
                break

            offset += limit

        logger.info(f"Retrieved {len(albums)} saved albums from Spotify")
        return albums

    def iter_saved_albums(self, start_offset: int = 0):
        """
        Generator that yields saved albums one at a time with pagination.

        Args:
            start_offset: Starting offset for resuming interrupted syncs

        Yields:
            Tuple of (album_dict, spotify_id, current_offset, total_albums)
        """
        if not self.sp:
            raise Exception("Not authenticated. Call authenticate_user() first.")

        offset = start_offset
        limit = 50
        total = None

        while True:
            results = self.sp.current_user_saved_albums(
                limit=limit,
                offset=offset
            )

            if total is None:
                total = results.get('total', 0)
                logger.info(f"Streaming {total} saved albums from Spotify (starting at {start_offset})")

            for item in results['items']:
                album_data = item.get('album')
                if not album_data:
                    continue

                # Extract UPC if available
                upc = None
                external_ids = album_data.get('external_ids', {})
                if external_ids and 'upc' in external_ids:
                    upc = external_ids['upc']

                # Get primary artist
                artist = album_data['artists'][0]['name'] if album_data['artists'] else "Unknown"

                # Get release year
                release_date = album_data.get('release_date', '')
                release_year = release_date[:4] if release_date else None

                spotify_id = album_data['id']
                album = {
                    'id': spotify_id,
                    'title': album_data['name'],
                    'artist': artist,
                    'upc': upc,
                    'release_year': release_year,
                    'total_tracks': album_data.get('total_tracks', 0)
                }
                yield album, spotify_id, offset, total

            if not results['next']:
                break

            offset += limit

    def iter_saved_tracks(self, start_offset: int = 0):
        """
        Generator that yields saved tracks one at a time with pagination.

        This is more memory-efficient than get_saved_tracks() and allows
        processing tracks as they're fetched.

        Args:
            start_offset: Starting offset for resuming interrupted syncs

        Yields:
            Tuple of (track_dict, spotify_id, current_offset, total_tracks)
        """
        if not self.sp:
            raise Exception("Not authenticated. Call authenticate_user() first.")

        offset = start_offset
        limit = 50
        total = None

        while True:
            results = self.sp.current_user_saved_tracks(
                limit=limit,
                offset=offset
            )

            if total is None:
                total = results.get('total', 0)
                logger.info(f"Streaming {total} saved tracks from Spotify (starting at {start_offset})")

            for item in results['items']:
                track_data = item.get('track')
                if not track_data:
                    continue

                # Extract ISRC if available
                isrc = None
                external_ids = track_data.get('external_ids', {})
                if external_ids and 'isrc' in external_ids:
                    isrc = external_ids['isrc']

                # Get primary artist
                artist = track_data['artists'][0]['name'] if track_data['artists'] else "Unknown"

                spotify_id = track_data['id']
                track = {
                    'id': spotify_id,
                    'title': track_data['name'],
                    'artist': artist,
                    'album': track_data['album']['name'],
                    'duration': track_data['duration_ms'],
                    'isrc': isrc
                }
                yield track, spotify_id, offset, total

            if not results['next']:
                break

            offset += limit
