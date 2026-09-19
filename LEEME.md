# Control de Prácticas Profesionalizantes

## Reemplazo

Conservar esta estructura al publicar el proyecto:

- `index.html`
- `css/style.css`
- `js/app.js`
- `js/drive.js`
- `js/firebase-config.js`
- `img/guemes.png`
- `firestore.rules.example` (referencia de seguridad para el rol alumno)

## Cambios principales

- Carga de una práctica para uno o varios alumnos.
- Horario, horas diarias, días concretos de asistencia, tutor y estado.
- Sólo las prácticas en estado **Realizada** contabilizan horas cumplidas.
- Asistencias automáticas en estado **Presente** para los días programados ya alcanzados.
- Corrección de asistencia a Presente, Tardanza, Ausente justificado, Ausente injustificado o Día reprogramado.
- Filtros por alumno, fecha y lugar.
- Dashboard con prácticas futuras y prácticas actualmente en curso.
- Configuración de bloques visibles del dashboard.
- Seguimiento de horas y asistencia dentro de la ficha de cada alumno.
- Portal de consulta para cuentas con rol `alumno`.
- Informes PDF configurables con logo, datos institucionales y devolución.
- Importación y actualización masiva de alumnos por legajo/DNI.
- Tablas paginadas automáticamente cada 20 registros.

La generación automática se ejecuta al iniciar sesión y al abrir Asistencia. Esto evita duplicados y permite funcionar con la arquitectura actual, sin servidor adicional.

## Rol alumno y seguridad

Para cada cuenta con rol `alumno`, completar `alumnoId` en su documento de la colección `usuarios`. Desde la interfaz administrativa esto se realiza al crear el perfil y elegir el alumno vinculado.

El archivo `firestore.rules.example` contiene una base de reglas para que cada alumno sólo pueda consultar sus propios datos. Debe compararse y combinarse con las reglas actuales antes de publicarlo en Firebase.
