-- Esquema de la app de finanzas personales para Supabase (Postgres).
--
-- Cómo usarlo:
--   1. Entrá a tu proyecto en supabase.com -> SQL Editor -> New query.
--   2. Pegá todo este archivo y dale "Run".
--
-- Nota: la app también crea estas mismas tablas automáticamente la primera
-- vez que arranca (CREATE TABLE IF NOT EXISTS), así que correr este script
-- a mano es opcional. Se entrega para que puedas revisar el esquema antes
-- de conectar la app, o recrearlo manualmente si hace falta.

CREATE TABLE IF NOT EXISTS configuracion (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    salario_total REAL NOT NULL DEFAULT 0,
    salario_q1 REAL NOT NULL DEFAULT 0,
    salario_q2 REAL NOT NULL DEFAULT 0,
    salario_moneda TEXT NOT NULL DEFAULT 'CRC',
    tipo_cambio REAL NOT NULL DEFAULT 520,
    moneda_visualizacion TEXT NOT NULL DEFAULT 'CRC'
);

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
);

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
);

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
);

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
);

CREATE TABLE IF NOT EXISTS categorias_variables (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#B5533C',
    presupuesto_mensual REAL NOT NULL DEFAULT 0,
    emoji TEXT NOT NULL DEFAULT '🏷️',
    UNIQUE(user_id, nombre)
);

CREATE TABLE IF NOT EXISTS reglas_comercio (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    comercio TEXT NOT NULL,
    categoria_id INTEGER NOT NULL REFERENCES categorias_variables(id) ON DELETE CASCADE,
    UNIQUE(user_id, comercio)
);

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
);
CREATE INDEX IF NOT EXISTS idx_transacciones_user_fecha ON transacciones(user_id, fecha);

CREATE TABLE IF NOT EXISTS aportes_objetivo (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    objetivo_id INTEGER NOT NULL REFERENCES objetivos(id) ON DELETE CASCADE,
    monto REAL NOT NULL,
    fecha TEXT NOT NULL,
    nota TEXT,
    origen TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS abonos_deuda (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    deuda_id INTEGER NOT NULL REFERENCES deudas(id) ON DELETE CASCADE,
    monto REAL NOT NULL,
    fecha TEXT NOT NULL,
    nota TEXT,
    origen TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS ingresos_extra (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    descripcion TEXT NOT NULL,
    monto REAL NOT NULL,
    moneda TEXT NOT NULL DEFAULT 'CRC',
    fecha TEXT NOT NULL
);

-- Una fila por usuario: etiqueta de Gmail a sincronizar, último mensaje visto,
-- y el token OAuth (se guarda acá y no en disco porque Render no tiene disco
-- persistente entre reinicios/despliegues en el plan gratis).
CREATE TABLE IF NOT EXISTS sync_gmail (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    etiqueta TEXT NOT NULL DEFAULT 'Facturas electronicas',
    ultimo_mensaje_id TEXT,
    ultima_sincronizacion TEXT,
    token_json TEXT
);
