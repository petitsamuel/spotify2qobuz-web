"""SQLite storage for migration history and credentials."""

import aiosqlite
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from cryptography.fernet import Fernet


class Storage:
    """SQLite-based storage for migration data."""

    def __init__(self, db_path: str = "data/migrations.db"):
        self.db_path = db_path
        self._ensure_directory()
        self._encryption_key = self._get_or_create_key()
        self._fernet = Fernet(self._encryption_key)

    def _ensure_directory(self):
        """Ensure the data directory exists."""
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

    def _get_or_create_key(self) -> bytes:
        """Get or create encryption key for token storage."""
        key_path = Path(self.db_path).parent / ".encryption_key"
        if key_path.exists():
            return key_path.read_bytes()
        key = Fernet.generate_key()
        key_path.write_bytes(key)
        os.chmod(key_path, 0o600)
        return key

    def _encrypt(self, data: str) -> str:
        """Encrypt sensitive data."""
        return self._fernet.encrypt(data.encode()).decode()

    def _decrypt(self, data: str) -> str:
        """Decrypt sensitive data."""
        return self._fernet.decrypt(data.encode()).decode()

    async def init_db(self):
        """Initialize database tables."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS credentials (
                    id INTEGER PRIMARY KEY,
                    service TEXT UNIQUE NOT NULL,
                    data TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            await db.execute("""
                CREATE TABLE IF NOT EXISTS migrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    status TEXT NOT NULL,
                    migration_type TEXT NOT NULL,
                    dry_run INTEGER DEFAULT 0,
                    playlists_total INTEGER DEFAULT 0,
                    playlists_synced INTEGER DEFAULT 0,
                    tracks_matched INTEGER DEFAULT 0,
                    tracks_not_matched INTEGER DEFAULT 0,
                    isrc_matches INTEGER DEFAULT 0,
                    fuzzy_matches INTEGER DEFAULT 0,
                    report_json TEXT
                )
            """)

            # Add dry_run column if it doesn't exist (migration for existing DBs)
            try:
                await db.execute("ALTER TABLE migrations ADD COLUMN dry_run INTEGER DEFAULT 0")
            except Exception:
                pass  # Column already exists

            await db.execute("""
                CREATE TABLE IF NOT EXISTS sync_tasks (
                    id TEXT PRIMARY KEY,
                    migration_id INTEGER,
                    status TEXT NOT NULL,
                    progress_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (migration_id) REFERENCES migrations(id)
                )
            """)

            # Track synced tracks for resume support
            await db.execute("""
                CREATE TABLE IF NOT EXISTS synced_tracks (
                    spotify_id TEXT PRIMARY KEY,
                    qobuz_id TEXT,
                    sync_type TEXT NOT NULL,
                    synced_at TEXT NOT NULL
                )
            """)

            # Track sync progress for resume
            await db.execute("""
                CREATE TABLE IF NOT EXISTS sync_progress (
                    sync_type TEXT PRIMARY KEY,
                    last_offset INTEGER DEFAULT 0,
                    total_tracks INTEGER DEFAULT 0,
                    updated_at TEXT NOT NULL
                )
            """)

            # Store unmatched tracks for review
            await db.execute("""
                CREATE TABLE IF NOT EXISTS unmatched_tracks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    spotify_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL,
                    album TEXT,
                    sync_type TEXT NOT NULL,
                    suggestions_json TEXT,
                    status TEXT DEFAULT 'pending',
                    resolved_qobuz_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(spotify_id, sync_type)
                )
            """)

            await db.commit()

    async def save_credentials(self, service: str, credentials: Dict):
        """Save encrypted credentials."""
        encrypted = self._encrypt(json.dumps(credentials))
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                INSERT OR REPLACE INTO credentials (service, data, updated_at)
                VALUES (?, ?, ?)
            """, (service, encrypted, datetime.now().isoformat()))
            await db.commit()

    async def get_credentials(self, service: str) -> Optional[Dict]:
        """Get decrypted credentials."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT data FROM credentials WHERE service = ?",
                (service,)
            )
            row = await cursor.fetchone()
            if row:
                return json.loads(self._decrypt(row[0]))
            return None

    async def has_credentials(self, service: str) -> bool:
        """Check if credentials exist for a service."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT 1 FROM credentials WHERE service = ?",
                (service,)
            )
            row = await cursor.fetchone()
            return row is not None

    async def delete_credentials(self, service: str):
        """Delete credentials for a service."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM credentials WHERE service = ?", (service,))
            await db.commit()

    async def create_migration(self, migration_type: str, dry_run: bool = False) -> int:
        """Create a new migration record."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("""
                INSERT INTO migrations (started_at, status, migration_type, dry_run)
                VALUES (?, ?, ?, ?)
            """, (datetime.now().isoformat(), "running", migration_type, 1 if dry_run else 0))
            await db.commit()
            return cursor.lastrowid

    async def update_migration(self, migration_id: int, **kwargs):
        """Update migration record."""
        allowed_fields = {
            'completed_at', 'status', 'playlists_total', 'playlists_synced',
            'tracks_matched', 'tracks_not_matched', 'isrc_matches',
            'fuzzy_matches', 'report_json'
        }
        updates = {k: v for k, v in kwargs.items() if k in allowed_fields}
        if not updates:
            return

        set_clause = ", ".join(f"{k} = ?" for k in updates.keys())
        values = list(updates.values()) + [migration_id]

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                f"UPDATE migrations SET {set_clause} WHERE id = ?",
                values
            )
            await db.commit()

    async def get_migration(self, migration_id: int) -> Optional[Dict]:
        """Get a migration record."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM migrations WHERE id = ?",
                (migration_id,)
            )
            row = await cursor.fetchone()
            if row:
                return dict(row)
            return None

    async def get_migrations(self, limit: int = 20) -> List[Dict]:
        """Get recent migrations."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("""
                SELECT * FROM migrations
                ORDER BY started_at DESC
                LIMIT ?
            """, (limit,))
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def create_task(self, task_id: str, migration_id: int) -> str:
        """Create a sync task."""
        now = datetime.now().isoformat()
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                INSERT INTO sync_tasks (id, migration_id, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
            """, (task_id, migration_id, "pending", now, now))
            await db.commit()
        return task_id

    async def update_task(self, task_id: str, status: str, progress: Dict = None):
        """Update task status and progress."""
        async with aiosqlite.connect(self.db_path) as db:
            progress_json = json.dumps(progress) if progress else None
            await db.execute("""
                UPDATE sync_tasks
                SET status = ?, progress_json = ?, updated_at = ?
                WHERE id = ?
            """, (status, progress_json, datetime.now().isoformat(), task_id))
            await db.commit()

    async def get_task(self, task_id: str) -> Optional[Dict]:
        """Get task details."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM sync_tasks WHERE id = ?",
                (task_id,)
            )
            row = await cursor.fetchone()
            if row:
                result = dict(row)
                if result.get('progress_json'):
                    result['progress'] = json.loads(result['progress_json'])
                return result
            return None

    # --- Synced track tracking for resume support ---

    async def is_track_synced(self, spotify_id: str, sync_type: str) -> bool:
        """Check if a track has already been synced."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT 1 FROM synced_tracks WHERE spotify_id = ? AND sync_type = ?",
                (spotify_id, sync_type)
            )
            row = await cursor.fetchone()
            return row is not None

    async def mark_track_synced(self, spotify_id: str, qobuz_id: str, sync_type: str):
        """Mark a track as synced."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                INSERT OR REPLACE INTO synced_tracks (spotify_id, qobuz_id, sync_type, synced_at)
                VALUES (?, ?, ?, ?)
            """, (spotify_id, qobuz_id, sync_type, datetime.now().isoformat()))
            await db.commit()

    async def get_synced_track_ids(self, sync_type: str) -> set:
        """Get all synced Spotify track IDs for a sync type."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT spotify_id FROM synced_tracks WHERE sync_type = ?",
                (sync_type,)
            )
            rows = await cursor.fetchall()
            return {row[0] for row in rows}

    async def get_synced_count(self, sync_type: str) -> int:
        """Get count of synced tracks for a sync type."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT COUNT(*) FROM synced_tracks WHERE sync_type = ?",
                (sync_type,)
            )
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def clear_synced_tracks(self, sync_type: str):
        """Clear synced tracks for a fresh sync."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM synced_tracks WHERE sync_type = ?", (sync_type,))
            await db.commit()

    # --- Sync progress tracking ---

    async def save_sync_progress(self, sync_type: str, last_offset: int, total_tracks: int):
        """Save sync progress for resume."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                INSERT OR REPLACE INTO sync_progress (sync_type, last_offset, total_tracks, updated_at)
                VALUES (?, ?, ?, ?)
            """, (sync_type, last_offset, total_tracks, datetime.now().isoformat()))
            await db.commit()

    async def get_sync_progress(self, sync_type: str) -> Optional[Dict]:
        """Get sync progress for resume."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM sync_progress WHERE sync_type = ?",
                (sync_type,)
            )
            row = await cursor.fetchone()
            if row:
                return dict(row)
            return None

    async def clear_sync_progress(self, sync_type: str):
        """Clear sync progress."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM sync_progress WHERE sync_type = ?", (sync_type,))
            await db.commit()

    async def cleanup_stale_tasks(self):
        """Mark any 'running' tasks as 'interrupted' on startup."""
        async with aiosqlite.connect(self.db_path) as db:
            # Update stale tasks
            await db.execute("""
                UPDATE sync_tasks
                SET status = 'interrupted', updated_at = ?
                WHERE status IN ('running', 'pending', 'starting')
            """, (datetime.now().isoformat(),))

            # Update stale migrations
            await db.execute("""
                UPDATE migrations
                SET status = 'interrupted', completed_at = ?
                WHERE status = 'running'
            """, (datetime.now().isoformat(),))

            await db.commit()

    # --- Unmatched tracks for review ---

    async def save_unmatched_track(
        self,
        spotify_id: str,
        title: str,
        artist: str,
        album: str,
        sync_type: str,
        suggestions: List[Dict]
    ):
        """Save an unmatched track for later review."""
        now = datetime.now().isoformat()
        suggestions_json = json.dumps(suggestions) if suggestions else None

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                INSERT OR REPLACE INTO unmatched_tracks
                (spotify_id, title, artist, album, sync_type, suggestions_json, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            """, (spotify_id, title, artist, album, sync_type, suggestions_json, now, now))
            await db.commit()

    async def get_unmatched_tracks(
        self,
        sync_type: str = None,
        status: str = 'pending',
        limit: int = 100,
        offset: int = 0
    ) -> List[Dict]:
        """Get unmatched tracks for review."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            query = "SELECT * FROM unmatched_tracks WHERE 1=1"
            params = []

            if sync_type:
                query += " AND sync_type = ?"
                params.append(sync_type)

            if status:
                query += " AND status = ?"
                params.append(status)

            query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])

            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()

            results = []
            for row in rows:
                item = dict(row)
                if item.get('suggestions_json'):
                    item['suggestions'] = json.loads(item['suggestions_json'])
                else:
                    item['suggestions'] = []
                results.append(item)

            return results

    async def get_unmatched_count(self, sync_type: str = None, status: str = 'pending') -> int:
        """Get count of unmatched tracks."""
        async with aiosqlite.connect(self.db_path) as db:
            query = "SELECT COUNT(*) FROM unmatched_tracks WHERE 1=1"
            params = []

            if sync_type:
                query += " AND sync_type = ?"
                params.append(sync_type)

            if status:
                query += " AND status = ?"
                params.append(status)

            cursor = await db.execute(query, params)
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def resolve_unmatched_track(
        self,
        spotify_id: str,
        sync_type: str,
        qobuz_id: str,
        status: str = 'resolved'
    ):
        """Mark an unmatched track as resolved."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                UPDATE unmatched_tracks
                SET status = ?, resolved_qobuz_id = ?, updated_at = ?
                WHERE spotify_id = ? AND sync_type = ?
            """, (status, qobuz_id, datetime.now().isoformat(), spotify_id, sync_type))
            await db.commit()

    async def dismiss_unmatched_track(self, spotify_id: str, sync_type: str):
        """Mark an unmatched track as dismissed (user chose to skip)."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                UPDATE unmatched_tracks
                SET status = 'dismissed', updated_at = ?
                WHERE spotify_id = ? AND sync_type = ?
            """, (datetime.now().isoformat(), spotify_id, sync_type))
            await db.commit()

    async def clear_unmatched_tracks(self, sync_type: str = None):
        """Clear unmatched tracks (optionally by sync type)."""
        async with aiosqlite.connect(self.db_path) as db:
            if sync_type:
                await db.execute(
                    "DELETE FROM unmatched_tracks WHERE sync_type = ?",
                    (sync_type,)
                )
            else:
                await db.execute("DELETE FROM unmatched_tracks")
            await db.commit()
