"""Unit tests for sync service."""

import pytest
import json
import sys
from unittest.mock import Mock, patch, MagicMock, mock_open
from pathlib import Path
from src.sync_service import SyncService, SyncReport
from src.matcher import MatchResult


@pytest.fixture
def mock_credentials():
    """Create mock credentials."""
    return {
        'SPOTIFY_CLIENT_ID': 'test_spotify_id',
        'SPOTIFY_CLIENT_SECRET': 'test_spotify_secret',
        'SPOTIFY_REDIRECT_URI': 'http://localhost:8888/callback',
        'QOBUZ_USER_AUTH_TOKEN': 'test_token_abc123def456'
    }


@pytest.fixture
def sync_service():
    """Create a SyncService instance."""
    return SyncService(credentials_path="test_credentials.md")


@pytest.fixture
def mock_spotify_client():
    """Create a mock Spotify client."""
    client = Mock()
    client.authenticate_user = Mock()
    client.list_playlists = Mock()
    client.list_tracks = Mock()
    return client


@pytest.fixture
def mock_qobuz_client():
    """Create a mock Qobuz client."""
    client = Mock()
    client.authenticate = Mock()
    client.create_playlist = Mock()
    client.add_track = Mock()
    return client


@pytest.fixture
def mock_matcher():
    """Create a mock TrackMatcher."""
    matcher = Mock()
    matcher.match_track = Mock()
    return matcher


class TestSyncReport:
    """Test cases for SyncReport."""
    
    def test_init(self):
        """Test SyncReport initialization."""
        report = SyncReport()
        
        assert report.playlists_synced == 0
        assert report.tracks_matched == 0
        assert report.tracks_not_matched == 0
        assert report.isrc_matches == 0
        assert report.fuzzy_matches == 0
        assert len(report.missing_tracks) == 0
        assert len(report.errors) == 0
        assert report.start_time is not None
        assert report.end_time is None
    
    def test_add_matched_track_isrc(self):
        """Test adding ISRC matched track."""
        report = SyncReport()
        
        report.add_matched_track('isrc')
        
        assert report.tracks_matched == 1
        assert report.isrc_matches == 1
        assert report.fuzzy_matches == 0
    
    def test_add_matched_track_fuzzy(self):
        """Test adding fuzzy matched track."""
        report = SyncReport()
        
        report.add_matched_track('fuzzy')
        
        assert report.tracks_matched == 1
        assert report.fuzzy_matches == 1
        assert report.isrc_matches == 0
    
    def test_add_missing_track(self):
        """Test adding missing track."""
        report = SyncReport()
        track = {
            'title': 'Test Track',
            'artist': 'Test Artist',
            'album': 'Test Album'
        }
        
        report.add_missing_track('Test Playlist', track)
        
        assert report.tracks_not_matched == 1
        assert len(report.missing_tracks) == 1
        assert report.missing_tracks[0]['playlist'] == 'Test Playlist'
        assert report.missing_tracks[0]['title'] == 'Test Track'
    
    def test_add_error(self):
        """Test adding error."""
        report = SyncReport()
        
        report.add_error('Test error')
        
        assert len(report.errors) == 1
        assert report.errors[0] == 'Test error'
    
    def test_finalize(self):
        """Test finalizing report."""
        report = SyncReport()
        
        report.finalize()
        
        assert report.end_time is not None
    
    def test_to_dict(self):
        """Test converting report to dictionary."""
        report = SyncReport()
        report.add_matched_track('isrc')
        report.add_matched_track('fuzzy')
        report.add_missing_track('Test Playlist', {
            'title': 'Test Track',
            'artist': 'Test Artist',
            'album': 'Test Album'
        })
        report.finalize()
        
        result = report.to_dict()
        
        assert result['playlists_synced'] == 0
        assert result['tracks_matched'] == 2
        assert result['tracks_not_matched'] == 1
        assert result['isrc_matches'] == 1
        assert result['fuzzy_matches'] == 1
        assert 'match_rate' in result
        assert len(result['missing_tracks']) == 1
    
    def test_save_to_file(self, tmp_path):
        """Test saving report to file."""
        report = SyncReport()
        report.add_matched_track('isrc')
        report.finalize()
        
        filepath = tmp_path / "test_report.json"
        report.save_to_file(str(filepath))
        
        assert filepath.exists()
        
        with open(filepath, 'r') as f:
            data = json.load(f)
        
        assert data['tracks_matched'] == 1


class TestSyncService:
    """Test cases for SyncService."""
    
    def test_init(self, sync_service):
        """Test SyncService initialization."""
        assert sync_service.credentials_path == "test_credentials.md"
        assert sync_service.spotify_client is None
        assert sync_service.qobuz_client is None
        assert sync_service.matcher is None
        assert sync_service.report is not None
    
    @patch('src.sync_service.parse_credentials')
    def test_load_credentials_success(self, mock_parse, sync_service, mock_credentials):
        """Test successful credentials loading."""
        mock_parse.return_value = mock_credentials
        
        creds = sync_service.load_credentials()
        
        assert creds == mock_credentials
        mock_parse.assert_called_once_with("test_credentials.md")
    
    @patch('src.sync_service.parse_credentials')
    def test_load_credentials_failure(self, mock_parse, sync_service):
        """Test credentials loading failure."""
        mock_parse.side_effect = Exception("File not found")
        
        with pytest.raises(Exception, match="File not found"):
            sync_service.load_credentials()
        
        assert len(sync_service.report.errors) == 1
    
    @patch('src.sync_service.TrackMatcher')
    @patch('src.sync_service.QobuzClient')
    @patch('src.sync_service.SpotifyClient')
    def test_authenticate_clients_success(
        self, mock_spotify_class, mock_qobuz_class, mock_matcher_class,
        sync_service, mock_credentials
    ):
        """Test successful client authentication."""
        mock_spotify = Mock()
        mock_qobuz = Mock()
        mock_spotify_class.return_value = mock_spotify
        mock_qobuz_class.return_value = mock_qobuz
        
        sync_service.authenticate_clients(mock_credentials)
        
        assert sync_service.spotify_client == mock_spotify
        assert sync_service.qobuz_client == mock_qobuz
        assert sync_service.matcher is not None
        mock_spotify.authenticate_user.assert_called_once()
        mock_qobuz.authenticate.assert_called_once()
    
    @patch('src.sync_service.SpotifyClient')
    def test_authenticate_clients_failure(self, mock_spotify_class, sync_service, mock_credentials):
        """Test authentication failure."""
        mock_spotify_class.side_effect = Exception("Auth failed")
        
        with pytest.raises(Exception, match="Auth failed"):
            sync_service.authenticate_clients(mock_credentials)
        
        assert len(sync_service.report.errors) == 1
    
    def test_sync_playlist_success(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test successful playlist sync."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Test Playlist',
            'tracks_count': 2
        }
        
        tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 180000,
                'isrc': 'ISRC1'
            },
            {
                'title': 'Track 2',
                'artist': 'Artist 2',
                'album': 'Album 2',
                'duration': 200000,
                'isrc': 'ISRC2'
            }
        ]
        
        mock_spotify_client.list_tracks.return_value = tracks
        mock_qobuz_client.find_playlist_by_name.return_value = None  # No existing playlist
        mock_qobuz_client.create_playlist.return_value = 'qobuz_playlist_id'
        mock_qobuz_client.add_track.return_value = True
        
        match_result = MatchResult(
            qobuz_track={'id': 123, 'title': 'Track 1'},
            match_type='isrc',
            score=100.0
        )
        mock_matcher.match_track.return_value = match_result
        
        result = sync_service.sync_playlist(playlist, dry_run=False)
        
        assert result is True
        assert sync_service.report.playlists_synced == 1
        assert sync_service.report.tracks_matched == 2
        mock_spotify_client.list_tracks.assert_called_once_with('test_id')
        mock_qobuz_client.create_playlist.assert_called_once()
    
    def test_sync_playlist_dry_run(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test playlist sync in dry-run mode."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Test Playlist',
            'tracks_count': 1
        }
        
        tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 180000,
                'isrc': 'ISRC1'
            }
        ]
        
        mock_spotify_client.list_tracks.return_value = tracks
        
        match_result = MatchResult(
            qobuz_track={'id': 123, 'title': 'Track 1'},
            match_type='isrc',
            score=100.0
        )
        mock_matcher.match_track.return_value = match_result
        
        result = sync_service.sync_playlist(playlist, dry_run=True)
        
        assert result is True
        mock_qobuz_client.create_playlist.assert_not_called()
        mock_qobuz_client.add_track.assert_not_called()
    
    def test_sync_playlist_with_missing_tracks(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test playlist sync with some missing tracks."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Test Playlist',
            'tracks_count': 2
        }
        
        tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 180000,
                'isrc': 'ISRC1'
            },
            {
                'title': 'Track 2',
                'artist': 'Artist 2',
                'album': 'Album 2',
                'duration': 200000,
                'isrc': 'ISRC2'
            }
        ]
        
        mock_spotify_client.list_tracks.return_value = tracks
        mock_qobuz_client.find_playlist_by_name.return_value = None  # No existing playlist
        mock_qobuz_client.create_playlist.return_value = 'qobuz_playlist_id'
    
        # First track matches, second doesn't
        match_result = MatchResult(
            qobuz_track={'id': 123, 'title': 'Track 1'},
            match_type='isrc',
            score=100.0
        )
        mock_matcher.match_track.side_effect = [match_result, None]
        
        result = sync_service.sync_playlist(playlist, dry_run=False)
        
        assert result is True
        assert sync_service.report.tracks_matched == 1
        assert sync_service.report.tracks_not_matched == 1
        assert len(sync_service.report.missing_tracks) == 1
    
    def test_sync_playlist_empty(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test syncing empty playlist."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Empty Playlist',
            'tracks_count': 0
        }
        
        mock_spotify_client.list_tracks.return_value = []
        
        result = sync_service.sync_playlist(playlist, dry_run=False)
        
        assert result is True
        mock_qobuz_client.create_playlist.assert_not_called()
    
    def test_sync_all_playlists(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test syncing all playlists."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlists = [
            {'id': 'p1', 'name': 'Playlist 1', 'tracks_count': 1},
            {'id': 'p2', 'name': 'Playlist 2', 'tracks_count': 1}
        ]
        
        mock_spotify_client.list_playlists.return_value = playlists
        mock_spotify_client.list_tracks.return_value = []
        
        with patch.object(sync_service.report, 'save_to_file'):
            sync_service.sync_all_playlists(dry_run=True)
        
        assert sync_service.report.playlists_synced == 2
        assert sync_service.report.end_time is not None
    
    def test_sync_all_playlists_with_tracks(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test syncing all playlists with tracks to trigger match rate calculation."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlists = [
            {'id': 'p1', 'name': 'Playlist 1', 'tracks_count': 2}
        ]
        
        tracks = [
            {'title': 'Track 1', 'artist': 'Artist 1', 'album': 'Album 1'},
            {'title': 'Track 2', 'artist': 'Artist 2', 'album': 'Album 2'}
        ]
        
        mock_spotify_client.list_playlists.return_value = playlists
        mock_spotify_client.list_tracks.return_value = tracks
        mock_qobuz_client.find_playlist_by_name.return_value = None  # No existing playlist
        mock_qobuz_client.create_playlist.return_value = 'playlist_123'
        mock_qobuz_client.add_track.return_value = True
        
        # First track matches, second doesn't
        match_result = MatchResult(
            qobuz_track={'id': 123, 'title': 'Track 1'},
            match_type='isrc',
            score=100.0
        )
        mock_matcher.match_track.side_effect = [match_result, None]
        
        with patch.object(sync_service.report, 'save_to_file'):
            sync_service.sync_all_playlists(dry_run=False)
        
        assert sync_service.report.playlists_synced == 1
        assert sync_service.report.tracks_matched == 1
        assert sync_service.report.tracks_not_matched == 1
        assert sync_service.report.end_time is not None
    
    def test_authenticate_clients_exception(self, sync_service, mock_credentials):
        """Test authenticate_clients with exception."""
        with patch('src.sync_service.SpotifyClient', side_effect=Exception("Spotify init failed")):
            with pytest.raises(Exception, match="Spotify init failed"):
                sync_service.authenticate_clients(mock_credentials)
    
    def test_sync_playlist_create_failure(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test sync_playlist when playlist creation fails."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Test Playlist',
            'tracks_count': 1
        }
        
        mock_spotify_client.list_tracks.return_value = [
            {'title': 'Track 1', 'artist': 'Artist 1'}
        ]
        mock_qobuz_client.create_playlist.return_value = None  # Creation fails
        
        result = sync_service.sync_playlist(playlist, dry_run=False)
        
        assert result is False
        assert len(sync_service.report.errors) > 0
    
    def test_sync_playlist_add_track_failure(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test sync_playlist when adding track fails."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Test Playlist',
            'tracks_count': 1
        }
        
        track = {'title': 'Track 1', 'artist': 'Artist 1'}
        mock_spotify_client.list_tracks.return_value = [track]
        mock_qobuz_client.find_playlist_by_name.return_value = None  # No existing playlist
        mock_qobuz_client.create_playlist.return_value = 'playlist_123'
        mock_qobuz_client.add_track.return_value = False  # Add fails
        
        match_result = MatchResult(
            qobuz_track={'id': 123, 'title': 'Track 1'},
            match_type='isrc',
            score=100.0
        )
        mock_matcher.match_track.return_value = match_result
        
        result = sync_service.sync_playlist(playlist, dry_run=False)
        
        assert result is True  # Playlist sync succeeds even if track add fails
        assert sync_service.report.tracks_matched == 1
    
    def test_sync_playlist_exception(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test sync_playlist with exception."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Test Playlist',
            'tracks_count': 1
        }
        
        mock_spotify_client.list_tracks.side_effect = Exception("List tracks failed")
        
        result = sync_service.sync_playlist(playlist, dry_run=False)
        
        assert result is False
        assert len(sync_service.report.errors) > 0
    
    def test_sync_playlist_update_existing_found(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test sync_playlist with update_existing=True and existing playlist found."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Test Playlist',
            'tracks_count': 2
        }
        
        spotify_tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 200000,
                'isrc': 'ISRC001'
            },
            {
                'title': 'Track 2',
                'artist': 'Artist 2',
                'album': 'Album 2',
                'duration': 180000,
                'isrc': 'ISRC002'
            }
        ]
        
        mock_spotify_client.list_tracks.return_value = spotify_tracks
        
        # Mock existing playlist found
        mock_qobuz_client.find_playlist_by_name.return_value = {
            'id': 'existing_id',
            'name': 'Test Playlist',
            'tracks_count': 1
        }
        mock_qobuz_client.get_playlist_tracks.return_value = [123]  # One track already exists
        
        # Mock matcher
        mock_match1 = Mock()
        mock_match1.matched = True
        mock_match1.match_type = 'isrc'
        mock_match1.qobuz_track = {'id': 123, 'title': 'Track 1'}
        
        mock_match2 = Mock()
        mock_match2.matched = True
        mock_match2.match_type = 'isrc'
        mock_match2.qobuz_track = {'id': 456, 'title': 'Track 2'}
        
        mock_matcher.match_track.side_effect = [mock_match1, mock_match2]
        mock_qobuz_client.add_track.return_value = True
        
        result = sync_service.sync_playlist(playlist, dry_run=False, update_existing=True)
        
        assert result is True
        # Track 123 should be skipped (already in playlist), track 456 should be added
        mock_qobuz_client.add_track.assert_called_once_with('existing_id', 456)
    
    def test_sync_playlist_create_failure_return_false(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test sync_playlist when playlist creation fails returns False."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlist = {
            'id': 'test_id',
            'name': 'Test Playlist',
            'tracks_count': 1
        }
        
        spotify_tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 200000,
                'isrc': 'ISRC001'
            }
        ]
        
        mock_spotify_client.list_tracks.return_value = spotify_tracks
        # Playlist creation returns None (failure)
        mock_qobuz_client.create_playlist.return_value = None
        
        result = sync_service.sync_playlist(playlist, dry_run=False, update_existing=False)
        
        assert result is False
        assert len(sync_service.report.errors) > 0
    
    def test_sync_all_playlists_with_update_existing_false(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test sync_all_playlists with update_existing=False to cover CREATE MODE log."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        playlists = [
            {'id': '1', 'name': 'Playlist 1', 'tracks_count': 1}
        ]
        
        mock_spotify_client.list_playlists.return_value = playlists
        mock_spotify_client.list_tracks.return_value = []
        
        sync_service.sync_all_playlists(dry_run=False, update_existing=False)
        
        # Just verify it runs without error
        mock_spotify_client.list_playlists.assert_called_once()
    
    def test_sync_all_playlists_no_playlists(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test sync_all_playlists with no playlists."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        mock_spotify_client.list_playlists.return_value = []
        
        sync_service.sync_all_playlists(dry_run=False)
        
        assert sync_service.report.playlists_synced == 0
    
    def test_sync_all_playlists_exception(
        self, sync_service, mock_spotify_client, mock_qobuz_client, mock_matcher
    ):
        """Test sync_all_playlists with exception."""
        sync_service.spotify_client = mock_spotify_client
        sync_service.qobuz_client = mock_qobuz_client
        sync_service.matcher = mock_matcher
        
        mock_spotify_client.list_playlists.side_effect = Exception("List playlists failed")
        
        with pytest.raises(Exception, match="List playlists failed"):
            sync_service.sync_all_playlists(dry_run=False)


class TestMain:
    """Test cases for main() CLI function."""
    
    @patch('src.sync_service.SyncService')
    @patch('sys.argv', ['sync_service.py', '--dry-run', 'true'])
    def test_main_dry_run(self, mock_service_class):
        """Test main with dry-run mode."""
        from src.sync_service import main
        
        mock_service = Mock()
        mock_service_class.return_value = mock_service
        mock_service.load_credentials.return_value = {
            'SPOTIFY_CLIENT_ID': 'test',
            'SPOTIFY_CLIENT_SECRET': 'test',
            'SPOTIFY_REDIRECT_URI': 'http://localhost:8888',
            'QOBUZ_USER_AUTH_TOKEN': 'test'
        }
        
        with pytest.raises(SystemExit) as exc_info:
            main()
        
        assert exc_info.value.code == 0
        mock_service.sync_all_playlists.assert_called_once_with(dry_run=True, update_existing=True)
    
    @patch('src.sync_service.SyncService')
    @patch('sys.argv', ['sync_service.py', '--dry-run', 'false'])
    def test_main_normal_run(self, mock_service_class):
        """Test main with normal run mode."""
        from src.sync_service import main
        
        mock_service = Mock()
        mock_service_class.return_value = mock_service
        mock_service.load_credentials.return_value = {
            'SPOTIFY_CLIENT_ID': 'test',
            'SPOTIFY_CLIENT_SECRET': 'test',
            'SPOTIFY_REDIRECT_URI': 'http://localhost:8888',
            'QOBUZ_USER_AUTH_TOKEN': 'test'
        }
        
        with pytest.raises(SystemExit) as exc_info:
            main()
        
        assert exc_info.value.code == 0
        mock_service.sync_all_playlists.assert_called_once_with(dry_run=False, update_existing=True)
    
    @patch('src.sync_service.SyncService')
    @patch('sys.argv', ['sync_service.py', '--credentials', 'custom.md', '--log-file', 'custom.log'])
    def test_main_custom_paths(self, mock_service_class):
        """Test main with custom credentials and log file paths."""
        from src.sync_service import main
        
        mock_service = Mock()
        mock_service_class.return_value = mock_service
        mock_service.load_credentials.return_value = {
            'SPOTIFY_CLIENT_ID': 'test',
            'SPOTIFY_CLIENT_SECRET': 'test',
            'SPOTIFY_REDIRECT_URI': 'http://localhost:8888',
            'QOBUZ_USER_AUTH_TOKEN': 'test'
        }
        
        with pytest.raises(SystemExit) as exc_info:
            main()
        
        assert exc_info.value.code == 0
        mock_service_class.assert_called_once_with(
            credentials_path='custom.md',
            log_file='custom.log'
        )
    
    @patch('src.sync_service.SyncService')
    @patch('sys.argv', ['sync_service.py'])
    def test_main_keyboard_interrupt(self, mock_service_class):
        """Test main with keyboard interrupt."""
        from src.sync_service import main
        
        mock_service = Mock()
        mock_service_class.return_value = mock_service
        mock_service.load_credentials.return_value = {
            'SPOTIFY_CLIENT_ID': 'test',
            'SPOTIFY_CLIENT_SECRET': 'test',
            'SPOTIFY_REDIRECT_URI': 'http://localhost:8888',
            'QOBUZ_USER_AUTH_TOKEN': 'test'
        }
        mock_service.sync_all_playlists.side_effect = KeyboardInterrupt()
        
        with pytest.raises(SystemExit) as exc_info:
            main()
        
        assert exc_info.value.code == 1
    
    @patch('src.sync_service.SyncService')
    @patch('sys.argv', ['sync_service.py'])
    def test_main_exception(self, mock_service_class):
        """Test main with exception."""
        from src.sync_service import main
        
        mock_service = Mock()
        mock_service_class.return_value = mock_service
        mock_service.load_credentials.side_effect = Exception("Load failed")
        
        with pytest.raises(SystemExit) as exc_info:
            main()
        
        assert exc_info.value.code == 1
