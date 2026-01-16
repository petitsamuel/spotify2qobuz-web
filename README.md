# Spotify to Qobuz Migration

Migrate your playlists and saved songs from Spotify to Qobuz with a web interface.

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/petitsamuel/spotify2qobuz-web.git
cd spotify2qobuz-web
pip install -r requirements.txt
```

### 2. Set up Spotify credentials

Create a Spotify app at https://developer.spotify.com/dashboard:
1. Click "Create App"
2. Set redirect URI to `http://127.0.0.1:8000/auth/spotify/callback`
3. Copy your Client ID and Client Secret

```bash
cp .env.example .env
```

Edit `.env`:
```
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8000/auth/spotify/callback
```

### 3. Run the web server

```bash
python run_web.py
```

Open http://127.0.0.1:8000

### 4. Connect your accounts

**Spotify:** Click "Connect Spotify" and authorize the app.

**Qobuz:** Click "Connect Qobuz" and follow the instructions to get your token:
1. Open https://play.qobuz.com and log in
2. Open DevTools (F12) → Network tab
3. Play any song or click around
4. Filter by `api.json` and click any request
5. In Headers, find `X-User-Auth-Token` and copy the value
6. Paste it in the web interface

### 5. Sync!

Once both accounts are connected:
- **Sync All Playlists** - transfers all your Spotify playlists to Qobuz
- **Sync Saved Tracks** - transfers your liked songs to Qobuz favorites

Watch the real-time progress and match rate as it syncs.

## Features

- OAuth login for Spotify
- Real-time sync progress with live stats
- Match rate tracking (ISRC + fuzzy matching)
- Duplicate prevention (safe to run multiple times)
- Migration history

## Tech Stack

- FastAPI + Jinja2
- Tailwind CSS + Alpine.js
- SQLite for storage
- Spotipy for Spotify API
- RapidFuzz for track matching

## License

MIT
