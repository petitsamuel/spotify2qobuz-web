# Spotify to Qobuz Migration

Migrate your playlists and saved songs from Spotify to Qobuz with a modern web interface.

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/petitsamuel/spotify2qobuz-web.git
cd spotify2qobuz-web
npm install
```

### 2. Set up environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```dotenv
DATABASE_URL=postgresql://user:password@host:5432/database?sslmode=require
ENCRYPTION_KEY=your-32-byte-hex-encryption-key-here
SPOTIFY_CLIENT_ID=your-spotify-client-id
SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
```

**Spotify App Setup:**
1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click "Create App"
3. Set redirect URI to your deployment URL + `/api/auth/spotify/callback`
4. Copy your Client ID and Client Secret

### 3. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 4. Connect your accounts

**Spotify:** Click "Connect Spotify" and authorize the app.

**Qobuz:** Click "Connect Qobuz" and follow the instructions to get your token:
1. Open [Qobuz Web Player](https://play.qobuz.com) and log in
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

- Next.js 16 + React 19
- Tailwind CSS
- Radix UI components
- TanStack Query
- Neon PostgreSQL (serverless)

## Deployment

Deploy to Vercel:

```bash
npm run build
```

Or use the Vercel CLI / dashboard for automatic deployments.

## License

MIT
