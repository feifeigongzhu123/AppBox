#!/usr/bin/env python3
"""Upload AppBox to GitHub using the GitHub REST API.

This mirrors english-daily/scripts/upload_github.py: the token is read from
the environment and is never written to disk.

Usage:
    set GITHUB_TOKEN=ghp_xxx
    python scripts/deploy_github.py

    # or put the token in AppBox/.token (gitignored), then:
    python scripts/deploy_github.py

    # only inspect what would be uploaded
    python scripts/deploy_github.py --dry-run

The token needs the classic `repo` scope (it is used to create the repository
and enable GitHub Pages).
"""

import argparse
import base64
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests

API = "https://api.github.com"
ROOT = Path(__file__).resolve().parent.parent

EXCLUDE_DIRS = {".git", "__pycache__", "node_modules", ".tmp"}
EXCLUDE_FILES = {
    "data/admin-token.txt",
    ".token",
    ".env",
    "server.log",
    ".DS_Store",
    "Thumbs.db",
}
EXCLUDE_SUFFIXES = {".pyc", ".zip", ".log", ".tmp"}


def headers(token):
    return {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "appbox-uploader",
    }


def request(method, path, token, **kwargs):
    response = requests.request(
        method, API + path, headers=headers(token), timeout=60, **kwargs
    )
    if response.status_code >= 400:
        raise RuntimeError(
            "%s %s -> %s: %s"
            % (method, path, response.status_code, response.text[:500])
        )
    return response


def fill_config(owner, repo):
    path = ROOT / "assets" / "config.js"
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"mode:\s*'[^']*'", "mode: 'github'", text, count=1)
    text = re.sub(r"owner:\s*'[^']*'", "owner: '" + owner + "'", text, count=1)
    text = re.sub(r"repo:\s*'[^']*'", "repo: '" + repo + "'", text, count=1)
    path.write_text(text, encoding="utf-8")
    return path


def collect_files():
    files = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if any(part in EXCLUDE_DIRS for part in relative.parts):
            continue
        key = relative.as_posix()
        if key in EXCLUDE_FILES:
            continue
        if any(key.endswith(suffix) for suffix in EXCLUDE_SUFFIXES):
            continue
        files.append((key, path))
    return sorted(files, key=lambda item: item[0])


def dry_run():
    files = collect_files()
    print("Would upload %d files:" % len(files))
    total = 0
    for key, path in files:
        size = path.stat().st_size
        total += size
        print("  %-46s %8.1f KB" % (key, size / 1024))
    print("Total: %.2f MB" % (total / (1024 * 1024)))
    print("Excluded: .token, .env, data/admin-token.txt, .tmp/, __pycache__/, archives, logs")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="AppBox", help="repository name")
    parser.add_argument(
        "--description",
        default="AppBox · 我的程序盒子：网页程序在线打开，安装包提供下载",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-pages", action="store_true", help="do not enable Pages")
    args = parser.parse_args()

    if args.dry_run:
        return dry_run()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        token_file = ROOT / ".token"
        if token_file.is_file():
            token = token_file.read_text(encoding="utf-8").strip()
    if not token:
        print("GITHUB_TOKEN is not set.", file=sys.stderr)
        print(
            "Create a classic token with `repo` scope, then either:\n"
            "  1. save it as a single line in AppBox/.token (gitignored), or\n"
            "  2. set GITHUB_TOKEN=ghp_xxx and run:\n"
            "     python scripts/deploy_github.py",
            file=sys.stderr,
        )
        return 2

    user = request("GET", "/user", token).json()
    owner = user["login"]
    repo = args.repo
    print("Target: %s/%s" % (owner, repo))

    response = requests.post(
        API + "/user/repos",
        headers=headers(token),
        json={
            "name": repo,
            "description": args.description,
            "private": False,
            "auto_init": False,
            "has_issues": True,
            "has_wiki": False,
            "has_projects": False,
        },
        timeout=60,
    )
    if response.status_code == 422 and "already exists" in response.text:
        print("Repository already exists; reusing it.")
    elif response.status_code != 201:
        raise RuntimeError(
            "create repo -> %s: %s" % (response.status_code, response.text[:500])
        )
    else:
        print("Repository created.")

    config_path = fill_config(owner, repo)
    print("Filled owner/repo into %s" % config_path.relative_to(ROOT))

    files = collect_files()
    print("Uploading %d files via Contents API ..." % len(files))

    for index, (relative, path) in enumerate(files, 1):
        content = path.read_bytes()
        if not content:
            content = b"\n"
        encoded = base64.b64encode(content).decode("ascii")
        contents_path = "/repos/{}/{}/contents/{}".format(
            owner, repo, quote(relative, safe="/")
        )
        payload = {
            "message": "AppBox: add " + relative,
            "content": encoded,
            "branch": "main",
        }

        existing = requests.get(API + contents_path, headers=headers(token), timeout=60)
        if existing.status_code == 200:
            payload["sha"] = existing.json()["sha"]

        result = requests.put(
            API + contents_path, headers=headers(token), json=payload, timeout=60
        )
        if result.status_code not in (200, 201):
            raise RuntimeError(
                "upload %s -> %s: %s"
                % (relative, result.status_code, result.text[:500])
            )
        print("  [%d/%d] %s" % (index, len(files), relative))

    time.sleep(2)

    if not args.no_pages:
        pages_response = requests.post(
            API + "/repos/{}/{}/pages".format(owner, repo),
            headers=headers(token),
            json={"source": {"branch": "main", "path": "/"}, "build_type": "legacy"},
            timeout=60,
        )
        if pages_response.status_code in (201, 202, 204):
            print("GitHub Pages enabled.")
        elif pages_response.status_code == 409:
            print("GitHub Pages is already configured.")
        else:
            print(
                "Pages not enabled automatically (%s): %s"
                % (pages_response.status_code, pages_response.text[:300])
            )
            print("Open Settings -> Pages and choose main / (root).")

    print("")
    print("Repository: https://github.com/%s/%s" % (owner, repo))
    print("Pages URL:  https://%s.github.io/%s/" % (owner, repo))
    print("Pages usually goes live in 1-2 minutes.")
    print("The token was only used in memory and was not written to disk.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("Upload failed:", error, file=sys.stderr)
        raise SystemExit(1)
