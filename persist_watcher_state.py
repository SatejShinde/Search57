"""Publish allowlisted watcher checkpoints with bounded non-force push retries.

Tier locks protect same-file writers; retries handle disjoint fast/slow commits
racing for main. Conflicting rebases fail closed instead of overwriting state.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=30)


def authorize_action(env):
    if env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("Checkpoint CLI only permits main-branch GitHub Actions runs")


def publish(tier, *, followup=False, run=git, sleep=time.sleep):
    if tier not in {"fast", "slow"}:
        raise ValueError("Invalid tier")
    paths = ([f"state_{tier}.json"] if not followup else []) + [f"pending_{tier}.json", f"archive_outbox_{tier}.json"]
    paths = [p for p in paths if Path(p).is_file()]
    for path in paths:
        json.loads(Path(path).read_text(encoding="utf-8"))
    if not paths:
        return
    # Never scoop up other source/private files already staged by another tool.
    staged = run("diff", "--cached", "--name-only")
    if staged.returncode or staged.stdout.strip():
        raise RuntimeError("Index not clean before checkpoint staging")
    for args in [("config", "user.name", "job-watcher-bot"),
                 ("config", "user.email", "actions@users.noreply.github.com"),
                 ("add", "--", *paths)]:
        if run(*args).returncode:
            raise RuntimeError("Cannot stage allowlisted checkpoints")
    diff = run("diff", "--cached", "--quiet")
    if diff.returncode == 0:
        return
    if diff.returncode != 1 or run("commit", "-m", f"state: {tier} delivery checkpoints").returncode:
        raise RuntimeError("Cannot commit delivery checkpoint")
    for attempt in range(3):
        if run("fetch", "--no-tags", "origin", "main").returncode:
            if attempt < 2:
                sleep(2**attempt); continue
            break
        if run("rebase", "origin/main").returncode:
            run("rebase", "--abort")
            raise RuntimeError("Checkpoint conflict; remote state preserved, manual recovery required")
        if run("push", "origin", "HEAD:main").returncode == 0:
            return
        if attempt < 2:
            sleep(2**attempt)
    raise RuntimeError("Checkpoint push unconfirmed after three non-force attempts")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", choices=["fast", "slow"], required=True)
    parser.add_argument("--followup", action="store_true")
    args = parser.parse_args()
    authorize_action(os.environ)
    publish(args.tier, followup=args.followup)


if __name__ == "__main__":
    main()
