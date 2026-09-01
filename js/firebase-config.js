// Reemplazá estos valores por los de TU proyecto de Firebase.
// Se obtienen en: Firebase Console -> Configuración del proyecto -> Tus apps -> Config
// Estas claves son públicas por diseño (no son secretas); la seguridad real
// la dan las Reglas de Firestore (ver firestore.rules) y el login de Auth.
export const firebaseConfig = {
  apiKey: "AIzaSyCxmJtDVnYdDhoWM2Q77ys1lPK15njUCfM",
  authDomain: "control-practicas-f7b5a.firebaseapp.com",
  projectId: "control-practicas-f7b5a",
  storageBucket: "control-practicas-f7b5a.firebasestorage.app",
  messagingSenderId: "575083696161",
  appId: "1:575083696161:web:cfcfc60cd782339e92d360",
  measurementId: "G-RB4QWFHDV6"
};
// --- Google Drive (búsqueda de archivos) ---
// Client ID de OAuth (tipo "Aplicación web") creado en Google Cloud Console.
// Ver README para el paso a paso.
export const googleDriveConfig = {
  clientId: "TU_CLIENT_ID.apps.googleusercontent.com",
  folderId: "ID_DE_LA_CARPETA_DE_DRIVE",
};

// --- EmailJS (envío de notificaciones) ---
// Se obtienen en https://www.emailjs.com/ (plan gratis: 200 mails/mes)
export const emailjsConfig = {
  publicKey: "3TNv9_jszGm9ceZDv",
  serviceId: "service_1uto54c",
  templateId: "template_kchlwi9",
};
