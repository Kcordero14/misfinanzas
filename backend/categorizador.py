"""
Motor de categorización de gastos variables.

Estrategia:
1. Si ya existe una regla guardada para ese comercio exacto (porque el usuario
   corrigió antes), se usa esa.
2. Si no, se intenta adivinar por palabras clave comunes en comercios de Costa Rica.
3. Si no hay coincidencia, va a "Otros" y queda pendiente de revisión.

Cuando el usuario corrige manualmente la categoría de una transacción, se guarda
una regla para ese comercio exacto, de modo que la próxima vez se categorice solo.
"""

# Palabras clave -> nombre de categoría (debe existir en categorias_variables)
PALABRAS_CLAVE = {
    "Súper": [
        "WALMART", "MAXI", "MAS X MENOS", "MASXMENOS", "AUTOMERCADO",
        "PALI", "PRICE SMART", "PRICESMART", "FRESH MARKET", "SUPER",
    ],
    "Comida": [
        "SODA", "RESTAURANT", "RESTAURANTE", "SARITA", "OKAYAMA", "SUSHI",
        "PIZZA", "MCDONALD", "KFC", "BURGER", "TACO", "POPS", "SPOON",
        "ROSTI", "CAFE", "CAFETERIA", "PANADERIA", "PASTELERIA", "BAR ",
        "WAFFLE", "DELI", "GRILL", "WENDY",
    ],
    "Transporte": [
        "UBER", "DIDI", "INDRIVE", "GASOLINERA", "SERVICENTRO", "DELTA",
        "RECOPE", "GAS STATION", "ESTACION", "TAXI", "PARKING", "PARQUEO",
    ],
    "Entretenimiento": [
        "CINEMARK", "CINE", "NOVA CINEMAS", "NETFLIX", "SPOTIFY", "DISNEY",
        "HBO", "STEAM", "PLAYSTATION", "XBOX", "TEATRO", "CONCIERTO",
    ],
    "Salud": [
        "FARMACIA", "FISCHEL", "SUCRE", "LA BOMBA", "CLINICA", "HOSPITAL",
        "LABORATORIO", "DENTAL", "OPTICA",
    ],
    "Ropa": [
        "ZARA", "H&M", "SIMAN", "PULL AND BEAR", "ADIDAS", "NIKE",
        "DEPORTIVO", "SHOES", "FACTORY",
    ],
}


def sugerir_categoria(conn, user_id, comercio: str) -> int | None:
    """Devuelve el id de categoría sugerida para un comercio, o None si no hay pista."""
    comercio_norm = comercio.upper().strip()

    # 1. Regla aprendida para este comercio exacto
    row = conn.execute(
        "SELECT categoria_id FROM reglas_comercio WHERE user_id = ? AND comercio = ?",
        (user_id, comercio_norm),
    ).fetchone()
    if row:
        return row["categoria_id"]

    # 2. Palabras clave
    for nombre_categoria, palabras in PALABRAS_CLAVE.items():
        for palabra in palabras:
            if palabra in comercio_norm:
                cat_row = conn.execute(
                    "SELECT id FROM categorias_variables WHERE user_id = ? AND nombre = ?",
                    (user_id, nombre_categoria),
                ).fetchone()
                if cat_row:
                    return cat_row["id"]

    # 3. Sin pista: "Otros"
    cat_row = conn.execute(
        "SELECT id FROM categorias_variables WHERE user_id = ? AND nombre = 'Otros'",
        (user_id,),
    ).fetchone()
    return cat_row["id"] if cat_row else None


def aprender_categoria(conn, user_id, comercio: str, categoria_id: int):
    """Guarda/actualiza la regla para que este comercio siempre caiga en esta categoría."""
    comercio_norm = comercio.upper().strip()
    conn.execute(
        """
        INSERT INTO reglas_comercio (user_id, comercio, categoria_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, comercio) DO UPDATE SET categoria_id = excluded.categoria_id
        """,
        (user_id, comercio_norm, categoria_id),
    )
    conn.commit()
