"""Unit tests for credentials parser."""

import pytest
import tempfile
import os
from src.utils.credentials import parse_credentials, CredentialsError


class TestCredentialsParser:
    """Test cases for credentials parser."""
    
    def test_parse_credentials_success(self):
        """Test successful parsing of credentials file."""
        content = """
## Spotify
SPOTIFY_CLIENT_ID=test_id_123
SPOTIFY_CLIENT_SECRET=test_secret_456
SPOTIFY_REDIRECT_URI=http://localhost:8888/callback

## Qobuz
QOBUZ_USER_AUTH_TOKEN=test_token_abc123def456
"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.md') as f:
            f.write(content)
            temp_path = f.name
        
        try:
            creds = parse_credentials(temp_path)
            
            assert creds['SPOTIFY_CLIENT_ID'] == 'test_id_123'
            assert creds['SPOTIFY_CLIENT_SECRET'] == 'test_secret_456'
            assert creds['SPOTIFY_REDIRECT_URI'] == 'http://localhost:8888/callback'
            assert creds['QOBUZ_USER_AUTH_TOKEN'] == 'test_token_abc123def456'
        finally:
            os.unlink(temp_path)
    
    def test_parse_credentials_file_not_found(self):
        """Test error when credentials file doesn't exist."""
        with pytest.raises(CredentialsError, match="Credentials file not found"):
            parse_credentials('nonexistent_file.md')
    
    def test_parse_credentials_missing_keys(self):
        """Test error when required credentials are missing."""
        content = """
## Spotify
SPOTIFY_CLIENT_ID=test_id_123
SPOTIFY_CLIENT_SECRET=test_secret_456
"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.md') as f:
            f.write(content)
            temp_path = f.name
        
        try:
            with pytest.raises(CredentialsError, match="Missing required credentials"):
                parse_credentials(temp_path)
        finally:
            os.unlink(temp_path)
    
    def test_parse_credentials_with_spaces(self):
        """Test parsing credentials with spaces in values."""
        content = """
## Spotify
SPOTIFY_CLIENT_ID=  test_id_123  
SPOTIFY_CLIENT_SECRET=test_secret_456
SPOTIFY_REDIRECT_URI=http://localhost:8888/callback

## Qobuz
QOBUZ_USER_AUTH_TOKEN=test_token_abc123def456
"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.md') as f:
            f.write(content)
            temp_path = f.name
        
        try:
            creds = parse_credentials(temp_path)
            # Should strip spaces
            assert creds['SPOTIFY_CLIENT_ID'] == 'test_id_123'
        finally:
            os.unlink(temp_path)
