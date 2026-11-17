#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AppBox 服务端
-------------
- 提供商店页面（index.html / assets）
- 把上传的网页程序解压到 storage/apps/<id>/，通过 /apps/<id>/ 访问
- 把上传的安装包/压缩包存到 storage/files/，通过 /files/<文件名> 下载
- 程序目录保存在 data/apps.json

没有第三方依赖，Python 3.8+ 直接运行：
    python server.py

管理口令：环境变量 APPBOX_TOKEN，或 data/admin-token.txt（首次启动自动生成）。
"""

import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
APPS_DIR = BASE / "apps"
FILES_DIR = BASE / "files"
TMP_DIR = BASE / ".tmp"
CATALOG = DATA / "apps.json"
TOKEN_FILE = DATA / "admin-token.txt"

MAX_UPLOAD = 300 * 1024 * 1024        # 单次上传上限：300 MB
MAX_EXTRACT = 1024 * 1024 * 1024      # 解压后总大小上限：1 GB
MAX_JSON = 2 * 1024 * 1024            # 程序信息 JSON 上限

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")
ICON_PATH_RE = re.compile(
    r"^(apps|assets)/[A-Za-z0-9_./-]+\.(png|jpe?g|svg|webp|gif|avif)$", re.I
)
DOWNLOAD_EXTS = {
    ".zip", ".rar", ".7z", ".exe", ".msi", ".apk", ".dmg", ".pkg",
    ".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".html",
}

CATALOG_LOCK = threading.Lock()


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

def load_token() -> str:
    env = os.environ.get("APPBOX_TOKEN", "").strip()
    if env:
        return env
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(18)
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
    return token


TOKEN = load_token()


def load_catalog():
    if not CATALOG.exists():
        return []
    try:
        data = json.loads(CATALOG.read_text(encoding="utf-8"))
    except Exception:
        return []
    return data if isinstance(data, list) else []


def save_catalog(items) -> None:
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    tmp = CATALOG.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp.replace(CATALOG)


def safe_slug(value: str) -> str:
    value = (value or "").strip().lower()
    if not SLUG_RE.fullmatch(value):
        raise ValueError("链接标识只能用小写字母、数字和短横线，长度 2–40")
    return value


def safe_upload_name(name: str) -> str:
    name = os.path.basename((name or "").replace("\\", "/")).strip()
    name = re.sub(r"[\x00-\x1f<>:\"/\\|?*]+", "_", name)
    return name[:120] or "file.bin"


def safe_join(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    root = root.resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("非法路径")
    return candidate


def lan_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"


# --------------------------------------------------------------------------
# 程序信息校验
# --------------------------------------------------------------------------

def text(value, limit) -> str:
    return str(value if value is not None else "").strip()[:limit]


def clean_entry(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("提交的格式不对")

    entry_id = safe_slug(text(raw.get("id"), 40))
    name = text(raw.get("name"), 60)
    if not name:
        raise ValueError("程序名不能为空")

    kind = text(raw.get("kind"), 10)
    if kind not in ("web", "link", "download"):
        raise ValueError("程序类型不正确")

    accent = text(raw.get("accent"), 20) or "#5b7cfa"
    if not ACCENT_RE.fullmatch(accent):
        accent = "#5b7cfa"

    icon = text(raw.get("icon"), 8) or "📦"
    if not ICON_PATH_RE.fullmatch(icon) and len(icon) > 4:
        icon = icon[:4]

    tags = raw.get("tags") or []
    if isinstance(tags, str):
        tags = re.split(r"[,，、\s]+", tags)
    tags = [text(tag, 20) for tag in tags if text(tag, 20)][:8]

    usage_raw = raw.get("usage") or []
    usage = []
    if isinstance(usage_raw, list):
        for step in usage_raw[:20]:
            if not isinstance(step, dict):
                continue
            title = text(step.get("title"), 60)
            body = text(step.get("text"), 300)
            if title or body:
                usage.append({"title": title or "步骤", "text": body})

    tips = raw.get("tips") or []
    if isinstance(tips, str):
        tips = tips.splitlines()
    tips = [text(tip, 160) for tip in tips if text(tip, 160)][:10]

    entry = {
        "id": entry_id,
        "name": name,
        "tagline": text(raw.get("tagline"), 80),
        "icon": icon,
        "accent": accent,
        "category": text(raw.get("category"), 20) or "其他",
        "tags": tags,
        "kind": kind,
        "embed": bool(raw.get("embed", True)),
        "featured": bool(raw.get("featured", False)),
        "description": text(raw.get("description"), 4000),
        "usage": usage,
        "tips": tips,
        "version": text(raw.get("version"), 20),
        "updated": text(raw.get("updated"), 20) or time.strftime("%Y-%m-%d"),
        "size": int(raw.get("size") or 0),
    }

    if kind == "web":
        entry["url"] = "apps/%s/" % entry_id
        if not (APPS_DIR / entry_id / "index.html").is_file():
            raise ValueError("还没有这个网页程序的文件，请先上传 zip 压缩包")
        entry["download"] = False
    elif kind == "download":
        url = text(raw.get("url"), 300)
        if not url.startswith("files/"):
            raise ValueError("下载文件地址不正确")
        stored = FILES_DIR / os.path.basename(urllib.parse.unquote(url))
        if not stored.is_file():
            raise ValueError("下载文件不存在，请重新上传")
        entry["url"] = "files/" + urllib.parse.quote(stored.name)
        entry["size"] = stored.stat().st_size
        entry["download"] = True
    else:
        url = text(raw.get("url"), 500)
        if not re.match(r"^https?://", url, re.I):
            raise ValueError("外部网址需要以 http:// 或 https:// 开头")
        entry["url"] = url
        entry["embed"] = False
        entry["download"] = False

    return entry


# --------------------------------------------------------------------------
# 上传处理
# --------------------------------------------------------------------------

def safe_extract_zip(zip_path: Path, dest: Path) -> None:
    with zipfile.ZipFile(zip_path) as archive:
        infos = archive.infolist()
        if len(infos) > 5000:
            raise ValueError("压缩包里的文件太多了")
        total = sum(info.file_size for info in infos)
        if total > MAX_EXTRACT:
            raise ValueError("解压后超过 1 GB，请精简后再上传")
        for info in infos:
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/"):
                raise ValueError("压缩包里有非法路径")
            target = safe_join(dest, name)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def normalize_bundle(dest: Path) -> None:
    """压缩包里如果只套了一层文件夹，把内容提上来。"""
    if (dest / "index.html").is_file():
        return
    children = [item for item in dest.iterdir() if item.name not in ("__MACOSX",)]
    children = [item for item in children if not item.name.startswith("._")]
    if len(children) == 1 and children[0].is_dir():
        inner = children[0]
        if (inner / "index.html").is_file():
            for item in inner.iterdir():
                shutil.move(str(item), str(dest / item.name))
            inner.rmdir()


def install_webapp(slug: str, zip_path: Path) -> dict:
    stage = TMP_DIR / (".stage-" + slug)
    if stage.exists():
        shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)

    try:
        safe_extract_zip(zip_path, stage)
        normalize_bundle(stage)
        if not (stage / "index.html").is_file():
            raise ValueError("压缩包根目录里没有 index.html，请把入口页面放在最外层")

        target = APPS_DIR / slug
        if target.exists():
            shutil.rmtree(target)
        stage.rename(target)
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)

    return {"ok": True, "url": "apps/%s/" % slug}


def install_file(original_name: str, temp_path: Path) -> dict:
    original_name = safe_upload_name(original_name)
    ext = os.path.splitext(original_name)[1].lower()
    if ext and ext not in DOWNLOAD_EXTS:
        raise ValueError("这个文件类型不在允许列表里：%s" % ext)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    stored_name = "%s-%s" % (time.strftime("%Y%m%d%H%M%S"), original_name)
    target = FILES_DIR / stored_name
    temp_path.replace(target)
    return {
        "ok": True,
        "url": "files/" + urllib.parse.quote(stored_name),
        "name": original_name,
        "size": target.stat().st_size,
    }


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------

class AppBoxHandler(BaseHTTPRequestHandler):
    server_version = "AppBox/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- 响应辅助 ----------

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status >= 400:
            # 请求体可能还没读完，直接断开，避免污染 keep-alive 连接。
            self.close_connection = True
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400):
        self.send_json({"ok": False, "error": message}, status)

    def serve_file(self, path: Path, download=False, cache="no-cache"):
        if not path.is_file():
            return self.send_error_json("文件不存在", 404)
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        if download:
            quoted = urllib.parse.quote(path.name)
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quoted)
        self.end_headers()
        try:
            with open(path, "rb") as handle:
                shutil.copyfileobj(handle, self.wfile)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---------- 鉴权 ----------

    def is_admin(self) -> bool:
        supplied = self.headers.get("X-Admin-Token", "")
        return bool(supplied) and hmac.compare_digest(supplied, TOKEN)

    def require_admin(self) -> bool:
        if self.is_admin():
            return True
        self.send_error_json("管理口令不正确", 401)
        return False

    # ---------- 请求体 ----------

    def content_length(self, limit: int) -> int:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            raise ValueError("请求为空")
        if length > limit:
            raise ValueError("文件太大，单次最多 %d MB" % (limit // (1024 * 1024)))
        return length

    def stream_body_to(self, dest: Path, length: int):
        remaining = length
        with open(dest, "wb") as out:
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    raise ValueError("上传中断")
                out.write(chunk)
                remaining -= len(chunk)

    def read_json_body(self):
        length = self.content_length(MAX_JSON)
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # ---------- GET ----------

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = urllib.parse.unquote(parsed.path)
            query = urllib.parse.parse_qs(parsed.query)

            if path == "/api/apps":
                return self.send_json(load_catalog())

            if path == "/data/apps.json":
                return self.serve_file(CATALOG)

            if path in ("/", "/index.html"):
                return self.serve_file(BASE / "index.html")

            if path.startswith("/assets/"):
                rel = path[len("/assets/"):]
                try:
                    target = safe_join(BASE / "assets", rel)
                except ValueError:
                    return self.send_error_json("非法路径", 400)
                if target.is_dir():
                    return self.send_error_json("文件不存在", 404)
                return self.serve_file(target)

            if path.startswith("/apps/"):
                rest = path[len("/apps/"):]
                parts = rest.split("/", 1)
                slug = parts[0]
                if not SLUG_RE.fullmatch(slug):
                    return self.send_error_json("程序不存在", 404)
                sub = parts[1] if len(parts) > 1 else ""
                if sub == "" or sub.endswith("/"):
                    sub += "index.html"
                try:
                    target = safe_join(APPS_DIR / slug, sub)
                except ValueError:
                    return self.send_error_json("非法路径", 400)
                if target.is_dir():
                    target = target / "index.html"
                return self.serve_file(target)

            if path.startswith("/files/"):
                name = os.path.basename(path)
                try:
                    target = safe_join(FILES_DIR, name)
                except ValueError:
                    return self.send_error_json("非法路径", 400)
                return self.serve_file(target, download=True)

            return self.send_error_json("页面不存在", 404)

        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.send_error_json("服务器处理失败：%s" % exc, 500)

    # ---------- POST ----------

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = urllib.parse.unquote(parsed.path)
            query = urllib.parse.parse_qs(parsed.query)

            if path == "/api/auth":
                if not self.require_admin():
                    return
                return self.send_json({"ok": True})

            if path == "/api/apps":
                if not self.require_admin():
                    return
                raw = self.read_json_body()
                entry = clean_entry(raw)
                with CATALOG_LOCK:
                    items = load_catalog()
                    replaced = False
                    for index, item in enumerate(items):
                        if item.get("id") == entry["id"]:
                            items[index] = entry
                            replaced = True
                            break
                    if not replaced:
                        items.append(entry)
                    save_catalog(items)
                return self.send_json({"ok": True, "app": entry, "created": not replaced})

            if path == "/api/upload/webapp":
                if not self.require_admin():
                    return
                slug = safe_slug((query.get("slug") or [""])[0])
                length = self.content_length(MAX_UPLOAD)
                temp = TMP_DIR / (".upload-%s.zip" % slug)
                try:
                    self.stream_body_to(temp, length)
                    if not zipfile.is_zipfile(temp):
                        raise ValueError("上传的不是有效的 zip 压缩包")
                    result = install_webapp(slug, temp)
                finally:
                    if temp.exists():
                        temp.unlink()
                return self.send_json(result)

            if path == "/api/upload/file":
                if not self.require_admin():
                    return
                encoded = self.headers.get("X-Filename-Enc", "")
                try:
                    name = urllib.parse.unquote(encoded) if encoded else "file.bin"
                except Exception:
                    name = "file.bin"
                length = self.content_length(MAX_UPLOAD)
                temp = TMP_DIR / (".upload-%s.tmp" % secrets.token_hex(4))
                try:
                    self.stream_body_to(temp, length)
                    result = install_file(name, temp)
                finally:
                    if temp.exists():
                        temp.unlink()
                return self.send_json(result)

            return self.send_error_json("接口不存在", 404)

        except ValueError as exc:
            self.send_error_json(str(exc), 400)
        except json.JSONDecodeError:
            self.send_error_json("提交的数据不是有效 JSON", 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.send_error_json("服务器处理失败：%s" % exc, 500)

    # ---------- DELETE ----------

    def do_DELETE(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if urllib.parse.unquote(parsed.path) != "/api/apps":
                return self.send_error_json("接口不存在", 404)
            if not self.require_admin():
                return
            query = urllib.parse.parse_qs(parsed.query)
            app_id = (query.get("id") or [""])[0]
            purge = (query.get("purge") or ["0"])[0] == "1"
            app_id = safe_slug(app_id)

            removed = None
            with CATALOG_LOCK:
                items = load_catalog()
                kept = []
                for item in items:
                    if item.get("id") == app_id:
                        removed = item
                    else:
                        kept.append(item)
                if removed is None:
                    return self.send_error_json("没有找到这个程序", 404)
                save_catalog(kept)

            if purge:
                if removed.get("kind") == "web":
                    shutil.rmtree(APPS_DIR / app_id, ignore_errors=True)
                elif removed.get("kind") == "download":
                    url = removed.get("url") or ""
                    if url.startswith("files/"):
                        target = FILES_DIR / os.path.basename(urllib.parse.unquote(url))
                        if target.is_file():
                            target.unlink()

            return self.send_json({"ok": True})

        except ValueError as exc:
            self.send_error_json(str(exc), 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.send_error_json("服务器处理失败：%s" % exc, 500)

    # ---------- 日志 ----------

    def log_message(self, fmt, *args):
        # 静态资源的 200 日志太吵，只保留接口和错误。
        if str(args[1] if len(args) > 1 else "200").startswith(("4", "5")):
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    port = int(os.environ.get("PORT", "8080"))

    for directory in (DATA, APPS_DIR, FILES_DIR, TMP_DIR):
        directory.mkdir(parents=True, exist_ok=True)

    server = ThreadingHTTPServer(("0.0.0.0", port), AppBoxHandler)
    server.daemon_threads = True

    print()
    print("  AppBox 已启动")
    print("  ------------------------------------------")
    print("  本机访问:   http://localhost:%d/" % port)
    print("  局域网访问: http://%s:%d/" % (lan_ip(), port))
    print("  管理口令:   %s" % TOKEN)
    print("  口令文件:   %s" % TOKEN_FILE)
    print("  程序目录:   %s" % APPS_DIR)
    print("  下载目录:   %s" % FILES_DIR)
    print("  按 Ctrl+C 停止")
    print()

    if "--no-browser" not in sys.argv and os.environ.get("APPBOX_NO_BROWSER", "") != "1":
        threading.Timer(0.9, lambda: webbrowser.open("http://localhost:%d/" % port)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
