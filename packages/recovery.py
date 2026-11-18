"""Back up, restore and independently replay a workbench project."""
import argparse
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
from zipfile import BadZipFile

from jsonschema import ValidationError


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup", help="Archive a quiescent project and print its SHA-256")
    restore = commands.add_parser("restore", help="Verify and restore an archive into an unused project directory")
    replay = commands.add_parser("replay", help="Recompute saved analyses into a separate data directory")
    for command in (backup, restore, replay):
        command.add_argument("--data-dir", required=True, type=Path)
    for command in (backup, replay):
        command.add_argument("--project", required=True)
    for command in (backup, restore):
        command.add_argument("--archive", required=True, type=Path)
    restore.add_argument("--sha256", required=True, help="SHA-256 retained when the backup was created")
    replay.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "backup":
            from packages.agent.backup import backup_project
            report = backup_project(args.data_dir, args.project, args.archive)
        elif args.command == "restore":
            from packages.agent.backup import restore_project
            report = restore_project(args.archive, args.data_dir, expected_sha256=args.sha256)
        else:
            from packages.agent.replay import replay_project
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"],
                                             cwd=Path(__file__).resolve().parents[1], text=True).strip()
            report = replay_project(args.data_dir, args.project, args.destination, commit)
    except (OSError, ValueError, RuntimeError, EOFError, sqlite3.Error, ValidationError,
            BadZipFile, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(report.get("ok", True) is False or report.get("status") == "failed")


if __name__ == "__main__":
    sys.exit(main())
