import { googleDriveConfig } from "./firebase-config.js";

let tokenClient = null;
let accessToken = null;

const MIME_CARPETA = "application/vnd.google-apps.folder";

// Tipos de archivo que cuentan como "informe". Se incluye .doc por las dudas
// de que algún informe viejo no esté todavía en .docx.
const MIMES_INFORME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc
]);

// Cache en memoria del recorrido completo del árbol de carpetas, para no
// repetir docenas de llamadas a la API cada vez que se hace una búsqueda
// dentro de la misma sesión. Se invalida sola a los 5 minutos, al reconectar
// con Drive, o cuando se pide explícitamente un refresco.
let cacheArbol = null;
let cacheTimestamp = 0;
const CACHE_VIGENCIA_MS = 5 * 60 * 1000;

/** Se llama al hacer click en "Conectar con Google Drive". Pide permiso de solo lectura. */
export function initApp() {
  if (!window.google || !window.google.accounts) {
    alert("Todavía está cargando Google. Esperá un segundo y volvé a intentar.");
    return;
  }
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: googleDriveConfig.clientId,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      callback: (resp) => {
        if (resp.access_token) {
          accessToken = resp.access_token;
          cacheArbol = null; // token nuevo -> descartamos cualquier cache vieja
          document.getElementById("drive-estado").textContent = "Conectado a Google Drive. Ya podés buscar.";
        }
      },
    });
  }
  tokenClient.requestAccessToken();
}

/**
 * Devuelve TODOS los hijos directos (subcarpetas + archivos) de una carpeta
 * de Drive, resolviendo la paginación si hay más de una página de resultados.
 */
async function listarHijos(folderId) {
  if (!accessToken) throw new Error("Sin token de Drive");

  const hijos = [];
  let pageToken = "";
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);

  do {
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${q}` +
      `&fields=nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)` +
      `&pageSize=1000&orderBy=name` +
      (pageToken ? `&pageToken=${pageToken}` : "");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      if (res.status === 401) accessToken = null; // token vencido, hay que reconectar
      throw new Error(`Error de Drive: ${res.status}`);
    }
    const data = await res.json();
    hijos.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return hijos;
}

/**
 * Recorre recursivamente el árbol a partir de folderId (pensado para la
 * estructura: Informes / Séptimo A / <alumno> / informe.docx, y lo mismo
 * para Séptimo B). "ruta" son los nombres de carpeta ya recorridos, así que
 * ruta[0] queda como "curso" (Séptimo A / Séptimo B) y ruta[1] como
 * "alumno", sin importar si en el medio hay más subniveles.
 */
async function recorrerCarpetas(folderId, ruta = []) {
  const hijos = await listarHijos(folderId);
  const subcarpetas = hijos.filter((h) => h.mimeType === MIME_CARPETA);

  const archivos = hijos
    .filter((h) => MIMES_INFORME.has(h.mimeType))
    .map((f) => ({
      id: f.id,
      nombre: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      curso: ruta[0] || "",
      alumno: ruta[1] || "",
      ruta: ruta.join(" / "),
    }));

  // Las subcarpetas se piden en paralelo (curso -> alumno son como mucho un
  // puñado de carpetas cada nivel), así que esto es rápido incluso con
  // varias decenas de alumnos.
  const listasHijas = await Promise.all(
    subcarpetas.map((c) => recorrerCarpetas(c.id, [...ruta, c.name]))
  );

  return archivos.concat(...listasHijas);
}

/**
 * Recorre TODA la estructura de carpetas configurada (googleDriveConfig.folderId
 * debe apuntar a la carpeta raíz "Informes", que contiene "Séptimo A",
 * "Séptimo B", y dentro de cada una una carpeta por alumno) y devuelve un
 * array plano con todos los informes (.docx/.pdf) encontrados, sin importar
 * cuán anidados estén.
 *
 * Usa una cache de 5 minutos; pasá { forzarRefresco: true } si necesitás
 * pisarla (por ejemplo, después de subir un informe nuevo a Drive).
 */
export async function cargarTodosLosInformes({ forzarRefresco = false } = {}) {
  const ahora = Date.now();
  if (!forzarRefresco && cacheArbol && ahora - cacheTimestamp < CACHE_VIGENCIA_MS) {
    return cacheArbol;
  }
  const informes = await recorrerCarpetas(googleDriveConfig.folderId);
  cacheArbol = informes;
  cacheTimestamp = ahora;
  return informes;
}

/**
 * Busca informes en TODO el árbol de carpetas (no solo en la carpeta raíz)
 * por nombre de archivo, alumno o curso. Reutiliza la misma cache que
 * cargarTodosLosInformes, así que buscar varias veces seguidas es instantáneo.
 */
export async function buscarEnDrive(nombre, opciones = {}) {
  const informes = await cargarTodosLosInformes(opciones);
  const buscado = (nombre || "").trim().toLowerCase();
  if (!buscado) return informes;

  return informes.filter(
    (i) =>
      i.nombre.toLowerCase().includes(buscado) ||
      i.alumno.toLowerCase().includes(buscado) ||
      i.curso.toLowerCase().includes(buscado)
  );
}
