import { firebaseConfig } from "./firebase-config.js";
import { initApp as initDrive, buscarEnDrive, cargarTodosLosInformes } from "./drive.js";

import { clock, addDays, datesFor, daysFor, calendarState, calculatePractice, manualHours, attendanceId, attendanceState, attendanceMatches, dayHours, targets, notificationCandidates, parseDays, validDate, num, duration, practiceId, expectedAgreementNames, validEmail } from "./domain.mjs";
import { createPager, pageSpec, searchText, searchableFields } from "./record-pages.mjs";
import { createFirestoreAccess, firestoreMessage } from "./firestore-access.mjs";
import { synchronizeAttendance, validateAttendance } from "./attendance-store.mjs";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc as sdkAddDoc, updateDoc as sdkUpdateDoc, deleteDoc as sdkDeleteDoc,
  getDocs as sdkGetDocs, getDoc as sdkGetDoc, query, orderBy, setDoc as sdkSetDoc, where, limit, runTransaction as sdkRunTransaction, writeBatch as sdkWriteBatch, queryEqual, refEqual, startAfter, documentId,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const firestoreAccess = createFirestoreAccess({getDocs:sdkGetDocs,getDoc:sdkGetDoc,queryEqual,refEqual},{maxEntries:120});
const {getDocs,getDoc}=firestoreAccess;
// Toda escritura local invalida lecturas; nunca conservar datos de otro usuario.
async function mutate(fn,args){firestoreAccess.guard();try{return await fn(...args);}catch(err){firestoreAccess.failed(err);throw err;}finally{firestoreAccess.clear();resetRecordPages();ultimaSincronizacion=0;}}
function indexedArgs(args,complete=false){const [ref,data,...rest]=args,path=ref.path||'',name=path.split('/')[0],input={...data};if(complete&&name==='practicas'&&input.fecha&&!input.fechaFin)input.fechaFin=input.fecha;return [ref,{...input,...searchableFields(name,input)},...rest];}
const addDoc=(...args)=>mutate(sdkAddDoc,indexedArgs(args,true)),updateDoc=(...args)=>mutate(sdkUpdateDoc,indexedArgs(args)),deleteDoc=(...args)=>mutate(sdkDeleteDoc,args),setDoc=(...args)=>mutate(sdkSetDoc,indexedArgs(args,true));
const runTransaction=(...args)=>mutate(sdkRunTransaction,args);
function writeBatch(...args){const batch=sdkWriteBatch(...args),commit=batch.commit.bind(batch);batch.commit=(...xs)=>mutate(commit,xs);for(const method of ["set","update"]){const original=batch[method].bind(batch);batch[method]=(...xs)=>original(...indexedArgs(xs,method==="set"));}return batch;}
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
let ultimosGruposCorrelativos = null; // prácticas de jornadas consecutivas listas para agrupar por semana
let ultimoCalculoEstadisticas = [];
let estadOrden = { campo: "nombre", asc: true };
let objetivoHoras = { interna: 0, externa: 0, interescolar: 0 };

// Listados acotados; historial completo sólo en consultas explícitas de horas/informes.
const recordPagers=new Map(),studentChoices=new Map();
function resetRecordPages(){for(const pager of recordPagers.values())pager.reset();recordPagers.clear();}
const valueOf=id=>document.getElementById(id)?.value.trim()||'';
const rowData=d=>({id:d.id,...d.data()});
function delayed(fn,ms=450){let timer;return()=>{clearTimeout(timer);timer=setTimeout(()=>Promise.resolve(fn()).catch(e=>mostrarAlerta(firestoreMessage(e),'danger')),ms);};}
function queryFor(spec,cursor=null,size=null){const clauses=spec.filters.map(([field,op,value])=>where(field==='__name__'?documentId():field,op,value));for(const [field,dir] of spec.order)clauses.push(orderBy(field==='__name__'?documentId():field,dir));if(cursor)clauses.push(startAfter(cursor));if(size)clauses.push(limit(size));return query(collection(db,spec.collection),...clauses);}
async function recordsPage(tableId,spec,move,loader){
 let pager=recordPagers.get(tableId);if(!pager){pager=createPager(async(spec,cursor,size)=>(await getDocs(queryFor(spec,cursor,size))).docs);recordPagers.set(tableId,pager);}
 const page=await pager.load(spec,typeof move==='number'?move:0);if(!page)return null;
 const body=document.getElementById(tableId);body.dataset.remotePage='true';
 let nav=document.getElementById(tableId+'-remote-nav');if(!nav){nav=document.createElement('div');nav.id=tableId+'-remote-nav';nav.className='d-flex align-items-center gap-2 flex-wrap my-2';body.closest('table').insertAdjacentElement('afterend',nav);}
 nav.innerHTML=`<button class="btn btn-sm btn-outline-secondary" ${page.previous?'':'disabled'}>Anterior</button><span class="small">Página ${page.number} · hasta 20 registros por consulta</span><button class="btn btn-sm btn-outline-secondary" ${page.more?'':'disabled'}>Siguiente</button><button class="btn btn-sm btn-outline-secondary">Actualizar</button>`;
 const buttons=nav.querySelectorAll('button');const act=async move=>{buttons.forEach(b=>b.disabled=true);try{await loader(move);}catch(err){mostrarAlerta(firestoreMessage(err),'danger');buttons.forEach(b=>b.disabled=false);}};
 buttons[0].onclick=()=>act(-1);buttons[1].onclick=()=>act(1);buttons[2].onclick=()=>{pager.reset();firestoreAccess.clear();act(0);};
 return page;
}
async function registroPorId(name,id){if(!id)return null;const snap=await getDoc(doc(db,name,id));return snap.exists()?rowData(snap):null;}
async function guardarPracticaConInformes(id,data,previous){
 if(previous?.lugar!==data.lugar){const related=await getDocs(query(collection(db,'informes'),where('practicaId','==',id)));if(related.docs.length>450)throw new Error('Esta práctica tiene más de 450 informes vinculados; requiere una actualización por tandas.');const batch=writeBatch(db);batch.update(doc(db,'practicas',id),data);for(const report of related.docs)batch.update(report.ref,{lugar:data.lugar||''});await batch.commit();}
 else await updateDoc(doc(db,'practicas',id),data);
}
async function relatedStudents(rows){
 const ids=[...new Set(rows.map(r=>r.alumnoId).filter(Boolean))],cached=[],missing=[];
 for(const id of ids){const result=firestoreAccess.cachedDoc(doc(db,'alumnos',id));if(result)cached.push(result);else missing.push(id);}
 const snapshots=await Promise.all(cached);
 for(let i=0;i<missing.length;i+=20){const snap=await getDocs(query(collection(db,'alumnos'),where(documentId(),'in',missing.slice(i,i+20)),limit(20)));snapshots.push(...snap.docs);}
 return Object.fromEntries(snapshots.filter(s=>s.exists()).map(s=>{const a=rowData(s);return [a.id,a];}));
}

function addStudentOptions(id,students){const select=document.getElementById(id);if(!select)return;const chosen=select.value;for(const a of students){if(![...select.options].some(o=>o.value===a.id)){const o=document.createElement('option');o.value=a.id;o.textContent=`${nombreCompleto(a)} (${a.legajo||''})`;select.append(o);}}select.value=chosen;}
function chosenStudent(id){const value=valueOf(id);if(!value)return '';const chosen=studentChoices.get(id)?.get(value);if(!chosen)throw new Error('Elegí el alumno entre las sugerencias de búsqueda. Podés buscar por apellido, nombre o legajo.');return chosen;}
function attachStudentSearch(id){
 const control=document.getElementById(id);if(!control)return;
 const isSelect=control.tagName==='SELECT',wrap=document.createElement('div');wrap.className='d-flex gap-1 flex-wrap mb-1';
 const mode=document.createElement('select');mode.className='form-select form-select-sm';mode.style.maxWidth='125px';mode.setAttribute('aria-label','Buscar alumno por');mode.innerHTML='<option value="apellido">Apellido</option><option value="nombre">Nombre</option><option value="legajo">Legajo</option>';
 const input=isSelect?document.createElement('input'):control;if(isSelect){input.className='form-control form-control-sm';input.placeholder='Buscar alumno…';input.setAttribute('aria-label','Buscar alumno');control.insertAdjacentElement('beforebegin',wrap);wrap.append(mode,input);}else{control.insertAdjacentElement('beforebegin',wrap);wrap.append(mode);}
 const datalist=document.createElement('datalist');datalist.id=id+'-resultados';input.setAttribute('list',datalist.id);input.insertAdjacentElement('afterend',datalist);
 let serial=0;const choices=new Map();studentChoices.set(id,choices);
 const search=delayed(async()=>{const term=input.value.trim(),token=++serial;if(!term||choices.has(term))return;if(term.length<2&&mode.value!=='legajo')return;
  const spec=pageSpec('alumnos',{prefix:term,searchField:'busqueda_'+mode.value});const snap=await getDocs(queryFor(spec,null,20));if(token!==serial||input.value.trim()!==term)return;
  datalist.replaceChildren();for(const a of snap.docs.map(rowData).filter(a=>!a.archivado)){const label=`${nombreCompleto(a)} (${a.legajo||a.id})`;choices.set(label,a.id);const option=document.createElement('option');option.value=label;datalist.append(option);if(isSelect)addStudentOptions(id,[a]);}
 });input.addEventListener('input',search);mode.onchange=()=>{serial++;datalist.replaceChildren();search();};
 if(isSelect)input.addEventListener('change',()=>{const chosen=choices.get(input.value);if(chosen){control.value=chosen;control.dispatchEvent(new window.Event('change'));}});
}
function attendanceSpec(){return pageSpec('asistencias',{equal:{fecha:valueOf('asist-filtro-fecha'),alumnoId:valueOf('asist-filtro-alumno'),lugar:valueOf('asist-filtro-lugar'),tipo:valueOf('asist-filtro-tipo'),estado:valueOf('asist-filtro-estado')},from:valueOf('asist-filtro-desde'),to:valueOf('asist-filtro-hasta')});}
async function readForStudents(name,ids){const unique=[...new Set(ids)].filter(Boolean),rows=[];for(let i=0;i<unique.length;i+=30){const snap=await getDocs(query(collection(db,name),where('alumnoId','in',unique.slice(i,i+30))));rows.push(...snap.docs.map(rowData));}return rows;}
async function practicasAlumno(id){
 const [practices,attendance]=await Promise.all([getDocs(query(collection(db,'practicas'),where('alumnoId','==',id))),getDocs(query(collection(db,'asistencias'),where('alumnoId','==',id)))]);
 const raw=practices.docs.map(rowData).filter(p=>!p.archivada),records=attendance.docs.map(rowData);return raw.map(p=>calculatePractice(p,records,raw));
}
window.consultarHorasPractica=async(id,alumnoId)=>{
 try{const own=await practicasAlumno(alumnoId),p=own.find(p=>p.id===id);if(!p)return false;
  const real=own.reduce((n,p)=>n+horasCumplidas(p),0),total=own.reduce((n,p)=>n+horasCumplidas(p)+horasPendientes(p),0);
  acumuladosPracticas[alumnoId]={horasRealizadas:real,totalHoras:total};
  for(const row of document.getElementById('tabla-practicas').querySelectorAll('[data-practica]')){const item=own.find(p=>p.id===row.dataset.practica);if(!item)continue;const hours=row.querySelector('[data-horas-practica]');if(hours)hours.textContent=`${horasCumplidas(item).toFixed(2)} / ${num(item.horasPlanificadas).toFixed(2)}${item.jornadasPendientes||item.conflictosAsistencia?' · revisar jornadas':''}`;row.querySelector('[data-acum-real]').textContent=real.toFixed(1);row.querySelector('[data-acum-total]').textContent=total.toFixed(1);}
  ultimasPracticasFiltradas=ultimasPracticasFiltradas.map(row=>own.find(p=>p.id===row.id)?{...row,...own.find(p=>p.id===row.id)}:row);return true;
 }catch(err){mostrarAlerta(firestoreMessage(err),'danger');return false;}
};

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
function hoyISO() { return clock().date; }

// Suma/resta días a una fecha AAAA-MM-DD sin pasar por UTC (mismo motivo que hoyISO).
function sumarDiasISO(fechaISO, dias) { return addDays(fechaISO, dias); }

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
function fechasProgramadas(fechaISO, fechaFinISO, diasSemana = []) { return datesFor({fecha:fechaISO,fechaFin:fechaFinISO,diasSemana,diasPorSemana:5}); }

function calcularHorasTotalesAutomatico(fechaISO, fechaFinISO, horasPorDia, diasPorSemana, diasSemana = []) {
  return +(datesFor({fecha:fechaISO,fechaFin:fechaFinISO,diasPorSemana,diasSemana}).length * num(horasPorDia)).toFixed(2);
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
  pendiente: "Pendiente de revisión",
  suprimido: "Jornada retirada",
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
function estadoPractica(p) { return p?.estadoCalculado || calendarState(p || {}); }
function practicaRealizada(p) { return estadoPractica(p) === "realizada"; }
function horasCumplidas(p) { return num(p?.horasRealizadas ?? (manualHours(p || {}) && practicaRealizada(p) ? p.horasTotales : 0)); }
function horasPendientes(p) { return estadoPractica(p) === "cancelada" ? 0 : num(p?.horasPendientes); }
function conHoras(p) { return horasCumplidas(p) > 0; }
function etiquetaEstado(p) { return ({programada:"Programada",en_curso:"En curso",realizada:"Realizada",cancelada:"Cancelada",pendiente_revision:"Revisar cronograma"})[estadoPractica(p)] || "Revisar"; }
async function lecturaPracticas() {
 const q=usuarioActual?.rol === "alumno" ? query(collection(db,"practicas"),where("alumnoId","==",usuarioActual.alumnoId||"__sin_alumno__")) : collection(db,"practicas");
 const snap=await getDocs(q);return snap.docs.map(d=>({id:d.id,...d.data()}));
}
async function lecturaAsistencias() {
 const q=usuarioActual?.rol === "alumno" ? query(collection(db,"asistencias"),where("alumnoId","==",usuarioActual.alumnoId||"__sin_alumno__")) : collection(db,"asistencias");
 const snap=await getDocs(q);return snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>!r.duplicadaEn);
}
async function enriquecerPracticas(raw,records=null) {
 records=records||await lecturaAsistencias();const live=raw.filter(p=>!p.archivada);
 return live.map(p=>calculatePractice(p,records,live));
}
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

// Paginación visual reutilizable: toda tabla extensa muestra 20 filas por página.
const PAGINA_TAM = 20;
function paginarTbody(tbody, pagina = 1) {
  if(tbody.dataset.remotePage)return;
  const filas = [...tbody.children].filter(x => x.tagName === "TR");
  const totalPaginas = Math.max(1, Math.ceil(filas.length / PAGINA_TAM));
  const actual = Math.min(Math.max(1, pagina), totalPaginas);
  filas.forEach((fila, i) => fila.classList.toggle("d-none", i < (actual - 1) * PAGINA_TAM || i >= actual * PAGINA_TAM));
  let nav = tbody.closest("table")?.parentElement?.querySelector(":scope > .paginacion-tabla");
  if (!nav) {
    nav = document.createElement("div"); nav.className = "paginacion-tabla";
    tbody.closest("table")?.insertAdjacentElement("afterend", nav);
  }
  nav.classList.toggle("d-none", filas.length <= PAGINA_TAM);
  nav.innerHTML = `<button class="btn btn-sm btn-outline-secondary" ${actual === 1 ? "disabled" : ""}>Anterior</button><span class="small">Página ${actual} de ${totalPaginas} · ${filas.length} registros</span><button class="btn btn-sm btn-outline-secondary" ${actual === totalPaginas ? "disabled" : ""}>Siguiente</button>`;
  const botones = nav.querySelectorAll("button");
  botones[0].onclick = () => paginarTbody(tbody, actual - 1);
  botones[1].onclick = () => paginarTbody(tbody, actual + 1);
}
function prepararTablasResponsivasYPaginadas() {
  document.querySelectorAll("table").forEach(tabla => {
    if (!tabla.parentElement.classList.contains("table-responsive")) {
      const wrap = document.createElement("div"); wrap.className = "table-responsive";
      tabla.parentNode.insertBefore(wrap, tabla); wrap.appendChild(tabla);
    }
  });
  document.querySelectorAll("tbody[id]").forEach(tbody => {
    paginarTbody(tbody, 1);
    new MutationObserver(() => paginarTbody(tbody, 1)).observe(tbody, { childList: true });
  });
}
prepararTablasResponsivasYPaginadas();

// Las tarjetas principales pueden contraerse para que las páginas extensas
// sean más fáciles de recorrer. Se excluyen filtros horizontales y tarjetas
// internas de indicadores para no alterar su grilla.
function prepararSeccionesDesplegables() {
  const tarjetas = [...new Set(document.querySelectorAll(".vista > .card:not(.row):not(.filtros-horizontales), .vista > form.card:not(.row), .vista .dashboard-widget:not(.row), .vista > .table-responsive"))];
  tarjetas.forEach((card, indice) => {
    if (card.dataset.desplegablePreparado) return;
    card.dataset.desplegablePreparado = "1";
    card.classList.add("seccion-colapsable");
    const titulo = card.querySelector("h3,h4,h5,h6")?.textContent.trim() || card.previousElementSibling?.textContent?.trim().slice(0,60) || `Sección ${indice + 1}`;
    const contenido = document.createElement("div"); contenido.className = "seccion-contenido";
    while (card.firstChild) contenido.appendChild(card.firstChild);
    const barra = document.createElement("div"); barra.className = "seccion-toggle-barra";
    const boton = document.createElement("button"); boton.type = "button"; boton.className = "btn btn-sm btn-outline-secondary";
    boton.textContent = `Contraer: ${titulo}`; boton.setAttribute("aria-expanded", "true");
    boton.addEventListener("click", () => {
      const cerrar = !contenido.classList.contains("d-none");
      contenido.classList.toggle("d-none", cerrar); card.classList.toggle("seccion-cerrada", cerrar);
      boton.textContent = `${cerrar ? "Desplegar" : "Contraer"}: ${titulo}`; boton.setAttribute("aria-expanded", String(!cerrar));
    });
    barra.appendChild(boton); card.append(barra, contenido);
  });
}
prepararSeccionesDesplegables();

function mostrarVista(nombre) {
  if (usuarioActual?.rol === "alumno" && !["mi-practica"].includes(nombre)) nombre = "mi-practica";
  document.querySelectorAll(".vista").forEach(v => v.classList.remove("activa"));
  document.getElementById(`vista-${nombre}`).classList.add("activa");
  document.querySelectorAll("[data-view]").forEach(a => a.classList.remove("active"));
  document.querySelector(`[data-view="${nombre}"]`)?.classList.add("active");
  cargarVista(nombre);
}

function cargarVista(nombre) {
  const cargadores = {
    dashboard: cargarDashboard,
    estadisticas: () => {},
    alumnos: cargarAlumnos,
    practicas: () => cargarPracticas(),
    informes: cargarInformes,
    resumen: () => {},
    faltas: cargarFaltas,
    asistencia: cargarAsistencia,
    notificaciones: cargarNotificaciones,
    usuarios: cargarUsuarios,
    drive: () => {},
    importar: () => {},
    duplicados: () => {},
    configuracion: cargarConfiguracion,
    "mi-practica": cargarMiPractica,
  };
  Promise.resolve().then(async () => { return cargadores[nombre]?.(); }).catch(err => mostrarAlerta(`No se pudo cargar la vista: ${firestoreMessage(err)}`, "danger"));
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
  firestoreAccess.reset();resetRecordPages();preparationCursors.clear();for(const choices of studentChoices.values())choices.clear();document.querySelectorAll('datalist[id$="-resultados"]').forEach(el=>el.replaceChildren()); cacheAlumnos=[];cacheLugares=[];ultimaSincronizacion=0;
  if (user) {
    let perfil = { nombre: user.email, rol: "sin_perfil" };
    try {
      const snap = await getDoc(doc(db, "usuarios", user.uid));
      if (snap.exists()) perfil = snap.data();
    } catch (e) {
      usuarioActual=null;
      document.getElementById("app-shell").classList.add("d-none");
      document.getElementById("login-view").classList.remove("d-none");
      const box=document.getElementById("login-error");box.textContent=firestoreMessage(e);box.classList.remove("d-none");return;
    }

    usuarioActual = { uid: user.uid, email: user.email, ...perfil };
    document.getElementById("usuario-actual").textContent = `${usuarioActual.nombre} (${usuarioActual.rol})`;
    document.querySelectorAll(".admin-only").forEach(el => {
      el.classList.toggle("d-none", usuarioActual.rol !== "admin");
    });
    document.querySelectorAll(".alumno-only").forEach(el => el.classList.toggle("d-none", usuarioActual.rol !== "alumno"));
    document.querySelectorAll("[data-view]").forEach(enlace => {
      const item = enlace.closest("li");
      if (!item || item.classList.contains("admin-only") || item.classList.contains("alumno-only")) return;
      item.classList.toggle("d-none", usuarioActual.rol === "alumno");
    });

    document.getElementById("login-view").classList.add("d-none");
    document.getElementById("app-shell").classList.remove("d-none");
    mostrarVista(usuarioActual.rol === "alumno" ? "mi-practica" : "dashboard");
    if (["admin","tutor"].includes(usuarioActual.rol)) {
      revisarYEnviarNotificacionesAutomaticas();
    }
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
  if(usuarioActual?.rol === "alumno") {
    const id=usuarioActual.alumnoId;if(!id)return [];
    const s=await getDoc(doc(db,"alumnos",id));cacheAlumnos=s.exists()&&!s.data().archivado?[{id:s.id,...s.data()}]:[];return cacheAlumnos;
  }
  const snap = await getDocs(query(collection(db, "alumnos"), orderBy("apellido")));
  cacheAlumnos = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a=>!a.archivado);
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
  if (selectEl.id === "practica-alumno") renderSelectorAlumnosPractica();
}

function renderSelectorAlumnosPractica() {
  const select = document.getElementById("practica-alumno");
  const cont = document.getElementById("practica-alumno-checks");
  const resumen = document.getElementById("practica-alumnos-seleccionados");
  if (!select || !cont || !resumen) return;
  const filtro = document.getElementById("practica-alumno-buscar")?.value.trim().toLowerCase() || "";
  cont.innerHTML = [...select.options].filter(o => o.textContent.toLowerCase().includes(filtro)).map(o => `<label><input type="checkbox" value="${escaparHTML(o.value)}" ${o.selected ? "checked" : ""}> <span>${escaparHTML(o.textContent)}</span></label>`).join("") || `<span class="text-muted small">No se encontraron alumnos.</span>`;
  cont.querySelectorAll("input").forEach(chk => chk.addEventListener("change", () => {
    const opcion = [...select.options].find(o => o.value === chk.value);
    if (opcion) opcion.selected = chk.checked;
    renderResumenAlumnosPractica();
  }));
  renderResumenAlumnosPractica();
}
function renderResumenAlumnosPractica() {
  const seleccionados = [...document.getElementById("practica-alumno").selectedOptions];
  document.getElementById("practica-alumnos-seleccionados").innerHTML = seleccionados.length
    ? seleccionados.map(o => `<span class="badge">${escaparHTML(o.textContent)}</span>`).join("")
    : `<span class="text-muted small">Todavía no seleccionaste alumnos.</span>`;
}
document.getElementById("practica-alumno-buscar")?.addEventListener("input", renderSelectorAlumnosPractica);

async function prepararListasPractica(p = {}) {
  const [lugares, recent] = await Promise.all([obtenerLugares().catch(() => []), getDocs(query(collection(db,"practicas"),orderBy("fecha","desc"),limit(20)))]);const practicas=recent.docs.map(rowData);
  const configurarLista = (selectId, nuevoId, ocultoId, valores, actual, etiquetaNuevo) => {
    const sel = document.getElementById(selectId), nuevo = document.getElementById(nuevoId), oculto = document.getElementById(ocultoId);
    const unicos = [...new Set(valores.filter(Boolean).map(v => String(v).trim()))].sort((a,b) => a.localeCompare(b));
    if (actual && !unicos.some(v => normalizarTexto(v) === normalizarTexto(actual))) unicos.unshift(actual);
    sel.innerHTML = `<option value="">Seleccionar...</option>` + unicos.map(v => `<option value="${escaparHTML(v)}">${escaparHTML(v)}</option>`).join("") + `<option value="__nuevo__">+ ${etiquetaNuevo}</option>`;
    sel.value = actual || ""; oculto.value = actual || "";
    nuevo.classList.add("d-none"); nuevo.value = "";
    const sincronizar = () => {
      const esNuevo = sel.value === "__nuevo__"; nuevo.classList.toggle("d-none", !esNuevo);
      oculto.value = esNuevo ? nuevo.value.trim() : sel.value;
    };
    sel.onchange = sincronizar; nuevo.oninput = sincronizar;
  };
  const nombresLugares = [...lugares.map(x => x.nombre), ...practicas.map(x => x.lugar)];
  configurarLista("practica-lugar-select", "practica-lugar-nuevo", "practica-lugar", nombresLugares, p.lugar || "", "Agregar nuevo lugar");
  configurarLista("practica-sector-select", "practica-sector-nuevo", "practica-sector", practicas.map(x => x.sector), p.sector || "", "Escribir otro sector");

  const tutores = new Map();
  practicas.filter(x => x.tutorResponsable).forEach(x => { const k=normalizarTexto(x.tutorResponsable); if(!tutores.has(k)) tutores.set(k, { nombre:x.tutorResponsable, email:x.tutorEmail || "", contacto:x.contacto || "" }); });
  if (p.tutorResponsable) tutores.set(normalizarTexto(p.tutorResponsable), { nombre:p.tutorResponsable, email:p.tutorEmail || "", contacto:p.contacto || "" });
  const tutorSel = document.getElementById("practica-tutor-select");
  tutorSel.innerHTML = `<option value="">Seleccionar...</option>` + [...tutores.values()].sort((a,b)=>a.nombre.localeCompare(b.nombre)).map(t => `<option value="${escaparHTML(t.nombre)}" data-email="${escaparHTML(t.email)}" data-contacto="${escaparHTML(t.contacto)}">${escaparHTML(t.nombre)}</option>`).join("") + `<option value="__nuevo__">+ Escribir otro tutor</option>`;
  tutorSel.value = p.tutorResponsable || "";
  const tutorInput = document.getElementById("practica-tutor"); tutorInput.value = p.tutorResponsable || ""; tutorInput.classList.toggle("d-none", !!p.tutorResponsable);
  tutorSel.onchange = () => {
    const nuevo = tutorSel.value === "__nuevo__";
    tutorInput.classList.toggle("d-none", !nuevo); tutorInput.value = nuevo ? "" : tutorSel.value;
    const op = tutorSel.selectedOptions[0];
    if (!nuevo && op) { document.getElementById("practica-tutor-email").value = op.dataset.email || ""; document.getElementById("practica-contacto").value = op.dataset.contacto || ""; }
  };
}

async function cargarAlumnos(move=0) {
  const spec=pageSpec('alumnos',{prefix:document.getElementById('alumno-filtro-texto').value,searchField:'busqueda_'+document.getElementById('alumno-buscar-campo').value,equal:{busqueda_curso:searchText(document.getElementById('alumno-filtro-curso').value)},direction:'asc'});
  const page=await recordsPage('tabla-alumnos',spec,move,cargarAlumnos);if(!page)return;
  const filtrados=page.docs.map(rowData).filter(a=>!a.archivado);
  ultimosAlumnosFiltrados = filtrados;

  const chkTodos = document.getElementById("chk-todos-alumnos");
  if (chkTodos) chkTodos.checked = false;

  document.getElementById("tabla-alumnos").innerHTML = filtrados.map(a => `
    <tr>
      <td><input type="checkbox" class="chk-alumno" value="${a.id}"></td>
      <td>${a.legajo}</td><td>${nombreCompleto(a)}</td><td>${a.curso || ""}</td><td>${a.sector || ""}</td><td>${a.email || ""}</td><td>${escaparHTML(a.telefono || "")}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary" onclick="window.editarAlumno('${a.id}')">Ficha / Editar</button>
        <button class="btn btn-sm btn-outline-danger" onclick="window.eliminarAlumno('${a.id}')">Eliminar</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="8" class="text-muted">No hay alumnos cargados.</td></tr>`;
}

document.getElementById("chk-todos-alumnos")?.addEventListener("change", (e) => {
  document.querySelectorAll(".chk-alumno").forEach(c => c.checked = e.target.checked);
});

async function archivarAlumnos(ids){
 const practicas=await readForStudents("practicas",ids);
 if(ids.length+practicas.length>450)throw new Error("Seleccioná menos alumnos: esta operación debe ser atómica.");
 const batch=writeBatch(db);
 ids.forEach(id=>batch.update(doc(db,"alumnos",id),{archivado:true}));
 practicas.forEach(p=>batch.update(doc(db,"practicas",p.id),{archivada:true}));
 await batch.commit();cacheAlumnos=[];
}
document.getElementById("btn-eliminar-alumnos-masivo")?.addEventListener("click",async()=>{
 const ids=[...document.querySelectorAll(".chk-alumno:checked")].map(c=>c.value);
 if(!ids.length||!confirm(`¿Archivar ${ids.length} alumnos y sus prácticas? Se conserva su historial.`))return;
 try{await archivarAlumnos(ids);mostrarAlerta("Alumnos archivados.");await cargarAlumnos();}catch(err){mostrarAlerta(err.message,"danger");}
});

document.getElementById("btn-exportar-alumnos")?.addEventListener("click", () => {
  if (!ultimosAlumnosFiltrados.length) { mostrarAlerta("No hay alumnos para exportar.", "warning"); return; }
  const encabezados = ["Legajo", "Apellido", "Nombre", "Curso / división", "Sector / carrera", "Email", "Teléfono"];
  const filas = ultimosAlumnosFiltrados.map(a => [a.legajo, a.apellido, a.nombre, a.curso || "", a.sector || "", a.email || "", a.telefono || ""]);
  exportarXLSX("alumnos.xlsx", "Alumnos", encabezados, filas);
});

document.getElementById("alumno-filtro-texto").addEventListener("input", delayed(cargarAlumnos));
document.getElementById("alumno-filtro-curso").addEventListener("input", delayed(cargarAlumnos));

document.getElementById("btn-nuevo-alumno").addEventListener("click", () => {
  document.getElementById("form-alumno").reset();
  document.getElementById("alumno-id").value = "";
  document.getElementById("modal-alumno-titulo").textContent = "Nuevo alumno";
  document.getElementById("alumno-practicas-wrap").classList.add("d-none");
  document.getElementById("btn-eliminar-alumno").classList.add("d-none");
  abrirModal("modal-alumno");
});

async function cargarPracticasDeAlumnoEnFicha(alumnoId) {
  const [practicas, snapAsistencias] = await Promise.all([practicasAlumno(alumnoId), getDocs(query(collection(db, "asistencias"),where("alumnoId","==",alumnoId)))]);
  const asistencias = snapAsistencias.docs.map(d => d.data()).filter(r => r.alumnoId === alumnoId && !r.duplicadaEn && !r.suprimido && !r.fueraCronograma);
  const propias = practicas.filter(p => p.alumnoId === alumnoId).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const realizadas = propias.filter(practicaRealizada);
  const horas = propias.reduce((t, p) => t + horasCumplidas(p), 0);
  const presentes = asistencias.filter(r => ["presente", "tardanza"].includes(r.estado || (r.presente ? "presente" : "ausente_injustificado"))).length;
  document.getElementById("alumno-seguimiento").innerHTML = `<strong>Seguimiento:</strong> ${realizadas.length} práctica(s) realizada(s), ${horas.toFixed(1)} horas contabilizadas y ${presentes}/${asistencias.length} jornadas con asistencia.`;
  document.getElementById("tabla-alumno-practicas").innerHTML = propias.map(p => `
    <tr class="tipo-${p.tipo || "interna"}">
      <td>${fmtRangoFechas(p)}</td><td>${p.lugar}</td>
      <td>${String(p.sector || "Sin especificar").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]))}</td>
      <td>${badgeTipo(p.tipo)}</td>
      <td><span class="badge bg-${practicaRealizada(p) ? "success" : "secondary"}">${estadoPractica(p).replace("_", " ")}</span></td>
      <td>${asistencias.filter(r => !r.duplicadaEn && !r.suprimido && !r.fueraCronograma && r.practicaId === p.id && ["presente", "tardanza"].includes(r.estado || (r.presente ? "presente" : "ausente_injustificado"))).length}/${asistencias.filter(r => !r.duplicadaEn && !r.suprimido && !r.fueraCronograma && r.practicaId === p.id).length}</td>
      <td title="Horas cumplidas / planificadas">${horasCumplidas(p).toFixed(2)} / ${num(p.horasPlanificadas).toFixed(2)}${manualHours(p) ? " · manual" : ""}</td>
      <td>
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="window.editarPractica('${p.id}', true)">Editar</button>
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="window.eliminarPractica('${p.id}', true)">Eliminar</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="8" class="text-muted">Este alumno todavía no tiene prácticas cargadas.</td></tr>`;
}

window.editarAlumno = async (id) => {
  const a = await registroPorId("alumnos",id);if(!a)return;
  document.getElementById("alumno-id").value = a.id;
  document.getElementById("alumno-legajo").value = a.legajo;
  document.getElementById("alumno-nombre").value = a.nombre;
  document.getElementById("alumno-apellido").value = a.apellido;
  document.getElementById("alumno-email").value = a.email || "";
  document.getElementById("alumno-telefono").value = a.telefono || "";
  document.getElementById("alumno-sector").value = a.sector || "";
  document.getElementById("alumno-curso").value = a.curso || "";
  document.getElementById("modal-alumno-titulo").textContent = `Ficha de ${nombreCompleto(a)}`;
  document.getElementById("alumno-practicas-wrap").classList.remove("d-none");
  document.getElementById("btn-eliminar-alumno").classList.remove("d-none");
  await cargarPracticasDeAlumnoEnFicha(a.id);
  abrirModal("modal-alumno");
};

window.eliminarAlumno = async id=>{
 if(!confirm("¿Archivar al alumno y sus prácticas? Se conserva el historial y los informes."))return;
 try{await archivarAlumnos([id]);cerrarModal("modal-alumno");mostrarAlerta("Alumno archivado.");await cargarAlumnos();}catch(err){mostrarAlerta(err.message,"danger");}
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
  document.getElementById("practica-alumno-buscar").value = "";
  document.getElementById("practica-id").value = "";
  document.getElementById("practica-estado").value = "programada";
  document.getElementById("practica-modo-horas").value = "jornadas";
  document.getElementById("practica-acuerdo-nombre").value = "";
  marcarDiasFormulario([1, 2, 3, 4, 5]);
  await llenarSelectAlumnos(document.getElementById("practica-alumno"), alumnoId);
  await prepararListasPractica();
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
    telefono: document.getElementById("alumno-telefono").value.trim(),
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
  const alumnos=await obtenerAlumnos();const mapa=Object.fromEntries(alumnos.map(a=>[a.id,a]));
  return (await enriquecerPracticas(await lecturaPracticas())).map(p=>({...p,alumno:mapa[p.alumnoId]})).sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha)));
}

async function cargarPracticas(move=0) {
  const alumnoId=chosenStudent('f-alumno');
  const spec=pageSpec('practicas',{equal:{alumnoId,tipo:valueOf('f-tipo'),lugar:valueOf('f-lugar'),tutorResponsable:valueOf('f-tutor'),sector:valueOf('f-sector')},from:valueOf('f-desde'),to:valueOf('f-hasta')});
  const page=await recordsPage('tabla-practicas',spec,move,cargarPracticas);if(!page)return;
  const raw=page.docs.map(rowData).filter(p=>!p.archivada);
  const mapa=await relatedStudents(raw);
  const practicas=raw.map(p=>({...calculatePractice(p,[],raw),alumno:mapa[p.alumnoId]}));
  const acumPorAlumno={};acumuladosPracticas={};
  ultimasPracticasFiltradas = practicas;

  const chkTodas = document.getElementById("chk-todas-practicas");
  if (chkTodas) chkTodas.checked = false;

  document.getElementById("tabla-practicas").innerHTML = practicas.map(p => {
    const acum = acumPorAlumno[p.alumnoId] || { totalHoras: 0, horasRealizadas: 0 };
    const pendiente = !manualHours(p);
    // Compatibilidad con prácticas cargadas antes de que existiera "horasPorDia":
    // en ese esquema viejo, "horasTotales" ya representaba la carga diaria.
    const horasPorDia = dayHours(p);
    const diasPorSemana = p.diasPorSemana ?? 5;
    return `
    <tr data-practica="${p.id}" class="tipo-${p.tipo || "interna"}">
      <td><input type="checkbox" class="chk-practica" value="${p.id}"></td>
      <td>${fmtRangoFechas(p)}</td><td>${p.alumno ? nombreCompleto(p.alumno) : "-"}</td>
      <td>${p.lugar}</td>
      <td>${badgeTipo(p.tipo)}</td>
      <td><span class="badge bg-${practicaRealizada(p) ? "success" : estadoPractica(p) === "en_curso" ? "primary" : estadoPractica(p) === "cancelada" ? "danger" : "secondary"}">${etiquetaEstado(p)}</span></td>
      <td>${p.sector || ""}</td>
      <td>${p.horaInicio || ""} - ${p.horaFin || ""}</td>
      <td>
        <input type="number" step="0.5" min="0" class="form-control form-control-sm" style="width:80px"
          value="${horasPorDia}" title="Horas que debe cumplir el alumno cada día de práctica"
          onchange="window.actualizarHorasPorDia('${p.id}', this.value)">
      </td>
      <td>
        <input type="number" step="1" min="1" max="7" class="form-control form-control-sm" style="width:70px"
          value="${diasPorSemana}" readonly title="Elegí los días exactos desde Editar"
          onchange="window.actualizarDiasSemana('${p.id}', this.value)">
      </td>
      <td>
        ${pendiente
          ? `<span data-horas-practica><button class="btn btn-sm btn-outline-secondary" onclick="window.consultarHorasPractica('${p.id}','${p.alumnoId}')">Consultar horas</button> / ${num(p.horasPlanificadas).toFixed(2)} planificadas</span>`
          : `<input type="number" step="0.5" min="0" class="form-control form-control-sm" style="width:90px"
              value="${numeroHoras(p.horasTotales)}" title="Horas totales reales de esta práctica"
              onchange="window.actualizarHorasTotalesReal('${p.id}', this.value)">`}
      </td>
      <td data-acum-real>Consultar</td>
      <td data-acum-total>Consultar</td>
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
  if (p && !manualHours(p)) {
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
  if (p && !manualHours(p)) {
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
  await updateDoc(doc(db, "practicas", id), { horasTotales, modoHoras:"manual", estado:"realizada", realizada:true });
  mostrarAlerta("Horas totales actualizadas.");
  cargarPracticas();
};

document.getElementById("chk-todas-practicas")?.addEventListener("change", (e) => {
  document.querySelectorAll(".chk-practica").forEach(c => c.checked = e.target.checked);
});

document.getElementById("btn-eliminar-practicas-masivo")?.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".chk-practica:checked")].map(c => c.value);
  if (!ids.length) { mostrarAlerta("Seleccioná al menos una práctica.", "warning"); return; }
  if (!confirm(`¿Archivar ${ids.length} prácticas? Se conserva el historial.`)) return;
  await Promise.all(ids.map(id => updateDoc(doc(db, "practicas", id), {archivada:true,estado:"cancelada",archivadaEn:new Date().toISOString()})));
  mostrarAlerta(`${ids.length} prácticas archivadas.`);
  cargarPracticas();
});

document.getElementById("btn-exportar-practicas")?.addEventListener("click", async () => {
  for(const id of [...new Set(ultimasPracticasFiltradas.map(p=>p.alumnoId))]){const first=ultimasPracticasFiltradas.find(p=>p.alumnoId===id);if(await window.consultarHorasPractica(first.id,id)===false)return;}
  if (!ultimasPracticasFiltradas.length) { mostrarAlerta("No hay prácticas para exportar.", "warning"); return; }
  const encabezados = ["Fecha inicio", "Fecha fin", "Alumno", "Legajo", "Lugar", "Tipo", "Estado", "Sector",
    "Hora entrada", "Hora salida", "Horas x día", "Días por semana", "Horas cumplidas (práctica)", "Horas planificadas (práctica)",
    "Horas realizadas (alumno)", "Horas totales (alumno)", "Tutor", "Contacto"];
  const filas = ultimasPracticasFiltradas.map(p => [
    fmtFecha(p.fecha), p.fechaFin ? fmtFecha(p.fechaFin) : "",
    p.alumno ? nombreCompleto(p.alumno) : "", p.alumno?.legajo || "",
    p.lugar || "", infoTipo(p.tipo).label, estadoPractica(p), p.sector || "",
    p.horaInicio || "", p.horaFin || "", p.horasPorDia ?? p.horasTotales ?? 0, p.diasPorSemana ?? 5,
    horasCumplidas(p), num(p.horasPlanificadas),
    acumuladosPracticas[p.alumnoId]?.horasRealizadas ?? 0, acumuladosPracticas[p.alumnoId]?.totalHoras ?? 0,
    p.tutorResponsable || "", p.contacto || "",
  ]);
  exportarXLSX("practicas.xlsx", "Prácticas", encabezados, filas);
});

document.getElementById("btn-filtrar-practicas").addEventListener("click", cargarPracticas);
document.getElementById("btn-limpiar-practicas").addEventListener("click", () => {
  ["f-alumno", "f-lugar", "f-tutor", "f-sector", "f-desde", "f-hasta","f-tipo"].forEach(id => document.getElementById(id).value = "");
  cargarPracticas();
});

// Actualiza el campo "Horas totales" del modal de práctica:
// - Si la práctica está PENDIENTE, se recalcula sola (a partir de horas x
//   día + días por semana + rango de fechas) y queda de solo lectura.
// - Si ya se REALIZÓ, se habilita para que se cargue el valor real a mano
//   (o el que trajo una importación), sin pisar lo que el usuario tipeó.
function actualizarPreviewHorasTotales() {
 const manual=document.getElementById("practica-modo-horas")?.value === "manual";
 const input=document.getElementById("practica-horas-totales"); input.readOnly=!manual;
 const fecha=document.getElementById("practica-fecha").value,fin=document.getElementById("practica-fecha-fin").value;
 if(!manual)input.value=calcularHorasTotalesAutomatico(fecha,fin,num(document.getElementById("practica-horas-dia").value),diasSeleccionadosFormulario().length,diasSeleccionadosFormulario());
 document.getElementById("practica-horas-totales-ayuda").textContent=manual?"Total histórico validado manualmente. No se recalcula por jornadas. Usá Por jornadas para aplicar ausencias y tardanzas.":"Total planificado. Las horas cumplidas se calculan por jornada terminada y estado de asistencia.";
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
  document.getElementById("practica-alumno-buscar").value = "";
  document.getElementById("practica-id").value = "";
  document.getElementById("practica-estado").value = "programada";
  document.getElementById("practica-modo-horas").value = "jornadas";
  document.getElementById("practica-acuerdo-nombre").value = "";
  marcarDiasFormulario([1, 2, 3, 4, 5]);
  await llenarSelectAlumnos(document.getElementById("practica-alumno"));
  await prepararListasPractica();
  actualizarPreviewHorasTotales();
  abrirModal("modal-practica");
});

window.editarPractica = async (id, desdeFicha = false) => {
  const p = await registroPorId("practicas",id);if(!p)return;
  practicaOrigenAlumnoId = desdeFicha ? p.alumnoId : null;
  if (desdeFicha) cerrarModal("modal-alumno");
  document.getElementById("practica-alumno-buscar").value = "";
  document.getElementById("practica-id").value = p.id;
  await llenarSelectAlumnos(document.getElementById("practica-alumno"), p.alumnoId);
  await prepararListasPractica(p);
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
  document.getElementById("practica-horas-dia").value = dayHours(p);
  document.getElementById("practica-dias-semana").value = p.diasPorSemana ?? 5;
  marcarDiasFormulario(p.diasSemana?.length ? p.diasSemana : [1, 2, 3, 4, 5].slice(0, p.diasPorSemana ?? 5));
  document.getElementById("practica-horas-totales").value = p.horasTotales ?? 0;
  document.getElementById("practica-estado").value = estadoPractica(p) === "pendiente_revision" ? "programada" : estadoPractica(p);
  document.getElementById("practica-modo-horas").value = manualHours(p) ? "manual" : "jornadas";
  document.getElementById("practica-acuerdo-nombre").value = p.acuerdoNombre || "";
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
  const modoHoras = document.getElementById("practica-modo-horas").value;
  const realizada = modoHoras === "manual" && estado === "realizada";
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
  if(!validDate(fecha)|| (fechaFin&&!validDate(fechaFin))) { mostrarAlerta("Revisá las fechas.","warning");return; }
  if(modoHoras==="manual" && (estado!=="realizada" || (fechaFin||fecha)>hoyISO())) {mostrarAlerta("El total manual sólo corresponde a períodos terminados y realizados.","warning");return;}
  const entrada=document.getElementById("practica-inicio").value,salida=document.getElementById("practica-fin").value;
  if(entrada && salida && duration(entrada,salida)===null) {mostrarAlerta("La salida debe ser posterior a la entrada.","warning");return;}
  if(!Number.isFinite(horasPorDia)||horasPorDia<=0||horasPorDia>24) {mostrarAlerta("Indicá horas por día mayores a cero y no superiores a 24.","warning");return;}
  if(duration(entrada,salida)!==null&&horasPorDia>duration(entrada,salida)){mostrarAlerta("Las horas diarias superan el horario indicado.","warning");return;}
  const datos = {
    modoHoras, acuerdoNombre:document.getElementById("practica-acuerdo-nombre").value.trim(),
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
    const camposAviso = ["alumnoId", "fecha", "fechaFin", "lugar", "sector", "horaInicio", "horaFin", "tutorResponsable", "tutorEmail", "contacto", "acuerdoNombre"];
    if (anterior.exists() && camposAviso.some(c => (anterior.data()[c] || "") !== (datos[c] || ""))) {
      datos.avisoAutomaticoEnviado = false;
      avisosEnviadosSesion.delete(id);
    }
    await guardarPracticaConInformes(id,datos,anterior.exists()?anterior.data():null);
  } else {
    const grupoId = `grupo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await Promise.all(alumnosSeleccionados.map(alumnoId => addDoc(collection(db, "practicas"), { ...datos, alumnoId, grupoId })));
  }
  await registrarLugarSiNuevo(datos.lugar).catch(()=>mostrarAlerta("La práctica se guardó, pero no se pudo actualizar el catálogo de lugares.","warning"));
  cerrarModal("modal-practica");
  mostrarAlerta("Fecha de práctica guardada.");
  await sincronizarAsistenciasAutomaticas(true,alumnosSeleccionados);
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
  await updateDoc(doc(db, "practicas", id), {archivada:true,estado:"cancelada",archivadaEn:new Date().toISOString()});
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
// prácticas realizadas de ESE alumno en particular (para poder vincular el informe a
// la práctica que corresponde y que después aparezca en "Resumen por
// práctica"). Si no hay alumno seleccionado, deja solo la opción inicial.
async function llenarSelectPracticaDeInforme(alumnoId, seleccionadaId = "") {
  const sel = document.getElementById("informe-practica");
  if (!alumnoId) {
    sel.innerHTML = `<option value="">Seleccionar práctica realizada</option>`;
    return;
  }
  const practicas = await practicasAlumno(alumnoId);
  const propias = practicas.filter(p => practicaRealizada(p));
  sel.innerHTML = `<option value="">Seleccionar práctica realizada</option>` +
    propias.map(p => `<option value="${p.id}" ${p.id === seleccionadaId ? "selected" : ""}>${p.lugar} (${fmtRangoFechas(p)})</option>`).join("");
}
document.getElementById("informe-alumno").addEventListener("change", (e) => llenarSelectPracticaDeInforme(e.target.value));

async function cargarCumplimientoInformes() {
  const selected=chosenStudent("if-alumno");
  const [alumnos, practicas] = await Promise.all([selected?registroPorId("alumnos",selected).then(a=>a?[a]:[]):obtenerAlumnos(), selected?practicasAlumno(selected):obtenerPracticas()]);
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const mapaPracticas = Object.fromEntries(practicas.map(p => [p.id, p]));

  const snap = await getDocs(selected?query(collection(db,"informes"),where("alumnoId","==",selected)):collection(db,"informes"));
  const todosInformes = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const fAlumno = "";
  const fLugar = document.getElementById("if-lugar").value.trim().toLowerCase();
  const fTitulo = document.getElementById("if-titulo").value.trim().toLowerCase();
  const fEstado = document.getElementById("if-estado").value;

  // El cumplimiento se calcula por práctica, no por cantidad bruta de
  // documentos: dos informes vinculados a la misma práctica cubren una sola.
  // "Pendiente" todavía no se considera presentado.
  const informesPresentados = todosInformes.filter(i => i.practicaId && i.estado !== "pendiente");
  const practicasRealizadas = practicas.filter(p => practicaRealizada(p)).filter(p => {
    const alumno = mapaAlumnos[p.alumnoId];
    if (fAlumno && !(alumno && `${nombreCompleto(alumno)} ${alumno.legajo}`.toLowerCase().includes(fAlumno))) return false;
    if (fLugar && !(p.lugar || "").toLowerCase().includes(fLugar)) return false;
    return true;
  });
  const porAlumno = {};
  practicasRealizadas.forEach(p => (porAlumno[p.alumnoId] ||= []).push(p));
  document.getElementById("tabla-cumplimiento-informes").innerHTML = Object.entries(porAlumno)
    .sort(([aId], [bId]) => (mapaAlumnos[aId] ? nombreCompleto(mapaAlumnos[aId]) : "").localeCompare(mapaAlumnos[bId] ? nombreCompleto(mapaAlumnos[bId]) : ""))
    .map(([alumnoId, realizadas]) => {
      const idsRealizadas = new Set(realizadas.map(p => p.id));
      const cubiertas = new Set(informesPresentados.filter(i => i.alumnoId === alumnoId && idsRealizadas.has(i.practicaId)).map(i => i.practicaId));
      const faltantes = realizadas.filter(p => !cubiertas.has(p.id));
      const completo = faltantes.length === 0;
      const detalleFaltantes = faltantes.map(p => `${p.lugar} (${fmtRangoFechas(p)})`).join("; ");
      const detalleFaltantesHTML = faltantes.map(p => `<div class="mb-1">${badgeTipo(p.tipo)} <strong>${escaparHTML(p.lugar||"Sin lugar")}</strong> · ${escaparHTML(p.sector||"Sin sector")} · ${fmtRangoFechas(p)}</div>`).join("");
      return `<tr class="${completo ? "table-success" : "table-danger"}">
        <td>${escaparHTML(mapaAlumnos[alumnoId] ? nombreCompleto(mapaAlumnos[alumnoId]) : "Alumno no encontrado")}</td>
        <td>${realizadas.length}</td>
        <td>${cubiertas.size}</td>
        <td>${completo ? `<span class="text-success">Ninguna</span>` : detalleFaltantesHTML}</td>
        <td><span class="badge bg-${completo ? "success" : "danger"}" ${detalleFaltantes ? `title="${escaparHTML(detalleFaltantes)}"` : ""}>${completo ? "Completo" : `Faltan ${faltantes.length}`}</span></td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="text-muted">No hay prácticas realizadas para los filtros seleccionados.</td></tr>`;

 }
async function cargarInformes(move=0){
 document.getElementById("tabla-cumplimiento-informes").innerHTML='<tr><td colspan="5">Usá Calcular cumplimiento para consultar el historial completo de los alumnos filtrados.</td></tr>';
 const spec=pageSpec('informes',{equal:{alumnoId:chosenStudent('if-alumno'),lugar:valueOf('if-lugar'),estado:valueOf('if-estado')},prefix:valueOf('if-titulo'),searchField:'busqueda_titulo'});
 const page=await recordsPage('tabla-informes',spec,move,cargarInformes);if(!page)return;
 const informes=page.docs.map(rowData),mapaAlumnos=await relatedStudents(informes);
 const practiceIds=[...new Set(informes.map(i=>i.practicaId).filter(Boolean))];
 const related=await Promise.all(practiceIds.map(id=>registroPorId('practicas',id))),mapaPracticas=Object.fromEntries(related.filter(Boolean).map(p=>[p.id,p]));
 document.getElementById('tabla-informes').innerHTML=informes.map(i=>{const p=mapaPracticas[i.practicaId];return `<tr><td>${escaparHTML(mapaAlumnos[i.alumnoId]?nombreCompleto(mapaAlumnos[i.alumnoId]):'—')}</td><td>${escaparHTML(i.titulo)}</td><td>${fmtFecha(i.fechaPresentacion)}</td><td>${escaparHTML(i.estado)}</td><td>${p?escaparHTML(p.lugar)+' ('+fmtRangoFechas(p)+')':'—'}</td><td>${i.enlaceDrive?`<a href="${escaparHTML(i.enlaceDrive)}" target="_blank">Ver archivo</a>`:''}</td></tr>`;}).join('')||'<tr><td colspan="6">No hay informes en esta página.</td></tr>';
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
  if(datos.practicaId){const p=await registroPorId("practicas",datos.practicaId);datos.lugar=p?.lugar||"";}
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
  const asistencias = asistenciasSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r=>!r.duplicadaEn&&!r.suprimido&&!r.fueraCronograma);
  const faltas = [...faltasSnap.docs.map(d => ({ id: d.id, ...d.data(), legado:true })), ...asistencias.filter(r=>!r.duplicadaEn&&!r.suprimido&&!r.fueraCronograma&&["ausente_justificado","ausente_injustificado"].includes(attendanceState(r)))];

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

  const sinDesglose=practicasFiltradas.filter(p=>calculatePractice(p,asistencias,practicas,clock(),{desde:fDesde,hasta:fHasta}).requiereDesglose);
  if(sinDesglose.length)mostrarAlerta(`${sinDesglose.length} prácticas tienen totales manuales sin desglose diario. No se distribuyen automáticamente en un rango parcial.`,"warning");
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
        (acc, p) => acc + calculatePractice(p, asistencias, practicas, clock(), {desde:fDesde,hasta:fHasta}).horasRealizadas, 0
      );
      // "Asistió" = hay al menos un registro de asistencia presente para ese
      // alumno en ese lugar, dentro de alguno de sus períodos.
      const asistio = entry.periodos.some(p => {
        const fin = p.fechaFin || p.fecha;
        return asistencias.some(a =>
          a.alumnoId === p.alumnoId && a.presente && !a.duplicadaEn && !a.suprimido && !a.fueraCronograma &&
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
          if (f.alumnoId === p.alumnoId && (!f.practicaId||f.practicaId===p.id) && f.fecha >= p.fecha && f.fecha <= fin && (!fDesde||f.fecha>=fDesde) && (!fHasta||f.fecha<=fHasta)) fechasFaltas.add(f.fecha);
        });
      });
      // Si tiene un informe vinculado a CUALQUIERA de sus períodos en este
      // lugar, se considera presentado.
      const informe = entry.periodos.map(p => (informesPorPracticaId[p.id] || []).find(i=>i.estado!=="pendiente")).find(Boolean) || null;

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
  const practicasDelAlumno = alumnoId ? await practicasAlumno(alumnoId) : [];
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
        alumnoId, practicaId, titulo, fechaPresentacion, estado,lugar:practicaId?(await registroPorId("practicas",practicaId))?.lugar||"":"",
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
async function cargarFaltas(move=0) {
  const spec=pageSpec('faltas',{equal:{alumnoId:valueOf('falta-filtro-alumno')}});
  const page=await recordsPage('tabla-faltas',spec,move,cargarFaltas);if(!page)return;
  const faltas=page.docs.map(rowData),mapaAlumnos=await relatedStudents(faltas);
  addStudentOptions('falta-filtro-alumno',Object.values(mapaAlumnos));
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
let sincronizacionEnCurso=null,ultimaSincronizacion=0;
async function sincronizarAsistenciasAutomaticas(forzar=false,alumnoIds=null) {
 if(!["admin","tutor"].includes(usuarioActual?.rol))return 0;
 if(sincronizacionEnCurso)return sincronizacionEnCurso;
 if(!forzar&&ultimaSincronizacion&&Date.now()-ultimaSincronizacion<300000)return 0;
 sincronizacionEnCurso=(async()=>{
  const [practices,records]=await Promise.all(alumnoIds?[readForStudents("practicas",alumnoIds),readForStudents("asistencias",alumnoIds)]:[lecturaPracticas(),lecturaAsistencias()]);
  return synchronizeAttendance({db,api:{doc,runTransaction},practices,records,onPending:()=>mostrarAlerta("Quedan jornadas pendientes de sincronizar. Se procesan hasta 30 por revisión; volvé a Asistencia después de cinco minutos. Apps Script también procesa jornadas recientes.","info")});
 })();
 try{const n=await sincronizacionEnCurso;ultimaSincronizacion=Date.now();return n;}finally{sincronizacionEnCurso=null;}
}

async function cargarAsistencia(move=0) {
  const spec=attendanceSpec();
  const page=await recordsPage('tabla-asistencia',spec,move,cargarAsistencia);if(!page)return;
  const registros=page.docs.map(rowData).filter(r=>!r.duplicadaEn&&!r.suprimido&&!r.fueraCronograma);
  const mapaAlumnos=await relatedStudents(registros);
  addStudentOptions('asist-filtro-alumno',Object.values(mapaAlumnos));
  const chkTodas = document.getElementById("chk-todas-asistencia");
  if (chkTodas) chkTodas.checked = false;

  document.getElementById("tabla-asistencia").innerHTML = registros.map(r => {
    const estado = attendanceState(r);
    return `
    <tr>
      <td><input type="checkbox" class="chk-asistencia" value="${r.id}"></td>
      <td>${fmtFecha(r.fecha)}</td><td>${mapaAlumnos[r.alumnoId] ? nombreCompleto(mapaAlumnos[r.alumnoId]) : "-"}</td>
      <td>${escaparHTML(r.lugar)}</td><td>${r.tipo ? badgeTipo(r.tipo) : ""}</td>
      <td><select class="form-select form-select-sm estado-asistencia" onchange="window.actualizarEstadoAsistencia('${r.id}', this.value)">${Object.entries(ESTADOS_ASISTENCIA).map(([v,l]) => `<option value="${v}" ${v === estado ? "selected" : ""}>${l}</option>`).join("")}</select></td><td><input type="time" value="${r.horaEntrada || ""}" onchange="window.actualizarHorarioAsistencia('${r.id}','horaEntrada',this.value)"></td><td><input type="time" value="${r.horaSalida || ""}" onchange="window.actualizarHorarioAsistencia('${r.id}','horaSalida',this.value)"></td><td>${escaparHTML(r.observaciones)}</td>
      <td><button class="btn btn-sm btn-outline-secondary" onclick="window.reprogramarJornada('${r.id}')">Reprogramar</button> <button class="btn btn-sm btn-outline-danger" onclick="window.eliminarAsistencia('${r.id}')">Eliminar</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" class="text-muted">No hay registros de asistencia.</td></tr>`;
}

window.actualizarEstadoAsistencia = async (id, estado) => {
  if (!ESTADOS_ASISTENCIA[estado]) return;
  const snap=await getDoc(doc(db,"asistencias",id));if(!snap.exists())return;
  const data={...snap.data(),estado};const p=await registroPorId("practicas",data.practicaId);
  try{validateAttendance(data,p);}catch(err){mostrarAlerta(err.message,"warning");await cargarAsistencia();return;}
  await updateDoc(doc(db, "asistencias", id), { estado, presente: ["presente", "tardanza"].includes(estado), editado: new Date().toISOString(), confirmado:true, origen:"manual", conflicto:false });
  mostrarAlerta("Estado de asistencia actualizado.");
};

document.getElementById("chk-todas-asistencia")?.addEventListener("change", (e) => {
  document.querySelectorAll(".chk-asistencia").forEach(c => c.checked = e.target.checked);
});

window.eliminarAsistencia = async (id) => {
  if (!confirm("¿Eliminar este registro de asistencia? Esta acción no se puede deshacer.")) return;
  await updateDoc(doc(db, "asistencias", id), {suprimido:true,presente:false,estado:"suprimido",editado:new Date().toISOString()});
  mostrarAlerta("Registro de asistencia eliminado.");
  cargarAsistencia();
};

document.getElementById("btn-eliminar-asistencia-masivo")?.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".chk-asistencia:checked")].map(c => c.value);
  if (!ids.length) { mostrarAlerta("Seleccioná al menos un registro.", "warning"); return; }
  if (!confirm(`¿Eliminar ${ids.length} registro(s) de asistencia seleccionado(s)? Esta acción no se puede deshacer.`)) return;
  await Promise.all(ids.map(id => updateDoc(doc(db, "asistencias", id), {suprimido:true,presente:false,estado:"suprimido",editado:new Date().toISOString()})));
  mostrarAlerta(`${ids.length} registro(s) de asistencia eliminado(s).`);
  cargarAsistencia();
});

document.getElementById("asist-filtro-alumno").addEventListener("change", cargarAsistencia);
document.getElementById("asist-filtro-fecha").addEventListener("change", cargarAsistencia);
document.getElementById("asist-filtro-lugar").addEventListener("input", delayed(cargarAsistencia));
document.getElementById("btn-limpiar-asistencia").addEventListener("click", () => {
  document.getElementById("asist-filtro-alumno").value = "";
  document.getElementById("asist-filtro-fecha").value = "";
  document.getElementById("asist-filtro-lugar").value = "";
  ["asist-filtro-desde","asist-filtro-hasta","asist-filtro-tipo","asist-filtro-estado"].forEach(id=>document.getElementById(id).value="");
  cargarAsistencia();
});

// Si para ese alumno y esa fecha ya hay una práctica cargada, se autocompletan
// lugar y tipo (se pueden editar igual antes de guardar).
async function actualizarSelectorJornadas() {
 const sel=document.getElementById("asist-practica");if(!sel)return;
 const id=document.getElementById("asist-alumno").value,date=document.getElementById("asist-fecha").value;
 const choices=(id?(await getDocs(query(collection(db,"practicas"),where("alumnoId","==",id)))).docs.map(rowData):[]).filter(p=>p.alumnoId===id&&estadoPractica(p)!=="cancelada"&&(!date||datesFor(p).includes(date)));
 const previous=sel.value;sel.innerHTML='<option value="">Seleccionar práctica</option>'+choices.map(p=>`<option value="${escaparHTML(p.id)}">${escaparHTML(p.lugar)} · ${escaparHTML(p.sector)} · ${fmtRangoFechas(p)} · ${p.horaInicio||""}</option>`).join('');
 if(choices.some(p=>p.id===previous))sel.value=previous;else if(choices.length===1)sel.value=choices[0].id;
 return choices;
}
async function autocompletarAsistenciaDesdePractica() {
 const choices=await actualizarSelectorJornadas();const p=choices?.find(p=>p.id===document.getElementById("asist-practica").value);if(!p)return;
 document.getElementById("asist-lugar").value=p.lugar||"";document.getElementById("asist-tipo").value=p.tipo||"interna";
 document.getElementById("asist-entrada").value=p.horaInicio||"";document.getElementById("asist-salida").value=p.horaFin||"";
}
document.getElementById("asist-alumno").addEventListener("change", autocompletarAsistenciaDesdePractica);
document.getElementById("asist-fecha").addEventListener("change", autocompletarAsistenciaDesdePractica);

document.getElementById("form-asistencia").addEventListener("submit", async (e) => {
  e.preventDefault();
  const lugar = document.getElementById("asist-lugar").value.trim();
  const alumnoId = document.getElementById("asist-alumno").value;
  const fecha = document.getElementById("asist-fecha").value;
  const estado = document.getElementById("asist-estado").value;
  const practicaId=document.getElementById("asist-practica").value;
  const practica=await registroPorId("practicas",practicaId);
  const datos = {
    practicaId, alumnoId, fecha,
    lugar,
    tipo: document.getElementById("asist-tipo").value,
    estado,
    presente: ["presente", "tardanza"].includes(estado),
    horaEntrada: document.getElementById("asist-entrada").value,
    horaSalida: document.getElementById("asist-salida").value,
    observaciones: document.getElementById("asist-obs").value.trim(),
    origen: "manual", confirmado:true,editado:new Date().toISOString(),conflicto:false,suprimido:false,fueraCronograma:false,
  };
  try{if(!practica||practica.alumnoId!==alumnoId)throw new Error("Seleccioná la práctica del alumno.");validateAttendance(datos,practica);}catch(err){mostrarAlerta(err.message,"warning");return;}
  datos.lugar=practica.lugar||"";datos.tipo=practica.tipo||"interna";
  await setDoc(doc(db,"asistencias",attendanceId(practicaId,fecha)),datos,{merge:true});
  await registrarLugarSiNuevo(lugar);
  document.getElementById("form-asistencia").reset();
  document.getElementById("asist-estado").value = "presente";
  mostrarAlerta("Asistencia registrada.");
  cargarAsistencia();
});

// ------------------------------------------------------- NOTIFICACIONES -
function actualizarAlertaConfigNotif() {
 const alerta=document.getElementById("notif-config-alerta");
 alerta.textContent="Avisos gratuitos con Google Apps Script. Las solicitudes se procesan aproximadamente cada hora; podés ejecutar el script manualmente para adelantarlas.";
 alerta.classList.remove("d-none");
}
// Configuración persistente de avisos: cuántos días antes se avisa, un CC
// fijo para todos los envíos, y si el envío debe dispararse solo.
async function obtenerConfigNotificaciones() {
  const porDefecto = { diasAviso: 7, ccEmail: "", automatico: false, horaEnvio:"08:00", acuerdosFolderId:"16RT_GoWf_acRnlvK1o995H3_6Aul0kla" };
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
  document.getElementById("notif-hora-envio").value=config.horaEnvio||"08:00";
  document.getElementById("notif-acuerdos-carpeta").value=config.acuerdosFolderId||"";
  await renderProximasYHistorial();
  await renderSolicitudes();
}

document.getElementById("btn-notif-guardar-config").addEventListener("click", async () => {
  const diasAviso = parseInt(document.getElementById("notif-dias").value || "3", 10);
  const ccEmail = document.getElementById("notif-cc-config").value.trim();
  const automatico = document.getElementById("notif-auto").checked;
  if (!Number.isInteger(diasAviso) || diasAviso < 0 || diasAviso > 90 || (ccEmail && !emailValido(ccEmail))) {
    mostrarAlerta("Revisá los días de aviso y el correo de copia.", "warning"); return;
  }
  const horaEnvio=document.getElementById("notif-hora-envio").value;
  const entradaCarpeta=document.getElementById("notif-acuerdos-carpeta").value.trim();
  const acuerdosFolderId=entradaCarpeta.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1] || entradaCarpeta;
  if(!/^[a-zA-Z0-9_-]+$/.test(acuerdosFolderId)||!/^\d{2}:\d{2}$/.test(horaEnvio)){mostrarAlerta("Indicá carpeta de acuerdos y horario válidos.","warning");return;}
  await setDoc(doc(db, "configuracion", "notificaciones"), { diasAviso, ccEmail, automatico,horaEnvio,acuerdosFolderId },{merge:true});
  mostrarAlerta("Configuración de avisos guardada.");
  await renderProximasYHistorial();
});

// Refresca la tabla de "próximas" y el historial usando el valor de "días de
// aviso" que esté tipeado en este momento (no hace falta guardar para probar
// distintos rangos).
async function renderProximasYHistorial(move=0) {
  const dias = parseInt(document.getElementById("notif-dias").value || "3", 10);
  const hoy=hoyISO(),hasta=sumarDiasISO(hoy,dias);
  const spec=pageSpec('practicas',{from:'',to:hasta,direction:'asc'});spec.filters.push(['fecha','>=',hoy]);
  const page=await recordsPage('tabla-notif-proximas',spec,move,renderProximasYHistorial);if(!page)return;
  const proximas=page.docs.map(rowData).filter(p=>!p.archivada&&['programada','en_curso'].includes(calendarState(p))&&!p.avisoAutomaticoEnviado);
  const mapaAlumnos=await relatedStudents(proximas);
  document.getElementById("tabla-notif-proximas").innerHTML = proximas.map(p => `
    <tr>
      <td><input type="checkbox" class="chk-notif-practica" value="${p.id}" checked></td>
      <td>${fmtFecha(p.fecha)}</td>
      <td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td>
      <td>${mapaAlumnos[p.alumnoId]?.email || "(sin email)"}</td>
      <td>${p.lugar}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="text-muted">No hay prácticas próximas en ese rango.</td></tr>`;
  document.getElementById("chk-todas-notificaciones").checked = proximas.length > 0;

  document.getElementById("btn-notif-enviar").dataset.proximas = JSON.stringify(proximas);

  const histSnap = await getDocs(query(collection(db, "notificaciones_log"), orderBy("fechaEnvio", "desc"), limit(20)));
  const historial = histSnap.docs.map(d => d.data()).slice(0, 30);
  document.getElementById("tabla-notif-historial").innerHTML = historial.map(h => `
    <tr>
      <td>${new Date(h.fechaEnvio).toLocaleString()}</td>
      <td>${h.tipo === "correo_particular" ? `${escaparHTML(h.nombreDestinatario||"Destinatario particular")} (${escaparHTML(h.destinatario||"")})` : (mapaAlumnos[h.alumnoId] ? nombreCompleto(mapaAlumnos[h.alumnoId]) : h.alumnoId)}</td>
      <td>${["automatico","programado"].includes(h.origen) ? "Automático" : "Manual"}</td>
      <td><span class="badge bg-${h.estado === "enviado" ? "success" : "danger"}">${h.estado}</span></td>
      <td>${h.detalle || "-"}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="text-muted">Sin envíos todavía.</td></tr>`;
}

document.getElementById("notif-dias").addEventListener("input", delayed(renderProximasYHistorial));
document.getElementById("chk-todas-notificaciones").addEventListener("change", e => {
  document.querySelectorAll(".chk-notif-practica").forEach(x=>x.checked=e.target.checked);
});
document.getElementById("tabla-notif-proximas").addEventListener("change", e => {
  if(!e.target.classList.contains("chk-notif-practica"))return;
  const checks=[...document.querySelectorAll(".chk-notif-practica")];
  document.getElementById("chk-todas-notificaciones").checked=checks.length>0&&checks.every(x=>x.checked);
});

let envioEnCurso = false;
function emailValido(valor) { return validEmail(valor); }
async function solicitarAviso(accion,datos={}) {
 if(!["admin","tutor"].includes(usuarioActual?.rol))throw new Error("Se requiere rol docente.");
 const ref=await addDoc(collection(db,"notificaciones_solicitudes"),{accion,solicitanteUid:usuarioActual.uid,estado:"pendiente",creado:new Date().toISOString(),...datos});
 return ref.id;
}
document.getElementById("btn-notif-enviar").addEventListener("click",async e=>{
 const btn=e.currentTarget;if(btn.disabled||envioEnCurso)return;btn.disabled=true;envioEnCurso=true;
 try{
  const ids=[...document.querySelectorAll(".chk-notif-practica:checked")].map(x=>x.value);
  if(!ids.length||ids.length>100)throw new Error("Seleccioná entre una y cien prácticas.");
  const cc=document.getElementById("notif-cc").value.trim();if(cc&&!emailValido(cc))throw new Error("Correo de copia inválido.");
  const id=await solicitarAviso("enviar",{practicaIds:ids,cc,mensaje:document.getElementById("notif-mensaje").value.trim()});
  mostrarAlerta("Solicitud registrada. Apps Script la procesará en su próxima ejecución; todavía no se enviaron los correos.","info");
  mostrarSolicitud(id);await renderSolicitudes();
 }catch(err){mostrarAlerta(err.message,"danger");}finally{btn.disabled=false;envioEnCurso=false;}
});
document.getElementById("btn-notif-enviar-particular").addEventListener("click",async e=>{
 const btn=e.currentTarget,datos={nombre:document.getElementById("notif-particular-nombre").value.trim(),email:document.getElementById("notif-particular-email").value.trim(),asunto:document.getElementById("notif-particular-asunto").value.trim(),mensaje:document.getElementById("notif-particular-mensaje").value.trim()};
 if(!datos.nombre||!emailValido(datos.email)||!datos.asunto||!datos.mensaje){mostrarAlerta("Completá nombre, correo, asunto y mensaje.","warning");return;}
 if(btn.disabled||envioEnCurso)return;btn.disabled=true;envioEnCurso=true;
 try{const id=await solicitarAviso("particular",datos);mostrarSolicitud(id);mostrarAlerta("Correo particular solicitado; pendiente de Apps Script.","info");await renderSolicitudes();}
 catch(err){mostrarAlerta(err.message,"danger");}finally{btn.disabled=false;envioEnCurso=false;}
});
let solicitudVisible=null;
async function mostrarSolicitud(id){
 solicitudVisible=id;const snap=await getDoc(doc(db,"notificaciones_solicitudes",id));if(!snap.exists())return;
 const data=snap.data(),out=document.getElementById("notif-diagnostico");out.replaceChildren();
 const line=document.createElement("p");line.textContent=`Solicitud ${id}: ${data.estado}. ${data.detalle||""}`;out.append(line);
 if(data.estado==="pendiente"||data.estado==="procesando"){const text=document.createElement("p");text.textContent="El disparador funciona aproximadamente cada hora. Para procesar ahora, ejecutá procesarControlPracticas en Apps Script.";out.append(text);}
 const result=data.resultado;
 if(result){const text=document.createElement("p");text.textContent=`Enviados: ${result.enviados||0}. Listos: ${result.listos||0}. Bloqueados: ${result.bloqueados||0}. Pendientes: ${result.pendientes||0}.`;out.append(text);
  for(const row of result.detalles||[]){const p=document.createElement("p");p.textContent=`${row.lugar||""} / ${row.sector||""}: ${row.estado}. ${row.acuerdo||""} ${row.detalle||""}`;out.append(p);}
 }
}
async function renderSolicitudes(){
 const snap=await getDocs(query(collection(db,"notificaciones_solicitudes"),orderBy("creado","desc"),limit(10)));
 const out=document.getElementById("notif-solicitudes");if(!out)return;out.replaceChildren();
 for(const docSnap of snap.docs){const d=docSnap.data(),button=document.createElement("button");button.className="btn btn-sm btn-outline-secondary me-2 mb-2";button.textContent=`${d.accion}: ${d.estado} · ${d.creado}`;button.onclick=()=>mostrarSolicitud(docSnap.id);out.append(button);}
 if(!snap.docs.length)out.textContent="Sin solicitudes.";
 const config=await obtenerConfigNotificaciones(),heartbeat=document.getElementById("notif-ultimo-control");
 if(heartbeat)heartbeat.textContent=config.ultimoControl?`Último control: ${config.ultimoControl.fecha}, ${config.ultimoControl.estado}. Cuota disponible: ${config.ultimoControl.cuotaDisponible??"sin dato"}. ${config.ultimoControl.detalle||""}`:"Apps Script todavía no registró una ejecución. Seguí CONFIGURACION_GRATUITA.md.";
}
document.getElementById("btn-notif-actualizar")?.addEventListener("click",async()=>{firestoreAccess.clear();await renderSolicitudes();await renderProximasYHistorial();if(solicitudVisible)await mostrarSolicitud(solicitudVisible);});
// Los avisos automáticos los procesa Apps Script, independientemente del inicio de sesión.
async function revisarYEnviarNotificacionesAutomaticas() {
 // El trabajador programado es el único emisor automático. No enviar desde el login.
 return;
}

// ------------------------------------------------------- PORTAL ALUMNO --
async function cargarMiPractica() {
  const alumnoId = usuarioActual?.alumnoId;
  if (!alumnoId) {
    document.getElementById("mi-practica-datos").innerHTML = `<div class="alert alert-warning mb-0">Esta cuenta todavía no está vinculada con un alumno. Solicitá al administrador que complete la vinculación.</div>`;
    document.getElementById("tabla-mi-practica").innerHTML = ""; document.getElementById("tabla-mi-asistencia").innerHTML = ""; return;
  }
  const [snapAlumno, snapPracticas, snapAsist] = await Promise.all([getDoc(doc(db,"alumnos",alumnoId)), getDocs(query(collection(db,"practicas"),where("alumnoId","==",alumnoId))), getDocs(query(collection(db,"asistencias"), where("alumnoId","==",alumnoId)))]);
  if (!snapAlumno.exists()) return;
  const a = { id: snapAlumno.id, ...snapAlumno.data() };
  const propias = await enriquecerPracticas(snapPracticas.docs.map(d=>({id:d.id,...d.data()})));
  const asistencias = snapAsist.docs.map(d => d.data()).filter(r=>!r.duplicadaEn&&!r.suprimido&&!r.fueraCronograma).sort((x,y)=>String(y.fecha).localeCompare(String(x.fecha)));
  const horas = propias.reduce((t,p)=>t+horasCumplidas(p),0);
  document.getElementById("mi-practica-datos").innerHTML = `<div class="row g-2"><div class="col-md-3"><strong>Alumno</strong><br>${escaparHTML(nombreCompleto(a))}</div><div class="col-md-2"><strong>Legajo</strong><br>${escaparHTML(a.legajo)}</div><div class="col-md-2"><strong>Curso</strong><br>${escaparHTML(a.curso || "-")}</div><div class="col-md-2"><strong>Teléfono</strong><br>${escaparHTML(a.telefono || "-")}</div><div class="col-md-3"><strong>Horas realizadas</strong><br>${horas.toFixed(1)}</div></div>`;
  document.getElementById("tabla-mi-practica").innerHTML = propias.map(p=>`<tr class="tipo-${p.tipo || "interna"}"><td>${fmtRangoFechas(p)}</td><td>${escaparHTML(p.lugar)}</td><td>${escaparHTML(p.sector||"")}</td><td>${escaparHTML(estadoPractica(p).replace("_"," "))}</td><td>${horasCumplidas(p).toFixed(2)} / ${num(p.horasPlanificadas).toFixed(2)}</td><td>${escaparHTML(p.tutorResponsable||"")}</td></tr>`).join("") || `<tr><td colspan="6">No hay prácticas asignadas.</td></tr>`;
  document.getElementById("tabla-mi-asistencia").innerHTML = asistencias.map(r=>`<tr><td>${fmtFecha(r.fecha)}</td><td>${escaparHTML(r.lugar||"")}</td><td>${escaparHTML(ESTADOS_ASISTENCIA[r.estado] || (r.presente ? "Presente" : "Ausente injustificado"))}</td><td>${escaparHTML(`${r.horaEntrada||""} - ${r.horaSalida||""}`)}</td><td>${escaparHTML(r.observaciones||"")}</td></tr>`).join("") || `<tr><td colspan="5">Sin registros de asistencia.</td></tr>`;
}

let alumnosDisponiblesInformePDF = [];
let practicasDisponiblesInformePDF = [];
let alumnosSeleccionadosPDFSet = new Set();

function alumnosSeleccionadosInformePDF() {
  return [...alumnosSeleccionadosPDFSet];
}

function renderAlumnosInformePDF() {
  const filtro = document.getElementById("pdf-buscar-alumno").value.trim().toLowerCase();
  const seleccionados = new Set(alumnosSeleccionadosInformePDF());
  const visibles = alumnosDisponiblesInformePDF.filter(a => !filtro || `${nombreCompleto(a)} ${a.legajo}`.toLowerCase().includes(filtro));
  document.getElementById("pdf-alumnos-selector").innerHTML = visibles.map(a=>`<label><input type="checkbox" value="${a.id}" ${seleccionados.has(a.id)?"checked":""}> <span>${escaparHTML(nombreCompleto(a))} · ${escaparHTML(a.legajo)}</span></label>`).join("") || `<span class="text-muted small">No se encontraron alumnos.</span>`;
  document.getElementById("pdf-alumnos-contador").textContent = `${seleccionados.size} alumno(s) seleccionado(s)`;
  document.getElementById("pdf-seleccionar-todos").checked = visibles.length > 0 && visibles.every(a=>seleccionados.has(a.id));
}

function actualizarAlcanceInformePDF() {
  const seleccionados = new Set(alumnosSeleccionadosInformePDF());
  const base = practicasDisponiblesInformePDF.filter(p=>!seleccionados.size || seleccionados.has(p.alumnoId));
  const crearOpciones = (valores, texto, actual) => `<option value="">${texto}</option>` + [...new Set(valores.filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b)).map(v=>`<option value="${escaparHTML(v)}" ${v===actual?"selected":""}>${escaparHTML(v)}</option>`).join("");
  const lugar = document.getElementById("pdf-filtro-lugar"), sector = document.getElementById("pdf-filtro-sector");
  lugar.innerHTML = crearOpciones(base.map(p=>p.lugar), "Todos los lugares", lugar.value);
  sector.innerHTML = crearOpciones(base.map(p=>p.sector), "Todos los sectores", sector.value);
  document.getElementById("pdf-alumnos-contador").textContent = `${seleccionados.size} alumno(s) seleccionado(s)`;
}

async function abrirInformePDF(alumnoId = "") {
  if (usuarioActual?.rol === "alumno" && !alumnoId) alumnoId = usuarioActual.alumnoId || "";
  document.getElementById("pdf-alumno-id").value = alumnoId;
  const devolucion = document.getElementById("pdf-devolucion");
  devolucion.value = ""; devolucion.disabled = usuarioActual?.rol === "alumno";
  devolucion.placeholder = usuarioActual?.rol === "alumno" ? "La devolución la completa el equipo docente." : "Escribí aquí la devolución para el alumno...";
  try {
    const [alumnos, practicas] = await Promise.all([obtenerAlumnos(), obtenerPracticas()]);
    alumnosDisponiblesInformePDF = usuarioActual?.rol === "alumno" ? alumnos.filter(a=>a.id===alumnoId) : alumnos;
    practicasDisponiblesInformePDF = practicas.filter(p=>practicaRealizada(p) && alumnosDisponiblesInformePDF.some(a=>a.id===p.alumnoId));
    alumnosSeleccionadosPDFSet = new Set(alumnoId ? [alumnoId] : []);
    document.getElementById("pdf-buscar-alumno").value = "";
    document.getElementById("pdf-alumnos-selector").innerHTML = alumnosDisponiblesInformePDF.map(a=>`<label><input type="checkbox" value="${a.id}" ${a.id===alumnoId?"checked":""}> <span>${escaparHTML(nombreCompleto(a))} · ${escaparHTML(a.legajo)}</span></label>`).join("");
    document.getElementById("pdf-filtro-tipo").value = "";
    document.getElementById("pdf-filtro-lugar").value = "";
    document.getElementById("pdf-filtro-sector").value = "";
    renderAlumnosInformePDF(); actualizarAlcanceInformePDF();
    abrirModal("modal-informe-pdf");
  } catch (err) {
    mostrarAlerta("No se pudieron cargar los filtros del informe.", "danger");
  }
}
document.getElementById("btn-informe-pdf-alumno").addEventListener("click", () => abrirInformePDF(document.getElementById("alumno-id").value));
document.getElementById("btn-mi-informe-pdf").addEventListener("click", () => abrirInformePDF(usuarioActual?.alumnoId));
document.getElementById("btn-abrir-generador-pdf").addEventListener("click", () => abrirInformePDF());
document.getElementById("pdf-buscar-alumno").addEventListener("input", renderAlumnosInformePDF);
document.getElementById("pdf-alumnos-selector").addEventListener("change", e => {
  if (e.target.matches("input[type=checkbox]")) e.target.checked ? alumnosSeleccionadosPDFSet.add(e.target.value) : alumnosSeleccionadosPDFSet.delete(e.target.value);
  renderAlumnosInformePDF(); actualizarAlcanceInformePDF();
});
document.getElementById("pdf-seleccionar-todos").addEventListener("change", e => {
  const filtro=document.getElementById("pdf-buscar-alumno").value.trim().toLowerCase();
  alumnosDisponiblesInformePDF.filter(a=>!filtro||`${nombreCompleto(a)} ${a.legajo}`.toLowerCase().includes(filtro)).forEach(a=>e.target.checked?alumnosSeleccionadosPDFSet.add(a.id):alumnosSeleccionadosPDFSet.delete(a.id));
  renderAlumnosInformePDF(); actualizarAlcanceInformePDF();
});

async function imagenADataURL(url) {
  const blob = await (await fetch(url)).blob();
  return await new Promise((resolve,reject)=>{ const r=new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(blob); });
}
document.getElementById("btn-generar-pdf").addEventListener("click", async () => {
  const alumnoIds = alumnosSeleccionadosInformePDF();
  const opciones = new Set([...document.querySelectorAll("#pdf-opciones input:checked")].map(x=>x.value));
  const filtroTipo = document.getElementById("pdf-filtro-tipo").value;
  const filtroLugar = document.getElementById("pdf-filtro-lugar").value;
  const filtroSector = document.getElementById("pdf-filtro-sector").value;
  if (!alumnoIds.length) { mostrarAlerta("Seleccioná al menos un alumno.", "warning"); return; }
  if (!opciones.size) { mostrarAlerta("Seleccioná al menos una sección.", "warning"); return; }
  if (!window.jspdf?.jsPDF) { mostrarAlerta("No se cargó el generador PDF. Recargá la página.", "danger"); return; }
  const btn = document.getElementById("btn-generar-pdf"); btn.disabled = true;
  try {
    const datosAlumnos = await Promise.all(alumnoIds.map(async alumnoId => {
      const [snapA, practicas, snapAsist, snapInformes] = await Promise.all([
        getDoc(doc(db,"alumnos",alumnoId)), getDocs(query(collection(db,"practicas"),where("alumnoId","==",alumnoId))),
        getDocs(query(collection(db,"asistencias"),where("alumnoId","==",alumnoId))),
        getDocs(query(collection(db,"informes"),where("alumnoId","==",alumnoId))),
      ]);
      if (!snapA.exists()) return null;
      return { a:{id:snapA.id,...snapA.data()}, propias:await enriquecerPracticas(practicas.docs.map(d=>({id:d.id,...d.data()})),snapAsist.docs.map(rowData)), asist:snapAsist.docs.map(d=>d.data()).filter(r=>!r.duplicadaEn&&!r.suprimido&&!r.fueraCronograma), informes:snapInformes.docs.map(d=>d.data()) };
    }));
    const validos = datosAlumnos.filter(Boolean);
    if (!validos.length) throw new Error("No se encontraron los alumnos seleccionados.");
    const seccionesDePractica = ["horas","practicas","inasistencias","tardanzas","informes"].some(x=>opciones.has(x));
    const { jsPDF } = window.jspdf; const pdf = new jsPDF({unit:"mm",format:"a4"});
    if (typeof pdf.autoTable !== "function") throw new Error("No se cargó el componente de tablas PDF. Recargá la página e intentá nuevamente.");
    const logo = await imagenADataURL("img/guemes.png").catch(()=>"");
    const encabezado = () => { if(logo) pdf.addImage(logo,"PNG",12,8,22,22); pdf.setTextColor(7,84,127); pdf.setFontSize(15); pdf.text("Escuela Técnica N.° 10",40,15); pdf.setFontSize(11); pdf.text("Prácticas Profesionalizantes",40,22); pdf.setDrawColor(5,143,208); pdf.line(12,33,198,33); };
    const alcance = `Tipo: ${filtroTipo ? infoTipo(filtroTipo).label : "Todos"} · Lugar: ${filtroLugar||"Todos"} · Sector: ${filtroSector||"Todos"}`;
    let incluidos=0;
    for (const {a, propias, asist, informes} of validos) {
      const propiasFiltradas = propias.filter(p=>practicaRealizada(p)||conHoras(p)).filter(p=>(!filtroTipo||normalizarTipo(p.tipo)===filtroTipo)&&(!filtroLugar||p.lugar===filtroLugar)&&(!filtroSector||p.sector===filtroSector));
      if (seccionesDePractica && !propiasFiltradas.length) continue;
      if (incluidos++) pdf.addPage();
      const idsPracticas=new Set(propiasFiltradas.map(p=>p.id));
      const asistFiltrada=asist.filter(r=>r.practicaId?idsPracticas.has(r.practicaId):propiasFiltradas.some(p=>normalizarTexto(r.lugar||"")===normalizarTexto(p.lugar||"")&&(!r.tipo||normalizarTipo(r.tipo)===normalizarTipo(p.tipo))&&r.fecha>=p.fecha&&r.fecha<=(p.fechaFin||p.fecha)));
      const informesFiltrados=informes.filter(i=>i.practicaId&&idsPracticas.has(i.practicaId));
      const mapaPracticas=Object.fromEntries(propiasFiltradas.map(p=>[p.id,p]));
      encabezado(); let y=40;
      pdf.setTextColor(30);pdf.setFontSize(14);pdf.text(`Informe de ${nombreCompleto(a)}`,12,y);y+=6;
      pdf.setFontSize(8);pdf.setTextColor(80);const lineasAlcance=pdf.splitTextToSize(alcance,184);pdf.text(lineasAlcance,12,y);y+=lineasAlcance.length*4+3;
      const tabla=(titulo,head,body)=>{const filas=body.length?body:[head.map((_,i)=>i===0?"Sin registros":"")];pdf.setFontSize(11);pdf.setTextColor(165,48,43);pdf.text(titulo,12,y);y+=2;pdf.autoTable({startY:y,head:[head],body:filas,theme:"grid",headStyles:{fillColor:[5,143,208]},styles:{fontSize:8},margin:{left:12,right:12,top:38},didDrawPage:d=>{if(d.pageNumber>1)encabezado();}});y=pdf.lastAutoTable.finalY+8;if(y>265){pdf.addPage();encabezado();y=40;}};
      if(opciones.has("datos"))tabla("Datos personales",["Dato","Información"],[["Legajo",a.legajo||""],["Curso / división",a.curso||""],["Sector / carrera",a.sector||""],["Email",a.email||""],["Teléfono",a.telefono||""]]);
      if(opciones.has("horas")){const por={};propiasFiltradas.forEach(p=>por[p.sector||"Sin sector"]=(por[p.sector||"Sin sector"]||0)+horasCumplidas(p));tabla("Horas realizadas por sector",["Sector","Horas"],Object.entries(por).map(([s,h])=>[s,h.toFixed(1)]));}
      if(opciones.has("practicas"))tabla("Prácticas realizadas",["Período","Tipo","Lugar","Sector","Horas"],propiasFiltradas.map(p=>[fmtRangoFechas(p),infoTipo(p.tipo).label,p.lugar||"",p.sector||"",horasCumplidas(p).toFixed(2)]));
      if(opciones.has("inasistencias"))tabla("Inasistencias",["Fecha","Lugar","Estado","Observación"],asistFiltrada.filter(r=>["ausente_justificado","ausente_injustificado"].includes(r.estado)||(!r.estado&&r.presente===false)).map(r=>[fmtFecha(r.fecha),r.lugar||"",ESTADOS_ASISTENCIA[r.estado]||"Ausente injustificado",r.observaciones||""]));
      if(opciones.has("tardanzas"))tabla("Tardanzas",["Fecha","Lugar","Horario","Observación"],asistFiltrada.filter(r=>r.estado==="tardanza").map(r=>[fmtFecha(r.fecha),r.lugar||"",`${r.horaEntrada||""}-${r.horaSalida||""}`,r.observaciones||""]));
      if(opciones.has("informes"))tabla("Informes presentados",["Fecha","Título","Práctica","Estado","Observación"],informesFiltrados.filter(i=>i.estado!=="pendiente").map(i=>{const p=mapaPracticas[i.practicaId];return[fmtFecha(i.fechaPresentacion||i.fecha),i.titulo||"",p?`${p.lugar} (${fmtRangoFechas(p)})`:"",i.estado||"",i.observaciones||""];}));
      const devolucion=document.getElementById("pdf-devolucion").value.trim();if(opciones.has("devolucion"))tabla("Devolución / observaciones docentes",["Observación"],[[devolucion||"Sin observaciones docentes."]]);
    }
    if(!incluidos)throw new Error("Ningún alumno seleccionado tiene prácticas realizadas que coincidan con el alcance elegido.");
    const paginas=pdf.internal.getNumberOfPages();for(let i=1;i<=paginas;i++){pdf.setPage(i);pdf.setFontSize(8);pdf.setTextColor(100);pdf.text(`Generado ${new Date().toLocaleDateString("es-AR")} · Página ${i} de ${paginas}`,105,291,{align:"center"});}
    pdf.save(`${incluidos===1?"informe_alumno":"informes_alumnos"}_${hoyISO()}.pdf`); cerrarModal("modal-informe-pdf");
  } catch(err){mostrarAlerta(err.message||"No se pudo generar el PDF.","danger");} finally{btn.disabled=false;}
});

// ------------------------------------------------------------- USUARIOS -
async function cargarUsuarios(move=0) {
  const spec=pageSpec('usuarios',{equal:{rol:valueOf('usuarios-filtro-rol')},prefix:valueOf('usuarios-filtro-texto'),searchField:'busqueda_nombre',direction:'asc'});
  const page=await recordsPage('tabla-usuarios',spec,move,cargarUsuarios);if(!page)return;
  const usuarios=page.docs.map(rowData),mapaAlumnos=await relatedStudents(usuarios);
  document.getElementById('usuarios-count').textContent=`${usuarios.length} en esta página`;
  document.getElementById("tabla-usuarios").innerHTML = usuarios.map(u => `
    <tr><td>${escaparHTML(u.nombre)}</td><td>${escaparHTML(u.email)}</td><td>${escaparHTML(u.rol)}</td><td>${u.alumnoId && mapaAlumnos[u.alumnoId] ? escaparHTML(nombreCompleto(mapaAlumnos[u.alumnoId])) : "-"}</td></tr>
  `).join("") || `<tr><td colspan="4" class="text-muted">No hay perfiles cargados todavía.</td></tr>`;
  addStudentOptions("usuario-alumno-id",Object.values(mapaAlumnos));
}

document.getElementById("usuario-rol").addEventListener("change", (e) => document.getElementById("usuario-alumno-wrap").classList.toggle("d-none", e.target.value !== "alumno"));

document.getElementById("form-usuario").addEventListener("submit", async (e) => {
  e.preventDefault();
  const uid = document.getElementById("usuario-uid").value.trim();
  const rol = document.getElementById("usuario-rol").value;
  const alumnoId = document.getElementById("usuario-alumno-id").value;
  if (rol === "alumno" && !alumnoId) { mostrarAlerta("Vinculá la cuenta con un alumno.", "warning"); return; }
  await setDoc(doc(db, "usuarios", uid), {
    nombre: document.getElementById("usuario-nombre").value.trim(),
    email: document.getElementById("usuario-email").value.trim(),
    rol,
    alumnoId: rol === "alumno" ? alumnoId : "",
  });
  document.getElementById("form-usuario").reset();
  document.getElementById("usuario-alumno-wrap").classList.add("d-none");
  mostrarAlerta("Usuario guardado.");
  cargarUsuarios();
});

// ------------------------------------------------------------ DASHBOARD -
async function cargarDashboardCompleto() {
  const alumnos = await obtenerAlumnos(true);
  const snap = await getDocs(collection(db, "practicas"));
  const practicas = await enriquecerPracticas(snap.docs.map(d=>({id:d.id,...d.data()})));

  const totalHoras = practicas.reduce((acc, p) => acc + horasCumplidas(p), 0);
  document.getElementById("stat-horas").textContent = totalHoras.toFixed(1);
  document.getElementById("stat-alumnos").textContent = alumnos.length;
  document.getElementById("stat-practicas").textContent = practicas.length;

  const porSector = {};
  practicas.filter(conHoras).forEach(p => {
    const s = p.sector || "Sin sector";
    porSector[s] = (porSector[s] || 0) + horasCumplidas(p);
  });
  document.getElementById("tabla-horas-sector").innerHTML = Object.entries(porSector)
    .map(([s, h]) => `<tr><td>${s}</td><td>${h.toFixed(1)}</td></tr>`).join("")
    || `<tr><td colspan="2" class="text-muted">Todavía no hay prácticas cargadas.</td></tr>`;

  const hoy = hoyISO();
  const mapaAlumnos = Object.fromEntries(alumnos.map(a => [a.id, a]));
  const proximas = practicas
    .map(p => p)
    .filter(p => p.fecha > hoy && estadoPractica(p) === "programada")
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(0, 5);
  document.getElementById("tabla-proximas").innerHTML = proximas.map(p => `
    <tr><td>${fmtRangoFechas(p)}</td><td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td><td>${p.lugar}</td></tr>
  `).join("") || `<tr><td colspan="3" class="text-muted">No hay prácticas próximas.</td></tr>`;

  const enCurso = practicas
    .map(p => p)
    .filter(p => estadoPractica(p) === "en_curso")
    .sort((a, b) => String(a.lugar || "").localeCompare(String(b.lugar || "")));
  document.getElementById("tabla-en-curso").innerHTML = enCurso.map(p => `
    <tr><td>${fmtRangoFechas(p)}</td><td>${mapaAlumnos[p.alumnoId] ? nombreCompleto(mapaAlumnos[p.alumnoId]) : "-"}</td><td>${escaparHTML(p.lugar)}</td></tr>
  `).join("") || `<tr><td colspan="3" class="text-muted">No hay prácticas en curso hoy.</td></tr>`;
  await aplicarConfigDashboard();
}

async function cargarDashboard(){
 for(const id of ['stat-horas','stat-alumnos','stat-practicas'])document.getElementById(id).textContent='Consultar';
 document.getElementById('tabla-horas-sector').innerHTML='<tr><td colspan="2">Usá Calcular indicadores para consultar las horas del historial completo.</td></tr>';
 const hoy=hoyISO();
 const [future,current]=await Promise.all([getDocs(query(collection(db,'practicas'),where('fecha','>',hoy),orderBy('fecha','asc'),limit(5))),getDocs(query(collection(db,'practicas'),where('fechaFin','>=',hoy),where('fecha','<=',hoy),orderBy('fechaFin','asc'),orderBy('fecha','asc'),limit(20)))]);
 const proximas=future.docs.map(rowData).filter(p=>!p.archivada&&calendarState(p)==='programada'),enCurso=current.docs.map(rowData).filter(p=>!p.archivada&&calendarState(p)==='en_curso');
 const mapa=await relatedStudents([...proximas,...enCurso]);
 for(const [id,rows] of [['tabla-proximas',proximas],['tabla-en-curso',enCurso]])document.getElementById(id).innerHTML=rows.map(p=>`<tr><td>${fmtRangoFechas(p)}</td><td>${escaparHTML(mapa[p.alumnoId]?nombreCompleto(mapa[p.alumnoId]):'—')}</td><td>${escaparHTML(p.lugar)}</td></tr>`).join('')||'<tr><td colspan="3">No hay prácticas en esta consulta.</td></tr>';
 await aplicarConfigDashboard();
}

// --------------------------------------------------------- ESTADISTICAS -

// Objetivo de horas a cumplir, UNO SOLO para todo el colegio (no por curso
// ni por alumno), con un valor independiente por tipo de práctica. Se
// guarda en Firestore en config/horasRequeridas para que lo vean todos los
// que entren a Estadísticas. Si los tres quedan en 0 (nunca se configuró),
// se mantiene el cálculo viejo de % cumplido (contra el total propio del
// alumno) para no romper lo que ya había.
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
  const practicas = await enriquecerPracticas(snap.docs.map(d=>({id:d.id,...d.data()})));

  const porAlumno = {};
  alumnos.forEach(a => {
    porAlumno[a.id] = { alumno: a, horasRealizadas: 0, horasPendientes: 0, horasInterna: 0, horasExterna: 0, horasInterescolar: 0, cantidad: 0 };
  });

  practicas.forEach(p => {
    const horas = numeroHoras(p.horasTotales);
    const esRealizada = practicaRealizada(p);
    const registro = porAlumno[p.alumnoId];
    if (!registro || estadoPractica(p) === "cancelada") return;
    registro.cantidad += 1;
    const cumplidas=horasCumplidas(p);
    registro.horasRealizadas += cumplidas;
    if (normalizarTipo(p.tipo) === "externa") registro.horasExterna += cumplidas;
    else if (normalizarTipo(p.tipo) === "interescolar") registro.horasInterescolar += cumplidas;
    else registro.horasInterna += cumplidas;
    registro.horasPendientes += horasPendientes(p);
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
      const result=targets({interna:f.horasInterna,externa:f.horasExterna,interescolar:f.horasInterescolar},objetivoHoras);
      pct=result.pct;faltan=result.faltan;
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

// Alumnos con menos horas realizadas según el tipo elegido: permite revisar
// por separado internas, externas, interescolares o el total de las tres.
function renderTablaAtencion() {
  const tbody = document.getElementById("tabla-estad-atencion");
  if (!tbody) return;
  const cantidadSel = document.getElementById("estad-atencion-cantidad");
  const cantidad = cantidadSel ? parseInt(cantidadSel.value, 10) || 0 : 10;
  const tipo = document.getElementById("estad-atencion-tipo")?.value || "todas";
  const horasTipo = f => tipo === "interna" ? f.horasInterna : tipo === "externa" ? f.horasExterna : tipo === "interescolar" ? f.horasInterescolar : f.horasRealizadas;
  const objetivoTipo = f => tipo === "interna" ? f.reqInterna : tipo === "externa" ? f.reqExterna : tipo === "interescolar" ? f.reqInterescolar : f.reqTotal;
  const etiqueta = { todas:"Todas", interna:"Internas", externa:"Externas", interescolar:"Interescolares" }[tipo];
  document.getElementById("estad-atencion-columna").textContent = `Horas: ${etiqueta}`;
  document.getElementById("estad-atencion-ayuda").textContent = `Ordenado de menor a mayor por horas ${etiqueta.toLowerCase()}. Solo se contabilizan prácticas realizadas.`;

  const ordenadosPorMenosHoras = [...ultimoCalculoEstadisticas].sort((a, b) => {
    const ha = horasTipo(a), hb = horasTipo(b);
    if (ha !== hb) return ha - hb;
    return nombreCompleto(a.alumno).localeCompare(nombreCompleto(b.alumno));
  });
  const lista = cantidad > 0 ? ordenadosPorMenosHoras.slice(0, cantidad) : ordenadosPorMenosHoras;

  tbody.innerHTML = lista.map(f => {
    const horas = horasTipo(f), objetivo = objetivoTipo(f);
    const pct = objetivo > 0 ? Math.min(100, (horas / objetivo) * 100) : null;
    return `
    <tr>
      <td><a href="#" class="link-alumno-ficha" onclick="window.editarAlumno('${f.alumno.id}'); return false;">${nombreCompleto(f.alumno)}</a></td>
      <td>${f.alumno.legajo}</td>
      <td>${f.alumno.curso || ""}</td>
      <td>${f.horasInterna.toFixed(1)}</td>
      <td>${f.horasExterna.toFixed(1)}</td>
      <td>${f.horasInterescolar.toFixed(1)}</td>
      <td><strong>${horas.toFixed(1)}</strong></td>
      <td>${pct === null ? "Sin objetivo" : `${pct.toFixed(0)}%`}</td>
      <td><button type="button" class="btn btn-sm btn-outline-secondary" onclick="window.editarAlumno('${f.alumno.id}')">Ver ficha</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" class="text-muted">No hay alumnos para mostrar.</td></tr>`;
}

document.getElementById("btn-estad-actualizar").addEventListener("click", cargarEstadisticas);
document.getElementById("estad-buscar-alumno")?.addEventListener("input", renderTablaEstadisticas);
document.getElementById("estad-atencion-cantidad")?.addEventListener("change", renderTablaAtencion);
document.getElementById("estad-atencion-tipo")?.addEventListener("change", renderTablaAtencion);

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
  { key: "telefono", alias: ["telefono", "tel", "celular", "telefono celular", "contacto alumno"] },
  { key: "curso", alias: ["curso", "division", "curso / division", "curso/division", "curso y division"] },
  { key: "sector", alias: ["sector", "carrera", "sector / carrera", "sector/carrera"] },
  { key: "lugar", alias: ["lugar", "lugar de practica"] },
  { key: "tipo", alias: ["tipo", "tipo (interna/externa)"] },
  { key: "fecha", alias: ["fecha", "fecha (aaaa-mm-dd)", "fecha inicio", "fecha de inicio"] },
  { key: "fechaFin", alias: ["fecha fin", "fecha de fin", "fecha fin (aaaa-mm-dd)", "hasta"] },
  { key: "horaInicio", alias: ["hora inicio", "inicio"] },
  { key: "horaFin", alias: ["hora fin", "fin"] },
  { key: "horasPorDia", alias: ["horas x dia", "horas por dia", "horas diarias"] },
  { key: "diasSemana", alias: ["dias exactos", "dias de asistencia", "dias semana"] },
  { key: "acuerdoNombre", alias: ["nombre acuerdo pdf", "acuerdo pdf"] },
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
function determinarRealizada(datos) {
  return ["realizada", "hecha", "cumplida"].includes(normalizarTexto(datos.estado));
}

document.getElementById("btn-importar-plantilla").addEventListener("click", () => {
  if (!window.XLSX) { mostrarAlerta("No se cargó Excel. Recargá la página.", "danger"); return; }
  const encabezados = ["Legajo", "Apellido", "Nombre", "Email", "Teléfono", "Curso / División", "Sector / Carrera", "Lugar de práctica",
    "Tipo (interna/externa/interescolar)", "Fecha inicio (AAAA-MM-DD)", "Fecha fin (AAAA-MM-DD)", "Hora inicio", "Hora fin",
    "Horas x día (si está pendiente)", "Días por semana (si está pendiente)", "Horas totales (si ya se realizó)",
    "Tutor responsable", "Email tutor", "Contacto", "Presente (si/no)", "Estado (realizada/pendiente)",
    "Observaciones asistencia", "Notas práctica", "Días exactos", "Nombre acuerdo PDF"];
  const ejemploRealizada = ["1234", "Gómez", "Ana", "ana@mail.com", "2664 123456", "5to Enfermería", "Enfermería", "Hospital Central", "interna",
    "2026-09-15", "2026-09-15", "08:00", "12:00", "4", "5", "4", "Lic. Pérez", "perez@escuela.edu.ar", "011-555-1234", "si", "realizada", "Llegó puntual", "Primer día", "mar", ""];
  const ejemploPendiente = ["1235", "Pérez", "Luis", "luis@mail.com", "2664 654321", "5to Enfermería", "Enfermería", "Hospital Central", "interna",
    "2026-10-01", "2026-12-19", "", "", "4", "3", "", "Lic. Pérez", "perez@escuela.edu.ar", "011-555-1234", "", "pendiente", "", "Cronograma de jornadas", "lun,mie,vie", ""];
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
    else if (!validDate(fechaISO)) errores.push("Fecha con formato no reconocido");

    let fechaFinISO = datos.fechaFin ? normalizarFecha(datos.fechaFin) : "";
    if (fechaFinISO && !validDate(fechaFinISO)) { errores.push("Fecha fin con formato no reconocido"); fechaFinISO = ""; }
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

    const realizada = determinarRealizada(datos);
    const estadoEntrada = normalizarTexto(datos.estado);
    if (estadoEntrada && !["realizada","hecha","cumplida","pendiente","programada","en_curso","en curso","cancelada"].includes(estadoEntrada)) errores.push("Estado desconocido");
    const estado = estadoEntrada === "cancelada" ? "cancelada" : realizada ? "realizada" : "programada";
    const horasPorDia = num(datos.horasPorDia || duration(datos.horaInicio,datos.horaFin));
    let diasSemana = [];
    try { diasSemana = datos.diasSemana ? parseDays(datos.diasSemana) : daysFor({fecha:fechaISO,fechaFin:fechaFinISO,diasPorSemana:datos.diasPorSemana||5}); } catch(err) { errores.push(err.message); }
    const diasPorSemana = diasSemana.length;
    if(!realizada && !diasSemana.length) errores.push("Faltan días exactos de asistencia");
    if(!realizada && (horasPorDia<=0 || horasPorDia>24)) errores.push("Horas diarias inválidas");
    if((datos.horaInicio||datos.horaFin) && duration(datos.horaInicio,datos.horaFin)===null) errores.push("Horario inválido");
    if(!realizada && duration(datos.horaInicio,datos.horaFin)!==null && horasPorDia>duration(datos.horaInicio,datos.horaFin)) errores.push("Horas diarias mayores al horario");
    if(realizada && (num(datos.horasTotales)<=0 || (fechaFinISO||fechaISO)>=hoyISO())) errores.push("Carga manual requiere horas positivas y un período ya finalizado");
    const horasTotales = realizada ? num(datos.horasTotales) : datesFor({fecha:fechaISO,fechaFin:fechaFinISO,diasSemana}).length*horasPorDia;

    return {
      fila: idx + 2, datos, fechaISO, fechaFinISO, realizada, estado, diasSemana, horasPorDia, diasPorSemana, horasTotales,
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
      <td><span class="badge bg-${f.realizada ? "success" : "secondary"}">${f.estado}</span></td>
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
          telefono: (f.datos.telefono || "").trim(),
          curso: (f.datos.curso || "").trim(),
          sector: (f.datos.sector || "").trim(),
        }, { merge: true });
        legajoAId[legajoNorm] = alumnoId;
        alumnosCreados++;
      }

      const practicaDatos = {
        alumnoId,
        lugar: (f.datos.lugar || "").trim(),
        tipo: normalizarTipo(f.datos.tipo),
        realizada: f.realizada, estado:f.estado, modoHoras:f.realizada ? "manual" : "jornadas", diasSemana:f.diasSemana, acuerdoNombre:String(f.datos.acuerdoNombre||""),
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
      };
      const practicaImportId = practiceId(practicaDatos);
      const antiguas = await getDocs(query(collection(db,"practicas"),where("alumnoId","==",alumnoId)));
      if(antiguas.docs.some(d=>practiceId(d.data())===practicaImportId)){omitidas++;continue;}
      const creada = await runTransaction(db,async tx=>{
        const ref=doc(db,"practicas",practicaImportId),existe=await tx.get(ref);
        if(existe.exists())return false;
        tx.set(ref,practicaDatos);
        const presente=normalizarPresente(f.datos.presente);
        if(presente!==null && f.fechaISO<hoyISO() && !f.realizada && datesFor(practicaDatos).includes(f.fechaISO)){
          tx.set(doc(db,"asistencias",attendanceId(practicaImportId,f.fechaISO)),{alumnoId,practicaId:practicaImportId,fecha:f.fechaISO,lugar:practicaDatos.lugar,tipo:practicaDatos.tipo,presente,estado:presente?"presente":"ausente_injustificado",origen:"importacion",confirmado:true,horaEntrada:f.datos.horaInicio||"",horaSalida:f.datos.horaFin||"",observaciones:String(f.datos.observacionesAsistencia||"")});
        }
        return true;
      });
      if(creada)practicasCreadas++;else omitidas++;
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

// Importación independiente de alumnos: alta o actualización por legajo/DNI.
let filasImportarAlumnos = [];
document.getElementById("btn-alumnos-plantilla").addEventListener("click", () => {
  const datos=[["Legajo","Apellido","Nombre","Email","Teléfono","Curso / División","Sector / Carrera"],["48354207","Calvo Albornoz","Alma Valentina","alumno@sanluis.edu.ar","2664 123456","7 B","Informática"]];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(datos),"Alumnos");XLSX.writeFile(wb,"plantilla_alumnos.xlsx");
});
async function leerPlanilla(file){
  const wb=/\.csv$/i.test(file.name)?XLSX.read(await file.text(),{type:"string",cellDates:true}):XLSX.read(await file.arrayBuffer(),{type:"array",cellDates:true});
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:"",raw:false});
}
document.getElementById("importar-alumnos-archivo").addEventListener("change", async e=>{
  const file=e.target.files[0];if(!file)return;
  try{
    const crudas=await leerPlanilla(file), existentes=await obtenerAlumnos(true), porLegajo=Object.fromEntries(existentes.map(a=>[normalizarLegajo(a.legajo),a]));
    filasImportarAlumnos=crudas.map((cruda,i)=>{const d=mapearFila(cruda), errores=[];if(!d.legajo)errores.push("Falta legajo");if(!d.apellido)errores.push("Falta apellido");if(!d.nombre)errores.push("Falta nombre");const existente=porLegajo[normalizarLegajo(d.legajo)];return{fila:i+2,d,existente,errores};});
    renderImportarAlumnos();
  }catch(err){mostrarAlerta("No se pudo leer la planilla de alumnos.","danger");}
});
function renderImportarAlumnos(){
  const validas=filasImportarAlumnos.filter(f=>!f.errores.length).length;
  document.getElementById("importar-alumnos-resumen").innerHTML=`Filas: <strong>${filasImportarAlumnos.length}</strong> · Válidas: <strong class="text-success">${validas}</strong> · Se actualizarán: <strong>${filasImportarAlumnos.filter(f=>f.existente&&!f.errores.length).length}</strong>`;
  document.getElementById("tabla-importar-alumnos").innerHTML=filasImportarAlumnos.map(f=>`<tr class="${f.errores.length?"table-danger":f.existente?"table-info":""}"><td>${f.fila}</td><td>${escaparHTML(f.d.legajo)}</td><td>${escaparHTML(`${f.d.apellido} ${f.d.nombre}`)}</td><td>${escaparHTML(f.d.curso)}</td><td>${escaparHTML(f.d.sector)}</td><td>${escaparHTML(f.d.email)}</td><td>${escaparHTML(f.d.telefono)}</td><td>${f.existente?"Actualizar":"Crear"}</td><td>${f.errores.join("; ")||"OK"}</td></tr>`).join("")||`<tr><td colspan="9">Sin datos.</td></tr>`;
  document.getElementById("btn-importar-alumnos-confirmar").disabled=!validas;
}
document.getElementById("btn-importar-alumnos-confirmar").addEventListener("click",async e=>{
  const btn=e.currentTarget;btn.disabled=true;let creados=0,actualizados=0,omitidos=0;
  for(const f of filasImportarAlumnos){if(f.errores.length){omitidos++;continue;}const datos={legajo:String(f.d.legajo).trim(),apellido:String(f.d.apellido).trim(),nombre:String(f.d.nombre).trim()};for(const [k,v] of Object.entries({email:f.d.email,telefono:f.d.telefono,curso:f.d.curso,sector:f.d.sector})){if(String(v||"").trim())datos[k]=String(v).trim();}try{const id=f.existente?.id||idAlumnoDesdeLegajo(datos.legajo);await setDoc(doc(db,"alumnos",id),datos,{merge:true});f.existente?actualizados++:creados++;}catch(_){omitidos++;}}
  cacheAlumnos=[];mostrarAlerta(`Alumnos creados: ${creados}. Actualizados: ${actualizados}. Omitidos: ${omitidos}.`);filasImportarAlumnos=[];renderImportarAlumnos();document.getElementById("importar-alumnos-archivo").value="";
});

// ------------------------------------------------------------ OPTIMIZAR -
async function cargarOptimizacion() {
  await Promise.all([cargarDuplicados(), cargarPracticasCorrelativas()]);
}

// Fusionar alumnos duplicados.
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
  const practicas = await enriquecerPracticas(practicasSnap.docs.map(d => ({ id: d.id, ...d.data() })));
  const asistencias = asistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const faltas = [...faltasSnap.docs.map(d => ({ id: d.id, ...d.data(), legado:true })), ...asistencias.filter(r=>!r.duplicadaEn&&!r.suprimido&&!r.fueraCronograma&&["ausente_justificado","ausente_injustificado"].includes(attendanceState(r)))];

  const grupos = buscarGruposDuplicados(alumnos);
  ultimosGruposDuplicados = { grupos, practicas, asistencias, faltas };

  document.getElementById("duplicados-resumen").innerHTML = grupos.length
    ? `Se encontraron <strong>${grupos.length}</strong> posible(s) grupo(s) de alumnos duplicados.`
    : "No se encontraron alumnos duplicados (mismo legajo o mismo nombre y apellido). Si sabés que hay uno y no aparece, puede que el nombre esté escrito distinto en cada registro.";

  document.getElementById("duplicados-lista").innerHTML = grupos.map((g, gi) => {
    const filas = g.map(a => {
      const propias = practicas.filter(p => p.alumnoId === a.id);
      const horasRealizadas = propias.reduce((s,p)=>s+horasCumplidas(p),0);
      const horasPendientes = propias.reduce((s,p)=>s+horasPendientes(p),0);
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

window.fusionarGrupo = async gi=>{
 const g=ultimosGruposDuplicados?.grupos?.[gi],radio=document.querySelector(`input[name="mantener-${gi}"]:checked`);
 if(!g||!radio)return;
 const principal=g.find(a=>a.id===radio.value),otros=g.filter(a=>a.id!==principal.id),ids=new Set(otros.map(a=>a.id));
 if(!confirm(`¿Unificar ${otros.length} registros en ${nombreCompleto(principal)} y conservar el historial?`))return;
 try{
  const colecciones=["practicas","asistencias","faltas","informes","usuarios"];
  const snaps=await Promise.all(colecciones.map(c=>getDocs(collection(db,c))));
  const refs=snaps.flatMap((snap,i)=>snap.docs.filter(d=>ids.has(d.data().alumnoId)).map(d=>({ref:d.ref,data:{alumnoId:principal.id}})));
  if(refs.length+otros.length+1>450)throw new Error("Hay demasiados registros para una fusión atómica. Requiere revisión administrativa.");
  const batch=writeBatch(db);refs.forEach(r=>batch.update(r.ref,r.data));
  const relleno={};for(const campo of ["email","telefono","sector","curso","legajo"])if(!principal[campo]){const x=otros.find(o=>o[campo]);if(x)relleno[campo]=x[campo];}
  batch.update(doc(db,"alumnos",principal.id),relleno);
  otros.forEach(o=>batch.update(doc(db,"alumnos",o.id),{archivado:true,fusionadoEn:principal.id}));
  await batch.commit();cacheAlumnos=[];await sincronizarAsistenciasAutomaticas();mostrarAlerta("Fusión completada conservando informes y usuarios.");await cargarDuplicados();
 }catch(err){mostrarAlerta(err.message,"danger");}
};

// Devuelve el lunes de la semana de una fecha ISO. Trabaja en hora local para
// evitar que la zona horaria cambie el día al convertir a Date.
function inicioSemanaISO(fechaISO) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  const dia = new Date(y, m - 1, d).getDay();
  return sumarDiasISO(fechaISO, dia === 0 ? -6 : 1 - dia);
}

function buscarGruposPracticasCorrelativas(practicas) {
  const candidatos = practicas.filter(p => p.fecha && (!p.fechaFin || p.fechaFin === p.fecha) && p.alumnoId && p.lugar && p.sector);
  const porCompatibilidad = {};
  candidatos.forEach(p => {
    // Se exige también igual tipo, estado, tutor y horario para que el período
    // resultante no mezcle datos incompatibles aunque lugar y sector coincidan.
    const clave = [p.alumnoId, normalizarTexto(p.lugar), normalizarTexto(p.sector), normalizarTipo(p.tipo), estadoPractica(p),
      normalizarTexto(p.tutorResponsable || ""), p.horaInicio || "", p.horaFin || "", inicioSemanaISO(p.fecha)].join("|");
    (porCompatibilidad[clave] ||= []).push(p);
  });

  const grupos = [];
  Object.values(porCompatibilidad).forEach(lista => {
    lista.sort((a, b) => a.fecha.localeCompare(b.fecha));
    let corrida = [];
    lista.forEach(p => {
      if (!corrida.length || p.fecha === sumarDiasISO(corrida[corrida.length - 1].fecha, 1)) corrida.push(p);
      else { if (corrida.length > 1) grupos.push(corrida); corrida = [p]; }
    });
    if (corrida.length > 1) grupos.push(corrida);
  });
  return grupos.sort((a, b) => a[0].fecha.localeCompare(b[0].fecha));
}

async function cargarPracticasCorrelativas() {
  const resumen = document.getElementById("practicas-correlativas-resumen");
  const lista = document.getElementById("practicas-correlativas-lista");
  resumen.textContent = "Buscando...";
  const [practicas, asistSnap, informesSnap] = await Promise.all([
    obtenerPracticas(), getDocs(collection(db, "asistencias")), getDocs(collection(db, "informes")),
  ]);
  const grupos = buscarGruposPracticasCorrelativas(practicas);
  const asistencias = asistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const informes = informesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  ultimosGruposCorrelativos = { grupos, asistencias, informes };
  resumen.innerHTML = grupos.length
    ? `Se encontraron <strong>${grupos.length}</strong> período(s) que pueden agruparse.`
    : "No se encontraron jornadas consecutivas compatibles para agrupar.";
  lista.innerHTML = grupos.map((g, gi) => {
    const p = g[0];
    const totalHoras = g.reduce((s, x) => s + numeroHoras(x.horasTotales), 0);
    return `<div class="card p-3 mb-3 shadow-sm">
      <div class="d-flex flex-wrap justify-content-between gap-2 align-items-start">
        <div><strong>${escaparHTML(p.alumno ? nombreCompleto(p.alumno) : "Alumno no encontrado")}</strong><br>
          <span>${fmtFecha(g[0].fecha)} → ${fmtFecha(g[g.length - 1].fecha)} · ${escaparHTML(p.lugar)} · ${escaparHTML(p.sector)}</span></div>
        <span class="badge bg-primary">${g.length} jornadas · ${totalHoras.toFixed(1)} h</span>
      </div>
      <div class="small text-muted my-2">${g.map(x => fmtFecha(x.fecha)).join(" · ")}</div>
      <button type="button" class="btn btn-primary btn-sm" onclick="window.agruparPracticasCorrelativas(${gi})">Agrupar este período</button>
    </div>`;
  }).join("");
}

document.getElementById("btn-buscar-practicas-correlativas").addEventListener("click", cargarPracticasCorrelativas);

window.agruparPracticasCorrelativas = async gi=>{
 const grupo=ultimosGruposCorrelativos?.grupos?.[gi];if(!grupo?.length)return;
 const ordenadas=[...grupo].sort((a,b)=>a.fecha.localeCompare(b.fecha)),principal=ordenadas[0],restantes=ordenadas.slice(1),ids=new Set(restantes.map(p=>p.id));
 try{
  const diasSemana=[...new Set(ordenadas.map(p=>new Date(`${p.fecha}T12:00:00Z`).getUTCDay()))];
  const combinado={...principal,fechaFin:ordenadas.at(-1).fecha,diasSemana};
  if(new Set(ordenadas.map(p=>p.fecha)).size!==ordenadas.length || datesFor(combinado).length!==ordenadas.length || ordenadas.some(p=>manualHours(p)!==manualHours(principal)||dayHours(p)!==dayHours(principal)||p.horaInicio!==principal.horaInicio||p.horaFin!==principal.horaFin||p.acuerdoNombre!==principal.acuerdoNombre))throw new Error("Las jornadas tienen horarios, acuerdos o días incompatibles; se conservan por separado.");
  const [asist,informes]=await Promise.all([getDocs(collection(db,"asistencias")),getDocs(collection(db,"informes"))]);
  const referencias=[...asist.docs,...informes.docs].filter(d=>ids.has(d.data().practicaId));
  if(referencias.length+restantes.length+1>450)throw new Error("El grupo supera el límite de una operación atómica.");
  if(!confirm(`¿Agrupar ${ordenadas.length} jornadas conservando sus horas y registros?`))return;
  const batch=writeBatch(db);
  batch.update(doc(db,"practicas",principal.id),{fechaFin:combinado.fechaFin,diasSemana,diasPorSemana:diasSemana.length,horasPorDia:dayHours(principal),horasTotales:ordenadas.reduce((s,p)=>s+num(p.horasTotales),0),modoHoras:manualHours(principal)?"manual":"jornadas"});
  referencias.forEach(d=>batch.update(d.ref,{practicaId:principal.id}));
  restantes.forEach(p=>batch.update(doc(db,"practicas",p.id),{archivada:true,agrupadaEn:principal.id}));
  await batch.commit();await sincronizarAsistenciasAutomaticas();mostrarAlerta("Jornadas agrupadas conservando el historial.");await cargarPracticasCorrelativas();
 }catch(err){mostrarAlerta(err.message,"warning");}
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
    estadoPractica(p), horasCumplidas(p), num(p.horasPlanificadas),
    p.horaInicio || "", p.horaFin || "", p.tutorResponsable || "", p.contacto || ""];
}
const columnasPractica = ["ID práctica", "Inicio", "Fin", "Lugar", "Sector / carrera", "Tipo de práctica", "Estado", "Horas cumplidas", "Horas planificadas", "Entrada", "Salida", "Tutor", "Contacto"];

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
    registroPorId("alumnos",id).then(a=>a?[a]:[]), practicasAlumno(id),
    getDocs(query(collection(db, "asistencias"), where("alumnoId", "==", id))),
    getDocs(query(collection(db, "faltas"), where("alumnoId", "==", id))),
    getDocs(query(collection(db, "informes"), where("alumnoId", "==", id))),
  ]);
  const a = alumnos.find(a => a.id === id);
  if (!a) throw new Error("El alumno ya no existe.");
  const propias = practicas.filter(p => p.alumnoId === id);
  const realizadas = propias.reduce((t,p)=>t+horasCumplidas(p),0);
  const pendientes = propias.reduce((t,p)=>t+horasPendientes(p),0);
  const registros = snap => snap.docs.map(d => d.data()).sort((a, b) => String(a.fecha || "").localeCompare(String(b.fecha || "")));
  const nombre = String(a.legajo || a.id).replace(/[^\p{L}\p{N}_-]/gu, "_");
  exportarLibro(`ficha_${nombre}_${hoyISO()}.xlsx`, [
    { nombre: "Ficha", encabezados: ["Dato", "Valor"], filas: [["Alumno", nombreCompleto(a)], ["Legajo", a.legajo || ""], ["Curso", a.curso || ""], ["Sector", a.sector || ""], ["Email", a.email || ""], ["Teléfono", a.telefono || ""], ["Horas realizadas", realizadas], ["Horas pendientes estimadas", pendientes], ["Cantidad de prácticas", propias.length], ["Generado", new Date().toLocaleString("es-AR")], ["Criterio", "Horas por jornadas terminadas y estado; los totales históricos manuales permanecen identificados."]] },
    { nombre: "Prácticas", encabezados: columnasPractica, filas: propias.map(filaPractica) },
    { nombre: "Asistencias", encabezados: ["Fecha", "Lugar", "Tipo", "Estado", "Entrada", "Salida", "Observaciones"], filas: registros(asistencias).map(r => [fmtFecha(r.fecha), r.lugar || "", infoTipo(r.tipo).label, ESTADOS_ASISTENCIA[r.estado] || (r.presente ? "Presente" : "Ausente injustificado"), r.horaEntrada || "", r.horaSalida || "", r.observaciones || ""]) },
    { nombre: "Faltas", encabezados: ["Fecha", "Justificada", "Motivo"], filas: registros(faltas).map(r => [fmtFecha(r.fecha), r.justificada ? "Sí" : "No", r.motivo || ""]) },
    { nombre: "Informes", encabezados: ["Fecha", "Título", "Práctica vinculada", "Enlace"], filas: registros(informes).map(r => [fmtFecha(r.fecha), r.titulo || "", r.practicaId || "", r.enlaceDrive || ""]) },
  ]);
}));

for (const [boton, coleccion, filtro] of [["btn-exportar-asistencias", "asistencias", "asist-filtro-alumno"], ["btn-exportar-faltas", "faltas", "falta-filtro-alumno"]]) {
  document.getElementById(boton).addEventListener("click", e => accionExportar(e.currentTarget, async () => {
    const id = document.getElementById(filtro).value;
    const spec=coleccion==="asistencias"?attendanceSpec():pageSpec("faltas",{equal:{alumnoId:id}});
    const snap=await getDocs(queryFor(spec));
    const mapa=await relatedStudents(snap.docs.map(rowData));
    const filas = snap.docs.map(d => d.data()).filter(r=>coleccion!=="asistencias"||(!r.duplicadaEn&&!r.suprimido&&!r.fueraCronograma)).sort((a, b) => String(a.fecha || "").localeCompare(String(b.fecha || "")));
    const asistencia = coleccion === "asistencias";
    exportarXLSX(`${coleccion}_${hoyISO()}.xlsx`, asistencia ? "Asistencias" : "Faltas",
      ["Fecha", "Alumno", "Legajo", ...(asistencia ? ["Lugar", "Estado", "Entrada", "Salida", "Observaciones"] : ["Justificada", "Motivo"])],
      filas.map(r => [fmtFecha(r.fecha), mapa[r.alumnoId] ? nombreCompleto(mapa[r.alumnoId]) : r.alumnoId, mapa[r.alumnoId]?.legajo || "", ...(asistencia ? [r.lugar || "", ESTADOS_ASISTENCIA[r.estado] || (r.presente ? "Presente" : "Ausente injustificado"), r.horaEntrada || "", r.horaSalida || "", r.observaciones || ""] : [r.justificada ? "Sí" : "No", r.motivo || ""])]));
  }));
}
document.getElementById("practica-modo-horas")?.addEventListener("change",actualizarPreviewHorasTotales);
document.getElementById("asist-practica")?.addEventListener("change",autocompletarAsistenciaDesdePractica);
window.actualizarHorarioAsistencia=async(id,campo,value)=>{
 if(!["horaEntrada","horaSalida"].includes(campo))return;
 const snap=await getDoc(doc(db,"asistencias",id));if(!snap.exists())return;
 const data={...snap.data(),[campo]:value};const p=await registroPorId("practicas",data.practicaId);
 try{validateAttendance(data,p);await updateDoc(snap.ref,{[campo]:value,origen:"manual",confirmado:true,editado:new Date().toISOString()});await cargarAsistencia();}
 catch(err){mostrarAlerta(err.message,"warning");}
};
document.getElementById("btn-notif-comprobar")?.addEventListener("click",async e=>{
 const btn=e.currentTarget;btn.disabled=true;
 try{const id=await solicitarAviso("comprobar");await mostrarSolicitud(id);await renderSolicitudes();}
 catch(err){document.getElementById("notif-diagnostico").textContent=`No se pudo registrar la comprobación: ${err.message}. Revisá las reglas de Firestore y el rol docente.`;}
 finally{btn.disabled=false;}
});
// La actualización se realiza al abrir cada vista; evitar releer todo Firestore cada minuto en Spark.


window.reprogramarJornada=async id=>{
 const fecha=prompt("Nueva fecha de esta jornada (AAAA-MM-DD):");if(fecha===null)return;
 if(!validDate(fecha)){mostrarAlerta("Fecha inválida.","warning");return;}
 try{
  const ref=doc(db,"asistencias",id),snap=await getDoc(ref),r=snap.data();
  if(!r?.practicaId)throw new Error("Vinculá primero la asistencia a su práctica.");
  const pref=doc(db,"practicas",r.practicaId),ps=await getDoc(pref),p=ps.data();
  if(!p||p.archivada||p.estado==="cancelada"||manualHours(p))throw new Error("Reprogramación requiere una práctica por jornadas activa.");
  if(fecha<=hoyISO())throw new Error("Elegí una fecha futura para reprogramar.");
  const nuevoId='reprogramada_'+attendanceId(r.practicaId,r.fecha),nuevoRef=doc(db,"practicas",nuevoId);
  await runTransaction(db,async tx=>{
   const [actual,practica,nueva]=await Promise.all([tx.get(ref),tx.get(pref),tx.get(nuevoRef)]);
   if(nueva.exists())throw new Error("Esta jornada ya fue reprogramada. Editá la práctica creada.");
   if(!actual.exists()||!practica.exists()||practica.data().archivada)throw new Error("La práctica cambió. Recargá la vista.");
   const base=practica.data();
   tx.set(nuevoRef,{...base,fecha,fechaFin:fecha,diasSemana:[new Date(`${fecha}T12:00:00Z`).getUTCDay()],diasPorSemana:1,horasTotales:dayHours(base),estado:"programada",realizada:false,modoHoras:"jornadas",avisoAutomaticoEnviado:false,reprogramacionDe:r.practicaId,jornadaOriginal:r.fecha});
   tx.update(ref,{estado:"reprogramado",presente:false,fechaReprogramada:fecha,practicaReprogramadaId:nuevoId,origen:"manual",confirmado:true,editado:new Date().toISOString()});
  });
  mostrarAlerta("Jornada reprogramada: el día original no suma horas; la nueva fecha tiene su propio registro.");await cargarAsistencia();
 }catch(err){mostrarAlerta(err.message,"warning");}
};
const preparationCursors=new Map();
async function prepareSearchPage(){
 if(usuarioActual?.rol!=='admin')throw new Error('Se requiere administrador.');
 const name=valueOf('busqueda-preparar-coleccion'),cursor=preparationCursors.get(name),spec={collection:name,filters:[],order:[['__name__','asc']]};
 const docs=(await getDocs(queryFor(spec,cursor,20))).docs;
 const batch=writeBatch(db);let changed=0;
 for(const snap of docs){const data=snap.data(),extra=searchableFields(name,name==='practicas'?{...data,fechaFin:data.fechaFin||data.fecha||''}:data);
  if(name==='asistencias'){if(!data.estado)extra.estado=attendanceState(data);if(!data.tipo&&data.practicaId){const p=await registroPorId('practicas',data.practicaId);if(p)extra.tipo=p.tipo||'interna';}}
  if(name==='informes'&&data.practicaId){const p=await registroPorId('practicas',data.practicaId);if(p)extra.lugar=p.lugar||'';}
  if(Object.entries(extra).some(([k,v])=>data[k]!==v)){batch.update(snap.ref,extra);changed++;}
 }
 if(changed)await batch.commit();
 if(docs.length)preparationCursors.set(name,docs.at(-1));
 if(docs.length<20)await setDoc(doc(db,'configuracion','lecturas'),{[name+'Preparadas']:true,actualizado:new Date().toISOString()},{merge:true});
 document.getElementById('busqueda-progreso').textContent=`${docs.length} revisados, ${changed} preparados. ${docs.length===20?'Continuá con próximos 20.':'Terminó esta colección.'}`;
}
function actionButton(id,fn){document.getElementById(id)?.addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;try{await fn();}catch(err){mostrarAlerta(firestoreMessage(err),'danger');}finally{button.disabled=false;}});}
function initializeRemoteLists(){
 for(const id of ['f-lugar','if-lugar','asist-filtro-lugar']){const input=document.getElementById(id);input?.setAttribute('list','lugares-list');input?.addEventListener('focus',async()=>{try{await obtenerLugares();poblarDatalistLugares();}catch(err){mostrarAlerta(firestoreMessage(err),'warning');}});}
 for(const id of ['f-alumno','if-alumno','asist-filtro-alumno','falta-filtro-alumno','asist-alumno','usuario-alumno-id'])attachStudentSearch(id);
 document.getElementById('alumno-buscar-campo')?.addEventListener('change',()=>cargarAlumnos());
 document.getElementById('usuarios-filtro-texto')?.addEventListener('input',delayed(cargarUsuarios));document.getElementById('usuarios-filtro-rol')?.addEventListener('change',()=>cargarUsuarios());
 for(const id of ['asist-filtro-desde','asist-filtro-hasta','asist-filtro-tipo','asist-filtro-estado'])document.getElementById(id)?.addEventListener('change',()=>cargarAsistencia());
 actionButton('btn-preparar-busqueda',prepareSearchPage);
 actionButton('btn-calcular-dashboard',cargarDashboardCompleto);
 actionButton('btn-calcular-cumplimiento',cargarCumplimientoInformes);
 actionButton('btn-preparar-asistencia',async()=>{document.getElementById('form-asistencia').classList.remove('d-none');const docs=(await getDocs(query(collection(db,'alumnos'),orderBy(documentId()),limit(20)))).docs;addStudentOptions('asist-alumno',docs.map(rowData).filter(a=>!a.archivado));await actualizarSelectorJornadas();});
 actionButton('btn-sincronizar-asistencia',async()=>{await sincronizarAsistenciasAutomaticas(true);await cargarAsistencia();});
}
initializeRemoteLists();
