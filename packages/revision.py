"""Resolve provenance from this checkout or a Git-generated release archive."""
from pathlib import Path
import re
import subprocess


def source_commit(root=Path(__file__).resolve().parents[1]):
    if (root / '.git').exists():
        revision = subprocess.check_output(['git', 'rev-parse', '--verify', 'HEAD'], cwd=root,
                                           text=True, timeout=5).strip()
    else:
        revision = (root / 'baselines/source-commit.txt').read_text(encoding='ascii').strip()
    if not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', revision):
        raise ValueError('Cannot determine the source commit. Use a Git checkout or git archive of a commit.')
    return revision
