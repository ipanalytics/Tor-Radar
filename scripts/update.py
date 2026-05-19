#!/usr/bin/env python3
import csv
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CURRENT = DATA / "current"
SNAPSHOTS = DATA / "snapshots"
HISTORY = DATA / "history"
CACHE = DATA / "cache"

DAN_URL = "https://www.dan.me.uk/torlist/?full"
ONIONOO_URL = (
    "https://onionoo.torproject.org/details"
    "?type=relay&fields=fingerprint,nickname,or_addresses,dir_address,"
    "last_seen,first_seen,flags,country,country_name,as,as_name,"
    "platform,version,advertised_bandwidth,exit_policy,contact"
)

RETENTION_SNAPSHOTS = int(os.environ.get("TOR_RADAR_SNAPSHOT_RETENTION", "168"))
RETENTION_HISTORY_ROWS = int(os.environ.get("TOR_RADAR_HISTORY_RETENTION", "720"))
DAN_REFRESH_HOURS = int(os.environ.get("TOR_RADAR_DAN_REFRESH_HOURS", "6"))
USER_AGENT = os.environ.get(
    "TOR_RADAR_USER_AGENT",
    "TorRadar/0.1 (+https://github.com/your-org/tor-radar; contact: ops@example.com)",
)


def fetch_text(url, timeout=60):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def fetch_optional_text(url, timeout=60):
    try:
        return fetch_text(url, timeout), None
    except (urllib.error.URLError, TimeoutError) as exc:
        return "", str(exc)


def read_json(path, default):
    try:
        with path.open() as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")
    tmp.replace(path)


def parse_ips(text):
    ips = set()
    for line in text.splitlines():
        item = line.strip()
        if not item or item.startswith("#"):
            continue
        try:
            ips.add(str(ipaddress.ip_address(item)))
        except ValueError:
            continue
    return ips


def load_dan_cache(now):
    cache = read_json(CACHE / "dan.json", {})
    fetched_at = cache.get("fetchedAt")
    ips = set(cache.get("ips") or [])
    if not fetched_at:
        return ips, None, True
    try:
        fetched = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    except ValueError:
        return ips, fetched_at, True
    age_hours = (now - fetched).total_seconds() / 3600
    return ips, fetched_at, age_hours >= DAN_REFRESH_HOURS


def get_dan_ips(now):
    cached_ips, fetched_at, should_refresh = load_dan_cache(now)
    if not should_refresh:
        return cached_ips, {
            "url": DAN_URL,
            "ok": bool(cached_ips),
            "mode": "cache",
            "fetchedAt": fetched_at,
            "count": len(cached_ips),
            "error": None,
        }

    dan_text, dan_error = fetch_optional_text(DAN_URL)
    fresh_ips = parse_ips(dan_text)
    if fresh_ips:
        fetched_at = now.isoformat().replace("+00:00", "Z")
        write_json(CACHE / "dan.json", {"fetchedAt": fetched_at, "ips": sorted(fresh_ips)})
        return fresh_ips, {
            "url": DAN_URL,
            "ok": True,
            "mode": "fresh",
            "fetchedAt": fetched_at,
            "count": len(fresh_ips),
            "error": None,
        }

    return cached_ips, {
        "url": DAN_URL,
        "ok": bool(cached_ips),
        "mode": "cache_after_error" if cached_ips else "unavailable",
        "fetchedAt": fetched_at,
        "count": len(cached_ips),
        "error": dan_error,
    }


def relay_ips(relay):
    out = set()
    for addr in relay.get("or_addresses") or []:
        host = addr.rsplit(":", 1)[0]
        if host.startswith("[") and "]" in host:
            host = host[1 : host.index("]")]
        try:
            out.add(str(ipaddress.ip_address(host)))
        except ValueError:
            pass
    dir_addr = relay.get("dir_address")
    if dir_addr:
        host = dir_addr.rsplit(":", 1)[0]
        try:
            out.add(str(ipaddress.ip_address(host)))
        except ValueError:
            pass
    return out


def role_from_flags(flags):
    flags = set(flags or [])
    if "Exit" in flags:
        return "exit"
    if "Guard" in flags:
        return "guard"
    return "middle"


def normalize_asn(value):
    if not value:
        return "unknown"
    value = str(value).strip()
    if value.upper().startswith("AS"):
        return value.upper()
    return f"AS{value}"


def top(counter, limit=15):
    return [{"key": key, "count": count} for key, count in counter.most_common(limit)]


def bandwidth_top(rows, key, limit=15):
    totals = defaultdict(int)
    for row in rows:
        totals[row.get(key) or "unknown"] += int(row.get("bandwidth") or 0)
    return [
        {"key": name, "bandwidth": value}
        for name, value in sorted(totals.items(), key=lambda item: item[1], reverse=True)[:limit]
    ]


def append_jsonl(path, row, max_rows):
    rows = []
    if path.exists():
        rows = path.read_text().splitlines()
    rows.append(json.dumps(row, sort_keys=True))
    rows = rows[-max_rows:]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(rows) + "\n")


def append_csv(path, fieldnames, row, max_rows):
    old_rows = []
    if path.exists():
        with path.open() as f:
            old_rows = list(csv.DictReader(f))
    old_rows.append({key: row.get(key, "") for key in fieldnames})
    old_rows = old_rows[-max_rows:]
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(old_rows)


def compact_relay(relay, ips, in_dan):
    flags = relay.get("flags") or []
    asn = normalize_asn(relay.get("as"))
    as_name = relay.get("as_name") or "unknown"
    return {
        "fingerprint": relay.get("fingerprint"),
        "nickname": relay.get("nickname") or "",
        "role": role_from_flags(flags),
        "flags": flags,
        "ips": sorted(ips),
        "inDanList": bool(in_dan),
        "country": (relay.get("country") or "??").upper(),
        "countryName": relay.get("country_name") or "Unknown",
        "asn": asn,
        "asName": as_name,
        "firstSeen": relay.get("first_seen"),
        "lastSeen": relay.get("last_seen"),
        "version": relay.get("version") or "",
        "platform": relay.get("platform") or "",
        "bandwidth": int(relay.get("advertised_bandwidth") or 0),
        "exitPolicy": relay.get("exit_policy") or [],
        "contactHash": stable_contact_hash(relay.get("contact") or ""),
    }


def stable_contact_hash(contact):
    if not contact:
        return ""
    # Not cryptographic secrecy; just lets the UI cluster repeated contacts without exposing them.
    import hashlib

    return hashlib.sha256(contact.encode("utf-8", "replace")).hexdigest()[:12]


def build_insights(current, previous):
    insights = []
    delta_relays = current["summary"]["relays"] - previous.get("summary", {}).get("relays", current["summary"]["relays"])
    delta_exits = current["summary"]["exits"] - previous.get("summary", {}).get("exits", current["summary"]["exits"])
    delta_bandwidth = current["summary"]["bandwidth"] - previous.get("summary", {}).get("bandwidth", current["summary"]["bandwidth"])

    insights.append(
        {
            "title": "Hourly movement",
            "value": f"{delta_relays:+d} relays, {delta_exits:+d} exits",
            "detail": f"Advertised bandwidth changed by {delta_bandwidth:+,} bytes/s since the previous run.",
            "kind": "change",
        }
    )

    for item in current["aggregates"]["asnBandwidth"][:3]:
        pct = item["bandwidth"] / max(current["summary"]["bandwidth"], 1) * 100
        insights.append(
            {
                "title": "Infrastructure concentration",
                "value": f"{item['key']} at {pct:.1f}%",
                "detail": "Share of total advertised relay bandwidth in one autonomous system.",
                "kind": "concentration",
            }
        )

    new_fingerprints = set(current["fingerprints"]) - set(previous.get("fingerprints", []))
    gone_fingerprints = set(previous.get("fingerprints", [])) - set(current["fingerprints"])
    insights.append(
        {
            "title": "Churn",
            "value": f"{len(new_fingerprints)} new, {len(gone_fingerprints)} gone",
            "detail": "Fingerprint-level changes compared with the previous snapshot.",
            "kind": "churn",
        }
    )
    return insights[:6]


def prune_snapshots():
    files = sorted(SNAPSHOTS.glob("*.json"))
    for path in files[:-RETENTION_SNAPSHOTS]:
        path.unlink()


def main():
    now = datetime.now(timezone.utc).replace(microsecond=0)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    generated_at = now.isoformat().replace("+00:00", "Z")

    CURRENT.mkdir(parents=True, exist_ok=True)
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    HISTORY.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    dan_ips, dan_source = get_dan_ips(now)
    onionoo = json.loads(fetch_text(ONIONOO_URL))
    relays_raw = onionoo.get("relays") or []

    relays = []
    all_ips = set()
    for relay in relays_raw:
        ips = relay_ips(relay)
        if not ips:
            continue
        all_ips.update(ips)
        relays.append(compact_relay(relay, ips, bool(ips & dan_ips)))

    by_role = Counter(row["role"] for row in relays)
    by_country = Counter(row["country"] for row in relays)
    by_asn = Counter(row["asn"] for row in relays)
    by_version = Counter(row["version"] or "unknown" for row in relays)
    dan_only_ips = sorted(dan_ips - all_ips)

    bandwidth = sum(row["bandwidth"] for row in relays)
    previous = read_json(CURRENT / "network.json", {})

    current = {
        "generatedAt": generated_at,
        "source": {
            "dan": {
                **dan_source,
                "refreshHours": DAN_REFRESH_HOURS,
            },
            "onionoo": {
                "url": ONIONOO_URL,
                "ok": True,
                "published": onionoo.get("relays_published"),
            },
        },
        "summary": {
            "relays": len(relays),
            "ips": len(all_ips),
            "danIps": len(dan_ips),
            "danOnlyIps": len(dan_only_ips),
            "guards": by_role.get("guard", 0),
            "middles": by_role.get("middle", 0),
            "exits": by_role.get("exit", 0),
            "countries": len(by_country),
            "asns": len(by_asn),
            "bandwidth": bandwidth,
        },
        "aggregates": {
            "roles": dict(by_role),
            "countries": top(by_country, 25),
            "asns": top(by_asn, 25),
            "versions": top(by_version, 12),
            "asnBandwidth": bandwidth_top(relays, "asn", 20),
            "countryBandwidth": bandwidth_top(relays, "country", 20),
        },
        "insights": [],
        "relays": sorted(relays, key=lambda row: row["bandwidth"], reverse=True),
        "danOnlySample": dan_only_ips[:500],
        "fingerprints": sorted(row["fingerprint"] for row in relays if row.get("fingerprint")),
    }
    current["insights"] = build_insights(current, previous)

    snapshot_path = SNAPSHOTS / f"{stamp}.json"
    write_json(snapshot_path, current)
    write_json(CURRENT / "network.json", current)
    write_json(CURRENT / "latest.json", {"generatedAt": generated_at, "snapshot": f"../snapshots/{stamp}.json"})

    history_row = {
        "generatedAt": generated_at,
        **current["summary"],
    }
    append_jsonl(HISTORY / "summary.jsonl", history_row, RETENTION_HISTORY_ROWS)
    append_csv(
        HISTORY / "summary.csv",
        list(history_row.keys()),
        history_row,
        RETENTION_HISTORY_ROWS,
    )
    prune_snapshots()

    print(f"generated {snapshot_path.relative_to(ROOT)} relays={len(relays)} ips={len(all_ips)}")


if __name__ == "__main__":
    try:
        main()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"update failed: {exc}", file=sys.stderr)
        sys.exit(1)
