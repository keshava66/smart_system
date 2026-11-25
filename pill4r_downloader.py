#!/usr/bin/env python3
"""
PILL4R file downloader.

Reads relative download paths (externalUrl) from a Snowflake table, joins each
with the PILL4R base URL, downloads the file, and writes an Excel report:

    Full URL | File Name | Download Status | Error

Features
--------
* Snowflake key-pair auth (same config.ini layout as snowflake_client.py)
* Optional CSV input (--input-csv) for testing without Snowflake
* Concurrent downloads with retry/backoff on 429/5xx and network errors
* Streaming writes to a .part file, renamed atomically on success
* File name taken from Content-Disposition, falling back to Content-Type
* Resumable: files already on disk are skipped (use --force to re-download)
* Excel report is always written, even on Ctrl+C or unexpected errors
"""

from __future__ import annotations

import argparse
import configparser
import csv
import logging
import mimetypes
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from email.message import Message
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import unquote, urljoin, urlparse

import requests
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# --------------------------------------------------------------------------- #
# Defaults (override via CLI flags or environment variables)
# --------------------------------------------------------------------------- #
DEFAULT_BASE_URL = "https://pill4r.jnj.com"
DEFAULT_TABLE = '"DEV_RAW"."POC_CORE"."RDH_CORTELLIS_APPROVAL_PACKAGE_PILL4R_DATA"'
DEFAULT_URL_COLUMN = "externalUrl"  # case-sensitive: the column is quoted in Snowflake
DEFAULT_CONFIG = "config.ini"
DEFAULT_SECTION = "SNOWFLAKE"
DEFAULT_OUTPUT_DIR = "downloads"
DEFAULT_WORKERS = 8
DEFAULT_TIMEOUT = (10, 120)  # (connect, read) seconds
CHUNK_SIZE = 1024 * 256

STATUS_SUCCESS = "Success"
STATUS_FAIL = "Fail"
STATUS_SKIPPED = "Success"  # already-downloaded files count as success

log = logging.getLogger("pill4r_downloader")


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #
@dataclass
class DownloadResult:
    full_url: str
    file_name: str
    status: str
    error: str = ""


# --------------------------------------------------------------------------- #
# Snowflake: fetch paths
# --------------------------------------------------------------------------- #
def _load_private_key(path: str, password: Optional[str]) -> bytes:
    from cryptography.hazmat.primitives import serialization

    path = os.path.expanduser(path.strip())
    if not os.path.exists(path):
        raise FileNotFoundError(f"Private key file not found: {path}")
    with open(path, "rb") as f:
        key = serialization.load_pem_private_key(
            f.read(), password=password.encode() if password else None
        )
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def fetch_paths_from_snowflake(
    config_path: str, section: str, table: str, column: str, limit: Optional[int]
) -> List[str]:
    import snowflake.connector

    cfg = configparser.ConfigParser()
    if not cfg.read(config_path):
        raise FileNotFoundError(f"Config file not found: {config_path}")
    if section not in cfg:
        raise KeyError(f"'{section}' section not found in {config_path}")
    sec = cfg[section]

    required = ("user", "account", "private_key_path", "role", "warehouse", "database", "schema")
    for key in required:
        if not sec.get(key, "").strip():
            raise KeyError(f"Missing '{key}' in [{section}] of {config_path}")

    private_key = _load_private_key(sec["private_key_path"], sec.get("private_key_password"))

    # Identifier is double-quoted because the column is case-sensitive; reject embedded quotes.
    if '"' in column:
        raise ValueError("Column name must not contain double quotes")
    sql = f'SELECT DISTINCT "{column}" FROM {table} WHERE "{column}" IS NOT NULL'
    if limit:
        sql += f" LIMIT {int(limit)}"

    log.info("Connecting to Snowflake account=%s", sec["account"])
    conn = snowflake.connector.connect(
        user=sec["user"],
        account=sec["account"],
        private_key=private_key,
        role=sec["role"],
        warehouse=sec["warehouse"],
        database=sec["database"],
        schema=sec["schema"],
        application="PILL4R_DOWNLOADER",
    )
    try:
        cur = conn.cursor()
        try:
            log.info("Running: %s", sql)
            cur.execute(sql)
            paths = [str(r[0]).strip() for r in cur.fetchall() if r[0] and str(r[0]).strip()]
        finally:
            cur.close()
    finally:
        conn.close()
    log.info("Fetched %d distinct paths from Snowflake", len(paths))
    return paths


def read_paths_from_csv(csv_path: str, column: str) -> List[str]:
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError(f"{csv_path} is empty")
        # Case-insensitive column match (externalUrl / EXTERNAL_URL / external_url)
        norm = {c.lower().replace("_", ""): c for c in reader.fieldnames}
        actual = norm.get(column.lower().replace("_", ""))
        if not actual:
            raise KeyError(f"Column '{column}' not in CSV headers: {reader.fieldnames}")
        return [r[actual].strip() for r in reader if r.get(actual) and r[actual].strip()]


# --------------------------------------------------------------------------- #
# URL / filename helpers
# --------------------------------------------------------------------------- #
def build_full_url(base_url: str, path: str) -> str:
    """Join base + path. Absolute URLs in the data are kept as-is by urljoin."""
    base = base_url.rstrip("/") + "/"
    return urljoin(base, path.strip())


def dedupe_preserve_order(items: List[str]) -> List[str]:
    return list(dict.fromkeys(items))


_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_filename(name: str, max_len: int = 180) -> str:
    name = unquote(name).strip().strip(".")
    name = _INVALID_CHARS.sub("_", name)
    name = os.path.basename(name)  # defeat path traversal
    if len(name) > max_len:
        stem, ext = os.path.splitext(name)
        name = stem[: max_len - len(ext)] + ext
    return name or "download"


def filename_from_content_disposition(header: Optional[str]) -> Optional[str]:
    if not header:
        return None
    msg = Message()
    msg["content-disposition"] = header
    name = msg.get_filename()  # handles filename= and RFC 5987 filename*=
    return sanitize_filename(name) if name else None


def resolve_filename(url: str, resp: requests.Response) -> str:
    """
    Priority: Content-Disposition -> URL last segment (+ extension guessed from
    Content-Type when the segment has none). The URL id is the last path segment
    (e.g. .../cortellis-download/426253), so it is unique per file.
    """
    name = filename_from_content_disposition(resp.headers.get("Content-Disposition"))
    if name:
        return name
    segment = sanitize_filename(os.path.basename(urlparse(url).path.rstrip("/")))
    if not os.path.splitext(segment)[1]:
        ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
        ext = mimetypes.guess_extension(ctype) if ctype else None
        if ext and ctype != "application/octet-stream":
            segment += ext
    return segment


def expected_name_from_url(url: str) -> str:
    return sanitize_filename(os.path.basename(urlparse(url).path.rstrip("/")))


# --------------------------------------------------------------------------- #
# HTTP session
# --------------------------------------------------------------------------- #
def build_session(workers: int, verify: object, token: Optional[str]) -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=4,
        connect=4,
        read=3,
        backoff_factor=1.5,  # 0s, 1.5s, 3s, 6s...
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET"]),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=workers, pool_maxsize=workers)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.verify = verify
    session.headers.update({"User-Agent": "pill4r-downloader/1.0", "Accept": "*/*"})
    if token:
        session.headers["Authorization"] = f"Bearer {token}"
    return session


# --------------------------------------------------------------------------- #
# Download one file
# --------------------------------------------------------------------------- #
_name_lock = threading.Lock()
_claimed_names: Dict[str, str] = {}  # filename -> url that owns it


def _claim_unique_path(out_dir: Path, name: str, url: str) -> Path:
    """Two different URLs must never write to the same file name."""
    with _name_lock:
        candidate, n = name, 1
        while _claimed_names.get(candidate, url) != url:
            stem, ext = os.path.splitext(name)
            candidate = f"{stem}_{n}{ext}"
            n += 1
        _claimed_names[candidate] = url
        return out_dir / candidate


def download_one(
    session: requests.Session, full_url: str, out_dir: Path, timeout, force: bool
) -> DownloadResult:
    tmp_path: Optional[Path] = None
    name = expected_name_from_url(full_url)
    try:
        # Cheap resume check: exact URL-id name already on disk (no extension case)
        if not force:
            existing = out_dir / name
            if existing.exists() and existing.stat().st_size > 0:
                return DownloadResult(full_url, existing.name, STATUS_SKIPPED, "")

        with session.get(full_url, stream=True, timeout=timeout, allow_redirects=True) as resp:
            if resp.status_code != 200:
                return DownloadResult(
                    full_url, name, STATUS_FAIL, f"HTTP {resp.status_code} {resp.reason}"
                )

            name = resolve_filename(full_url, resp)

            # An HTML body with no attachment header is almost always a login/error page
            ctype = resp.headers.get("Content-Type", "").lower()
            if "text/html" in ctype and not resp.headers.get("Content-Disposition"):
                return DownloadResult(
                    full_url, name, STATUS_FAIL,
                    "Received HTML instead of a file (possible login/error page)",
                )

            if not force:
                existing = out_dir / name
                if existing.exists() and existing.stat().st_size > 0:
                    return DownloadResult(full_url, existing.name, STATUS_SKIPPED, "")

            final_path = _claim_unique_path(out_dir, name, full_url)
            tmp_path = final_path.with_name(final_path.name + ".part")

            expected = resp.headers.get("Content-Length")
            written = 0
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                    if chunk:
                        f.write(chunk)
                        written += len(chunk)

            if written == 0:
                raise IOError("Downloaded file is empty")
            if expected and expected.isdigit() and written != int(expected):
                raise IOError(f"Incomplete download: got {written} of {expected} bytes")

            os.replace(tmp_path, final_path)  # atomic
            tmp_path = None
            return DownloadResult(full_url, final_path.name, STATUS_SUCCESS, "")

    except requests.exceptions.SSLError as e:
        return DownloadResult(full_url, name, STATUS_FAIL, f"SSL error: {e}")
    except requests.exceptions.Timeout:
        return DownloadResult(full_url, name, STATUS_FAIL, "Request timed out")
    except requests.exceptions.RequestException as e:
        return DownloadResult(full_url, name, STATUS_FAIL, f"Request error: {e}")
    except Exception as e:  # noqa: BLE001 - one bad file must not kill the batch
        return DownloadResult(full_url, name, STATUS_FAIL, f"{type(e).__name__}: {e}")
    finally:
        if tmp_path is not None and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


# --------------------------------------------------------------------------- #
# Excel report
# --------------------------------------------------------------------------- #
def write_excel_report(results: List[DownloadResult], report_path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Downloads"

    headers = ["Full URL", "File Name", "Download Status", "Error"]
    ws.append(headers)
    header_fill = PatternFill("solid", start_color="1F4E78")
    for col in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=col)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")

    red = Font(color="C00000", bold=True)
    green = Font(color="2E7D32", bold=True)
    for r in results:
        ws.append([r.full_url, r.file_name, r.status, r.error])
        status_cell = ws.cell(row=ws.max_row, column=3)
        status_cell.font = green if r.status == STATUS_SUCCESS else red

    widths = {1: 70, 2: 40, 3: 18, 4: 70}
    for idx, w in widths.items():
        ws.column_dimensions[get_column_letter(idx)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    report_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(report_path)
    log.info("Excel report written: %s", report_path)


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Download PILL4R files listed in Snowflake.")
    p.add_argument("--base-url", default=os.getenv("PILL4R_BASE_URL", DEFAULT_BASE_URL))
    p.add_argument("--config", default=os.getenv("DQE_CONFIG", DEFAULT_CONFIG))
    p.add_argument("--section", default=DEFAULT_SECTION)
    p.add_argument("--table", default=DEFAULT_TABLE)
    p.add_argument("--column", default=DEFAULT_URL_COLUMN, help="URL column (case-sensitive in Snowflake)")
    p.add_argument("--input-csv", help="Read paths from a CSV instead of Snowflake (testing)")
    p.add_argument("--limit", type=int, help="Max number of URLs to process")
    p.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    p.add_argument("--report", help="Excel report path (default: <output-dir>/download_report_<timestamp>.xlsx)")
    p.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    p.add_argument("--force", action="store_true", help="Re-download files that already exist")
    p.add_argument("--ca-bundle", default=os.getenv("PILL4R_CA_BUNDLE"),
                   help="Path to corporate CA bundle (PEM) for SSL verification")
    p.add_argument("--insecure", action="store_true", help="Disable SSL verification (NOT recommended)")
    p.add_argument("--verbose", "-v", action="store_true")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("snowflake").setLevel(logging.WARNING)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = Path(args.report) if args.report else out_dir / f"download_report_{ts}.xlsx"

    # 1) Get paths
    if args.input_csv:
        paths = read_paths_from_csv(args.input_csv, args.column)
        if args.limit:
            paths = paths[: args.limit]
    else:
        paths = fetch_paths_from_snowflake(args.config, args.section, args.table, args.column, args.limit)

    full_urls = dedupe_preserve_order([build_full_url(args.base_url, p) for p in paths])
    if not full_urls:
        log.warning("No URLs to process.")
        return 0
    log.info("Processing %d unique URLs with %d workers", len(full_urls), args.workers)

    # 2) HTTP session
    if args.insecure:
        verify: object = False
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        log.warning("SSL verification disabled")
    else:
        verify = args.ca_bundle or True
    session = build_session(args.workers, verify, os.getenv("PILL4R_TOKEN"))

    # 3) Download concurrently; always write the report
    results_by_url: Dict[str, DownloadResult] = {}
    interrupted = False
    started = time.time()
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(download_one, session, u, out_dir, DEFAULT_TIMEOUT, args.force): u
                for u in full_urls
            }
            done = 0
            try:
                for fut in as_completed(futures):
                    res = fut.result()
                    results_by_url[res.full_url] = res
                    done += 1
                    if res.status == STATUS_FAIL:
                        log.warning("[%d/%d] FAIL %s -> %s", done, len(full_urls), res.full_url, res.error)
                    elif done % 25 == 0 or done == len(full_urls):
                        log.info("[%d/%d] done", done, len(full_urls))
            except KeyboardInterrupt:
                interrupted = True
                log.error("Interrupted: cancelling pending downloads...")
                for f in futures:
                    f.cancel()
    finally:
        session.close()
        # Preserve original order; mark anything unfinished
        ordered = [
            results_by_url.get(u, DownloadResult(u, "", STATUS_FAIL, "Not processed (interrupted)"))
            for u in full_urls
        ]
        write_excel_report(ordered, report_path)

    ok = sum(1 for r in results_by_url.values() if r.status == STATUS_SUCCESS)
    failed = len(full_urls) - ok
    log.info("Finished in %.1fs | success=%d fail=%d | files in %s",
             time.time() - started, ok, failed, out_dir.resolve())
    if interrupted:
        return 130
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())