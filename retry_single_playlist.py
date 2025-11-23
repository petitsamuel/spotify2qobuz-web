#!/usr/bin/env python3
"""Script to retry syncing a single playlist."""

import sys
from src.sync_service import SyncService
from src.utils.logger import get_logger

def main():
    if len(sys.argv) < 2:
        print("Usage: python retry_single_playlist.py <playlist_name>")
        sys.exit(1)
    
    playlist_name = sys.argv[1]
    logger = get_logger()
    
    print(f"Retrying sync for playlist: {playlist_name}")
    
    # Initialize sync
    sync_service = SyncService('credentials.md')
    
    # Load credentials and authenticate
    try:
        credentials = sync_service.load_credentials()
        if not credentials:
            print("❌ Failed to load credentials")
            sys.exit(1)
        
        sync_service.authenticate_clients(credentials)
    except Exception as e:
        print(f"❌ Authentication failed: {e}")
        sys.exit(1)
    
    # Get all playlists
    playlists = sync_service.spotify_client.list_playlists()
    logger.info(f'Retrieved {len(playlists)} playlists from Spotify')
    
    # Find target playlist
    target = [p for p in playlists if p['name'] == playlist_name]
    
    if not target:
        print(f'❌ Playlist "{playlist_name}" not found')
        print(f'Available playlists: {[p["name"] for p in playlists[:5]]}...')
        sys.exit(1)
    
    playlist = target[0]
    print(f'✅ Found playlist: {playlist["name"]} ({playlist["tracks_count"]} tracks)')
    
    # Sync the playlist
    try:
        sync_service.sync_playlist(playlist)
        print(f'✅ Sync completed successfully for {playlist_name}!')
    except Exception as e:
        print(f'❌ Error syncing playlist: {str(e)}')
        logger.error(f'Error syncing playlist {playlist_name}: {str(e)}')
        sys.exit(1)

if __name__ == '__main__':
    main()
