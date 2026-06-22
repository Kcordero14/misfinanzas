"""
Capa de base de datos para la app de finanzas personales.
Usa Postgres (Supabase), accedido vía psycopg2. La conexión se identifica
con la variable de entorno DATABASE_URL (connection string de Supabase).
"""
import os
import re
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

# En Render las variables de entorno ya vienen seteadas en el ambiente; en local
# se leen de un archivo .env en la raíz del proyecto (ver .env.example).
load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]

_PLACEHOLDER = re.compile(r"\?")

# Categorías variables por defecto que se crean para cada usuario nuevo
CATEGORIAS_DEFAULT = [
    ("Comida", "#B5533C", "🍔"),
    ("Súper", "#2E5E45", "🛒"),
    ("Transporte", "#3D6FB5", "🚌"),
    ("Ocio", "#C49A3D", "🎉"),
    ("Salud", "#7A4FB5", "💊"),
    ("Ropa", "#B54F8C", "👕"),
    ("Cuidado personal", "#1E8A99", "💅"),
    ("Hogar", "#D9883D", "🧹"),
    ("Otros", "#6B6862", "🗂️"),
    ("Ahorros", "#1F7A5C", "💰"),
    ("Gastos fijos", "#2C3E50", "📌"),
    ("Deudas", "#8C3A3A", "💳"),
]


class _Conexion:
    """Envuelve una conexión de psycopg2 para que se comporte como una
    sqlite3.Connection: placeholders `?` (en vez de `%s`), un método
    .execute() a nivel de conexión que devuelve el cursor, y filas
    accesibles como diccionario (fila["columna"], dict(fila))."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(_PLACEHOLDER.sub("%s", sql), params)
        return cur

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()


def get_connection():
    conn = psycopg2.connect(DATABASE_URL)
    return _Conexion(conn)


def init_db():
    """Crea el esquema completo si no existe. Idempotente: se puede llamar
    en cada arranque de la app sin riesgo."""
    conn = get_connection()

    # Configuración general: salario, división en quincenas, moneda. Una fila por usuario.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS configuracion (
            user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
            salario_total REAL NOT NULL DEFAULT 0,
            salario_q1 REAL NOT NULL DEFAULT 0,
            salario_q2 REAL NOT NULL DEFAULT 0,
            salario_moneda TEXT NOT NULL DEFAULT 'CRC',
            tipo_cambio REAL NOT NULL DEFAULT 520,
            moneda_visualizacion TEXT NOT NULL DEFAULT 'CRC',
            onboarding_completado INTEGER NOT NULL DEFAULT 0
        )
    """)
    # Para bases ya existentes (creadas antes de este campo): las cuentas que ya
    # estaban en uso se marcan como onboarding ya completado (no se les debe
    # aparecer el carrusel de bienvenida retroactivamente). El DEFAULT de la
    # columna se deja en 0 después, para que sí aparezca en las cuentas nuevas.
    conn.execute("ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS onboarding_completado INTEGER NOT NULL DEFAULT 1")
    conn.execute("ALTER TABLE configuracion ALTER COLUMN onboarding_completado SET DEFAULT 0")
    conn.commit()

    # Objetivos de largo plazo (colchón financiero, prima casa, etc.)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS objetivos (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            nombre TEXT NOT NULL,
            monto_total REAL NOT NULL,
            meses_plazo INTEGER NOT NULL,
            acumulado REAL NOT NULL DEFAULT 0,
            creado_en TEXT NOT NULL,
            moneda TEXT NOT NULL DEFAULT 'CRC',
            dividir_quincenas INTEGER NOT NULL DEFAULT 0,
            UNIQUE(user_id, nombre)
        )
    """)

    # Deudas (tarjetas, préstamos, etc.). El saldo va bajando con los pagos/abonos.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS deudas (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            nombre TEXT NOT NULL,
            saldo_inicial REAL NOT NULL,
            saldo_actual REAL NOT NULL,
            cuota_minima REAL NOT NULL,
            tasa_interes_anual REAL,
            moneda TEXT NOT NULL DEFAULT 'CRC',
            dividir_quincenas INTEGER NOT NULL DEFAULT 0,
            creado_en TEXT NOT NULL,
            UNIQUE(user_id, nombre)
        )
    """)

    # Rubros de gastos fijos mensuales. Pueden vincularse a un objetivo o a una deuda.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rubros_fijos (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            nombre TEXT NOT NULL,
            monto_q1 REAL NOT NULL DEFAULT 0,
            monto_q2 REAL NOT NULL DEFAULT 0,
            objetivo_id INTEGER REFERENCES objetivos(id) ON DELETE SET NULL,
            orden INTEGER NOT NULL DEFAULT 0,
            moneda TEXT NOT NULL DEFAULT 'CRC',
            generado_de_objetivo INTEGER NOT NULL DEFAULT 0,
            deuda_id INTEGER REFERENCES deudas(id) ON DELETE SET NULL,
            UNIQUE(user_id, nombre)
        )
    """)

    # Pagos realizados de rubros fijos, por mes (YYYY-MM). Ya queda acotado por usuario
    # a través de rubro_id, que pertenece a un usuario.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pagos_fijos (
            id SERIAL PRIMARY KEY,
            rubro_id INTEGER NOT NULL REFERENCES rubros_fijos(id) ON DELETE CASCADE,
            mes TEXT NOT NULL,
            quincena TEXT NOT NULL CHECK (quincena IN ('Q1','Q2')),
            monto REAL NOT NULL,
            fecha_pago TEXT NOT NULL,
            origen TEXT NOT NULL DEFAULT 'manual',
            moneda TEXT NOT NULL DEFAULT 'CRC',
            UNIQUE(rubro_id, mes, quincena)
        )
    """)

    # Categorías de gastos variables (Comida, Súper, Transporte, etc.)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS categorias_variables (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            nombre TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#B5533C',
            presupuesto_mensual REAL NOT NULL DEFAULT 0,
            emoji TEXT NOT NULL DEFAULT '🏷️',
            UNIQUE(user_id, nombre)
        )
    """)

    # Reglas de aprendizaje: comercio -> categoría (se actualiza cuando el usuario corrige)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS reglas_comercio (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            comercio TEXT NOT NULL,
            categoria_id INTEGER NOT NULL REFERENCES categorias_variables(id) ON DELETE CASCADE,
            UNIQUE(user_id, comercio)
        )
    """)

    # Transacciones variables, importadas de correos o agregadas a mano
    conn.execute("""
        CREATE TABLE IF NOT EXISTS transacciones (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            comercio TEXT NOT NULL,
            ciudad TEXT,
            fecha TEXT NOT NULL,
            monto REAL NOT NULL,
            moneda TEXT NOT NULL DEFAULT 'CRC',
            tarjeta TEXT,
            autorizacion TEXT,
            referencia TEXT,
            categoria_id INTEGER REFERENCES categorias_variables(id) ON DELETE SET NULL,
            categoria_corregida INTEGER NOT NULL DEFAULT 0,
            origen_archivo TEXT,
            importado_en TEXT NOT NULL,
            UNIQUE(user_id, referencia)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_transacciones_user_fecha ON transacciones(user_id, fecha)")

    # Ahorros: aportes manuales (o derivados de rubro fijo) a un objetivo de largo plazo
    conn.execute("""
        CREATE TABLE IF NOT EXISTS aportes_objetivo (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            objetivo_id INTEGER NOT NULL REFERENCES objetivos(id) ON DELETE CASCADE,
            monto REAL NOT NULL,
            fecha TEXT NOT NULL,
            nota TEXT,
            origen TEXT NOT NULL DEFAULT 'manual'
        )
    """)

    # Abonos a deudas: pagos extra aparte de la cuota mínima mensual/quincenal
    conn.execute("""
        CREATE TABLE IF NOT EXISTS abonos_deuda (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            deuda_id INTEGER NOT NULL REFERENCES deudas(id) ON DELETE CASCADE,
            monto REAL NOT NULL,
            fecha TEXT NOT NULL,
            nota TEXT,
            origen TEXT NOT NULL DEFAULT 'manual'
        )
    """)

    # Ingresos extraordinarios: plata aparte del salario (ventas, regalos, trabajos extra...)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ingresos_extra (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            descripcion TEXT NOT NULL,
            monto REAL NOT NULL,
            moneda TEXT NOT NULL DEFAULT 'CRC',
            fecha TEXT NOT NULL
        )
    """)

    # Estado de sincronización con Gmail (etiqueta a usar, último mensaje visto, token
    # OAuth). Una fila por usuario. El token vive en la base (no en disco) porque el
    # disco de Render no es persistente entre reinicios/despliegues.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_gmail (
            user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
            etiqueta TEXT NOT NULL DEFAULT 'Facturas electronicas',
            ultimo_mensaje_id TEXT,
            ultima_sincronizacion TEXT,
            token_json TEXT
        )
    """)

    # Backfill de emoji para categorías por defecto creadas antes de tener
    # iconos propios: solo toca las que se quedaron con el emoji genérico, así
    # no pisa un emoji que el usuario ya haya personalizado a mano.
    for nombre, _color, emoji in CATEGORIAS_DEFAULT:
        conn.execute(
            "UPDATE categorias_variables SET emoji = ? WHERE nombre = ? AND emoji = '🏷️'",
            (emoji, nombre),
        )

    conn.commit()
    conn.close()


def asegurar_datos_iniciales(user_id):
    """Crea las filas de arranque (configuración, sync_gmail, categorías por
    defecto) para un usuario nuevo. Idempotente: seguro llamarlo en cada login."""
    conn = get_connection()

    conn.execute(
        "INSERT INTO configuracion (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING",
        (user_id,),
    )
    conn.execute(
        """INSERT INTO sync_gmail (user_id, etiqueta) VALUES (?, 'Facturas electronicas')
           ON CONFLICT (user_id) DO NOTHING""",
        (user_id,),
    )
    for nombre, color, emoji in CATEGORIAS_DEFAULT:
        conn.execute(
            """INSERT INTO categorias_variables (user_id, nombre, color, emoji) VALUES (?, ?, ?, ?)
               ON CONFLICT (user_id, nombre) DO NOTHING""",
            (user_id, nombre, color, emoji),
        )

    conn.commit()
    conn.close()


if __name__ == "__main__":
    init_db()
    print("Esquema inicializado en Supabase.")
