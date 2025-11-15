"""Unit tests for track matcher."""

import pytest
from unittest.mock import Mock, MagicMock
from src.matcher import TrackMatcher, MatchResult
from src.qobuz_client import QobuzClient


@pytest.fixture
def mock_qobuz_client():
    """Create a mock Qobuz client."""
    return Mock(spec=QobuzClient)


@pytest.fixture
def matcher(mock_qobuz_client):
    """Create a TrackMatcher instance."""
    return TrackMatcher(mock_qobuz_client)


@pytest.fixture
def spotify_track():
    """Create a sample Spotify track."""
    return {
        'title': 'Test Track',
        'artist': 'Test Artist',
        'album': 'Test Album',
        'duration': 180000,
        'isrc': 'USRC17607839'
    }


@pytest.fixture
def qobuz_track():
    """Create a sample Qobuz track."""
    return {
        'id': 12345,
        'title': 'Test Track',
        'artist': 'Test Artist',
        'album': 'Test Album',
        'duration': 180000
    }


class TestMatchResult:
    """Test cases for MatchResult."""
    
    def test_init(self, qobuz_track):
        """Test MatchResult initialization."""
        result = MatchResult(
            qobuz_track=qobuz_track,
            match_type='isrc',
            score=100.0
        )
        
        assert result.qobuz_track == qobuz_track
        assert result.match_type == 'isrc'
        assert result.score == 100.0
    
    def test_repr(self, qobuz_track):
        """Test MatchResult string representation."""
        result = MatchResult(
            qobuz_track=qobuz_track,
            match_type='fuzzy',
            score=85.5
        )
        
        assert 'fuzzy' in repr(result)
        assert '85.5' in repr(result)


class TestTrackMatcher:
    """Test cases for TrackMatcher."""
    
    def test_init(self, matcher, mock_qobuz_client):
        """Test TrackMatcher initialization."""
        assert matcher.qobuz_client == mock_qobuz_client
    
    def test_match_track_by_isrc(self, matcher, mock_qobuz_client, spotify_track, qobuz_track):
        """Test track matching using ISRC."""
        mock_qobuz_client.search_by_isrc.return_value = qobuz_track
        
        result = matcher.match_track(spotify_track)
        
        assert result is not None
        assert result.match_type == 'isrc'
        assert result.score == 100.0
        assert result.qobuz_track == qobuz_track
        mock_qobuz_client.search_by_isrc.assert_called_once_with('USRC17607839')
    
    def test_match_track_by_fuzzy_when_isrc_fails(
        self, matcher, mock_qobuz_client, spotify_track, qobuz_track
    ):
        """Test fallback to fuzzy matching when ISRC fails."""
        mock_qobuz_client.search_by_isrc.return_value = None
        mock_qobuz_client.search_by_metadata.return_value = qobuz_track
        
        result = matcher.match_track(spotify_track)
        
        assert result is not None
        assert result.match_type == 'fuzzy'
        mock_qobuz_client.search_by_isrc.assert_called_once()
        mock_qobuz_client.search_by_metadata.assert_called_once()
    
    def test_match_track_no_isrc(self, matcher, mock_qobuz_client, qobuz_track):
        """Test track matching when no ISRC is available."""
        spotify_track_no_isrc = {
            'title': 'Test Track',
            'artist': 'Test Artist',
            'album': 'Test Album',
            'duration': 180000,
            'isrc': None
        }
        mock_qobuz_client.search_by_metadata.return_value = qobuz_track
        
        result = matcher.match_track(spotify_track_no_isrc)
        
        assert result is not None
        assert result.match_type == 'fuzzy'
        mock_qobuz_client.search_by_isrc.assert_not_called()
        mock_qobuz_client.search_by_metadata.assert_called_once()
    
    def test_match_track_no_match(self, matcher, mock_qobuz_client, spotify_track):
        """Test when no match is found."""
        mock_qobuz_client.search_by_isrc.return_value = None
        mock_qobuz_client.search_by_metadata.return_value = None
        
        result = matcher.match_track(spotify_track)
        
        assert result is None
    
    def test_match_by_isrc_success(self, matcher, mock_qobuz_client, spotify_track, qobuz_track):
        """Test ISRC matching success."""
        mock_qobuz_client.search_by_isrc.return_value = qobuz_track
        
        result = matcher._match_by_isrc(spotify_track)
        
        assert result is not None
        assert result.match_type == 'isrc'
        assert result.score == 100.0
    
    def test_match_by_isrc_no_match(self, matcher, mock_qobuz_client, spotify_track):
        """Test ISRC matching with no result."""
        mock_qobuz_client.search_by_isrc.return_value = None
        
        result = matcher._match_by_isrc(spotify_track)
        
        assert result is None
    
    def test_match_by_fuzzy_exact_match(self, matcher, mock_qobuz_client, spotify_track, qobuz_track):
        """Test fuzzy matching with exact match."""
        mock_qobuz_client.search_by_metadata.return_value = qobuz_track
        
        result = matcher._match_by_fuzzy(spotify_track)
        
        assert result is not None
        assert result.match_type == 'fuzzy'
        assert result.score == 100.0
    
    def test_match_by_fuzzy_good_match(self, matcher, mock_qobuz_client, spotify_track):
        """Test fuzzy matching with good similarity score."""
        similar_track = {
            'id': 12345,
            'title': 'Test Track',  # Same title to pass threshold
            'artist': 'Test Artist',
            'album': 'Test Album',
            'duration': 181000  # Within tolerance
        }
        mock_qobuz_client.search_by_metadata.return_value = similar_track
        
        result = matcher._match_by_fuzzy(spotify_track)
        
        assert result is not None
        assert result.match_type == 'fuzzy'
        assert result.score >= matcher.MIN_COMBINED_SCORE
    
    def test_match_by_fuzzy_title_too_different(self, matcher, mock_qobuz_client, spotify_track):
        """Test fuzzy matching fails when title is too different."""
        different_track = {
            'id': 12345,
            'title': 'Completely Different Title',
            'artist': 'Test Artist',
            'album': 'Test Album',
            'duration': 180000
        }
        mock_qobuz_client.search_by_metadata.return_value = different_track
        
        result = matcher._match_by_fuzzy(spotify_track)
        
        assert result is None
    
    def test_match_by_fuzzy_artist_too_different(self, matcher, mock_qobuz_client, spotify_track):
        """Test fuzzy matching fails when artist is too different."""
        different_track = {
            'id': 12345,
            'title': 'Test Track',
            'artist': 'Completely Different Artist',
            'album': 'Test Album',
            'duration': 180000
        }
        mock_qobuz_client.search_by_metadata.return_value = different_track
        
        result = matcher._match_by_fuzzy(spotify_track)
        
        assert result is None
    
    def test_match_by_fuzzy_duration_too_different(self, matcher, mock_qobuz_client, spotify_track):
        """Test fuzzy matching fails when duration is too different."""
        different_track = {
            'id': 12345,
            'title': 'Test Track',
            'artist': 'Test Artist',
            'album': 'Test Album',
            'duration': 240000  # 60 seconds difference
        }
        mock_qobuz_client.search_by_metadata.return_value = different_track
        
        result = matcher._match_by_fuzzy(spotify_track)
        
        assert result is None
    
    def test_match_by_fuzzy_no_results(self, matcher, mock_qobuz_client, spotify_track):
        """Test fuzzy matching when no results are returned."""
        mock_qobuz_client.search_by_metadata.return_value = None
        
        result = matcher._match_by_fuzzy(spotify_track)
        
        assert result is None
    
    def test_normalize_string(self, matcher):
        """Test string normalization."""
        assert matcher._normalize_string("Test String") == "test string"
        assert matcher._normalize_string("  Spaces  ") == "spaces"
        assert matcher._normalize_string("MixedCase") == "mixedcase"
    
    def test_thresholds(self, matcher):
        """Test that thresholds are set correctly."""
        assert matcher.TITLE_THRESHOLD == 80
        assert matcher.ARTIST_THRESHOLD == 75
        assert matcher.DURATION_TOLERANCE_MS == 5000
        assert matcher.MIN_COMBINED_SCORE == 75
