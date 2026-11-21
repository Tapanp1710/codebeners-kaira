# KAIRA Backend

KAIRA is an AI-powered, voice-first business operations backend for small businesses.

## Stack

- FastAPI, Pydantic v2 and pydantic-settings, Uvicorn, pytest, Ruff.
- Planned, not yet implemented: PostgreSQL, SQLAlchemy, Alembic, Sarvam AI speech and LLM integration.

## Project structure

```
app/        application code
  api/v1/   versioned API routers
  core/     configuration and shared core modules
  schemas/  Pydantic request and response models
tests/
  unit/     unit tests
  api/      HTTP API tests
docs/       project documentation
```

## Prerequisites

- Python 3.11 or newer on Windows.

## Setup

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Then edit `.env` locally. Never commit it.

## Run

```
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## Endpoints

- `GET /health`
- `GET /ready`
- `GET /api/v1/health`
- `GET /api/v1/ready`
- `GET /docs`
- `GET /openapi.json`

## Tests

```
.venv\Scripts\python.exe -m pytest
```

## Lint and format

```
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe -m ruff format --check .
```

## Status

PostgreSQL configuration, SQLAlchemy models and Alembic migrations are NOT implemented yet (Milestone 2). `/ready` reports database as `not_implemented`.

## CORS

Allowed origins come from `CORS_ORIGINS` in `.env` (comma-separated). Default: `http://localhost:3000`. To allow another frontend origin, add it to `CORS_ORIGINS`.
