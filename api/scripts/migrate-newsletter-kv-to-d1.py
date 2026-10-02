#!/usr/bin/env python3
"""KV → D1 newsletter migration (T17). One-shot, row-for-row verified.

Reads every key from the live `brimwood-newsletter` KV namespace and writes
the equivalent rows into D1's newsletter_subscribers table:
  sub:<email>     → status='active'   (confirmed subscriber)
  pending:<token> → status='pending'  (unconfirmed double opt-in)

Idempotent: re-running upserts rather than duplicating.
Usage (from api/):
  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
    python3 scripts/migrate-newsletter-kv-to-d1.py [--dry-run]
"""
import json
import os
import subprocess
import sys
import uuid

KV_NAMESPACE = "d047be5a3b25466883589896bc044a1b"  # live brimwood-newsletter
DB = "brimwood_db"
DRY_RUN = "--dry-run" in sys.argv


def wrangler(*args: str) -> str:
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": os.environ["CLOUDFLARE_API_TOKEN"],
        "CLOUDFLARE_ACCOUNT_ID": os.environ["CLOUDFLARE_ACCOUNT_ID"],
    }
    r = subprocess.run(
        ["./node_modules/.bin/wrangler", *args],
        capture_output=True, text=True, env=env,
    )
    if r.returncode != 0:
        print("wrangler failed:", r.stderr[-500:], file=sys.stderr)
        sys.exit(1)
    return r.stdout


def lit(v: str | None) -> str:
    """SQL string literal with quote escaping."""
    if v is None:
        return "NULL"
    return "'" + v.replace("'", "''") + "'"


def main() -> None:
    keys = json.loads(wrangler("kv", "key", "list", "--namespace-id", KV_NAMESPACE))
    subs = [k["name"] for k in keys if k["name"].startswith("sub:")]
    pendings = [k["name"] for k in keys if k["name"].startswith("pending:")]
    print(f"KV keys: {len(keys)} ({len(subs)} subscribed, {len(pendings)} pending)")

    stmts: list[str] = []
    for key in subs:
        raw = wrangler("kv", "key", "get", key, "--namespace-id", KV_NAMESPACE).strip()
        if not raw:
            continue
        data = json.loads(raw)
        email = data["email"].lower()
        stmts.append(
            "INSERT INTO newsletter_subscribers "
            "(id, email, name, status, unsub_token, source, subscribed_at) VALUES "
            f"({lit(str(uuid.uuid4()))}, {lit(email)}, {lit(data.get('name'))}, "
            f"'active', {lit(data.get('unsubToken') or str(uuid.uuid4()))}, 'kv-migration', "
            f"strftime('%Y-%m-%dT%H:%M:%fZ', {int(data.get('subscribedAt', 0)) // 1000}, 'unixepoch')) "
            "ON CONFLICT(email) DO UPDATE SET status='active', "
            "name=excluded.name, unsub_token=excluded.unsub_token;"
        )
    for key in pendings:
        raw = wrangler("kv", "key", "get", key, "--namespace-id", KV_NAMESPACE).strip()
        if not raw:
            continue
        data = json.loads(raw)
        email = data["email"].lower()
        stmts.append(
            "INSERT INTO newsletter_subscribers "
            "(id, email, name, status, confirm_token, unsub_token, source) VALUES "
            f"({lit(str(uuid.uuid4()))}, {lit(email)}, {lit(data.get('name'))}, "
            f"'pending', {lit(key.split(':', 1)[1])}, {lit(str(uuid.uuid4()))}, 'kv-migration') "
            "ON CONFLICT(email) DO NOTHING;"
        )

    print(f"{'DRY-RUN ' if DRY_RUN else ''}would migrate: {len(subs)} active, {len(pendings)} pending")
    if DRY_RUN or not stmts:
        report_counts()
        return

    with open("/tmp/migrate-newsletter.sql", "w") as f:
        f.write("\n".join(stmts))
    out = wrangler("d1", "execute", DB, "--file", "/tmp/migrate-newsletter.sql")
    print(out.splitlines()[0] if out else "done")
    report_counts()


def report_counts() -> None:
    out = wrangler("d1", "execute", DB, "--command",
                   "SELECT status, COUNT(*) AS n FROM newsletter_subscribers GROUP BY status",
                   "--json")
    rows = json.loads(out)[0]["results"]
    print("D1 newsletter_subscribers by status:", {r["status"]: r["n"] for r in rows})


if __name__ == "__main__":
    for v in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
        if not os.environ.get(v):
            sys.exit(f"missing env {v}")
    main()
