# Mis finanzas

App web para llevar tu plan financiero: salario, gastos fijos, objetivos de
largo plazo, deudas y gastos variables importados de los correos de
notificación del banco. Es **multiusuario**: cada persona se registra con su
correo y contraseña, y solo ve sus propios datos.

La app corre en [Render](https://render.com) (hosting gratis) y guarda los
datos en [Supabase](https://supabase.com) (base de datos Postgres gratis).
También podés correrla en tu computadora apuntando al mismo proyecto de
Supabase.

## 1. Crear el proyecto de Supabase (una sola vez)

1. Entrá a [supabase.com](https://supabase.com), creá una cuenta gratis y
   hacé clic en **"New project"**.
2. Ponele un nombre, elegí una contraseña para la base de datos (guardala,
   la vas a necesitar) y una región cercana. Esperá un par de minutos a que
   el proyecto termine de crearse.
3. **Desactivá la confirmación de correo obligatoria** (para que registrarse
   sea instantáneo): andá a **Authentication → Providers → Email** y apagá
   la opción **"Confirm email"**. Guardá los cambios.
4. (Opcional) El esquema de tablas se crea solo la primera vez que arranca
   la app, pero si querés revisarlo antes podés correr el archivo
   `supabase_schema.sql` de este repo en **SQL Editor → New query**.
5. Anotá estos tres datos, los vas a necesitar en el paso 2:
   - **Connection string**: `Project Settings → Database → Connection
     string` (modo "URI"). Reemplazá `[YOUR-PASSWORD]` por la contraseña
     que pusiste en el paso 2.
   - **Project URL**: `Project Settings → API → Project URL`.
   - **anon public key**: `Project Settings → API → Project API keys →
     anon public`.

## 2. Correr la app en tu computadora

**Necesitás Python 3** (en Windows lo descargás de
[python.org](https://www.python.org/downloads/) — al instalar, marcá la
casilla "Add Python to PATH").

1. Abrí una terminal dentro de esta carpeta (`gastos-app`).
2. Copiá `.env.example` a un archivo nuevo llamado `.env` y completá
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `FLASK_SECRET_KEY`
   con los datos del paso 1 (`FLASK_SECRET_KEY` puede ser cualquier texto
   largo inventado por vos). Dejá `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
   vacíos por ahora si todavía no vas a usar la sincronización con Gmail.
3. Corré:

   ```
   python3 iniciar.py
   ```

   (en Windows puede ser `python iniciar.py`)

4. Se va a abrir solo una pestaña en tu navegador en `http://127.0.0.1:5050`.
   Registrate con tu correo y una contraseña.
5. Para cerrar la app: volvé a la terminal y presioná `Ctrl + C`.

## 3. Primeros pasos dentro de la app

1. **Configurar** → metés tu salario total y cómo se divide en Q1/Q2, y
   creás tus rubros de gastos fijos (igual que tu Excel).
2. **Ahorros** → creás tus metas de largo plazo (colchón financiero, prima
   casa, etc.) con el monto total y los meses de plazo; la app genera sola
   el rubro fijo mensual correspondiente.
3. **Deudas** → registrás el saldo y la cuota mínima; cada cuota pagada
   reduce el saldo automáticamente.
4. **Transacciones** → arrastrá ahí los archivos `.eml` que descargás de tu
   carpeta de Gmail con las notificaciones de compra (o conectá Gmail para
   que se importen solas, ver más abajo). La app reconoce el comercio, el
   monto y la fecha, y le asigna una categoría automáticamente (Comida,
   Súper, Transporte, etc.). Si la categoría queda mal asignada, la cambiás
   vos — la próxima vez que llegue una compra de ese mismo comercio, la app
   ya se acuerda y la pone bien sola.
5. **Dashboard** → vista mensual de cuánto llevás pagado de cada gasto fijo,
   cuánto gastaste en variables por categoría, y cuánto te queda disponible.

## 4. Conectar Gmail (sincronización automática, opcional)

Con esto, en vez de descargar cada correo a mano, apretás un botón
"Sincronizar ahora" y la app trae sola todos los correos nuevos de tu
etiqueta. Lo configura **quien administra el servidor**, una sola vez para
toda la app (todos los usuarios que se registren después solo tienen que
apretar "Conectar Gmail" con su propia cuenta).

### Paso 1: Crear un proyecto en Google Cloud (gratis)

1. Entrá a [console.cloud.google.com](https://console.cloud.google.com/),
   creá un proyecto nuevo (por ejemplo `Mis Finanzas`).
2. Buscá **"Gmail API"** en la barra de búsqueda y hacé clic en
   **"Habilitar"**.

### Paso 2: Configurar la pantalla de consentimiento

1. Menú (☰) → **"APIs y servicios" → "Pantalla de consentimiento de
   OAuth"**. Elegí **"Externo"** y completá lo básico (nombre, tu correo).
   Guardá y continuá hasta el final con los valores por defecto.
2. En **"Usuarios de prueba"**, agregá los correos de las personas que vayan
   a usar la sincronización con Gmail (mientras la app esté en modo de
   prueba, solo esos correos van a poder conectar su cuenta).

### Paso 3: Crear las credenciales (tipo "Aplicación web")

1. **"APIs y servicios" → "Credenciales" → "+ Crear credenciales" → "ID de
   cliente de OAuth"**.
2. En "Tipo de aplicación" elegí **"Aplicación web"** (no "Escritorio").
3. En **"URIs de redirección autorizados"** agregá las dos:
   - `http://127.0.0.1:5050/api/gmail/callback` (para probar en tu compu)
   - `https://TU-APP.onrender.com/api/gmail/callback` (para producción, una
     vez que sepas la URL que te dio Render — podés agregarla después
     editando estas mismas credenciales)
4. Hacé clic en **"Crear"**. Te muestra un **Client ID** y un **Client
   secret** — copialos.

### Paso 4: Guardar las credenciales

- **En local**: pegalas en tu `.env` como `GOOGLE_CLIENT_ID` y
  `GOOGLE_CLIENT_SECRET`, y reiniciá `iniciar.py`.
- **En Render**: agregalas como variables de entorno del servicio (ver
  sección 5).

### Paso 5: Conectar tu cuenta

1. Andá a **Configurar → Conexión con Gmail → "Conectar Gmail"**.
2. Se te va a pedir elegir tu cuenta de Google y autorizar el acceso de
   solo lectura. Aceptá (como la app está en modo de prueba, Google puede
   mostrar "Google no verificó esta app" — hacé clic en "Avanzado" → "Ir a
   Mis Finanzas (no seguro)" para continuar).
3. Volvés a la app ya conectado. Andá a **Transacciones** y apretá
   "Sincronizar ahora".

Por defecto sincroniza la etiqueta **"Facturas electronicas"**; cambiala en
**Configurar** si la tuya se llama distinto. El acceso es de **solo
lectura** (no puede borrar ni enviar correos), y podés desconectarlo en
cualquier momento desde **Configurar** o desde
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## 5. Desplegar en Render (hosting gratis)

1. Subí este proyecto a un repositorio de GitHub.
2. En [render.com](https://render.com), creá una cuenta y hacé clic en
   **"New +" → "Web Service"**, conectá tu repositorio.
3. Configurá:
   - **Root Directory**: `backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app`
   - **Instance Type**: Free
4. En **"Environment"**, agregá las variables: `DATABASE_URL`,
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FLASK_SECRET_KEY`, y si vas a usar
   Gmail, `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` (los mismos valores
   de tu `.env`, nunca los subas al repositorio).
5. Creá el servicio. Cuando termine de desplegar te da una URL del tipo
   `https://tu-app.onrender.com`.
6. Si vas a usar Gmail, volvé a Google Cloud Console y agregá esa URL +
   `/api/gmail/callback` a los "URIs de redirección autorizados" de tus
   credenciales (paso 3 de la sección 4).

**Nota del plan gratis de Render:** el servicio se "duerme" después de ~15
minutos sin uso, y tarda unos segundos en despertar la próxima vez que
alguien entra. Eso es normal y no afecta tus datos (viven en Supabase, no
en el servidor).

## 6. Cómo descargar los correos de Gmail manualmente (alternativa)

1. Abrí el correo de notificación de la compra en Gmail.
2. Hacé clic en los tres puntos (⋮) arriba a la derecha del correo.
3. Elegí "Descargar mensaje".
4. Se descarga un archivo `.eml` — ese es el que arrastrás a la pestaña
   "Transacciones".

Por ahora la app reconoce el formato de notificaciones del **BAC
Credomatic**. Si más adelante usás otro banco, contame el formato del
correo y agrego el soporte.

## Dónde quedan tus datos

Todo se guarda en tu proyecto de Supabase (Postgres en la nube), no en el
servidor de Render ni en tu computadora. Cada usuario registrado solo ve
sus propios datos. Supabase no hace backups automáticos en el plan
gratuito, así que si tenés datos importantes es buena idea exportarlos de
vez en cuando (`Table Editor` → exportar como CSV, o un `pg_dump` si te
sentís cómodo con la terminal).

## Estructura del proyecto

```
gastos-app/
├── iniciar.py            ← corré este archivo para abrir la app en local
├── .env.example           (plantilla de variables de entorno)
├── supabase_schema.sql     (esquema de la base de datos, opcional)
├── backend/
│   ├── app.py              (servidor y rutas)
│   ├── db.py                (conexión a Postgres/Supabase)
│   ├── auth.py               (registro/login contra Supabase Auth)
│   ├── gmail_integracion.py   (OAuth web + sincronización con Gmail)
│   ├── parser.py               (lee los correos .eml)
│   ├── categorizador.py         (asigna categorías automáticamente)
│   └── requirements.txt
└── frontend/
    ├── index.html
    ├── style.css
    └── app.js
```
