import { googleDriveConfig } from "./firebase-config.js";

let tokenClient = null;
let accessToken = null;

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
          document.getElementById("drive-estado").textContent = "Conectado a Google Drive. Ya podés buscar.";
        }
      },
    });
  }
  tokenClient.requestAccessToken();
}

/** Busca archivos por nombre dentro de la carpeta configurada. */
export async function buscarEnDrive(nombre) {
  if (!accessToken) throw new Error("Sin token de Drive");

  const folderId = googleDriveConfig.folderId;
  const q = encodeURIComponent(`'${folderId}' in parents and name contains '${nombre.replace(/'/g, "\\'")}' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=modifiedTime desc&pageSize=25`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    if (res.status === 401) accessToken = null; // token vencido, hay que reconectar
    throw new Error(`Error de Drive: ${res.status}`);
  }
  const data = await res.json();
  return data.files || [];
}
