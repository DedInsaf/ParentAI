#!/usr/bin/env python3
"""Create a consistent, private backup of Adym's mutable data."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil
import sqlite3
import tarfile
import tempfile


def backup(data: Path, destination: Path, keep: int) -> Path:
    data, destination = data.resolve(), destination.resolve()
    if not data.is_dir():
        raise SystemExit(f"Data directory does not exist: {data}")
    destination.mkdir(parents=True, exist_ok=True)
    # Manual pre-update backup and the timer can run in the same second.
    # Microseconds prevent the second run from silently replacing the first.
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    archive = destination / f"adym-{stamp}.tar.gz"
    # Stage beside the archives: the hardened systemd unit explicitly grants
    # write access there, while its private /tmp may be unavailable.
    with tempfile.TemporaryDirectory(prefix=".adym-backup-", dir=destination) as temporary:
        staging = Path(temporary) / "data"
        staging.mkdir()
        for database in ("users.sqlite3", "usage.sqlite3"):
            source = data / database
            if source.is_file():
                with sqlite3.connect(source) as source_db, sqlite3.connect(staging / database) as target_db:
                    source_db.backup(target_db)
        profiles = data / "profiles"
        if profiles.is_dir():
            shutil.copytree(profiles, staging / "profiles")
        with tarfile.open(archive, "w:gz") as output:
            output.add(staging, arcname="data")
    archive.chmod(0o600)
    archives = sorted(destination.glob("adym-*.tar.gz"), reverse=True)
    for old in archives[max(1, keep):]:
        old.unlink()
    return archive


def main():
    parser = argparse.ArgumentParser(description="Backup Adym databases and family profiles")
    parser.add_argument("--data", type=Path, default=Path("data"))
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--keep", type=int, default=14)
    args = parser.parse_args()
    if args.keep < 1:
        raise SystemExit("--keep must be at least 1")
    print(backup(args.data, args.destination, args.keep))


if __name__ == "__main__":
    main()
