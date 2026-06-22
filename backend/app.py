"""
API para la app de finanzas personales.
Backend Flask + Postgres (Supabase), multiusuario: cada usuario solo ve sus
propios datos. Pensada para correr hosteada (Render) detrás de un proxy HTTPS.
"""
from functools import wraps

from flask import Flask, jsonify, request, send_from_directory, session, redirect
from werkzeug.middleware.proxy_fix import ProxyFix
from datetime import datetime, date
import calendar
import math
import os

from db import get_connection, init_db, asegurar_datos_iniciales
from parser import parse_eml_bytes
from categorizador import sugerir_categoria, aprender_categoria
import gmail_integracion as gmail
import auth

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ["FLASK_SECRET_KEY"]
# Render (y la mayoría de hosts) ponen la app detrás de un proxy HTTPS: sin esto,
# Flask cree que las requests son HTTP y arma mal la redirect_uri de Gmail OAuth.
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

# Categorías del sistema que no son gasto de consumo variable (van a ahorros,
# deudas o ya son fijos): se excluyen de los totales y gráficos de consumo.
CATEGORIAS_NO_CONSUMO = {"Ahorros", "Deudas", "Gastos fijos"}
CATEGORIAS_PROTEGIDAS = {"Ahorros", "Gastos fijos", "Deudas"}

init_db()


def requiere_login(f):
    """Exige sesión activa y pasa el user_id como primer argumento de la ruta."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        user_id = auth.usuario_actual()
        if not user_id:
            return jsonify({"error": "No hay sesión activa"}), 401
        return f(user_id, *args, **kwargs)
    return wrapper


# ---------- Servir el frontend ----------

@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(FRONTEND_DIR, filename)


# ---------- Autenticación ----------

@app.route("/api/auth/registro", methods=["POST"])
def auth_registro():
    data = request.get_json()
    correo = (data.get("correo") or "").strip()
    password = data.get("password") or ""
    if not correo or not password:
        return jsonify({"error": "Correo y contraseña son obligatorios"}), 400

    ok, mensaje = auth.registrar(correo, password)
    if not ok:
        return jsonify({"error": mensaje}), 400
    if mensaje == "confirmar_correo":
        return jsonify({"ok": True, "requiere_confirmacion": True})

    asegurar_datos_iniciales(auth.usuario_actual())
    return jsonify({"ok": True})


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json()
    correo = (data.get("correo") or "").strip()
    password = data.get("password") or ""
    ok, mensaje = auth.iniciar_sesion(correo, password)
    if not ok:
        return jsonify({"error": mensaje}), 401

    asegurar_datos_iniciales(auth.usuario_actual())
    return jsonify({"ok": True})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    auth.cerrar_sesion()
    return jsonify({"ok": True})


@app.route("/api/auth/sesion", methods=["GET"])
def auth_sesion():
    user_id = auth.usuario_actual()
    return jsonify({
        "sesion_activa": bool(user_id),
        "correo": session.get("correo") if user_id else None,
    })


# ---------- Configuración (salario) ----------

@app.route("/api/configuracion", methods=["GET"])
@requiere_login
def get_configuracion(user_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM configuracion WHERE user_id = ?", (user_id,)).fetchone()
    conn.close()
    return jsonify(dict(row))


@app.route("/api/configuracion", methods=["PUT"])
@requiere_login
def put_configuracion(user_id):
    data = request.get_json()
    conn = get_connection()
    config_actual = conn.execute("SELECT * FROM configuracion WHERE user_id = ?", (user_id,)).fetchone()
    dia_pago_q1 = data.get("dia_pago_q1", config_actual["dia_pago_q1"] if config_actual else 15)
    dia_pago_q2 = data.get("dia_pago_q2", config_actual["dia_pago_q2"] if config_actual else 30)
    # El día de pago de la quincena 1 siempre debe caer antes que el de la 2 dentro
    # del mes; si los mandan invertidos, se intercambian para que el cálculo de
    # "en qué quincena estamos hoy" no se rompa.
    if dia_pago_q1 >= dia_pago_q2:
        dia_pago_q1, dia_pago_q2 = dia_pago_q2, dia_pago_q1
    conn.execute(
        """UPDATE configuracion SET salario_total = ?, salario_q1 = ?, salario_q2 = ?,
           salario_moneda = ?, tipo_cambio = ?, moneda_visualizacion = ?,
           dia_pago_q1 = ?, dia_pago_q2 = ?
           WHERE user_id = ?""",
        (
            data["salario_total"],
            data["salario_q1"],
            data["salario_q2"],
            data.get("salario_moneda", "CRC"),
            data.get("tipo_cambio", 520),
            data.get("moneda_visualizacion", config_actual["moneda_visualizacion"] if config_actual else "CRC"),
            dia_pago_q1,
            dia_pago_q2,
            user_id,
        ),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/onboarding/completar", methods=["POST"])
@requiere_login
def completar_onboarding(user_id):
    conn = get_connection()
    conn.execute("UPDATE configuracion SET onboarding_completado = 1 WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Objetivos de largo plazo ----------

@app.route("/api/objetivos", methods=["GET"])
@requiere_login
def get_objetivos(user_id):
    conn = get_connection()
    rows = conn.execute("SELECT * FROM objetivos WHERE user_id = ? ORDER BY creado_en", (user_id,)).fetchall()
    objetivos = []
    for r in rows:
        o = dict(r)
        o["aporte_mensual_sugerido"] = round(o["monto_total"] / o["meses_plazo"], 2) if o["meses_plazo"] else 0
        o["porcentaje"] = round(min(o["acumulado"] / o["monto_total"] * 100, 100), 1) if o["monto_total"] else 0
        # Meses restantes según ritmo actual de aporte mensual sugerido
        restante = max(o["monto_total"] - o["acumulado"], 0)
        o["meses_restantes"] = (
            round(restante / o["aporte_mensual_sugerido"], 1)
            if o["aporte_mensual_sugerido"] else None
        )
        objetivos.append(o)
    conn.close()
    return jsonify(objetivos)


def _asegurar_rubro_fijo_de_objetivo(conn, user_id, objetivo_id):
    """Crea (si no existe) el rubro fijo derivado de un objetivo de largo plazo,
    con el aporte mensual sugerido (monto_total / meses_plazo) repartido en Q1.
    Se distingue de un rubro fijo manual por generado_de_objetivo = 1."""
    objetivo = conn.execute(
        "SELECT * FROM objetivos WHERE id = ? AND user_id = ?", (objetivo_id, user_id)
    ).fetchone()
    if not objetivo:
        return
    aporte = round(objetivo["monto_total"] / objetivo["meses_plazo"], 2) if objetivo["meses_plazo"] else 0

    if objetivo["dividir_quincenas"]:
        monto_q1 = round(aporte / 2, 2)
        monto_q2 = round(aporte - monto_q1, 2)
    else:
        monto_q1 = aporte
        monto_q2 = 0

    existente = conn.execute(
        "SELECT id FROM rubros_fijos WHERE objetivo_id = ? AND generado_de_objetivo = 1 AND user_id = ?",
        (objetivo_id, user_id),
    ).fetchone()
    if existente:
        conn.execute(
            "UPDATE rubros_fijos SET monto_q1 = ?, monto_q2 = ?, moneda = ? WHERE id = ?",
            (monto_q1, monto_q2, objetivo["moneda"], existente["id"]),
        )
    else:
        nombre_rubro = f"Ahorro: {objetivo['nombre']}"
        conn.execute(
            """INSERT INTO rubros_fijos
               (user_id, nombre, monto_q1, monto_q2, objetivo_id, orden, generado_de_objetivo, moneda)
               VALUES (?, ?, ?, ?, ?, 0, 1, ?)
               ON CONFLICT (user_id, nombre) DO NOTHING""",
            (user_id, nombre_rubro, monto_q1, monto_q2, objetivo_id, objetivo["moneda"]),
        )


@app.route("/api/objetivos", methods=["POST"])
@requiere_login
def crear_objetivo(user_id):
    data = request.get_json()
    conn = get_connection()
    cur = conn.execute(
        """INSERT INTO objetivos (user_id, nombre, monto_total, meses_plazo, acumulado, creado_en, moneda, dividir_quincenas)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?) RETURNING id""",
        (
            user_id,
            data["nombre"],
            data["monto_total"],
            data["meses_plazo"],
            datetime.now().isoformat(),
            data.get("moneda", "CRC"),
            1 if data.get("dividir_quincenas") else 0,
        ),
    )
    objetivo_id = cur.fetchone()["id"]
    # Genera automáticamente el gasto fijo mensual derivado de este objetivo
    _asegurar_rubro_fijo_de_objetivo(conn, user_id, objetivo_id)
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "id": objetivo_id})


@app.route("/api/objetivos/<int:objetivo_id>", methods=["PUT"])
@requiere_login
def actualizar_objetivo(user_id, objetivo_id):
    data = request.get_json()
    conn = get_connection()
    # Si no viene en el body, se conserva el valor actual (este modal no siempre
    # expone la opción de dividir en quincenas; eso se ajusta desde el rubro fijo
    # derivado, en la pestaña Configurar).
    if "dividir_quincenas" in data:
        dividir_quincenas = 1 if data["dividir_quincenas"] else 0
    else:
        actual = conn.execute(
            "SELECT dividir_quincenas FROM objetivos WHERE id = ? AND user_id = ?", (objetivo_id, user_id)
        ).fetchone()
        dividir_quincenas = actual["dividir_quincenas"] if actual else 0
    conn.execute(
        """UPDATE objetivos SET nombre = ?, monto_total = ?, meses_plazo = ?, moneda = ?, dividir_quincenas = ?
           WHERE id = ? AND user_id = ?""",
        (
            data["nombre"],
            data["monto_total"],
            data["meses_plazo"],
            data.get("moneda", "CRC"),
            dividir_quincenas,
            objetivo_id,
            user_id,
        ),
    )
    _asegurar_rubro_fijo_de_objetivo(conn, user_id, objetivo_id)
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/objetivos/<int:objetivo_id>", methods=["DELETE"])
@requiere_login
def borrar_objetivo(user_id, objetivo_id):
    conn = get_connection()
    conn.execute(
        "DELETE FROM rubros_fijos WHERE objetivo_id = ? AND generado_de_objetivo = 1 AND user_id = ?",
        (objetivo_id, user_id),
    )
    conn.execute("DELETE FROM objetivos WHERE id = ? AND user_id = ?", (objetivo_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Deudas ----------

def _amortizacion_meses_restantes(saldo, cuota, tasa_anual):
    """Meses restantes e interés total estimado para terminar de pagar una deuda,
    pagando siempre la misma cuota. Sin tasa, es una simple división. Si la cuota
    no alcanza a cubrir ni el interés mensual, no hay forma de amortizar (None)."""
    saldo = saldo or 0
    cuota = cuota or 0
    if saldo <= 0:
        return 0, 0
    if not cuota:
        return None, None
    if not tasa_anual:
        return round(saldo / cuota, 1), 0
    r = (tasa_anual / 100) / 12
    if r <= 0:
        return round(saldo / cuota, 1), 0
    if cuota <= saldo * r:
        return None, None
    n = -math.log(1 - (r * saldo) / cuota) / math.log(1 + r)
    interes_total = cuota * n - saldo
    return round(n, 1), round(max(interes_total, 0), 2)


def _saldo_desde_plazo(cuota, meses, tasa_anual):
    """Estima el saldo adeudado a partir de la cuota y el plazo restante (modo B
    de creación de deuda), usando el valor presente de una anualidad si hay tasa."""
    cuota = cuota or 0
    meses = meses or 0
    if not tasa_anual:
        return round(cuota * meses, 2)
    r = (tasa_anual / 100) / 12
    if r <= 0:
        return round(cuota * meses, 2)
    saldo = cuota * (1 - (1 + r) ** (-meses)) / r
    return round(saldo, 2)


def _categoria_deudas_id(conn, user_id):
    fila = conn.execute(
        "SELECT id FROM categorias_variables WHERE user_id = ? AND nombre = 'Deudas'", (user_id,)
    ).fetchone()
    if fila:
        return fila["id"]
    cur = conn.execute(
        "INSERT INTO categorias_variables (user_id, nombre, color, emoji) VALUES (?, 'Deudas', '#8C3A3A', '💳') RETURNING id",
        (user_id,),
    )
    return cur.fetchone()["id"]


def _asegurar_rubro_fijo_de_deuda(conn, user_id, deuda_id):
    """Crea o actualiza el rubro fijo derivado de una deuda, con la cuota mínima
    repartida en Q1 (o en las dos quincenas si dividir_quincenas está activo)."""
    deuda = conn.execute(
        "SELECT * FROM deudas WHERE id = ? AND user_id = ?", (deuda_id, user_id)
    ).fetchone()
    if not deuda:
        return
    cuota = deuda["cuota_minima"] or 0

    if deuda["dividir_quincenas"]:
        monto_q1 = round(cuota / 2, 2)
        monto_q2 = round(cuota - monto_q1, 2)
    else:
        monto_q1 = cuota
        monto_q2 = 0

    existente = conn.execute(
        "SELECT id FROM rubros_fijos WHERE deuda_id = ? AND generado_de_objetivo = 1 AND user_id = ?",
        (deuda_id, user_id),
    ).fetchone()
    if existente:
        conn.execute(
            "UPDATE rubros_fijos SET monto_q1 = ?, monto_q2 = ?, moneda = ? WHERE id = ?",
            (monto_q1, monto_q2, deuda["moneda"], existente["id"]),
        )
    else:
        nombre_rubro = f"Deuda: {deuda['nombre']}"
        conn.execute(
            """INSERT INTO rubros_fijos
               (user_id, nombre, monto_q1, monto_q2, deuda_id, orden, generado_de_objetivo, moneda)
               VALUES (?, ?, ?, ?, ?, 0, 1, ?)
               ON CONFLICT (user_id, nombre) DO NOTHING""",
            (user_id, nombre_rubro, monto_q1, monto_q2, deuda_id, deuda["moneda"]),
        )


@app.route("/api/deudas", methods=["GET"])
@requiere_login
def get_deudas(user_id):
    conn = get_connection()
    rows = conn.execute("SELECT * FROM deudas WHERE user_id = ? ORDER BY creado_en", (user_id,)).fetchall()
    deudas = []
    for r in rows:
        d = dict(r)
        d["pagado"] = round(d["saldo_inicial"] - d["saldo_actual"], 2)
        d["porcentaje"] = round(min(d["pagado"] / d["saldo_inicial"] * 100, 100), 1) if d["saldo_inicial"] else 0
        meses_restantes, interes_total = _amortizacion_meses_restantes(
            d["saldo_actual"], d["cuota_minima"], d["tasa_interes_anual"]
        )
        d["meses_restantes"] = meses_restantes
        d["interes_total_estimado"] = interes_total
        deudas.append(d)
    conn.close()
    return jsonify(deudas)


@app.route("/api/deudas", methods=["POST"])
@requiere_login
def crear_deuda(user_id):
    data = request.get_json()
    modo = data.get("modo", "monto")
    cuota_minima = data["cuota_minima"]
    tasa_interes_anual = data.get("tasa_interes_anual") or None

    if modo == "plazo":
        meses_plazo = data["meses_plazo"]
        saldo_inicial = _saldo_desde_plazo(cuota_minima, meses_plazo, tasa_interes_anual)
    else:
        saldo_inicial = data["monto_adeudado"]

    conn = get_connection()
    cur = conn.execute(
        """INSERT INTO deudas
           (user_id, nombre, saldo_inicial, saldo_actual, cuota_minima, tasa_interes_anual, moneda, dividir_quincenas, creado_en)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""",
        (
            user_id,
            data["nombre"],
            saldo_inicial,
            saldo_inicial,
            cuota_minima,
            tasa_interes_anual,
            data.get("moneda", "CRC"),
            1 if data.get("dividir_quincenas") else 0,
            datetime.now().isoformat(),
        ),
    )
    deuda_id = cur.fetchone()["id"]
    _asegurar_rubro_fijo_de_deuda(conn, user_id, deuda_id)
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "id": deuda_id})


@app.route("/api/deudas/<int:deuda_id>", methods=["PUT"])
@requiere_login
def actualizar_deuda(user_id, deuda_id):
    data = request.get_json()
    conn = get_connection()
    campos = ["nombre = ?", "cuota_minima = ?", "tasa_interes_anual = ?", "moneda = ?"]
    valores = [data["nombre"], data["cuota_minima"], data.get("tasa_interes_anual") or None, data.get("moneda", "CRC")]

    if "dividir_quincenas" in data:
        campos.append("dividir_quincenas = ?")
        valores.append(1 if data["dividir_quincenas"] else 0)

    if "saldo_actual" in data:
        campos.append("saldo_actual = ?")
        valores.append(data["saldo_actual"])

    valores.append(deuda_id)
    valores.append(user_id)
    conn.execute(f"UPDATE deudas SET {', '.join(campos)} WHERE id = ? AND user_id = ?", valores)
    _asegurar_rubro_fijo_de_deuda(conn, user_id, deuda_id)
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/deudas/<int:deuda_id>", methods=["DELETE"])
@requiere_login
def borrar_deuda(user_id, deuda_id):
    conn = get_connection()
    conn.execute(
        "DELETE FROM rubros_fijos WHERE deuda_id = ? AND generado_de_objetivo = 1 AND user_id = ?",
        (deuda_id, user_id),
    )
    conn.execute("DELETE FROM deudas WHERE id = ? AND user_id = ?", (deuda_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/deudas/<int:deuda_id>/abonos", methods=["POST"])
@requiere_login
def agregar_abono_deuda(user_id, deuda_id):
    """Abono extraordinario aparte de la cuota mínima: reduce el saldo y se
    registra como gasto bajo la categoría 'Deudas' para que se debite del mes."""
    data = request.get_json()
    monto = abs(data["monto"])
    nota = data.get("nota", "")
    conn = get_connection()
    deuda = conn.execute(
        "SELECT * FROM deudas WHERE id = ? AND user_id = ?", (deuda_id, user_id)
    ).fetchone()
    if not deuda:
        conn.close()
        return jsonify({"error": "Deuda no encontrada"}), 404
    if monto > deuda["saldo_actual"]:
        monto = deuda["saldo_actual"]

    ahora = datetime.now().isoformat()
    cur = conn.execute(
        """INSERT INTO abonos_deuda (user_id, deuda_id, monto, fecha, nota, origen)
           VALUES (?, ?, ?, ?, ?, 'manual') RETURNING id""",
        (user_id, deuda_id, monto, ahora, nota),
    )
    abono_id = cur.fetchone()["id"]
    conn.execute(
        "UPDATE deudas SET saldo_actual = saldo_actual - ? WHERE id = ? AND user_id = ?",
        (monto, deuda_id, user_id),
    )

    categoria_id = _categoria_deudas_id(conn, user_id)
    conn.execute(
        """INSERT INTO transacciones
           (user_id, comercio, ciudad, fecha, monto, moneda, tarjeta, autorizacion, referencia,
            categoria_id, categoria_corregida, origen_archivo, importado_en)
           VALUES (?, ?, '', ?, ?, ?, '', '', ?, ?, 1, 'abono_deuda', ?)""",
        (
            user_id,
            f"Abono: {deuda['nombre']}",
            ahora,
            monto,
            deuda["moneda"],
            f"abono-deuda-{deuda_id}-{abono_id}",
            categoria_id,
            ahora,
        ),
    )

    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/deudas/<int:deuda_id>/abonos", methods=["GET"])
@requiere_login
def listar_abonos_deuda(user_id, deuda_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM abonos_deuda WHERE deuda_id = ? AND user_id = ? ORDER BY fecha DESC",
        (deuda_id, user_id),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


def _categoria_ahorros_id(conn, user_id):
    fila = conn.execute(
        "SELECT id FROM categorias_variables WHERE user_id = ? AND nombre = 'Ahorros'", (user_id,)
    ).fetchone()
    if fila:
        return fila["id"]
    cur = conn.execute(
        "INSERT INTO categorias_variables (user_id, nombre, color, emoji) VALUES (?, 'Ahorros', '#1F7A5C', '💰') RETURNING id",
        (user_id,),
    )
    return cur.fetchone()["id"]


def _categoria_gastos_fijos_id(conn, user_id):
    fila = conn.execute(
        "SELECT id FROM categorias_variables WHERE user_id = ? AND nombre = 'Gastos fijos'", (user_id,)
    ).fetchone()
    if fila:
        return fila["id"]
    cur = conn.execute(
        "INSERT INTO categorias_variables (user_id, nombre, color, emoji) VALUES (?, 'Gastos fijos', '#2C3E50', '📌') RETURNING id",
        (user_id,),
    )
    return cur.fetchone()["id"]


@app.route("/api/objetivos/<int:objetivo_id>/aportes", methods=["POST"])
@requiere_login
def agregar_aporte(user_id, objetivo_id):
    data = request.get_json()
    monto = data["monto"]
    nota = data.get("nota", "")
    conn = get_connection()
    objetivo = conn.execute(
        "SELECT * FROM objetivos WHERE id = ? AND user_id = ?", (objetivo_id, user_id)
    ).fetchone()
    if not objetivo:
        conn.close()
        return jsonify({"error": "Objetivo no encontrado"}), 404
    ahora = datetime.now().isoformat()
    cur = conn.execute(
        """INSERT INTO aportes_objetivo (user_id, objetivo_id, monto, fecha, nota, origen)
           VALUES (?, ?, ?, ?, ?, 'manual') RETURNING id""",
        (user_id, objetivo_id, monto, ahora, nota),
    )
    aporte_id = cur.fetchone()["id"]
    conn.execute(
        "UPDATE objetivos SET acumulado = acumulado + ? WHERE id = ? AND user_id = ?",
        (monto, objetivo_id, user_id),
    )

    # Registra el aporte como una transacción de gasto variable, bajo la categoría "Ahorros",
    # para que se debite del salario disponible en la pestaña de gastos mensuales. Queda
    # vinculada al aporte mediante "referencia", para poder revertirla si luego se retira.
    categoria_id = _categoria_ahorros_id(conn, user_id)
    nombre_objetivo = objetivo["nombre"]
    conn.execute(
        """INSERT INTO transacciones
           (user_id, comercio, ciudad, fecha, monto, moneda, tarjeta, autorizacion, referencia,
            categoria_id, categoria_corregida, origen_archivo, importado_en)
           VALUES (?, ?, '', ?, ?, ?, '', '', ?, ?, 1, 'aporte_objetivo', ?)""",
        (
            user_id,
            f"Aporte: {nombre_objetivo}",
            ahora,
            monto,
            objetivo["moneda"],
            f"aporte-objetivo-{objetivo_id}-{aporte_id}",
            categoria_id,
            ahora,
        ),
    )

    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/objetivos/<int:objetivo_id>/retiros", methods=["POST"])
@requiere_login
def retirar_de_objetivo(user_id, objetivo_id):
    """Retiro de emergencia: saca dinero de un objetivo de largo plazo y lo devuelve
    al disponible del mes. En vez de crear una transacción negativa (que dejaría mal
    los totales y gráficos de gastos variables), revierte/recorta las transacciones de
    aporte previas vinculadas a este objetivo, empezando por las más recientes."""
    data = request.get_json()
    monto = abs(data["monto"])
    nota = data.get("nota", "")
    conn = get_connection()
    objetivo = conn.execute(
        "SELECT * FROM objetivos WHERE id = ? AND user_id = ?", (objetivo_id, user_id)
    ).fetchone()
    if not objetivo:
        conn.close()
        return jsonify({"error": "Objetivo no encontrado"}), 404
    if monto > objetivo["acumulado"]:
        conn.close()
        return jsonify({"error": "El retiro no puede ser mayor al monto acumulado"}), 400

    ahora = datetime.now().isoformat()
    conn.execute(
        """INSERT INTO aportes_objetivo (user_id, objetivo_id, monto, fecha, nota, origen)
           VALUES (?, ?, ?, ?, ?, 'retiro_emergencia')""",
        (user_id, objetivo_id, -monto, ahora, nota),
    )
    conn.execute(
        "UPDATE objetivos SET acumulado = acumulado - ? WHERE id = ? AND user_id = ?",
        (monto, objetivo_id, user_id),
    )

    restante = monto
    aportes_tx = conn.execute(
        """SELECT id, monto FROM transacciones
           WHERE referencia LIKE ? AND user_id = ? ORDER BY fecha DESC""",
        (f"aporte-objetivo-{objetivo_id}-%", user_id),
    ).fetchall()
    for tx in aportes_tx:
        if restante <= 0:
            break
        if tx["monto"] <= restante:
            conn.execute("DELETE FROM transacciones WHERE id = ?", (tx["id"],))
            restante -= tx["monto"]
        else:
            conn.execute(
                "UPDATE transacciones SET monto = monto - ? WHERE id = ?",
                (restante, tx["id"]),
            )
            restante = 0
    # Si el retiro supera lo registrado como aportes manuales (p. ej. parte del
    # acumulado viene de un rubro fijo automático), el resto ya estaba reflejado
    # como gasto fijo y no corresponde tocar las transacciones variables.

    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/objetivos/<int:objetivo_id>/aportes", methods=["GET"])
@requiere_login
def listar_aportes(user_id, objetivo_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM aportes_objetivo WHERE objetivo_id = ? AND user_id = ? ORDER BY fecha DESC",
        (objetivo_id, user_id),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ---------- Ingresos extraordinarios ----------

@app.route("/api/ingresos-extra", methods=["GET"])
@requiere_login
def get_ingresos_extra(user_id):
    mes = request.args.get("mes")  # YYYY-MM
    conn = get_connection()
    if mes:
        rows = conn.execute(
            "SELECT * FROM ingresos_extra WHERE user_id = ? AND substr(fecha, 1, 7) = ? ORDER BY fecha DESC",
            (user_id, mes),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM ingresos_extra WHERE user_id = ? ORDER BY fecha DESC", (user_id,)
        ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/ingresos-extra", methods=["POST"])
@requiere_login
def crear_ingreso_extra(user_id):
    data = request.get_json()
    conn = get_connection()
    conn.execute(
        """INSERT INTO ingresos_extra (user_id, descripcion, monto, moneda, fecha) VALUES (?, ?, ?, ?, ?)""",
        (user_id, data["descripcion"], data["monto"], data.get("moneda", "CRC"), data.get("fecha") or datetime.now().isoformat()),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/ingresos-extra/<int:ingreso_id>", methods=["DELETE"])
@requiere_login
def borrar_ingreso_extra(user_id, ingreso_id):
    conn = get_connection()
    conn.execute("DELETE FROM ingresos_extra WHERE id = ? AND user_id = ?", (ingreso_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Rubros de gastos fijos ----------

@app.route("/api/rubros-fijos", methods=["GET"])
@requiere_login
def get_rubros_fijos(user_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM rubros_fijos WHERE user_id = ? ORDER BY orden, id", (user_id,)
    ).fetchall()
    config = conn.execute("SELECT * FROM configuracion WHERE user_id = ?", (user_id,)).fetchone()
    tipo_cambio = config["tipo_cambio"] or 0
    salario_total_base = _convertir(config["salario_total"] or 0, config["salario_moneda"], "CRC", tipo_cambio)

    rubros = []
    for r in rows:
        rb = dict(r)
        total = rb["monto_q1"] + rb["monto_q2"]
        rb["monto_total"] = total
        total_base = _convertir(total, rb["moneda"], "CRC", tipo_cambio)
        rb["porcentaje_salario"] = round(total_base / salario_total_base * 100, 1) if salario_total_base else 0
        rubros.append(rb)
    conn.close()
    return jsonify(rubros)


@app.route("/api/rubros-fijos", methods=["POST"])
@requiere_login
def crear_rubro_fijo(user_id):
    data = request.get_json()
    conn = get_connection()
    cur = conn.execute(
        """INSERT INTO rubros_fijos (user_id, nombre, monto_q1, monto_q2, objetivo_id, orden, moneda)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id""",
        (
            user_id,
            data["nombre"],
            data["monto_q1"],
            data["monto_q2"],
            data.get("objetivo_id"),
            data.get("orden", 0),
            data.get("moneda", "CRC"),
        ),
    )
    conn.commit()
    rubro_id = cur.fetchone()["id"]
    conn.close()
    return jsonify({"ok": True, "id": rubro_id})


@app.route("/api/rubros-fijos/<int:rubro_id>", methods=["PUT"])
@requiere_login
def actualizar_rubro_fijo(user_id, rubro_id):
    data = request.get_json()
    conn = get_connection()
    conn.execute(
        """UPDATE rubros_fijos SET nombre = ?, monto_q1 = ?, monto_q2 = ?, objetivo_id = ?, moneda = ?
           WHERE id = ? AND user_id = ?""",
        (data["nombre"], data["monto_q1"], data["monto_q2"], data.get("objetivo_id"), data.get("moneda", "CRC"), rubro_id, user_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/rubros-fijos/reordenar", methods=["PUT"])
@requiere_login
def reordenar_rubros_fijos(user_id):
    """Recibe la lista completa de ids en el orden deseado y guarda el orden."""
    data = request.get_json()
    ids = data.get("ids", [])
    conn = get_connection()
    for indice, rubro_id in enumerate(ids):
        conn.execute(
            "UPDATE rubros_fijos SET orden = ? WHERE id = ? AND user_id = ?", (indice, rubro_id, user_id)
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/rubros-fijos/<int:rubro_id>", methods=["DELETE"])
@requiere_login
def borrar_rubro_fijo(user_id, rubro_id):
    conn = get_connection()
    conn.execute("DELETE FROM rubros_fijos WHERE id = ? AND user_id = ?", (rubro_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Pagos de rubros fijos (por mes) ----------

@app.route("/api/pagos-fijos", methods=["GET"])
@requiere_login
def get_pagos_fijos(user_id):
    mes = request.args.get("mes")  # formato YYYY-MM
    conn = get_connection()
    query = """SELECT pf.* FROM pagos_fijos pf
               JOIN rubros_fijos rf ON rf.id = pf.rubro_id
               WHERE rf.user_id = ?"""
    params = [user_id]
    if mes:
        query += " AND pf.mes = ?"
        params.append(mes)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/pagos-fijos", methods=["POST"])
@requiere_login
def marcar_pago_fijo(user_id):
    data = request.get_json()
    rubro_id = data["rubro_id"]
    mes = data["mes"]
    quincena = data["quincena"]
    monto = data["monto"]
    origen = data.get("origen", "manual")

    conn = get_connection()
    rubro_row = conn.execute(
        "SELECT nombre, moneda, objetivo_id, deuda_id FROM rubros_fijos WHERE id = ? AND user_id = ?",
        (rubro_id, user_id),
    ).fetchone()
    # La moneda del pago siempre es la del rubro: el monto que llega del modal ya está
    # en esa moneda (no convertida), así que no debe sobreescribirse con otra moneda.
    moneda = rubro_row["moneda"] if rubro_row else "CRC"
    ahora = datetime.now().isoformat()
    conn.execute(
        """INSERT INTO pagos_fijos (rubro_id, mes, quincena, monto, fecha_pago, origen, moneda)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(rubro_id, mes, quincena) DO UPDATE SET monto = excluded.monto, origen = excluded.origen, moneda = excluded.moneda""",
        (rubro_id, mes, quincena, monto, ahora, origen, moneda),
    )

    # Si el rubro está vinculado a un objetivo de largo plazo, el pago suma al acumulado
    if rubro_row and rubro_row["objetivo_id"]:
        conn.execute(
            "UPDATE objetivos SET acumulado = acumulado + ? WHERE id = ? AND user_id = ?",
            (monto, rubro_row["objetivo_id"], user_id),
        )
        conn.execute(
            """INSERT INTO aportes_objetivo (user_id, objetivo_id, monto, fecha, nota, origen)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (user_id, rubro_row["objetivo_id"], monto, ahora, f"Pago fijo {mes} {quincena}", origen),
        )

    # Si el rubro está vinculado a una deuda, el pago de la cuota reduce el saldo
    if rubro_row and rubro_row["deuda_id"]:
        conn.execute(
            "UPDATE deudas SET saldo_actual = MAX(saldo_actual - ?, 0) WHERE id = ? AND user_id = ?",
            (monto, rubro_row["deuda_id"], user_id),
        )

    # Registra el pago como transacción visible en "Transacciones", bajo la categoría
    # "Deudas" si es la cuota de una deuda, o "Gastos fijos" en cualquier otro caso.
    # Se excluye de los totales de gastos variables (ver /api/dashboard) porque ese
    # monto ya está contado en el presupuesto fijo.
    es_deuda = bool(rubro_row and rubro_row["deuda_id"])
    categoria_id = _categoria_deudas_id(conn, user_id) if es_deuda else _categoria_gastos_fijos_id(conn, user_id)
    nombre_rubro = rubro_row["nombre"] if rubro_row else ""
    # El nombre del rubro generado por una deuda ya empieza con "Deuda: ", así que
    # se evita el "Pago: Deuda: X" redundante.
    comercio = f"Cuota: {nombre_rubro[len('Deuda: '):]}" if es_deuda and nombre_rubro.startswith("Deuda: ") else f"Pago: {nombre_rubro}"
    referencia = f"pago-fijo-{rubro_id}-{mes}-{quincena}"
    conn.execute(
        """INSERT INTO transacciones
           (user_id, comercio, ciudad, fecha, monto, moneda, tarjeta, autorizacion, referencia,
            categoria_id, categoria_corregida, origen_archivo, importado_en)
           VALUES (?, ?, '', ?, ?, ?, '', '', ?, ?, 1, 'pago_fijo', ?)
           ON CONFLICT(user_id, referencia) DO UPDATE SET monto = excluded.monto, fecha = excluded.fecha""",
        (
            user_id,
            comercio,
            ahora,
            monto,
            moneda,
            referencia,
            categoria_id,
            ahora,
        ),
    )

    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/pagos-fijos/<int:pago_id>", methods=["DELETE"])
@requiere_login
def deshacer_pago_fijo(user_id, pago_id):
    conn = get_connection()
    pago = conn.execute(
        """SELECT pf.* FROM pagos_fijos pf
           JOIN rubros_fijos rf ON rf.id = pf.rubro_id
           WHERE pf.id = ? AND rf.user_id = ?""",
        (pago_id, user_id),
    ).fetchone()
    if pago:
        rubro = conn.execute(
            "SELECT objetivo_id, deuda_id FROM rubros_fijos WHERE id = ? AND user_id = ?",
            (pago["rubro_id"], user_id),
        ).fetchone()
        if rubro and rubro["objetivo_id"]:
            conn.execute(
                "UPDATE objetivos SET acumulado = acumulado - ? WHERE id = ? AND user_id = ?",
                (pago["monto"], rubro["objetivo_id"], user_id),
            )
        if rubro and rubro["deuda_id"]:
            conn.execute(
                "UPDATE deudas SET saldo_actual = saldo_actual + ? WHERE id = ? AND user_id = ?",
                (pago["monto"], rubro["deuda_id"], user_id),
            )
        referencia = f"pago-fijo-{pago['rubro_id']}-{pago['mes']}-{pago['quincena']}"
        conn.execute("DELETE FROM transacciones WHERE referencia = ? AND user_id = ?", (referencia, user_id))
        conn.execute("DELETE FROM pagos_fijos WHERE id = ?", (pago_id,))
        conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Categorías variables ----------

@app.route("/api/categorias", methods=["GET"])
@requiere_login
def get_categorias(user_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM categorias_variables WHERE user_id = ? ORDER BY nombre", (user_id,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/categorias", methods=["POST"])
@requiere_login
def crear_categoria(user_id):
    data = request.get_json()
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO categorias_variables (user_id, nombre, color, presupuesto_mensual, emoji) VALUES (?, ?, ?, ?, ?) RETURNING id",
        (user_id, data["nombre"], data.get("color", "#6B6862"), data.get("presupuesto_mensual", 0), data.get("emoji", "🏷️")),
    )
    conn.commit()
    cat_id = cur.fetchone()["id"]
    conn.close()
    return jsonify({"ok": True, "id": cat_id})


@app.route("/api/categorias/<int:cat_id>", methods=["PUT"])
@requiere_login
def actualizar_categoria(user_id, cat_id):
    """Usado principalmente para setear el presupuesto mensual de la categoría."""
    data = request.get_json()
    conn = get_connection()

    categoria = conn.execute(
        "SELECT nombre FROM categorias_variables WHERE id = ? AND user_id = ?", (cat_id, user_id)
    ).fetchone()
    es_protegida = categoria and categoria["nombre"] in CATEGORIAS_PROTEGIDAS
    if es_protegida and "nombre" in data and data["nombre"] != categoria["nombre"]:
        conn.close()
        return jsonify({"error": f'"{categoria["nombre"]}" es una categoría del sistema y no se puede renombrar.'}), 400

    campos = []
    valores = []
    if "presupuesto_mensual" in data:
        campos.append("presupuesto_mensual = ?")
        valores.append(data["presupuesto_mensual"])
    if "nombre" in data:
        campos.append("nombre = ?")
        valores.append(data["nombre"])
    if "color" in data:
        campos.append("color = ?")
        valores.append(data["color"])
    if "emoji" in data:
        campos.append("emoji = ?")
        valores.append(data["emoji"])
    if campos:
        valores.append(cat_id)
        valores.append(user_id)
        conn.execute(f"UPDATE categorias_variables SET {', '.join(campos)} WHERE id = ? AND user_id = ?", valores)
        conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/categorias/<int:cat_id>", methods=["DELETE"])
@requiere_login
def borrar_categoria(user_id, cat_id):
    """Borra una categoría y reasigna sus transacciones a 'Otros' (o la primera categoría que quede)."""
    conn = get_connection()

    categoria = conn.execute(
        "SELECT nombre FROM categorias_variables WHERE id = ? AND user_id = ?", (cat_id, user_id)
    ).fetchone()
    if categoria and categoria["nombre"] in CATEGORIAS_PROTEGIDAS:
        conn.close()
        return jsonify({"error": f'"{categoria["nombre"]}" es una categoría del sistema y no se puede borrar.'}), 400

    total_categorias = conn.execute(
        "SELECT COUNT(*) AS n FROM categorias_variables WHERE user_id = ?", (user_id,)
    ).fetchone()["n"]
    if total_categorias <= 1:
        conn.close()
        return jsonify({"error": "No podés borrar la última categoría."}), 400

    destino = conn.execute(
        "SELECT id FROM categorias_variables WHERE user_id = ? AND nombre = 'Otros' AND id != ?", (user_id, cat_id)
    ).fetchone()
    if not destino:
        destino = conn.execute(
            "SELECT id FROM categorias_variables WHERE user_id = ? AND id != ? ORDER BY nombre LIMIT 1", (user_id, cat_id)
        ).fetchone()

    conn.execute(
        "UPDATE transacciones SET categoria_id = ? WHERE categoria_id = ? AND user_id = ?",
        (destino["id"], cat_id, user_id),
    )
    conn.execute("DELETE FROM categorias_variables WHERE id = ? AND user_id = ?", (cat_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "reasignado_a": destino["id"]})


# ---------- Transacciones (gastos variables) ----------

@app.route("/api/transacciones", methods=["GET"])
@requiere_login
def get_transacciones(user_id):
    mes = request.args.get("mes")  # YYYY-MM
    conn = get_connection()
    query = """
        SELECT t.*, c.nombre as categoria_nombre, c.color as categoria_color, c.emoji as categoria_emoji
        FROM transacciones t
        LEFT JOIN categorias_variables c ON t.categoria_id = c.id
        WHERE t.user_id = ?
    """
    params = [user_id]
    if mes:
        query += " AND substr(t.fecha, 1, 7) = ?"
        params.append(mes)
    query += " ORDER BY t.fecha DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/transacciones/<int:trans_id>", methods=["PUT"])
@requiere_login
def actualizar_transaccion(user_id, trans_id):
    """Usado principalmente para corregir manualmente la categoría asignada."""
    data = request.get_json()
    conn = get_connection()

    campos = []
    valores = []
    if "categoria_id" in data:
        campos.append("categoria_id = ?")
        valores.append(data["categoria_id"])
        campos.append("categoria_corregida = 1")

        # Aprender la corrección para este comercio
        trans = conn.execute(
            "SELECT comercio FROM transacciones WHERE id = ? AND user_id = ?", (trans_id, user_id)
        ).fetchone()
        if trans:
            aprender_categoria(conn, user_id, trans["comercio"], data["categoria_id"])

    if "monto" in data:
        campos.append("monto = ?")
        valores.append(data["monto"])
    if "comercio" in data:
        campos.append("comercio = ?")
        valores.append(data["comercio"])
    if "moneda" in data:
        campos.append("moneda = ?")
        valores.append(data["moneda"])
    if "fecha" in data:
        campos.append("fecha = ?")
        valores.append(data["fecha"])
    if "ciudad" in data:
        campos.append("ciudad = ?")
        valores.append(data["ciudad"])

    if campos:
        valores.append(trans_id)
        valores.append(user_id)
        conn.execute(f"UPDATE transacciones SET {', '.join(campos)} WHERE id = ? AND user_id = ?", valores)
        conn.commit()

    conn.close()
    return jsonify({"ok": True})


@app.route("/api/transacciones/<int:trans_id>", methods=["DELETE"])
@requiere_login
def borrar_transaccion(user_id, trans_id):
    conn = get_connection()
    trans = conn.execute(
        "SELECT origen_archivo, referencia, monto FROM transacciones WHERE id = ? AND user_id = ?",
        (trans_id, user_id),
    ).fetchone()

    if trans:
        referencia = trans["referencia"] or ""
        # Si la transacción es el reflejo de un aporte a un objetivo o de un abono a
        # una deuda, al borrarla hay que revertir también el monto acumulado/pagado y
        # el registro en su tabla, si no quedarían descuadrados.
        if trans["origen_archivo"] == "aporte_objetivo" and referencia.startswith("aporte-objetivo-"):
            partes = referencia.split("-")  # aporte-objetivo-{objetivo_id}-{aporte_id}
            objetivo_id, aporte_id = partes[2], partes[3]
            conn.execute(
                "UPDATE objetivos SET acumulado = acumulado - ? WHERE id = ? AND user_id = ?",
                (trans["monto"], objetivo_id, user_id),
            )
            conn.execute("DELETE FROM aportes_objetivo WHERE id = ? AND user_id = ?", (aporte_id, user_id))
        elif trans["origen_archivo"] == "abono_deuda" and referencia.startswith("abono-deuda-"):
            partes = referencia.split("-")  # abono-deuda-{deuda_id}-{abono_id}
            deuda_id, abono_id = partes[2], partes[3]
            conn.execute(
                "UPDATE deudas SET saldo_actual = saldo_actual + ? WHERE id = ? AND user_id = ?",
                (trans["monto"], deuda_id, user_id),
            )
            conn.execute("DELETE FROM abonos_deuda WHERE id = ? AND user_id = ?", (abono_id, user_id))

    conn.execute("DELETE FROM transacciones WHERE id = ? AND user_id = ?", (trans_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/transacciones/manual", methods=["POST"])
@requiere_login
def crear_transaccion_manual(user_id):
    data = request.get_json()
    conn = get_connection()
    categoria_id = data.get("categoria_id")
    if not categoria_id:
        categoria_id = sugerir_categoria(conn, user_id, data["comercio"])

    conn.execute(
        """INSERT INTO transacciones
           (user_id, comercio, ciudad, fecha, monto, moneda, tarjeta, autorizacion, referencia,
            categoria_id, categoria_corregida, origen_archivo, importado_en)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual', ?)""",
        (
            user_id,
            data["comercio"],
            data.get("ciudad", ""),
            data["fecha"],
            data["monto"],
            data.get("moneda", "CRC"),
            data.get("tarjeta", ""),
            data.get("autorizacion", ""),
            data.get("referencia"),
            categoria_id,
            datetime.now().isoformat(),
        ),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Importación de correos .eml ----------

@app.route("/api/importar-correos", methods=["POST"])
@requiere_login
def importar_correos(user_id):
    archivos = request.files.getlist("archivos")
    if not archivos:
        return jsonify({"error": "No se recibieron archivos"}), 400

    conn = get_connection()
    resultados = {"importados": 0, "duplicados": 0, "errores": 0, "detalle": []}

    for archivo in archivos:
        try:
            raw = archivo.read()
            datos = parse_eml_bytes(raw)
            if not datos or not datos.get("comercio") or datos.get("monto") is None:
                resultados["errores"] += 1
                resultados["detalle"].append({"archivo": archivo.filename, "estado": "error", "razon": "No se pudo extraer la información"})
                continue

            referencia = datos.get("referencia")
            if referencia:
                existe = conn.execute(
                    "SELECT id FROM transacciones WHERE user_id = ? AND referencia = ?", (user_id, referencia)
                ).fetchone()
                if existe:
                    resultados["duplicados"] += 1
                    resultados["detalle"].append({"archivo": archivo.filename, "estado": "duplicado"})
                    continue

            categoria_id = sugerir_categoria(conn, user_id, datos["comercio"])

            conn.execute(
                """INSERT INTO transacciones
                   (user_id, comercio, ciudad, fecha, monto, moneda, tarjeta, autorizacion, referencia,
                    categoria_id, categoria_corregida, origen_archivo, importado_en)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
                (
                    user_id,
                    datos["comercio"],
                    datos.get("ciudad", ""),
                    datos.get("fecha") or datetime.now().isoformat(),
                    datos["monto"],
                    datos.get("moneda", "CRC"),
                    datos.get("tarjeta", ""),
                    datos.get("autorizacion", ""),
                    referencia,
                    categoria_id,
                    archivo.filename,
                    datetime.now().isoformat(),
                ),
            )
            resultados["importados"] += 1
            resultados["detalle"].append({"archivo": archivo.filename, "estado": "importado", "comercio": datos["comercio"], "monto": datos["monto"]})
        except Exception as e:
            resultados["errores"] += 1
            resultados["detalle"].append({"archivo": archivo.filename, "estado": "error", "razon": str(e)})

    conn.commit()
    conn.close()
    return jsonify(resultados)


# ---------- Sincronización con Gmail ----------

@app.route("/api/gmail/estado", methods=["GET"])
@requiere_login
def gmail_estado(user_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM sync_gmail WHERE user_id = ?", (user_id,)).fetchone()
    conn.close()
    return jsonify({
        "credenciales_configuradas": gmail.hay_credenciales_configuradas(),
        "sesion_activa": bool(row and row["token_json"]),
        "etiqueta": row["etiqueta"] if row else "Facturas electronicas",
        "ultima_sincronizacion": row["ultima_sincronizacion"] if row else None,
    })


@app.route("/api/gmail/etiqueta", methods=["PUT"])
@requiere_login
def gmail_set_etiqueta(user_id):
    data = request.get_json()
    conn = get_connection()
    conn.execute("UPDATE sync_gmail SET etiqueta = ? WHERE user_id = ?", (data["etiqueta"], user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/gmail/conectar", methods=["GET"])
@requiere_login
def gmail_conectar(user_id):
    """Redirige a la pantalla de consentimiento de Google (flujo OAuth web)."""
    redirect_uri = request.url_root.rstrip("/") + "/api/gmail/callback"
    try:
        url, state, code_verifier = gmail.generar_url_autorizacion(redirect_uri)
    except gmail.GmailNoConfigurado as e:
        return jsonify({"error": str(e)}), 400
    session["gmail_oauth_state"] = state
    session["gmail_code_verifier"] = code_verifier
    return redirect(url)


@app.route("/api/gmail/callback", methods=["GET"])
def gmail_callback():
    """Google vuelve acá después de que el usuario autoriza el acceso a Gmail."""
    user_id = auth.usuario_actual()
    if not user_id:
        return "Tu sesión expiró. Volvé a entrar a la app e intentá de nuevo.", 401

    state = request.args.get("state")
    if not state or state != session.get("gmail_oauth_state"):
        return "Solicitud inválida (no coincide el state de la sesión).", 400

    code = request.args.get("code")
    if not code:
        return "Google no envió un código de autorización.", 400

    code_verifier = session.get("gmail_code_verifier")
    redirect_uri = request.url_root.rstrip("/") + "/api/gmail/callback"
    conn = get_connection()
    try:
        gmail.procesar_callback(conn, user_id, redirect_uri, code, code_verifier)
    except Exception as e:
        return f"No se pudo completar la conexión con Gmail: {e}", 500
    finally:
        conn.close()
    session.pop("gmail_oauth_state", None)
    session.pop("gmail_code_verifier", None)
    return redirect("/?gmail=conectado")


@app.route("/api/gmail/desconectar", methods=["POST"])
@requiere_login
def gmail_desconectar(user_id):
    conn = get_connection()
    gmail.desconectar(conn, user_id)
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/gmail/sincronizar", methods=["POST"])
@requiere_login
def gmail_sincronizar(user_id):
    conn = get_connection()
    estado = conn.execute("SELECT * FROM sync_gmail WHERE user_id = ?", (user_id,)).fetchone()
    etiqueta = estado["etiqueta"] if estado else "Facturas electronicas"
    ultimo_id = estado["ultimo_mensaje_id"] if estado else None

    if not gmail.hay_credenciales_configuradas():
        conn.close()
        return jsonify({
            "error": "No hay credenciales de Gmail configuradas todavía.",
            "requiere_configuracion": True,
        }), 400

    try:
        resultado = gmail.listar_mensajes_nuevos(conn, user_id, etiqueta, despues_de_id=ultimo_id)
    except gmail.GmailNoConfigurado as e:
        conn.close()
        return jsonify({"error": str(e), "requiere_configuracion": True}), 400
    except Exception as e:
        conn.close()
        return jsonify({"error": str(e)}), 500

    if resultado["error"]:
        conn.close()
        return jsonify({"error": resultado["error"]}), 400

    mensajes = resultado["mensajes"]
    resumen = {"importados": 0, "duplicados": 0, "errores": 0, "detalle": []}

    nuevo_ultimo_id = ultimo_id
    # Gmail entrega del más reciente al más viejo; el primero de la lista es el más nuevo
    if mensajes:
        nuevo_ultimo_id = mensajes[0]["id"]

    # Procesamos del más viejo al más nuevo para que el orden de importación sea cronológico
    for m in reversed(mensajes):
        try:
            datos = parse_eml_bytes(m["raw"])
            if not datos or not datos.get("comercio") or datos.get("monto") is None:
                resumen["errores"] += 1
                resumen["detalle"].append({"estado": "error", "razon": "No se pudo leer la transacción"})
                continue

            referencia = datos.get("referencia")
            if referencia:
                existe = conn.execute(
                    "SELECT id FROM transacciones WHERE user_id = ? AND referencia = ?", (user_id, referencia)
                ).fetchone()
                if existe:
                    resumen["duplicados"] += 1
                    resumen["detalle"].append({"estado": "duplicado", "comercio": datos.get("comercio")})
                    continue

            categoria_id = sugerir_categoria(conn, user_id, datos["comercio"])

            conn.execute(
                """INSERT INTO transacciones
                   (user_id, comercio, ciudad, fecha, monto, moneda, tarjeta, autorizacion, referencia,
                    categoria_id, categoria_corregida, origen_archivo, importado_en)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
                (
                    user_id,
                    datos["comercio"],
                    datos.get("ciudad", ""),
                    datos.get("fecha") or datetime.now().isoformat(),
                    datos["monto"],
                    datos.get("moneda", "CRC"),
                    datos.get("tarjeta", ""),
                    datos.get("autorizacion", ""),
                    referencia,
                    categoria_id,
                    "gmail",
                    datetime.now().isoformat(),
                ),
            )
            resumen["importados"] += 1
            resumen["detalle"].append({"estado": "importado", "comercio": datos["comercio"], "monto": datos["monto"]})
        except Exception as e:
            resumen["errores"] += 1
            resumen["detalle"].append({"estado": "error", "razon": str(e)})

    conn.execute(
        "UPDATE sync_gmail SET ultimo_mensaje_id = ?, ultima_sincronizacion = ? WHERE user_id = ?",
        (nuevo_ultimo_id, datetime.now().isoformat(), user_id),
    )
    conn.commit()
    conn.close()
    return jsonify(resumen)


# ---------- Dashboard / resumen ----------

def _convertir(monto, moneda_origen, moneda_destino, tipo_cambio):
    """Convierte un monto entre CRC y USD. El tipo de cambio es CRC por 1 USD,
    editado a mano por el usuario en Configurar (sin llamadas externas)."""
    monto = monto or 0
    moneda_origen = moneda_origen or "CRC"
    if moneda_origen == moneda_destino:
        return monto
    if moneda_origen == "USD" and moneda_destino == "CRC":
        return monto * (tipo_cambio or 0)
    if moneda_origen == "CRC" and moneda_destino == "USD":
        return monto / tipo_cambio if tipo_cambio else 0
    return monto


def _fecha_de_pago(anio, mes, dia):
    """Fecha real del día de pago en ese mes, recortada al último día si el mes
    tiene menos días que el número configurado (ej: día 30 en febrero)."""
    dias_mes = calendar.monthrange(anio, mes)[1]
    return date(anio, mes, min(dia, dias_mes))


def _calcular_quincena_actual(dia_pago_q1, dia_pago_q2, hoy):
    """Determina en qué quincena cae 'hoy', según los días de pago configurados.
    El período de cada quincena va desde su día de pago hasta el día de pago
    siguiente (es la plata que hay que estirar hasta el próximo depósito)."""
    anio, mes = hoy.year, hoy.month
    pago_q1 = _fecha_de_pago(anio, mes, dia_pago_q1)
    pago_q2 = _fecha_de_pago(anio, mes, dia_pago_q2)

    if hoy < pago_q1:
        anio_ant, mes_ant = (anio, mes - 1) if mes > 1 else (anio - 1, 12)
        inicio = _fecha_de_pago(anio_ant, mes_ant, dia_pago_q2)
        fin = pago_q1
        quincena = "Q2"
    elif hoy < pago_q2:
        inicio = pago_q1
        fin = pago_q2
        quincena = "Q1"
    else:
        anio_sig, mes_sig = (anio, mes + 1) if mes < 12 else (anio + 1, 1)
        inicio = pago_q2
        fin = _fecha_de_pago(anio_sig, mes_sig, dia_pago_q1)
        quincena = "Q2"

    return {
        "quincena": quincena,
        "periodo_inicio": inicio,
        "periodo_fin": fin,
        "dias_para_proximo_pago": (fin - hoy).days,
    }


@app.route("/api/dashboard", methods=["GET"])
@requiere_login
def get_dashboard(user_id):
    mes = request.args.get("mes") or datetime.now().strftime("%Y-%m")
    conn = get_connection()

    config = conn.execute("SELECT * FROM configuracion WHERE user_id = ?", (user_id,)).fetchone()
    tipo_cambio = config["tipo_cambio"] or 0
    moneda_vista = config["moneda_visualizacion"] or "CRC"

    def _a_moneda_base(monto, moneda, _tipo_cambio):
        return _convertir(monto, moneda, moneda_vista, tipo_cambio)

    salario_total = _a_moneda_base(config["salario_total"] or 0, config["salario_moneda"], tipo_cambio)

    ingresos_extra_mes = conn.execute(
        "SELECT * FROM ingresos_extra WHERE user_id = ? AND substr(fecha, 1, 7) = ?", (user_id, mes)
    ).fetchall()
    ingresos_extra_total = sum(_a_moneda_base(i["monto"], i["moneda"], tipo_cambio) for i in ingresos_extra_mes)

    # Asegura que todos los objetivos existentes tengan su rubro fijo derivado
    objetivos_existentes = conn.execute("SELECT id FROM objetivos WHERE user_id = ?", (user_id,)).fetchall()
    for o in objetivos_existentes:
        _asegurar_rubro_fijo_de_objetivo(conn, user_id, o["id"])
    conn.commit()

    rubros = conn.execute(
        "SELECT * FROM rubros_fijos WHERE user_id = ? ORDER BY orden, id", (user_id,)
    ).fetchall()
    pagos_mes = conn.execute(
        """SELECT pf.* FROM pagos_fijos pf
           JOIN rubros_fijos rf ON rf.id = pf.rubro_id
           WHERE rf.user_id = ? AND pf.mes = ?""",
        (user_id, mes),
    ).fetchall()
    pagado_por_rubro = {}
    for p in pagos_mes:
        pagado_por_rubro[p["rubro_id"]] = pagado_por_rubro.get(p["rubro_id"], 0) + _a_moneda_base(p["monto"], p["moneda"], tipo_cambio)

    total_fijos_presupuestado = 0
    total_fijos_pagado = 0
    detalle_fijos = []
    for r in rubros:
        monto_q1 = _a_moneda_base(r["monto_q1"], r["moneda"], tipo_cambio)
        monto_q2 = _a_moneda_base(r["monto_q2"], r["moneda"], tipo_cambio)
        presupuestado = monto_q1 + monto_q2
        pagado = pagado_por_rubro.get(r["id"], 0)
        total_fijos_presupuestado += presupuestado
        total_fijos_pagado += pagado
        detalle_fijos.append({
            "id": r["id"],
            "nombre": r["nombre"],
            "presupuestado": presupuestado,
            "monto_q1": monto_q1,
            "monto_q2": monto_q2,
            # Montos en la moneda original del rubro (sin convertir), para que el
            # modal de "marcar pagado" no reenvíe un monto ya convertido como si
            # todavía estuviera en la moneda original (eso duplicaba la conversión).
            "monto_q1_original": r["monto_q1"],
            "monto_q2_original": r["monto_q2"],
            "moneda": r["moneda"],
            "moneda_distinta": r["moneda"] != moneda_vista,
            "pagado": pagado,
            "porcentaje_pagado": round(pagado / presupuestado * 100, 1) if presupuestado else 0,
            "porcentaje_salario": round(presupuestado / salario_total * 100, 1) if salario_total else 0,
            "generado_de_objetivo": bool(r["generado_de_objetivo"]),
        })

    # Gastos variables del mes por categoría (convertidos a moneda base).
    # Excluye las transacciones que solo registran el pago de un rubro fijo:
    # ese monto ya se cuenta en total_fijos_presupuestado, sumarlo aquí también
    # lo duplicaría en el disponible y en el gráfico de distribución del salario.
    variables_raw = conn.execute(
        """SELECT t.categoria_id, c.nombre as categoria, c.color as color, c.emoji as emoji, c.presupuesto_mensual as presupuesto_mensual,
                  t.monto as monto, t.moneda as moneda
           FROM transacciones t
           LEFT JOIN categorias_variables c ON t.categoria_id = c.id
           WHERE t.user_id = ? AND substr(t.fecha, 1, 7) = ? AND (t.origen_archivo IS NULL OR t.origen_archivo != 'pago_fijo')""",
        (user_id, mes),
    ).fetchall()

    agregados = {}
    for v in variables_raw:
        clave = v["categoria_id"]
        if clave not in agregados:
            agregados[clave] = {
                "categoria_id": clave,
                "categoria": v["categoria"],
                "color": v["color"],
                "emoji": v["emoji"],
                # El presupuesto por categoría se guarda en CRC; se convierte a la
                # moneda de visualización elegida para que sea comparable con "total".
                "presupuesto_mensual": _convertir(v["presupuesto_mensual"] or 0, "CRC", moneda_vista, tipo_cambio),
                "total": 0,
                "cantidad": 0,
            }
        agregados[clave]["total"] += _a_moneda_base(v["monto"], v["moneda"], tipo_cambio)
        agregados[clave]["cantidad"] += 1

    detalle_variables = sorted(agregados.values(), key=lambda x: x["total"], reverse=True)
    for v in detalle_variables:
        presupuesto = v["presupuesto_mensual"]
        v["disponible"] = presupuesto - v["total"]
        v["porcentaje_usado"] = round(v["total"] / presupuesto * 100, 1) if presupuesto else None

    # Incluye categorías con presupuesto asignado pero sin gasto este mes, para el gráfico de barras
    todas_categorias = conn.execute(
        "SELECT * FROM categorias_variables WHERE user_id = ? ORDER BY nombre", (user_id,)
    ).fetchall()
    presupuesto_categorias = []
    for c in todas_categorias:
        gastado_existente = next((v for v in detalle_variables if v["categoria_id"] == c["id"]), None)
        gastado = gastado_existente["total"] if gastado_existente else 0
        presupuesto = _convertir(c["presupuesto_mensual"] or 0, "CRC", moneda_vista, tipo_cambio)
        presupuesto_categorias.append({
            "categoria_id": c["id"],
            "categoria": c["nombre"],
            "color": c["color"],
            "emoji": c["emoji"],
            "presupuesto_mensual": presupuesto,
            "gastado": gastado,
            "disponible": presupuesto - gastado,
        })

    total_variables = sum(v["total"] for v in detalle_variables)

    # Total de "consumo" del mes: gasto variable real, excluyendo las categorías del
    # sistema (Ahorros, Deudas, Gastos fijos) que no son consumo. Es lo que encabeza
    # el panel de gastos variables. OJO: distinto de total_variables, que sí incluye
    # esos movimientos porque comprometen el disponible del mes.
    total_consumo = sum(v["total"] for v in detalle_variables if v["categoria"] not in CATEGORIAS_NO_CONSUMO)

    # Total de consumo del mes anterior, para comparar en el dashboard.
    y, m = int(mes[:4]), int(mes[5:7])
    mes_anterior = f"{y - 1:04d}-12" if m == 1 else f"{y:04d}-{m - 1:02d}"
    prev_rows = conn.execute(
        """SELECT t.monto as monto, t.moneda as moneda FROM transacciones t
           LEFT JOIN categorias_variables c ON t.categoria_id = c.id
           WHERE t.user_id = ? AND substr(t.fecha, 1, 7) = ?
             AND (t.origen_archivo IS NULL OR t.origen_archivo != 'pago_fijo')
             AND (c.nombre IS NULL OR c.nombre NOT IN ('Ahorros', 'Deudas', 'Gastos fijos'))""",
        (user_id, mes_anterior),
    ).fetchall()
    total_consumo_anterior = sum(_a_moneda_base(r["monto"], r["moneda"], tipo_cambio) for r in prev_rows)

    disponible = salario_total + ingresos_extra_total - total_fijos_presupuestado
    disponible_restante = disponible - total_variables

    # ----- Disponible de la quincena actual -----
    # Solo tiene sentido si el usuario cobra en dos quincenas, configuró sus días
    # de pago, y está viendo el mes real de hoy (en otro mes no hay un "hoy" que
    # ubicar dentro de una quincena).
    hoy_fecha = datetime.now().date()
    quincena_info = None
    if config["salario_q1"] and config["salario_q2"] and mes == hoy_fecha.strftime("%Y-%m"):
        q = _calcular_quincena_actual(config["dia_pago_q1"] or 15, config["dia_pago_q2"] or 30, hoy_fecha)
        periodo_inicio_str = q["periodo_inicio"].strftime("%Y-%m-%d")
        periodo_fin_str = q["periodo_fin"].strftime("%Y-%m-%d")
        hoy_str = hoy_fecha.strftime("%Y-%m-%d")

        salario_q1_conv = _a_moneda_base(config["salario_q1"] or 0, config["salario_moneda"], tipo_cambio)
        salario_q2_conv = _a_moneda_base(config["salario_q2"] or 0, config["salario_moneda"], tipo_cambio)
        salario_quincena = salario_q1_conv if q["quincena"] == "Q1" else salario_q2_conv

        gastos_fijos_quincena = sum(
            r["monto_q1"] if q["quincena"] == "Q1" else r["monto_q2"] for r in detalle_fijos
        )

        ingresos_extra_quincena = conn.execute(
            "SELECT * FROM ingresos_extra WHERE user_id = ? AND fecha >= ? AND fecha < ?",
            (user_id, periodo_inicio_str, periodo_fin_str),
        ).fetchall()
        ingresos_extra_quincena_total = sum(
            _a_moneda_base(i["monto"], i["moneda"], tipo_cambio) for i in ingresos_extra_quincena
        )

        gasto_variable_quincena_rows = conn.execute(
            """SELECT monto, moneda FROM transacciones
               WHERE user_id = ? AND fecha >= ? AND fecha <= ?
                 AND (origen_archivo IS NULL OR origen_archivo != 'pago_fijo')""",
            (user_id, periodo_inicio_str, hoy_str),
        ).fetchall()
        gasto_variable_quincena = sum(
            _a_moneda_base(r["monto"], r["moneda"], tipo_cambio) for r in gasto_variable_quincena_rows
        )

        disponible_quincena = (
            salario_quincena + ingresos_extra_quincena_total - gastos_fijos_quincena - gasto_variable_quincena
        )

        quincena_info = {
            "quincena": q["quincena"],
            "periodo_inicio": periodo_inicio_str,
            "periodo_fin": periodo_fin_str,
            "dias_para_proximo_pago": q["dias_para_proximo_pago"],
            "disponible_quincena": disponible_quincena,
        }

    # ----- Ritmo de gasto diario (para el gráfico de tendencia del dashboard) -----
    # Suma de gasto variable "real" por día del mes: excluye pagos de rubros fijos,
    # aportes a ahorros y abonos a deudas (esos no son gasto de consumo del día).
    gasto_por_dia_raw = conn.execute(
        """SELECT substr(t.fecha, 9, 2) as dia, t.monto as monto, t.moneda as moneda
           FROM transacciones t
           WHERE t.user_id = ? AND substr(t.fecha, 1, 7) = ?
             AND (t.origen_archivo IS NULL
                  OR t.origen_archivo NOT IN ('pago_fijo', 'aporte_objetivo', 'abono_deuda'))""",
        (user_id, mes),
    ).fetchall()

    anio, mes_num = int(mes[:4]), int(mes[5:7])
    dias_en_mes = calendar.monthrange(anio, mes_num)[1]
    hoy = datetime.now()
    # Si el mes mostrado es el actual, solo consideramos hasta el día de hoy.
    dia_tope = hoy.day if (hoy.year == anio and hoy.month == mes_num) else dias_en_mes

    gasto_diario = {d: 0.0 for d in range(1, dias_en_mes + 1)}
    for r in gasto_por_dia_raw:
        try:
            d = int(r["dia"])
        except (TypeError, ValueError):
            continue
        if d in gasto_diario:
            gasto_diario[d] += _a_moneda_base(r["monto"], r["moneda"], tipo_cambio)

    # Banda "normal": promedio ± una desviación estándar del gasto de los días ya
    # transcurridos. Los días sin gasto cuentan como 0 para que la banda sea realista.
    valores_dias = [gasto_diario[d] for d in range(1, dia_tope + 1)]
    if valores_dias:
        promedio = sum(valores_dias) / len(valores_dias)
        varianza = sum((v - promedio) ** 2 for v in valores_dias) / len(valores_dias)
        desviacion = math.sqrt(varianza)
    else:
        promedio = desviacion = 0
    banda_inferior = max(promedio - desviacion, 0)
    banda_superior = promedio + desviacion

    ritmo_diario = []
    for d in range(1, dias_en_mes + 1):
        gasto = gasto_diario[d]
        transcurrido = d <= dia_tope
        ritmo_diario.append({
            "dia": d,
            "gasto": gasto,
            # Solo marcamos "caro" los días ya transcurridos que se salieron por arriba.
            "fuera_de_rango": transcurrido and gasto > banda_superior and gasto > 0,
            "transcurrido": transcurrido,
        })

    dias_caros = [r["dia"] for r in ritmo_diario if r["fuera_de_rango"]]

    conn.close()
    return jsonify({
        "mes": mes,
        "salario_total": salario_total,
        "ingresos_extra_total": ingresos_extra_total,
        "tipo_cambio": tipo_cambio,
        "moneda_visualizacion": moneda_vista,
        "total_fijos_presupuestado": total_fijos_presupuestado,
        "total_fijos_pagado": total_fijos_pagado,
        "detalle_fijos": detalle_fijos,
        "total_variables": total_variables,
        "total_consumo": total_consumo,
        "total_consumo_anterior": total_consumo_anterior,
        "detalle_variables": detalle_variables,
        "presupuesto_categorias": presupuesto_categorias,
        "disponible_mensual": disponible,
        "disponible_restante": disponible_restante,
        "quincena_actual": quincena_info,
        "ritmo_diario": ritmo_diario,
        "ritmo_banda_inferior": banda_inferior,
        "ritmo_banda_superior": banda_superior,
        "ritmo_promedio": promedio,
        "dias_caros": dias_caros,
    })


if __name__ == "__main__":
    print("Servidor corriendo en http://localhost:5050")
    app.run(host="127.0.0.1", port=5050, debug=False)
