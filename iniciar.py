#!/usr/bin/env python3
"""
Iniciar la app de finanzas personales en modo local.
Doble clic (o "python3 iniciar.py" desde la terminal) y se abre solo en el navegador.

Necesita un archivo .env en esta misma carpeta con las variables de entorno
(ver .env.example) apuntando a tu proyecto de Supabase.
"""
import subprocess
import sys
import os
import webbrowser
import time
import threading

CARPETA = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(CARPETA, "backend")
REQUIREMENTS = os.path.join(BACKEND, "requirements.txt")

# El flujo OAuth de Google exige HTTPS por defecto. En local corremos sobre
# http://127.0.0.1, así que le avisamos a la librería que está bien (solo
# para desarrollo: esto nunca se setea en Render, que sí sirve por HTTPS).
os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")


def instalar_dependencias():
    print("Revisando dependencias (solo la primera vez puede tardar un poco)...")
    subprocess.run(
        [
            sys.executable, "-m", "pip", "install",
            "-r", REQUIREMENTS,
            "--quiet", "--break-system-packages",
        ],
        capture_output=True,
    )


def abrir_navegador():
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:5050")


def main():
    if not os.path.exists(os.path.join(CARPETA, ".env")):
        print("\nFalta el archivo .env en la raíz del proyecto.")
        print("Copiá .env.example a .env y completá tus credenciales de Supabase antes de continuar.\n")
        sys.exit(1)

    instalar_dependencias()

    sys.path.insert(0, BACKEND)
    os.chdir(BACKEND)

    # Importar app.py ya corre init_db() (lo hace al cargarse el módulo, para
    # que funcione igual con gunicorn en producción). No hace falta llamarlo
    # de nuevo acá: una sola conexión a la base en vez de dos.
    from app import app

    threading.Thread(target=abrir_navegador, daemon=True).start()

    print("\n" + "=" * 50)
    print("  Tu app de finanzas está lista")
    print("  Abrila en: http://127.0.0.1:5050")
    print("  Para cerrarla: presioná Ctrl+C en esta ventana")
    print("=" * 50 + "\n")

    app.run(host="127.0.0.1", port=5050, debug=False)


if __name__ == "__main__":
    main()
