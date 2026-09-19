# Control de Prácticas Profesionalizantes

## Reemplazo

Conservar esta estructura al publicar el proyecto:

- `index.html`
- `css/style.css`
- `js/app.js`
- `js/drive.js`
- `js/firebase-config.js`
- `img/guemes.png`

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

La generación automática se ejecuta al iniciar sesión y al abrir Asistencia. Esto evita duplicados y permite funcionar con la arquitectura actual, sin servidor adicional.
