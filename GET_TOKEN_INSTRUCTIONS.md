# How to Get Your Qobuz Session Token

This project uses **token-based authentication** instead of app_id/password to avoid API restrictions and support Google login accounts.

## Quick Start (Recommended: HAR File Method)

### Method 1: Export HAR File (Easiest!)

This is the easiest method - let the browser capture everything automatically.

1. **Open Qobuz Web Player**
   - Go to https://play.qobuz.com and login

2. **Open DevTools Network Tab**
   - Press `Cmd+Option+I` (Mac) or `F12` (Windows/Linux)
   - Click the **Network** tab
   - Make sure "Preserve log" is checked ✅

3. **Generate Activity**
   - Play a song, browse playlists, or click around
   - You'll see network requests appearing

4. **Export HAR File**
   - Right-click anywhere in the Network tab request list
   - Select **"Save all as HAR with content"** or **"Export HAR"**
   - Save as `qobuz.har` in your project folder

5. **Extract Token**
   ```bash
   python extract_token_from_har.py qobuz.har
   ```
   
   The script will automatically find and extract your token!

6. **Copy to credentials.md**
   - The script will show you the token
   - Copy it to your `credentials.md` file

### Method 2: Manual Browser Cookie (Traditional)

## Step-by-Step Instructions

### 1. Login to Qobuz Web Player
1. Open your browser (Chrome, Firefox, Safari, etc.)
2. Go to https://play.qobuz.com
3. Login with your account (Google login works fine!)

### 2. Open Browser Developer Tools

**Chrome/Edge (Mac):**
- Press `Cmd+Option+I` or Right-click → Inspect

**Firefox (Mac):**
- Press `Cmd+Option+I` or Right-click → Inspect Element

**Safari (Mac):**
1. First, enable the Developer menu:
   - Go to **Safari** → **Preferences** (or **Settings**)
   - Click the **Advanced** tab
   - Check ✅ **Show Develop menu in menu bar**
2. Then press `Cmd+Option+I` or go to **Develop** → **Show Web Inspector**
3. Or right-click anywhere on the page → **Inspect Element**

### 3. Find Your Session Token

#### Chrome/Edge Instructions:
1. Click on the **Application** tab at the top
2. In the left sidebar, expand **Cookies**
3. Click on `https://play.qobuz.com`
4. Look for the cookie named `user_auth_token`
5. Click on it and **copy the Value** (long alphanumeric string)

#### Firefox Instructions:
1. Click on the **Storage** tab at the top
2. In the left sidebar, expand **Cookies**
3. Click on `https://play.qobuz.com`
4. Look for the cookie named `user_auth_token`
5. Double-click the Value field and copy it

#### Safari Instructions:
1. Click on the **Storage** tab at the top (looks like a database icon)
2. In the left sidebar, expand **Cookies**
3. Click on `https://play.qobuz.com`
4. Look for the cookie named `user_auth_token` in the list
5. Click on the row and look at the **Value** field at the bottom
6. **Double-click the value** to select it, then copy it (`Cmd+C`)

#### Brave Instructions (Network Tab Method):
**If you can't find the cookie, use the Network tab instead:**

1. Make sure you're logged into https://play.qobuz.com
2. Press `Cmd+Option+I` to open DevTools
3. Click the **Network** tab
4. **Clear the list** (click the 🚫 icon)
5. **Play any song** or click on a playlist in Qobuz
6. You'll see new requests appearing in the Network tab
7. Look for a request that includes `/track` or `/playlist` or just any request
8. Click on it
9. Look for the **Request Headers** section (might need to scroll down)
10. Find one of these headers:
    - `X-User-Auth-Token: your_token_here`
    - `x-user-auth-token: your_token_here`
    - Look in the `Cookie:` header for `user_auth_token=your_token_here`
11. Copy the token value (the part after the `:` or `=`)

**Alternative - Console Method:**
1. Press `Cmd+Option+I` to open DevTools
2. Click the **Console** tab
3. Paste this command and press Enter:
   ```javascript
   document.cookie.split('; ').find(row => row.startsWith('user_auth_token='))?.split('=')[1]
   ```
4. If it returns a long string, that's your token!
5. Copy it (it will be in quotes, copy just the part inside the quotes)

**What to look for:**
The token is usually a long string (40-100+ characters) like:
```
1234567890abcdefghijklmnopqrstuvwxyz...
```

### 4. Update Your Credentials File
1. Open `credentials.md` in your project
2. Replace `YOUR_TOKEN_HERE` with your copied token:

```
QOBUZ_USER_AUTH_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 5. Test Your Token
Test if the token works:
```bash
python test_token.py
```

You should see:
```
✅ Token is VALID!
   User: Your Name
   User ID: 1234567
```

If it fails, try getting the token again using Method 1 (HAR file).

## Token Expiration

- Tokens typically last **30-90 days**
- If you get authentication errors, just get a fresh token following these steps again
- Keep your token **private** - it's like a password!

## Troubleshooting

**Token not working?**
- Make sure you're logged into Qobuz in the browser
- Try logging out and back in, then get a fresh token
- Ensure you copied the **entire** token value (no spaces or line breaks)

**Can't find the cookie?**
- Make sure you're on `play.qobuz.com`, not just `qobuz.com`
- Try refreshing the page after logging in
- The cookie name might vary - look for anything with "auth" or "token" in the name

**Still having issues?**
- Check that your Qobuz subscription is active
- Try using a different browser
- Contact support if your account has restrictions
