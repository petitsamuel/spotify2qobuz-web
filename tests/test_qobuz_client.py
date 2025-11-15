"""Unit tests for Qobuz client."""

import pytest
from unittest.mock import Mock, patch, MagicMock
import requests
from src.qobuz_client import QobuzClient


@pytest.fixture
def qobuz_client():
    """Create a Qobuz client instance."""
    return QobuzClient(user_auth_token="test_token_123")


@pytest.fixture
def authenticated_client(qobuz_client):
    """Create an authenticated Qobuz client."""
    qobuz_client.user_id = 12345
    qobuz_client.user_name = "Test User"
    return qobuz_client


class TestQobuzClient:
    """Test cases for QobuzClient."""
    
    def test_init(self, qobuz_client):
        """Test client initialization."""
        assert qobuz_client.user_auth_token == "test_token_123"
        assert qobuz_client.user_id is None
        assert qobuz_client.user_name is None
        assert qobuz_client._session is not None
        assert qobuz_client._session.headers["X-User-Auth-Token"] == "test_token_123"
    
    def test_authenticate_success(self, qobuz_client):
        """Test successful authentication."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'user': {
                'id': 12345,
                'display_name': 'Test User'
            }
        }
        
        with patch.object(qobuz_client._session, 'get', return_value=mock_response):
            qobuz_client.authenticate()
        
        assert qobuz_client.user_id == 12345
        assert qobuz_client.user_name == 'Test User'
    
    def test_authenticate_failure(self, qobuz_client):
        """Test authentication failure."""
        mock_response = Mock()
        mock_response.status_code = 401
        mock_response.text = "Invalid token"
        
        with patch.object(qobuz_client._session, 'get', return_value=mock_response):
            with pytest.raises(Exception, match="Invalid or expired Qobuz token"):
                qobuz_client.authenticate()
    
    def test_make_request_success(self, authenticated_client):
        """Test successful API request."""
        mock_response = Mock()
        mock_response.json.return_value = {'result': 'success'}
        
        with patch.object(authenticated_client._session, 'get', return_value=mock_response):
            result = authenticated_client._make_request('test/endpoint', {'param': 'value'})
        
        assert result == {'result': 'success'}
    
    def test_make_request_failure(self, authenticated_client):
        """Test failed API request."""
        with patch.object(authenticated_client._session, 'get', side_effect=requests.exceptions.RequestException("Request failed")):
            with pytest.raises(Exception, match="Qobuz API request failed"):
                authenticated_client._make_request('test/endpoint')
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_isrc_found(self, mock_request, authenticated_client):
        """Test successful ISRC search."""
        mock_request.return_value = {
            'tracks': {
                'total': 1,
                'items': [
                    {
                        'id': 12345,
                        'title': 'Test Track',
                        'isrc': 'USRC17607839',
                        'performer': {'name': 'Test Artist'},
                        'album': {'title': 'Test Album'},
                        'duration': 180
                    }
                ]
            }
        }
        
        result = authenticated_client.search_by_isrc('USRC17607839')
        
        assert result is not None
        assert result['id'] == 12345
        assert result['title'] == 'Test Track'
        assert result['artist'] == 'Test Artist'
        assert result['album'] == 'Test Album'
        assert result['duration'] == 180000  # Converted to ms
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_isrc_not_found(self, mock_request, authenticated_client):
        """Test ISRC search with no results."""
        mock_request.return_value = {
            'tracks': {
                'total': 0,
                'items': []
            }
        }
        
        result = authenticated_client.search_by_isrc('INVALID')
        
        assert result is None
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_isrc_case_insensitive(self, mock_request, authenticated_client):
        """Test ISRC search is case insensitive."""
        mock_request.return_value = {
            'tracks': {
                'total': 1,
                'items': [
                    {
                        'id': 12345,
                        'title': 'Test Track',
                        'isrc': 'usrc17607839',
                        'performer': {'name': 'Test Artist'},
                        'album': {'title': 'Test Album'},
                        'duration': 180
                    }
                ]
            }
        }
        
        result = authenticated_client.search_by_isrc('USRC17607839')
        
        assert result is not None
        assert result['id'] == 12345
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_metadata_found(self, mock_request, authenticated_client):
        """Test successful metadata search."""
        mock_request.return_value = {
            'tracks': {
                'total': 1,
                'items': [
                    {
                        'id': 12345,
                        'title': 'Test Track',
                        'performer': {'name': 'Test Artist'},
                        'album': {'title': 'Test Album'},
                        'duration': 180
                    }
                ]
            }
        }
        
        result = authenticated_client.search_by_metadata('Test Track', 'Test Artist', 180000)
        
        assert result is not None
        assert result['id'] == 12345
        assert result['title'] == 'Test Track'
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_metadata_not_found(self, mock_request, authenticated_client):
        """Test metadata search with no results."""
        mock_request.return_value = {
            'tracks': {
                'total': 0,
                'items': []
            }
        }
        
        result = authenticated_client.search_by_metadata('Unknown', 'Unknown', 0)
        
        assert result is None
    
    def test_create_playlist_success(self, authenticated_client):
        """Test successful playlist creation."""
        mock_response = Mock()
        mock_response.json.return_value = {
            'id': 67890,
            'name': 'Test Playlist'
        }
        
        with patch.object(authenticated_client._session, 'post', return_value=mock_response):
            playlist_id = authenticated_client.create_playlist('Test Playlist', 'Test Description')
        
        assert playlist_id == '67890'
    
    def test_create_playlist_failure(self, authenticated_client):
        """Test failed playlist creation."""
        with patch.object(authenticated_client._session, 'post', side_effect=Exception("Creation failed")):
            result = authenticated_client.create_playlist('Test Playlist')
        
        assert result is None
    
    def test_add_track_success(self, authenticated_client):
        """Test successful track addition."""
        mock_response = Mock()
        
        with patch.object(authenticated_client._session, 'post', return_value=mock_response):
            result = authenticated_client.add_track('playlist_123', 456)
        
        assert result is True
    
    def test_add_track_failure(self, authenticated_client):
        """Test failed track addition."""
        with patch.object(authenticated_client._session, 'post', side_effect=Exception("Add failed")):
            result = authenticated_client.add_track('playlist_123', 456)
        
        assert result is False
    
    @patch.object(QobuzClient, '_make_request')
    def test_get_playlist_success(self, mock_request, authenticated_client):
        """Test successful playlist retrieval."""
        mock_request.return_value = {
            'id': 123,
            'name': 'Test Playlist'
        }
        
        result = authenticated_client.get_playlist('123')
        
        assert result is not None
        assert result['id'] == 123
    
    @patch.object(QobuzClient, '_make_request')
    def test_get_playlist_failure(self, mock_request, authenticated_client):
        """Test failed playlist retrieval."""
        mock_request.side_effect = Exception("Get failed")
        
        result = authenticated_client.get_playlist('123')
        
        assert result is None
    
    def test_authenticate_missing_user_data(self, qobuz_client):
        """Test authentication with missing user data in response."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'status': 'success'
            # Missing 'user' key
        }
        
        with patch.object(qobuz_client._session, 'get', return_value=mock_response):
            qobuz_client.authenticate()
        
        # Should use defaults when user data is missing
        assert qobuz_client.user_id == 1
        assert qobuz_client.user_name == "Qobuz User"
    
    def test_authenticate_network_error(self, qobuz_client):
        """Test authentication with network error."""
        with patch.object(qobuz_client._session, 'get', side_effect=requests.exceptions.ConnectionError("Network error")):
            with pytest.raises(Exception, match="Qobuz authentication failed"):
                qobuz_client.authenticate()
    
    def test_make_request_not_authenticated(self, qobuz_client):
        """Test making request without authentication."""
        # qobuz_client is not authenticated (user_auth_token exists but user_id is None)
        # Reset token to test the error
        qobuz_client.user_auth_token = None
        
        with pytest.raises(Exception, match="Not authenticated"):
            qobuz_client._make_request('test/endpoint')
    
    def test_make_request_post_method(self, authenticated_client):
        """Test POST request method."""
        mock_response = Mock()
        mock_response.json.return_value = {'result': 'success'}
        
        with patch.object(authenticated_client._session, 'post', return_value=mock_response) as mock_post:
            result = authenticated_client._make_request('test/endpoint', {'data': 'value'}, method='POST')
        
        assert result == {'result': 'success'}
        mock_post.assert_called_once()
    
    def test_make_request_with_response_error_details(self, authenticated_client):
        """Test request failure with response details logged."""
        mock_response = Mock()
        mock_response.text = "Detailed error message"
        error = requests.exceptions.HTTPError("HTTP Error")
        error.response = mock_response
        
        with patch.object(authenticated_client._session, 'get', side_effect=error):
            with pytest.raises(Exception, match="Qobuz API request failed"):
                authenticated_client._make_request('test/endpoint')
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_isrc_exception(self, mock_request, authenticated_client):
        """Test ISRC search with exception."""
        # Simulate exception during API request
        mock_request.side_effect = Exception("Search failed")
        
        result = authenticated_client.search_by_isrc('USRC17607839')
        
        assert result is None
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_isrc_no_exact_match(self, mock_request, authenticated_client):
        """Test ISRC search with no exact ISRC match in results."""
        mock_request.return_value = {
            'tracks': {
                'total': 1,
                'items': [
                    {
                        'id': 12345,
                        'title': 'Test Track',
                        'isrc': 'DIFFERENT123',  # Different ISRC
                        'performer': {'name': 'Test Artist'},
                        'album': {'title': 'Test Album'},
                        'duration': 180
                    }
                ]
            }
        }
        
        result = authenticated_client.search_by_isrc('USRC17607839')
        
        assert result is None
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_metadata_exception(self, mock_request, authenticated_client):
        """Test metadata search with exception."""
        # Simulate exception during API request
        mock_request.side_effect = Exception("Search failed")
        
        result = authenticated_client.search_by_metadata('Test', 'Artist', 180000)
        
        assert result is None
    
    @patch.object(QobuzClient, '_make_request')
    def test_search_by_metadata_empty_items(self, mock_request, authenticated_client):
        """Test metadata search with empty items despite non-zero total."""
        mock_request.return_value = {
            'tracks': {
                'total': 1,
                'items': []  # Empty items list
            }
        }
        
        result = authenticated_client.search_by_metadata('Test', 'Artist', 180000)
        
        assert result is None
    
    def test_create_playlist_with_response_error(self, authenticated_client):
        """Test playlist creation with response error details."""
        mock_response = Mock()
        mock_response.text = "Detailed creation error"
        error = requests.exceptions.HTTPError("Creation error")
        error.response = mock_response
        
        with patch.object(authenticated_client._session, 'post', side_effect=error):
            result = authenticated_client.create_playlist('Test Playlist')
        
        assert result is None
