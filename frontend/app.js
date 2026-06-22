// ===== Estado global =====
const API = "/api";
let mesActual = nuevoMesActual();
let categorias = [];
// Moneda elegida en Configurar para mostrar todos los montos de la app, y el
// tipo de cambio vigente para convertir hacia/desde ella. Se actualizan al
// cargar el dashboard o la configuración (que son la fuente de verdad).
let monedaVisualizacion = "CRC";
let tipoCambioGlobal = 520;

function nuevoMesActual() {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
}

function formatoColones(monto) {
  return formatoMonto(monto, monedaVisualizacion);
}

function formatoMonto(monto, moneda) {
  const n = Math.round(monto || 0);
  if (moneda === "USD") return "$" + n.toLocaleString("en-US");
  return "₡" + n.toLocaleString("es-CR");
}

// Convierte un color hex (#RRGGBB) a rgba con la transparencia dada, para usar
// el color de categoría como fondo suave sin definir una variante "-suave" por cada una.
function hexARgba(hex, alpha) {
  const limpio = (hex || "").replace("#", "");
  if (limpio.length !== 6) return `rgba(92,107,122,${alpha})`;
  const r = parseInt(limpio.slice(0, 2), 16);
  const g = parseInt(limpio.slice(2, 4), 16);
  const b = parseInt(limpio.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Convierte un monto desde su moneda original hacia la moneda de visualización elegida.
function convertirAMonedaVisualizacion(monto, monedaOrigen) {
  monto = monto || 0;
  monedaOrigen = monedaOrigen || "CRC";
  if (monedaOrigen === monedaVisualizacion) return monto;
  if (monedaOrigen === "USD" && monedaVisualizacion === "CRC") return monto * tipoCambioGlobal;
  if (monedaOrigen === "CRC" && monedaVisualizacion === "USD") return tipoCambioGlobal ? monto / tipoCambioGlobal : 0;
  return monto;
}

// Formatea un monto convertido a la moneda de visualización elegida.
function formatoConvertido(monto, monedaOrigen) {
  return formatoMonto(convertirAMonedaVisualizacion(monto, monedaOrigen), monedaVisualizacion);
}

// Nota gris que aclara el monto original cuando difiere de la moneda de visualización.
function notaMonedaOriginal(monto, monedaOrigen) {
  if (!monedaOrigen || monedaOrigen === monedaVisualizacion) return "";
  return `<span class="nota-moneda-original">(${formatoMonto(monto, monedaOrigen)} original)</span>`;
}

// Convierte un monto entre CRC y USD usando el tipo de cambio global (no depende
// de la moneda de visualización elegida, sirve para convertir entre dos monedas cualesquiera).
function convertirEntreMonedas(monto, monedaOrigen, monedaDestino) {
  monto = monto || 0;
  monedaOrigen = monedaOrigen || "CRC";
  if (monedaOrigen === monedaDestino) return monto;
  if (monedaOrigen === "USD" && monedaDestino === "CRC") return monto * tipoCambioGlobal;
  if (monedaOrigen === "CRC" && monedaDestino === "USD") return tipoCambioGlobal ? monto / tipoCambioGlobal : 0;
  return monto;
}

function formatoFecha(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  return d.toLocaleDateString("es-CR", { day: "2-digit", month: "short" });
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
    ...options,
  });
  if (!res.ok) {
    console.error("Error API", path, res.status);
  }
  return res.json();
}

// ===== Navegación de tabs =====
const NOMBRES_TAB = {
  dashboard: "Dashboard",
  objetivos: "Ahorros",
  deudas: "Deudas",
  gastos: "Transacciones",
  config: "Configurar",
};

document.querySelectorAll(".pestana").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pestana").forEach((b) => b.classList.remove("activa"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.add("oculta"));
    btn.classList.add("activa");
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("oculta");
    cargarTabActiva(btn.dataset.tab);

    document.getElementById("menu-movil-label").textContent = NOMBRES_TAB[btn.dataset.tab] || btn.dataset.tab;
    document.getElementById("pestanas").classList.remove("menu-abierto");
    document.getElementById("btn-menu-movil").setAttribute("aria-expanded", "false");
  });
});

document.getElementById("btn-menu-movil").addEventListener("click", () => {
  const nav = document.getElementById("pestanas");
  const abierto = nav.classList.toggle("menu-abierto");
  document.getElementById("btn-menu-movil").setAttribute("aria-expanded", String(abierto));
});

function cargarTabActiva(tab) {
  if (tab === "dashboard") cargarDashboard();
  if (tab === "objetivos") cargarObjetivos();
  if (tab === "deudas") cargarDeudas();
  if (tab === "gastos") cargarGastos();
  if (tab === "config") cargarConfig();
}

// ===== Selector de mes =====
const selectorMes = document.getElementById("selector-mes");
selectorMes.value = mesActual;
selectorMes.addEventListener("change", () => {
  mesActual = selectorMes.value;
  const tabActiva = document.querySelector(".pestana.activa").dataset.tab;
  cargarTabActiva(tabActiva);
});

// =====================================================================
// Autenticación
// =====================================================================
let modoAuthRegistro = false;

async function verificarSesion() {
  const data = await api("/auth/sesion");
  if (data.sesion_activa) {
    mostrarApp();
  } else {
    mostrarLogin();
  }
}

function mostrarLogin() {
  document.getElementById("auth-overlay").classList.remove("oculta");
  document.getElementById("app-shell").classList.add("oculta");
}

async function mostrarApp() {
  document.getElementById("auth-overlay").classList.add("oculta");
  document.getElementById("app-shell").classList.remove("oculta");
  cargarDashboard();
  comprobarRetornoGmail();

  const config = await api("/configuracion");
  if (config && !config.onboarding_completado) {
    abrirOnboarding();
  }
}

// Si volvemos del flujo de autorización de Gmail (redirect_uri -> /?gmail=conectado),
// limpiamos la URL y abrimos directamente la pestaña de Configurar para mostrar el resultado.
function comprobarRetornoGmail() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("gmail") === "conectado") {
    window.history.replaceState({}, "", window.location.pathname);
    document.querySelector('.pestana[data-tab="config"]').click();
  }
}

document.getElementById("btn-auth-toggle").addEventListener("click", () => {
  modoAuthRegistro = !modoAuthRegistro;
  document.getElementById("auth-modo").textContent = modoAuthRegistro ? "Crear cuenta" : "Iniciar sesión";
  document.getElementById("auth-submit").textContent = modoAuthRegistro ? "Crear cuenta" : "Entrar";
  document.getElementById("auth-toggle-texto").textContent = modoAuthRegistro ? "¿Ya tenés cuenta?" : "¿No tenés cuenta?";
  document.getElementById("btn-auth-toggle").textContent = modoAuthRegistro ? "Iniciar sesión" : "Crear cuenta";
  document.getElementById("auth-error").classList.add("oculta");
  document.getElementById("auth-info").classList.add("oculta");
});

document.getElementById("form-auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  const correo = document.getElementById("auth-correo").value.trim();
  const password = document.getElementById("auth-password").value;
  const errorEl = document.getElementById("auth-error");
  const infoEl = document.getElementById("auth-info");
  errorEl.classList.add("oculta");
  infoEl.classList.add("oculta");

  const boton = document.getElementById("auth-submit");
  boton.disabled = true;
  const ruta = modoAuthRegistro ? "/auth/registro" : "/auth/login";
  const data = await api(ruta, { method: "POST", body: JSON.stringify({ correo, password }) });
  boton.disabled = false;

  if (data.error) {
    errorEl.textContent = data.error;
    errorEl.classList.remove("oculta");
    return;
  }
  if (data.requiere_confirmacion) {
    infoEl.textContent = "Cuenta creada. Revisá tu correo para confirmarla y después iniciá sesión.";
    infoEl.classList.remove("oculta");
    return;
  }
  document.getElementById("form-auth").reset();
  mostrarApp();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  mostrarLogin();
});

// =====================================================================
// Carrusel de bienvenida (solo se muestra a cuentas nuevas, ver mostrarApp())
// =====================================================================
const ONBOARDING_PASOS = ["bienvenida", "salario", "fijos", "ahorros", "deudas", "variables", "resumen"];
const CATEGORIAS_SISTEMA_ONBOARDING = ["Ahorros", "Gastos fijos", "Deudas"];
// "Otros" sigue existiendo como categoría real en el resto de la app (Configurar,
// transacciones...); solo se oculta como botón en el paso de presupuesto del
// carrusel porque no aporta nada elegir un monto para un cajón de "lo que sea".
const CATEGORIAS_OCULTAS_ONBOARDING_VARIABLES = ["Otros"];
let onboardingPaso = 0;

function abrirOnboarding() {
  onboardingPaso = 0;
  document.getElementById("onboarding-overlay").classList.remove("oculta");
  renderOnboardingPaso();
}

async function cerrarOnboarding() {
  document.getElementById("onboarding-overlay").classList.add("oculta");
  await api("/onboarding/completar", { method: "POST" });
  cargarDashboard();
  if (document.querySelector(".pestana.activa").dataset.tab === "config") cargarConfig();
}

document.getElementById("onboarding-omitir-todo").addEventListener("click", cerrarOnboarding);

function renderOnboardingPuntos() {
  document.getElementById("onboarding-puntos").innerHTML = ONBOARDING_PASOS.map((_, i) => {
    let clase = "onboarding-punto";
    if (i === onboardingPaso) clase += " activo";
    else if (i < onboardingPaso) clase += " completado";
    return `<span class="${clase}"></span>`;
  }).join("");
}

function onboardingIr(delta) {
  onboardingPaso += delta;
  renderOnboardingPaso();
}

// Bloque reutilizable de "Atrás / Omitir paso / Continuar" para cada paso del carrusel.
function onboardingAcciones({ mostrarAtras = true, mostrarOmitir = false, textoContinuar = "Continuar →" } = {}) {
  return `
    <div class="onboarding-acciones">
      ${mostrarAtras ? `<button class="boton-secundario" id="onboarding-btn-atras">Atrás</button>` : "<span></span>"}
      <div class="onboarding-acciones-derecha">
        ${mostrarOmitir ? `<button class="boton-texto" id="onboarding-btn-omitir">Omitir paso</button>` : ""}
        <button class="boton-primario" id="onboarding-btn-continuar">${textoContinuar}</button>
      </div>
    </div>
  `;
}

function conectarOnboardingAcciones({ onContinuar, onOmitir }) {
  const btnAtras = document.getElementById("onboarding-btn-atras");
  if (btnAtras) btnAtras.addEventListener("click", () => onboardingIr(-1));
  const btnOmitir = document.getElementById("onboarding-btn-omitir");
  if (btnOmitir) btnOmitir.addEventListener("click", () => (onOmitir ? onOmitir() : onboardingIr(1)));
  document.getElementById("onboarding-btn-continuar").addEventListener("click", onContinuar);
}

async function renderOnboardingPaso() {
  renderOnboardingPuntos();
  const fns = {
    bienvenida: renderOnboardingBienvenida,
    salario: renderOnboardingSalario,
    fijos: renderOnboardingFijos,
    ahorros: renderOnboardingAhorros,
    deudas: renderOnboardingDeudas,
    variables: renderOnboardingVariables,
    resumen: renderOnboardingResumen,
  };
  await fns[ONBOARDING_PASOS[onboardingPaso]]();
}

function renderOnboardingBienvenida() {
  document.getElementById("onboarding-contenido").innerHTML = `
    <div class="onboarding-paso">
      <div class="onboarding-bienvenida-emoji">👋</div>
      <h2>¡Bienvenido/a!</h2>
      <p class="onboarding-paso-sub">Configuremos lo básico en un par de minutos. Podés saltarte cualquier paso.</p>
      <div class="onboarding-acciones">
        <span></span>
        <div class="onboarding-acciones-derecha">
          <button class="boton-primario" id="onboarding-btn-empezar">Vamos 🚀</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("onboarding-btn-empezar").addEventListener("click", () => onboardingIr(1));
}

async function renderOnboardingSalario() {
  const config = await api("/configuracion");
  document.getElementById("onboarding-contenido").innerHTML = `
    <div class="onboarding-paso">
      <div class="onboarding-bienvenida-emoji">💰</div>
      <span class="onboarding-paso-eyebrow">Paso 1 de 5</span>
      <h2>¿Cuánto ganás al mes?</h2>
      <p class="onboarding-paso-sub">Con esto calculamos cuánto te queda disponible para gastar cada mes, después de tus gastos fijos.</p>
      <label>Salario total mensual</label>
      <input type="number" id="onb-salario-total" value="${config.salario_total || ""}" step="1" min="0" placeholder="Ej. 650000">
      <label>Moneda</label>
      <select id="onb-salario-moneda">
        <option value="CRC" ${config.salario_moneda !== "USD" ? "selected" : ""}>Colones (CRC)</option>
        <option value="USD" ${config.salario_moneda === "USD" ? "selected" : ""}>Dólares (USD)</option>
      </select>
      <label class="modal-check">
        <input type="checkbox" id="onb-salario-quincenas" ${config.salario_q1 > 0 && config.salario_q2 > 0 ? "checked" : ""}>
        Lo recibo en dos quincenas iguales
      </label>
      <div id="onb-dias-pago" style="display:${config.salario_q1 > 0 && config.salario_q2 > 0 ? "block" : "none"};">
        <p class="onboarding-paso-sub">¿Qué día del mes te pagan cada quincena? Así sabemos cuánto te queda disponible hasta tu próximo pago.</p>
        <label>Día de pago quincena 1</label>
        <input type="number" id="onb-dia-pago-q1" min="1" max="31" value="${config.dia_pago_q1 || 15}">
        <label>Día de pago quincena 2</label>
        <input type="number" id="onb-dia-pago-q2" min="1" max="31" value="${config.dia_pago_q2 || 30}">
      </div>
      ${onboardingAcciones({ mostrarOmitir: true })}
    </div>
  `;
  document.getElementById("onb-salario-quincenas").addEventListener("change", (e) => {
    document.getElementById("onb-dias-pago").style.display = e.target.checked ? "block" : "none";
  });
  conectarOnboardingAcciones({
    onContinuar: async () => {
      const total = parseFloat(document.getElementById("onb-salario-total").value) || 0;
      const moneda = document.getElementById("onb-salario-moneda").value;
      const dividir = document.getElementById("onb-salario-quincenas").checked;
      if (total > 0) {
        const salario_q1 = dividir ? Math.round(total / 2) : total;
        const salario_q2 = dividir ? total - salario_q1 : 0;
        const dia_pago_q1 = parseInt(document.getElementById("onb-dia-pago-q1").value) || 15;
        const dia_pago_q2 = parseInt(document.getElementById("onb-dia-pago-q2").value) || 30;
        await api("/configuracion", {
          method: "PUT",
          body: JSON.stringify({
            salario_total: total,
            salario_q1,
            salario_q2,
            salario_moneda: moneda,
            tipo_cambio: config.tipo_cambio,
            moneda_visualizacion: config.moneda_visualizacion || moneda,
            dia_pago_q1,
            dia_pago_q2,
          }),
        });
      }
      onboardingIr(1);
    },
  });
}

// ---------------------------------------------------------------------
// Patrón compartido por los pasos de fijos/ahorros/deudas: una grilla de
// tarjetas con sugerencias comunes (más una de "Otro" para algo distinto).
// Tocar una tarjeta abre un panel chiquito para completar el monto; si ya
// tiene datos guardados, se ve marcada y al tocarla de nuevo se edita.
// ---------------------------------------------------------------------
function onboardingChipHTML(sugerencia, existente, formatoFn) {
  const clase = "onboarding-chip" + (existente ? " agregado" : "");
  return `
    <button type="button" class="${clase}" data-nombre="${sugerencia.nombre}" data-emoji="${sugerencia.emoji}">
      ${existente ? `<span class="onboarding-chip-quitar" data-id="${existente.id}" title="Quitar">✕</span>` : ""}
      <span class="onboarding-chip-emoji">${sugerencia.emoji}</span>
      <span class="onboarding-chip-nombre">${sugerencia.nombre}</span>
      ${existente ? `<span class="onboarding-chip-monto">${formatoFn(existente)}</span>` : ""}
    </button>
  `;
}

function onboardingChipOtroHTML() {
  return `
    <button type="button" class="onboarding-chip onboarding-chip-otro" data-nombre="" data-emoji="✏️">
      <span class="onboarding-chip-emoji">✏️</span>
      <span class="onboarding-chip-nombre">Otro</span>
    </button>
  `;
}

// Pinta la grilla completa: sugerencias fijas + cualquier ítem ya guardado que
// no estuviera en la lista de sugerencias (lo agregó el usuario con "Otro").
function onboardingPintarChips(contId, sugerencias, itemsPorNombre, formatoFn, onClick) {
  const usados = new Set();
  let html = sugerencias.map((s) => {
    if (itemsPorNombre[s.nombre]) usados.add(s.nombre);
    return onboardingChipHTML(s, itemsPorNombre[s.nombre], formatoFn);
  }).join("");
  html += Object.keys(itemsPorNombre)
    .filter((n) => !usados.has(n))
    .map((n) => onboardingChipHTML({ nombre: n, emoji: "✨" }, itemsPorNombre[n], formatoFn))
    .join("");
  html += onboardingChipOtroHTML();

  const cont = document.getElementById(contId);
  cont.innerHTML = html;
  cont.querySelectorAll(".onboarding-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      if (e.target.closest(".onboarding-chip-quitar")) return;
      const esOtro = chip.classList.contains("onboarding-chip-otro");
      const nombre = chip.dataset.nombre;
      onClick({ nombre: esOtro ? "" : nombre, emoji: chip.dataset.emoji, existente: esOtro ? null : itemsPorNombre[nombre], esOtro });
    });
  });
}

const FIJOS_SUGERENCIAS = [
  { nombre: "Alquiler", emoji: "🏠" },
  { nombre: "Servicios (agua y luz)", emoji: "💡" },
  { nombre: "Internet", emoji: "📶" },
  { nombre: "Plan celular", emoji: "📱" },
  { nombre: "Gimnasio", emoji: "🏋️" },
  { nombre: "Streaming", emoji: "🎬" },
  { nombre: "Seguro del carro", emoji: "🚗" },
  { nombre: "Seguro médico", emoji: "🏥" },
  { nombre: "Mascota", emoji: "🐶" },
];

async function renderOnboardingFijos() {
  const rubros = await api("/rubros-fijos");
  const itemsPorNombre = {};
  rubros.filter((r) => !r.generado_de_objetivo).forEach((r) => { itemsPorNombre[r.nombre] = r; });

  document.getElementById("onboarding-contenido").innerHTML = `
    <div class="onboarding-paso">
      <div class="onboarding-bienvenida-emoji">📌</div>
      <span class="onboarding-paso-eyebrow">Paso 2 de 5</span>
      <h2>Tus gastos fijos</h2>
      <p class="onboarding-paso-sub">Tocá los que pagás todos los meses. Después le ponés el monto.</p>
      <div class="onboarding-chips" id="onb-fijos-chips"></div>
      <div class="onboarding-panel oculta" id="onb-fijos-panel"></div>
      ${onboardingAcciones({ textoContinuar: "Continuar →" })}
    </div>
  `;

  onboardingPintarChips(
    "onb-fijos-chips",
    FIJOS_SUGERENCIAS,
    itemsPorNombre,
    (r) => formatoMonto(r.monto_q1 + r.monto_q2, r.moneda),
    abrirPanelFijo
  );
  document.querySelectorAll("#onb-fijos-chips .onboarding-chip-quitar").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/rubros-fijos/${btn.dataset.id}`, { method: "DELETE" });
      renderOnboardingFijos();
    });
  });

  conectarOnboardingAcciones({ onContinuar: () => onboardingIr(1) });
}

function abrirPanelFijo({ nombre, emoji, existente, esOtro }) {
  const panel = document.getElementById("onb-fijos-panel");
  panel.classList.remove("oculta");
  panel.innerHTML = `
    <div class="onboarding-panel-titulo">
      <span>${emoji}</span>
      ${esOtro ? `<input type="text" id="onb-fijo-nombre-otro" placeholder="Nombre del gasto" style="flex:1;">` : `<span>${nombre}</span>`}
    </div>
    <div class="onboarding-fila-campos">
      <div>
        <label>Monto mensual</label>
        <input type="number" id="onb-fijo-monto" step="1" min="0" value="${existente ? existente.monto_q1 + existente.monto_q2 : ""}">
      </div>
      <div>
        <label>Moneda</label>
        <select id="onb-fijo-moneda">
          <option value="CRC" ${!existente || existente.moneda !== "USD" ? "selected" : ""}>Colones (CRC)</option>
          <option value="USD" ${existente && existente.moneda === "USD" ? "selected" : ""}>Dólares (USD)</option>
        </select>
      </div>
    </div>
    <label class="modal-check">
      <input type="checkbox" id="onb-fijo-quincenas" ${existente && existente.monto_q2 > 0 ? "checked" : ""}>
      Dividir en dos quincenas iguales
    </label>
    <div class="onboarding-panel-acciones">
      ${existente ? `<button class="boton-texto" id="onb-fijo-quitar">Quitar</button>` : `<button class="boton-texto" id="onb-fijo-cancelar">Cancelar</button>`}
      <button class="boton-primario" id="onb-fijo-guardar">Guardar</button>
    </div>
  `;
  if (esOtro) document.getElementById("onb-fijo-nombre-otro").focus();

  document.getElementById("onb-fijo-guardar").addEventListener("click", async () => {
    const nombreFinal = esOtro ? document.getElementById("onb-fijo-nombre-otro").value.trim() : nombre;
    const monto_total = parseFloat(document.getElementById("onb-fijo-monto").value) || 0;
    if (!nombreFinal || !monto_total) return;
    const moneda = document.getElementById("onb-fijo-moneda").value;
    const dividir = document.getElementById("onb-fijo-quincenas").checked;
    const monto_q1 = dividir ? Math.round(monto_total / 2) : monto_total;
    const monto_q2 = dividir ? monto_total - monto_q1 : 0;
    if (existente) {
      await api(`/rubros-fijos/${existente.id}`, { method: "PUT", body: JSON.stringify({ nombre: nombreFinal, monto_q1, monto_q2, moneda, objetivo_id: existente.objetivo_id || null }) });
    } else {
      await api("/rubros-fijos", { method: "POST", body: JSON.stringify({ nombre: nombreFinal, monto_q1, monto_q2, moneda, objetivo_id: null }) });
    }
    renderOnboardingFijos();
  });
  const btnCancelar = document.getElementById("onb-fijo-cancelar");
  if (btnCancelar) btnCancelar.addEventListener("click", () => panel.classList.add("oculta"));
  const btnQuitar = document.getElementById("onb-fijo-quitar");
  if (btnQuitar) btnQuitar.addEventListener("click", async () => {
    await api(`/rubros-fijos/${existente.id}`, { method: "DELETE" });
    renderOnboardingFijos();
  });
}

const AHORROS_SUGERENCIAS = [
  { nombre: "Fondo de emergencia", emoji: "🚨" },
  { nombre: "Viaje", emoji: "✈️" },
  { nombre: "Casa propia", emoji: "🏠" },
  { nombre: "Carro", emoji: "🚗" },
  { nombre: "Retiro", emoji: "👴" },
  { nombre: "Estudios", emoji: "🎓" },
  { nombre: "Boda", emoji: "💍" },
];

async function renderOnboardingAhorros() {
  const objetivos = await api("/objetivos");
  const itemsPorNombre = {};
  objetivos.forEach((o) => { itemsPorNombre[o.nombre] = o; });

  document.getElementById("onboarding-contenido").innerHTML = `
    <div class="onboarding-paso">
      <div class="onboarding-bienvenida-emoji">💭</div>
      <span class="onboarding-paso-eyebrow">Paso 3 de 5</span>
      <h2>¿Con qué estás soñando?</h2>
      <p class="onboarding-paso-sub">Elegí las metas de ahorro que tengan sentido para vos. Después definís cuánto y en cuánto tiempo querés juntarlo.</p>
      <div class="onboarding-chips" id="onb-ahorros-chips"></div>
      <div class="onboarding-panel oculta" id="onb-ahorros-panel"></div>
      ${onboardingAcciones({ textoContinuar: "Continuar →" })}
    </div>
  `;

  onboardingPintarChips(
    "onb-ahorros-chips",
    AHORROS_SUGERENCIAS,
    itemsPorNombre,
    (o) => formatoMonto(o.monto_total, o.moneda),
    abrirPanelAhorro
  );
  document.querySelectorAll("#onb-ahorros-chips .onboarding-chip-quitar").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/objetivos/${btn.dataset.id}`, { method: "DELETE" });
      renderOnboardingAhorros();
    });
  });

  conectarOnboardingAcciones({ onContinuar: () => onboardingIr(1) });
}

function abrirPanelAhorro({ nombre, emoji, existente, esOtro }) {
  const panel = document.getElementById("onb-ahorros-panel");
  panel.classList.remove("oculta");
  panel.innerHTML = `
    <div class="onboarding-panel-titulo">
      <span>${emoji}</span>
      ${esOtro ? `<input type="text" id="onb-ahorro-nombre-otro" placeholder="Nombre de la meta" style="flex:1;">` : `<span>${nombre}</span>`}
    </div>
    <div class="onboarding-fila-campos-3">
      <div><label>Monto meta</label><input type="number" id="onb-ahorro-monto" step="1" min="0" value="${existente ? existente.monto_total : ""}"></div>
      <div><label>Plazo (meses)</label><input type="number" id="onb-ahorro-meses" step="1" min="1" value="${existente ? existente.meses_plazo : 12}"></div>
      <div>
        <label>Moneda</label>
        <select id="onb-ahorro-moneda">
          <option value="CRC" ${!existente || existente.moneda !== "USD" ? "selected" : ""}>Colones (CRC)</option>
          <option value="USD" ${existente && existente.moneda === "USD" ? "selected" : ""}>Dólares (USD)</option>
        </select>
      </div>
    </div>
    <label class="modal-check">
      <input type="checkbox" id="onb-ahorro-quincenas" ${existente && existente.dividir_quincenas ? "checked" : ""}>
      Aportar en dos quincenas iguales
    </label>
    <div class="onboarding-panel-acciones">
      ${existente ? `<button class="boton-texto" id="onb-ahorro-quitar">Quitar</button>` : `<button class="boton-texto" id="onb-ahorro-cancelar">Cancelar</button>`}
      <button class="boton-primario" id="onb-ahorro-guardar">Guardar</button>
    </div>
  `;
  if (esOtro) document.getElementById("onb-ahorro-nombre-otro").focus();

  document.getElementById("onb-ahorro-guardar").addEventListener("click", async () => {
    const nombreFinal = esOtro ? document.getElementById("onb-ahorro-nombre-otro").value.trim() : nombre;
    const monto_total = parseFloat(document.getElementById("onb-ahorro-monto").value) || 0;
    const meses_plazo = parseInt(document.getElementById("onb-ahorro-meses").value) || 0;
    if (!nombreFinal || !monto_total || !meses_plazo) return;
    const moneda = document.getElementById("onb-ahorro-moneda").value;
    const dividir_quincenas = document.getElementById("onb-ahorro-quincenas").checked;
    if (existente) {
      await api(`/objetivos/${existente.id}`, { method: "DELETE" });
    }
    await api("/objetivos", { method: "POST", body: JSON.stringify({ nombre: nombreFinal, monto_total, meses_plazo, moneda, dividir_quincenas }) });
    renderOnboardingAhorros();
  });
  const btnCancelar = document.getElementById("onb-ahorro-cancelar");
  if (btnCancelar) btnCancelar.addEventListener("click", () => panel.classList.add("oculta"));
  const btnQuitar = document.getElementById("onb-ahorro-quitar");
  if (btnQuitar) btnQuitar.addEventListener("click", async () => {
    await api(`/objetivos/${existente.id}`, { method: "DELETE" });
    renderOnboardingAhorros();
  });
}

const DEUDAS_SUGERENCIAS = [
  { nombre: "Tarjeta de crédito", emoji: "💳" },
  { nombre: "Préstamo personal", emoji: "🏦" },
  { nombre: "Préstamo de carro", emoji: "🚗" },
  { nombre: "Hipoteca", emoji: "🏠" },
  { nombre: "Préstamo estudiantil", emoji: "🎓" },
];

async function renderOnboardingDeudas() {
  const deudas = await api("/deudas");
  const itemsPorNombre = {};
  deudas.forEach((d) => { itemsPorNombre[d.nombre] = d; });

  document.getElementById("onboarding-contenido").innerHTML = `
    <div class="onboarding-paso">
      <div class="onboarding-bienvenida-emoji">💳</div>
      <span class="onboarding-paso-eyebrow">Paso 4 de 5</span>
      <h2>Tus deudas</h2>
      <p class="onboarding-paso-sub">Tocá las que tenés y contános cómo van. Así llevás el control de cuánto debés y cuándo terminás de pagar.</p>
      <div class="onboarding-chips" id="onb-deudas-chips"></div>
      <div class="onboarding-panel oculta" id="onb-deudas-panel"></div>
      ${onboardingAcciones({ textoContinuar: "Continuar →" })}
    </div>
  `;

  onboardingPintarChips(
    "onb-deudas-chips",
    DEUDAS_SUGERENCIAS,
    itemsPorNombre,
    (d) => formatoMonto(d.saldo_actual, d.moneda),
    abrirPanelDeuda
  );
  document.querySelectorAll("#onb-deudas-chips .onboarding-chip-quitar").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/deudas/${btn.dataset.id}`, { method: "DELETE" });
      renderOnboardingDeudas();
    });
  });

  conectarOnboardingAcciones({ onContinuar: () => onboardingIr(1) });
}

function abrirPanelDeuda({ nombre, emoji, existente, esOtro }) {
  const panel = document.getElementById("onb-deudas-panel");
  panel.classList.remove("oculta");
  panel.innerHTML = `
    <div class="onboarding-panel-titulo">
      <span>${emoji}</span>
      ${esOtro ? `<input type="text" id="onb-deuda-nombre-otro" placeholder="Nombre de la deuda" style="flex:1;">` : `<span>${nombre}</span>`}
    </div>
    <div class="onboarding-fila-campos">
      <div><label>Saldo actual</label><input type="number" id="onb-deuda-saldo" step="1" min="0" value="${existente ? existente.saldo_actual : ""}"></div>
      <div><label>Cuota mensual mínima</label><input type="number" id="onb-deuda-cuota" step="1" min="0" value="${existente ? existente.cuota_minima : ""}"></div>
    </div>
    <div class="onboarding-fila-campos">
      <div><label>Tasa de interés anual % (opcional)</label><input type="number" id="onb-deuda-tasa" step="0.1" min="0" value="${existente && existente.tasa_interes_anual ? existente.tasa_interes_anual : ""}"></div>
      <div>
        <label>Moneda</label>
        <select id="onb-deuda-moneda">
          <option value="CRC" ${!existente || existente.moneda !== "USD" ? "selected" : ""}>Colones (CRC)</option>
          <option value="USD" ${existente && existente.moneda === "USD" ? "selected" : ""}>Dólares (USD)</option>
        </select>
      </div>
    </div>
    <label class="modal-check">
      <input type="checkbox" id="onb-deuda-quincenas" ${existente && existente.dividir_quincenas ? "checked" : ""}>
      Pagar la cuota en dos quincenas iguales
    </label>
    <div class="onboarding-panel-acciones">
      ${existente ? `<button class="boton-texto" id="onb-deuda-quitar">Quitar</button>` : `<button class="boton-texto" id="onb-deuda-cancelar">Cancelar</button>`}
      <button class="boton-primario" id="onb-deuda-guardar">Guardar</button>
    </div>
  `;
  if (esOtro) document.getElementById("onb-deuda-nombre-otro").focus();

  document.getElementById("onb-deuda-guardar").addEventListener("click", async () => {
    const nombreFinal = esOtro ? document.getElementById("onb-deuda-nombre-otro").value.trim() : nombre;
    const monto_adeudado = parseFloat(document.getElementById("onb-deuda-saldo").value) || 0;
    const cuota_minima = parseFloat(document.getElementById("onb-deuda-cuota").value) || 0;
    if (!nombreFinal || !monto_adeudado || !cuota_minima) return;
    const tasa_interes_anual = parseFloat(document.getElementById("onb-deuda-tasa").value) || null;
    const moneda = document.getElementById("onb-deuda-moneda").value;
    const dividir_quincenas = document.getElementById("onb-deuda-quincenas").checked;
    if (existente) {
      await api(`/deudas/${existente.id}`, { method: "DELETE" });
    }
    await api("/deudas", {
      method: "POST",
      body: JSON.stringify({ modo: "monto", nombre: nombreFinal, monto_adeudado, cuota_minima, tasa_interes_anual, moneda, dividir_quincenas }),
    });
    renderOnboardingDeudas();
  });
  const btnCancelar = document.getElementById("onb-deuda-cancelar");
  if (btnCancelar) btnCancelar.addEventListener("click", () => panel.classList.add("oculta"));
  const btnQuitar = document.getElementById("onb-deuda-quitar");
  if (btnQuitar) btnQuitar.addEventListener("click", async () => {
    await api(`/deudas/${existente.id}`, { method: "DELETE" });
    renderOnboardingDeudas();
  });
}

function construirPieDisponible(categoriasVariables, disponibleCRC) {
  const r = 64, cx = 76, cy = 76, grosor = 24;
  const circ = 2 * Math.PI * r;
  const total = Math.max(disponibleCRC, 0);
  const asignado = categoriasVariables.reduce((s, c) => s + (c.presupuesto_mensual || 0), 0);
  const sinAsignar = Math.max(total - asignado, 0);

  let acumulado = 0;
  const segmentos = total > 0
    ? categoriasVariables.filter((c) => c.presupuesto_mensual > 0).map((c) => {
        const dash = (c.presupuesto_mensual / total) * circ;
        const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.color || "var(--verde)"}" stroke-width="${grosor}"
          stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-acumulado).toFixed(2)}"
          transform="rotate(-90 ${cx} ${cy})"><title>${c.nombre}: ${formatoMonto(c.presupuesto_mensual, "CRC")}</title></circle>`;
        acumulado += dash;
        return el;
      }).join("")
    : "";

  const segmentoResto = total > 0 && sinAsignar > 0
    ? (() => {
        const dash = (sinAsignar / total) * circ;
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--linea)" stroke-width="${grosor}"
          stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-acumulado).toFixed(2)}"
          transform="rotate(-90 ${cx} ${cy})"></circle>`;
      })()
    : "";

  const pctAsignado = total > 0 ? Math.round((asignado / total) * 100) : 0;

  const leyenda = categoriasVariables.filter((c) => c.presupuesto_mensual > 0).map((c) => `
    <div class="leyenda-punto-item">
      <span class="leyenda-punto" style="background:${c.color || "var(--verde)"}"></span>
      <span>${c.emoji || ""} ${c.nombre}</span>
      <strong style="margin-left:auto; font-family:var(--fuente-mono);">${formatoMonto(c.presupuesto_mensual, "CRC")}</strong>
    </div>
  `).join("") + (sinAsignar > 0 ? `
    <div class="leyenda-punto-item leyenda-punto-disponible">
      <span class="leyenda-punto" style="background:var(--linea)"></span>
      <span>Sin asignar</span>
      <strong style="margin-left:auto; font-family:var(--fuente-mono);">${formatoMonto(sinAsignar, "CRC")}</strong>
    </div>
  ` : "");

  return `
    <div class="onboarding-pie-wrap">
      <div class="onboarding-pie-svg">
        <svg width="152" height="152" viewBox="0 0 152 152">
          ${segmentos || segmentoResto ? `${segmentos}${segmentoResto}` : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--linea)" stroke-width="${grosor}"></circle>`}
        </svg>
        <div class="onboarding-pie-centro">
          <strong>${pctAsignado}%</strong>
          <span>asignado</span>
        </div>
      </div>
      <div class="onboarding-pie-leyenda">${leyenda || `<p class="onboarding-pie-vacio">Todavía no asignaste nada del disponible.</p>`}</div>
    </div>
  `;
}

async function renderOnboardingVariables() {
  // El presupuesto de cada categoría se guarda siempre en colones (no tiene
  // moneda propia), por eso esta pantalla trabaja toda en CRC: usamos /categorias
  // (valores crudos) en vez de /dashboard (que vendría convertido a la moneda de
  // visualización) para no guardar un monto en USD como si fuera CRC.
  const [categorias, config, dash] = await Promise.all([
    api("/categorias"),
    api("/configuracion"),
    api(`/dashboard?mes=${mesActual}`),
  ]);
  const categoriasVariables = categorias.filter((c) =>
    !CATEGORIAS_SISTEMA_ONBOARDING.includes(c.nombre) && !CATEGORIAS_OCULTAS_ONBOARDING_VARIABLES.includes(c.nombre)
  );
  const disponibleCRC = config.moneda_visualizacion === "USD"
    ? (dash.disponible_mensual || 0) * (config.tipo_cambio || 0)
    : (dash.disponible_mensual || 0);

  document.getElementById("onboarding-contenido").innerHTML = `
    <div class="onboarding-paso">
      <div class="onboarding-bienvenida-emoji">🎯</div>
      <span class="onboarding-paso-eyebrow">Paso 5 de 5</span>
      <h2>Presupuesto para el día a día</h2>
      <p class="onboarding-paso-sub">Tocá una categoría y ponele cuánto querés gastar en ella este mes (en colones).</p>
      <div id="onb-var-pie"></div>
      <div class="onboarding-chips" id="onb-var-chips" style="margin-top:14px;"></div>
      <div class="onboarding-panel oculta" id="onb-var-panel"></div>
      ${onboardingAcciones({ textoContinuar: "Continuar →" })}
    </div>
  `;

  const actualizarResumen = () => {
    document.getElementById("onb-var-pie").innerHTML = construirPieDisponible(categoriasVariables, disponibleCRC);
  };
  actualizarResumen();

  const contChips = document.getElementById("onb-var-chips");
  contChips.innerHTML = categoriasVariables.map((c) => {
    const tieneMonto = c.presupuesto_mensual > 0;
    return `
      <button type="button" class="onboarding-chip ${tieneMonto ? "agregado" : ""}" data-cat-id="${c.id}">
        <span class="onboarding-chip-emoji">${c.emoji || "🏷️"}</span>
        <span class="onboarding-chip-nombre">${c.nombre}</span>
        ${tieneMonto ? `<span class="onboarding-chip-monto">${formatoMonto(c.presupuesto_mensual, "CRC")}</span>` : ""}
      </button>
    `;
  }).join("") + onboardingChipOtroHTML();

  const panel = document.getElementById("onb-var-panel");

  contChips.querySelectorAll(".onboarding-chip:not(.onboarding-chip-otro)").forEach((chip) => {
    chip.addEventListener("click", () => {
      const cat = categoriasVariables.find((c) => c.id === parseInt(chip.dataset.catId));
      panel.classList.remove("oculta");
      panel.innerHTML = `
        <div class="onboarding-panel-titulo"><span>${cat.emoji || "🏷️"}</span><span>${cat.nombre}</span></div>
        <label>Monto mensual (₡)</label>
        <input type="number" id="onb-var-monto" step="1" min="0" value="${cat.presupuesto_mensual || ""}">
        <div class="onboarding-panel-acciones">
          <button class="boton-texto" id="onb-var-cancelar">Cancelar</button>
          <button class="boton-primario" id="onb-var-guardar">Guardar</button>
        </div>
      `;
      document.getElementById("onb-var-monto").focus();
      document.getElementById("onb-var-cancelar").addEventListener("click", () => panel.classList.add("oculta"));
      document.getElementById("onb-var-guardar").addEventListener("click", async () => {
        const presupuesto_mensual = parseFloat(document.getElementById("onb-var-monto").value) || 0;
        await api(`/categorias/${cat.id}`, { method: "PUT", body: JSON.stringify({ presupuesto_mensual }) });
        renderOnboardingVariables();
      });
    });
  });

  contChips.querySelector(".onboarding-chip-otro").addEventListener("click", () => {
    panel.classList.remove("oculta");
    panel.innerHTML = `
      <div class="onboarding-panel-titulo">
        <span>✏️</span>
        <input type="text" id="onb-var-nombre-otro" placeholder="Nombre del rubro" style="flex:1;">
      </div>
      <label>Monto mensual (₡)</label>
      <input type="number" id="onb-var-monto" step="1" min="0">
      <div class="onboarding-panel-acciones">
        <button class="boton-texto" id="onb-var-cancelar">Cancelar</button>
        <button class="boton-primario" id="onb-var-guardar">Guardar</button>
      </div>
    `;
    document.getElementById("onb-var-nombre-otro").focus();
    document.getElementById("onb-var-cancelar").addEventListener("click", () => panel.classList.add("oculta"));
    document.getElementById("onb-var-guardar").addEventListener("click", async () => {
      const nombre = document.getElementById("onb-var-nombre-otro").value.trim();
      const presupuesto_mensual = parseFloat(document.getElementById("onb-var-monto").value) || 0;
      if (!nombre) return;
      await api("/categorias", { method: "POST", body: JSON.stringify({ nombre, presupuesto_mensual, emoji: "✨" }) });
      renderOnboardingVariables();
    });
  });

  conectarOnboardingAcciones({ onContinuar: () => onboardingIr(1) });
}

async function renderOnboardingResumen() {
  const [config, rubros, objetivos, deudas] = await Promise.all([
    api("/configuracion"),
    api("/rubros-fijos"),
    api("/objetivos"),
    api("/deudas"),
  ]);
  const rubrosManuales = rubros.filter((r) => !r.generado_de_objetivo);

  document.getElementById("onboarding-contenido").innerHTML = `
    <div class="onboarding-paso">
      <div class="onboarding-bienvenida-emoji">🎉</div>
      <h2>Ya configuraste lo básico</h2>
      <p class="onboarding-paso-sub">Podés agregar más rubros, ahorros o deudas cuando quieras desde sus pestañas, y ajustar cualquier monto desde "Configurar".</p>
      <div class="onboarding-resumen-lista">
        <div class="onboarding-resumen-fila"><span>💵 Salario mensual</span><strong>${formatoMonto(config.salario_total || 0, config.salario_moneda)}</strong></div>
        <div class="onboarding-resumen-fila"><span>📌 Gastos fijos agregados</span><strong>${rubrosManuales.length}</strong></div>
        <div class="onboarding-resumen-fila"><span>💭 Metas de ahorro</span><strong>${objetivos.length}</strong></div>
        <div class="onboarding-resumen-fila"><span>💳 Deudas</span><strong>${deudas.length}</strong></div>
      </div>
      <div class="onboarding-acciones">
        <button class="boton-secundario" id="onboarding-btn-atras">Atrás</button>
        <div class="onboarding-acciones-derecha">
          <button class="boton-primario" id="onboarding-btn-finalizar">Ir al dashboard →</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("onboarding-btn-atras").addEventListener("click", () => onboardingIr(-1));
  document.getElementById("onboarding-btn-finalizar").addEventListener("click", cerrarOnboarding);
}

// =====================================================================
// TAB 1: DASHBOARD
// =====================================================================
async function cargarDashboard() {
  const data = await api(`/dashboard?mes=${mesActual}`);
  monedaVisualizacion = data.moneda_visualizacion || "CRC";
  tipoCambioGlobal = data.tipo_cambio || tipoCambioGlobal;

  const labelEl = document.getElementById("dash-hero-label");
  const countdownEl = document.getElementById("dash-hero-countdown");
  const deltaEl = document.getElementById("dash-disponible-delta");
  const q = data.quincena_actual;
  let pasado;
  if (q) {
    labelEl.textContent = `Disponible quincena ${q.quincena === "Q1" ? "1" : "2"}`;
    document.getElementById("dash-disponible").textContent = formatoColones(q.disponible_quincena);
    const dias = q.dias_para_proximo_pago;
    countdownEl.textContent = dias <= 0
      ? "Hoy te pagan 🎉"
      : `Faltan ${dias} día${dias === 1 ? "" : "s"} para tu próximo pago`;
    document.getElementById("dash-disponible-sub").textContent = `${formatoColones(data.disponible_restante)} disponible en total este mes`;
    pasado = q.disponible_quincena < 0;
    deltaEl.textContent = pasado ? "Te pasaste de esta quincena" : "Disponible para gastar";
  } else {
    labelEl.textContent = "Disponible este mes";
    document.getElementById("dash-disponible").textContent = formatoColones(data.disponible_restante);
    countdownEl.textContent = "";
    document.getElementById("dash-disponible-sub").textContent = data.ingresos_extra_total
      ? `de ${formatoColones(data.salario_total)} de salario + ${formatoColones(data.ingresos_extra_total)} extra`
      : `de ${formatoColones(data.salario_total)} de salario`;
    pasado = data.disponible_restante < 0;
    deltaEl.textContent = pasado ? "Te pasaste del presupuesto" : "Disponible para gastar";
  }
  deltaEl.className = "dash-hero-delta " + (pasado ? "negativo" : "positivo");
  document.querySelector(".dash-hero-disponible").classList.toggle("sobre-presupuesto", pasado);

  // Lista de rubros fijos del mes
  const contFijos = document.getElementById("dash-lista-fijos");
  if (data.detalle_fijos.length === 0) {
    contFijos.innerHTML = `<div class="vacio">Todavía no tenés rubros de gastos fijos.</div>`;
  } else {
    contFijos.innerHTML = data.detalle_fijos.map((r) => {
      const pagado = r.pagado >= r.presupuestado && r.presupuestado > 0;
      return `
        <div class="fila-rubro">
          <button class="fila-rubro-check ${pagado ? "pagado" : ""}" data-rubro-id="${r.id}" data-presupuestado="${r.presupuestado}" data-monto-q1="${r.monto_q1_original}" data-monto-q2="${r.monto_q2_original}" data-moneda="${r.moneda}" title="Marcar como pagado">${pagado ? "✓" : ""}</button>
          <div class="fila-rubro-info">
            <span class="fila-rubro-nombre">${r.nombre}</span>
          </div>
          <div class="fila-rubro-montos"><strong>${formatoColones(r.pagado)}</strong> de ${formatoColones(r.presupuestado)}</div>
        </div>`;
    }).join("");

    contFijos.querySelectorAll(".fila-rubro-check").forEach((btn) => {
      btn.addEventListener("click", () => abrirModalMarcarPago(
        btn.dataset.rubroId,
        parseFloat(btn.dataset.presupuestado),
        btn.classList.contains("pagado"),
        parseFloat(btn.dataset.montoQ1),
        parseFloat(btn.dataset.montoQ2),
        btn.dataset.moneda
      ));
    });
  }

  // Contador "pagados / total" en el encabezado de Gastos fijos
  const totalRubros = data.detalle_fijos.length;
  const pagadosRubros = data.detalle_fijos.filter((r) => r.pagado >= r.presupuestado && r.presupuestado > 0).length;
  const contadorFijos = document.getElementById("dash-fijos-contador");
  if (contadorFijos) {
    contadorFijos.textContent = totalRubros ? `${pagadosRubros} / ${totalRubros} pagados` : "";
  }
  document.getElementById("seg-fijos-sub").textContent = totalRubros ? `${pagadosRubros} / ${totalRubros} pagados` : "Sin rubros";

  dibujarRitmoDiario(data);
  dibujarPieCategorias(data);
  dibujarBarrasPresupuesto(data);
}

// Construye el encabezado "Gastaste este mes ₡X + comparación" para incrustarlo
// dentro de la caja de los anillos de presupuesto.
function encabezadoGastoVariable(data) {
  const actual = data.total_consumo || 0;
  const anterior = data.total_consumo_anterior || 0;
  let texto, clase;
  if (!anterior) {
    texto = "Sin gasto el mes anterior para comparar";
    clase = "neutro";
  } else {
    const pct = Math.round(((actual - anterior) / anterior) * 100);
    if (pct === 0) { texto = "Igual que el mes anterior"; clase = "neutro"; }
    else if (pct > 0) { texto = `${pct}% más que el mes anterior`; clase = "negativo"; }
    else { texto = `${Math.abs(pct)}% menos que el mes anterior`; clase = "positivo"; }
  }
  return `
    <div class="dash-variables-resumen">
      <span class="dash-variables-label">Gastaste este mes</span>
      <div class="dash-variables-fila">
        <span class="dash-variables-monto">${formatoColones(actual)}</span>
        <span class="dash-variables-delta ${clase}">${texto}</span>
      </div>
    </div>`;
}

// ===== Segmentos del dashboard (Gastos fijos / Ahorros / Variables) =====
document.querySelectorAll(".dash-segmento").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".dash-segmento").forEach((b) => b.classList.remove("activo"));
    document.querySelectorAll(".dash-panel").forEach((p) => p.classList.add("oculto-panel"));
    btn.classList.add("activo");
    document.getElementById("dash-panel-" + btn.dataset.segmento).classList.remove("oculto-panel");
  });
});

document.getElementById("btn-dash-nuevo-rubro").addEventListener("click", abrirModalNuevoRubro);

// ===== Gráfico de ritmo de gasto diario con banda de rango normal =====
function dibujarRitmoDiario(data) {
  const cont = document.getElementById("dash-grafico-ritmo");
  const titulo = document.getElementById("dash-ritmo-titulo");
  const nota = document.getElementById("dash-ritmo-nota");
  const ritmo = data.ritmo_diario || [];

  // Solo graficamos los días transcurridos que tuvieron gasto (> 0). La línea
  // brinca de un día con gasto al siguiente, pero el eje X sigue mapeado por
  // número de día, así que el hueco de los días en ₡0 se respeta visualmente.
  const conGasto = ritmo.filter((r) => r.transcurrido && r.gasto > 0);
  if (conGasto.length === 0) {
    cont.innerHTML = `<div class="vacio">Todavía no hay gastos este mes para mostrar tu ritmo.</div>`;
    titulo.textContent = "Aún sin datos";
    nota.textContent = "";
    return;
  }

  const ancho = 620, alto = 200, padX = 12, padTop = 14, padBot = 28;
  const nDias = ritmo.length;
  const bandaSup = data.ritmo_banda_superior || 0;
  const maxGasto = Math.max(bandaSup, ...conGasto.map((r) => r.gasto), 1);
  const maxY = maxGasto * 1.12;

  const x = (i) => padX + (nDias > 1 ? i * (ancho - padX * 2) / (nDias - 1) : 0);
  const y = (v) => alto - padBot - (v / maxY) * (alto - padTop - padBot);

  // Banda de rango normal (inferior a superior) como área verde tenue.
  const yInf = y(data.ritmo_banda_inferior || 0);
  const ySup = y(bandaSup);
  const banda = `<rect x="${padX}" y="${ySup.toFixed(1)}" width="${(ancho - padX * 2).toFixed(1)}" height="${Math.max(yInf - ySup, 0).toFixed(1)}" fill="var(--verde-suave)" rx="6"></rect>
    <line x1="${padX}" y1="${y(data.ritmo_promedio || 0).toFixed(1)}" x2="${ancho - padX}" y2="${y(data.ritmo_promedio || 0).toFixed(1)}" stroke="var(--verde)" stroke-width="1" stroke-dasharray="3 4" opacity="0.5"></line>`;

  // Línea que conecta solo los días con gasto.
  let linePath = "";
  conGasto.forEach((r, idx) => {
    const i = r.dia - 1;
    linePath += (idx === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(r.gasto).toFixed(1) + " ";
  });

  const puntos = conGasto.map((r) => {
    const cx = x(r.dia - 1), cy = y(r.gasto);
    const fill = r.fuera_de_rango ? "var(--terracota)" : "#FFFFFF";
    const stroke = r.fuera_de_rango ? "var(--terracota)" : "var(--tinta)";
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${fill}" stroke="${stroke}" stroke-width="2"><title>Día ${r.dia}: ${formatoColones(r.gasto)}</title></circle>`;
  }).join("");

  // Etiquetas de día (primero, ~10, ~20, último)
  const marcas = [1, Math.round(nDias / 3), Math.round((nDias * 2) / 3), nDias];
  const ejeX = [...new Set(marcas)].map((d) =>
    `<text x="${x(d - 1).toFixed(1)}" y="${alto - 8}" text-anchor="middle" font-size="11" fill="var(--tinta-suave)" font-family="var(--fuente-mono)">${d}</text>`
  ).join("");

  cont.innerHTML = `
    <svg viewBox="0 0 ${ancho} ${alto}" width="100%" height="${alto}" xmlns="http://www.w3.org/2000/svg">
      ${banda}
      <path d="${linePath}" fill="none" stroke="var(--tinta)" stroke-width="2" stroke-linejoin="round"></path>
      ${puntos}
      ${ejeX}
    </svg>`;

  const nCaros = (data.dias_caros || []).length;
  if (nCaros === 0) {
    titulo.textContent = "Te mantuviste en tu ritmo";
    nota.textContent = "Ningún día te saliste de tu rango normal de gasto este mes.";
  } else {
    titulo.textContent = "Casi siempre dentro de lo normal";
    const lista = data.dias_caros.join(", ");
    nota.textContent = `Te saliste del rango ${nCaros} día${nCaros === 1 ? "" : "s"} — el resto del mes te mantuviste por debajo de tu gasto habitual.`;
  }
}

// Categorías del sistema que no son gasto de consumo variable y no deben aparecer
// en los gráficos de gasto variable (van a ahorros, deudas o ya son fijos).
const CATEGORIAS_NO_VARIABLES = ["Ahorros", "Deudas", "Gastos fijos"];

// ===== Barra apilada: qué parte del salario se fue en cada categoría =====
function dibujarPieCategorias(data) {
  const cont = document.getElementById("dash-lista-variables");
  const categorias = (data.detalle_variables || []).filter((v) => !CATEGORIAS_NO_VARIABLES.includes(v.categoria));
  // El total ya no sale de "salario - fijos" sino de la suma de los presupuestos
  // asignados a cada categoría de gasto variable en Configurar.
  const disponibleParaVariables = (data.presupuesto_categorias || []).reduce((s, c) => s + (c.presupuesto_mensual || 0), 0);

  if (categorias.length === 0) {
    cont.innerHTML = `<div class="vacio">No hay gastos variables registrados este mes todavía. Importalos en la pestaña Gastos mensuales.</div>`;
    return;
  }
  if (!disponibleParaVariables) {
    cont.innerHTML = `<div class="vacio">Asigná un presupuesto a tus categorías en Configurar para ver este gráfico.</div>`;
    return;
  }

  const totalVariables = categorias.reduce((s, v) => s + v.total, 0);

  const segmentos = categorias.map((v) => {
    const pct = Math.max((v.total / disponibleParaVariables) * 100, 0);
    return `<div class="barra-apilada-segmento" style="width:${pct}%; background:${v.color};" title="${v.categoria}: ${formatoColones(v.total)}"></div>`;
  }).join("") + (() => {
    const pctDisponible = Math.max(((disponibleParaVariables - totalVariables) / disponibleParaVariables) * 100, 0);
    return pctDisponible > 0 ? `<div class="barra-apilada-segmento" style="width:${pctDisponible}%; background:var(--linea);" title="Disponible: ${formatoColones(disponibleParaVariables - totalVariables)}"></div>` : "";
  })();

  const leyenda = categorias.map((v) => `
    <div class="leyenda-punto-item">
      <span class="leyenda-punto" style="background:${v.color};"></span>
      <span>${v.categoria || "Sin categoría"}</span>
    </div>`).join("") + `
    <div class="leyenda-punto-item leyenda-punto-disponible">
      <span class="leyenda-punto" style="background:var(--linea);"></span>
      <span>Disponible</span>
    </div>`;

  cont.innerHTML = `
    <div class="barra-apilada-encabezado">
      <span class="barra-apilada-total">De ${formatoColones(disponibleParaVariables)} para variables</span>
      <span class="barra-apilada-gastado">${formatoColones(totalVariables)} gastado</span>
    </div>
    <div class="barra-apilada-track">
      ${segmentos}
    </div>
    <div class="barra-apilada-leyenda">${leyenda}</div>`;
}

// ===== Grilla de anillos: presupuesto por categoría =====
function dibujarBarrasPresupuesto(data) {
  const cont = document.getElementById("dash-grafico-barras");
  const categorias = (data.presupuesto_categorias || []).filter((c) => c.presupuesto_mensual > 0);

  if (categorias.length === 0) {
    cont.innerHTML = encabezadoGastoVariable(data) +
      `<div class="vacio">Asigná un presupuesto a tus categorías en Configurar para ver este gráfico.</div>`;
    return;
  }

  function abreviar(monto) {
    const n = Math.round(Math.abs(monto || 0));
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(n);
  }

  const tarjetas = categorias.map((c) => {
    const sobrepasado = c.gastado > c.presupuesto_mensual;
    const pctReal = c.presupuesto_mensual ? (c.gastado / c.presupuesto_mensual) * 100 : 0;
    const fraccion = Math.min(pctReal / 100, 1);
    const color = sobrepasado ? "var(--terracota)" : (c.color || "var(--azul)");
    const libres = c.presupuesto_mensual - c.gastado;
    const simbolo = monedaVisualizacion === "USD" ? "$" : "₡";

    const tam = 88, r = 36, cx = tam / 2, cy = tam / 2, circ = 2 * Math.PI * r;
    const dash = circ * fraccion;
    const colorTexto = sobrepasado ? "var(--terracota)" : "var(--verde)";

    const anillo = `
      <svg width="${tam}" height="${tam}" viewBox="0 0 ${tam} ${tam}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--linea)" stroke-width="7"></circle>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="${circ}" stroke-dashoffset="${circ - dash}"
          transform="rotate(-90 ${cx} ${cy})"></circle>
        <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-family="var(--fuente-mono)" font-size="17" font-weight="800" fill="var(--tinta)">${simbolo}${abreviar(libres)}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="var(--fuente-cuerpo)" font-size="10" font-weight="700" fill="${colorTexto}">${sobrepasado ? "de más" : "libres"}</text>
      </svg>`;

    return `
      <div class="tarjeta-anillo-categoria">
        ${anillo}
        <div class="tarjeta-anillo-info">
          <span class="tarjeta-anillo-nombre">${c.categoria}</span>
          <span class="tarjeta-anillo-gastado">Gastado ${formatoColones(c.gastado)}</span>
          <span class="tarjeta-anillo-detalle" style="${sobrepasado ? "color:var(--terracota); font-weight:600;" : ""}">de ${formatoColones(c.presupuesto_mensual)} · ${Math.round(pctReal)}%</span>
        </div>
      </div>`;
  }).join("");

  cont.innerHTML = encabezadoGastoVariable(data) +
    `<div class="grilla-anillos-categoria">${tarjetas}</div>`;
}

function abrirModalMarcarPago(rubroId, presupuestado, yaEstaPagado, montoQ1, montoQ2, moneda) {
  if (yaEstaPagado) {
    if (confirm("¿Deshacer el pago de este rubro para este mes?")) {
      api(`/pagos-fijos?mes=${mesActual}`).then(async (pagos) => {
        // Un rubro puede tener pago registrado en Q1 y Q2 por separado: hay que
        // borrar todos los pagos de este mes, no solo el primero que aparezca,
        // si no queda "a medias" marcado como pagado.
        const pagosDelRubro = pagos.filter((p) => p.rubro_id == rubroId);
        await Promise.all(pagosDelRubro.map((p) => api(`/pagos-fijos/${p.id}`, { method: "DELETE" })));
        cargarDashboard();
      });
    }
    return;
  }

  const montosPorQuincena = { Q1: montoQ1, Q2: montoQ2 };
  const simbolo = moneda === "USD" ? "$" : "₡";
  // El selector de quincena solo tiene sentido si el rubro está dividido en
  // dos pagos; si no, mostrarlo confunde y permite elegir "Quincena 2" con
  // un monto de 0 (la cuota completa va siempre en Q1).
  const dividido = montoQ2 > 0;

  abrirModal(`
    <h3>Marcar rubro como pagado</h3>
    ${dividido ? `
    <label>Quincena</label>
    <select id="modal-quincena">
      <option value="Q1">Quincena 1</option>
      <option value="Q2">Quincena 2</option>
    </select>` : ""}
    <label>Monto pagado (${moneda === "USD" ? "Dólares" : "Colones"})</label>
    <input type="number" id="modal-monto" value="${montoQ1}" step="1">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Marcar como pagado</button>
    </div>
  `);

  if (dividido) {
    document.getElementById("modal-quincena").addEventListener("change", (e) => {
      document.getElementById("modal-monto").value = montosPorQuincena[e.target.value];
    });
  }

  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const quincena = dividido ? document.getElementById("modal-quincena").value : "Q1";
    const monto = parseFloat(document.getElementById("modal-monto").value);
    await api("/pagos-fijos", {
      method: "POST",
      body: JSON.stringify({ rubro_id: parseInt(rubroId), mes: mesActual, quincena, monto, moneda, origen: "manual" }),
    });
    cerrarModal();
    cargarDashboard();
  });
}

// =====================================================================
// TAB 2: OBJETIVOS LARGO PLAZO
// =====================================================================
async function cargarObjetivos() {
  const objetivos = await api("/objetivos");
  // Cada objetivo puede estar configurado en una moneda distinta: hay que convertir
  // todos a la moneda de visualización antes de sumarlos, si no el total no tiene sentido.
  const totalAcumulado = objetivos.reduce((s, o) => s + convertirAMonedaVisualizacion(o.acumulado || 0, o.moneda), 0);
  const metasActivas = objetivos.filter((o) => (o.acumulado || 0) < (o.monto_total || 0)).length;
  const hero = document.getElementById("ahorros-hero");
  if (hero) {
    hero.innerHTML = objetivos.length === 0 ? "" : `
      <div class="ahorros-hero">
        <div class="ahorros-hero-main">
          <span class="ahorros-hero-label">Total acumulado</span>
          <span class="ahorros-hero-monto">${formatoColones(totalAcumulado)}</span>
        </div>
        <div class="ahorros-hero-side">${metasActivas} meta${metasActivas === 1 ? "" : "s"} activa${metasActivas === 1 ? "" : "s"}</div>
      </div>`;
  }
  renderObjetivos(objetivos, "lista-objetivos", true);
}

function renderObjetivos(objetivos, contenedorId, conAcciones) {
  const cont = document.getElementById(contenedorId);
  if (objetivos.length === 0) {
    cont.innerHTML = `<div class="vacio">Todavía no tenés objetivos de largo plazo. Creá el primero, como "Colchón financiero" o "Prima casa".</div>`;
    return;
  }
  cont.innerHTML = objetivos.map((o) => `
    <div class="tarjeta-objetivo meta-card">
      <div class="meta-card-top">
        <div class="meta-titulo">
          <div class="tarjeta-objetivo-nombre">${o.nombre}</div>
          <div class="tarjeta-objetivo-meta">Meta ${formatoMonto(o.monto_total, o.moneda)} · ${o.meses_plazo} meses</div>
        </div>
        ${conAcciones ? `
        <div class="tarjeta-objetivo-acciones">
          <button class="boton-texto meta-accion-destacada" data-aportar="${o.id}" data-nombre="${o.nombre}" data-moneda="${o.moneda}">+ Aportar</button>
          <button class="boton-texto meta-accion-suave" data-editar="${o.id}" data-nombre="${o.nombre}" data-monto="${o.monto_total}" data-meses="${o.meses_plazo}" data-moneda="${o.moneda}">Editar</button>
          <button class="boton-texto meta-accion-suave" data-borrar="${o.id}">Eliminar</button>
        </div>` : ""}
      </div>

      <div class="meta-card-cuerpo">
        <div class="meta-ahorrado">
          <span class="meta-mini-label">Ahorrado</span>
          <span class="meta-monto-fila">
            <span class="meta-monto">${formatoMonto(o.acumulado, o.moneda)}</span>
            <span class="meta-monto-de">de ${formatoMonto(o.monto_total, o.moneda)}</span>
            ${notaMonedaOriginal(o.acumulado, o.moneda)}
          </span>
        </div>
        <span class="meta-pct">${o.porcentaje}%</span>
      </div>

      <div class="termometro-track meta-barra">
        <div class="termometro-relleno" style="width:${o.porcentaje}%"></div>
      </div>

      <div class="meta-card-footer">
        <div class="meta-footer-item">
          <span class="meta-mini-label">Faltan</span>
          <span class="meta-footer-valor">${formatoMonto(Math.max(o.monto_total - o.acumulado, 0), o.moneda)}</span>
        </div>
        <div class="meta-footer-item">
          <span class="meta-mini-label">Aporte</span>
          <span class="meta-footer-valor">${formatoMonto(o.aporte_mensual_sugerido, o.moneda)}</span>
        </div>
        <div class="meta-footer-item">
          <span class="meta-mini-label">A este ritmo</span>
          <span class="meta-footer-valor">${o.meses_restantes !== null ? `≈ ${o.meses_restantes} meses` : "—"}</span>
        </div>
      </div>
    </div>`).join("");

  if (conAcciones) {
    cont.querySelectorAll("[data-aportar]").forEach((btn) =>
      btn.addEventListener("click", () => abrirModalAporte(btn.dataset.aportar, btn.dataset.nombre, btn.dataset.moneda))
    );
    cont.querySelectorAll("[data-editar]").forEach((btn) =>
      btn.addEventListener("click", () => abrirModalEditarObjetivo(btn.dataset.editar, btn.dataset.nombre, btn.dataset.monto, btn.dataset.meses, btn.dataset.moneda))
    );
    cont.querySelectorAll("[data-borrar]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (confirm("¿Eliminar este objetivo? Esta acción no se puede deshacer.")) {
          await api(`/objetivos/${btn.dataset.borrar}`, { method: "DELETE" });
          cargarObjetivos();
        }
      })
    );
  }
}

document.getElementById("btn-nuevo-objetivo").addEventListener("click", async () => {
  const configSalario = await api("/configuracion");

  abrirModal(`
    <h3>Nuevo objetivo de largo plazo</h3>
    <label>Nombre</label>
    <input type="text" id="modal-nombre" placeholder="Ej. Prima casa">
    <label>Moneda</label>
    <select id="modal-moneda">
      <option value="CRC">Colones (CRC)</option>
      <option value="USD">Dólares (USD)</option>
    </select>
    <label>¿Cómo querés definir la meta?</label>
    <select id="modal-modo">
      <option value="total">Monto total a ahorrar</option>
      <option value="mensual">Monto a ahorrar por mes</option>
      <option value="porcentaje">Porcentaje del salario por mes</option>
    </select>

    <div id="modal-campo-total">
      <label>Monto total de la meta</label>
      <input type="number" id="modal-monto-total" step="1" min="0">
    </div>
    <div id="modal-campo-mensual" class="modal-campo-oculto">
      <label>Monto a ahorrar por mes</label>
      <input type="number" id="modal-monto-mensual" step="1" min="0">
    </div>
    <div id="modal-campo-porcentaje" class="modal-campo-oculto">
      <label>Porcentaje del salario por mes</label>
      <input type="number" id="modal-porcentaje" step="0.1" min="0" max="100">
    </div>

    <label>Plazo en meses</label>
    <input type="number" id="modal-meses" step="1" min="1">

    <label class="modal-check">
      <input type="checkbox" id="modal-dividir-quincenas">
      Dividir el aporte mensual en dos quincenas iguales
    </label>

    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Crear objetivo</button>
    </div>
  `);

  const camposPorModo = {
    total: document.getElementById("modal-campo-total"),
    mensual: document.getElementById("modal-campo-mensual"),
    porcentaje: document.getElementById("modal-campo-porcentaje"),
  };
  document.getElementById("modal-modo").addEventListener("change", (e) => {
    Object.values(camposPorModo).forEach((div) => div.classList.add("modal-campo-oculto"));
    camposPorModo[e.target.value].classList.remove("modal-campo-oculto");
  });

  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const nombre = document.getElementById("modal-nombre").value.trim();
    const moneda = document.getElementById("modal-moneda").value;
    const modo = document.getElementById("modal-modo").value;
    const meses_plazo = parseInt(document.getElementById("modal-meses").value);
    const dividir_quincenas = document.getElementById("modal-dividir-quincenas").checked;
    if (!nombre || !meses_plazo) return;

    let monto_total;
    if (modo === "mensual") {
      const monto_mensual = parseFloat(document.getElementById("modal-monto-mensual").value) || 0;
      monto_total = Math.round(monto_mensual * meses_plazo);
    } else if (modo === "porcentaje") {
      const pct = parseFloat(document.getElementById("modal-porcentaje").value) || 0;
      const salarioEnMonedaObjetivo = convertirEntreMonedas(configSalario.salario_total, configSalario.salario_moneda, moneda);
      const monto_mensual = salarioEnMonedaObjetivo * pct / 100;
      monto_total = Math.round(monto_mensual * meses_plazo);
    } else {
      monto_total = parseFloat(document.getElementById("modal-monto-total").value) || 0;
    }
    if (!monto_total) return;

    await api("/objetivos", { method: "POST", body: JSON.stringify({ nombre, monto_total, meses_plazo, moneda, dividir_quincenas }) });
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
});

function abrirModalEditarObjetivo(id, nombre, monto, meses, moneda) {
  abrirModal(`
    <h3>Editar objetivo</h3>
    <label>Nombre</label>
    <input type="text" id="modal-nombre" value="${nombre}">
    <label>Monto total de la meta</label>
    <input type="number" id="modal-monto-total" value="${monto}" step="1">
    <label>Moneda</label>
    <select id="modal-moneda">
      <option value="CRC" ${moneda !== "USD" ? "selected" : ""}>Colones (CRC)</option>
      <option value="USD" ${moneda === "USD" ? "selected" : ""}>Dólares (USD)</option>
    </select>
    <label>Plazo en meses</label>
    <input type="number" id="modal-meses" value="${meses}" step="1">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Guardar cambios</button>
    </div>
    <hr class="modal-separador">
    <button class="boton-texto boton-peligro" id="modal-retirar">Retirar fondos (uso de emergencia)</button>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const nuevoNombre = document.getElementById("modal-nombre").value.trim();
    const monto_total = parseFloat(document.getElementById("modal-monto-total").value);
    const nuevaMoneda = document.getElementById("modal-moneda").value;
    const meses_plazo = parseInt(document.getElementById("modal-meses").value);
    await api(`/objetivos/${id}`, { method: "PUT", body: JSON.stringify({ nombre: nuevoNombre, monto_total, meses_plazo, moneda: nuevaMoneda }) });
    cerrarModal();
    cargarObjetivos();
  });
  document.getElementById("modal-retirar").addEventListener("click", () => {
    abrirModalRetiroObjetivo(id, nombre, moneda);
  });
}

function abrirModalRetiroObjetivo(objetivoId, nombre, moneda) {
  abrirModal(`
    <h3>Retirar fondos de "${nombre}"</h3>
    <p class="modal-aviso">No se debería, pero si ocupás usar este dinero para una emergencia, podés retirarlo acá. El monto se devuelve a tu disponible del mes, registrado bajo la etiqueta "Ahorros".</p>
    <label>Monto a retirar</label>
    <input type="number" id="modal-monto" step="1" min="0">
    <label>Motivo (opcional)</label>
    <input type="text" id="modal-nota" placeholder="Ej. Reparación de emergencia">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario boton-peligro" id="modal-confirmar">Confirmar retiro</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const monto = parseFloat(document.getElementById("modal-monto").value);
    const nota = document.getElementById("modal-nota").value.trim();
    if (!monto) return;
    const resultado = await api(`/objetivos/${objetivoId}/retiros`, { method: "POST", body: JSON.stringify({ monto, nota }) });
    if (resultado && resultado.error) {
      alert(resultado.error);
      return;
    }
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
}

function abrirModalAporte(objetivoId, nombre, moneda) {
  abrirModal(`
    <h3>Registrar aporte${nombre ? ` a "${nombre}"` : ""}</h3>
    <label>Monto del aporte (${moneda === "USD" ? "Dólares" : "Colones"})</label>
    <input type="number" id="modal-monto" step="1" min="0">
    <label>Nota (opcional)</label>
    <input type="text" id="modal-nota" placeholder="Ej. Bono de diciembre">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Guardar aporte</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const monto = parseFloat(document.getElementById("modal-monto").value);
    const nota = document.getElementById("modal-nota").value.trim();
    if (!monto) return;
    await api(`/objetivos/${objetivoId}/aportes`, { method: "POST", body: JSON.stringify({ monto, nota }) });
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
}

// =====================================================================
// TAB: DEUDAS
// =====================================================================

// Réplica en JS de la amortización que hace el backend, para la calculadora
// de "qué pasa si abono extra" sin necesidad de ida y vuelta al servidor.
function mesesRestantesDeuda(saldo, cuota, tasaAnual) {
  saldo = saldo || 0;
  cuota = cuota || 0;
  if (saldo <= 0) return { meses: 0, interes: 0 };
  if (!cuota) return { meses: null, interes: null };
  if (!tasaAnual) return { meses: saldo / cuota, interes: 0 };
  const r = (tasaAnual / 100) / 12;
  if (r <= 0) return { meses: saldo / cuota, interes: 0 };
  if (cuota <= saldo * r) return { meses: null, interes: null };
  const n = -Math.log(1 - (r * saldo) / cuota) / Math.log(1 + r);
  const interes = Math.max(cuota * n - saldo, 0);
  return { meses: n, interes };
}

async function cargarDeudas() {
  const deudas = await api("/deudas");
  const totalAdeudado = deudas.reduce((s, d) => s + convertirAMonedaVisualizacion(d.saldo_actual, d.moneda), 0);
  const hero = document.getElementById("deudas-hero");
  if (hero) {
    hero.innerHTML = deudas.length === 0 ? "" : `
      <div class="ahorros-hero">
        <div class="ahorros-hero-main">
          <span class="ahorros-hero-label">Total adeudado</span>
          <span class="ahorros-hero-monto">${formatoColones(totalAdeudado)}</span>
        </div>
        <div class="ahorros-hero-side">${deudas.length} deuda${deudas.length === 1 ? "" : "s"} activa${deudas.length === 1 ? "" : "s"}</div>
      </div>`;
  }

  const cont = document.getElementById("lista-deudas");
  if (deudas.length === 0) {
    cont.innerHTML = `<div class="vacio">No tenés deudas registradas. Si tenés alguna (tarjeta, préstamo...), agregala para llevarle la pista.</div>`;
    return;
  }

  cont.innerHTML = deudas.map((d) => {
    const sinSalida = d.meses_restantes === null;
    return `
    <div class="tarjeta-objetivo">
      <div class="tarjeta-objetivo-header">
        <div>
          <div class="tarjeta-objetivo-nombre">${d.nombre}</div>
          <div class="tarjeta-objetivo-meta">
            Cuota ${formatoMonto(d.cuota_minima, d.moneda)}${d.dividir_quincenas ? " (dividida en 2 quincenas)" : "/mes"}
            ${d.tasa_interes_anual ? ` · ${d.tasa_interes_anual}% anual` : " · sin interés"}
          </div>
        </div>
        <div class="tarjeta-objetivo-acciones">
          <button class="boton-texto" data-abonar="${d.id}">+ Abonar</button>
          <button class="boton-texto" data-calculadora="${d.id}">Calculadora</button>
          <button class="boton-texto" data-editar-deuda="${d.id}" data-nombre="${d.nombre}" data-cuota="${d.cuota_minima}" data-tasa="${d.tasa_interes_anual || ""}" data-moneda="${d.moneda}" data-quincenas="${d.dividir_quincenas}">Editar</button>
          <button class="boton-texto" data-borrar-deuda="${d.id}">Eliminar</button>
        </div>
      </div>
      <div class="termometro-track">
        <div class="termometro-relleno" style="width:${d.porcentaje}%"></div>
        <span class="termometro-pct">${d.porcentaje}%</span>
      </div>
      <div class="tarjeta-objetivo-stats">
        <span>Saldo: <strong>${formatoMonto(d.saldo_actual, d.moneda)}</strong></span>
        <span>Pagado: <strong>${formatoMonto(d.pagado, d.moneda)}</strong> de ${formatoMonto(d.saldo_inicial, d.moneda)}</span>
        <span>${sinSalida ? "La cuota no alcanza ni para cubrir el interés" : d.meses_restantes !== null ? `≈ ${d.meses_restantes} meses restantes${d.interes_total_estimado ? ` · ${formatoMonto(d.interes_total_estimado, d.moneda)} en intereses` : ""}` : ""}</span>
      </div>
    </div>`;
  }).join("");

  cont.querySelectorAll("[data-abonar]").forEach((btn) =>
    btn.addEventListener("click", () => abrirModalAbonoDeuda(btn.dataset.abonar))
  );
  cont.querySelectorAll("[data-calculadora]").forEach((btn) => {
    const d = deudas.find((x) => x.id == btn.dataset.calculadora);
    btn.addEventListener("click", () => abrirModalCalculadoraDeuda(d));
  });
  cont.querySelectorAll("[data-editar-deuda]").forEach((btn) =>
    btn.addEventListener("click", () => abrirModalEditarDeuda(
      btn.dataset.editarDeuda, btn.dataset.nombre, btn.dataset.cuota, btn.dataset.tasa, btn.dataset.moneda, btn.dataset.quincenas === "1"
    ))
  );
  cont.querySelectorAll("[data-borrar-deuda]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (confirm("¿Eliminar esta deuda? También se borra el rubro fijo de la cuota mínima asociado.")) {
        await api(`/deudas/${btn.dataset.borrarDeuda}`, { method: "DELETE" });
        cargarDeudas();
      }
    })
  );
}

document.getElementById("btn-nueva-deuda").addEventListener("click", abrirModalNuevaDeuda);

function abrirModalNuevaDeuda() {
  abrirModal(`
    <h3>Nueva deuda</h3>
    <label>Nombre</label>
    <input type="text" id="modal-nombre" placeholder="Ej. Tarjeta BAC">
    <label>Moneda</label>
    <select id="modal-moneda">
      <option value="CRC">Colones (CRC)</option>
      <option value="USD">Dólares (USD)</option>
    </select>
    <label>¿Cómo querés definirla?</label>
    <select id="modal-modo">
      <option value="monto">Por el monto que falta por pagar</option>
      <option value="plazo">Por el plazo que falta para saldarla</option>
    </select>

    <div id="modal-campo-monto">
      <label>Monto adeudado actualmente</label>
      <input type="number" id="modal-monto-adeudado" step="1" min="0">
    </div>
    <div id="modal-campo-plazo" class="modal-campo-oculto">
      <label>Meses que faltan para terminar de pagarla</label>
      <input type="number" id="modal-meses-plazo" step="1" min="1">
    </div>

    <label>Cuota mínima</label>
    <input type="number" id="modal-cuota-minima" step="1" min="0">
    <label>Tasa de interés anual (opcional, dejalo vacío si no la sabés o no tiene)</label>
    <input type="number" id="modal-tasa" step="0.01" min="0" placeholder="Ej. 38">

    <label>¿Cómo pagás la cuota?</label>
    <select id="modal-frecuencia">
      <option value="mensual">Una vez al mes</option>
      <option value="quincenal">Dividida en dos quincenas</option>
    </select>

    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Crear deuda</button>
    </div>
  `);

  const campoMonto = document.getElementById("modal-campo-monto");
  const campoPlazo = document.getElementById("modal-campo-plazo");
  document.getElementById("modal-modo").addEventListener("change", (e) => {
    if (e.target.value === "plazo") {
      campoMonto.classList.add("modal-campo-oculto");
      campoPlazo.classList.remove("modal-campo-oculto");
    } else {
      campoPlazo.classList.add("modal-campo-oculto");
      campoMonto.classList.remove("modal-campo-oculto");
    }
  });

  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const nombre = document.getElementById("modal-nombre").value.trim();
    const moneda = document.getElementById("modal-moneda").value;
    const modo = document.getElementById("modal-modo").value;
    const cuota_minima = parseFloat(document.getElementById("modal-cuota-minima").value) || 0;
    const tasaVal = document.getElementById("modal-tasa").value;
    const tasa_interes_anual = tasaVal === "" ? null : parseFloat(tasaVal);
    const dividir_quincenas = document.getElementById("modal-frecuencia").value === "quincenal";
    if (!nombre || !cuota_minima) return;

    const body = { nombre, moneda, modo, cuota_minima, tasa_interes_anual, dividir_quincenas };
    if (modo === "plazo") {
      body.meses_plazo = parseInt(document.getElementById("modal-meses-plazo").value) || 0;
      if (!body.meses_plazo) return;
    } else {
      body.monto_adeudado = parseFloat(document.getElementById("modal-monto-adeudado").value) || 0;
      if (!body.monto_adeudado) return;
    }

    await api("/deudas", { method: "POST", body: JSON.stringify(body) });
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
}

function abrirModalEditarDeuda(id, nombre, cuota, tasa, moneda, dividirQuincenas) {
  abrirModal(`
    <h3>Editar deuda</h3>
    <label>Nombre</label>
    <input type="text" id="modal-nombre" value="${nombre}">
    <label>Moneda</label>
    <select id="modal-moneda">
      <option value="CRC" ${moneda !== "USD" ? "selected" : ""}>Colones (CRC)</option>
      <option value="USD" ${moneda === "USD" ? "selected" : ""}>Dólares (USD)</option>
    </select>
    <label>Cuota mínima</label>
    <input type="number" id="modal-cuota-minima" value="${cuota}" step="1" min="0">
    <label>Tasa de interés anual (opcional)</label>
    <input type="number" id="modal-tasa" value="${tasa || ""}" step="0.01" min="0">
    <label>¿Cómo pagás la cuota?</label>
    <select id="modal-frecuencia">
      <option value="mensual" ${!dividirQuincenas ? "selected" : ""}>Una vez al mes</option>
      <option value="quincenal" ${dividirQuincenas ? "selected" : ""}>Dividida en dos quincenas</option>
    </select>
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Guardar cambios</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const nuevoNombre = document.getElementById("modal-nombre").value.trim();
    const nuevaMoneda = document.getElementById("modal-moneda").value;
    const cuota_minima = parseFloat(document.getElementById("modal-cuota-minima").value) || 0;
    const tasaVal = document.getElementById("modal-tasa").value;
    const tasa_interes_anual = tasaVal === "" ? null : parseFloat(tasaVal);
    const dividir_quincenas = document.getElementById("modal-frecuencia").value === "quincenal";
    if (!nuevoNombre || !cuota_minima) return;
    await api(`/deudas/${id}`, {
      method: "PUT",
      body: JSON.stringify({ nombre: nuevoNombre, moneda: nuevaMoneda, cuota_minima, tasa_interes_anual, dividir_quincenas }),
    });
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
}

function abrirModalAbonoDeuda(deudaId) {
  abrirModal(`
    <h3>Abonar a la deuda</h3>
    <p class="modal-aviso">Esto es aparte de la cuota mínima mensual: un abono extraordinario que baja el saldo más rápido.</p>
    <label>Monto del abono</label>
    <input type="number" id="modal-monto" step="1" min="0">
    <label>Nota (opcional)</label>
    <input type="text" id="modal-nota" placeholder="Ej. Aguinaldo">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Guardar abono</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const monto = parseFloat(document.getElementById("modal-monto").value);
    const nota = document.getElementById("modal-nota").value.trim();
    if (!monto) return;
    await api(`/deudas/${deudaId}/abonos`, { method: "POST", body: JSON.stringify({ monto, nota }) });
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
}

async function abrirModalAbonarDeudaRapido() {
  const deudas = await api("/deudas");
  if (deudas.length === 0) {
    alert("Todavía no tenés deudas registradas. Creá una primero en la pestaña Deudas.");
    return;
  }
  if (deudas.length === 1) {
    abrirModalAbonoDeuda(deudas[0].id);
    return;
  }
  abrirModal(`
    <h3>¿A qué deuda querés abonar?</h3>
    <label>Deuda</label>
    <select id="modal-deuda-rapida">
      ${deudas.map((d) => `<option value="${d.id}">${d.nombre}</option>`).join("")}
    </select>
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Continuar</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", () => {
    abrirModalAbonoDeuda(document.getElementById("modal-deuda-rapida").value);
  });
}

// Calculadora: "¿qué pasa si abono extra?" — compara meses e intereses con y sin
// el abono adicional, todo calculado en el navegador a partir del saldo actual.
// Más allá de esto (~20 años), la cuota apenas alcanza a cubrir el interés: la
// fórmula de amortización se vuelve extremadamente sensible ahí (un abono chiquito
// puede "ahorrar" un monto de interés gigante en términos relativos) y mostrar esa
// cifra tal cual es engañoso, aunque matemáticamente se derive de la fórmula correcta.
const LIMITE_MESES_CONFIABLE = 240;

function abrirModalCalculadoraDeuda(d) {
  const base = mesesRestantesDeuda(d.saldo_actual, d.cuota_minima, d.tasa_interes_anual);

  abrirModal(`
    <h3>Calculadora · ${d.nombre}</h3>
    <p class="modal-aviso">Saldo actual: ${formatoMonto(d.saldo_actual, d.moneda)} · Cuota: ${formatoMonto(d.cuota_minima, d.moneda)}${d.tasa_interes_anual ? ` · ${d.tasa_interes_anual}% anual` : " · sin interés"}</p>
    <label>Abono extra mensual (además de la cuota)</label>
    <input type="number" id="modal-abono-mensual" step="1" min="0" value="0">
    <label>Abono único de una sola vez (se resta del saldo antes de simular)</label>
    <input type="number" id="modal-abono-unico" step="1" min="0" value="0">
    <div id="resultado-calculadora" class="resultado-calculadora"></div>
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cerrar</button>
    </div>
  `);

  function recalcular() {
    const abonoMensual = parseFloat(document.getElementById("modal-abono-mensual").value) || 0;
    const abonoUnico = parseFloat(document.getElementById("modal-abono-unico").value) || 0;
    const saldoConAbono = Math.max(d.saldo_actual - abonoUnico, 0);
    const conExtra = mesesRestantesDeuda(saldoConAbono, d.cuota_minima + abonoMensual, d.tasa_interes_anual);

    const cont = document.getElementById("resultado-calculadora");
    if (conExtra.meses === null) {
      cont.innerHTML = `<p>Con esos números la cuota no alcanza a cubrir ni el interés mensual — no se termina de pagar así.</p>`;
      return;
    }
    if ((base.meses !== null && base.meses > LIMITE_MESES_CONFIABLE) || conExtra.meses > LIMITE_MESES_CONFIABLE) {
      cont.innerHTML = `<p>La cuota actual apenas alcanza a cubrir el interés de esta deuda — al ritmo actual tardaría más de ${Math.round(LIMITE_MESES_CONFIABLE / 12)} años en pagarse. En ese punto cualquier abono ayuda muchísimo, pero el cálculo exacto de cuánto se ahorra deja de ser confiable (la fórmula se vuelve muy inestable ahí). Lo más sano es subir la cuota mínima antes de fijarte en el ahorro de intereses.</p>`;
      return;
    }
    const mesesAhorrados = base.meses !== null ? Math.max(base.meses - conExtra.meses, 0) : 0;
    const interesAhorrado = base.interes !== null ? Math.max(base.interes - conExtra.interes, 0) : 0;
    cont.innerHTML = `
      <div class="resultado-calculadora-fila"><span>Meses restantes ahora</span><strong>${base.meses !== null ? base.meses.toFixed(1) : "—"}</strong></div>
      <div class="resultado-calculadora-fila"><span>Meses restantes con el abono</span><strong>${conExtra.meses.toFixed(1)}</strong></div>
      <div class="resultado-calculadora-fila destacado"><span>Te ahorrarías</span><strong>${mesesAhorrados.toFixed(1)} meses${d.tasa_interes_anual ? ` y ${formatoMonto(interesAhorrado, d.moneda)} en intereses` : ""}</strong></div>
    `;
  }

  document.getElementById("modal-abono-mensual").addEventListener("input", recalcular);
  document.getElementById("modal-abono-unico").addEventListener("input", recalcular);
  recalcular();
}

// =====================================================================
// TAB 3: TRANSACCIONES
// =====================================================================
let transaccionesDelMes = [];
let ingresosExtraDelMes = [];

// Clasifica el origen de una fila para mostrar un acento de color sutil y una
// etiqueta chiquita. Esto es puramente visual: la lista sigue viniendo de
// /api/transacciones (gastos) y /api/ingresos-extra (ingresos) tal cual,
// nada de esto toca las sumas que usa el dashboard.
function origenFila(t) {
  if (t.esIngreso) return { clase: "origen-ingreso", etiqueta: "Ingreso extra" };
  if (t.origen_archivo === "gmail") return { clase: "origen-correo", etiqueta: "Correo" };
  if (t.origen_archivo === "aporte_objetivo") return { clase: "origen-ahorro", etiqueta: "Ahorro" };
  if (t.origen_archivo === "abono_deuda") return { clase: "origen-deuda", etiqueta: "Abono a deuda" };
  if (t.origen_archivo === "pago_fijo") return { clase: "origen-fijo", etiqueta: "Gasto fijo" };
  return { clase: "origen-manual", etiqueta: "Manual" };
}

async function cargarGastos() {
  cargarEstadoGmail();
  if (categorias.length === 0) categorias = await api("/categorias");
  transaccionesDelMes = await api(`/transacciones?mes=${mesActual}`);
  ingresosExtraDelMes = await api(`/ingresos-extra?mes=${mesActual}`);

  const filtro = document.getElementById("filtro-categoria-transacciones");
  const seleccionPrevia = filtro.value;
  filtro.innerHTML = `<option value="">Todas las categorías</option>` +
    categorias.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join("");
  filtro.value = seleccionPrevia;

  renderTransacciones();
}

function renderTransacciones() {
  const filtroCatId = document.getElementById("filtro-categoria-transacciones").value;
  const orden = document.getElementById("orden-transacciones").value;

  const gastos = filtroCatId
    ? transaccionesDelMes.filter((t) => String(t.categoria_id) === filtroCatId)
    : transaccionesDelMes;
  // Los ingresos extra no tienen categoría: solo aparecen cuando no hay filtro activo.
  const ingresos = filtroCatId ? [] : ingresosExtraDelMes.map((i) => ({ ...i, esIngreso: true, comercio: i.descripcion }));

  const filas = [...gastos, ...ingresos];

  filas.sort((a, b) => {
    if (orden === "monto-desc") return convertirAMonedaVisualizacion(b.monto, b.moneda) - convertirAMonedaVisualizacion(a.monto, a.moneda);
    if (orden === "monto-asc") return convertirAMonedaVisualizacion(a.monto, a.moneda) - convertirAMonedaVisualizacion(b.monto, b.moneda);
    if (orden === "fecha-asc") return new Date(a.fecha) - new Date(b.fecha);
    return new Date(b.fecha) - new Date(a.fecha);
  });

  const cont = document.getElementById("tabla-transacciones");
  if (filas.length === 0) {
    cont.innerHTML = filtroCatId
      ? `<div class="vacio">No hay transacciones en esta categoría este mes.</div>`
      : `<div class="vacio">No hay transacciones este mes. Importá tus correos arriba o agregá una a mano.</div>`;
    return;
  }

  cont.innerHTML = filas.map((t) => {
    const origen = origenFila(t);
    if (t.esIngreso) {
      const estiloFecha = `style="background:${hexARgba("0E8C7F", 0.16)};"`;
      return `
        <div class="fila-transaccion ${origen.clase}">
          <span class="fila-transaccion-fecha" ${estiloFecha}>${formatoFecha(t.fecha)}</span>
          <span class="fila-transaccion-comercio">${t.comercio}<span class="etiqueta-origen">${origen.etiqueta}</span></span>
          <span class="select-categoria fila-transaccion-sin-categoria">—</span>
          <div class="fila-transaccion-derecha">
            <span class="fila-transaccion-monto fila-transaccion-monto-ingreso">+${formatoConvertido(t.monto, t.moneda)} ${notaMonedaOriginal(t.monto, t.moneda)}</span>
            <button class="fila-transaccion-borrar" data-borrar-ingreso="${t.id}" title="Eliminar">✕</button>
          </div>
        </div>`;
    }
    const categoria = categorias.find((c) => c.id === t.categoria_id);
    const colorCategoria = (categoria && categoria.color) || "5C6B7A";
    const estiloFecha = `style="background:${hexARgba(colorCategoria, 0.18)};"`;
    return `
      <div class="fila-transaccion ${origen.clase}">
        <span class="fila-transaccion-fecha" ${estiloFecha}>${formatoFecha(t.fecha)}</span>
        <span class="fila-transaccion-comercio">${t.comercio}<span class="etiqueta-origen">${origen.etiqueta}${t.ciudad ? " · " + t.ciudad : ""}</span></span>
        <select class="select-categoria" data-trans-id="${t.id}">
          ${categorias.map((c) => `<option value="${c.id}" ${c.id === t.categoria_id ? "selected" : ""}>${c.nombre}</option>`).join("")}
        </select>
        <div class="fila-transaccion-derecha">
          <span class="fila-transaccion-monto">${formatoConvertido(t.monto, t.moneda)} ${notaMonedaOriginal(t.monto, t.moneda)}</span>
          <button class="fila-transaccion-editar" data-editar-trans="${t.id}" title="Editar">✎</button>
          <button class="fila-transaccion-borrar" data-borrar-trans="${t.id}" title="Eliminar">✕</button>
        </div>
      </div>`;
  }).join("");

  cont.querySelectorAll(".select-categoria").forEach((sel) => {
    sel.addEventListener("change", async () => {
      await api(`/transacciones/${sel.dataset.transId}`, {
        method: "PUT",
        body: JSON.stringify({ categoria_id: parseInt(sel.value) }),
      });
      cargarGastos();
    });
  });

  cont.querySelectorAll("[data-borrar-trans]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (confirm("¿Eliminar esta transacción?")) {
        await api(`/transacciones/${btn.dataset.borrarTrans}`, { method: "DELETE" });
        cargarGastos();
      }
    });
  });

  cont.querySelectorAll("[data-borrar-ingreso]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (confirm("¿Eliminar este ingreso extraordinario?")) {
        await api(`/ingresos-extra/${btn.dataset.borrarIngreso}`, { method: "DELETE" });
        cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
      }
    });
  });

  cont.querySelectorAll("[data-editar-trans]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = transaccionesDelMes.find((x) => x.id == btn.dataset.editarTrans);
      abrirModalEditarTransaccion(t);
    });
  });
}

document.getElementById("filtro-categoria-transacciones").addEventListener("change", () => {
  renderTransacciones();
});

document.getElementById("orden-transacciones").addEventListener("change", () => {
  renderTransacciones();
});

function abrirModalEditarTransaccion(t) {
  abrirModal(`
    <h3>Editar transacción</h3>
    <label>Comercio</label>
    <input type="text" id="modal-comercio" value="${t.comercio.replace(/"/g, "&quot;")}">
    <label>Ciudad</label>
    <input type="text" id="modal-ciudad" value="${(t.ciudad || "").replace(/"/g, "&quot;")}">
    <label>Monto</label>
    <input type="number" id="modal-monto" step="1" min="0" value="${t.monto}">
    <label>Moneda</label>
    <select id="modal-moneda">
      <option value="CRC" ${t.moneda !== "USD" ? "selected" : ""}>Colones (CRC)</option>
      <option value="USD" ${t.moneda === "USD" ? "selected" : ""}>Dólares (USD)</option>
    </select>
    <label>Fecha</label>
    <input type="date" id="modal-fecha" value="${(t.fecha || "").slice(0, 10)}">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Guardar</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const comercio = document.getElementById("modal-comercio").value.trim();
    const ciudad = document.getElementById("modal-ciudad").value.trim();
    const monto = parseFloat(document.getElementById("modal-monto").value);
    const moneda = document.getElementById("modal-moneda").value;
    const fechaInput = document.getElementById("modal-fecha").value;
    if (!comercio || !monto || !fechaInput) return;
    const horaOriginal = (t.fecha || "").slice(11) || "12:00:00";
    const fecha = `${fechaInput}T${horaOriginal}`;
    await api(`/transacciones/${t.id}`, {
      method: "PUT",
      body: JSON.stringify({ comercio, ciudad, monto, moneda, fecha }),
    });
    cerrarModal();
    cargarGastos();
  });
}

document.getElementById("btn-agregar-manual").addEventListener("click", abrirModalGastoManual);

async function abrirModalGastoManual() {
  if (categorias.length === 0) categorias = await api("/categorias");
  abrirModal(`
    <h3>Agregar gasto a mano</h3>
    <label>Comercio</label>
    <input type="text" id="modal-comercio" placeholder="Ej. Soda Tía Maria">
    <label>Monto</label>
    <input type="number" id="modal-monto" step="1" min="0">
    <label>Moneda</label>
    <select id="modal-moneda">
      <option value="CRC">Colones (CRC)</option>
      <option value="USD">Dólares (USD)</option>
    </select>
    <label>Fecha</label>
    <input type="date" id="modal-fecha" value="${new Date().toISOString().slice(0, 10)}">
    <label>Categoría</label>
    <select id="modal-categoria">
      ${categorias.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join("")}
    </select>
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Agregar</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const comercio = document.getElementById("modal-comercio").value.trim();
    const monto = parseFloat(document.getElementById("modal-monto").value);
    const moneda = document.getElementById("modal-moneda").value;
    const fecha = document.getElementById("modal-fecha").value + "T12:00:00";
    const categoria_id = parseInt(document.getElementById("modal-categoria").value);
    if (!comercio || !monto) return;
    await api("/transacciones/manual", { method: "POST", body: JSON.stringify({ comercio, monto, moneda, fecha, categoria_id }) });
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
}

// --- Importación de correos ---
const zonaImportar = document.getElementById("zona-importar");
const inputCorreos = document.getElementById("input-correos");

document.getElementById("btn-elegir-archivos").addEventListener("click", (e) => {
  e.stopPropagation();
  inputCorreos.click();
});
zonaImportar.addEventListener("click", () => inputCorreos.click());

inputCorreos.addEventListener("change", () => {
  if (inputCorreos.files.length) importarArchivos(inputCorreos.files);
});

["dragenter", "dragover"].forEach((evento) => {
  zonaImportar.addEventListener(evento, (e) => {
    e.preventDefault();
    zonaImportar.classList.add("arrastrando");
  });
});
["dragleave", "drop"].forEach((evento) => {
  zonaImportar.addEventListener(evento, (e) => {
    e.preventDefault();
    zonaImportar.classList.remove("arrastrando");
  });
});
zonaImportar.addEventListener("drop", (e) => {
  const archivos = e.dataTransfer.files;
  if (archivos.length) importarArchivos(archivos);
});

async function importarArchivos(archivos) {
  const formData = new FormData();
  for (const archivo of archivos) {
    formData.append("archivos", archivo);
  }
  const resultadoDiv = document.getElementById("resultado-importacion");
  resultadoDiv.classList.remove("oculta");
  resultadoDiv.textContent = "Importando…";

  const data = await api("/importar-correos", { method: "POST", body: formData });

  let mensaje = `<strong>${data.importados}</strong> importados`;
  if (data.duplicados) mensaje += `, <strong>${data.duplicados}</strong> ya existían`;
  if (data.errores) mensaje += `, <strong>${data.errores}</strong> no se pudieron leer`;
  resultadoDiv.innerHTML = mensaje;

  inputCorreos.value = "";
  cargarGastos();
}

// =====================================================================
// --- Sincronización con Gmail ---
async function cargarEstadoGmail() {
  const estado = await api("/gmail/estado");
  const bloque = document.getElementById("bloque-gmail");
  const titulo = document.getElementById("gmail-titulo");
  const subtitulo = document.getElementById("gmail-subtitulo");
  const boton = document.getElementById("btn-sincronizar-gmail");

  if (!estado.credenciales_configuradas) {
    bloque.classList.add("necesita-config");
    titulo.textContent = "Gmail no está conectado todavía";
    subtitulo.textContent = "El servidor todavía no tiene configuradas las credenciales de Google.";
    boton.textContent = "Ver instrucciones";
    boton.onclick = () => abrirModalInstruccionesGmail();
  } else if (!estado.sesion_activa) {
    bloque.classList.add("necesita-config");
    titulo.textContent = "Conectá tu cuenta de Gmail";
    subtitulo.textContent = "Autorizá el acceso de solo lectura para poder sincronizar tus correos.";
    boton.textContent = "Conectar Gmail";
    boton.onclick = () => { window.location.href = API + "/gmail/conectar"; };
  } else {
    bloque.classList.remove("necesita-config");
    titulo.textContent = `Sincronizar etiqueta "${estado.etiqueta}"`;
    subtitulo.textContent = estado.ultima_sincronizacion
      ? `Última sincronización: ${formatoFecha(estado.ultima_sincronizacion)}`
      : "Todavía no se ha sincronizado. Click para traer tus correos.";
    boton.textContent = "Sincronizar ahora";
    boton.onclick = sincronizarGmail;
  }
}

async function sincronizarGmail() {
  const boton = document.getElementById("btn-sincronizar-gmail");
  const resultadoDiv = document.getElementById("resultado-sync-gmail");
  boton.disabled = true;
  boton.textContent = "Sincronizando…";
  resultadoDiv.classList.remove("oculta");
  resultadoDiv.textContent = "Sincronizando con Gmail…";

  try {
    const data = await api("/gmail/sincronizar", { method: "POST" });
    if (data.error) {
      resultadoDiv.innerHTML = data.error;
    } else {
      let mensaje = `<strong>${data.importados}</strong> correos nuevos importados`;
      if (data.duplicados) mensaje += `, <strong>${data.duplicados}</strong> ya estaban`;
      if (data.errores) mensaje += `, <strong>${data.errores}</strong> no se pudieron leer`;
      resultadoDiv.innerHTML = mensaje;
      cargarGastos();
    }
  } catch (e) {
    resultadoDiv.textContent = "Ocurrió un error al sincronizar. Revisá la terminal donde corre la app.";
  }

  boton.disabled = false;
  cargarEstadoGmail();
}

function abrirModalInstruccionesGmail() {
  abrirModal(`
    <h3>Conectar Gmail (una sola vez)</h3>
    <p style="font-size:13px; line-height:1.6; color:var(--tinta-suave);">
      Para que la app pueda leer correos de Gmail, quien administra el servidor
      tiene que configurar las credenciales de Google (variables de entorno
      <code>GOOGLE_CLIENT_ID</code> y <code>GOOGLE_CLIENT_SECRET</code>). El
      paso a paso completo está en el archivo <strong>README.md</strong>, en la
      sección "Conectar Gmail".
    </p>
    <div class="modal-acciones">
      <button class="boton-primario" onclick="cerrarModal()">Entendido</button>
    </div>
  `);
}

document.getElementById("btn-guardar-etiqueta").addEventListener("click", async () => {
  const etiqueta = document.getElementById("cfg-etiqueta-gmail").value.trim();
  if (!etiqueta) return;
  await api("/gmail/etiqueta", { method: "PUT", body: JSON.stringify({ etiqueta }) });
  cargarConfigGmail();
});

document.getElementById("btn-desconectar-gmail").addEventListener("click", async () => {
  if (confirm("¿Desconectar tu cuenta de Gmail? Vas a tener que autorizar de nuevo la próxima vez que sincronicés.")) {
    await api("/gmail/desconectar", { method: "POST" });
    cargarConfigGmail();
  }
});

document.getElementById("btn-conectar-gmail").addEventListener("click", () => {
  window.location.href = API + "/gmail/conectar";
});

async function cargarConfigGmail() {
  const estado = await api("/gmail/estado");
  document.getElementById("cfg-etiqueta-gmail").value = estado.etiqueta;
  const textoEstado = document.getElementById("cfg-gmail-estado-texto");
  const btnDesconectar = document.getElementById("btn-desconectar-gmail");
  const btnConectar = document.getElementById("btn-conectar-gmail");

  if (!estado.credenciales_configuradas) {
    textoEstado.textContent = "Credenciales no configuradas todavía en el servidor. Ver README.md.";
    btnDesconectar.style.display = "none";
    btnConectar.style.display = "none";
  } else if (!estado.sesion_activa) {
    textoEstado.textContent = "Credenciales listas. Conectá tu cuenta de Gmail para poder sincronizar.";
    btnDesconectar.style.display = "none";
    btnConectar.style.display = "inline-block";
  } else {
    textoEstado.textContent = `Conectado ✓ — última sincronización: ${estado.ultima_sincronizacion ? formatoFecha(estado.ultima_sincronizacion) : "nunca"}`;
    btnDesconectar.style.display = "inline-block";
    btnConectar.style.display = "none";
  }
}

// =====================================================================
// TAB CONFIG
// =====================================================================
async function cargarConfig() {
  cargarConfigGmail();
  const config = await api("/configuracion");
  document.getElementById("cfg-salario-total").value = config.salario_total || "";
  document.getElementById("cfg-salario-q1").value = config.salario_q1 || "";
  document.getElementById("cfg-salario-q2").value = config.salario_q2 || "";
  document.getElementById("cfg-salario-moneda").value = config.salario_moneda || "CRC";
  document.getElementById("cfg-dia-pago-q1").value = config.dia_pago_q1 || 15;
  document.getElementById("cfg-dia-pago-q2").value = config.dia_pago_q2 || 30;
  document.getElementById("cfg-tipo-cambio").value = config.tipo_cambio || 520;
  document.getElementById("cfg-moneda-visualizacion").value = config.moneda_visualizacion || "CRC";

  const objetivos = await api("/objetivos");
  const rubros = await api("/rubros-fijos");
  const contRubros = document.getElementById("lista-rubros-config");

  if (rubros.length === 0) {
    contRubros.innerHTML = `<div class="vacio">No hay rubros fijos todavía.</div>`;
  } else {
    contRubros.innerHTML = rubros.map((r) => {
      const objetivo = objetivos.find((o) => o.id === r.objetivo_id);
      return `
      <div class="fila-rubro-config">
        <div class="fila-rubro-config-top">
          <div class="fila-rubro-config-nombre">
            <strong>${r.nombre}</strong>
            ${objetivo ? `<span class="etiqueta-vinculo">→ ${objetivo.nombre}</span>` : ""}
            ${r.generado_de_objetivo ? `<span class="etiqueta-vinculo">auto</span>` : ""}
          </div>
          <span class="fila-rubro-config-pct">${r.porcentaje_salario}% del salario</span>
        </div>
        <div class="fila-rubro-config-bottom">
          <div class="fila-rubro-config-montos">
            <span>Q1 <strong>${formatoMonto(r.monto_q1, r.moneda)}</strong></span>
            <span>Q2 <strong>${formatoMonto(r.monto_q2, r.moneda)}</strong></span>
          </div>
          <div class="fila-rubro-config-acciones">
            <button class="boton-icono" data-mover-rubro="${r.id}" data-direccion="arriba" title="Mover arriba">↑</button>
            <button class="boton-icono" data-mover-rubro="${r.id}" data-direccion="abajo" title="Mover abajo">↓</button>
            <span class="separador-acciones"></span>
            <button class="boton-icono editar" data-editar-rubro="${r.id}" title="Editar">✎</button>
            <button class="boton-icono borrar" data-borrar-rubro="${r.id}" title="Eliminar">✕</button>
          </div>
        </div>
      </div>`;
    }).join("");

    contRubros.querySelectorAll("[data-mover-rubro]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = rubros.findIndex((x) => x.id == btn.dataset.moverRubro);
        const destino = btn.dataset.direccion === "arriba" ? idx - 1 : idx + 1;
        if (destino < 0 || destino >= rubros.length) return;
        const ids = rubros.map((r) => r.id);
        [ids[idx], ids[destino]] = [ids[destino], ids[idx]];
        await api("/rubros-fijos/reordenar", { method: "PUT", body: JSON.stringify({ ids }) });
        cargarConfig();
      });
    });

    contRubros.querySelectorAll("[data-editar-rubro]").forEach((btn) => {
      const r = rubros.find((x) => x.id == btn.dataset.editarRubro);
      btn.addEventListener("click", () => abrirModalRubro(r, objetivos));
    });
    contRubros.querySelectorAll("[data-borrar-rubro]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (confirm("¿Eliminar este rubro fijo?")) {
          await api(`/rubros-fijos/${btn.dataset.borrarRubro}`, { method: "DELETE" });
          cargarConfig();
        }
      });
    });
  }

  const CATEGORIAS_PROTEGIDAS = ["Ahorros", "Gastos fijos", "Deudas"];

  const contCats = document.getElementById("lista-categorias-config");
  const todasCategorias = await api("/categorias");
  categorias = todasCategorias;
  contCats.innerHTML = `<div class="grilla-categorias-config">${todasCategorias.map((c) => {
    const protegida = CATEGORIAS_PROTEGIDAS.includes(c.nombre);
    return `
    <div class="tarjeta-categoria-config">
      <div class="tarjeta-categoria-top">
        <span class="fila-categoria-punto" style="background:${c.color}"></span>
        <span class="tarjeta-categoria-nombre" title="${c.nombre.replace(/"/g, "&quot;")}">${c.nombre}</span>
        <div class="tarjeta-categoria-acciones">
          <button class="boton-icono editar" data-editar-cat="${c.id}" data-nombre="${c.nombre.replace(/"/g, "&quot;")}" data-color="${c.color}" title="Editar color">✎</button>
          <button class="boton-icono borrar" data-borrar-cat="${c.id}" data-nombre="${c.nombre.replace(/"/g, "&quot;")}" title="Eliminar" style="${protegida ? "visibility:hidden; pointer-events:none;" : ""}" ${protegida ? "tabindex=\"-1\"" : ""}>✕</button>
        </div>
      </div>
      <label class="tarjeta-categoria-presupuesto">
        Presupuesto mensual
        <input type="number" class="input-presupuesto-categoria" data-cat-id="${c.id}" value="${c.presupuesto_mensual || 0}" step="1" min="0">
      </label>
    </div>`;
  }).join("")}</div>`;

  contCats.querySelectorAll(".input-presupuesto-categoria").forEach((input) => {
    input.addEventListener("change", async () => {
      const presupuesto_mensual = parseFloat(input.value) || 0;
      await api(`/categorias/${input.dataset.catId}`, {
        method: "PUT",
        body: JSON.stringify({ presupuesto_mensual }),
      });
    });
  });

  contCats.querySelectorAll("[data-editar-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      abrirModalEditarCategoria(btn.dataset.editarCat, btn.dataset.nombre, btn.dataset.color, CATEGORIAS_PROTEGIDAS.includes(btn.dataset.nombre));
    });
  });

  contCats.querySelectorAll("[data-borrar-cat]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (confirm(`¿Eliminar la categoría "${btn.dataset.nombre}"? Las transacciones que tenía pasarán a "Otros".`)) {
        const res = await api(`/categorias/${btn.dataset.borrarCat}`, { method: "DELETE" });
        if (res && res.error) {
          alert(res.error);
          return;
        }
        cargarConfig();
      }
    });
  });
}

function abrirModalEditarCategoria(catId, nombreActual, colorActual, protegida) {
  abrirModal(`
    <h3>Editar categoría</h3>
    <label>Nombre</label>
    <input type="text" id="modal-nombre" value="${nombreActual}" ${protegida ? "readonly" : ""}>
    <label>Color</label>
    <input type="color" id="modal-color" value="${colorActual}">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Guardar cambios</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const nombre = document.getElementById("modal-nombre").value.trim();
    const color = document.getElementById("modal-color").value;
    if (!nombre) return;
    await api(`/categorias/${catId}`, { method: "PUT", body: JSON.stringify({ nombre, color }) });
    cerrarModal();
    cargarConfig();
  });
}

document.getElementById("form-salario").addEventListener("submit", async (e) => {
  e.preventDefault();
  const salario_total = parseFloat(document.getElementById("cfg-salario-total").value) || 0;
  const salario_q1 = parseFloat(document.getElementById("cfg-salario-q1").value) || 0;
  const salario_q2 = parseFloat(document.getElementById("cfg-salario-q2").value) || 0;
  const salario_moneda = document.getElementById("cfg-salario-moneda").value;
  const tipo_cambio = parseFloat(document.getElementById("cfg-tipo-cambio").value) || 0;
  const moneda_visualizacion = document.getElementById("cfg-moneda-visualizacion").value;
  const dia_pago_q1 = parseInt(document.getElementById("cfg-dia-pago-q1").value) || 15;
  const dia_pago_q2 = parseInt(document.getElementById("cfg-dia-pago-q2").value) || 30;
  await api("/configuracion", { method: "PUT", body: JSON.stringify({ salario_total, salario_q1, salario_q2, salario_moneda, tipo_cambio, moneda_visualizacion, dia_pago_q1, dia_pago_q2 }) });
  monedaVisualizacion = moneda_visualizacion;
  tipoCambioGlobal = tipo_cambio;
  alert("Salario actualizado");
});

document.getElementById("btn-nuevo-rubro").addEventListener("click", abrirModalNuevoRubro);

async function abrirModalNuevoRubro() {
  const objetivos = await api("/objetivos");
  abrirModalRubro(null, objetivos);
}

function abrirModalRubro(rubro, objetivos) {
  const esEdicion = !!rubro;
  abrirModal(`
    <h3>${esEdicion ? "Editar" : "Nuevo"} rubro fijo</h3>
    <label>Nombre</label>
    <input type="text" id="modal-nombre" value="${rubro ? rubro.nombre : ""}" placeholder="Ej. Pago teléfono">
    <label>Monto total mensual</label>
    <input type="number" id="modal-monto-total" value="${rubro ? rubro.monto_q1 + rubro.monto_q2 : ""}" step="1" min="0">
    <label class="modal-check">
      <input type="checkbox" id="modal-dividir-quincenas" ${rubro && rubro.monto_q2 > 0 ? "checked" : ""}>
      Dividir el monto en dos quincenas iguales
    </label>
    <label>Moneda</label>
    <select id="modal-moneda">
      <option value="CRC" ${!rubro || rubro.moneda === "CRC" ? "selected" : ""}>Colones (CRC)</option>
      <option value="USD" ${rubro && rubro.moneda === "USD" ? "selected" : ""}>Dólares (USD)</option>
    </select>
    <label>Vincular a objetivo de largo plazo (opcional)</label>
    <select id="modal-objetivo">
      <option value="">— Ninguno —</option>
      ${objetivos.map((o) => `<option value="${o.id}" ${rubro && rubro.objetivo_id === o.id ? "selected" : ""}>${o.nombre}</option>`).join("")}
    </select>
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">${esEdicion ? "Guardar cambios" : "Crear rubro"}</button>
    </div>
  `);

  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const nombre = document.getElementById("modal-nombre").value.trim();
    const monto_total = parseFloat(document.getElementById("modal-monto-total").value) || 0;
    const dividir_quincenas = document.getElementById("modal-dividir-quincenas").checked;
    let monto_q1, monto_q2;
    if (dividir_quincenas) {
      monto_q1 = Math.round(monto_total / 2);
      monto_q2 = monto_total - monto_q1;
    } else {
      monto_q1 = monto_total;
      monto_q2 = 0;
    }
    const moneda = document.getElementById("modal-moneda").value;
    const objetivoVal = document.getElementById("modal-objetivo").value;
    const objetivo_id = objetivoVal ? parseInt(objetivoVal) : null;
    if (!nombre || !monto_total) return;

    if (esEdicion) {
      await api(`/rubros-fijos/${rubro.id}`, { method: "PUT", body: JSON.stringify({ nombre, monto_q1, monto_q2, objetivo_id, moneda }) });
    } else {
      await api("/rubros-fijos", { method: "POST", body: JSON.stringify({ nombre, monto_q1, monto_q2, objetivo_id, moneda }) });
    }
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
}

document.getElementById("btn-nueva-categoria").addEventListener("click", () => {
  abrirModal(`
    <h3>Nueva categoría</h3>
    <label>Nombre</label>
    <input type="text" id="modal-nombre" placeholder="Ej. Mascotas">
    <label>Color</label>
    <input type="color" id="modal-color" value="#6B6862">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Crear categoría</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const nombre = document.getElementById("modal-nombre").value.trim();
    const color = document.getElementById("modal-color").value;
    if (!nombre) return;
    await api("/categorias", { method: "POST", body: JSON.stringify({ nombre, color }) });
    cerrarModal();
    cargarConfig();
  });
});

// =====================================================================
// Botón flotante de acciones rápidas
// =====================================================================
const fabContenedor = document.getElementById("fab-contenedor");
const fabMenu = document.getElementById("fab-menu");

document.getElementById("fab-boton").addEventListener("click", () => {
  fabContenedor.classList.toggle("abierto");
  fabMenu.classList.toggle("oculta");
});

function cerrarFabMenu() {
  fabContenedor.classList.remove("abierto");
  fabMenu.classList.add("oculta");
}

document.getElementById("fab-ingreso-extra").addEventListener("click", () => {
  cerrarFabMenu();
  abrirModalIngresoExtra();
});
document.getElementById("fab-gasto-manual").addEventListener("click", () => {
  cerrarFabMenu();
  abrirModalGastoManual();
});
document.getElementById("fab-aportar-ahorro").addEventListener("click", () => {
  cerrarFabMenu();
  abrirModalAportarRapido();
});
document.getElementById("fab-abonar-deuda").addEventListener("click", () => {
  cerrarFabMenu();
  abrirModalAbonarDeudaRapido();
});

function abrirModalIngresoExtra() {
  abrirModal(`
    <h3>Ingreso extraordinario</h3>
    <p class="modal-aviso">Plata aparte del salario: un trabajo extra, una venta, un regalo...</p>
    <label>Descripción</label>
    <input type="text" id="modal-descripcion" placeholder="Ej. Venta de bicicleta">
    <label>Monto</label>
    <input type="number" id="modal-monto" step="1" min="0">
    <label>Moneda</label>
    <select id="modal-moneda">
      <option value="CRC">Colones (CRC)</option>
      <option value="USD">Dólares (USD)</option>
    </select>
    <label>Fecha</label>
    <input type="date" id="modal-fecha" value="${new Date().toISOString().slice(0, 10)}">
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Agregar ingreso</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", async () => {
    const descripcion = document.getElementById("modal-descripcion").value.trim();
    const monto = parseFloat(document.getElementById("modal-monto").value);
    const moneda = document.getElementById("modal-moneda").value;
    const fecha = document.getElementById("modal-fecha").value + "T12:00:00";
    if (!descripcion || !monto) return;
    await api("/ingresos-extra", { method: "POST", body: JSON.stringify({ descripcion, monto, moneda, fecha }) });
    cerrarModal();
    cargarTabActiva(document.querySelector(".pestana.activa").dataset.tab);
  });
}

async function abrirModalAportarRapido() {
  const objetivos = await api("/objetivos");
  if (objetivos.length === 0) {
    alert("Todavía no tenés objetivos de largo plazo. Creá uno primero en la pestaña Ahorros.");
    return;
  }
  if (objetivos.length === 1) {
    abrirModalAporte(objetivos[0].id);
    return;
  }
  abrirModal(`
    <h3>¿A qué objetivo querés aportar?</h3>
    <label>Objetivo</label>
    <select id="modal-objetivo-rapido">
      ${objetivos.map((o) => `<option value="${o.id}">${o.nombre}</option>`).join("")}
    </select>
    <div class="modal-acciones">
      <button class="boton-secundario" onclick="cerrarModal()">Cancelar</button>
      <button class="boton-primario" id="modal-confirmar">Continuar</button>
    </div>
  `);
  document.getElementById("modal-confirmar").addEventListener("click", () => {
    const objetivoId = document.getElementById("modal-objetivo-rapido").value;
    abrirModalAporte(objetivoId);
  });
}

// =====================================================================
// Modal genérico
// =====================================================================
function abrirModal(html) {
  document.getElementById("modal-contenido").innerHTML = html;
  document.getElementById("modal-overlay").classList.remove("oculta");
}
function cerrarModal() {
  document.getElementById("modal-overlay").classList.add("oculta");
}
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") cerrarModal();
});

// ===== Inicio =====
verificarSesion();
