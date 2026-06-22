"""
Autenticación contra Supabase Auth (API REST).

La app no usa el cliente JS de Supabase: el navegador le habla a Flask como
siempre, y es Flask quien llama a Supabase Auth por HTTP. La sesión del
usuario se guarda en la cookie de sesión firmada de Flask (FLASK_SECRET_KEY).
"""
import os
import requests
from flask import session

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]

_HEADERS = {
    "apikey": SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
}


def registrar(correo, password):
    """Crea la cuenta en Supabase Auth. Devuelve (ok, mensaje_o_None)."""
    resp = requests.post(
        f"{SUPABASE_URL}/auth/v1/signup",
        headers=_HEADERS,
        json={"email": correo, "password": password},
        timeout=10,
    )
    data = resp.json()
    if resp.status_code >= 400:
        return False, data.get("msg") or data.get("error_description") or "No se pudo crear la cuenta."

    if data.get("access_token") and data.get("user"):
        _guardar_sesion(data)
        return True, None

    # El proyecto tiene "Confirm email" activado en Supabase: la cuenta se
    # creó pero no hay sesión todavía hasta que el usuario confirme el correo.
    return True, "confirmar_correo"


def iniciar_sesion(correo, password):
    """Inicia sesión contra Supabase Auth. Devuelve (ok, mensaje_de_error_o_None)."""
    resp = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers=_HEADERS,
        json={"email": correo, "password": password},
        timeout=10,
    )
    data = resp.json()
    if resp.status_code >= 400:
        return False, data.get("error_description") or data.get("msg") or "Correo o contraseña incorrectos."

    _guardar_sesion(data)
    return True, None


def cerrar_sesion():
    session.clear()


def usuario_actual():
    """Devuelve el user_id (UUID, como string) del usuario con sesión activa, o None."""
    return session.get("user_id")


def _guardar_sesion(data):
    session["user_id"] = data["user"]["id"]
    session["correo"] = data["user"].get("email")
