"""Credentials parser for reading credentials from credentials.md file."""

import os
import re
from typing import Dict


class CredentialsError(Exception):
    """Exception raised when credentials cannot be parsed."""
    pass


def parse_credentials(credentials_path: str = "credentials.md") -> Dict[str, str]:
    """
    Parse credentials from credentials.md file.
    
    Args:
        credentials_path: Path to the credentials file (default: credentials.md)
    
    Returns:
        Dictionary containing credentials with keys:
        - SPOTIFY_CLIENT_ID
        - SPOTIFY_CLIENT_SECRET
        - SPOTIFY_REDIRECT_URI
        - QOBUZ_USER_AUTH_TOKEN
    
    Raises:
        CredentialsError: If file not found or required credentials are missing
    """
    if not os.path.exists(credentials_path):
        raise CredentialsError(f"Credentials file not found: {credentials_path}")
    
    with open(credentials_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    credentials = {}
    
    # Define required credentials
    required_keys = [
        'SPOTIFY_CLIENT_ID',
        'SPOTIFY_CLIENT_SECRET',
        'SPOTIFY_REDIRECT_URI',
        'QOBUZ_USER_AUTH_TOKEN'
    ]
    
    # Parse key=value pairs
    pattern = r'([A-Z_]+)=(.+)'
    matches = re.findall(pattern, content)
    
    for key, value in matches:
        credentials[key] = value.strip()
    
    # Check all required credentials are present
    missing_keys = [key for key in required_keys if key not in credentials]
    if missing_keys:
        raise CredentialsError(
            f"Missing required credentials: {', '.join(missing_keys)}"
        )
    
    return credentials
