import { firebaseConfig, emailjsConfig } from "./firebase-config.js";
import { initApp as initDrive, buscarEnDrive, cargarTodosLosInformes } from "./drive.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  getDocs, getDoc, query, orderBy, setDoc, where, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

if (window.emailjs && emailjsConfigCompleta()) {
  window.emailjs.init({ publicKey: emailjsConfig.publicKey });
}

let usuarioActual = null; // { uid, nombre, rol, email }
let cacheAlumnos = [];    // se recarga al entrar a cada vista que la necesita
let cacheLugares = [];    // catálogo de lugares para el combo desplegable de "Lugar"
let practicaOrigenAlumnoId = null; // si no es null, el formulario de práctica se abrió desde la ficha de ese alumno
let ultimosAlumnosFiltrados = [];  // para exportar lo que se ve en pantalla
let ultimasPracticasFiltradas = [];
let acumuladosPracticas = {};
let ultimasFilasEstadisticas = [];
let ultimosResumenPracticas = []; // grupos calculados por cargarResumenPracticas, para abrir el detalle sin volver a pedirle todo a Firestore
let ultimosArchivosDrive = []; // últimos resultados de la tabla "Buscar en Drive", para saber qué archivos quedaron tildados
let filasRegistrarDrive = []; // filas del modal "Registrar informes desde Drive", con el archivo original de cada una
let ultimosGruposDuplicados = null; // { grupos, practicas, asistencias, faltas } calculado por cargarDuplicados, para que window.fusionarGrupo no tenga que volver a pedirle todo a Firestore

// ---------------------------------------------------------- helpers UI ---
function mostrarAlerta(mensaje, tipo = "success") {
  const cont = document.getElementById("alertas");
  const div = document.createElement("div");
  div.className = `alert alert-${tipo} alert-dismissible fade show`;
  div.textContent = mensaje;
  const cerrar = document.createElement("button");
  cerrar.type = "button"; cerrar.className = "btn-close";
  cerrar.setAttribute("data-bs-dismiss", "alert");
  div.appendChild(cerrar);
  cont.appendChild(div);
  setTimeout(() => div.remove(), 6000);
}

function fmtFecha(iso) {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Muestra el rango de fechas de una práctica. Si no tiene fecha de fin
// cargada (o es igual a la de inicio), se muestra un solo día.
function fmtRangoFechas(p) {
  if (!p?.fecha) return "-";
  const fin = p.fechaFin || p.fecha;
  if (!fin || fin === p.fecha) return fmtFecha(p.fecha);
  return `${fmtFecha(p.fecha)} → ${fmtFecha(fin)}`;
}

// Exporta una lista de filas (array de arrays) con encabezados a un .xlsx,
// reutilizado por los botones "Exportar" de Alumnos, Prácticas y Estadísticas.
function exportarXLSX(nombreArchivo, nombreHoja, encabezados, filas) {
  return exportarLibro(nombreArchivo, [{ nombre: nombreHoja, encabezados, filas }]);
}

// Devuelve la fecha de HOY en formato AAAA-MM-DD usando la hora LOCAL del
// navegador. Ojo: "new Date().toISOString()" convierte a UTC, y en
// Argentina (UTC-3) eso hace que entre las 21:00 y las 23:59 la fecha de
// "hoy" ya aparezca como la de mañana (bug de "fecha que no carga bien").
function hoyISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dia}`;
}

// Suma/resta días a una fecha AAAA-MM-DD sin pasar por UTC (mismo motivo que hoyISO).
function sumarDiasISO(fechaISO, dias) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + dias);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// Cantidad de días de calendario entre fecha y fechaFin, ambos incluidos.
// Si no hay fechaFin (o es igual a fecha) es una práctica de un solo día.
function diasEntreISO(fechaISO, fechaFinISO) {
  const [y1, m1, d1] = fechaISO.split("-").map(Number);
  const [y2, m2, d2] = (fechaFinISO || fechaISO).split("-").map(Number);
  const ini = new Date(y1, m1 - 1, d1);
  const fin = new Date(y2, m2 - 1, d2);
  return Math.round((fin - ini) / 86400000) + 1;
}

// Calcula las horas totales de una práctica PENDIENTE a partir de:
// - horasPorDia: cuántas horas debe cumplir el alumno cada día de práctica.
// - diasPorSemana: cantidad de días a la semana que concurre.
// - el rango de fechas (fechaISO -> fechaFinISO).
// Si la práctica es de un solo día, se cuenta directamente ese día (no tiene
// sentido prorratear por semana un único evento puntual). Si abarca un rango,
// se estima la cantidad de días de práctica como (días del rango / 7) *
// días por semana, y se multiplica por las horas de cada día.
// Las prácticas YA REALIZADAS no usan esta función: su total se carga a mano
// o se importa directamente (ver determinarRealizada / import).
function fechasProgramadas(fechaISO, fechaFinISO, diasSemana = []) {
  if (!fechaISO) return [];
  const finISO = fechaFinISO || fechaISO;
  const [yi, mi, di] = fechaISO.split("-").map(Number);
  const [yf, mf, df] = finISO.split("-").map(Number);
  const actual = new Date(yi, mi - 1, di);
  const fin = new Date(yf, mf - 1, df);
  const seleccionados = new Set((diasSemana || []).map(Number));
  const resultado = [];
  while (actual <= fin) {
    if (!seleccionados.size || seleccionados.has(actual.getDay())) {
      resultado.push(`${actual.getFullYear()}-${String(actual.getMonth() + 1).padStart(2, "0")}-${String(actual.getDate()).padStart(2, "0")}`);
    }
    actual.setDate(actual.getDate() + 1);
  }
  return resultado;
}

function calcularHorasTotalesAutomatico(fechaISO, fechaFinISO, horasPorDia, diasPorSemana, diasSemana = []) {
  if (!fechaISO || !horasPorDia) return 0;
  if (diasSemana?.length) return +(fechasProgramadas(fechaISO, fechaFinISO, diasSemana).length * horasPorDia).toFixed(2);
  const dias = diasEntreISO(fechaISO, fechaFinISO);
  if (!Number.isFinite(dias) || dias < 1) return 0;
  if (dias <= 1) return +horasPorDia.toFixed(2);
  const diasSemana = Math.min(7, Math.max(1, diasPorSemana || 5));
  const diasDePractica = Math.max(1, Math.round((dias / 7) * diasSemana));
  return +(diasDePractica * horasPorDia).toFixed(2);
}

// Tipos de práctica soportados y su color/etiqueta de referencia (se usa en
// todas las tablas y en Estadísticas para distinguirlos de un vistazo).
const TIPOS_PRACTICA = {
  interna: { label: "Interna", clase: "badge-tipo-interna" },
  externa: { label: "Externa", clase: "badge-tipo-externa" },
  interescolar: { label: "Interescolar", clase: "badge-tipo-interescolar" },
};
function infoTipo(tipo) {
  return TIPOS_PRACTICA[tipo] || TIPOS_PRACTICA.interna;
}
function badgeTipo(tipo) {
  const info = infoTipo(tipo);
  return `<span class="badge ${info.clase}">${info.label}</span>`;
}

const ESTADOS_ASISTENCIA = {
  presente: "Presente",
  tardanza: "Tardanza",
  ausente_justificado: "Ausente justificado",
  ausente_injustificado: "Ausente injustificado",
  reprogramado: "Día reprogramado",
};
const DIAS_SEMANA = { 0: "Dom", 1: "Lun", 2: "Mar", 3: "Mié", 4: "Jue", 5: "Vie", 6: "Sáb" };
const DASHBOARD_WIDGETS_DEFAULT = ["resumen", "horasSector", "proximas", "enCurso"];

function escaparHTML(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function estadoPractica(p) {
  if (p?.estado) return p.estado;
  return p?.realizada === false ? "programada" : "realizada";
}
function practicaRealizada(p) { return estadoPractica(p) === "realizada"; }
function diasSeleccionadosFormulario() {
  return [...document.querySelectorAll("#practica-dias-selector input:checked")].map(x => Number(x.value)).sort((a, b) => a - b);
}
function marcarDiasFormulario(dias = []) {
  const elegidos = new Set((dias || []).map(Number));
  document.querySelectorAll("#practica-dias-selector input").forEach(x => { x.checked = elegidos.has(Number(x.value)); });
  document.getElementById("practica-dias-semana").value = elegidos.size || 0;
}

async function obtenerConfigDashboard() {
  try {
    const snap = await getDoc(doc(db, "configuracion", "dashboard"));
    return snap.exists() && Array.isArray(snap.data().widgets) ? snap.data().widgets : DASHBOARD_WIDGETS_DEFAULT;
  } catch (_) { return DASHBOARD_WIDGETS_DEFAULT; }
}
async function aplicarConfigDashboard() {
  const visibles = new Set(await obtenerConfigDashboard());
  document.querySelectorAll("[data-dashboard-widget]").forEach(el => el.classList.toggle("oculto-config", !visibles.has(el.dataset.dashboardWidget)));
}
async function cargarConfiguracion() {
  const visibles = new Set(await obtenerConfigDashboard());
  document.querySelectorAll("#config-dashboard-widgets input").forEach(x => { x.checked = visibles.has(x.value); });
}

function abrirModal(id) {
  bootstrap.Modal.getOrCreateInstance(document.getElementById(id)).show();
}
function cerrarModal(id) {
  bootstrap.Modal.getInstance(document.getElementById(id))?.hide();
}

function mostrarVista(nombre) {
  document.querySelectorAll(".vista").forEach(v => v.classList.remove("activa"));
  document.getElementById(`vista-${nombre}`).classList.add("activa");
  document.querySelectorAll("[data-view]").forEach(a => a.classList.remove("active"));
  document.querySelector(`[data-view="${nombre}"]`)?.classList.add("active");
  cargarVista(nombre);
}

function cargarVista(nombre) {
  const cargadores = {
    dashboard: cargarDashboard,
    estadisticas: cargarEstadisticas,
    alumnos: cargarAlumnos,
    practicas: () => cargarPracticas(),
    informes: cargarInformes,
    resumen: cargarResumenPracticas,
    faltas: cargarFaltas,
    asistencia: cargarAsistencia,
    notificaciones: cargarNotificaciones,
    usuarios: cargarUsuarios,
    drive: () => {},
    importar: () => {},
    duplicados: cargarDuplicados,
    configuracion: cargarConfiguracion,
  };
  Promise.resolve().then(() => cargadores[nombre]?.()).catch(err => mostrarAlerta(`No se pudo cargar la vista: ${err.message || err}`, "danger"));
}

document.querySelectorAll("[data-view]").forEach(a => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    mostrarVista(a.dataset.view);
  });
});

// ------------------------------------------------------------------ AUTH -
document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errBox = document.getElementById("login-error");
  errBox.classList.add("d-none");
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errBox.textContent = "No se pudo iniciar sesión. Revisá el email y la contraseña.";
    errBox.classList.remove("d-none");
  }
});

document.getElementById("btn-logout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (user) {
    let perfil = { nombre: user.email, rol: "tutor" };
    try {
      const snap = await getDoc(doc(db, "usuarios", user.uid));
      if (snap.exists()) perfil = snap.data();
    } catch (e) { /* si todavía no existe el doc de perfil, seguimos con default */ }

    usuarioActual = { uid: user.uid, email: user.email, ...perfil };
    document.getElementById("usuario-actual").textContent = `${usuarioActual.nombre} (${usuarioActual.rol})`;
    document.querySelectorAll(".admin-only").forEach(el => {
      el.classList.toggle("d-none", usuarioActual.rol !== "admin");
    });

    document.getElementById("login-view").classList.add("d-none");
    document.getElementById("app-shell").classList.remove("d-none");
    mostrarVista("dashboard");
    await obtenerLugares();
    poblarDatalistLugares();
    await sincronizarAsistenciasAutomaticas();
    revisarYEnviarNotificacionesAutomaticas();
  } else {
    usuarioActual = null;
    cacheAlumnos = []; cacheLugares = [];
    ultimosAlumnosFiltrados = []; ultimasPracticasFiltradas = [];
    ultimasFilasEstadisticas = []; ultimosResumenPracticas = [];
    document.getElementById("app-shell").classList.add("d-none");
    document.getElementById("login-view").classList.remove("d-none");
  }
});

document.getElementById("btn-guardar-config-dashboard")?.addEventListener("click", async () => {
  const widgets = [...document.querySelectorAll("#config-dashboard-widgets input:checked")].map(x => x.value);
  await setDoc(doc(db, "configuracion", "dashboard"), { widgets, actualizado: new Date().toISOString() });
  await aplicarConfigDashboard();
  mostrarAlerta("Configuración del dashboard guardada.");
});

// -------------------------------------------------------------- LUGARES -
// Catálogo de lugares de práctica. Se arma solo: cada vez que se carga una
// práctica nueva (a mano o por importación) o un registro de asistencia con
// un lugar que todavía no está en la lista, se agrega acá. El campo "Lugar"
// del formulario sigue siendo de texto libre (con sugerencias) para poder
// escribir uno nuevo la primera vez.
async function obtenerLugares(forzar = false) {
  if (cacheLugares.length && !forzar) return cacheLugares;
  const snap = await getDocs(query(collection(db, "lugares"), orderBy("nombre")));
  cacheLugares = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return cacheLugares;
}

function poblarDatalistLugares() {
  const datalist = document.getElementById("lugares-list");
  if (!datalist) return;
  datalist.innerHTML = cacheLugares.map(l => `<option value="${l.nombre}">`).join("");
}

// Da de alta un lugar en el catálogo si todavía no existe (comparación sin
// importar mayúsculas/espacios). No hace nada si el nombre viene vacío.
async function registrarLugarSiNuevo(nombre) {
  const limpio = (nombre || "").trim();
  if (!limpio) return;
  await obtenerLugares();
  const yaExiste = cacheLugares.some(l => l.nombre.trim().toLowerCase() === limpio.toLowerCase());
  if (yaExiste) return;
  const ref = await addDoc(collection(db, "lugares"), { nombre: limpio });
  cacheLugares.push({ id: ref.id, nombre: limpio });
  cacheLugares.sort((a, b) => a.nombre.localeCompare(b.nombre));
  poblarDatalistLugares();
}

// Versión para dar de alta varios lugares de una sola vez (por ejemplo, al
// confirmar una importación con muchas filas), evitando pedir el catálogo
// entero una vez por cada fila.
async function registrarLugaresSiNuevos(nombres) {
  await obtenerLugares();
  const existentes = new Set(cacheLugares.map(l => l.nombre.trim().toLowerCase()));
  const vistos = new Set();
  const nuevos = [];
  for (const nombre of nombres) {
    const limpio = (nombre || "").trim();
    if (!limpio) continue;
    const clave = limpio.toLowerCase();
    if (existentes.has(clave) || vistos.has(clave)) continue;
    vistos.add(clave);
    nuevos.push(limpio);
  }
  if (!nuevos.length) return;
  await Promise.all(nuevos.map(async (nombre) => {
    const ref = await addDoc(collection(db, "lugares"), { nombre });
    cacheLugares.push({ id: ref.id, nombre });
  }));
  cacheLugares.sort((a, b) => a.nombre.localeCompare(b.nombre));
  poblarDatalistLugares();
}

// --------------------------------------------------------------- ALUMNOS -
async function obtenerAlumnos(forzar = false) {
  if (cacheAlumnos.length && !forzar) return cacheAlumnos;
  const snap = await getDocs(query(collection(db, "alumnos"), orderBy("apellido")));
  cacheAlumnos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return cacheAlumnos;
}

function nombreCompleto(a) {
  return `${a.apellido}, ${a.nombre}`;
}

async function llenarSelectAlumnos(selectEl, seleccionadoId = null) {
  const alumnos = await obtenerAlumnos();
  selectEl.innerHTML = alumnos.map(a =>
    `<option value="${a.id}" ${a.id === seleccionadoId ? "selected" : ""}>${nombreCompleto(a)} (${a.legajo})</option>`
  ).join("");
}

async function cargarAlumnos() {
  const alumnos = await obtenerAlumnos(true);
  const fTexto = document.getElementById("alumno-filtro-texto").value.trim().toLowerCase();
  const fCurso = document.getElementById("alumno-filtro-curso").value.trim().toLowerCase();

  const filtrados = alumnos.filter(a => {
    if (fTexto && !(`${nombreCompleto(a)} ${a.legajo} ${a.sector || ""}`.toLowerCase().includes(fTexto))) return false;
    if (fCurso && !(a.curso || "").toLowerCase().includes(fCurso)) return false;
    return true;
  });
  ultimosAlumnosFiltrados = filtrados;

  const chkTodos = document.getElementById("chk-todos-alumnos");
  if (chkTodos) chkTodos.checked = false;

  document.getElementById("tabla-alumnos").innerHTML = filtrados.map(a => `
    <tr>
      <td><input type="checkbox" class="chk-alumno" value="${a.id}"></td>
      <td>${a.legajo}</td><td>${nombreCompleto(a)}</td><td>${a.curso || ""}</td><td>${a.sector || ""}</td><td>${a.email || ""}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary" onclick="window.editarAlumno('${a.id}')">Ficha / Editar</button>
        <button class="btn btn-sm btn-outline-danger" onclick="window.eliminarAlumno('${a.id}')">Eliminar</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="7" class="text-muted">No hay alumnos cargados.</td></tr>`;
}

document.getElementById("chk-todos-alumnos")?.addEventListener("change", (e) => {
  document.querySelectorAll(".chk-alumno").forEach(c => c.checked = e.target.checked);
});

document.getElementById("btn-eliminar-alumnos-masivo")?.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".chk-alumno:checked")].map(c => c.value);
  if (!ids.length) { mostrarAlerta("Seleccioná al menos un alumno.", "warning"); return; }
  const confirmacion = confirm(
    `¿Eliminar ${ids.length} alumno(s) seleccionado(s)? También se borran sus prácticas, faltas y ` +
    `registros de asistencia. Esta acción no se puede deshacer.`
  );
  if (!confirmacion) return;

  const [practicas, snapFaltas, snapAsist] = await Promise.all([
    obtenerPracticas(),
    getDocs(query(collection(db, "faltas"))),
    getDocs(query(collection(db, "asistencias"))),
  ]);
  const idsSet = new Set(ids);

  await Promise.all(practicas.filter(p => idsSet.has(p.alumnoId)).map(p => deleteDoc(doc(db, "practicas", p.id))));
  await Promise.all(snapFaltas.docs.filter(d => idsSet.has(d.data().alumnoId)).map(d => deleteDoc(d.ref)));
  await Promise.all(snapAsist.docs.filter(d => idsSet.has(d.data().alumnoId)).map(d => deleteDoc(d.ref)));
  await Promise.all(ids.map(id => deleteDoc(doc(db, "alumnos", id))));

  mostrarAlerta(`${ids.length} alumno(s) y sus registros asociados fueron eliminados.`);
  cacheAlumnos = [];
  cargarAlumnos();
});

document.getElementById("btn-exportar-alumnos")?.addEventListener("click", () => {
  if (!ultimosAlumnosFiltrados.length) { mostrarAlerta("No hay alumnos para exportar.", "warning"); return; }
  const encabezados = ["Legajo", "Apellido", "Nombre", "Curso / división", "Sector / carrera", "Email"];
  const filas = ultimosAlumnosFiltrados.map(a => [a.legajo, a.apellido, a.nombre, a.curso || "", a.sector || "", a.email || ""]);
  exportarXLSX("alumnos.xlsx", "Alumnos", encabezados, filas);
});

document.getElementById("alumno-filtro-texto").addEventListener("input", cargarAlumnos);
document.getElementById("alumno-filtro-curso").addEventListener("input", cargarAlumnos);

document.getElementById("btn-nuevo-alumno").addEventListener("click", () => {
  document.getElementById("form-alumno").reset();
  document.getElementById("alumno-id").value = "";
  document.getElementById("modal-alumno-titulo").textContent = "Nuevo alumno";
  document.getElementById("alumno-practicas-wrap").classList.add("d-none");
  document.getElementById("btn-eliminar-alumno").classList.add("d-none");
  abrirModal("modal-alumno");
});

async function cargarPracticasDeAlumnoEnFicha(alumnoId) {
  const [practicas, snapAsistencias] = await Promise.all([obtenerPracticas(), getDocs(collection(db, "asistencias"))]);
  const asistencias = snapAsistencias.docs.map(d => d.data()).filter(r => r.alumnoId === alumnoId);
  const propias = practicas.filter(p => p.alumnoId === alumnoId).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const realizadas = propias.filter(practicaRealizada);
  const horas = realizadas.reduce((t, p) => t + numeroHoras(p.horasTotales), 0);
  const presentes = asistencias.filter(r => ["presente", "tardanza"].includes(r.estado || (r.presente ? "presente" : "ausente_injustificado"))).length;
  document.getElementById("alumno-seguimiento").innerHTML = `<strong>Seguimiento:</strong> ${realizadas.length} práctica(s) realizada(s), ${horas.toFixed(1)} horas contabilizadas y ${presentes}/${asistencias.length} jornadas con asistencia.`;
  document.getElementById("tabla-alumno-practicas").innerHTML = propias.map(p => `
    <tr>
      <td>${fmtRangoFechas(p)}</td><td>${p.lugar}</td>
      <td>${String(p.sector || "Sin especificar").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]))}</td>
      <td>${badgeTipo(p.tipo)}</td>
      <td><span class="badge bg-${practicaRealizada(p) ? "success" : "secondary"}">${estadoPractica(p).replace("_", " ")}</span></td>
      <td>${asistencias.filter(r => r.practicaId === p.id && ["presente", "tardanza"].includes(r.estado || (r.presente ? "presente" : "ausente_injustificado"))).length}/${asistencias.filter(r => r.practicaId === p.id).length}</td>
      <td>${p.horasTotales}</td>
      <td>
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="window.editarPractica('${p.id}', true)">Editar</button>
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="window.eliminarPractica('${p.id}', true)">Eliminar</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="8" class="text-muted">Este alumno todavía no tiene prácticas cargadas.</td></tr>`;
}

window.editarAlumno = async (id) => {
  const alumnos = await obtenerAlumnos();
  const a = alumnos.find(x => x.id === id);
  document.getElementById("alumno-id").value = a.id;
  document.getElementById("alumno-legajo").value = a.legajo;
  document.getElementById("alumno-nombre").value = a.nombre;
  document.getElementById("alumno-apellido").value = a.apellido;
  document.getElementById("alumno-email").value = a.email || "";
  document.getElementById("alumno-sector").value = a.sector || "";
  document.getElementById("alumno-curso").value = a.curso || "";
  document.getElementById("modal-alumno-titulo").textContent = `Ficha de ${nombreCompleto(a)}`;
  document.getElementById("alumno-practicas-wrap").classList.remove("d-none");
  document.getElementById("btn-eliminar-alumno").classList.remove("d-none");
  await cargarPracticasDeAlumnoEnFicha(a.id);
  abrirModal("modal-alumno");
};

window.eliminarAlumno = async (id) => {
  const alumnos = await obtenerAlumnos();
  const a = alumnos.find(x => x.id === id);
  if (!a) return;
  const practicas = (await obtenerPracticas()).filter(p => p.alumnoId === id);
  const confirmacion = confirm(
    `¿Eliminar a ${nombreCompleto(a)}? Esto también borra sus ${practicas.length} práctica(s), ` +
    `sus faltas y sus registros de asistencia. Esta acción no se puede deshacer.`
  );
  if (!confirmacion) return;

  await Promise.all(practicas.map(p => deleteDoc(doc(db, "practicas", p.id))));

  const [snapFaltas, snapAsist] = await Promise.all([
    getDocs(query(collection(db, "faltas"))),
    getDocs(query(collection(db, "asistencias"))),
  ]);
  await Promise.all(snapFaltas.docs.filter(d => d.data().alumnoId === id).map(d => deleteDoc(d.ref)));
  await Promise.all(snapAsist.docs.filter(d => d.data().alumnoId === id).map(d => deleteDoc(d.ref)));

  await deleteDoc(doc(db, "alumnos", id));
  cerrarModal("modal-alumno");
  mostrarAlerta("Alumno y sus registros asociados fueron eliminados.");
  cargarAlumnos();
};

document.getElementById("btn-eliminar-alumno").addEventListener("click", () => {
  const id = document.getElementById("alumno-id").value;
  if (id) window.eliminarAlumno(id);
});

document.getElementById("btn-alumno-nueva-practica").addEventListener("click", async () => {
  const alumnoId = document.getElementById("alumno-id").value;
  if (!alumnoId) return;
  practicaOrigenAlumnoId = alumnoId;
  cerrarModal("modal-alumno");
  document.getElementById("form-practica").reset();
  document.getElementById("practica-id").value = "";
  document.getElementById("practica-estado").value = "programada";
  marcarDiasFormulario([1, 2, 3, 4, 5]);
  await llenarSelectAlumnos(document.getElementById("practica-alumno"), alumnoId);
  actualizarPreviewHorasTotales();
  abrirModal("modal-practica");
});

document.getElementById("form-alumno").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("alumno-id").value;
  const datos = {
    legajo: document.getElementById("alumno-legajo").value.trim(),
    nombre: document.getElementById("alumno-nombre").value.trim(),
    apellido: document.getElementById("alumno-apellido").value.trim(),
    email: document.getElementById("alumno-email").value.trim(),
    sector: document.getElementById("alumno-sector").value.trim(),
    curso: document.getElementById("alumno-curso").value.trim(),
  };

  if (!datos.legajo) { mostrarAlerta("El legajo/DNI es obligatorio.", "warning"); return; }
  const idDesdeLegajo = idAlumnoDesdeLegajo(datos.legajo);
  if (!idDesdeLegajo) { mostrarAlerta("El legajo/DNI ingresado no es válido.", "warning"); return; }

  // Antes de crear o renombrar, nos fijamos si YA existe otro alumno con
  // este mismo legajo (con cualquier id, viejo o nuevo). Si existe, hay que
  // actualizar ESE registro en vez de crear uno nuevo: así nunca se duplica
  // un alumno aunque el formulario se haya usado dos veces por error.
  const alumnos = await obtenerAlumnos(true);
  const existentePorLegajo = alumnos.find(
    a => a.id !== id && normalizarLegajo(a.legajo) === normalizarLegajo(datos.legajo)
  );

  if (existentePorLegajo) {
    const seguir = confirm(
      `Ya existe un alumno con legajo "${datos.legajo}" (${nombreCompleto(existentePorLegajo)}). ` +
      `Se van a actualizar sus datos en ese registro en lugar de crear uno nuevo. ¿Continuás?`
    );
    if (!seguir) return;
    await updateDoc(doc(db, "alumnos", existentePorLegajo.id), datos);
  } else if (id) {
    await updateDoc(doc(db, "alumnos", id), datos);
  } else {
    // Alumno nuevo: se guarda con id = legajo/DNI normalizado, así una
    // futura alta o importación con el mismo legajo cae siempre en este
    // mismo documento en vez de crear un duplicado.
    await setDoc(doc(db, "alumnos", idDesdeLegajo), datos, { merge: true });
  }

  cerrarModal("modal-alumno");
  mostrarAlerta("Alumno guardado.");
  cacheAlumnos = [];
  cargarAlumnos();
});

// ------------------------------------------------------------- PRACTICAS -
async function obtenerPracticas() {
  const alumnos = await obtenerAlumnos();
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const snap = await getDocs(query(collection(db, "practicas"), orderBy("fecha", "desc")));
  return snap.docs.map(d => ({ id: d.id, ...d.data(), alumno: mapaAlumnos[d.data().alumnoId] }));
}

async function cargarPracticas() {
  const todasLasPracticas = await obtenerPracticas();

  // Acumulados por alumno (sobre TODAS sus prácticas, no solo las filtradas),
  // para mostrar en la tabla cuánto lleva realizado/total cada alumno además
  // de las horas puntuales del día de esa fila.
  const acumPorAlumno = {};
  todasLasPracticas.forEach(p => {
    if (!p.alumnoId) return;
    if (!acumPorAlumno[p.alumnoId]) acumPorAlumno[p.alumnoId] = { totalHoras: 0, horasRealizadas: 0 };
    const horas = numeroHoras(p.horasTotales);
    acumPorAlumno[p.alumnoId].totalHoras += horas;
    if (practicaRealizada(p)) acumPorAlumno[p.alumnoId].horasRealizadas += horas;
  });

  let practicas = todasLasPracticas;

  const fAlumno = document.getElementById("f-alumno").value.trim().toLowerCase();
  const fLugar = document.getElementById("f-lugar").value.trim().toLowerCase();
  const fTutor = document.getElementById("f-tutor").value.trim().toLowerCase();
  const fSector = document.getElementById("f-sector").value.trim().toLowerCase();
  const fDesde = document.getElementById("f-desde").value;
  const fHasta = document.getElementById("f-hasta").value;

  practicas = practicas.filter(p => {
    if (!p.alumno) return false;
    if (fAlumno && !(`${p.alumno.nombre} ${p.alumno.apellido} ${p.alumno.legajo}`.toLowerCase().includes(fAlumno))) return false;
    if (fLugar && !p.lugar?.toLowerCase().includes(fLugar)) return false;
    if (fTutor && !p.tutorResponsable?.toLowerCase().includes(fTutor)) return false;
    if (fSector && !p.sector?.toLowerCase().includes(fSector)) return false;
    // Se compara por superposición de rango: la práctica entra si su fecha fin
    // no es anterior al "desde" buscado, y su fecha inicio no es posterior al "hasta".
    const finPractica = p.fechaFin || p.fecha;
    if (fDesde && finPractica < fDesde) return false;
    if (fHasta && p.fecha > fHasta) return false;
    return true;
  });

  acumuladosPracticas = acumPorAlumno;
  ultimasPracticasFiltradas = practicas;

  const chkTodas = document.getElementById("chk-todas-practicas");
  if (chkTodas) chkTodas.checked = false;

  document.getElementById("tabla-practicas").innerHTML = practicas.map(p => {
    const acum = acumPorAlumno[p.alumnoId] || { totalHoras: 0, horasRealizadas: 0 };
    const pendiente = !practicaRealizada(p);
    // Compatibilidad con prácticas cargadas antes de que existiera "horasPorDia":
    // en ese esquema viejo, "horasTotales" ya representaba la carga diaria.
    const horasPorDia = p.horasPorDia ?? p.horasTotales ?? 0;
    const diasPorSemana = p.diasPorSemana ?? 5;
    return `
    <tr>
      <td><input type="checkbox" class="chk-practica" value="${p.id}"></td>
      <td>${fmtRangoFechas(p)}</td><td>${p.alumno ? nombreCompleto(p.alumno) : "-"}</td>
      <td>${p.lugar}</td>
      <td>${badgeTipo(p.tipo)}</td>
      <td><span class="badge bg-${practicaRealizada(p) ? "success" : estadoPractica(p) === "en_curso" ? "primary" : estadoPractica(p) === "cancelada" ? "danger" : "secondary"}">${({programada:"Programada",en_curso:"En curso",realizada:"Realizada",cancelada:"Cancelada"})[estadoPractica(p)]}</span></td>
      <td>${p.sector || ""}</td>
      <td>${p.horaInicio || ""} - ${p.horaFin || ""}</td>
      <td>
        <input type="number" step="0.5" min="0" class="form-control form-control-sm" style="width:80px"
          value="${horasPorDia}" title="Horas que debe cumplir el alumno cada día de práctica"
          onchange="window.actualizarHorasPorDia('${p.id}', this.value)">
      </td>
      <td>
        <input type="number" step="1" min="1" max="7" class="form-control form-control-sm" style="width:70px"
          value="${diasPorSemana}" title="Días por semana que concurre"
          onchange="window.actualizarDiasSemana('${p.id}', this.value)">
      </td>
      <td>
        ${pendiente
          ? `<span title="Calculado solo a partir de horas x día, días/sem y el rango de fechas">${(numeroHoras(p.horasTotales)).toFixed(1)}</span>`
          : `<input type="number" step="0.5" min="0" class="form-control form-control-sm" style="width:90px"
              value="${numeroHoras(p.horasTotales)}" title="Horas totales reales de esta práctica"
              onchange="window.actualizarHorasTotalesReal('${p.id}', this.value)">`}
      </td>
      <td>${acum.horasRealizadas.toFixed(1)}</td>
      <td>${acum.totalHoras.toFixed(1)}</td>
      <td>${p.tutorResponsable || ""}</td><td>${p.contacto || ""}</td>
      <td><button class="btn btn-sm btn-outline-secondary" onclick="window.editarPractica('${p.id}')">Editar</button></td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="window.eliminarPractica('${p.id}')">Eliminar</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="17" class="text-muted">No se encontraron prácticas.</td></tr>`;
}

// Edición rápida de "horas x día" directamente desde la tabla, sin abrir el
// modal. Si la práctica está pendiente, recalcula las horas totales solas;
// si ya se realizó, solo guarda el dato de referencia (el total no se toca).
window.actualizarHorasPorDia = async (id, valor) => {
  const horasPorDia = Number(valor);
  if (!Number.isFinite(horasPorDia) || horasPorDia < 0 || horasPorDia > 24) { mostrarAlerta("Las horas diarias deben estar entre 0 y 24.", "warning"); return; }
  const p = ultimasPracticasFiltradas.find(x => x.id === id);
  const cambios = { horasPorDia };
  if (p && !practicaRealizada(p)) {
    cambios.horasTotales = calcularHorasTotalesAutomatico(p.fecha, p.fechaFin, horasPorDia, p.diasPorSemana ?? 5, p.diasSemana || []);
  }
  await updateDoc(doc(db, "practicas", id), cambios);
  mostrarAlerta("Horas x día actualizadas.");
  cargarPracticas();
};

// Edición rápida de "días por semana". Misma lógica: recalcula el total solo
// si la práctica sigue pendiente.
window.actualizarDiasSemana = async (id, valor) => {
  const diasPorSemana = Number(valor);
  if (!Number.isInteger(diasPorSemana) || diasPorSemana < 1 || diasPorSemana > 7) { mostrarAlerta("Ingresá entre 1 y 7 días enteros.", "warning"); return; }
  const p = ultimasPracticasFiltradas.find(x => x.id === id);
  const cambios = { diasPorSemana };
  if (p && !practicaRealizada(p)) {
    cambios.horasTotales = calcularHorasTotalesAutomatico(p.fecha, p.fechaFin, p.horasPorDia ?? p.horasTotales ?? 0, diasPorSemana, p.diasSemana || []);
  }
  await updateDoc(doc(db, "practicas", id), cambios);
  mostrarAlerta("Días por semana actualizados.");
  cargarPracticas();
};

// Edición rápida de "horas totales" para prácticas YA REALIZADAS: acá el
// valor se carga a mano (o vino de una importación) y no se recalcula solo.
window.actualizarHorasTotalesReal = async (id, valor) => {
  const horasTotales = Number(valor);
  if (!Number.isFinite(horasTotales) || horasTotales < 0) { mostrarAlerta("Ingresá horas totales válidas, mayores o iguales a cero.", "warning"); return; }
  await updateDoc(doc(db, "practicas", id), { horasTotales });
  mostrarAlerta("Horas totales actualizadas.");
  cargarPracticas();
};

document.getElementById("chk-todas-practicas")?.addEventListener("change", (e) => {
  document.querySelectorAll(".chk-practica").forEach(c => c.checked = e.target.checked);
});

document.getElementById("btn-eliminar-practicas-masivo")?.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".chk-practica:checked")].map(c => c.value);
  if (!ids.length) { mostrarAlerta("Seleccioná al menos una práctica.", "warning"); return; }
  if (!confirm(`¿Eliminar ${ids.length} práctica(s) seleccionada(s)? Esta acción no se puede deshacer.`)) return;
  await Promise.all(ids.map(id => deleteDoc(doc(db, "practicas", id))));
  mostrarAlerta(`${ids.length} práctica(s) eliminada(s).`);
  cargarPracticas();
});

document.getElementById("btn-exportar-practicas")?.addEventListener("click", () => {
  if (!ultimasPracticasFiltradas.length) { mostrarAlerta("No hay prácticas para exportar.", "warning"); return; }
  const encabezados = ["Fecha inicio", "Fecha fin", "Alumno", "Legajo", "Lugar", "Tipo", "Estado", "Sector",
    "Hora entrada", "Hora salida", "Horas x día", "Días por semana", "Horas totales (práctica)",
    "Horas realizadas (alumno)", "Horas totales (alumno)", "Tutor", "Contacto"];
  const filas = ultimasPracticasFiltradas.map(p => [
    fmtFecha(p.fecha), p.fechaFin ? fmtFecha(p.fechaFin) : "",
    p.alumno ? nombreCompleto(p.alumno) : "", p.alumno?.legajo || "",
    p.lugar || "", infoTipo(p.tipo).label, estadoPractica(p), p.sector || "",
    p.horaInicio || "", p.horaFin || "", p.horasPorDia ?? p.horasTotales ?? 0, p.diasPorSemana ?? 5,
    numeroHoras(p.horasTotales),
    acumuladosPracticas[p.alumnoId]?.horasRealizadas ?? 0, acumuladosPracticas[p.alumnoId]?.totalHoras ?? 0,
    p.tutorResponsable || "", p.contacto || "",
  ]);
  exportarXLSX("practicas.xlsx", "Prácticas", encabezados, filas);
});

document.getElementById("btn-filtrar-practicas").addEventListener("click", cargarPracticas);
document.getElementById("btn-limpiar-practicas").addEventListener("click", () => {
  ["f-alumno", "f-lugar", "f-tutor", "f-sector", "f-desde", "f-hasta"].forEach(id => document.getElementById(id).value = "");
  cargarPracticas();
});

// Actualiza el campo "Horas totales" del modal de práctica:
// - Si la práctica está PENDIENTE, se recalcula sola (a partir de horas x
//   día + días por semana + rango de fechas) y queda de solo lectura.
// - Si ya se REALIZÓ, se habilita para que se cargue el valor real a mano
//   (o el que trajo una importación), sin pisar lo que el usuario tipeó.
function actualizarPreviewHorasTotales() {
  const realizada = document.getElementById("practica-estado").value === "realizada";
  const inputTotales = document.getElementById("practica-horas-totales");
  const ayuda = document.getElementById("practica-horas-totales-ayuda");
  if (realizada) {
    inputTotales.readOnly = false;
    inputTotales.classList.remove("bg-light");
    ayuda.textContent = "Práctica ya realizada: cargá acá el total real de horas (a mano o importado).";
  } else {
    const fecha = document.getElementById("practica-fecha").value;
    const fechaFin = document.getElementById("practica-fecha-fin").value;
    const horasPorDia = parseFloat(document.getElementById("practica-horas-dia").value || 0);
    const diasPorSemana = parseFloat(document.getElementById("practica-dias-semana").value || 5);
    inputTotales.value = calcularHorasTotalesAutomatico(fecha, fechaFin, horasPorDia, diasPorSemana, diasSeleccionadosFormulario());
    inputTotales.readOnly = true;
    inputTotales.classList.add("bg-light");
    ayuda.textContent = "Calculado solo a partir de \"Horas x día\", \"Días por semana\" y el rango de fechas. Se recalcula mientras la práctica esté pendiente.";
  }
}
["practica-fecha", "practica-fecha-fin", "practica-horas-dia", "practica-dias-semana", "practica-estado"].forEach(id => {
  document.getElementById(id).addEventListener("input", actualizarPreviewHorasTotales);
});
document.querySelectorAll("#practica-dias-selector input").forEach(x => x.addEventListener("change", () => {
  document.getElementById("practica-dias-semana").value = diasSeleccionadosFormulario().length;
  actualizarPreviewHorasTotales();
}));

document.getElementById("btn-nueva-practica").addEventListener("click", async () => {
  practicaOrigenAlumnoId = null;
  document.getElementById("form-practica").reset();
  document.getElementById("practica-id").value = "";
  document.getElementById("practica-estado").value = "programada";
  marcarDiasFormulario([1, 2, 3, 4, 5]);
  await llenarSelectAlumnos(document.getElementById("practica-alumno"));
  actualizarPreviewHorasTotales();
  abrirModal("modal-practica");
});

window.editarPractica = async (id, desdeFicha = false) => {
  const practicas = await obtenerPracticas();
  const p = practicas.find(x => x.id === id);
  practicaOrigenAlumnoId = desdeFicha ? p.alumnoId : null;
  if (desdeFicha) cerrarModal("modal-alumno");
  document.getElementById("practica-id").value = p.id;
  await llenarSelectAlumnos(document.getElementById("practica-alumno"), p.alumnoId);
  document.getElementById("practica-lugar").value = p.lugar;
  // Ojo: antes esto forzaba "interna" para cualquier tipo que no fuera "externa",
  // así que al editar una práctica interescolar y guardar, se perdía el tipo.
  document.getElementById("practica-tipo").value = p.tipo || "interna";
  document.getElementById("practica-sector").value = p.sector || "";
  document.getElementById("practica-fecha").value = p.fecha || "";
  document.getElementById("practica-fecha-fin").value = p.fechaFin || "";
  document.getElementById("practica-inicio").value = p.horaInicio || "";
  document.getElementById("practica-fin").value = p.horaFin || "";
  // Fallback para prácticas cargadas antes de que existiera "horasPorDia":
  // en ese esquema viejo, "horasTotales" ya representaba la carga diaria.
  document.getElementById("practica-horas-dia").value = p.horasPorDia ?? p.horasTotales ?? 0;
  document.getElementById("practica-dias-semana").value = p.diasPorSemana ?? 5;
  marcarDiasFormulario(p.diasSemana?.length ? p.diasSemana : [1, 2, 3, 4, 5].slice(0, p.diasPorSemana ?? 5));
  document.getElementById("practica-horas-totales").value = p.horasTotales ?? 0;
  document.getElementById("practica-estado").value = estadoPractica(p);
  document.getElementById("practica-tutor").value = p.tutorResponsable || "";
  document.getElementById("practica-tutor-email").value = p.tutorEmail || "";
  document.getElementById("practica-contacto").value = p.contacto || "";
  document.getElementById("practica-notas").value = p.notas || "";
  actualizarPreviewHorasTotales();
  abrirModal("modal-practica");
};

document.getElementById("form-practica").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("practica-id").value;
  const fecha = document.getElementById("practica-fecha").value;
  const fechaFin = document.getElementById("practica-fecha-fin").value;
  if (fechaFin && fechaFin < fecha) {
    mostrarAlerta("La fecha de fin no puede ser anterior a la fecha de inicio.", "danger");
    return;
  }
  const estado = document.getElementById("practica-estado").value;
  const realizada = estado === "realizada";
  const horasPorDia = parseFloat(document.getElementById("practica-horas-dia").value || 0);
  const diasSemana = diasSeleccionadosFormulario();
  if (!diasSemana.length) { mostrarAlerta("Seleccioná al menos un día de asistencia.", "warning"); return; }
  const diasPorSemana = diasSemana.length;
  // Pendiente: las horas totales se calculan solas. Realizada: se usa el
  // valor cargado a mano (o importado) en "Horas totales de esta práctica".
  const horasTotales = realizada
    ? parseFloat(document.getElementById("practica-horas-totales").value || 0)
    : calcularHorasTotalesAutomatico(fecha, fechaFin, horasPorDia, diasPorSemana, diasSemana);
  const alumnosSeleccionados = [...document.getElementById("practica-alumno").selectedOptions].map(o => o.value);
  if (!alumnosSeleccionados.length) { mostrarAlerta("Seleccioná al menos un alumno.", "warning"); return; }
  const datos = {
    alumnoId: alumnosSeleccionados[0],
    lugar: document.getElementById("practica-lugar").value.trim(),
    tipo: document.getElementById("practica-tipo").value,
    sector: document.getElementById("practica-sector").value.trim(),
    fecha,
    fechaFin,
    horaInicio: document.getElementById("practica-inicio").value,
    horaFin: document.getElementById("practica-fin").value,
    horasPorDia,
    diasPorSemana,
    diasSemana,
    horasTotales,
    realizada,
    estado,
    tutorResponsable: document.getElementById("practica-tutor").value.trim(),
    tutorEmail: document.getElementById("practica-tutor-email").value.trim(),
    contacto: document.getElementById("practica-contacto").value.trim(),
    notas: document.getElementById("practica-notas").value.trim(),
  };
  if (id) {
    const anterior = await getDoc(doc(db, "practicas", id));
    const camposAviso = ["alumnoId", "fecha", "fechaFin", "lugar", "horaInicio", "horaFin", "tutorResponsable", "tutorEmail", "contacto"];
    if (anterior.exists() && camposAviso.some(c => (anterior.data()[c] || "") !== (datos[c] || ""))) {
      datos.avisoAutomaticoEnviado = false;
      avisosEnviadosSesion.delete(id);
    }
    await updateDoc(doc(db, "practicas", id), datos);
  } else {
    const grupoId = `grupo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await Promise.all(alumnosSeleccionados.map(alumnoId => addDoc(collection(db, "practicas"), { ...datos, alumnoId, grupoId })));
  }
  await registrarLugarSiNuevo(datos.lugar);
  cerrarModal("modal-practica");
  mostrarAlerta("Fecha de práctica guardada.");
  await sincronizarAsistenciasAutomaticas();
  // Si se editó/creó desde la ficha de un alumno, hay que refrescar esa lista
  // (y no la de "Fechas de práctica") para que el cambio se vea reflejado ahí.
  if (practicaOrigenAlumnoId) {
    await cargarPracticasDeAlumnoEnFicha(practicaOrigenAlumnoId);
    abrirModal("modal-alumno");
  } else {
    cargarPracticas();
  }
  practicaOrigenAlumnoId = null;
});

window.eliminarPractica = async (id, desdeFicha = false) => {
  const confirmacion = confirm("¿Eliminar esta práctica? Esta acción no se puede deshacer.");
  if (!confirmacion) return;
  await deleteDoc(doc(db, "practicas", id));
  mostrarAlerta("Práctica eliminada.");
  if (desdeFicha) {
    const alumnoId = document.getElementById("alumno-id").value;
    if (alumnoId) await cargarPracticasDeAlumnoEnFicha(alumnoId);
  } else {
    cargarPracticas();
  }
};

// --------------------------------------------------------------- INFORMES
// Llena el combo "Práctica correspondiente" del modal de informe con las
// prácticas de ESE alumno en particular (para poder vincular el informe a
// la práctica que corresponde y que después aparezca en "Resumen por
// práctica"). Si no hay alumno seleccionado, deja solo la opción "Sin vincular".
async function llenarSelectPracticaDeInforme(alumnoId, seleccionadaId = "") {
  const sel = document.getElementById("informe-practica");
  if (!alumnoId) {
    sel.innerHTML = `<option value="">Sin vincular a una práctica</option>`;
    return;
  }
  const practicas = await obtenerPracticas();
  const propias = practicas.filter(p => p.alumnoId === alumnoId);
  sel.innerHTML = `<option value="">Sin vincular a una práctica</option>` +
    propias.map(p => `<option value="${p.id}" ${p.id === seleccionadaId ? "selected" : ""}>${p.lugar} (${fmtRangoFechas(p)})</option>`).join("");
}
document.getElementById("informe-alumno").addEventListener("change", (e) => llenarSelectPracticaDeInforme(e.target.value));

async function cargarInformes() {
  const [alumnos, practicas] = await Promise.all([obtenerAlumnos(), obtenerPracticas()]);
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const mapaPracticas = Object.fromEntries(practicas.map(p => [p.id, p]));

  const snap = await getDocs(query(collection(db, "informes"), orderBy("fechaPresentacion", "desc")));
  let informes = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const fAlumno = document.getElementById("if-alumno").value.trim().toLowerCase();
  const fLugar = document.getElementById("if-lugar").value.trim().toLowerCase();
  const fTitulo = document.getElementById("if-titulo").value.trim().toLowerCase();
  const fEstado = document.getElementById("if-estado").value;

  informes = informes.filter(i => {
    const alumno = mapaAlumnos[i.alumnoId];
    const practica = i.practicaId ? mapaPracticas[i.practicaId] : null;
    if (fAlumno && !(alumno && `${nombreCompleto(alumno)} ${alumno.legajo}`.toLowerCase().includes(fAlumno))) return false;
    if (fLugar && !(practica?.lugar || "").toLowerCase().includes(fLugar)) return false;
    if (fTitulo && !(i.titulo || "").toLowerCase().includes(fTitulo)) return false;
    if (fEstado && i.estado !== fEstado) return false;
    return true;
  });

  document.getElementById("tabla-informes").innerHTML = informes.map(i => {
    const practica = i.practicaId ? mapaPracticas[i.practicaId] : null;
    return `
    <tr>
      <td>${mapaAlumnos[i.alumnoId] ? nombreCompleto(mapaAlumnos[i.alumnoId]) : "-"}</td>
      <td>${i.titulo}</td><td>${fmtFecha(i.fechaPresentacion)}</td>
      <td><span class="badge badge-estado-${i.estado}">${i.estado}</span></td>
      <td>${practica ? `${practica.lugar} (${fmtRangoFechas(practica)})` : "-"}</td>
      <td>${i.enlaceDrive ? `<a href="${i.enlaceDrive}" target="_blank">Ver archivo</a>` : ""}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="text-muted">No se encontraron informes.</td></tr>`;
}

document.getElementById("btn-filtrar-informes").addEventListener("click", cargarInformes);
document.getElementById("btn-limpiar-informes").addEventListener("click", () => {
  ["if-alumno", "if-lugar", "if-titulo"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("if-estado").value = "";
  cargarInformes();
});

document.getElementById("btn-nuevo-informe").addEventListener("click", async () => {
  document.getElementById("form-informe").reset();
  await llenarSelectAlumnos(document.getElementById("informe-alumno"));
  await llenarSelectPracticaDeInforme(document.getElementById("informe-alumno").value);
  abrirModal("modal-informe");
});

document.getElementById("form-informe").addEventListener("submit", async (e) => {
  e.preventDefault();
  const datos = {
    alumnoId: document.getElementById("informe-alumno").value,
    practicaId: document.getElementById("informe-practica").value || "",
    titulo: document.getElementById("informe-titulo").value.trim(),
    fechaPresentacion: document.getElementById("informe-fecha").value || new Date().toISOString().slice(0, 10),
    estado: document.getElementById("informe-estado").value,
    enlaceDrive: document.getElementById("informe-enlace").value.trim(),
    observaciones: document.getElementById("informe-obs").value.trim(),
  };
  await addDoc(collection(db, "informes"), datos);
  cerrarModal("modal-informe");
  mostrarAlerta("Informe registrado.");
  cargarInformes();
});

// ------------------------------------------------------- RESUMEN POR PRACTICA
// La colección "practicas" tiene UN documento por alumno (cada alumno tiene su
// propia fila con sus horas, aunque haya ido al mismo lugar que sus
// compañeros). Acá los agrupamos por LUGAR nada más -para ver de un vistazo
// todo lo que pasó en un lugar determinado, aunque hayan ido en distintas
// fechas o con distinto tipo de práctica- y calculamos el estado de cada
// alumno ahí: horas realizadas, si asistió, si presentó el informe y si
// tiene faltas registradas en esas fechas.
function agruparPracticasPorLugar(practicas) {
  const grupos = {};
  practicas.forEach(p => {
    const clave = p.lugar || "(sin lugar)";
    if (!grupos[clave]) grupos[clave] = { lugar: clave, practicas: [] };
    grupos[clave].practicas.push(p);
  });
  return Object.values(grupos).sort((a, b) => a.lugar.localeCompare(b.lugar, "es"));
}

async function cargarResumenPracticas() {
  const [practicas, informesSnap, asistenciasSnap, faltasSnap] = await Promise.all([
    obtenerPracticas(),
    getDocs(collection(db, "informes")),
    getDocs(collection(db, "asistencias")),
    getDocs(collection(db, "faltas")),
  ]);
  const informes = informesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const asistencias = asistenciasSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const faltas = faltasSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Un informe "cuenta" para una práctica puntual solo si quedó vinculado a
  // ella (campo practicaId, que se completa desde el formulario de Informes,
  // incluyendo el registro masivo desde Drive).
  const informesPorPracticaId = {};
  informes.forEach(i => {
    if (!i.practicaId) return;
    (informesPorPracticaId[i.practicaId] ||= []).push(i);
  });

  const fLugar = document.getElementById("rp-lugar").value.trim().toLowerCase();
  const fTipo = document.getElementById("rp-tipo").value;
  const fDesde = document.getElementById("rp-desde").value;
  const fHasta = document.getElementById("rp-hasta").value;

  // Los filtros de tipo/fechas se aplican sobre cada período individual
  // ANTES de agrupar por lugar (así un lugar con prácticas de dos tipos
  // distintos puede filtrarse para ver solo uno de ellos).
  const practicasFiltradas = practicas.filter(p => {
    const fin = p.fechaFin || p.fecha;
    if (fTipo && p.tipo !== fTipo) return false;
    if (fDesde && fin < fDesde) return false;
    if (fHasta && p.fecha > fHasta) return false;
    return true;
  });

  let grupos = agruparPracticasPorLugar(practicasFiltradas);
  if (fLugar) grupos = grupos.filter(g => g.lugar.toLowerCase().includes(fLugar));

  ultimosResumenPracticas = grupos.map(g => {
    // Un mismo alumno puede tener más de un período en el mismo lugar
    // (por ejemplo, dos pasantías separadas): se agrupan todos sus períodos
    // y se suman/combinan para mostrar un solo estado por alumno.
    const porAlumno = {};
    g.practicas.forEach(p => {
      if (!porAlumno[p.alumnoId]) porAlumno[p.alumnoId] = { alumno: p.alumno, periodos: [] };
      porAlumno[p.alumnoId].periodos.push(p);
    });

    const detalle = Object.values(porAlumno).map(entry => {
      const horasRealizadas = entry.periodos.reduce(
        (acc, p) => acc + (practicaRealizada(p) ? numeroHoras(p.horasTotales) : 0), 0
      );
      // "Asistió" = hay al menos un registro de asistencia presente para ese
      // alumno en ese lugar, dentro de alguno de sus períodos.
      const asistio = entry.periodos.some(p => {
        const fin = p.fechaFin || p.fecha;
        return asistencias.some(a =>
          a.alumnoId === p.alumnoId && a.presente &&
          (!p.lugar || a.lugar === p.lugar) &&
          a.fecha >= p.fecha && a.fecha <= fin
        );
      });
      // Faltas dentro de cualquiera de sus períodos en este lugar (con Set
      // para no contar dos veces la misma fecha si los períodos se solapan).
      const fechasFaltas = new Set();
      entry.periodos.forEach(p => {
        const fin = p.fechaFin || p.fecha;
        faltas.forEach(f => {
          if (f.alumnoId === p.alumnoId && f.fecha >= p.fecha && f.fecha <= fin) fechasFaltas.add(f.fecha);
        });
      });
      // Si tiene un informe vinculado a CUALQUIERA de sus períodos en este
      // lugar, se considera presentado.
      const informe = entry.periodos.map(p => (informesPorPracticaId[p.id] || [])[0]).find(Boolean) || null;

      return {
        alumno: entry.alumno,
        periodos: entry.periodos,
        horasRealizadas,
        asistio,
        informe,
        faltas: fechasFaltas.size,
      };
    }).sort((a, b) => (a.alumno ? nombreCompleto(a.alumno) : "").localeCompare(b.alumno ? nombreCompleto(b.alumno) : "", "es"));

    return {
      lugar: g.lugar,
      tipos: [...new Set(g.practicas.map(p => p.tipo || "interna"))],
      detalle,
      totalAlumnos: detalle.length,
      totalHoras: detalle.reduce((acc, d) => acc + d.horasRealizadas, 0),
      totalInformes: detalle.filter(d => d.informe).length,
      totalConFaltas: detalle.filter(d => d.faltas > 0).length,
    };
  });

  document.getElementById("tabla-resumen-practicas").innerHTML = ultimosResumenPracticas.map((g, idx) => `
    <tr>
      <td>${g.lugar}</td>
      <td>${g.tipos.map(t => badgeTipo(t)).join(" ")}</td>
      <td>${g.totalAlumnos}</td>
      <td>${g.totalHoras.toFixed(1)}</td>
      <td>${g.totalInformes} / ${g.totalAlumnos}</td>
      <td>${g.totalConFaltas} / ${g.totalAlumnos}</td>
      <td><button class="btn btn-sm btn-outline-secondary" onclick="window.verDetallePractica(${idx})">Ver alumnos</button></td>
    </tr>`).join("") || `<tr><td colspan="7" class="text-muted">No se encontraron prácticas para ese filtro.</td></tr>`;
}

window.verDetallePractica = (idx) => {
  const g = ultimosResumenPracticas[idx];
  if (!g) return;
  document.getElementById("detalle-practica-titulo").textContent = `${g.lugar} — estado de cada alumno`;
  document.getElementById("tabla-detalle-practica").innerHTML = g.detalle.map(d => `
    <tr>
      <td>${d.alumno ? nombreCompleto(d.alumno) : "-"}</td>
      <td>${d.periodos.map(p => fmtRangoFechas(p)).join("<br>")}</td>
      <td>${d.horasRealizadas.toFixed(1)}</td>
      <td><span class="badge bg-${d.asistio ? "success" : "secondary"}">${d.asistio ? "Sí" : "No"}</span></td>
      <td>${d.informe
        ? `<span class="badge bg-success">Sí</span>${d.informe.enlaceDrive ? ` <a href="${d.informe.enlaceDrive}" target="_blank">Ver</a>` : ""}`
        : `<span class="badge bg-secondary">No</span>`}</td>
      <td>${d.faltas > 0 ? `<span class="badge bg-danger">${d.faltas}</span>` : "0"}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="text-muted">Sin alumnos asignados.</td></tr>`;
  abrirModal("modal-detalle-practica");
};

document.getElementById("btn-filtrar-resumen").addEventListener("click", cargarResumenPracticas);
document.getElementById("btn-limpiar-resumen").addEventListener("click", () => {
  ["rp-lugar", "rp-desde", "rp-hasta"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("rp-tipo").value = "";
  cargarResumenPracticas();
});

// ------------------------------------------------------------------ DRIVE
// Nombre corto y prolijo para el tipo de archivo, en vez del mimeType crudo.
function tipoArchivoLegible(mimeType) {
  if (mimeType === "application/vnd.google-apps.document") return "Google Docs";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "Word (.docx)";
  if (mimeType === "application/msword") return "Word (.doc)";
  return mimeType;
}

function renderTablaDrive(archivos) {
  ultimosArchivosDrive = archivos;
  const chkTodos = document.getElementById("chk-todos-drive");
  if (chkTodos) chkTodos.checked = false;
  document.getElementById("tabla-drive").innerHTML = archivos.map((f, idx) => `
    <tr>
      <td><input type="checkbox" class="chk-drive-archivo" value="${idx}"></td>
      <td>${f.curso || "-"}</td>
      <td>${f.alumno || "-"}</td>
      <td>${f.nombre}</td>
      <td>${tipoArchivoLegible(f.mimeType)}</td>
      <td>${new Date(f.modifiedTime).toLocaleString()}</td>
      <td><a href="${f.webViewLink}" target="_blank" class="btn btn-sm btn-outline-secondary">Abrir</a></td>
    </tr>`).join("") || `<tr><td colspan="7" class="text-muted">Sin resultados.</td></tr>`;
}

document.getElementById("btn-drive-login").addEventListener("click", () => initDrive());

document.getElementById("chk-todos-drive")?.addEventListener("change", (e) => {
  document.querySelectorAll(".chk-drive-archivo").forEach(c => c.checked = e.target.checked);
});

document.getElementById("form-drive-buscar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query_ = document.getElementById("drive-query").value.trim();
  const estado = document.getElementById("drive-estado");
  estado.textContent = "Buscando en todas las carpetas (Séptimo A, Séptimo B y cada alumno)...";
  try {
    const archivos = await buscarEnDrive(query_);
    estado.textContent = archivos.length ? `${archivos.length} informe(s) encontrado(s).` : "Sin resultados.";
    renderTablaDrive(archivos);
  } catch (err) {
    estado.textContent = "Necesitás conectar con Google Drive primero (botón de arriba).";
  }
});

// Trae absolutamente todos los informes (recorre Informes/SéptimoA/<alumno>/...
// e Informes/SéptimoB/<alumno>/... de forma recursiva), sin necesidad de
// escribir ningún nombre para buscar.
document.getElementById("btn-drive-cargar-todos").addEventListener("click", async () => {
  const estado = document.getElementById("drive-estado");
  document.getElementById("drive-query").value = "";
  estado.textContent = "Recorriendo carpetas de Drive, puede tardar unos segundos...";
  try {
    const archivos = await cargarTodosLosInformes({ forzarRefresco: true });
    estado.textContent = `${archivos.length} informe(s) encontrado(s) en total.`;
    renderTablaDrive(archivos);
  } catch (err) {
    estado.textContent = "Necesitás conectar con Google Drive primero (botón de arriba).";
  }
});

// ---------------------------------- Registrar informes desde Drive (masivo)
// Intenta relacionar un texto (nombre de la carpeta del alumno, o el nombre
// del archivo si no hay carpeta) con un alumno de la base, comparando
// apellido y nombre palabra por palabra. Devuelve null si no encuentra una
// coincidencia razonable (no adivina a los ponchazos).
function emparejarAlumnoPorTexto(texto, alumnos) {
  if (!texto) return null;
  const norm = normalizarTexto(texto).replace(/[^a-z0-9\s]/g, " ");
  const palabrasTexto = norm.split(/\s+/).filter(w => w.length > 1);
  if (!palabrasTexto.length) return null;

  let mejor = null, mejorPuntaje = 0;
  alumnos.forEach(a => {
    const normAlumno = normalizarTexto(`${a.apellido} ${a.nombre}`).replace(/[^a-z0-9\s]/g, " ");
    const palabrasAlumno = normAlumno.split(/\s+/).filter(w => w.length > 1);
    if (!palabrasAlumno.length) return;
    const coincidencias = palabrasAlumno.filter(w => palabrasTexto.includes(w)).length;
    const puntaje = coincidencias / palabrasAlumno.length;
    if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = a; }
  });
  // Exigimos que matcheen al menos la mitad de las palabras del nombre
  // completo (por ejemplo, apellido Y nombre si el alumno tiene dos).
  return mejorPuntaje >= 0.5 ? mejor : null;
}

// Entre las prácticas de un alumno, elige la que mejor podría corresponder al
// archivo: si el lugar de alguna práctica aparece mencionado en el nombre
// del archivo se usa esa; si no, se usa la práctica más reciente.
function elegirPracticaParaArchivo(practicasDelAlumno, archivo) {
  if (!practicasDelAlumno.length) return null;
  const nombreNorm = normalizarTexto(archivo.nombre);
  const porLugar = practicasDelAlumno.find(p => p.lugar && nombreNorm.includes(normalizarTexto(p.lugar)));
  if (porLugar) return porLugar;
  return [...practicasDelAlumno].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))[0];
}

function filaRegistrarDriveHTML(fila, alumnos) {
  const opcionesAlumnos = `<option value="">-- Seleccionar --</option>` +
    alumnos.map(a => `<option value="${a.id}" ${a.id === fila.alumnoIdSugerido ? "selected" : ""}>${nombreCompleto(a)} (${a.legajo})</option>`).join("");
  const opcionesPracticas = `<option value="">Sin vincular</option>` +
    fila.practicasDelAlumno.map(p => `<option value="${p.id}" ${p.id === fila.practicaIdSugerido ? "selected" : ""}>${p.lugar} (${fmtRangoFechas(p)})</option>`).join("");
  const tituloEscapado = fila.tituloSugerido.replace(/"/g, "&quot;");

  return `
    <tr>
      <td><input type="checkbox" class="chk-incluir-registrar" data-idx="${fila.idx}" ${fila.yaRegistrado ? "" : "checked"}></td>
      <td>
        <div>${fila.archivo.nombre}</div>
        <div class="text-muted small">${[fila.archivo.curso, fila.archivo.alumno].filter(Boolean).join(" / ")}</div>
        ${fila.yaRegistrado ? `<span class="badge bg-secondary">Ya registrado</span>` : ""}
      </td>
      <td><select class="form-select form-select-sm sel-alumno-registrar" data-idx="${fila.idx}" style="min-width:170px">${opcionesAlumnos}</select></td>
      <td><select class="form-select form-select-sm sel-practica-registrar" data-idx="${fila.idx}" style="min-width:190px">${opcionesPracticas}</select></td>
      <td><input type="text" class="form-control form-control-sm input-titulo-registrar" data-idx="${fila.idx}" value="${tituloEscapado}" style="min-width:160px"></td>
      <td><input type="date" class="form-control form-control-sm input-fecha-registrar" data-idx="${fila.idx}" value="${fila.fechaSugerida}"></td>
      <td>
        <select class="form-select form-select-sm sel-estado-registrar" data-idx="${fila.idx}">
          <option value="pendiente">Pendiente</option>
          <option value="entregado" selected>Entregado</option>
          <option value="aprobado">Aprobado</option>
          <option value="rechazado">Rechazado</option>
        </select>
      </td>
    </tr>`;
}

// Abre el modal de revisión con una fila por archivo seleccionado, con
// alumno/práctica/título/fecha PRE-CARGADOS a partir de la carpeta y el
// nombre de cada archivo. El usuario revisa/corrige antes de guardar.
async function abrirModalRegistrarInformesDrive(archivos) {
  const [alumnos, practicas, informesSnap] = await Promise.all([
    obtenerAlumnos(),
    obtenerPracticas(),
    getDocs(collection(db, "informes")),
  ]);
  const enlacesYaRegistrados = new Set(informesSnap.docs.map(d => d.data().enlaceDrive).filter(Boolean));

  filasRegistrarDrive = archivos.map((archivo, idx) => {
    const yaRegistrado = enlacesYaRegistrados.has(archivo.webViewLink);
    const alumnoSugerido = emparejarAlumnoPorTexto(archivo.alumno, alumnos) || emparejarAlumnoPorTexto(archivo.nombre, alumnos);
    const practicasDelAlumno = alumnoSugerido ? practicas.filter(p => p.alumnoId === alumnoSugerido.id) : [];
    const practicaSugerida = elegirPracticaParaArchivo(practicasDelAlumno, archivo);
    return {
      idx, archivo, yaRegistrado,
      alumnoIdSugerido: alumnoSugerido?.id || "",
      practicaIdSugerido: practicaSugerida?.id || "",
      practicasDelAlumno,
      tituloSugerido: archivo.nombre.replace(/\.(docx?|pdf)$/i, ""),
      fechaSugerida: (archivo.modifiedTime || "").slice(0, 10),
    };
  });

  document.getElementById("tabla-registrar-informes-drive").innerHTML =
    filasRegistrarDrive.map(fila => filaRegistrarDriveHTML(fila, alumnos)).join("") ||
    `<tr><td colspan="7" class="text-muted">No hay archivos seleccionados.</td></tr>`;

  const yaRegCount = filasRegistrarDrive.filter(f => f.yaRegistrado).length;
  document.getElementById("registrar-drive-resumen").textContent = yaRegCount
    ? `${filasRegistrarDrive.length} archivo(s) seleccionados — ${yaRegCount} ya estaban registrados (destildados).`
    : `${filasRegistrarDrive.length} archivo(s) seleccionados.`;
  document.getElementById("chk-todos-registrar-drive").checked = filasRegistrarDrive.some(f => !f.yaRegistrado);

  abrirModal("modal-registrar-informes-drive");
}

document.getElementById("btn-drive-registrar-informes").addEventListener("click", async () => {
  const idxs = [...document.querySelectorAll(".chk-drive-archivo:checked")].map(c => parseInt(c.value, 10));
  if (!idxs.length) { mostrarAlerta("Seleccioná al menos un archivo de la tabla.", "warning"); return; }
  const archivos = idxs.map(i => ultimosArchivosDrive[i]).filter(Boolean);
  await abrirModalRegistrarInformesDrive(archivos);
});

document.getElementById("chk-todos-registrar-drive").addEventListener("change", (e) => {
  document.querySelectorAll(".chk-incluir-registrar").forEach(c => c.checked = e.target.checked);
});

// Cuando se cambia el alumno de una fila, se refresca el combo de "Práctica"
// de esa misma fila con las prácticas de ese alumno (sin tocar el resto de
// las filas, para no perder lo que ya se tipeó/eligió ahí).
document.getElementById("tabla-registrar-informes-drive").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("sel-alumno-registrar")) return;
  const idx = e.target.dataset.idx;
  const alumnoId = e.target.value;
  const practicas = await obtenerPracticas();
  const practicasDelAlumno = alumnoId ? practicas.filter(p => p.alumnoId === alumnoId) : [];
  const selPractica = document.querySelector(`.sel-practica-registrar[data-idx="${idx}"]`);
  if (selPractica) {
    selPractica.innerHTML = `<option value="">Sin vincular</option>` +
      practicasDelAlumno.map(p => `<option value="${p.id}">${p.lugar} (${fmtRangoFechas(p)})</option>`).join("");
  }
});

document.getElementById("btn-guardar-informes-drive").addEventListener("click", async () => {
  const btn = document.getElementById("btn-guardar-informes-drive");
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = "Guardando...";

  let creados = 0, sinAlumno = 0, omitidos = 0;
  for (const fila of filasRegistrarDrive) {
    const incluirEl = document.querySelector(`.chk-incluir-registrar[data-idx="${fila.idx}"]`);
    if (!incluirEl || !incluirEl.checked) { omitidos++; continue; }
    const alumnoId = document.querySelector(`.sel-alumno-registrar[data-idx="${fila.idx}"]`).value;
    if (!alumnoId) { sinAlumno++; continue; }
    const practicaId = document.querySelector(`.sel-practica-registrar[data-idx="${fila.idx}"]`).value || "";
    const titulo = document.querySelector(`.input-titulo-registrar[data-idx="${fila.idx}"]`).value.trim() || fila.archivo.nombre;
    const fechaPresentacion = document.querySelector(`.input-fecha-registrar[data-idx="${fila.idx}"]`).value || hoyISO();
    const estado = document.querySelector(`.sel-estado-registrar[data-idx="${fila.idx}"]`).value;

    try {
      await addDoc(collection(db, "informes"), {
        alumnoId, practicaId, titulo, fechaPresentacion, estado,
        enlaceDrive: fila.archivo.webViewLink,
        observaciones: "Registrado desde Buscar en Drive",
      });
      creados++;
    } catch (err) {
      omitidos++;
    }
  }

  btn.disabled = false;
  btn.textContent = textoOriginal;
  cerrarModal("modal-registrar-informes-drive");

  let mensaje = `${creados} informe(s) registrado(s).`;
  if (sinAlumno) mensaje += ` ${sinAlumno} fila(s) sin alumno seleccionado, no se guardaron.`;
  if (omitidos) mensaje += ` ${omitidos} fila(s) destildada(s) u omitida(s).`;
  mostrarAlerta(mensaje, creados ? "success" : "warning");

  if (creados) cargarInformes();
});

// --------------------------------------------------------------- FALTAS -
async function cargarFaltas() {
  const alumnos = await obtenerAlumnos();
  const selFiltro = document.getElementById("falta-filtro-alumno");
  if (selFiltro.options.length <= 1) {
    selFiltro.innerHTML += alumnos.map(a => `<option value="${a.id}">${nombreCompleto(a)}</option>`).join("");
  }
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const snap = await getDocs(query(collection(db, "faltas"), orderBy("fecha", "desc")));
  let faltas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const filtroId = selFiltro.value;
  if (filtroId) faltas = faltas.filter(f => f.alumnoId === filtroId);

  const chkTodas = document.getElementById("chk-todas-faltas");
  if (chkTodas) chkTodas.checked = false;

  document.getElementById("tabla-faltas").innerHTML = faltas.map(f => `
    <tr>
      <td><input type="checkbox" class="chk-falta" value="${f.id}"></td>
      <td>${fmtFecha(f.fecha)}</td><td>${mapaAlumnos[f.alumnoId] ? nombreCompleto(mapaAlumnos[f.alumnoId]) : "-"}</td>
      <td>${f.justificada ? "Sí" : "No"}</td><td>${f.motivo || ""}</td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="window.eliminarFalta('${f.id}')">Eliminar</button></td>
    </tr>`).join("") || `<tr><td colspan="6" class="text-muted">No hay faltas registradas.</td></tr>`;
}

document.getElementById("chk-todas-faltas")?.addEventListener("change", (e) => {
  document.querySelectorAll(".chk-falta").forEach(c => c.checked = e.target.checked);
});

window.eliminarFalta = async (id) => {
  if (!confirm("¿Eliminar esta falta? Esta acción no se puede deshacer.")) return;
  await deleteDoc(doc(db, "faltas", id));
  mostrarAlerta("Falta eliminada.");
  cargarFaltas();
};

document.getElementById("btn-eliminar-faltas-masivo")?.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".chk-falta:checked")].map(c => c.value);
  if (!ids.length) { mostrarAlerta("Seleccioná al menos una falta.", "warning"); return; }
  if (!confirm(`¿Eliminar ${ids.length} falta(s) seleccionada(s)? Esta acción no se puede deshacer.`)) return;
  await Promise.all(ids.map(id => deleteDoc(doc(db, "faltas", id))));
  mostrarAlerta(`${ids.length} falta(s) eliminada(s).`);
  cargarFaltas();
});

document.getElementById("falta-filtro-alumno").addEventListener("change", cargarFaltas);
document.getElementById("btn-nueva-falta").addEventListener("click", async () => {
  document.getElementById("form-falta").reset();
  await llenarSelectAlumnos(document.getElementById("falta-alumno"));
  abrirModal("modal-falta");
});

document.getElementById("form-falta").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addDoc(collection(db, "faltas"), {
    alumnoId: document.getElementById("falta-alumno").value,
    fecha: document.getElementById("falta-fecha").value,
    justificada: document.getElementById("falta-justificada").checked,
    motivo: document.getElementById("falta-motivo").value.trim(),
  });
  cerrarModal("modal-falta");
  mostrarAlerta("Falta registrada.");
  cargarFaltas();
});

// ---------------------------------------------------------- ASISTENCIA --
async function sincronizarAsistenciasAutomaticas() {
  const [practicas, snapAsistencias] = await Promise.all([
    obtenerPracticas(),
    getDocs(collection(db, "asistencias")),
  ]);
  const existentes = new Set(snapAsistencias.docs.map(d => {
    const r = d.data();
    return `${r.practicaId || ""}|${r.alumnoId}|${r.fecha}`;
  }));
  const hoy = hoyISO();
  const altas = [];
  practicas.filter(p => estadoPractica(p) !== "cancelada").forEach(p => {
    const dias = p.diasSemana?.length ? p.diasSemana : [1, 2, 3, 4, 5, 6, 0].slice(0, Math.max(1, Math.min(7, Number(p.diasPorSemana) || 5)));
    fechasProgramadas(p.fecha, p.fechaFin, dias).filter(fecha => fecha <= hoy).forEach(fecha => {
      const clave = `${p.id}|${p.alumnoId}|${fecha}`;
      if (existentes.has(clave)) return;
      existentes.add(clave);
      altas.push(addDoc(collection(db, "asistencias"), {
        practicaId: p.id, alumnoId: p.alumnoId, fecha,
        lugar: p.lugar || "", tipo: p.tipo || "interna",
        estado: "presente", presente: true,
        horaEntrada: p.horaInicio || "", horaSalida: p.horaFin || "",
        observaciones: "Generado automáticamente según el cronograma",
        origen: "automatico", creado: new Date().toISOString(),
      }));
    });
  });
  if (altas.length) await Promise.all(altas);
  return altas.length;
}

async function cargarAsistencia() {
  await sincronizarAsistenciasAutomaticas();
  const alumnos = await obtenerAlumnos();
  const selForm = document.getElementById("asist-alumno");
  const selFiltro = document.getElementById("asist-filtro-alumno");
  if (selForm.options.length === 0) selForm.innerHTML = alumnos.map(a => `<option value="${a.id}">${nombreCompleto(a)}</option>`).join("");
  if (selFiltro.options.length <= 1) selFiltro.innerHTML += alumnos.map(a => `<option value="${a.id}">${nombreCompleto(a)}</option>`).join("");

  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const snap = await getDocs(query(collection(db, "asistencias"), orderBy("fecha", "desc")));
  let registros = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const filtroId = selFiltro.value;
  if (filtroId) registros = registros.filter(r => r.alumnoId === filtroId);
  const filtroFecha = document.getElementById("asist-filtro-fecha").value;
  const filtroLugar = document.getElementById("asist-filtro-lugar").value.trim().toLowerCase();
  if (filtroFecha) registros = registros.filter(r => r.fecha === filtroFecha);
  if (filtroLugar) registros = registros.filter(r => String(r.lugar || "").toLowerCase().includes(filtroLugar));
  registros = registros.slice(0, 100);

  const chkTodas = document.getElementById("chk-todas-asistencia");
  if (chkTodas) chkTodas.checked = false;

  document.getElementById("tabla-asistencia").innerHTML = registros.map(r => {
    const estado = r.estado || (r.presente ? "presente" : "ausente_injustificado");
    return `
    <tr>
      <td><input type="checkbox" class="chk-asistencia" value="${r.id}"></td>
      <td>${fmtFecha(r.fecha)}</td><td>${mapaAlumnos[r.alumnoId] ? nombreCompleto(mapaAlumnos[r.alumnoId]) : "-"}</td>
      <td>${escaparHTML(r.lugar)}</td><td>${r.tipo ? badgeTipo(r.tipo) : ""}</td>
      <td><select class="form-select form-select-sm estado-asistencia" onchange="window.actualizarEstadoAsistencia('${r.id}', this.value)">${Object.entries(ESTADOS_ASISTENCIA).map(([v,l]) => `<option value="${v}" ${v === estado ? "selected" : ""}>${l}</option>`).join("")}</select></td><td>${r.horaEntrada || ""}</td><td>${r.horaSalida || ""}</td><td>${escaparHTML(r.observaciones)}</td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="window.eliminarAsistencia('${r.id}')">Eliminar</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" class="text-muted">No hay registros de asistencia.</td></tr>`;
}

window.actualizarEstadoAsistencia = async (id, estado) => {
  if (!ESTADOS_ASISTENCIA[estado]) return;
  await updateDoc(doc(db, "asistencias", id), { estado, presente: ["presente", "tardanza"].includes(estado), editado: new Date().toISOString() });
  mostrarAlerta("Estado de asistencia actualizado.");
};

document.getElementById("chk-todas-asistencia")?.addEventListener("change", (e) => {
  document.querySelectorAll(".chk-asistencia").forEach(c => c.checked = e.target.checked);
});

window.eliminarAsistencia = async (id) => {
  if (!confirm("¿Eliminar este registro de asistencia? Esta acción no se puede deshacer.")) return;
  await deleteDoc(doc(db, "asistencias", id));
  mostrarAlerta("Registro de asistencia eliminado.");
  cargarAsistencia();
};

document.getElementById("btn-eliminar-asistencia-masivo")?.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".chk-asistencia:checked")].map(c => c.value);
  if (!ids.length) { mostrarAlerta("Seleccioná al menos un registro.", "warning"); return; }
  if (!confirm(`¿Eliminar ${ids.length} registro(s) de asistencia seleccionado(s)? Esta acción no se puede deshacer.`)) return;
  await Promise.all(ids.map(id => deleteDoc(doc(db, "asistencias", id))));
  mostrarAlerta(`${ids.length} registro(s) de asistencia eliminado(s).`);
  cargarAsistencia();
});

document.getElementById("asist-filtro-alumno").addEventListener("change", cargarAsistencia);
document.getElementById("asist-filtro-fecha").addEventListener("change", cargarAsistencia);
document.getElementById("asist-filtro-lugar").addEventListener("input", cargarAsistencia);
document.getElementById("btn-limpiar-asistencia").addEventListener("click", () => {
  document.getElementById("asist-filtro-alumno").value = "";
  document.getElementById("asist-filtro-fecha").value = "";
  document.getElementById("asist-filtro-lugar").value = "";
  cargarAsistencia();
});

// Si para ese alumno y esa fecha ya hay una práctica cargada, se autocompletan
// lugar y tipo (se pueden editar igual antes de guardar).
async function autocompletarAsistenciaDesdePractica() {
  const alumnoId = document.getElementById("asist-alumno").value;
  const fecha = document.getElementById("asist-fecha").value;
  if (!alumnoId || !fecha) return;
  const practicas = await obtenerPracticas();
  const practica = practicas.find(p => p.alumnoId === alumnoId && fecha >= p.fecha && fecha <= (p.fechaFin || p.fecha));
  if (!practica) return;
  const campoLugar = document.getElementById("asist-lugar");
  const campoTipo = document.getElementById("asist-tipo");
  if (campoLugar && !campoLugar.value) campoLugar.value = practica.lugar || "";
  if (campoTipo) campoTipo.value = practica.tipo || "interna";
}
document.getElementById("asist-alumno").addEventListener("change", autocompletarAsistenciaDesdePractica);
document.getElementById("asist-fecha").addEventListener("change", autocompletarAsistenciaDesdePractica);

document.getElementById("form-asistencia").addEventListener("submit", async (e) => {
  e.preventDefault();
  const lugar = document.getElementById("asist-lugar").value.trim();
  const alumnoId = document.getElementById("asist-alumno").value;
  const fecha = document.getElementById("asist-fecha").value;
  const estado = document.getElementById("asist-estado").value;
  const datos = {
    alumnoId, fecha,
    lugar,
    tipo: document.getElementById("asist-tipo").value,
    estado,
    presente: ["presente", "tardanza"].includes(estado),
    horaEntrada: document.getElementById("asist-entrada").value,
    horaSalida: document.getElementById("asist-salida").value,
    observaciones: document.getElementById("asist-obs").value.trim(),
    origen: "manual",
  };
  const snap = await getDocs(collection(db, "asistencias"));
  const existente = snap.docs.find(d => d.data().alumnoId === alumnoId && d.data().fecha === fecha && String(d.data().lugar || "") === lugar);
  if (existente) await updateDoc(existente.ref, datos); else await addDoc(collection(db, "asistencias"), datos);
  await registrarLugarSiNuevo(lugar);
  document.getElementById("form-asistencia").reset();
  document.getElementById("asist-estado").value = "presente";
  mostrarAlerta("Asistencia registrada.");
  cargarAsistencia();
});

// ------------------------------------------------------- NOTIFICACIONES -
function emailjsConfigCompleta() {
  return [emailjsConfig?.publicKey, emailjsConfig?.serviceId, emailjsConfig?.templateId]
    .every(v => typeof v === "string" && v.trim() && !/^(TU_|YOUR_)/i.test(v));
}

function actualizarAlertaConfigNotif() {
  const alerta = document.getElementById("notif-config-alerta");
  if (!window.emailjs) {
    alerta.textContent = "No se pudo cargar la librería de EmailJS (revisá tu conexión a internet).";
    alerta.classList.remove("d-none");
  } else if (!emailjsConfigCompleta()) {
    alerta.textContent = "Falta completar emailjsConfig (publicKey, serviceId y templateId) en js/firebase-config.js. Ver README, sección 4.";
    alerta.classList.remove("d-none");
  } else {
    alerta.classList.add("d-none");
  }
}

// Configuración persistente de avisos: cuántos días antes se avisa, un CC
// fijo para todos los envíos, y si el envío debe dispararse solo.
async function obtenerConfigNotificaciones() {
  const porDefecto = { diasAviso: 3, ccEmail: "", automatico: false };
  try {
    const snap = await getDoc(doc(db, "configuracion", "notificaciones"));
    return snap.exists() ? { ...porDefecto, ...snap.data() } : porDefecto;
  } catch (err) {
    return porDefecto;
  }
}

async function cargarNotificaciones() {
  actualizarAlertaConfigNotif();
  const config = await obtenerConfigNotificaciones();
  document.getElementById("notif-dias").value = config.diasAviso;
  document.getElementById("notif-cc-config").value = config.ccEmail || "";
  document.getElementById("notif-auto").checked = !!config.automatico;
  await renderProximasYHistorial();
}

document.getElementById("btn-notif-guardar-config").addEventListener("click", async () => {
  const diasAviso = parseInt(document.getElementById("notif-dias").value || "3", 10);
  const ccEmail = document.getElementById("notif-cc-config").value.trim();
  const automatico = document.getElementById("notif-auto").checked;
  if (!Number.isInteger(diasAviso) || diasAviso < 0 || (ccEmail && !emailValido(ccEmail))) {
    mostrarAlerta("Revisá los días de aviso y el correo de copia.", "warning"); return;
  }
  await setDoc(doc(db, "configuracion", "notificaciones"), { diasAviso, ccEmail, automatico });
  mostrarAlerta("Configuración de avisos guardada.");
  await renderProximasYHistorial();
});

// Refresca la tabla de "próximas" y el historial usando el valor de "días de
// aviso" que esté tipeado en este momento (no hace falta guardar para probar
// distintos rangos).
async function renderProximasYHistorial() {
  const dias = parseInt(document.getElementById("notif-dias").value || "3", 10);
  const alumnos = await obtenerAlumnos();
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));

  const hoy = hoyISO();
  const limite = sumarDiasISO(hoy, dias);

  const snap = await getDocs(collection(db, "practicas"));
  const proximas = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.fecha >= hoy && p.fecha <= limite && ["programada", "en_curso"].includes(estadoPractica(p)) && !p.avisoAutomaticoEnviado)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  document.getElementById("tabla-notif-proximas").innerHTML = proximas.map(p => `
    <tr>
      <td>${fmtFecha(p.fecha)}</td>
      <td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td>
      <td>${mapaAlumnos[p.alumnoId]?.email || "(sin email)"}</td>
      <td>${p.lugar}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="text-muted">No hay prácticas próximas en ese rango.</td></tr>`;

  document.getElementById("btn-notif-enviar").dataset.proximas = JSON.stringify(proximas);

  const histSnap = await getDocs(query(collection(db, "notificaciones_log"), orderBy("fechaEnvio", "desc"), limit(30)));
  const historial = histSnap.docs.map(d => d.data()).slice(0, 30);
  document.getElementById("tabla-notif-historial").innerHTML = historial.map(h => `
    <tr>
      <td>${new Date(h.fechaEnvio).toLocaleString()}</td>
      <td>${mapaAlumnos[h.alumnoId] ? nombreCompleto(mapaAlumnos[h.alumnoId]) : h.alumnoId}</td>
      <td>${h.origen === "automatico" ? "Automático" : "Manual"}</td>
      <td><span class="badge bg-${h.estado === "enviado" ? "success" : "danger"}">${h.estado}</span></td>
      <td>${h.detalle || "-"}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="text-muted">Sin envíos todavía.</td></tr>`;
}

document.getElementById("notif-dias").addEventListener("input", renderProximasYHistorial);

/** Lee un archivo (PDF) y lo devuelve como data URL en base64, para usarlo como adjunto dinámico de EmailJS. */
function leerArchivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

let envioEnCurso = false;
const avisosEnviadosSesion = new Set();

function emailValido(valor) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(valor || "").trim());
}

async function enviarTanda(proximas, { origen, cc = "", mensaje = "", adjunto = "", nombreAdjunto = "" }) {
  if (envioEnCurso) throw new Error("Ya hay una tanda de correos en curso.");
  if (!window.emailjs || !emailjsConfigCompleta()) throw new Error("Falta configurar EmailJS.");
  if (cc && !emailValido(cc)) throw new Error("Revisá el correo de copia (CC).");
  envioEnCurso = true;
  let enviados = 0, errores = 0, omitidos = 0;
  try {
    const alumnos = await obtenerAlumnos(true);
    const mapa = Object.fromEntries(alumnos.map(a => [a.id, a]));
    for (const candidata of proximas) {
      // Volver a leer evita usar una lista desactualizada después de otro envío.
      const snap = await getDoc(doc(db, "practicas", candidata.id));
      if (!snap.exists()) { omitidos++; continue; }
      const p = { ...snap.data(), id: candidata.id };
      if (!["programada", "en_curso"].includes(estadoPractica(p)) || p.avisoAutomaticoEnviado || avisosEnviadosSesion.has(p.id)) { omitidos++; continue; }
      const alumno = mapa[p.alumnoId];
      let estado = "error", detalle = "Alumno sin correo válido";
      const copia = cc || p.tutorEmail || "";
      if (emailValido(alumno?.email) && (!copia || emailValido(copia))) {
        const params = {
          to_email: alumno.email.trim(), to_name: nombreCompleto(alumno),
          name: alumno.nombre || "", apellido: alumno.apellido || "",
          lugar: p.lugar || "", fecha: fmtRangoFechas(p),
          horario: `${p.horaInicio || ""} - ${p.horaFin || ""}`,
          tutor: p.tutorResponsable || "", contacto: p.contacto || "",
          cc_email: copia.trim(), mensaje_adicional: mensaje,
        };
        if (adjunto) { params.adjunto_acuerdo = adjunto; params.adjunto_nombre = nombreAdjunto; }
        try {
          await window.emailjs.send(emailjsConfig.serviceId, emailjsConfig.templateId, params);
          estado = "enviado"; enviados++;
          avisosEnviadosSesion.add(p.id);
          detalle = "Aceptado por EmailJS; entrega en bandeja no confirmada";
        } catch (err) {
          detalle = `EmailJS ${err.status || ""}: ${err.text || err.message || "Error de envío"}`;
          errores++;
        }
        // EmailJS admite una solicitud por segundo, incluso si la anterior falla.
        await new Promise(resolve => setTimeout(resolve, 1100));
      } else { errores++; if (copia && !emailValido(copia)) detalle = "Correo de copia inválido"; }
      try {
        if (estado === "enviado") await updateDoc(doc(db, "practicas", p.id), {
          avisoAutomaticoEnviado: true, fechaAviso: new Date().toISOString(),
        });
        await addDoc(collection(db, "notificaciones_log"), {
          alumnoId: p.alumnoId, practicaId: p.id, tipo: "recordatorio_practica",
          origen, estado, detalle, fechaEnvio: new Date().toISOString(),
        });
      } catch (err) {
        throw new Error(`Tanda detenida. Aceptados por EmailJS: ${enviados}. No se pudo guardar el estado de la práctica ${p.id}. Revisá el historial de EmailJS antes de reintentar.`);
      }
    }
    return { enviados, errores, omitidos };
  } finally { envioEnCurso = false; }
}

document.getElementById("btn-notif-enviar").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled || envioEnCurso) return;
  btn.disabled = true;
  const texto = btn.textContent;
  btn.textContent = "Enviando...";
  try {
    const dias = Number(document.getElementById("notif-dias").value);
    if (!Number.isInteger(dias) || dias < 0) throw new Error("Ingresá una cantidad válida de días.");
    const hoy = hoyISO(), limite = sumarDiasISO(hoy, dias);
    const proximas = (await obtenerPracticas()).filter(p => p.fecha >= hoy && p.fecha <= limite && ["programada", "en_curso"].includes(estadoPractica(p)) && !p.avisoAutomaticoEnviado);
    if (!proximas.length) { mostrarAlerta("No hay prácticas pendientes sin avisar en este rango.", "info"); return; }
    const config = await obtenerConfigNotificaciones();
    const archivo = document.getElementById("notif-adjunto").files[0];
    if (archivo && (!/\.pdf$/i.test(archivo.name) || (archivo.type && archivo.type !== "application/pdf"))) throw new Error("El adjunto debe ser un PDF.");
    // Si no se puede leer, se detiene: nunca enviar omitiendo el acuerdo elegido.
    const adjunto = archivo ? await leerArchivoComoBase64(archivo) : "";
    const r = await enviarTanda(proximas, {
      origen: "manual", cc: document.getElementById("notif-cc").value.trim() || config.ccEmail || "",
      mensaje: document.getElementById("notif-mensaje").value.trim(),
      adjunto, nombreAdjunto: archivo?.name || "",
    });
    mostrarAlerta(`Aceptados por EmailJS: ${r.enviados}. Errores: ${r.errores}. Omitidos: ${r.omitidos}.`, "info");
    await cargarNotificaciones();
  } catch (err) { mostrarAlerta(err.message || "No se pudo enviar la tanda.", "danger"); }
  finally { btn.disabled = false; btn.textContent = texto; }
});

// Revisión automática: se llama una vez al iniciar sesión. Si el envío
// automático está habilitado en la configuración, busca prácticas pendientes
// dentro de la cantidad de días configurada que todavía no se avisaron, y las
// manda solas (con el CC fijo configurado). Como esta app no tiene backend
// propio, esto se dispara cuando alguien abre el sistema con sesión iniciada
// (en cada inicio de sesión), no en un horario fijo del día.
async function revisarYEnviarNotificacionesAutomaticas() {
  if (envioEnCurso) return;
  try {
    const config = await obtenerConfigNotificaciones();
    if (!config.automatico || !window.emailjs || !emailjsConfigCompleta()) return;
    const dias = Number(config.diasAviso);
    if (!Number.isInteger(dias) || dias < 0) throw new Error("Días de aviso inválidos.");
    const hoy = hoyISO(), limite = sumarDiasISO(hoy, dias);
    const pendientes = (await obtenerPracticas()).filter(p => p.fecha >= hoy && p.fecha <= limite && ["programada", "en_curso"].includes(estadoPractica(p)) && !p.avisoAutomaticoEnviado);
    if (!pendientes.length) return;
    const r = await enviarTanda(pendientes, { origen: "automatico", cc: config.ccEmail || "" });
    mostrarAlerta(`Avisos automáticos aceptados: ${r.enviados}. Errores: ${r.errores}.`, "info");
  } catch (err) { mostrarAlerta(err.message || "Error al revisar avisos automáticos.", "danger"); }
}

// ------------------------------------------------------------- USUARIOS -
async function cargarUsuarios() {
  const snap = await getDocs(collection(db, "usuarios"));
  const usuarios = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  document.getElementById("usuarios-count").textContent = usuarios.length;
  document.getElementById("tabla-usuarios").innerHTML = usuarios.map(u => `
    <tr><td>${u.nombre}</td><td>${u.email}</td><td>${u.rol}</td></tr>
  `).join("") || `<tr><td colspan="3" class="text-muted">No hay perfiles cargados todavía.</td></tr>`;

  const formUsuario = document.getElementById("form-usuario");
  formUsuario.classList.toggle("d-none", usuarios.length >= 3 && !formUsuario.dataset.editando);
}

document.getElementById("form-usuario").addEventListener("submit", async (e) => {
  e.preventDefault();
  const snap = await getDocs(collection(db, "usuarios"));
  const uid = document.getElementById("usuario-uid").value.trim();
  const yaExiste = snap.docs.some(d => d.id === uid);
  if (snap.size >= 3 && !yaExiste) {
    mostrarAlerta("Ya hay 3 usuarios cargados (el máximo permitido).", "danger");
    return;
  }
  await setDoc(doc(db, "usuarios", uid), {
    nombre: document.getElementById("usuario-nombre").value.trim(),
    email: document.getElementById("usuario-email").value.trim(),
    rol: document.getElementById("usuario-rol").value,
  });
  document.getElementById("form-usuario").reset();
  mostrarAlerta("Usuario guardado.");
  cargarUsuarios();
});

// ------------------------------------------------------------ DASHBOARD -
async function cargarDashboard() {
  const alumnos = await obtenerAlumnos(true);
  const snap = await getDocs(collection(db, "practicas"));
  const practicas = snap.docs.map(d => d.data());

  const totalHoras = practicas.reduce((acc, p) => acc + (practicaRealizada(p) ? numeroHoras(p.horasTotales) : 0), 0);
  document.getElementById("stat-horas").textContent = totalHoras.toFixed(1);
  document.getElementById("stat-alumnos").textContent = alumnos.length;
  document.getElementById("stat-practicas").textContent = practicas.length;

  const porSector = {};
  practicas.filter(practicaRealizada).forEach(p => {
    const s = p.sector || "Sin sector";
    porSector[s] = (porSector[s] || 0) + (numeroHoras(p.horasTotales));
  });
  document.getElementById("tabla-horas-sector").innerHTML = Object.entries(porSector)
    .map(([s, h]) => `<tr><td>${s}</td><td>${h.toFixed(1)}</td></tr>`).join("")
    || `<tr><td colspan="2" class="text-muted">Todavía no hay prácticas cargadas.</td></tr>`;

  const hoy = hoyISO();
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const proximas = practicas
    .map((p, idx) => ({ ...p, id: snap.docs[idx].id }))
    .filter(p => p.fecha > hoy && estadoPractica(p) !== "cancelada")
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(0, 5);
  document.getElementById("tabla-proximas").innerHTML = proximas.map(p => `
    <tr><td>${fmtRangoFechas(p)}</td><td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td><td>${p.lugar}</td></tr>
  `).join("") || `<tr><td colspan="3" class="text-muted">No hay prácticas próximas.</td></tr>`;

  const enCurso = practicas
    .map((p, idx) => ({ ...p, id: snap.docs[idx].id }))
    .filter(p => p.fecha <= hoy && (p.fechaFin || p.fecha) >= hoy && estadoPractica(p) !== "cancelada")
    .sort((a, b) => String(a.lugar || "").localeCompare(String(b.lugar || "")));
  document.getElementById("tabla-en-curso").innerHTML = enCurso.map(p => `
    <tr><td>${fmtRangoFechas(p)}</td><td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td><td>${escaparHTML(p.lugar)}</td></tr>
  `).join("") || `<tr><td colspan="3" class="text-muted">No hay prácticas en curso hoy.</td></tr>`;
  await aplicarConfigDashboard();
}

// --------------------------------------------------------- ESTADISTICAS -
let ultimoCalculoEstadisticas = []; // filas ya calculadas (todas, sin buscador ni orden aplicado); se recalculan solo al traer datos nuevos de Firestore
let estadOrden = { campo: "nombre", asc: true };

// Objetivo de horas a cumplir, UNO SOLO para todo el colegio (no por curso
// ni por alumno), con un valor independiente por tipo de práctica. Se
// guarda en Firestore en config/horasRequeridas para que lo vean todos los
// que entren a Estadísticas. Si los tres quedan en 0 (nunca se configuró),
// se mantiene el cálculo viejo de % cumplido (contra el total propio del
// alumno) para no romper lo que ya había.
let objetivoHoras = { interna: 0, externa: 0, interescolar: 0 };

async function cargarObjetivoHoras() {
  try {
    const snap = await getDoc(doc(db, "config", "horasRequeridas"));
    if (snap.exists()) {
      const d = snap.data();
      objetivoHoras = { interna: numeroHoras(d.interna), externa: numeroHoras(d.externa), interescolar: numeroHoras(d.interescolar) };
    }
  } catch (err) {
    // si falla la lectura (permisos, sin conexión) seguimos con lo que había en memoria
  }
  const iInterna = document.getElementById("estad-obj-interna");
  const iExterna = document.getElementById("estad-obj-externa");
  const iInterescolar = document.getElementById("estad-obj-interescolar");
  if (iInterna && document.activeElement !== iInterna) iInterna.value = objetivoHoras.interna || "";
  if (iExterna && document.activeElement !== iExterna) iExterna.value = objetivoHoras.externa || "";
  if (iInterescolar && document.activeElement !== iInterescolar) iInterescolar.value = objetivoHoras.interescolar || "";
}

document.getElementById("btn-estad-guardar-objetivo")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const interna = numeroHoras(document.getElementById("estad-obj-interna").value);
  const externa = numeroHoras(document.getElementById("estad-obj-externa").value);
  const interescolar = numeroHoras(document.getElementById("estad-obj-interescolar").value);
  btn.disabled = true;
  try {
    await setDoc(doc(db, "config", "horasRequeridas"), { interna, externa, interescolar });
    objetivoHoras = { interna, externa, interescolar };
    mostrarAlerta("Objetivo de horas guardado.");
    await cargarEstadisticas();
  } catch (err) {
    mostrarAlerta(`No se pudo guardar el objetivo: ${err.message || err}`, "danger");
  } finally {
    btn.disabled = false;
  }
});

async function cargarEstadisticas() {
  await cargarObjetivoHoras();
  const alumnos = await obtenerAlumnos(true);
  const snap = await getDocs(collection(db, "practicas"));
  const practicas = snap.docs.map(d => d.data());

  const porAlumno = {};
  alumnos.forEach(a => {
    porAlumno[a.id] = { alumno: a, horasRealizadas: 0, horasPendientes: 0, horasInterna: 0, horasExterna: 0, horasInterescolar: 0, cantidad: 0 };
  });

  practicas.forEach(p => {
    const horas = numeroHoras(p.horasTotales);
    const esRealizada = practicaRealizada(p);
    const registro = porAlumno[p.alumnoId];
    if (!registro) return;
    registro.cantidad += 1;
    if (esRealizada) {
      registro.horasRealizadas += horas;
      if (p.tipo === "externa") registro.horasExterna += horas;
      else if (p.tipo === "interescolar") registro.horasInterescolar += horas;
      else registro.horasInterna += horas;
    } else {
      registro.horasPendientes += horas;
    }
  });

  // % cumplido: si hay un objetivo de horas configurado (aunque sea en un
  // solo tipo), se calcula contra ESE objetivo fijo (igual para todos los
  // alumnos), separado por interna/externa/interescolar. "Horas faltantes"
  // pasa a ser lo que le falta para llegar al objetivo, no lo que tiene
  // programado. Si no hay ningún objetivo configurado (los tres en 0), se
  // mantiene el cálculo viejo (contra el total propio del alumno), para no
  // romper lo que ya había antes de configurar el objetivo.
  const reqInterna = objetivoHoras.interna || 0;
  const reqExterna = objetivoHoras.externa || 0;
  const reqInterescolar = objetivoHoras.interescolar || 0;
  const reqTotal = reqInterna + reqExterna + reqInterescolar;

  const filas = Object.values(porAlumno).map(f => {
    let pct, faltan;
    if (reqTotal > 0) {
      pct = (f.horasRealizadas / reqTotal) * 100;
      faltan = Math.max(0, reqTotal - f.horasRealizadas);
    } else {
      const horasObjetivoPropio = f.horasRealizadas + f.horasPendientes;
      pct = horasObjetivoPropio > 0 ? Math.min(100, (f.horasRealizadas / horasObjetivoPropio) * 100) : 0;
      faltan = f.horasPendientes;
    }
    return { ...f, pct, faltan, reqInterna, reqExterna, reqInterescolar, reqTotal };
  });
  ultimoCalculoEstadisticas = filas;

  const totalRealizadas = filas.reduce((s, f) => s + f.horasRealizadas, 0);
  const totalPendientes = filas.reduce((s, f) => s + f.horasPendientes, 0);
  const totalInterna = filas.reduce((s, f) => s + f.horasInterna, 0);
  const totalExterna = filas.reduce((s, f) => s + f.horasExterna, 0);
  const totalInterescolar = filas.reduce((s, f) => s + f.horasInterescolar, 0);
  const promedioPct = filas.length ? filas.reduce((acc, f) => acc + Math.min(100, f.pct), 0) / filas.length : 0;

  document.getElementById("estad-total-alumnos").textContent = alumnos.length;
  document.getElementById("estad-promedio").textContent = `${promedioPct.toFixed(0)}%`;
  document.getElementById("estad-horas-realizadas").textContent = totalRealizadas.toFixed(1);
  document.getElementById("estad-horas-pendientes").textContent = totalPendientes.toFixed(1);
  document.getElementById("estad-horas-internas").textContent = totalInterna.toFixed(1);
  document.getElementById("estad-horas-externas").textContent = totalExterna.toFixed(1);
  const elInterescolar = document.getElementById("estad-horas-interescolar");
  if (elInterescolar) elInterescolar.textContent = totalInterescolar.toFixed(1);

  // Objetivo * cantidad de alumnos, para que la tarjeta muestre "hecho /
  // a cumplir" a nivel colegio (cada alumno individualmente debe llegar a
  // reqInterna/reqExterna/reqInterescolar; a nivel agregado se multiplica).
  const elObjInterna = document.getElementById("estad-obj-interna-total");
  const elObjExterna = document.getElementById("estad-obj-externa-total");
  const elObjInterescolar = document.getElementById("estad-obj-interescolar-total");
  if (elObjInterna) elObjInterna.textContent = (reqInterna * alumnos.length).toFixed(1);
  if (elObjExterna) elObjExterna.textContent = (reqExterna * alumnos.length).toFixed(1);
  if (elObjInterescolar) elObjInterescolar.textContent = (reqInterescolar * alumnos.length).toFixed(1);

  renderTablaEstadisticas();
}

// Aplica buscador + orden sobre lo YA calculado (sin volver a pedirle nada
// a Firestore) y renderiza tanto la tabla principal como la de "menos
// horas". Deja ultimasFilasEstadisticas lista para el botón de Exportar.
function renderTablaEstadisticas() {
  const fBusqueda = document.getElementById("estad-buscar-alumno")?.value.trim().toLowerCase() || "";
  const filasFiltradas = fBusqueda
    ? ultimoCalculoEstadisticas.filter(f => `${nombreCompleto(f.alumno)} ${f.alumno.legajo}`.toLowerCase().includes(fBusqueda))
    : ultimoCalculoEstadisticas;

  const { campo, asc } = estadOrden;
  const valorOrden = (f) => (campo === "nombre" ? nombreCompleto(f.alumno).toLowerCase() : f[campo]);
  const filasOrdenadas = [...filasFiltradas].sort((a, b) => {
    const va = valorOrden(a), vb = valorOrden(b);
    let cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    if (cmp === 0) cmp = nombreCompleto(a.alumno).localeCompare(nombreCompleto(b.alumno));
    return asc ? cmp : -cmp;
  });
  ultimasFilasEstadisticas = filasOrdenadas;

  document.getElementById("tabla-estadisticas").innerHTML = filasOrdenadas.map(f => {
    // Barra apilada: un segmento por tipo de práctica (gris interna, celeste
    // externa, violeta interescolar), cada uno ocupando la proporción de
    // horas de ESE tipo sobre el objetivo total del alumno. Si entre los
    // tres tipos se supera el 100% (el alumno hizo más de lo pedido en
    // algún tipo), se escalan proporcionalmente para que la barra llene
    // como máximo el 100%, sin perder la proporción entre tipos.
    const reqTotal = f.reqTotal;
    let segInterna = 0, segExterna = 0, segInterescolar = 0;
    if (reqTotal > 0) {
      const crudoInterna = (f.horasInterna / reqTotal) * 100;
      const crudoExterna = (f.horasExterna / reqTotal) * 100;
      const crudoInterescolar = (f.horasInterescolar / reqTotal) * 100;
      const suma = crudoInterna + crudoExterna + crudoInterescolar;
      const factor = suma > 100 ? 100 / suma : 1;
      segInterna = crudoInterna * factor;
      segExterna = crudoExterna * factor;
      segInterescolar = crudoInterescolar * factor;
    } else {
      // Sin objetivo configurado: se reparte visualmente sobre el % viejo
      // (contra el propio total del alumno) para no dejar la barra vacía.
      const propio = f.horasInterna + f.horasExterna + f.horasInterescolar;
      if (propio > 0) {
        segInterna = (f.horasInterna / propio) * f.pct;
        segExterna = (f.horasExterna / propio) * f.pct;
        segInterescolar = (f.horasInterescolar / propio) * f.pct;
      }
    }
    const detalleTitulo = `Interna: ${f.horasInterna.toFixed(1)} / ${f.reqInterna.toFixed(1)} hs · Externa: ${f.horasExterna.toFixed(1)} / ${f.reqExterna.toFixed(1)} hs · Interescolar: ${f.horasInterescolar.toFixed(1)} / ${f.reqInterescolar.toFixed(1)} hs`;
    return `
    <tr>
      <td><a href="#" class="link-alumno-ficha" onclick="window.editarAlumno('${f.alumno.id}'); return false;">${nombreCompleto(f.alumno)}</a></td>
      <td>${f.alumno.legajo}</td>
      <td>${f.horasRealizadas.toFixed(1)}</td>
      <td>${f.horasPendientes.toFixed(1)}</td>
      <td>${f.horasInterna.toFixed(1)} / ${f.reqInterna.toFixed(1)}</td>
      <td>${f.horasExterna.toFixed(1)} / ${f.reqExterna.toFixed(1)}</td>
      <td>${f.horasInterescolar.toFixed(1)} / ${f.reqInterescolar.toFixed(1)}</td>
      <td>${f.cantidad}</td>
      <td>
        <div class="barra-tipos" title="${detalleTitulo}">
          <div class="seg-interna" style="width:${segInterna}%"></div>
          <div class="seg-externa" style="width:${segExterna}%"></div>
          <div class="seg-interescolar" style="width:${segInterescolar}%"></div>
        </div>
        <div class="text-muted small mt-1">${f.pct.toFixed(0)}%${reqTotal > 0 ? ` (${f.horasRealizadas.toFixed(1)} / ${reqTotal.toFixed(1)} hs)` : ""}</div>
      </td>
      <td>${f.faltan.toFixed(1)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" class="text-muted">No se encontraron alumnos con ese criterio.</td></tr>`;

  actualizarIndicadoresOrdenEstadisticas();
  renderTablaAtencion();
}

// Pinta una flechita en el encabezado por el que se está ordenando ahora.
function actualizarIndicadoresOrdenEstadisticas() {
  document.querySelectorAll("#vista-estadisticas .th-ordenable").forEach(th => {
    if (!th.dataset.label) th.dataset.label = th.textContent.trim();
    const base = th.dataset.label;
    th.textContent = th.dataset.campo === estadOrden.campo ? `${base} ${estadOrden.asc ? "▲" : "▼"}` : base;
  });
}

document.querySelectorAll("#vista-estadisticas .th-ordenable").forEach(th => {
  th.addEventListener("click", () => {
    const campo = th.dataset.campo;
    if (estadOrden.campo === campo) estadOrden.asc = !estadOrden.asc;
    else { estadOrden.campo = campo; estadOrden.asc = true; }
    renderTablaEstadisticas();
  });
});

// Alumnos con menos horas realizadas de prácticas internas + externas (no
// cuenta interescolares): para detectar de un vistazo a quién hay que
// hacerle seguimiento porque no arrancó o le falta avanzar. Desde acá
// también se puede abrir la ficha del alumno para ver sus prácticas.
function renderTablaAtencion() {
  const tbody = document.getElementById("tabla-estad-atencion");
  if (!tbody) return;
  const cantidadSel = document.getElementById("estad-atencion-cantidad");
  const cantidad = cantidadSel ? parseInt(cantidadSel.value, 10) || 0 : 10;

  const ordenadosPorMenosHoras = [...ultimoCalculoEstadisticas].sort((a, b) => {
    const ha = a.horasInterna + a.horasExterna, hb = b.horasInterna + b.horasExterna;
    if (ha !== hb) return ha - hb;
    return nombreCompleto(a.alumno).localeCompare(nombreCompleto(b.alumno));
  });
  const lista = cantidad > 0 ? ordenadosPorMenosHoras.slice(0, cantidad) : ordenadosPorMenosHoras;

  tbody.innerHTML = lista.map(f => {
    const total = f.horasInterna + f.horasExterna;
    return `
    <tr>
      <td><a href="#" class="link-alumno-ficha" onclick="window.editarAlumno('${f.alumno.id}'); return false;">${nombreCompleto(f.alumno)}</a></td>
      <td>${f.alumno.legajo}</td>
      <td>${f.alumno.curso || ""}</td>
      <td>${f.horasInterna.toFixed(1)}</td>
      <td>${f.horasExterna.toFixed(1)}</td>
      <td>${total.toFixed(1)}</td>
      <td>${f.pct.toFixed(0)}%</td>
      <td><button type="button" class="btn btn-sm btn-outline-secondary" onclick="window.editarAlumno('${f.alumno.id}')">Ver ficha</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="text-muted">No hay alumnos para mostrar.</td></tr>`;
}

document.getElementById("btn-estad-actualizar").addEventListener("click", cargarEstadisticas);
document.getElementById("estad-buscar-alumno")?.addEventListener("input", renderTablaEstadisticas);
document.getElementById("estad-atencion-cantidad")?.addEventListener("change", renderTablaAtencion);

document.getElementById("btn-estad-exportar")?.addEventListener("click", () => {
  if (!ultimasFilasEstadisticas.length) { mostrarAlerta("No hay datos para exportar.", "warning"); return; }
  const encabezados = ["Alumno", "Legajo", "Horas realizadas", "Horas pendientes",
    "Internas realizadas", "Internas a cumplir", "Externas realizadas", "Externas a cumplir",
    "Interescolares realizadas", "Interescolares a cumplir", "Cant. prácticas", "% cumplido", "Horas faltantes"];
  const filas = ultimasFilasEstadisticas.map(f => [nombreCompleto(f.alumno), f.alumno.legajo, f.horasRealizadas, f.horasPendientes,
    f.horasInterna, f.reqInterna, f.horasExterna, f.reqExterna, f.horasInterescolar, f.reqInterescolar,
    f.cantidad, `${f.pct.toFixed(0)}%`, f.faltan]);
  exportarXLSX("estadisticas.xlsx", "Estadísticas", encabezados, filas);
});

// ---------------------------------------------------------- IMPORTAR ----
let filasImportar = []; // filas ya parseadas del archivo, con validación

function normalizarTexto(s) {
  return (s ?? "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Clave de comparación para "legajo": además de normalizarTexto, sacamos
// separadores de miles/espacios y ceros a la izquierda. Esto es necesario
// porque Excel/Sheets suelen leer una columna de legajo como NÚMERO: un
// legajo "0045" guardado en la base como texto se puede reimportar como
// 45, o un legajo con formato de miles puede llegar como "1.234" o "1,234".
// Sin esta normalización, esas variantes no matchean contra el alumno ya
// existente y el importador termina creando un alumno duplicado (y por lo
// tanto la práctica nueva no se suma a las horas del alumno original,
// porque las horas se calculan sumando por alumnoId).
function normalizarLegajo(s) {
  let v = normalizarTexto(s).replace(/[\s.,]/g, "");
  if (/^0*\d+$/.test(v)) v = v.replace(/^0+(?=\d)/, ""); // sacar ceros a la izq. solo si es puramente numérico
  return v;
}

// Id determinístico de Firestore para "alumnos", armado a partir del
// legajo/DNI ya normalizado (normalizarLegajo). La idea es que dos altas
// del mismo alumno -a mano, por importación, o incluso dos importaciones
// hechas en simultáneo desde pestañas distintas- terminen siempre en el
// mismo documento en lugar de crear un registro duplicado con id al azar.
// Se sanitiza para que sea un id de documento válido en Firestore (nada de
// "/", ni vacío, ni "." o "..").
function idAlumnoDesdeLegajo(legajo) {
  const id = normalizarLegajo(legajo).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return id || null;
}

// alias de encabezados aceptados (normalizados) -> nombre de campo interno
const CAMPOS_IMPORTAR = [
  { key: "legajo", alias: ["legajo"] },
  { key: "apellido", alias: ["apellido"] },
  { key: "nombre", alias: ["nombre"] },
  { key: "email", alias: ["email", "mail", "correo"] },
  { key: "curso", alias: ["curso", "division", "curso / division", "curso/division", "curso y division"] },
  { key: "sector", alias: ["sector", "carrera", "sector / carrera", "sector/carrera"] },
  { key: "lugar", alias: ["lugar", "lugar de practica"] },
  { key: "tipo", alias: ["tipo", "tipo (interna/externa)"] },
  { key: "fecha", alias: ["fecha", "fecha (aaaa-mm-dd)", "fecha inicio", "fecha de inicio"] },
  { key: "fechaFin", alias: ["fecha fin", "fecha de fin", "fecha fin (aaaa-mm-dd)", "hasta"] },
  { key: "horaInicio", alias: ["hora inicio", "inicio"] },
  { key: "horaFin", alias: ["hora fin", "fin"] },
  { key: "horasPorDia", alias: ["horas x dia", "horas por dia", "horas diarias"] },
  { key: "diasPorSemana", alias: ["dias por semana", "cantidad de dias semanales", "dias semanales", "dias x semana"] },
  { key: "horasTotales", alias: ["horas totales", "horas"] },
  { key: "tutorResponsable", alias: ["tutor responsable", "tutor"] },
  { key: "tutorEmail", alias: ["email tutor", "email del tutor", "mail tutor", "email docente"] },
  { key: "contacto", alias: ["contacto"] },
  { key: "presente", alias: ["presente", "presente (si/no)", "asistencia"] },
  { key: "estado", alias: ["estado", "estado (realizada/pendiente)"] },
  { key: "observacionesAsistencia", alias: ["observaciones asistencia", "obs asistencia"] },
  { key: "notas", alias: ["notas practica", "notas"] },
];

// Saca aclaraciones entre paréntesis, ej: "fecha (aaaa-mm-dd o dd/mm/aaaa)" -> "fecha"
function quitarParentesis(s) {
  return s.replace(/\s*\([^)]*\)\s*/g, "").trim();
}

function mapearFila(filaCruda) {
  const filaNorm = {};
  Object.keys(filaCruda).forEach(h => {
    const norm = normalizarTexto(h);
    filaNorm[norm] = filaCruda[h];
    // además de la clave exacta, guardamos una variante sin paréntesis por si el
    // encabezado trae una aclaración distinta a la de la plantilla (ej. otro formato de fecha)
    const sinParentesis = quitarParentesis(norm);
    if (sinParentesis && filaNorm[sinParentesis] === undefined) filaNorm[sinParentesis] = filaCruda[h];
  });
  const resultado = {};
  CAMPOS_IMPORTAR.forEach(campo => {
    for (const alias of campo.alias) {
      if (filaNorm[alias] !== undefined && filaNorm[alias] !== "") { resultado[campo.key] = filaNorm[alias]; break; }
    }
  });
  return resultado;
}

function normalizarFecha(valor) {
  if (!valor) return "";
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  const s = valor.toString().trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    return `${y.padStart(4, "0")}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return s;
}

function normalizarTipo(valor) {
  const v = normalizarTexto(valor);
  if (v.startsWith("ext")) return "externa";
  // Ojo: "interna" también empieza con "inter", por eso se busca "escolar"
  // en vez de usar startsWith("inter").
  if (v.includes("interescolar") || v.includes("inter escolar") || v.includes("intercolegial")) return "interescolar";
  return "interna";
}

function normalizarPresente(valor) {
  if (valor === undefined || valor === "") return null;
  const v = normalizarTexto(valor);
  return ["si", "sí", "1", "true", "x", "presente"].includes(v);
}

// Decide si una fila cuenta como horas ya realizadas o como pendientes (programadas):
// 1) columna "Estado" explícita, 2) columna "Presente", 3) si no hay dato, se infiere por la fecha
// (se usa la fecha de fin si está cargada, porque la práctica no termina hasta ese día).
function determinarRealizada(datos, fechaISO, fechaFinISO) {
  if (datos.estado !== undefined && datos.estado !== "") {
    const v = normalizarTexto(datos.estado);
    if (["realizada", "hecha", "cumplida", "si", "sí", "1", "true"].includes(v)) return true;
    if (["pendiente", "programada", "por realizar", "no", "0", "false"].includes(v)) return false;
  }
  const presente = normalizarPresente(datos.presente);
  if (presente !== null) return presente;
  const hoy = hoyISO();
  const fechaEfectiva = fechaFinISO || fechaISO;
  return !fechaEfectiva || fechaEfectiva <= hoy;
}

document.getElementById("btn-importar-plantilla").addEventListener("click", () => {
  if (!window.XLSX) { mostrarAlerta("No se cargó Excel. Recargá la página.", "danger"); return; }
  const encabezados = ["Legajo", "Apellido", "Nombre", "Email", "Curso / División", "Sector / Carrera", "Lugar de práctica",
    "Tipo (interna/externa/interescolar)", "Fecha inicio (AAAA-MM-DD)", "Fecha fin (AAAA-MM-DD)", "Hora inicio", "Hora fin",
    "Horas x día (si está pendiente)", "Días por semana (si está pendiente)", "Horas totales (si ya se realizó)",
    "Tutor responsable", "Email tutor", "Contacto", "Presente (si/no)", "Estado (realizada/pendiente)",
    "Observaciones asistencia", "Notas práctica"];
  const ejemploRealizada = ["1234", "Gómez", "Ana", "ana@mail.com", "5to Enfermería", "Enfermería", "Hospital Central", "interna",
    "2026-09-15", "2026-09-15", "08:00", "12:00", "4", "5", "4", "Lic. Pérez", "perez@escuela.edu.ar", "011-555-1234", "si", "realizada", "Llegó puntual", "Primer día"];
  const ejemploPendiente = ["1235", "Pérez", "Luis", "luis@mail.com", "5to Enfermería", "Enfermería", "Hospital Central", "interna",
    "2026-10-01", "2026-12-19", "", "", "4", "3", "", "Lic. Pérez", "perez@escuela.edu.ar", "011-555-1234", "", "pendiente", "", "Se calcula solo con horas x día y días/semana"];
  const ws = XLSX.utils.aoa_to_sheet([encabezados, ejemploRealizada, ejemploPendiente]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Plantilla");
  XLSX.writeFile(wb, "plantilla_practicas.xlsx");
});

document.getElementById("importar-archivo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const esCSV = /\.csv$/i.test(file.name);
    let wb;
    if (esCSV) {
      // Los .csv se leen como texto (UTF-8) para no romper tildes/ñ.
      // Si se pasan como bytes crudos a XLSX.read, SheetJS puede no
      // detectar la codificación y corromper los caracteres acentuados
      // (ej. "práctica" deja de matchear con los encabezados esperados).
      const texto = await file.text();
      wb = XLSX.read(texto, { type: "string", cellDates: true });
    } else {
      const data = await file.arrayBuffer();
      wb = XLSX.read(data, { type: "array", cellDates: true });
    }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const filasCrudas = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    await procesarFilasImportar(filasCrudas);
  } catch (err) {
    mostrarAlerta("No se pudo leer el archivo. Verificá que sea un .xlsx, .xls o .csv válido.", "danger");
  }
});

async function procesarFilasImportar(filasCrudas) {
  const alumnos = await obtenerAlumnos(true);
  const porLegajo = Object.fromEntries(alumnos.map(a => [normalizarLegajo(a.legajo), a]));
  const porNombre = Object.fromEntries(
    alumnos.map(a => [`${normalizarTexto(a.apellido)}|${normalizarTexto(a.nombre)}`, a])
  );

  filasImportar = filasCrudas.map((cruda, idx) => {
    const datos = mapearFila(cruda);
    const errores = [];
    if (!datos.legajo) errores.push("Falta legajo");
    if (!datos.lugar) errores.push("Falta lugar de práctica");
    const fechaISO = normalizarFecha(datos.fecha);
    if (!datos.fecha) errores.push("Falta fecha");
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) errores.push("Fecha con formato no reconocido");

    let fechaFinISO = datos.fechaFin ? normalizarFecha(datos.fechaFin) : "";
    if (fechaFinISO && !/^\d{4}-\d{2}-\d{2}$/.test(fechaFinISO)) { errores.push("Fecha fin con formato no reconocido"); fechaFinISO = ""; }
    if (fechaFinISO && fechaISO && fechaFinISO < fechaISO) errores.push("Fecha fin anterior a la fecha de inicio");

    const alumnoExistente = datos.legajo ? porLegajo[normalizarLegajo(datos.legajo)] : null;
    if (!alumnoExistente && datos.legajo && (!datos.apellido || !datos.nombre)) {
      errores.push("Alumno nuevo: falta apellido y/o nombre");
    }

    // Red de seguridad: si el legajo no matcheó pero ya existe un alumno con
    // el mismo nombre y apellido, probablemente es la misma persona con el
    // legajo mal tipeado (o deformado por Excel) en esta fila. No lo tratamos
    // como error bloqueante (podría ser un homónimo real), pero lo marcamos
    // para que se revise antes de confirmar la importación.
    let advertencia = "";
    if (!alumnoExistente && datos.apellido && datos.nombre) {
      const posibleDuplicado = porNombre[`${normalizarTexto(datos.apellido)}|${normalizarTexto(datos.nombre)}`];
      if (posibleDuplicado) {
        advertencia = `Ya existe "${nombreCompleto(posibleDuplicado)}" con legajo "${posibleDuplicado.legajo}". ` +
          `Si es la misma persona, corregí el legajo de esta fila para no duplicarla.`;
      }
    }

    const realizada = determinarRealizada(datos, fechaISO, fechaFinISO);

    // Realizada: se usa el valor de "Horas totales" tal cual viene en la
    // planilla (importado). Pendiente: se calcula solo a partir de
    // "Horas x día" y "Días por semana" (si no vinieron, se asume 5 días/sem).
    const horasPorDia = parseFloat(datos.horasPorDia || 0) || 0;
    const diasPorSemana = parseFloat(datos.diasPorSemana || 0) || 5;
    const horasTotales = realizada
      ? (parseFloat(datos.horasTotales || 0) || 0)
      : calcularHorasTotalesAutomatico(fechaISO, fechaFinISO, horasPorDia, diasPorSemana);

    return {
      fila: idx + 2, datos, fechaISO, fechaFinISO, realizada, horasPorDia, diasPorSemana, horasTotales,
      alumnoExistente, esAlumnoNuevo: !alumnoExistente, errores, advertencia,
    };
  });

  renderPreviewImportar();
}

function renderPreviewImportar() {
  const validos = filasImportar.filter(f => f.errores.length === 0).length;
  const conError = filasImportar.length - validos;

  document.getElementById("importar-resumen-preview").innerHTML = filasImportar.length
    ? `Filas leídas: <strong>${filasImportar.length}</strong> — Listas para importar: <strong class="text-success">${validos}</strong> — Con errores (se omiten): <strong class="text-danger">${conError}</strong>`
    : "";

  document.getElementById("tabla-importar-preview").innerHTML = filasImportar.map(f => `
    <tr class="${f.errores.length ? "table-danger" : (f.advertencia ? "table-warning" : (f.esAlumnoNuevo ? "table-warning" : ""))}">
      <td>${f.fila}</td>
      <td>${f.datos.legajo || ""}</td>
      <td>${f.datos.apellido || ""} ${f.datos.nombre || ""}</td>
      <td>${f.datos.curso || ""}</td>
      <td>${f.esAlumnoNuevo ? "Alumno nuevo" : "Alumno existente"}</td>
      <td>${f.datos.lugar || ""}</td>
      <td>${badgeTipo(normalizarTipo(f.datos.tipo))}</td>
      <td>${f.fechaISO || f.datos.fecha || ""}</td>
      <td>${f.fechaFinISO || ""}</td>
      <td>${f.horasPorDia || ""}</td>
      <td>${f.diasPorSemana || ""}</td>
      <td>${f.horasTotales || 0}</td>
      <td><span class="badge bg-${f.realizada ? "success" : "secondary"}">${f.realizada ? "Realizada" : "Pendiente"}</span></td>
      <td>${f.errores.length ? f.errores.join("; ") : (f.advertencia ? `⚠️ ${f.advertencia}` : "OK")}</td>
    </tr>`).join("") || `<tr><td colspan="14" class="text-muted">Subí un archivo para ver la vista previa.</td></tr>`;

  document.getElementById("btn-importar-confirmar").disabled = validos === 0;
}

document.getElementById("btn-importar-confirmar").addEventListener("click", async () => {
  const btn = document.getElementById("btn-importar-confirmar");
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = "Importando...";

  let alumnosCreados = 0, practicasCreadas = 0, asistenciasCreadas = 0, omitidas = 0;
  const legajoAId = {};

  for (const f of filasImportar) {
    if (f.errores.length) { omitidas++; continue; }
    const legajoNorm = normalizarLegajo(f.datos.legajo);

    try {
      let alumnoId = f.alumnoExistente?.id || legajoAId[legajoNorm];
      if (!alumnoId) {
        // Alumno nuevo: se usa como id de documento el legajo/DNI
        // normalizado (en vez de un id al azar). setDoc con merge:true no
        // pisa nada si por algún motivo (ej. dos importaciones en paralelo)
        // el documento ya existiera con ese mismo id: sencillamente no
        // duplica al alumno.
        alumnoId = idAlumnoDesdeLegajo(f.datos.legajo);
        if (!alumnoId) { omitidas++; continue; }
        await setDoc(doc(db, "alumnos", alumnoId), {
          legajo: f.datos.legajo.trim(),
          nombre: (f.datos.nombre || "").trim(),
          apellido: (f.datos.apellido || "").trim(),
          email: (f.datos.email || "").trim(),
          curso: (f.datos.curso || "").trim(),
          sector: (f.datos.sector || "").trim(),
        }, { merge: true });
        legajoAId[legajoNorm] = alumnoId;
        alumnosCreados++;
      }

      await addDoc(collection(db, "practicas"), {
        alumnoId,
        lugar: (f.datos.lugar || "").trim(),
        tipo: normalizarTipo(f.datos.tipo),
        realizada: f.realizada,
        sector: (f.datos.sector || "").trim(),
        fecha: f.fechaISO,
        fechaFin: f.fechaFinISO || "",
        horaInicio: f.datos.horaInicio || "",
        horaFin: f.datos.horaFin || "",
        horasPorDia: f.horasPorDia,
        diasPorSemana: f.diasPorSemana,
        horasTotales: f.horasTotales,
        tutorResponsable: (f.datos.tutorResponsable || "").trim(),
        tutorEmail: (f.datos.tutorEmail || "").trim(),
        contacto: (f.datos.contacto || "").trim(),
        notas: (f.datos.notas || "Importado desde planilla").trim(),
      });
      practicasCreadas++;

      const presente = normalizarPresente(f.datos.presente);
      if (presente !== null) {
        await addDoc(collection(db, "asistencias"), {
          alumnoId,
          fecha: f.fechaISO,
          lugar: (f.datos.lugar || "").trim(),
          tipo: normalizarTipo(f.datos.tipo),
          presente,
          horaEntrada: f.datos.horaInicio || "",
          horaSalida: f.datos.horaFin || "",
          observaciones: (f.datos.observacionesAsistencia || "").trim(),
        });
        asistenciasCreadas++;
      }
    } catch (err) {
      omitidas++;
    }
  }

  cacheAlumnos = []; // forzar recarga de la lista de alumnos en el resto de la app
  await registrarLugaresSiNuevos(filasImportar.map(f => f.datos.lugar));
  mostrarAlerta(
    `Importación terminada. Alumnos nuevos: ${alumnosCreados}. Prácticas cargadas: ${practicasCreadas}. Asistencias cargadas: ${asistenciasCreadas}. Filas omitidas: ${omitidas}.`,
    "success"
  );

  filasImportar = [];
  renderPreviewImportar();
  document.getElementById("importar-archivo").value = "";
  btn.textContent = textoOriginal;
});

// ------------------------------------------------------- FUSIONAR DUPLICADOS -
// Agrupa alumnos que probablemente son la misma persona: mismo legajo
// normalizado (normalizarLegajo, que ignora ceros a la izquierda y
// separadores) O mismo nombre y apellido normalizados. Se usa un union-find
// simple para que, si A matchea con B por legajo y B matchea con C por
// nombre, los tres terminen en un solo grupo.
function buscarGruposDuplicados(alumnos) {
  const padre = {};
  alumnos.forEach(a => { padre[a.id] = a.id; });
  function encontrar(x) { while (padre[x] !== x) x = padre[x]; return x; }
  function unir(x, y) { const rx = encontrar(x), ry = encontrar(y); if (rx !== ry) padre[rx] = ry; }

  const porLegajo = {}, porNombre = {};
  alumnos.forEach(a => {
    const lk = normalizarLegajo(a.legajo);
    if (lk) { if (porLegajo[lk] !== undefined) unir(a.id, porLegajo[lk]); else porLegajo[lk] = a.id; }
    const nk = `${normalizarTexto(a.apellido)}|${normalizarTexto(a.nombre)}`;
    if (nk !== "|") { if (porNombre[nk] !== undefined) unir(a.id, porNombre[nk]); else porNombre[nk] = a.id; }
  });

  const grupos = {};
  alumnos.forEach(a => { (grupos[encontrar(a.id)] ||= []).push(a); });
  return Object.values(grupos).filter(g => g.length > 1);
}

async function cargarDuplicados() {
  document.getElementById("duplicados-resumen").textContent = "Buscando...";
  const [alumnos, practicasSnap, asistSnap, faltasSnap] = await Promise.all([
    obtenerAlumnos(true),
    getDocs(collection(db, "practicas")),
    getDocs(collection(db, "asistencias")),
    getDocs(collection(db, "faltas")),
  ]);
  const practicas = practicasSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const asistencias = asistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const faltas = faltasSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const grupos = buscarGruposDuplicados(alumnos);
  ultimosGruposDuplicados = { grupos, practicas, asistencias, faltas };

  document.getElementById("duplicados-resumen").innerHTML = grupos.length
    ? `Se encontraron <strong>${grupos.length}</strong> posible(s) grupo(s) de alumnos duplicados.`
    : "No se encontraron alumnos duplicados (mismo legajo o mismo nombre y apellido). Si sabés que hay uno y no aparece, puede que el nombre esté escrito distinto en cada registro.";

  document.getElementById("duplicados-lista").innerHTML = grupos.map((g, gi) => {
    const filas = g.map(a => {
      const propias = practicas.filter(p => p.alumnoId === a.id);
      const horasRealizadas = propias.filter(practicaRealizada).reduce((s, p) => s + (parseFloat(p.horasTotales) || 0), 0);
      const horasPendientes = propias.filter(p => !practicaRealizada(p)).reduce((s, p) => s + (parseFloat(p.horasTotales) || 0), 0);
      const nAsist = asistencias.filter(x => x.alumnoId === a.id).length;
      const nFaltas = faltas.filter(x => x.alumnoId === a.id).length;
      return { a, propias, horasRealizadas, horasPendientes, nAsist, nFaltas };
    });
    // sugerido para "mantener": el que tiene más prácticas cargadas y, si hay empate, más horas realizadas
    let sugeridoIdx = 0;
    filas.forEach((f, i) => {
      const s = filas[sugeridoIdx];
      if (f.propias.length > s.propias.length || (f.propias.length === s.propias.length && f.horasRealizadas > s.horasRealizadas)) sugeridoIdx = i;
    });
    const totalHoras = filas.reduce((s, f) => s + f.horasRealizadas, 0);
    const totalPracticas = filas.reduce((s, f) => s + f.propias.length, 0);

    return `
      <div class="card p-3 mb-3 shadow-sm">
        <div class="d-flex justify-content-between align-items-start mb-2">
          <h6 class="mb-0">Grupo ${gi + 1}: ${nombreCompleto(g[0])}</h6>
          <span class="badge bg-secondary">${g.length} registros</span>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-bordered mb-2">
            <thead>
              <tr><th>Mantener</th><th>Legajo</th><th>Nombre</th><th>Curso</th><th>Prácticas</th><th>Hs. realizadas</th><th>Hs. pendientes</th><th>Asist.</th><th>Faltas</th></tr>
            </thead>
            <tbody>
              ${filas.map((f, i) => `
                <tr>
                  <td><input type="radio" name="mantener-${gi}" value="${f.a.id}" ${i === sugeridoIdx ? "checked" : ""}></td>
                  <td>${f.a.legajo || ""}</td>
                  <td>${nombreCompleto(f.a)}</td>
                  <td>${f.a.curso || ""}</td>
                  <td>${f.propias.length}</td>
                  <td>${f.horasRealizadas.toFixed(1)}</td>
                  <td>${f.horasPendientes.toFixed(1)}</td>
                  <td>${f.nAsist}</td>
                  <td>${f.nFaltas}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="text-muted small mb-2">
          Si fusionás este grupo, el registro que quede va a sumar <strong>${totalHoras.toFixed(1)} hs realizadas</strong> en <strong>${totalPracticas} práctica(s)</strong> en total.
        </div>
        <button type="button" class="btn btn-primary btn-sm" onclick="window.fusionarGrupo(${gi})">Fusionar en el marcado</button>
      </div>`;
  }).join("");
}

document.getElementById("btn-buscar-duplicados").addEventListener("click", cargarDuplicados);

window.fusionarGrupo = async (gi) => {
  const { grupos, practicas, asistencias, faltas } = ultimosGruposDuplicados || {};
  const g = grupos?.[gi];
  if (!g) return;

  const radio = document.querySelector(`input[name="mantener-${gi}"]:checked`);
  if (!radio) { mostrarAlerta("Elegí a cuál registro mantener antes de fusionar.", "warning"); return; }
  const idPrincipal = radio.value;
  const principal = g.find(a => a.id === idPrincipal);
  const otros = g.filter(a => a.id !== idPrincipal);

  const confirmacion = confirm(
    `Se van a pasar todas las prácticas, asistencias y faltas de ${otros.map(nombreCompleto).join(", ")} a ${nombreCompleto(principal)}, ` +
    `y esos ${otros.length} registro(s) duplicado(s) se van a borrar. Esta acción no se puede deshacer. ¿Confirmás?`
  );
  if (!confirmacion) return;

  try {
    const idsOtros = new Set(otros.map(a => a.id));
    const reasignaciones = [
      ...practicas.filter(p => idsOtros.has(p.alumnoId)).map(p => updateDoc(doc(db, "practicas", p.id), { alumnoId: idPrincipal })),
      ...asistencias.filter(x => idsOtros.has(x.alumnoId)).map(x => updateDoc(doc(db, "asistencias", x.id), { alumnoId: idPrincipal })),
      ...faltas.filter(x => idsOtros.has(x.alumnoId)).map(x => updateDoc(doc(db, "faltas", x.id), { alumnoId: idPrincipal })),
    ];
    await Promise.all(reasignaciones);

    // Completa datos vacíos del registro que se mantiene con datos de los duplicados (no pisa lo que ya tenía)
    const relleno = {};
    ["email", "sector", "curso", "legajo"].forEach(campo => {
      if (!principal[campo]) {
        const conDato = otros.find(o => o[campo]);
        if (conDato) relleno[campo] = conDato[campo];
      }
    });
    if (Object.keys(relleno).length) await updateDoc(doc(db, "alumnos", idPrincipal), relleno);

    await Promise.all(otros.map(a => deleteDoc(doc(db, "alumnos", a.id))));

    cacheAlumnos = [];
    mostrarAlerta(`Listo: ${otros.length} registro(s) duplicado(s) se unificaron en ${nombreCompleto(principal)}.`);
    await cargarDuplicados();
  } catch (err) {
    mostrarAlerta("No se pudo completar la fusión. Probá de nuevo.", "danger");
  }
};

// Exportaciones: todas usan el mismo escritor y conservan números y tildes.
function numeroHoras(valor) {
  const numero = Number(typeof valor === "string" ? valor.replace(",", ".") : valor);
  return Number.isFinite(numero) && numero >= 0 ? numero : 0;
}
function exportarLibro(nombreArchivo, hojas) {
  if (!window.XLSX) { mostrarAlerta("No se cargó el componente de Excel. Revisá la conexión y recargá la página.", "danger"); return false; }
  try {
    const wb = XLSX.utils.book_new();
    for (const hoja of hojas) {
      const datos = [hoja.encabezados, ...hoja.filas];
      const ws = XLSX.utils.aoa_to_sheet(datos);
      ws["!cols"] = hoja.encabezados.map((h, i) => ({ wch: Math.min(55, datos.reduce((max, f) => Math.max(max, Math.min(55, String(f[i] ?? "").length + 2)), 12)) }));
      if (hoja.filas.length) ws["!autofilter"] = { ref: ws["!ref"] };
      XLSX.utils.book_append_sheet(wb, ws, hoja.nombre);
    }
    XLSX.writeFile(wb, nombreArchivo);
    return true;
  } catch (err) { mostrarAlerta(`No se pudo generar Excel: ${err.message || err}`, "danger"); return false; }
}
function filaPractica(p) {
  return [p.id, fmtFecha(p.fecha), fmtFecha(p.fechaFin || p.fecha), p.lugar || "", p.sector || "", infoTipo(p.tipo).label,
    estadoPractica(p), numeroHoras(p.horasTotales),
    p.horaInicio || "", p.horaFin || "", p.tutorResponsable || "", p.contacto || ""];
}
const columnasPractica = ["ID práctica", "Inicio", "Fin", "Lugar", "Sector / carrera", "Tipo de práctica", "Estado", "Horas", "Entrada", "Salida", "Tutor", "Contacto"];

async function accionExportar(btn, accion) {
  if (btn.disabled) return;
  btn.disabled = true;
  try { await accion(); }
  catch (err) { mostrarAlerta(`No se pudo exportar: ${err.message || err}`, "danger"); }
  finally { btn.disabled = false; }
}

document.getElementById("btn-exportar-resumen").addEventListener("click", e => accionExportar(e.currentTarget, async () => {
  await cargarResumenPracticas();
  const grupos = ultimosResumenPracticas;
  if (!grupos.length) { mostrarAlerta("No hay prácticas para esos filtros.", "warning"); return; }
  exportarLibro(`resumen_practicas_${hoyISO()}.xlsx`, [
    { nombre: "Resumen por lugar", encabezados: ["Lugar", "Tipos", "Alumnos", "Horas realizadas", "Alumnos con algún informe", "Alumnos con faltas en período"],
      filas: grupos.map(g => [g.lugar, g.tipos.map(t => infoTipo(t).label).join(", "), g.totalAlumnos, g.totalHoras, g.totalInformes, g.totalConFaltas]) },
    { nombre: "Detalle por alumno", encabezados: ["Lugar", "Alumno", "Legajo", "Períodos", "Horas realizadas", "Alguna asistencia registrada", "Algún informe vinculado", "Días de falta en período"],
      filas: grupos.flatMap(g => g.detalle.map(d => [g.lugar, d.alumno ? nombreCompleto(d.alumno) : "Alumno no encontrado", d.alumno?.legajo || "", d.periodos.map(fmtRangoFechas).join("; "), d.horasRealizadas, d.asistio ? "Sí" : "Sin registro", d.informe ? "Sí" : "No", d.faltas])) },
    { nombre: "Períodos", encabezados: ["Alumno", ...columnasPractica],
      filas: grupos.flatMap(g => g.detalle.flatMap(d => d.periodos.map(p => [d.alumno ? nombreCompleto(d.alumno) : "Alumno no encontrado", ...filaPractica(p)]))) },
    { nombre: "Criterios", encabezados: ["Criterio", "Valor"], filas: [
      ["Generado", new Date().toLocaleString("es-AR")],
      ...["rp-lugar", "rp-tipo", "rp-desde", "rp-hasta"].map(id => [id, document.getElementById(id).value || "Todos"]),
      ["Horas", "Totales del período completo que se superpone con el filtro; no prorrateados"],
      ["Faltas", "Fechas de falta del alumno dentro del período; el registro original no identifica lugar/práctica"],
      ["Informes", "Algún informe vinculado no significa que todos los períodos estén cubiertos"],
    ] },
  ]);
}));

document.getElementById("btn-exportar-ficha").addEventListener("click", e => accionExportar(e.currentTarget, async () => {
  const id = document.getElementById("alumno-id").value;
  if (!id) { mostrarAlerta("Primero guardá el alumno.", "warning"); return; }
  const [alumnos, practicas, asistencias, faltas, informes] = await Promise.all([
    obtenerAlumnos(true), obtenerPracticas(),
    getDocs(query(collection(db, "asistencias"), where("alumnoId", "==", id))),
    getDocs(query(collection(db, "faltas"), where("alumnoId", "==", id))),
    getDocs(query(collection(db, "informes"), where("alumnoId", "==", id))),
  ]);
  const a = alumnos.find(a => a.id === id);
  if (!a) throw new Error("El alumno ya no existe.");
  const propias = practicas.filter(p => p.alumnoId === id);
  const realizadas = propias.filter(practicaRealizada).reduce((t, p) => t + numeroHoras(p.horasTotales), 0);
  const pendientes = propias.filter(p => !practicaRealizada(p)).reduce((t, p) => t + numeroHoras(p.horasTotales), 0);
  const registros = snap => snap.docs.map(d => d.data()).sort((a, b) => String(a.fecha || "").localeCompare(String(b.fecha || "")));
  const nombre = String(a.legajo || a.id).replace(/[^\p{L}\p{N}_-]/gu, "_");
  exportarLibro(`ficha_${nombre}_${hoyISO()}.xlsx`, [
    { nombre: "Ficha", encabezados: ["Dato", "Valor"], filas: [["Alumno", nombreCompleto(a)], ["Legajo", a.legajo || ""], ["Curso", a.curso || ""], ["Sector", a.sector || ""], ["Email", a.email || ""], ["Horas realizadas", realizadas], ["Horas pendientes estimadas", pendientes], ["Cantidad de prácticas", propias.length], ["Generado", new Date().toLocaleString("es-AR")], ["Criterio", "Horas tomadas de prácticas; asistencias y faltas no se suman ni descuentan automáticamente."]] },
    { nombre: "Prácticas", encabezados: columnasPractica, filas: propias.map(filaPractica) },
    { nombre: "Asistencias", encabezados: ["Fecha", "Lugar", "Tipo", "Estado", "Entrada", "Salida", "Observaciones"], filas: registros(asistencias).map(r => [fmtFecha(r.fecha), r.lugar || "", infoTipo(r.tipo).label, ESTADOS_ASISTENCIA[r.estado] || (r.presente ? "Presente" : "Ausente injustificado"), r.horaEntrada || "", r.horaSalida || "", r.observaciones || ""]) },
    { nombre: "Faltas", encabezados: ["Fecha", "Justificada", "Motivo"], filas: registros(faltas).map(r => [fmtFecha(r.fecha), r.justificada ? "Sí" : "No", r.motivo || ""]) },
    { nombre: "Informes", encabezados: ["Fecha", "Título", "Práctica vinculada", "Enlace"], filas: registros(informes).map(r => [fmtFecha(r.fecha), r.titulo || "", r.practicaId || "", r.enlaceDrive || ""]) },
  ]);
}));

for (const [boton, coleccion, filtro] of [["btn-exportar-asistencias", "asistencias", "asist-filtro-alumno"], ["btn-exportar-faltas", "faltas", "falta-filtro-alumno"]]) {
  document.getElementById(boton).addEventListener("click", e => accionExportar(e.currentTarget, async () => {
    const id = document.getElementById(filtro).value;
    const [alumnos, snap] = await Promise.all([obtenerAlumnos(), getDocs(id ? query(collection(db, coleccion), where("alumnoId", "==", id)) : collection(db, coleccion))]);
    const mapa = Object.fromEntries(alumnos.map(a => [a.id, a]));
    const filas = snap.docs.map(d => d.data()).sort((a, b) => String(a.fecha || "").localeCompare(String(b.fecha || "")));
    const asistencia = coleccion === "asistencias";
    exportarXLSX(`${coleccion}_${hoyISO()}.xlsx`, asistencia ? "Asistencias" : "Faltas",
      ["Fecha", "Alumno", "Legajo", ...(asistencia ? ["Lugar", "Estado", "Entrada", "Salida", "Observaciones"] : ["Justificada", "Motivo"])],
      filas.map(r => [fmtFecha(r.fecha), mapa[r.alumnoId] ? nombreCompleto(mapa[r.alumnoId]) : r.alumnoId, mapa[r.alumnoId]?.legajo || "", ...(asistencia ? [r.lugar || "", ESTADOS_ASISTENCIA[r.estado] || (r.presente ? "Presente" : "Ausente injustificado"), r.horaEntrada || "", r.horaSalida || "", r.observaciones || ""] : [r.justificada ? "Sí" : "No", r.motivo || ""])]));
  }));
}
