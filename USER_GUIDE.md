# User Guide: Spotify to Qobuz Sync

## Welcome! 👋

This guide will help you sync your Spotify playlists to Qobuz. The entire process takes about 10-15 minutes to set up, then syncing is automatic!

## Table of Contents

1. [Initial Setup](#initial-setup)
2. [Running Your First Sync](#running-your-first-sync)
3. [Running Again (Updates)](#running-again-updates)
4. [Understanding the Results](#understanding-the-results)
5. [FAQ](#faq)

---

## Initial Setup

### Step 1: Install Python Dependencies

```bash
pip install -r requirements.txt
```

### Step 2: Get Spotify Credentials

1. Go to https://developer.spotify.com/dashboard
2. Click "Create app"
3. Fill in:
   - **App name:** Spotify to Qobuz Sync
   - **App description:** Personal playlist sync
   - **Redirect URI:** `http://127.0.0.1:8888/callback` ⚠️ **IMPORTANT!**
4. Save and copy:
   - **Client ID**
   - **Client Secret**

### Step 3: Get Qobuz Token (Easy HAR Method)

**Why HAR files?** They capture all browser network activity, making it easy to extract your authentication token without hunting through cookies.

#### How to Create a HAR File:

1. **Open Qobuz Web Player**
   - Go to https://play.qobuz.com
   - Log in with your account (Google login works!)

2. **Open Browser DevTools**
   - **Mac:** Press `Cmd+Option+I`
   - **Windows/Linux:** Press `F12`

3. **Go to Network Tab**
   - Click the **Network** tab at the top
   - ✅ Check "Preserve log" (important!)

4. **Generate Activity**
   - Play any song, or
   - Browse your playlists, or
   - Click around the interface

5. **Export HAR File**
   - Right-click anywhere in the Network request list
   - Select **"Save all as HAR with content"** or **"Export HAR..."**
   - Save the file as `qobuz.har` in your project folder

6. **Extract Your Token**
   ```bash
   python extract_token_from_har.py qobuz.har
   ```
   
   You'll see:
   ```
   ✅ Found token: As82Us_r_tSs4C4_NNVm7w...
   ```

7. **Copy the token** - it's the long string after "Found token:"

### Step 4: Update credentials.md

Edit `credentials.md` and fill in your values:

```markdown
## Spotify
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback

## Qobuz
QOBUZ_USER_AUTH_TOKEN=your_long_token_here
```

### Step 5: Test Everything

```bash
# Test Qobuz token
python test_token.py
```

Expected output:
```
✅ Token is VALID!
   User: Your Name
   User ID: 1234567

You can run the sync without getting a new token.
```

If you see ❌ errors, go back to Step 3.

---

## Running Your First Sync

### Option 1: Interactive Script (Recommended for beginners)

```bash
python sync.py
```

This will:
- Show you what it's about to do
- Ask for confirmation
- Start the sync

### Option 2: Direct Command

```bash
# Test mode first (dry run - no changes made)
python -m src.sync_service --dry-run true

# When ready, run for real
python -m src.sync_service
```

### What Happens During Sync

1. **Authenticates** with Spotify (browser opens, you approve)
2. **Lists all playlists** from your Spotify account
3. **For each playlist:**
   - Fetches all tracks
   - Searches Qobuz for each track (ISRC code first, then fuzzy match)
   - Creates playlist in Qobuz: "Playlist Name (from Spotify)"
   - Adds all matched tracks
4. **Generates report:**
   - Log file: `sync_logs/sync_YYYYMMDD_HHMMSS.log`
   - JSON report: `sync_report_YYYYMMDD_HHMMSS.json`

### How Long Does It Take?

- **121 playlists:** ~1.5 hours
- **10 playlists:** ~10-15 minutes
- **1 playlist:** ~1 minute

The sync processes each track individually for accuracy.

---

## Running Again (Updates)

**Great news: You can run the sync as many times as you want!** 🎉

### No Duplicates!

The sync is smart:
- ✅ Finds existing playlists in Qobuz
- ✅ Checks which tracks are already there
- ✅ Only adds NEW tracks
- ✅ Skips duplicates

### When to Run Again

- **Added songs to Spotify playlists** → Run sync to add them to Qobuz
- **Created new Spotify playlists** → Run sync to create them in Qobuz
- **Weekly/monthly update** → Keep Qobuz in sync with Spotify

### How to Run Again

Just run the same command:

```bash
python sync.py
```

Example output:
```
Found existing playlist with 39 tracks, will add missing tracks only
Playlist sync complete: 80s - 40/43 tracks matched, 35 already in playlist
```

This means:
- Playlist "80s (from Spotify)" already existed
- Had 39 tracks
- Found 40 matching tracks total in Spotify
- **35 were already there** (skipped)
- **5 new tracks added**

---

## Understanding the Results

### Match Rate

Expect **85-90% match rate** on most playlists.

**Why not 100%?**
- Some tracks don't exist in Qobuz's catalog
- Some tracks are different versions (remasters, etc.)
- Regional availability differences

### Log Files

Location: `sync_logs/sync_YYYYMMDD_HHMMSS.log`

Shows:
- Each playlist processed
- Each track match (ISRC or fuzzy)
- Tracks not found
- Any errors

### JSON Reports

Location: `sync_report_YYYYMMDD_HHMMSS.json`

Contains:
```json
{
  "playlists_synced": 121,
  "tracks_matched": 5016,
  "tracks_not_matched": 604,
  "isrc_matches": 4847,
  "fuzzy_matches": 169,
  "missing_tracks": {
    "Playlist Name": [
      {
        "title": "Song Title",
        "artist": "Artist Name",
        "album": "Album Name"
      }
    ]
  }
}
```

---

## FAQ

### Q: Do I need a new token each time I sync?

**A: No!** Tokens typically last days to weeks. Test it before syncing:

```bash
python test_token.py
```

### Q: What if my token expires?

**A:** You'll see an error. Just get a new one using the HAR file method (takes 2 minutes).

### Q: Can I sync specific playlists only?

**A:** Not yet. The tool syncs all playlists. You can delete unwanted ones from Qobuz after.

### Q: What if I accidentally created duplicate playlists?

**A:** 
1. Manually delete the duplicates in Qobuz web player
2. Next sync will update the remaining playlists (won't create more duplicates)

### Q: Why do some tracks not match?

**A:** 
- Not available in Qobuz's catalog
- Different version/edition
- Regional restrictions
- Check `sync_report_*.json` for the "missing_tracks" list

### Q: Can I interrupt the sync?

**A:** Yes, press `Ctrl+C`. You can run it again later - it will resume from scratch but won't create duplicates.

### Q: Where are my playlists in Qobuz?

**A:** Go to https://play.qobuz.com → Playlists. They'll have "(from Spotify)" at the end.

### Q: How do I sync only new songs?

**A:** Just run `python sync.py` again. It automatically detects existing playlists and adds only new tracks.

### Q: The Spotify browser didn't open?

**A:** The redirect URI might be wrong. Make sure it's exactly:
```
http://127.0.0.1:8888/callback
```
(Use `127.0.0.1` not `localhost`)

### Q: Can I run this automatically (cron job)?

**A:** Yes! But you'll need to handle Spotify OAuth token refresh. The current version requires browser authentication.

---

## Need Help?

1. **Check the logs:** `sync_logs/sync_*.log`
2. **Test your token:** `python test_token.py`
3. **Read detailed docs:**
   - [GET_TOKEN_INSTRUCTIONS.md](GET_TOKEN_INSTRUCTIONS.md)
   - [DUPLICATE_PREVENTION.md](DUPLICATE_PREVENTION.md)
4. **Run in test mode:** `python -m src.sync_service --dry-run true`

---

**Happy syncing! Your playlists are waiting in Qobuz! 🎵**
