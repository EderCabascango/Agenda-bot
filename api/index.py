"""Punto de entrada de Vercel: expone la app FastAPI de backend/main.py."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from main import app  # noqa: E402,F401
