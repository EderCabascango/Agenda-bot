"""Fija o restablece la contraseña del dueño de la app (no hay registro público).

Uso, desde la carpeta backend:
    .venv\\Scripts\\python set_password.py            # la pide por teclado sin mostrarla
    echo <clave> | python set_password.py --stdin     # para scripts y tests

Cerrará las sesiones abiertas en todos los dispositivos.
"""
import argparse
import getpass
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

import db  # noqa: E402
from auth import hash_password, owner_email, owner_user_id, validate_new_password  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stdin", action="store_true", help="lee la contraseña de la entrada estándar")
    args = parser.parse_args()

    if not owner_email():
        print("Falta OWNER_EMAIL en backend/.env (el correo con el que vas a iniciar sesión).", file=sys.stderr)
        return 1

    if args.stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    else:
        password = getpass.getpass(f"Nueva contraseña para {owner_email()}: ")
        if password != getpass.getpass("Repítela: "):
            print("Las contraseñas no coinciden.", file=sys.stderr)
            return 1

    try:
        validate_new_password(password)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1

    db.set_password_hash(owner_user_id(), hash_password(password))
    print(f"Contraseña guardada para {owner_email()}. Las sesiones anteriores quedaron cerradas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
