"""
Parser de correos de notificación de transacciones.
Por ahora soporta el formato de BAC Credomatic (notificacionesbaccr.com).
Diseñado para poder agregar más bancos después sin tocar el resto del sistema.
"""
import email
from email import policy
import re
from datetime import datetime


def _html_to_text(html: str) -> str:
    text = re.sub(r"<style.*?</style>", "", html, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = text.replace("&nbsp;", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def _extract_html(msg) -> str | None:
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            try:
                return part.get_content()
            except Exception:
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or "utf-8"
                return payload.decode(charset, errors="replace")
    return None


def _parse_monto(raw: str):
    """'CRC 1,600.00' -> (1600.00, 'CRC')"""
    raw = raw.strip()
    match = re.match(r"([A-Z]{3})\s*([\d,]+\.?\d*)", raw)
    if not match:
        return None, None
    moneda = match.group(1)
    monto = float(match.group(2).replace(",", ""))
    return monto, moneda


_MESES_ES_A_EN = {
    "ene": "Jan", "feb": "Feb", "mar": "Mar", "abr": "Apr",
    "may": "May", "jun": "Jun", "jul": "Jul", "ago": "Aug",
    "sep": "Sep", "oct": "Oct", "nov": "Nov", "dic": "Dec",
}


def _parse_fecha_bac(raw: str):
    """'Jun 18, 2026, 18:39' o 'Abr 16, 2026, 18:44' (mes en español) -> datetime"""
    raw = raw.strip()
    mes_actual = raw.split(" ", 1)[0]
    mes_en = _MESES_ES_A_EN.get(mes_actual.lower())
    if mes_en:
        raw = mes_en + raw[len(mes_actual):]
    try:
        return datetime.strptime(raw, "%b %d, %Y, %H:%M")
    except ValueError:
        return None


def parse_bac(text: str) -> dict | None:
    """Extrae los campos de una notificación de transacción del BAC a partir del texto plano."""

    def campo(etiqueta, texto):
        # Captura la línea siguiente a la etiqueta exacta
        pattern = re.escape(etiqueta) + r"\n(.+?)\n"
        m = re.search(pattern, texto)
        return m.group(1).strip() if m else None

    comercio = campo("Comercio:", text)
    ciudad = campo("Ciudad y país:", text)
    fecha_raw = campo("Fecha:", text)
    autorizacion = campo("Autorización:", text)
    referencia = campo("Referencia:", text)
    tipo = campo("Tipo de Transacción:", text)
    monto_raw = campo("Monto:", text)

    # La tarjeta está en la línea justo antes de "Autorización:" (ej. "MASTER\n************1620")
    tarjeta = None
    m = re.search(r"\n([A-Z]+)\n(\*+\d{3,4})\nAutorización:", text)
    if m:
        tarjeta = f"{m.group(1)} {m.group(2)}"

    if not comercio or not monto_raw:
        return None

    monto, moneda = _parse_monto(monto_raw)
    fecha_dt = _parse_fecha_bac(fecha_raw) if fecha_raw else None

    return {
        "comercio": comercio,
        "ciudad": ciudad,
        "fecha": fecha_dt.isoformat() if fecha_dt else None,
        "fecha_texto_original": fecha_raw,
        "monto": monto,
        "moneda": moneda or "CRC",
        "tarjeta": tarjeta,
        "autorizacion": autorizacion,
        "referencia": referencia,
        "tipo_transaccion": tipo,
        "banco": "BAC",
    }


def parse_eml_bytes(raw_bytes: bytes) -> dict | None:
    """Punto de entrada principal: recibe los bytes crudos de un .eml y devuelve los datos extraídos."""
    msg = email.message_from_bytes(raw_bytes, policy=policy.default)
    html = _extract_html(msg)
    if not html:
        return None
    text = _html_to_text(html)

    remitente = msg.get("From", "")

    # Detectar banco por remitente. Se puede extender con más parsers aquí.
    if "notificacionesbaccr.com" in remitente:
        return parse_bac(text)

    # Si no reconocemos el remitente, intentamos igual con el parser de BAC
    # por si el remitente viene con un alias distinto, y si falla devolvemos None.
    resultado = parse_bac(text)
    return resultado


if __name__ == "__main__":
    import sys
    with open(sys.argv[1], "rb") as f:
        datos = parse_eml_bytes(f.read())
    print(datos)
