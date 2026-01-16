"""Automated Qobuz authentication using Playwright."""

import asyncio
import json
import re
import subprocess
import sys
from typing import Optional, Dict
from src.utils.logger import get_logger

logger = get_logger()


async def extract_qobuz_token_from_browser(
    headless: bool = False,
    timeout: int = 120000
) -> Optional[Dict]:
    """
    Open a browser for user to login to Qobuz and extract the auth token.

    Uses a subprocess to avoid issues with async event loops in web servers.
    """
    # Run the browser extraction in a subprocess to avoid event loop conflicts
    script = '''
import asyncio
import json
import re
import sys

async def main():
    from playwright.async_api import async_playwright

    token_data = None

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            slow_mo=100  # Add small delay between actions for stability
        )
        context = await browser.new_context(
            viewport={'width': 1280, 'height': 800}
        )
        page = await context.new_page()

        async def handle_response(response):
            nonlocal token_data
            url = response.url

            if token_data:  # Already found
                return

            if 'qobuz.com/api' in url:
                try:
                    # Check for login/user endpoints
                    if any(x in url for x in ['user/login', 'user/get', 'favorite/getUserFavorites']):
                        try:
                            body = await response.json()
                            if 'user_auth_token' in body:
                                token_data = {
                                    'user_auth_token': body['user_auth_token'],
                                    'user_id': body.get('user', {}).get('id'),
                                    'display_name': body.get('user', {}).get('display_name')
                                }
                        except:
                            pass
                except:
                    pass

        page.on('response', handle_response)

        # Navigate to Qobuz
        await page.goto('https://play.qobuz.com/login')

        # Wait for successful login (URL changes to main app)
        try:
            await page.wait_for_url(
                re.compile(r'play\\.qobuz\\.com/(discover|album|artist|playlist|user|my-qobuz)'),
                timeout=120000
            )

            # Wait for API calls to complete
            await asyncio.sleep(3)

            # If no token from responses, try localStorage
            if not token_data:
                try:
                    storage = await page.evaluate("() => JSON.stringify(localStorage)")
                    data = json.loads(storage)
                    for key, value in data.items():
                        if 'localuser' in key.lower() or 'auth' in key.lower():
                            try:
                                parsed = json.loads(value)
                                if isinstance(parsed, dict):
                                    if 'user_auth_token' in parsed:
                                        token_data = {'user_auth_token': parsed['user_auth_token']}
                                        break
                                    elif 'authToken' in parsed:
                                        token_data = {'user_auth_token': parsed['authToken']}
                                        break
                            except:
                                pass
                except:
                    pass

            # Try intercepting a request by navigating
            if not token_data:
                await page.goto('https://play.qobuz.com/my-qobuz/all/favorites')
                await asyncio.sleep(2)

        except Exception as e:
            print(json.dumps({'error': str(e)}), file=sys.stderr)

        await browser.close()

    if token_data:
        print(json.dumps(token_data))
    else:
        print(json.dumps({'error': 'No token found'}))

asyncio.run(main())
'''

    try:
        # Run in subprocess to isolate the event loop
        result = await asyncio.create_subprocess_exec(
            sys.executable, '-c', script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        stdout, stderr = await asyncio.wait_for(
            result.communicate(),
            timeout=timeout / 1000 + 10  # Add buffer
        )

        if stderr:
            logger.debug(f"Browser stderr: {stderr.decode()}")

        if stdout:
            try:
                data = json.loads(stdout.decode().strip())
                if 'error' in data:
                    logger.error(f"Browser auth error: {data['error']}")
                    return None
                if 'user_auth_token' in data:
                    logger.info("Successfully extracted Qobuz auth token")
                    return data
            except json.JSONDecodeError:
                logger.error(f"Invalid JSON from browser: {stdout.decode()}")

        return None

    except asyncio.TimeoutError:
        logger.error("Browser auth timed out")
        return None
    except Exception as e:
        logger.error(f"Browser auth failed: {e}")
        return None


async def validate_qobuz_token(token: str) -> bool:
    """
    Validate a Qobuz auth token by making a test API call.
    """
    import httpx

    headers = {
        "X-App-Id": "798273057",
        "X-User-Auth-Token": token,
        "User-Agent": "Mozilla/5.0"
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://www.qobuz.com/api.json/0.2/favorite/getUserFavorites",
                params={"type": "albums", "limit": 1},
                headers=headers,
                timeout=10
            )
            return response.status_code == 200
    except Exception as e:
        logger.error(f"Token validation failed: {e}")
        return False


def extract_token_from_har_sync(har_path: str) -> Optional[str]:
    """
    Extract Qobuz auth token from HAR file (fallback method).
    """
    try:
        with open(har_path, 'r', encoding='utf-8') as f:
            har_data = json.load(f)

        for entry in har_data.get('log', {}).get('entries', []):
            request = entry.get('request', {})

            # Check request headers
            for header in request.get('headers', []):
                if header.get('name', '').lower() == 'x-user-auth-token':
                    return header['value']

            # Check response headers
            response = entry.get('response', {})
            for header in response.get('headers', []):
                if header.get('name', '').lower() == 'x-user-auth-token':
                    return header['value']

        logger.error("No auth token found in HAR file")
        return None

    except Exception as e:
        logger.error(f"Error reading HAR file: {e}")
        return None
