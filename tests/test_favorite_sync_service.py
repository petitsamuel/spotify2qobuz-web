"""Unit tests for FavoriteSyncService."""

import pytest
from unittest.mock import Mock, patch
from src.favorite_sync_service import FavoriteSyncService


@pytest.fixture
def mock_spotify_client():
    """Create a mock Spotify client."""
    return Mock()


@pytest.fixture
def mock_qobuz_client():
    """Create a mock Qobuz client."""
    return Mock()


@pytest.fixture
def favorite_sync_service(mock_spotify_client, mock_qobuz_client):
    """Create a FavoriteSyncService instance with mocked clients."""
    return FavoriteSyncService(
        spotify_client=mock_spotify_client,
        qobuz_client=mock_qobuz_client
    )


class TestFavoriteSyncService:
    """Test cases for FavoriteSyncService."""
    
    def test_init(self, favorite_sync_service, mock_spotify_client, mock_qobuz_client):
        """Test service initialization."""
        assert favorite_sync_service.spotify_client == mock_spotify_client
        assert favorite_sync_service.qobuz_client == mock_qobuz_client
    
    def test_sync_favorites_no_saved_tracks(self, favorite_sync_service, mock_spotify_client):
        """Test syncing when user has no saved tracks in Spotify."""
        mock_spotify_client.get_saved_tracks.return_value = []
        
        stats = favorite_sync_service.sync_favorites()
        
        assert stats['total_spotify_favorites'] == 0
        assert stats['matched'] == 0
        assert stats['not_found'] == 0
        mock_spotify_client.get_saved_tracks.assert_called_once()
    
    def test_sync_favorites_success(
        self,
        favorite_sync_service,
        mock_spotify_client,
        mock_qobuz_client
    ):
        """Test successful favorite sync."""
        # Setup mocks
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
                'isrc': None
            }
        ]
        
        mock_spotify_client.get_saved_tracks.return_value = spotify_tracks
        mock_qobuz_client.get_favorite_tracks.return_value = []
        
        # Mock search results - search_by_isrc and search_by_metadata return single dict or None
        mock_qobuz_client.search_by_isrc.return_value = {'id': 123456, 'title': 'Track 1', 'artist': 'Artist 1', 'album': 'Album 1', 'duration': 200000}
        mock_qobuz_client.search_by_metadata.return_value = {'id': 789012, 'title': 'Track 2', 'artist': 'Artist 2', 'album': 'Album 2', 'duration': 180000}
        
        # Mock add_favorite_track
        mock_qobuz_client.add_favorite_track.return_value = True
        
        stats = favorite_sync_service.sync_favorites(dry_run=False, skip_existing=True)
        
        assert stats['total_spotify_favorites'] == 2
        assert stats['matched'] == 2
        assert stats['not_found'] == 0
        assert stats['failed'] == 0
        assert stats['already_favorited'] == 0
        
        # Verify API calls
        mock_qobuz_client.search_by_isrc.assert_called_once_with('ISRC001')
        mock_qobuz_client.search_by_metadata.assert_called_once_with(
            title='Track 2', artist='Artist 2', duration=180000
        )
        assert mock_qobuz_client.add_favorite_track.call_count == 2
        mock_qobuz_client.add_favorite_track.assert_any_call(123456)
        mock_qobuz_client.add_favorite_track.assert_any_call(789012)
    
    def test_sync_favorites_dry_run(
        self,
        favorite_sync_service,
        mock_spotify_client,
        mock_qobuz_client
    ):
        """Test favorite sync in dry-run mode."""
        spotify_tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 200000,
                'isrc': 'ISRC001'
            }
        ]
        
        mock_spotify_client.get_saved_tracks.return_value = spotify_tracks
        mock_qobuz_client.get_favorite_tracks.return_value = []
        mock_qobuz_client.search_by_isrc.return_value = {'id': 123456, 'title': 'Track 1', 'artist': 'Artist 1', 'album': 'Album 1', 'duration': 200000}
        
        stats = favorite_sync_service.sync_favorites(dry_run=True, skip_existing=True)
        
        assert stats['matched'] == 1
        # In dry run, add_favorite_track should NOT be called
        mock_qobuz_client.add_favorite_track.assert_not_called()
    
    def test_sync_favorites_skip_existing(
        self,
        favorite_sync_service,
        mock_spotify_client,
        mock_qobuz_client
    ):
        """Test favorite sync skipping already favorited tracks."""
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
                'isrc': None
            }
        ]
        
        mock_spotify_client.get_saved_tracks.return_value = spotify_tracks
        # Track 123456 is already favorited
        mock_qobuz_client.get_favorite_tracks.return_value = [123456]
        
        # First track found by ISRC (already favorited), second by metadata
        mock_qobuz_client.search_by_isrc.return_value = {'id': 123456, 'title': 'Track 1', 'artist': 'Artist 1', 'album': 'Album 1', 'duration': 200000}
        mock_qobuz_client.search_by_metadata.return_value = {'id': 789012, 'title': 'Track 2', 'artist': 'Artist 2', 'album': 'Album 2', 'duration': 180000}
        
        mock_qobuz_client.add_favorite_track.return_value = True
        
        stats = favorite_sync_service.sync_favorites(dry_run=False, skip_existing=True)
        
        assert stats['already_favorited'] == 1
        assert stats['matched'] == 1  # Only Track 2
        # Should only add Track 2 to favorites
        mock_qobuz_client.add_favorite_track.assert_called_once_with(789012)
    
    def test_sync_favorites_no_skip_existing(
        self,
        favorite_sync_service,
        mock_spotify_client,
        mock_qobuz_client
    ):
        """Test favorite sync without skipping already favorited tracks."""
        spotify_tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 200000,
                'isrc': 'ISRC001'
            }
        ]
        
        mock_spotify_client.get_saved_tracks.return_value = spotify_tracks
        mock_qobuz_client.search_by_isrc.return_value = {'id': 123456, 'title': 'Track 1', 'artist': 'Artist 1', 'album': 'Album 1', 'duration': 200000}
        mock_qobuz_client.add_favorite_track.return_value = True
        
        stats = favorite_sync_service.sync_favorites(dry_run=False, skip_existing=False)
        
        # get_favorite_tracks should not be called when skip_existing is False
        mock_qobuz_client.get_favorite_tracks.assert_not_called()
        assert stats['already_favorited'] == 0
        assert stats['matched'] == 1
        mock_qobuz_client.add_favorite_track.assert_called_once_with(123456)
    
    def test_sync_favorites_track_not_found(
        self,
        favorite_sync_service,
        mock_spotify_client,
        mock_qobuz_client
    ):
        """Test syncing when track is not found in Qobuz."""
        spotify_tracks = [
            {
                'title': 'Obscure Track',
                'artist': 'Unknown Artist',
                'album': 'Lost Album',
                'duration': 200000,
                'isrc': None
            }
        ]
        
        mock_spotify_client.get_saved_tracks.return_value = spotify_tracks
        mock_qobuz_client.get_favorite_tracks.return_value = []
        # No ISRC, and metadata search returns None
        mock_qobuz_client.search_by_metadata.return_value = None
        
        stats = favorite_sync_service.sync_favorites()
        
        assert stats['not_found'] == 1
        assert stats['matched'] == 0
        mock_qobuz_client.add_favorite_track.assert_not_called()
    
    def test_sync_favorites_add_failure(
        self,
        favorite_sync_service,
        mock_spotify_client,
        mock_qobuz_client
    ):
        """Test syncing when adding to favorites fails."""
        spotify_tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 200000,
                'isrc': 'ISRC001'
            }
        ]
        
        mock_spotify_client.get_saved_tracks.return_value = spotify_tracks
        mock_qobuz_client.get_favorite_tracks.return_value = []
        mock_qobuz_client.search_by_isrc.return_value = {'id': 123456, 'title': 'Track 1', 'artist': 'Artist 1', 'album': 'Album 1', 'duration': 200000}
        # add_favorite_track returns False (failure)
        mock_qobuz_client.add_favorite_track.return_value = False
        
        stats = favorite_sync_service.sync_favorites(dry_run=False)
        
        assert stats['failed'] == 1
        assert stats['matched'] == 0
    
    def test_sync_favorites_search_exception(
        self,
        favorite_sync_service,
        mock_spotify_client,
        mock_qobuz_client
    ):
        """Test syncing when search raises an exception."""
        spotify_tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 200000,
                'isrc': 'ISRC001'
            }
        ]
        
        mock_spotify_client.get_saved_tracks.return_value = spotify_tracks
        mock_qobuz_client.get_favorite_tracks.return_value = []
        # search_by_isrc raises exception
        mock_qobuz_client.search_by_isrc.side_effect = Exception("Search API error")
        
        stats = favorite_sync_service.sync_favorites()
        
        assert stats['failed'] == 1
        assert stats['matched'] == 0
    
    def test_sync_favorites_get_favorites_exception(
        self,
        favorite_sync_service,
        mock_spotify_client,
        mock_qobuz_client
    ):
        """Test syncing when getting existing favorites fails."""
        spotify_tracks = [
            {
                'title': 'Track 1',
                'artist': 'Artist 1',
                'album': 'Album 1',
                'duration': 200000,
                'isrc': 'ISRC001'
            }
        ]
        
        mock_spotify_client.get_saved_tracks.return_value = spotify_tracks
        # get_favorite_tracks raises exception
        mock_qobuz_client.get_favorite_tracks.side_effect = Exception("API error")
        mock_qobuz_client.search_track.return_value = []
        
        # Should handle exception gracefully and continue without duplicate check
        stats = favorite_sync_service.sync_favorites(skip_existing=True)
        
        # Should proceed with sync despite error getting existing favorites
        assert stats['total_spotify_favorites'] == 1
