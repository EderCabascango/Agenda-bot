"""Ciclo de agenda: del día 15 de un mes al día 14 del siguiente.

Lógica determinista: el LLM nunca calcula fechas por su cuenta.
"""
from datetime import date, timedelta


def get_cycle(d: date) -> tuple[date, date]:
    """Devuelve (inicio, fin) del ciclo 15→14 que contiene la fecha `d`."""
    if d.day >= 15:
        start = date(d.year, d.month, 15)
    else:
        prev_last = d.replace(day=1) - timedelta(days=1)
        start = date(prev_last.year, prev_last.month, 15)
    # fin = día 14 del mes siguiente al inicio
    ny, nm = (start.year + 1, 1) if start.month == 12 else (start.year, start.month + 1)
    end = date(ny, nm, 14)
    return start, end
