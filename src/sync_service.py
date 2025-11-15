"""Synchronization service for syncing Spotify playlists to Qobuz."""

import argparse
import json
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List
from src.spotify_client import SpotifyClient
from src.qobuz_client import QobuzClient
from src.matcher import TrackMatcher
from src.utils.credentials import parse_credentials
from src.utils.logger import setup_logger, get_logger


class SyncReport:
    """Report of synchronization results."""
    
    def __init__(self):
        """Initialize empty sync report."""
        self.start_time = datetime.now()
        self.end_time = None
        self.playlists_synced = 0
        self.tracks_matched = 0
        self.tracks_not_matched = 0
        self.isrc_matches = 0
        self.fuzzy_matches = 0
        self.missing_tracks = []
        self.errors = []
    
    def add_matched_track(self, match_type: str):
        """Record a successful track match."""
        self.tracks_matched += 1
        if match_type == 'isrc':
            self.isrc_matches += 1
        elif match_type == 'fuzzy':
            self.fuzzy_matches += 1
    
    def add_missing_track(self, playlist_name: str, track: Dict):
        """Record a track that couldn't be matched."""
        self.tracks_not_matched += 1
        self.missing_tracks.append({
            'playlist': playlist_name,
            'title': track['title'],
            'artist': track['artist'],
            'album': track['album']
        })
    
    def add_error(self, error: str):
        """Record an error."""
        self.errors.append(error)
    
    def finalize(self):
        """Mark sync as complete."""
        self.end_time = datetime.now()
    
    def to_dict(self) -> Dict:
        """Convert report to dictionary."""
        duration = None
        if self.end_time:
            duration = (self.end_time - self.start_time).total_seconds()
        
        return {
            'start_time': self.start_time.isoformat(),
            'end_time': self.end_time.isoformat() if self.end_time else None,
            'duration_seconds': duration,
            'playlists_synced': self.playlists_synced,
            'tracks_matched': self.tracks_matched,
            'tracks_not_matched': self.tracks_not_matched,
            'match_rate': f"{(self.tracks_matched / (self.tracks_matched + self.tracks_not_matched) * 100):.2f}%" 
                         if (self.tracks_matched + self.tracks_not_matched) > 0 else "0%",
            'isrc_matches': self.isrc_matches,
            'fuzzy_matches': self.fuzzy_matches,
            'missing_tracks': self.missing_tracks,
            'errors': self.errors
        }
    
    def save_to_file(self, filepath: str):
        """Save report to JSON file."""
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(self.to_dict(), f, indent=2, ensure_ascii=False)


class SyncService:
    """Service for synchronizing Spotify playlists to Qobuz."""
    
    def __init__(self, credentials_path: str = "credentials.md", log_file: str = None):
        """
        Initialize sync service.
        
        Args:
            credentials_path: Path to credentials file
            log_file: Optional path to log file
        """
        self.credentials_path = credentials_path
        
        # Auto-generate log file name if not provided
        if log_file is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_file = f"sync_logs/sync_{timestamp}.log"
        
        self.logger = setup_logger(log_file=log_file)
        self.logger.info(f"📝 Sync log file: {log_file}")
        
        self.spotify_client: SpotifyClient = None
        self.qobuz_client: QobuzClient = None
        self.matcher: TrackMatcher = None
        self.report = SyncReport()
    
    def load_credentials(self) -> Dict[str, str]:
        """
        Load credentials from file.
        
        Returns:
            Credentials dictionary
        
        Raises:
            Exception: If credentials cannot be loaded
        """
        try:
            self.logger.info(f"Loading credentials from {self.credentials_path}")
            credentials = parse_credentials(self.credentials_path)
            return credentials
        except Exception as e:
            self.logger.error(f"Failed to load credentials: {e}")
            self.report.add_error(f"Failed to load credentials: {e}")
            raise
    
    def authenticate_clients(self, credentials: Dict[str, str]):
        """
        Authenticate Spotify and Qobuz clients.
        
        Args:
            credentials: Credentials dictionary
        
        Raises:
            Exception: If authentication fails
        """
        try:
            # Authenticate Spotify
            self.logger.info("Authenticating with Spotify...")
            self.spotify_client = SpotifyClient(
                client_id=credentials['SPOTIFY_CLIENT_ID'],
                client_secret=credentials['SPOTIFY_CLIENT_SECRET'],
                redirect_uri=credentials['SPOTIFY_REDIRECT_URI']
            )
            self.spotify_client.authenticate_user()
            
            # Authenticate Qobuz
            self.logger.info("Authenticating with Qobuz...")
            self.qobuz_client = QobuzClient(
                user_auth_token=credentials['QOBUZ_USER_AUTH_TOKEN']
            )
            self.qobuz_client.authenticate()
            
            # Initialize matcher
            self.matcher = TrackMatcher(self.qobuz_client)
            
            self.logger.info("Authentication successful")
            
        except Exception as e:
            self.logger.error(f"Authentication failed: {e}")
            self.report.add_error(f"Authentication failed: {e}")
            raise
    
    def sync_playlist(self, playlist: Dict, dry_run: bool = False, update_existing: bool = True) -> bool:
        """
        Sync a single playlist from Spotify to Qobuz.
        
        Args:
            playlist: Spotify playlist dictionary
            dry_run: If True, don't create playlist or add tracks
            update_existing: If True, update existing playlists instead of creating duplicates
        
        Returns:
            True if successful, False otherwise
        """
        playlist_name = playlist['name']
        playlist_id = playlist['id']
        
        self.logger.info(f"Syncing playlist: {playlist_name} ({playlist['tracks_count']} tracks)")
        
        try:
            # Get tracks from Spotify
            spotify_tracks = self.spotify_client.list_tracks(playlist_id)
            
            if not spotify_tracks:
                self.logger.warning(f"No tracks found in playlist: {playlist_name}")
                self.report.playlists_synced += 1
                return True
            
            # Check for existing Qobuz playlist
            qobuz_playlist_id = None
            qobuz_playlist_name = f"{playlist_name} (from Spotify)"
            existing_track_ids = set()
            
            if not dry_run:
                if update_existing:
                    existing_playlist = self.qobuz_client.find_playlist_by_name(qobuz_playlist_name)
                    if existing_playlist:
                        qobuz_playlist_id = existing_playlist['id']
                        existing_track_ids = set(self.qobuz_client.get_playlist_tracks(qobuz_playlist_id))
                        self.logger.info(f"Found existing playlist with {len(existing_track_ids)} tracks, will add missing tracks only")
                
                # Create new playlist if not found
                if not qobuz_playlist_id:
                    qobuz_playlist_id = self.qobuz_client.create_playlist(
                        name=qobuz_playlist_name,
                        description=f"Synced from Spotify on {datetime.now().strftime('%Y-%m-%d')}"
                    )
                    
                    if not qobuz_playlist_id:
                        self.logger.error(f"Failed to create Qobuz playlist: {playlist_name}")
                        self.report.add_error(f"Failed to create playlist: {playlist_name}")
                        return False
            
            # Match and add tracks
            matched_count = 0
            skipped_count = 0
            
            for track in spotify_tracks:
                match_result = self.matcher.match_track(track)
                
                if match_result:
                    self.report.add_matched_track(match_result.match_type)
                    matched_count += 1
                    
                    if not dry_run:
                        qobuz_track_id = match_result.qobuz_track['id']
                        
                        # Skip if track already in playlist
                        if qobuz_track_id in existing_track_ids:
                            skipped_count += 1
                            self.logger.debug(f"Skipping duplicate: {track['title']} by {track['artist']}")
                            continue
                        
                        success = self.qobuz_client.add_track(
                            qobuz_playlist_id,
                            qobuz_track_id
                        )
                        if not success:
                            self.logger.warning(
                                f"Failed to add track: {track['title']} by {track['artist']}"
                            )
                else:
                    self.logger.warning(
                        f"No match found for: {track['title']} by {track['artist']}"
                    )
                    self.report.add_missing_track(playlist_name, track)
            
            if skipped_count > 0:
                self.logger.info(
                    f"Playlist sync complete: {playlist_name} - "
                    f"{matched_count}/{len(spotify_tracks)} tracks matched, {skipped_count} already in playlist"
                )
            else:
                self.logger.info(
                    f"Playlist sync complete: {playlist_name} - "
                    f"{matched_count}/{len(spotify_tracks)} tracks matched"
                )
            self.report.playlists_synced += 1
            return True
            
        except Exception as e:
            self.logger.error(f"Error syncing playlist {playlist_name}: {e}")
            self.report.add_error(f"Error syncing playlist {playlist_name}: {e}")
            return False
    
    def sync_all_playlists(self, dry_run: bool = False, update_existing: bool = True):
        """
        Sync all Spotify playlists to Qobuz.
        
        Args:
            dry_run: If True, don't create playlists or add tracks
            update_existing: If True, update existing playlists instead of creating duplicates
        """
        try:
            self.logger.info("Starting playlist synchronization...")
            
            if dry_run:
                self.logger.info("DRY RUN MODE - No changes will be made")
            
            if update_existing:
                self.logger.info("UPDATE MODE - Will add new tracks to existing playlists")
            else:
                self.logger.info("CREATE MODE - Will create new playlists even if they exist")
            
            # Get all playlists
            playlists = self.spotify_client.list_playlists()
            
            if not playlists:
                self.logger.warning("No playlists found")
                return
            
            # Sync each playlist
            for i, playlist in enumerate(playlists, 1):
                self.logger.info(f"Processing playlist {i}/{len(playlists)}")
                self.sync_playlist(playlist, dry_run=dry_run, update_existing=update_existing)
            
            self.report.finalize()
            
            # Print summary
            self.logger.info("\n" + "="*60)
            self.logger.info("SYNC COMPLETE")
            self.logger.info("="*60)
            self.logger.info(f"Playlists synced: {self.report.playlists_synced}")
            self.logger.info(f"Tracks matched: {self.report.tracks_matched}")
            self.logger.info(f"Tracks not matched: {self.report.tracks_not_matched}")
            self.logger.info(f"ISRC matches: {self.report.isrc_matches}")
            self.logger.info(f"Fuzzy matches: {self.report.fuzzy_matches}")
            
            if self.report.tracks_matched + self.report.tracks_not_matched > 0:
                match_rate = (self.report.tracks_matched / 
                             (self.report.tracks_matched + self.report.tracks_not_matched) * 100)
                self.logger.info(f"Match rate: {match_rate:.2f}%")
            
            # Save report
            report_path = f"sync_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            self.report.save_to_file(report_path)
            self.logger.info(f"Report saved to: {report_path}")
            
        except Exception as e:
            self.logger.error(f"Sync failed: {e}")
            self.report.add_error(f"Sync failed: {e}")
            raise


def main():
    """Main entry point for CLI."""
    parser = argparse.ArgumentParser(
        description="Synchronize Spotify playlists to Qobuz"
    )
    parser.add_argument(
        '--dry-run',
        type=str,
        choices=['true', 'false'],
        default='false',
        help='Run in dry-run mode (no changes made)'
    )
    parser.add_argument(
        '--update-existing',
        type=str,
        choices=['true', 'false'],
        default='true',
        help='Update existing playlists instead of creating duplicates (default: true)'
    )
    parser.add_argument(
        '--credentials',
        type=str,
        default='credentials.md',
        help='Path to credentials file (default: credentials.md)'
    )
    parser.add_argument(
        '--log-file',
        type=str,
        default=None,
        help='Path to log file (optional)'
    )
    
    args = parser.parse_args()
    dry_run = args.dry_run == 'true'
    update_existing = args.update_existing == 'true'
    
    try:
        # Initialize service
        service = SyncService(
            credentials_path=args.credentials,
            log_file=args.log_file
        )
        
        # Load credentials and authenticate
        credentials = service.load_credentials()
        service.authenticate_clients(credentials)
        
        # Sync playlists
        service.sync_all_playlists(dry_run=dry_run, update_existing=update_existing)
        
        print("\nSync completed successfully!")
        sys.exit(0)
        
    except KeyboardInterrupt:
        print("\n\nSync interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\nSync failed: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
