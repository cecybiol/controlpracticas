# Prácticas Profesionalizantes

Sitio para llevar el control de las prácticas profesionalizantes de los alumnos:
horas por sector, fechas de práctica (con búsqueda), informes presentados,
búsqueda de archivos en una carpeta de Drive, faltas, asistencia y notificaciones
por mail. Pensado para 3 usuarios (administración/tutores) y hasta ~50 alumnos.

**Stack:** HTML/CSS/JS puro (sin build), Firebase Auth + Firestore, Google
Identity Services para Drive, EmailJS para los mails. Todo se sirve como
archivos estáticos, ideal para GitHub Pages.

## 1. Crear el proyecto de Firebase (gratis, sin tarjeta)

1. Entrá a https://console.firebase.google.com/ y creá un proyecto nuevo.
2. En **Authentication → Sign-in method**, habilitá el proveedor **Email/contraseña**.
3. En **Authentication → Users**, creá los 3 usuarios (email + contraseña) que van a usar el sistema.
   Copiá el **UID** de cada uno (lo vas a necesitar en el paso 5).
4. En **Firestore Database**, creá la base de datos (modo producción).
5. En **Firestore → Reglas**, pegá el contenido del archivo `firestore.rules` de este proyecto y publicá.
6. En **Configuración del proyecto → Tus apps**, agregá una app web y copiá el
   objeto de configuración (`apiKey`, `authDomain`, etc.) al archivo `js/firebase-config.js`.

## 2. Cargar los perfiles de usuario (nombre + rol)

Los 3 usuarios ya existen en Firebase Auth (paso 1.3), pero la app necesita
saber su nombre y si son "admin" o "tutor". Para el primer usuario (el admin),
hay que cargarlo a mano una vez desde la consola de Firestore, porque hasta
que exista un admin nadie puede usar la pantalla de "Usuarios" del sitio:

1. En **Firestore Database → Datos**, creá manualmente una colección `usuarios`.
2. Agregá un documento cuyo **ID sea el UID** de tu primer usuario (el admin), con estos campos:
   - `nombre` (string): tu nombre
   - `email` (string): el mismo email de esa cuenta
   - `rol` (string): `admin`
3. Iniciá sesión en el sitio con ese usuario. Desde la pantalla **Usuarios**
   ya vas a poder cargar los otros 2 (pegando su UID, que sacás de Authentication → Users).

## 3. Google Drive (búsqueda de archivos)

1. Andá a https://console.cloud.google.com/ y creá (o reusá) un proyecto.
2. **APIs y servicios → Biblioteca** → habilitá **Google Drive API**.
3. **APIs y servicios → Pantalla de consentimiento OAuth**: configurala como
   "Externa" (o "Interna" si usás Google Workspace), agregando los 3 emails
   como usuarios de prueba.
4. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**,
   tipo **Aplicación web**. En "Orígenes de JavaScript autorizados" agregá la
   URL donde vas a publicar el sitio (por ejemplo `https://tuusuario.github.io`).
5. Copiá el **Client ID** generado a `js/firebase-config.js` (`googleDriveConfig.clientId`).
6. Compartí la carpeta de Drive que querés que se pueda buscar con los emails
   de los 3 usuarios (o dejala accesible para cualquiera con el link, según prefieras).
7. Copiá el **ID de la carpeta** (está en la URL de Drive, después de `/folders/`)
   a `googleDriveConfig.folderId`.

Nota: como el sitio es estático, no hay forma de guardar una credencial de
Drive "compartida" de forma segura. Por eso cada usuario autoriza el acceso
de solo lectura desde su propia cuenta de Google la primera vez que usa esa
sección (botón "Conectar con Google Drive").

## 4. EmailJS (notificaciones por mail)

1. Creá una cuenta gratis en https://www.emailjs.com/ (200 mails/mes gratis).
2. Conectá tu servicio de mail (Gmail u otro) en **Email Services** y copiá el **Service ID**.
3. Creá una plantilla en **Email Templates**. Los **3 puntos que más se olvidan** (y por los que
   "no llega el mail" aunque el código esté bien) son:
   - En el campo **"To Email"** de la plantilla (no en el cuerpo del mensaje) tenés que poner `{{to_email}}`.
   - El **Service ID** y el **Template ID** de la plantilla tienen que estar copiados en
     `js/firebase-config.js`, junto con el **Public Key** (los 3 valores, no solo uno).
   - Si el dominio donde publicás el sitio (por ejemplo tu GitHub Pages) no está en la lista de
     dominios permitidos de tu cuenta de EmailJS (**Account → Security → Allowed origins**), el envío
     falla silenciosamente. Agregalo ahí.
4. En el **cuerpo** de la plantilla podés usar estas variables, que la app ya envía:
   `{{to_email}}`, `{{to_name}}`, `{{lugar}}`, `{{fecha}}`, `{{horario}}`, `{{tutor}}`, `{{contacto}}`,
   `{{mensaje_adicional}}` (el texto libre que se carga desde la pantalla de Notificaciones antes de enviar).
5. **Copia (CC) al docente/tutor:** en la plantilla, en el campo **"To CC"** (junto a "To Email"),
   poné `{{cc_email}}`. La app completa esa variable con el email que cargues en el campo
   "CC (docente/tutor)" de Notificaciones, o si lo dejás vacío, con el email del tutor que hayas
   cargado en esa práctica puntual (campo "Email del tutor/docente" del formulario de Fecha de práctica).
6. **Adjuntar el acuerdo de práctica en PDF:** en el editor de la plantilla, pestaña **Attachments →
   Add Attachment → Variable Attachment**, y como "Parameter name" poné `adjunto_acuerdo` (el nombre de
   archivo puede ser dinámico con `{{adjunto_nombre}}`, o fijo). Desde Notificaciones, subís el PDF una
   vez y se adjunta a todos los mails de esa tanda. Tené en cuenta:
   - Si nunca subís un archivo, no se envía adjunto (no hace falta sacar la configuración de la plantilla).
   - EmailJS tiene un límite de tamaño total por mail según tu plan (revisá https://www.emailjs.com/pricing/);
     un PDF muy pesado puede hacer fallar el envío.
   - Si el acuerdo es siempre el mismo archivo para todos los alumnos, es más simple usar un
     **Static Attachment** (subilo una sola vez en la plantilla) en lugar de subirlo cada vez.
7. Copiá el **Template ID** y tu **Public Key** (en Account → General).
8. Completá los tres valores en `js/firebase-config.js` (`emailjsConfig`).

## 5. Publicar en GitHub Pages

1. Subí todo este proyecto a un repositorio de GitHub.
2. En el repo: **Settings → Pages → Source**, elegí la rama `main` y la carpeta `/ (root)`.
3. Esperá un minuto y el sitio va a quedar publicado en
   `https://tuusuario.github.io/nombre-del-repo/`.
4. Volvé al paso 3.4 (Google Cloud) y al 6 (Firebase Authentication, si pide
   dominios autorizados) y agregá esa URL como origen permitido.

## Probarlo en tu computadora antes de subirlo

No hace falta ningún servidor especial, pero los módulos de JavaScript (`type="module"`)
no funcionan si abrís el `index.html` directo con doble click. Corré un
servidor simple desde la carpeta del proyecto, por ejemplo:

```bash
python3 -m http.server 8000
```

y abrí `http://localhost:8000` en el navegador.

## Qué hace cada sección

- **Horas / Dashboard**: panel general con totales (horas, alumnos, prácticas cargadas), horas acumuladas por sector y las próximas 5 prácticas agendadas.
- **Estadísticas**: definís un objetivo de horas por alumno y la sección calcula, para cada uno, cuántas horas **ya realizó** (separadas en internas / externas), cuántas tiene **pendientes/programadas**, qué porcentaje del objetivo cumplió (solo con horas realizadas) y cuántas horas le faltan. También muestra el promedio general de cumplimiento.
- **Fechas de práctica**: alta, edición, **eliminación** y búsqueda (por alumno, lugar, tutor, sector y rango de fechas) de cada práctica agendada, incluyendo Tipo (interna/externa), el email del tutor/docente (usado para copiar en las notificaciones) y un check "Ya se realizó" para marcar si esas horas ya se cumplieron o todavía están programadas.
- **Informes PP**: registro de los informes que cada alumno presenta, con estado (pendiente/entregado/aprobado/rechazado) y enlace opcional a Drive.
- **Buscar en Drive**: una vez conectada la cuenta de Google (botón "Conectar con Google Drive"), busca archivos por nombre dentro de la carpeta de Drive configurada en `firebase-config.js`. Necesita que completes `googleDriveConfig` (Client ID + ID de carpeta, ver punto 3 de esta guía) y que la carpeta esté compartida con los usuarios; si no ves resultados, revisá esos dos puntos antes que nada.
- **Faltas**: registro de inasistencias por alumno, con marca de "justificada" y motivo.
- **Asistencia**: registro de presente/ausente por fecha, con hora de entrada/salida y observaciones; se puede filtrar por alumno.
- **Notificaciones**: arma la lista de alumnos con prácticas dentro de los próximos N días y envía un mail recordatorio por EmailJS (necesita `emailjsConfig` completo, ver punto 4). Antes de enviar podés agregar un **mensaje adicional**, poner un **email en copia (CC)** para el docente/tutor (o dejar que use el de cada práctica) y **adjuntar el acuerdo de práctica en PDF**. La pantalla avisa si falta terminar de configurar EmailJS. Guarda un historial de envíos.
- **Alumnos**: alta, edición y **eliminación** de la ficha de cada alumno (legajo, nombre, apellido, email, sector, **curso/división**), con buscador por nombre/legajo/sector y filtro por curso. Desde el botón **"Ficha / Editar"** de cada alumno se abre una vista con sus datos editables y, debajo, **todas sus prácticas** (con acceso directo para editarlas, eliminarlas o cargar una nueva sin salir de la ficha). Eliminar un alumno también borra sus prácticas, faltas y registros de asistencia asociados (se pide confirmación).
- **Importar planilla**: sube un Excel/CSV con una fila por práctica (alumno + lugar + fecha + horas + asistencia); si el legajo no existe todavía crea el alumno (incluyendo su **curso/división**), y además genera automáticamente los registros de práctica y de asistencia correspondientes. Incluye botón de plantilla y una vista previa con validación antes de confirmar. Cada fila se marca como **Realizada** o **Pendiente**: se usa la columna "Estado" si la completás; si no, se mira "Presente" (sí/no); y si tampoco hay dato, se infiere por la fecha (pasada o de hoy = realizada, futura = pendiente). Solo las horas "Realizada" cuentan en Estadísticas y en el Dashboard.
- **Usuarios** (solo admin): alta de los 3 perfiles del sistema (nombre + rol), a partir del UID creado en Firebase Authentication.

## Estructura del proyecto

```
index.html            La app completa (todas las secciones)
css/style.css         Estilos
js/firebase-config.js  Tus claves de Firebase / Drive / EmailJS (completar)
js/app.js              Lógica principal: login, navegación, CRUD de Firestore
js/drive.js             Búsqueda en Google Drive (OAuth de navegador)
firestore.rules        Reglas de seguridad para pegar en Firebase Console
```

## Qué ampliaría primero

1. **Export a Excel/PDF** de horas por alumno y por sector (útil para
   entregar constancias o reportes a la institución).
   2. **Notificaciones automáticas programadas** (hoy el envío es manual con un
      botón): se podría sumar Google Apps Script como disparador diario gratuito
      que llame a EmailJS o a un webhook, sin necesitar un servidor propio.
3. **Registro de asistencia con QR o geolocalización** para que el alumno
   marque entrada/salida desde su celular en el lugar de práctica.
4. **Historial de cambios** (quién editó qué y cuándo) en Firestore, útil si
   hay auditorías.
5. **Recordatorio automático de faltas** cuando un alumno acumula más de N
   inasistencias no justificadas.
