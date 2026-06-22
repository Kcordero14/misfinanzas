"""
Integración con Gmail API (flujo OAuth web, apto para correr en un servidor
hosteado como Render — no abre un navegador local).

Flujo:
1. El usuario configura un cliente OAuth de tipo "Web application" en Google
   Cloud Console (una vez) y guarda su client id/secret como variables de
   entorno GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
2. Desde "Configurar" el usuario aprieta "Conectar Gmail": se le redirige a
   la pantalla de consentimiento de Google y vuelve a /api/gmail/callback.
3. El token (access + refresh) se guarda en la tabla sync_gmail, una fila por
   usuario, en vez de un archivo en disco: el disco de Render no es
   persistente entre reinicios/despliegues en el plan gratis.
4. listar_mensajes_nuevos() trae los correos con la etiqueta configurada que
   no se hayan importado todavía.
"""
import os
import json
import base64

try:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import Flow
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    LIBRERIAS_DISPONIBLES = True
except ImportError:
    LIBRERIAS_DISPONIBLES = False

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")


class GmailNoConfigurado(Exception):
    """Se lanza cuando faltan las credenciales de Google o no hay una cuenta de Gmail conectada."""
    pass


def hay_credenciales_configuradas() -> bool:
    return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)


def hay_sesion_activa(conn, user_id) -> bool:
    row = conn.execute(
        "SELECT token_json FROM sync_gmail WHERE user_id = ?", (user_id,)
    ).fetchone()
    return bool(row and row["token_json"])


def _client_config():
    return {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }


def generar_url_autorizacion(redirect_uri: str):
    """Arma la URL de consentimiento de Google. Devuelve (url, state, code_verifier).

    Google exige PKCE: el code_verifier generado acá tiene que volver a usarse
    tal cual al intercambiar el code por el token en procesar_callback, así
    que quien llame a esta función debe guardarlo (p. ej. en la sesión) junto
    con el state."""
    if not hay_credenciales_configuradas():
        raise GmailNoConfigurado(
            "Faltan las variables de entorno GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET."
        )
    flow = Flow.from_client_config(_client_config(), scopes=SCOPES, redirect_uri=redirect_uri)
    url, state = flow.authorization_url(
        access_type="offline", include_granted_scopes="true", prompt="consent"
    )
    return url, state, flow.code_verifier


def procesar_callback(conn, user_id, redirect_uri: str, code: str, code_verifier: str):
    """Intercambia el code de autorización por tokens y los guarda en sync_gmail."""
    flow = Flow.from_client_config(
        _client_config(), scopes=SCOPES, redirect_uri=redirect_uri, code_verifier=code_verifier
    )
    flow.fetch_token(code=code)
    creds = flow.credentials
    conn.execute(
        "UPDATE sync_gmail SET token_json = ? WHERE user_id = ?",
        (creds.to_json(), user_id),
    )
    conn.commit()


def desconectar(conn, user_id):
    """Borra el token guardado, para forzar un nuevo login la próxima vez."""
    conn.execute("UPDATE sync_gmail SET token_json = NULL WHERE user_id = ?", (user_id,))
    conn.commit()


def _obtener_credenciales(conn, user_id):
    """Devuelve credenciales válidas, refrescando si hace falta. Lanza
    GmailNoConfigurado si el usuario nunca conectó su cuenta de Gmail."""
    if not LIBRERIAS_DISPONIBLES:
        raise GmailNoConfigurado(
            "Faltan instalar las librerías de Google: "
            "pip install google-auth google-auth-oauthlib google-api-python-client"
        )
    if not hay_credenciales_configuradas():
        raise GmailNoConfigurado(
            "No hay credenciales de Gmail configuradas en el servidor "
            "(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)."
        )

    row = conn.execute(
        "SELECT token_json FROM sync_gmail WHERE user_id = ?", (user_id,)
    ).fetchone()
    if not row or not row["token_json"]:
        raise GmailNoConfigurado("Todavía no conectaste tu cuenta de Gmail.")

    creds = Credentials.from_authorized_user_info(json.loads(row["token_json"]), SCOPES)

    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            conn.execute(
                "UPDATE sync_gmail SET token_json = ? WHERE user_id = ?",
                (creds.to_json(), user_id),
            )
            conn.commit()
        else:
            raise GmailNoConfigurado("La sesión de Gmail expiró. Volvé a conectar tu cuenta.")

    return creds


def listar_mensajes_nuevos(conn, user_id, etiqueta: str, despues_de_id: str | None = None, max_resultados: int = 100):
    """
    Devuelve una lista de mensajes (id, raw bytes en formato .eml) de la etiqueta
    dada. Si se pasa despues_de_id, se detiene al encontrar ese id (ya importado).
    Gmail entrega los mensajes del más reciente al más viejo.
    """
    creds = _obtener_credenciales(conn, user_id)
    servicio = build("gmail", "v1", credentials=creds)

    resultados = []
    page_token = None

    try:
        # Buscar el id de la etiqueta por nombre (las etiquetas de usuario no son "INBOX"/"SENT")
        etiquetas = servicio.users().labels().list(userId="me").execute().get("labels", [])
        label_id = None
        for lbl in etiquetas:
            if lbl["name"].lower() == etiqueta.lower():
                label_id = lbl["id"]
                break
        if not label_id:
            return {"error": f'No se encontró la etiqueta "{etiqueta}" en tu Gmail.', "mensajes": []}

        detenido = False
        while not detenido:
            resp = servicio.users().messages().list(
                userId="me", labelIds=[label_id], maxResults=min(max_resultados, 100), pageToken=page_token
            ).execute()
            mensajes_pagina = resp.get("messages", [])

            for m in mensajes_pagina:
                if despues_de_id and m["id"] == despues_de_id:
                    detenido = True
                    break
                resultados.append(m["id"])
                if len(resultados) >= max_resultados:
                    detenido = True
                    break

            page_token = resp.get("nextPageToken")
            if not page_token:
                break

        # Descargar el contenido raw (.eml) de cada mensaje
        mensajes_completos = []
        for msg_id in resultados:
            raw_msg = servicio.users().messages().get(userId="me", id=msg_id, format="raw").execute()
            raw_bytes = base64.urlsafe_b64decode(raw_msg["raw"])
            mensajes_completos.append({"id": msg_id, "raw": raw_bytes})

        return {"error": None, "mensajes": mensajes_completos}

    except HttpError as e:
        return {"error": f"Error al conectar con Gmail: {e}", "mensajes": []}
