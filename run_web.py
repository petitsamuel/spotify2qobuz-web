#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Launch the Spotify to Qobuz web interface."""

import os
import sys


def main():
    # Load environment variables
    from dotenv import load_dotenv
    load_dotenv()

    # Check for required environment variables
    if not os.environ.get('SPOTIFY_CLIENT_ID'):
        print("Warning: SPOTIFY_CLIENT_ID not set")
        print("Copy .env.example to .env and fill in your Spotify credentials")
        print()

    # Start the server
    import uvicorn
    uvicorn.run(
        "web.main:app",
        host="127.0.0.1",
        port=8000,
        reload=True
    )


if __name__ == "__main__":
    main()
