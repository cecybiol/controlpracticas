import { firebaseConfig, emailjsConfig } from "./firebase-config.js";
import { initApp as initDrive, buscarEnDrive } from "./drive.js";

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
  } else {
    usuarioActual = null;
    document.getElementById("app-shell").classList.add("d-none");
    document.getElementById("login-view").classList.remove("d-none");
  }
});

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

  document.getElementById("tabla-alumnos").innerHTML = filtrados.map(a => `
    <tr>
      <td>${a.legajo}</td><td>${nombreCompleto(a)}</td><td>${a.curso || ""}</td><td>${a.sector || ""}</td><td>${a.email || ""}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary" onclick="window.editarAlumno('${a.id}')">Ficha / Editar</button>
        <button class="btn btn-sm btn-outline-danger" onclick="window.eliminarAlumno('${a.id}')">Eliminar</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="6" class="text-muted">No hay alumnos cargados.</td></tr>`;
}

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
      <td>${fmtFecha(p.fecha)}</td><td>${p.lugar}</td>
      <td>${badgeTipo(p.tipo)}</td>
      <td><span class="badge bg-${p.realizada !== false ? "success" : "secondary"}">${p.realizada !== false ? "Realizada" : "Pendiente"}</span></td>
      <td>${p.horasTotales}</td>
      <td>
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="window.editarPractica('${p.id}')">Editar</button>
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
    if (fDesde && p.fecha < fDesde) return false;
    if (fHasta && p.fecha > fHasta) return false;
    return true;
  });

  document.getElementById("tabla-practicas").innerHTML = practicas.map(p => {
    const acum = acumPorAlumno[p.alumnoId] || { totalHoras: 0, horasRealizadas: 0 };
    const horasDiaRealizadas = p.realizada !== false ? (p.horasTotales || 0) : 0;
    return `
    <tr>
      <td>${fmtFecha(p.fecha)}</td><td>${p.alumno ? nombreCompleto(p.alumno) : "-"}</td>
      <td>${p.lugar}</td>
      <td>${badgeTipo(p.tipo)}</td>
      <td><span class="badge bg-${p.realizada !== false ? "success" : "secondary"}">${p.realizada !== false ? "Realizada" : "Pendiente"}</span></td>
      <td>${p.sector || ""}</td>
      <td>${p.horaInicio || ""} - ${p.horaFin || ""}</td>
      <td>${(p.horasTotales || 0).toFixed(1)}</td>
      <td>${horasDiaRealizadas.toFixed(1)}</td>
      <td>${acum.horasRealizadas.toFixed(1)}</td>
      <td>${acum.totalHoras.toFixed(1)}</td>
      <td>${p.tutorResponsable || ""}</td><td>${p.contacto || ""}</td>
      <td><button class="btn btn-sm btn-outline-secondary" onclick="window.editarPractica('${p.id}')">Editar</button></td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="window.eliminarPractica('${p.id}')">Eliminar</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="15" class="text-muted">No se encontraron prácticas.</td></tr>`;
}

document.getElementById("btn-filtrar-practicas").addEventListener("click", cargarPracticas);
document.getElementById("btn-limpiar-practicas").addEventListener("click", () => {
  ["f-alumno", "f-lugar", "f-tutor", "f-sector", "f-desde", "f-hasta"].forEach(id => document.getElementById(id).value = "");
  cargarPracticas();
});

document.getElementById("btn-nueva-practica").addEventListener("click", async () => {
  document.getElementById("form-practica").reset();
  document.getElementById("practica-id").value = "";
  await llenarSelectAlumnos(document.getElementById("practica-alumno"));
  abrirModal("modal-practica");
});

window.editarPractica = async (id) => {
  const practicas = await obtenerPracticas();
  const p = practicas.find(x => x.id === id);
  document.getElementById("practica-id").value = p.id;
  await llenarSelectAlumnos(document.getElementById("practica-alumno"), p.alumnoId);
  document.getElementById("practica-lugar").value = p.lugar;
  document.getElementById("practica-tipo").value = p.tipo === "externa" ? "externa" : "interna";
  document.getElementById("practica-sector").value = p.sector || "";
  document.getElementById("practica-fecha").value = p.fecha;
  document.getElementById("practica-inicio").value = p.horaInicio || "";
  document.getElementById("practica-fin").value = p.horaFin || "";
  document.getElementById("practica-horas").value = p.horasTotales || 0;
  document.getElementById("practica-realizada").checked = p.realizada !== false;
  document.getElementById("practica-tutor").value = p.tutorResponsable || "";
  document.getElementById("practica-tutor-email").value = p.tutorEmail || "";
  document.getElementById("practica-contacto").value = p.contacto || "";
  document.getElementById("practica-notas").value = p.notas || "";
  abrirModal("modal-practica");
};

document.getElementById("form-practica").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("practica-id").value;
  const datos = {
    alumnoId: document.getElementById("practica-alumno").value,
    lugar: document.getElementById("practica-lugar").value.trim(),
    tipo: document.getElementById("practica-tipo").value,
    sector: document.getElementById("practica-sector").value.trim(),
    fecha: document.getElementById("practica-fecha").value,
    horaInicio: document.getElementById("practica-inicio").value,
    horaFin: document.getElementById("practica-fin").value,
    horasTotales: parseFloat(document.getElementById("practica-horas").value || 0),
    realizada: document.getElementById("practica-realizada").checked,
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
  cerrarModal("modal-practica");
  mostrarAlerta("Fecha de práctica guardada.");
  cargarPracticas();
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
document.getElementById("btn-drive-login").addEventListener("click", () => initDrive());
document.getElementById("form-drive-buscar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query_ = document.getElementById("drive-query").value.trim();
  const estado = document.getElementById("drive-estado");
  estado.textContent = "Buscando...";
  try {
    const archivos = await buscarEnDrive(query_);
    estado.textContent = archivos.length ? "" : "Sin resultados.";
    document.getElementById("tabla-drive").innerHTML = archivos.map(f => `
      <tr>
        <td>${f.name}</td><td>${f.mimeType}</td><td>${new Date(f.modifiedTime).toLocaleString()}</td>
        <td><a href="${f.webViewLink}" target="_blank" class="btn btn-sm btn-outline-secondary">Abrir</a></td>
      </tr>`).join("");
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

  document.getElementById("tabla-faltas").innerHTML = faltas.map(f => `
    <tr>
      <td>${fmtFecha(f.fecha)}</td><td>${mapaAlumnos[f.alumnoId] ? nombreCompleto(mapaAlumnos[f.alumnoId]) : "-"}</td>
      <td>${f.justificada ? "Sí" : "No"}</td><td>${f.motivo || ""}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="text-muted">No hay faltas registradas.</td></tr>`;
}

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

  document.getElementById("tabla-asistencia").innerHTML = registros.map(r => `
    <tr>
      <td>${fmtFecha(r.fecha)}</td><td>${mapaAlumnos[r.alumnoId] ? nombreCompleto(mapaAlumnos[r.alumnoId]) : "-"}</td>
      <td>${r.lugar || ""}</td><td>${r.tipo ? badgeTipo(r.tipo) : ""}</td>
      <td>${r.presente ? "Sí" : "No"}</td><td>${r.horaEntrada || ""}</td><td>${r.horaSalida || ""}</td><td>${r.observaciones || ""}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="text-muted">No hay registros de asistencia.</td></tr>`;
}

document.getElementById("asist-filtro-alumno").addEventListener("change", cargarAsistencia);

// Si para ese alumno y esa fecha ya hay una práctica cargada, se autocompletan
// lugar y tipo (se pueden editar igual antes de guardar).
async function autocompletarAsistenciaDesdePractica() {
  const alumnoId = document.getElementById("asist-alumno").value;
  const fecha = document.getElementById("asist-fecha").value;
  if (!alumnoId || !fecha) return;
  const practicas = await obtenerPracticas();
  const practica = practicas.find(p => p.alumnoId === alumnoId && p.fecha === fecha);
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
  await addDoc(collection(db, "asistencias"), {
    alumnoId: document.getElementById("asist-alumno").value,
    fecha: document.getElementById("asist-fecha").value,
    lugar: document.getElementById("asist-lugar").value.trim(),
    tipo: document.getElementById("asist-tipo").value,
    presente: document.getElementById("asist-presente").checked,
    horaEntrada: document.getElementById("asist-entrada").value,
    horaSalida: document.getElementById("asist-salida").value,
    observaciones: document.getElementById("asist-obs").value.trim(),
  });
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

async function cargarNotificaciones() {
  actualizarAlertaConfigNotif();
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
      <td><span class="badge bg-${h.estado === "enviado" ? "success" : "danger"}">${h.estado}</span></td>
      <td>${h.detalle || "-"}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="text-muted">Sin envíos todavía.</td></tr>`;
}

document.getElementById("btn-notif-actualizar").addEventListener("click", cargarNotificaciones);

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

  const mensajeAdicional = document.getElementById("notif-mensaje").value.trim();
  const ccManual = document.getElementById("notif-cc").value.trim();
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
        cc_email: ccManual || p.tutorEmail || "",
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

    await addDoc(collection(db, "notificaciones_log"), {
      alumnoId: p.alumnoId, practicaId: p.id, tipo: "recordatorio_practica",
      estado, detalle, fechaEnvio: new Date().toISOString(),
    });
  }

  btn.disabled = false;
  btn.textContent = textoOriginal;
  mostrarAlerta(`Notificaciones enviadas: ${enviados}. Errores: ${errores}.`, "info");
  cargarNotificaciones();
});

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
    .filter(p => p.fecha >= hoy)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(0, 5);
  document.getElementById("tabla-proximas").innerHTML = proximas.map(p => `
    <tr><td>${fmtFecha(p.fecha)}</td><td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td><td>${p.lugar}</td></tr>
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

  document.getElementById("tabla-estadisticas").innerHTML = filas
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
    }).join("") || `<tr><td colspan="10" class="text-muted">Todavía no hay alumnos o prácticas cargadas.</td></tr>`;
}

document.getElementById("btn-estad-actualizar").addEventListener("click", cargarEstadisticas);

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
  { key: "fecha", alias: ["fecha", "fecha (aaaa-mm-dd)"] },
  { key: "horaInicio", alias: ["hora inicio", "inicio"] },
  { key: "horaFin", alias: ["hora fin", "fin"] },
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
// 1) columna "Estado" explícita, 2) columna "Presente", 3) si no hay dato, se infiere por la fecha.
function determinarRealizada(datos, fechaISO) {
  if (datos.estado !== undefined && datos.estado !== "") {
    const v = normalizarTexto(datos.estado);
    if (["realizada", "hecha", "cumplida", "si", "sí", "1", "true"].includes(v)) return true;
    if (["pendiente", "programada", "por realizar", "no", "0", "false"].includes(v)) return false;
  }
  const presente = normalizarPresente(datos.presente);
  if (presente !== null) return presente;
  const hoy = hoyISO();
  return !fechaISO || fechaISO <= hoy;
}

document.getElementById("btn-importar-plantilla").addEventListener("click", () => {
  const encabezados = ["Legajo", "Apellido", "Nombre", "Email", "Curso / División", "Sector / Carrera", "Lugar de práctica",
    "Tipo (interna/externa/interescolar)", "Fecha (AAAA-MM-DD)", "Hora inicio", "Hora fin", "Horas totales",
    "Tutor responsable", "Email tutor", "Contacto", "Presente (si/no)", "Estado (realizada/pendiente)",
    "Observaciones asistencia", "Notas práctica"];
  const ejemplo = ["1234", "Gómez", "Ana", "ana@mail.com", "5to Enfermería", "Enfermería", "Hospital Central", "interna",
    "2026-09-15", "08:00", "12:00", "4", "Lic. Pérez", "perez@escuela.edu.ar", "011-555-1234", "si", "realizada", "Llegó puntual", "Primer día"];
  const ws = XLSX.utils.aoa_to_sheet([encabezados, ejemplo]);
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

    const alumnoExistente = datos.legajo ? porLegajo[normalizarTexto(datos.legajo)] : null;
    if (!alumnoExistente && datos.legajo && (!datos.apellido || !datos.nombre)) {
      errores.push("Alumno nuevo: falta apellido y/o nombre");
    }

    const realizada = determinarRealizada(datos, fechaISO);

    return { fila: idx + 2, datos, fechaISO, realizada, alumnoExistente, esAlumnoNuevo: !alumnoExistente, errores };
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
      <td>${f.datos.horasTotales || ""}</td>
      <td><span class="badge bg-${f.realizada ? "success" : "secondary"}">${f.realizada ? "Realizada" : "Pendiente"}</span></td>
      <td>${f.errores.length ? f.errores.join("; ") : "OK"}</td>
    </tr>`).join("") || `<tr><td colspan="11" class="text-muted">Subí un archivo para ver la vista previa.</td></tr>`;

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
        horaInicio: f.datos.horaInicio || "",
        horaFin: f.datos.horaFin || "",
        horasTotales: parseFloat(f.datos.horasTotales || 0) || 0,
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
  mostrarAlerta(
    `Importación terminada. Alumnos nuevos: ${alumnosCreados}. Prácticas cargadas: ${practicasCreadas}. Asistencias cargadas: ${asistenciasCreadas}. Filas omitidas: ${omitidas}.`,
    "success"
  );

  filasImportar = [];
  renderPreviewImportar();
  document.getElementById("importar-archivo").value = "";
  btn.textContent = textoOriginal;
});
