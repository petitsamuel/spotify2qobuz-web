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
                    playlists_total INTEGER DEFAULT 0,
                    playlists_synced INTEGER DEFAULT 0,
                    tracks_matched INTEGER DEFAULT 0,
                    tracks_not_matched INTEGER DEFAULT 0,
                    isrc_matches INTEGER DEFAULT 0,
                    fuzzy_matches INTEGER DEFAULT 0,
                    report_json TEXT
                )
            """)

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

    async def create_migration(self, migration_type: str) -> int:
        """Create a new migration record."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("""
                INSERT INTO migrations (started_at, status, migration_type)
                VALUES (?, ?, ?)
            """, (datetime.now().isoformat(), "running", migration_type))
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
