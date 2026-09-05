import { firebaseConfig, emailjsConfig } from "./firebase-config.js";
import { initApp as initDrive, buscarEnDrive, cargarTodosLosInformes } from "./drive.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  getDocs, getDoc, query, orderBy, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

if (window.emailjs && emailjsConfig.publicKey !== "TU_PUBLIC_KEY") {
  window.emailjs.init({ publicKey: emailjsConfig.publicKey });
}

let usuarioActual = null; // { uid, nombre, rol, email }
let cacheAlumnos = [];    // se recarga al entrar a cada vista que la necesita
let cacheLugares = [];    // catálogo de lugares para el combo desplegable de "Lugar"
let practicaOrigenAlumnoId = null; // si no es null, el formulario de práctica se abrió desde la ficha de ese alumno
let ultimosAlumnosFiltrados = [];  // para exportar lo que se ve en pantalla
let ultimasPracticasFiltradas = [];
let ultimasFilasEstadisticas = [];

// ---------------------------------------------------------- helpers UI ---
function mostrarAlerta(mensaje, tipo = "success") {
  const cont = document.getElementById("alertas");
  const div = document.createElement("div");
  div.className = `alert alert-${tipo} alert-dismissible fade show`;
  div.innerHTML = `${mensaje}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
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
  const ws = XLSX.utils.aoa_to_sheet([encabezados, ...filas]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, nombreHoja);
  XLSX.writeFile(wb, nombreArchivo);
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
function calcularHorasTotalesAutomatico(fechaISO, fechaFinISO, horasPorDia, diasPorSemana) {
  if (!fechaISO || !horasPorDia) return 0;
  const dias = diasEntreISO(fechaISO, fechaFinISO);
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

function abrirModal(id) {
  new bootstrap.Modal(document.getElementById(id)).show();
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
    faltas: cargarFaltas,
    asistencia: cargarAsistencia,
    notificaciones: cargarNotificaciones,
    usuarios: cargarUsuarios,
    drive: () => {},
    importar: () => {},
  };
  cargadores[nombre]?.();
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
    revisarYEnviarNotificacionesAutomaticas();
  } else {
    usuarioActual = null;
    document.getElementById("app-shell").classList.add("d-none");
    document.getElementById("login-view").classList.remove("d-none");
  }
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
  const practicas = await obtenerPracticas();
  const propias = practicas.filter(p => p.alumnoId === alumnoId).sort((a, b) => b.fecha.localeCompare(a.fecha));
  document.getElementById("tabla-alumno-practicas").innerHTML = propias.map(p => `
    <tr>
      <td>${fmtRangoFechas(p)}</td><td>${p.lugar}</td>
      <td>${badgeTipo(p.tipo)}</td>
      <td><span class="badge bg-${p.realizada !== false ? "success" : "secondary"}">${p.realizada !== false ? "Realizada" : "Pendiente"}</span></td>
      <td>${p.horasTotales}</td>
      <td>
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="window.editarPractica('${p.id}', true)">Editar</button>
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="window.eliminarPractica('${p.id}', true)">Eliminar</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="6" class="text-muted">Este alumno todavía no tiene prácticas cargadas.</td></tr>`;
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
  await llenarSelectAlumnos(document.getElementById("practica-alumno"), alumnoId);
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
  if (id) {
    await updateDoc(doc(db, "alumnos", id), datos);
  } else {
    await addDoc(collection(db, "alumnos"), datos);
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
    const horas = p.horasTotales || 0;
    acumPorAlumno[p.alumnoId].totalHoras += horas;
    if (p.realizada !== false) acumPorAlumno[p.alumnoId].horasRealizadas += horas;
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

  ultimasPracticasFiltradas = practicas;

  const chkTodas = document.getElementById("chk-todas-practicas");
  if (chkTodas) chkTodas.checked = false;

  document.getElementById("tabla-practicas").innerHTML = practicas.map(p => {
    const acum = acumPorAlumno[p.alumnoId] || { totalHoras: 0, horasRealizadas: 0 };
    const pendiente = p.realizada === false;
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
      <td><span class="badge bg-${!pendiente ? "success" : "secondary"}">${!pendiente ? "Realizada" : "Pendiente"}</span></td>
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
          ? `<span title="Calculado solo a partir de horas x día, días/sem y el rango de fechas">${(p.horasTotales || 0).toFixed(1)}</span>`
          : `<input type="number" step="0.5" min="0" class="form-control form-control-sm" style="width:90px"
              value="${p.horasTotales || 0}" title="Horas totales reales de esta práctica"
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
  const horasPorDia = parseFloat(valor) || 0;
  const p = ultimasPracticasFiltradas.find(x => x.id === id);
  const cambios = { horasPorDia };
  if (p && p.realizada === false) {
    cambios.horasTotales = calcularHorasTotalesAutomatico(p.fecha, p.fechaFin, horasPorDia, p.diasPorSemana ?? 5);
  }
  await updateDoc(doc(db, "practicas", id), cambios);
  mostrarAlerta("Horas x día actualizadas.");
  cargarPracticas();
};

// Edición rápida de "días por semana". Misma lógica: recalcula el total solo
// si la práctica sigue pendiente.
window.actualizarDiasSemana = async (id, valor) => {
  let diasPorSemana = parseFloat(valor) || 5;
  diasPorSemana = Math.min(7, Math.max(1, diasPorSemana));
  const p = ultimasPracticasFiltradas.find(x => x.id === id);
  const cambios = { diasPorSemana };
  if (p && p.realizada === false) {
    cambios.horasTotales = calcularHorasTotalesAutomatico(p.fecha, p.fechaFin, p.horasPorDia ?? p.horasTotales ?? 0, diasPorSemana);
  }
  await updateDoc(doc(db, "practicas", id), cambios);
  mostrarAlerta("Días por semana actualizados.");
  cargarPracticas();
};

// Edición rápida de "horas totales" para prácticas YA REALIZADAS: acá el
// valor se carga a mano (o vino de una importación) y no se recalcula solo.
window.actualizarHorasTotalesReal = async (id, valor) => {
  const horasTotales = parseFloat(valor) || 0;
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
  const acumPorAlumno = {};
  ultimasPracticasFiltradas.forEach(p => {
    if (!p.alumnoId) return;
    if (!acumPorAlumno[p.alumnoId]) acumPorAlumno[p.alumnoId] = { totalHoras: 0, horasRealizadas: 0 };
  });
  const filas = ultimasPracticasFiltradas.map(p => [
    fmtFecha(p.fecha), p.fechaFin ? fmtFecha(p.fechaFin) : "",
    p.alumno ? nombreCompleto(p.alumno) : "", p.alumno?.legajo || "",
    p.lugar || "", infoTipo(p.tipo).label, p.realizada !== false ? "Realizada" : "Pendiente", p.sector || "",
    p.horaInicio || "", p.horaFin || "", p.horasPorDia ?? p.horasTotales ?? 0, p.diasPorSemana ?? 5,
    p.horasTotales || 0,
    "", "",
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
  const realizada = document.getElementById("practica-realizada").checked;
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
    inputTotales.value = calcularHorasTotalesAutomatico(fecha, fechaFin, horasPorDia, diasPorSemana);
    inputTotales.readOnly = true;
    inputTotales.classList.add("bg-light");
    ayuda.textContent = "Calculado solo a partir de \"Horas x día\", \"Días por semana\" y el rango de fechas. Se recalcula mientras la práctica esté pendiente.";
  }
}
["practica-fecha", "practica-fecha-fin", "practica-horas-dia", "practica-dias-semana"].forEach(id => {
  document.getElementById(id).addEventListener("input", actualizarPreviewHorasTotales);
});
document.getElementById("practica-realizada").addEventListener("change", actualizarPreviewHorasTotales);

document.getElementById("btn-nueva-practica").addEventListener("click", async () => {
  practicaOrigenAlumnoId = null;
  document.getElementById("form-practica").reset();
  document.getElementById("practica-id").value = "";
  document.getElementById("practica-dias-semana").value = 5;
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
  document.getElementById("practica-horas-totales").value = p.horasTotales ?? 0;
  document.getElementById("practica-realizada").checked = p.realizada !== false;
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
  const realizada = document.getElementById("practica-realizada").checked;
  const horasPorDia = parseFloat(document.getElementById("practica-horas-dia").value || 0);
  const diasPorSemana = parseFloat(document.getElementById("practica-dias-semana").value || 5);
  // Pendiente: las horas totales se calculan solas. Realizada: se usa el
  // valor cargado a mano (o importado) en "Horas totales de esta práctica".
  const horasTotales = realizada
    ? parseFloat(document.getElementById("practica-horas-totales").value || 0)
    : calcularHorasTotalesAutomatico(fecha, fechaFin, horasPorDia, diasPorSemana);
  const datos = {
    alumnoId: document.getElementById("practica-alumno").value,
    lugar: document.getElementById("practica-lugar").value.trim(),
    tipo: document.getElementById("practica-tipo").value,
    sector: document.getElementById("practica-sector").value.trim(),
    fecha,
    fechaFin,
    horaInicio: document.getElementById("practica-inicio").value,
    horaFin: document.getElementById("practica-fin").value,
    horasPorDia,
    diasPorSemana,
    horasTotales,
    realizada,
    tutorResponsable: document.getElementById("practica-tutor").value.trim(),
    tutorEmail: document.getElementById("practica-tutor-email").value.trim(),
    contacto: document.getElementById("practica-contacto").value.trim(),
    notas: document.getElementById("practica-notas").value.trim(),
  };
  if (id) {
    await updateDoc(doc(db, "practicas", id), datos);
  } else {
    await addDoc(collection(db, "practicas"), datos);
  }
  await registrarLugarSiNuevo(datos.lugar);
  cerrarModal("modal-practica");
  mostrarAlerta("Fecha de práctica guardada.");
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
async function cargarInformes() {
  const alumnos = await obtenerAlumnos();
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const snap = await getDocs(query(collection(db, "informes"), orderBy("fechaPresentacion", "desc")));
  const informes = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  document.getElementById("tabla-informes").innerHTML = informes.map(i => `
    <tr>
      <td>${mapaAlumnos[i.alumnoId] ? nombreCompleto(mapaAlumnos[i.alumnoId]) : "-"}</td>
      <td>${i.titulo}</td><td>${fmtFecha(i.fechaPresentacion)}</td>
      <td><span class="badge badge-estado-${i.estado}">${i.estado}</span></td>
      <td>${i.enlaceDrive ? `<a href="${i.enlaceDrive}" target="_blank">Ver archivo</a>` : ""}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="text-muted">No hay informes registrados.</td></tr>`;
}

document.getElementById("btn-nuevo-informe").addEventListener("click", async () => {
  document.getElementById("form-informe").reset();
  await llenarSelectAlumnos(document.getElementById("informe-alumno"));
  abrirModal("modal-informe");
});

document.getElementById("form-informe").addEventListener("submit", async (e) => {
  e.preventDefault();
  const datos = {
    alumnoId: document.getElementById("informe-alumno").value,
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

// ------------------------------------------------------------------ DRIVE
// Nombre corto y prolijo para el tipo de archivo, en vez del mimeType crudo.
function tipoArchivoLegible(mimeType) {
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "Word (.docx)";
  if (mimeType === "application/msword") return "Word (.doc)";
  return mimeType;
}

function renderTablaDrive(archivos) {
  document.getElementById("tabla-drive").innerHTML = archivos.map(f => `
    <tr>
      <td>${f.curso || "-"}</td>
      <td>${f.alumno || "-"}</td>
      <td>${f.nombre}</td>
      <td>${tipoArchivoLegible(f.mimeType)}</td>
      <td>${new Date(f.modifiedTime).toLocaleString()}</td>
      <td><a href="${f.webViewLink}" target="_blank" class="btn btn-sm btn-outline-secondary">Abrir</a></td>
    </tr>`).join("") || `<tr><td colspan="6" class="text-muted">Sin resultados.</td></tr>`;
}

document.getElementById("btn-drive-login").addEventListener("click", () => initDrive());

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
async function cargarAsistencia() {
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
  registros = registros.slice(0, 100);

  const chkTodas = document.getElementById("chk-todas-asistencia");
  if (chkTodas) chkTodas.checked = false;

  document.getElementById("tabla-asistencia").innerHTML = registros.map(r => `
    <tr>
      <td><input type="checkbox" class="chk-asistencia" value="${r.id}"></td>
      <td>${fmtFecha(r.fecha)}</td><td>${mapaAlumnos[r.alumnoId] ? nombreCompleto(mapaAlumnos[r.alumnoId]) : "-"}</td>
      <td>${r.lugar || ""}</td><td>${r.tipo ? badgeTipo(r.tipo) : ""}</td>
      <td>${r.presente ? "Sí" : "No"}</td><td>${r.horaEntrada || ""}</td><td>${r.horaSalida || ""}</td><td>${r.observaciones || ""}</td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="window.eliminarAsistencia('${r.id}')">Eliminar</button></td>
    </tr>`).join("") || `<tr><td colspan="10" class="text-muted">No hay registros de asistencia.</td></tr>`;
}

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
  await addDoc(collection(db, "asistencias"), {
    alumnoId: document.getElementById("asist-alumno").value,
    fecha: document.getElementById("asist-fecha").value,
    lugar,
    tipo: document.getElementById("asist-tipo").value,
    presente: document.getElementById("asist-presente").checked,
    horaEntrada: document.getElementById("asist-entrada").value,
    horaSalida: document.getElementById("asist-salida").value,
    observaciones: document.getElementById("asist-obs").value.trim(),
  });
  await registrarLugarSiNuevo(lugar);
  document.getElementById("form-asistencia").reset();
  document.getElementById("asist-presente").checked = true;
  mostrarAlerta("Asistencia registrada.");
  cargarAsistencia();
});

// ------------------------------------------------------- NOTIFICACIONES -
function emailjsConfigCompleta() {
  return emailjsConfig.publicKey !== "TU_PUBLIC_KEY"
    && emailjsConfig.serviceId !== "TU_SERVICE_ID"
    && emailjsConfig.templateId !== "TU_TEMPLATE_ID";
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
  await setDoc(doc(db, "configuracion", "notificaciones"), { diasAviso, ccEmail, automatico });
  mostrarAlerta("Configuración de avisos guardada.");
  renderProximasYHistorial();
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
    .filter(p => p.fecha >= hoy && p.fecha <= limite)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  document.getElementById("tabla-notif-proximas").innerHTML = proximas.map(p => `
    <tr>
      <td>${fmtFecha(p.fecha)}</td>
      <td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td>
      <td>${mapaAlumnos[p.alumnoId]?.email || "(sin email)"}</td>
      <td>${p.lugar}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="text-muted">No hay prácticas próximas en ese rango.</td></tr>`;

  document.getElementById("btn-notif-enviar").dataset.proximas = JSON.stringify(proximas);

  const histSnap = await getDocs(query(collection(db, "notificaciones_log"), orderBy("fechaEnvio", "desc")));
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

document.getElementById("btn-notif-enviar").addEventListener("click", async (e) => {
  const proximas = JSON.parse(e.target.dataset.proximas || "[]");
  const alumnos = await obtenerAlumnos();
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));

  if (!window.emailjs || !emailjsConfigCompleta()) {
    mostrarAlerta("Falta configurar EmailJS (publicKey, serviceId y templateId) en js/firebase-config.js (ver README).", "warning");
    return;
  }
  if (!proximas.length) {
    mostrarAlerta("No hay prácticas próximas para notificar en este rango de días.", "warning");
    return;
  }

  const config = await obtenerConfigNotificaciones();
  const mensajeAdicional = document.getElementById("notif-mensaje").value.trim();
  const ccOverride = document.getElementById("notif-cc").value.trim();
  const ccPorDefecto = ccOverride || config.ccEmail || "";
  const archivoAdjunto = document.getElementById("notif-adjunto").files[0] || null;

  let adjuntoBase64 = "";
  if (archivoAdjunto) {
    try {
      adjuntoBase64 = await leerArchivoComoBase64(archivoAdjunto);
    } catch (err) {
      mostrarAlerta("No se pudo leer el PDF adjunto, se enviará sin adjunto.", "warning");
    }
  }

  const btn = document.getElementById("btn-notif-enviar");
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = "Enviando...";

  let enviados = 0, errores = 0;
  for (const p of proximas) {
    const alumno = mapaAlumnos[p.alumnoId];
    let estado = "error", detalle = "Alumno sin email cargado";
    if (alumno?.email) {
      const params = {
        to_email: alumno.email,
        to_name: alumno.nombre,
        lugar: p.lugar,
        fecha: fmtFecha(p.fecha),
        horario: `${p.horaInicio || ""} - ${p.horaFin || ""}`,
        tutor: p.tutorResponsable || "",
        contacto: p.contacto || "",
        cc_email: ccPorDefecto || p.tutorEmail || "",
        mensaje_adicional: mensajeAdicional,
      };
      if (adjuntoBase64) {
        params.adjunto_acuerdo = adjuntoBase64;
        params.adjunto_nombre = archivoAdjunto.name;
      }
      try {
        await window.emailjs.send(emailjsConfig.serviceId, emailjsConfig.templateId, params);
        estado = "enviado";
        detalle = params.cc_email ? `Con copia a ${params.cc_email}` : "";
        enviados++;
      } catch (err) {
        detalle = "Error al enviar el mail"; errores++;
      }
    } else { errores++; }

    if (estado === "enviado") {
      // Evita que el revisor automático vuelva a avisar por esta misma práctica.
      await updateDoc(doc(db, "practicas", p.id), { avisoAutomaticoEnviado: true }).catch(() => {});
    }
    await addDoc(collection(db, "notificaciones_log"), {
      alumnoId: p.alumnoId, practicaId: p.id, tipo: "recordatorio_practica",
      origen: "manual", estado, detalle, fechaEnvio: new Date().toISOString(),
    });
  }

  btn.disabled = false;
  btn.textContent = textoOriginal;
  mostrarAlerta(`Notificaciones enviadas: ${enviados}. Errores: ${errores}.`, "info");
  cargarNotificaciones();
});

// Revisión automática: se llama una vez al iniciar sesión. Si el envío
// automático está habilitado en la configuración, busca prácticas pendientes
// dentro de la cantidad de días configurada que todavía no se avisaron, y las
// manda solas (con el CC fijo configurado). Como esta app no tiene backend
// propio, esto se dispara cuando alguien abre el sistema con sesión iniciada
// (una vez por día por navegador), no en un horario fijo del día.
async function revisarYEnviarNotificacionesAutomaticas() {
  try {
    const hoy = hoyISO();
    if (localStorage.getItem("ultimaRevisionNotifAuto") === hoy) return;

    const config = await obtenerConfigNotificaciones();
    if (!config.automatico) { localStorage.setItem("ultimaRevisionNotifAuto", hoy); return; }
    if (!window.emailjs || !emailjsConfigCompleta()) return;

    const limite = sumarDiasISO(hoy, config.diasAviso ?? 3);
    const alumnos = await obtenerAlumnos();
    const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));

    const snap = await getDocs(collection(db, "practicas"));
    const pendientesDeAviso = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.fecha >= hoy && p.fecha <= limite && p.realizada === false && !p.avisoAutomaticoEnviado);

    localStorage.setItem("ultimaRevisionNotifAuto", hoy);
    if (!pendientesDeAviso.length) return;

    let enviados = 0;
    for (const p of pendientesDeAviso) {
      const alumno = mapaAlumnos[p.alumnoId];
      let estado = "error", detalle = "Alumno sin email cargado";
      if (alumno?.email) {
        const params = {
          to_email: alumno.email,
          to_name: alumno.nombre,
          lugar: p.lugar,
          fecha: fmtFecha(p.fecha),
          horario: `${p.horaInicio || ""} - ${p.horaFin || ""}`,
          tutor: p.tutorResponsable || "",
          contacto: p.contacto || "",
          cc_email: config.ccEmail || p.tutorEmail || "",
          mensaje_adicional: "",
        };
        try {
          await window.emailjs.send(emailjsConfig.serviceId, emailjsConfig.templateId, params);
          estado = "enviado";
          detalle = params.cc_email ? `Con copia a ${params.cc_email}` : "";
          enviados++;
        } catch (err) {
          detalle = "Error al enviar el mail";
        }
      }
      if (estado === "enviado") {
        await updateDoc(doc(db, "practicas", p.id), { avisoAutomaticoEnviado: true }).catch(() => {});
      }
      await addDoc(collection(db, "notificaciones_log"), {
        alumnoId: p.alumnoId, practicaId: p.id, tipo: "recordatorio_practica",
        origen: "automatico", estado, detalle, fechaEnvio: new Date().toISOString(),
      });
    }
    if (enviados) mostrarAlerta(`Se enviaron ${enviados} aviso(s) automático(s) de prácticas próximas.`, "info");
  } catch (err) {
    console.error("Error revisando notificaciones automáticas", err);
  }
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

  const totalHoras = practicas.reduce((acc, p) => acc + (p.realizada !== false ? (p.horasTotales || 0) : 0), 0);
  document.getElementById("stat-horas").textContent = totalHoras.toFixed(1);
  document.getElementById("stat-alumnos").textContent = alumnos.length;
  document.getElementById("stat-practicas").textContent = practicas.length;

  const porSector = {};
  practicas.filter(p => p.realizada !== false).forEach(p => {
    const s = p.sector || "Sin sector";
    porSector[s] = (porSector[s] || 0) + (p.horasTotales || 0);
  });
  document.getElementById("tabla-horas-sector").innerHTML = Object.entries(porSector)
    .map(([s, h]) => `<tr><td>${s}</td><td>${h.toFixed(1)}</td></tr>`).join("")
    || `<tr><td colspan="2" class="text-muted">Todavía no hay prácticas cargadas.</td></tr>`;

  const hoy = hoyISO();
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const proximas = practicas
    .map((p, idx) => ({ ...p, id: snap.docs[idx].id }))
    .filter(p => (p.fechaFin || p.fecha) >= hoy)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(0, 5);
  document.getElementById("tabla-proximas").innerHTML = proximas.map(p => `
    <tr><td>${fmtRangoFechas(p)}</td><td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td><td>${p.lugar}</td></tr>
  `).join("") || `<tr><td colspan="3" class="text-muted">No hay prácticas próximas.</td></tr>`;
}

// --------------------------------------------------------- ESTADISTICAS -
async function cargarEstadisticas() {
  const alumnos = await obtenerAlumnos(true);
  const snap = await getDocs(collection(db, "practicas"));
  const practicas = snap.docs.map(d => d.data());
  const objetivo = parseFloat(document.getElementById("estad-objetivo").value || "200") || 0;

  const porAlumno = {};
  alumnos.forEach(a => {
    porAlumno[a.id] = { alumno: a, horasRealizadas: 0, horasPendientes: 0, horasInterna: 0, horasExterna: 0, horasInterescolar: 0, cantidad: 0 };
  });

  let totalRealizadas = 0, totalPendientes = 0, totalInterna = 0, totalExterna = 0, totalInterescolar = 0;
  practicas.forEach(p => {
    const horas = p.horasTotales || 0;
    const esRealizada = p.realizada !== false; // sin dato = compatibilidad con carga manual previa

    if (esRealizada) {
      totalRealizadas += horas;
      if (p.tipo === "externa") totalExterna += horas;
      else if (p.tipo === "interescolar") totalInterescolar += horas;
      else totalInterna += horas;
    } else {
      totalPendientes += horas;
    }

    const registro = porAlumno[p.alumnoId];
    if (registro) {
      registro.cantidad += 1;
      if (esRealizada) {
        registro.horasRealizadas += horas;
        if (p.tipo === "externa") registro.horasExterna += horas;
        else if (p.tipo === "interescolar") registro.horasInterescolar += horas;
        else registro.horasInterna += horas;
      } else {
        registro.horasPendientes += horas;
      }
    }
  });

  const filas = Object.values(porAlumno);
  const promedioPct = filas.length
    ? filas.reduce((acc, f) => acc + (objetivo > 0 ? Math.min(100, (f.horasRealizadas / objetivo) * 100) : 0), 0) / filas.length
    : 0;

  document.getElementById("estad-total-alumnos").textContent = alumnos.length;
  document.getElementById("estad-promedio").textContent = `${promedioPct.toFixed(0)}%`;
  document.getElementById("estad-horas-realizadas").textContent = totalRealizadas.toFixed(1);
  document.getElementById("estad-horas-pendientes").textContent = totalPendientes.toFixed(1);
  document.getElementById("estad-horas-internas").textContent = totalInterna.toFixed(1);
  document.getElementById("estad-horas-externas").textContent = totalExterna.toFixed(1);
  const elInterescolar = document.getElementById("estad-horas-interescolar");
  if (elInterescolar) elInterescolar.textContent = totalInterescolar.toFixed(1);

  // Buscador por alumno: solo filtra la tabla de detalle, las tarjetas de
  // arriba siguen mostrando los totales generales.
  const fBusqueda = document.getElementById("estad-buscar-alumno")?.value.trim().toLowerCase() || "";
  const filasVisibles = fBusqueda
    ? filas.filter(f => `${nombreCompleto(f.alumno)} ${f.alumno.legajo}`.toLowerCase().includes(fBusqueda))
    : filas;
  ultimasFilasEstadisticas = filasVisibles;

  document.getElementById("tabla-estadisticas").innerHTML = filasVisibles
    .sort((a, b) => nombreCompleto(a.alumno).localeCompare(nombreCompleto(b.alumno)))
    .map(f => {
      const pct = objetivo > 0 ? Math.min(100, (f.horasRealizadas / objetivo) * 100) : 0;
      const faltan = Math.max(0, objetivo - f.horasRealizadas);
      const color = pct >= 100 ? "bg-success" : pct >= 50 ? "bg-warning" : "bg-danger";
      return `
      <tr>
        <td>${nombreCompleto(f.alumno)}</td>
        <td>${f.alumno.legajo}</td>
        <td>${f.horasRealizadas.toFixed(1)}</td>
        <td>${f.horasPendientes.toFixed(1)}</td>
        <td>${f.horasInterna.toFixed(1)}</td>
        <td>${f.horasExterna.toFixed(1)}</td>
        <td>${f.horasInterescolar.toFixed(1)}</td>
        <td>${f.cantidad}</td>
        <td>
          <div class="progress" style="height: 18px;">
            <div class="progress-bar ${color}" style="width:${pct}%">${pct.toFixed(0)}%</div>
          </div>
        </td>
        <td>${faltan.toFixed(1)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="10" class="text-muted">No se encontraron alumnos con ese criterio.</td></tr>`;
}

document.getElementById("btn-estad-actualizar").addEventListener("click", cargarEstadisticas);
document.getElementById("estad-buscar-alumno")?.addEventListener("input", cargarEstadisticas);

document.getElementById("btn-estad-exportar")?.addEventListener("click", () => {
  if (!ultimasFilasEstadisticas.length) { mostrarAlerta("No hay datos para exportar.", "warning"); return; }
  const objetivo = parseFloat(document.getElementById("estad-objetivo").value || "200") || 0;
  const encabezados = ["Alumno", "Legajo", "Horas realizadas", "Horas pendientes", "Internas", "Externas",
    "Interescolares", "Cant. prácticas", "% cumplido", "Horas faltantes"];
  const filas = ultimasFilasEstadisticas.map(f => {
    const pct = objetivo > 0 ? Math.min(100, (f.horasRealizadas / objetivo) * 100) : 0;
    const faltan = Math.max(0, objetivo - f.horasRealizadas);
    return [nombreCompleto(f.alumno), f.alumno.legajo, f.horasRealizadas, f.horasPendientes,
      f.horasInterna, f.horasExterna, f.horasInterescolar, f.cantidad, `${pct.toFixed(0)}%`, faltan];
  });
  exportarXLSX("estadisticas.xlsx", "Estadísticas", encabezados, filas);
});

// ---------------------------------------------------------- IMPORTAR ----
let filasImportar = []; // filas ya parseadas del archivo, con validación

function normalizarTexto(s) {
  return (s ?? "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
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
  const porLegajo = Object.fromEntries(alumnos.map(a => [normalizarTexto(a.legajo), a]));

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

    const alumnoExistente = datos.legajo ? porLegajo[normalizarTexto(datos.legajo)] : null;
    if (!alumnoExistente && datos.legajo && (!datos.apellido || !datos.nombre)) {
      errores.push("Alumno nuevo: falta apellido y/o nombre");
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
      alumnoExistente, esAlumnoNuevo: !alumnoExistente, errores,
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
    <tr class="${f.errores.length ? "table-danger" : (f.esAlumnoNuevo ? "table-warning" : "")}">
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
      <td>${f.errores.length ? f.errores.join("; ") : "OK"}</td>
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
    const legajoNorm = normalizarTexto(f.datos.legajo);

    try {
      let alumnoId = f.alumnoExistente?.id || legajoAId[legajoNorm];
      if (!alumnoId) {
        const ref = await addDoc(collection(db, "alumnos"), {
          legajo: f.datos.legajo.trim(),
          nombre: (f.datos.nombre || "").trim(),
          apellido: (f.datos.apellido || "").trim(),
          email: (f.datos.email || "").trim(),
          curso: (f.datos.curso || "").trim(),
          sector: (f.datos.sector || "").trim(),
        });
        alumnoId = ref.id;
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
