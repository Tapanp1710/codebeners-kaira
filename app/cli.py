"""Operational commands - no SQL or code edits needed by the owner.

python -m app.cli check-config      validate .env and report problems
python -m app.cli wait-db [--timeout 60]
python -m app.cli migrate           apply Alembic migrations (alembic upgrade head)
python -m app.cli seed              idempotent demo data (development only)
python -m app.cli create-owner --business "Name" --email you@x.com --name "You" [--opening-cash 0]
                                    first production account (password read from KAIRA_OWNER_PASSWORD
                                    or prompted)
python -m app.cli export-openapi [path]
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
import sys
import time
from datetime import date
from decimal import Decimal
from pathlib import Path


# Config errors go to stderr with exit code 2, so every subcommand fails the same way.
def _settings():
    from app.core.config import ConfigurationError, get_settings

    try:
        return get_settings()
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)


def cmd_check_config(_: argparse.Namespace) -> int:
    s = _settings()
    # Only the text after '@' (host/db) is printed to avoid echoing credentials. If the URL has
    # no '@', the whole string is printed.
    print(f"APP_ENV={s.APP_ENV}  database={s.DATABASE_URL.split('@')[-1]}")
    print(
        f"Voice/AI provider: {'Sarvam configured' if s.sarvam_configured else 'NOT configured (typed input only)'}"
    )
    print(f"Extraction provider: {s.extraction_provider}")
    print(f"CORS origins: {', '.join(s.CORS_ORIGINS)}")
    print("Configuration OK")
    return 0


def cmd_wait_db(args: argparse.Namespace) -> int:
    from app.db.session import build_engine, database_is_reachable

    engine = build_engine(_settings())
    # Fixed 2-second polling interval; each probe opens and closes its own connection.
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if database_is_reachable(engine):
            print("Database is reachable")
            return 0
        time.sleep(2)
    print(f"Database not reachable after {args.timeout}s", file=sys.stderr)
    return 1


def cmd_migrate(_: argparse.Namespace) -> int:
    from app.db.migrations import upgrade_to_head

    upgrade_to_head(_settings().DATABASE_URL)
    print("Migrations applied (head)")
    return 0


# Builds a new engine per call and never disposes it; fine for a one-shot process.
# Callers must close the returned session.
def _session():
    from app.db.session import build_engine, build_session_factory

    return build_session_factory(build_engine(_settings()))()


def cmd_seed(args: argparse.Namespace) -> int:
    from app.seed import seed_demo

    s = _settings()
    # Guard against seeding demo data into staging/production unless --force is passed.
    if s.is_production_like and not args.force:
        print("Refusing to seed demo data in staging/production (use --force to override).", file=sys.stderr)
        return 2
    # With no DEMO_OWNER_PASSWORD, a random one is generated; it is printed once and not written
    # to disk by this command.
    password = s.DEMO_OWNER_PASSWORD
    generated = False
    if not password:
        password = secrets.token_urlsafe(12)
        generated = True
    db = _session()
    try:
        result = seed_demo(
            db, owner_email=s.DEMO_OWNER_EMAIL, owner_password=password, timezone=s.DEFAULT_TIMEZONE
        )
        db.commit()
    finally:
        db.close()
    print(f"Demo data ready for {result['owner_email']} (business {result['business_id']})")
    # The password is printed only when this run created the owner account.
    if result["created_owner"] and generated:
        print(f"Generated demo owner password (shown once): {password}")
    elif result["created_owner"]:
        print("Demo owner password: value of DEMO_OWNER_PASSWORD in .env")
    return 0


def cmd_create_owner(args: argparse.Namespace) -> int:
    from sqlalchemy import select

    from app.core.security import hash_password
    from app.models import Business, User
    from app.utils.dates import business_today

    s = _settings()
    # Password comes from KAIRA_OWNER_PASSWORD or an interactive prompt, never a CLI argument,
    # so it does not appear in shell history.
    password = os.environ.get("KAIRA_OWNER_PASSWORD") or getpass.getpass("Owner password (min 10 chars): ")
    if len(password) < 10:
        print("Password must be at least 10 characters.", file=sys.stderr)
        return 2
    db = _session()
    try:
        # Idempotent: an existing e-mail exits 0 without changes (lowercased lookup).
        if db.scalar(select(User).where(User.email == args.email.lower())):
            print("A user with that e-mail already exists; nothing changed.")
            return 0
        # Decimal() and date.fromisoformat() raise on malformed --opening-cash or
        # --opening-date values. No guard here, so bad input ends the command with a traceback.
        business = Business(
            name=args.business,
            business_type=args.business_type,
            currency=s.DEFAULT_CURRENCY,
            timezone=s.DEFAULT_TIMEZONE,
            opening_cash_balance=Decimal(args.opening_cash),
            opening_cash_as_of=date.fromisoformat(args.opening_date)
            if args.opening_date
            else business_today(s.DEFAULT_TIMEZONE),
            overdue_collection_delay_days=s.DEFAULT_OVERDUE_COLLECTION_DELAY_DAYS,
        )
        db.add(business)
        # flush() assigns business.id so the owner User can reference it before the commit.
        db.flush()
        db.add(
            User(
                business_id=business.id,
                name=args.name,
                email=args.email.lower(),
                password_hash=hash_password(password),
                role="owner",
            )
        )
        db.commit()
        print(f"Created business '{business.name}' with owner {args.email.lower()}")
    finally:
        db.close()
    return 0


def cmd_export_openapi(args: argparse.Namespace) -> int:
    from app.main import create_app

    # Builds the app only to introspect routes. The engine is lazy, so no database connection
    # is needed and lifespan startup does not run.
    spec = create_app(_settings()).openapi()
    path = Path(args.path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"OpenAPI written to {path} ({len(spec['paths'])} paths)")
    return 0


# Each subcommand stores its handler with set_defaults(func=...); main dispatches on args.func.
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check-config").set_defaults(func=cmd_check_config)
    p = sub.add_parser("wait-db")
    p.add_argument("--timeout", type=int, default=60)
    p.set_defaults(func=cmd_wait_db)
    sub.add_parser("migrate").set_defaults(func=cmd_migrate)
    p = sub.add_parser("seed")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_seed)
    p = sub.add_parser("create-owner")
    p.add_argument("--business", required=True)
    p.add_argument("--business-type", default=None)
    p.add_argument("--email", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--opening-cash", default="0.00")
    p.add_argument("--opening-date", default=None, help="YYYY-MM-DD (default today)")
    p.set_defaults(func=cmd_create_owner)
    p = sub.add_parser("export-openapi")
    p.add_argument("path", nargs="?", default="docs/openapi.json")
    p.set_defaults(func=cmd_export_openapi)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
