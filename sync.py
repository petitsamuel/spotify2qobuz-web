#!/usr/bin/env python3
"""
Spotify to Qobuz Playlist Sync

Safe re-run script that won't create duplicates.
"""

import sys
from src.sync_service import SyncService

def main():
    print("=" * 70)
    print("Spotify to Qobuz Playlist Sync")
    print("=" * 70)
    print()
    print("This script will:")
    print("✓ Find existing playlists in Qobuz")
    print("✓ Add only NEW tracks (skip duplicates)")
    print("✓ Create playlists that don't exist yet")
    print()
    
    # Ask for confirmation
    response = input("Start sync? (yes/no): ").strip().lower()
    if response not in ['yes', 'y']:
        print("Sync cancelled.")
        return
    
    print()
    print("Starting sync...")
    print()
    
    try:
        # Initialize service
        service = SyncService()
        
        # Load credentials and authenticate
        credentials = service.load_credentials()
        service.authenticate_clients(credentials)
        
        # Sync playlists with update_existing=True (default)
        # This prevents duplicates!
        service.sync_all_playlists(
            dry_run=False,
            update_existing=True  # This is the key: updates existing playlists
        )
        
        print()
        print("=" * 70)
        print("Sync completed successfully!")
        print("=" * 70)
        
    except KeyboardInterrupt:
        print("\n\nSync interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\nSync failed: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
