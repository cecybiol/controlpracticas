import { agreementFields, readAgreementTemplate, mappingCount, validateAgreementMappings, agreementValues, agreementPreview, generateAgreement, validateAgreementBatch, agreementZip } from './agreements.mjs';

export function initAgreementEditor({ document, tools, readPage, studentId, allowed, filenameFor, download, message }) {
  const root = document.getElementById('acuerdos-editor');
  const byId = id => document.getElementById(id);
  let template = null, selected = new Map(), candidates = new Map(), fields = [], epoch = 0, uploadVersion = 0, loading = false;
  const status = text => { byId('acuerdos-estado').textContent = text; };
  const mappings = () => [...root.querySelectorAll('[data-acuerdo-mapa]')].filter(row => row.querySelector('input[type=checkbox]').checked).map(row => ({
    ...fields.find(field => field.key === row.dataset.acuerdoMapa), source: row.querySelector('input[type=text]').value,
  }));
  const syncButtons = () => {
    byId('acuerdos-generar').disabled = !template || !selected.size || loading;
    byId('acuerdos-contador').textContent = `${selected.size} acuerdos seleccionados de hasta 50 por tanda`;
  };
  const action = fn => async event => {
    if (!allowed()) return;
    try { await fn(event); } catch (err) { status(message(err)); }
  };
  function renderMappings() {
    const body = byId('acuerdos-mapas');
    body.replaceChildren();
    const choices = byId('acuerdos-asignar-campo');
    choices.replaceChildren();
    for (const field of fields) {
      const row = document.createElement('tr');
      row.dataset.acuerdoMapa = field.key;
      const activeCell = document.createElement('td'), labelCell = document.createElement('th'), textCell = document.createElement('td'), countCell = document.createElement('td');
      labelCell.scope = 'row'; labelCell.textContent = field.label;
      const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'form-check-input'; check.setAttribute('aria-label', `Reemplazar ${field.label}`);
      const input = document.createElement('input'); input.type = 'text'; input.className = 'form-control form-control-sm'; input.setAttribute('aria-label', `Texto original para ${field.label}`); input.setAttribute('list', 'acuerdos-negritas'); input.maxLength = 500;
      input.value = field.source || `{{${field.key}}}`;
      check.checked = field.active ?? !!(template && mappingCount(template, input.value));
      const update = () => {
        countCell.textContent = template ? String(mappingCount(template, input.value)) : '—';
        field.source = input.value; field.active = check.checked;
        renderSelected();
      };
      input.addEventListener('input', update); check.addEventListener('change', update);
      activeCell.append(check); textCell.append(input); row.append(activeCell, labelCell, textCell, countCell); body.append(row);
      countCell.textContent = template ? String(mappingCount(template, input.value)) : '—';
      const option = document.createElement('option'); option.value = field.key; option.textContent = field.label; choices.append(option);
    }
    renderSelected();
  }
  function renderSelected() {
    const content = byId('acuerdos-seleccionados');
    const open = new Set([...content.querySelectorAll('details[open]')].map(node => node.dataset.acuerdoId));
    content.replaceChildren();
    const enabled = mappings();
    for (const [id, row] of selected) {
      const card = document.createElement('details'); card.className = 'border rounded p-3 mb-2'; card.dataset.acuerdoId = id; card.open = open.has(id) || selected.size === 1;
      const summary = document.createElement('summary'); summary.className = 'fw-semibold'; summary.textContent = `${row.label} · ${row.practice.lugar || ''} · ${row.values.fecha_practica}`;
      const grid = document.createElement('div'); grid.className = 'row g-2 mt-1';
      for (const field of enabled) {
        const wrap = document.createElement('div'); wrap.className = 'col-md-6';
        const label = document.createElement('label'); label.className = 'form-label w-100 small'; label.append(field.label);
        const input = document.createElement('input'); input.className = 'form-control form-control-sm'; input.type = 'text'; input.maxLength = 500; input.value = row.values[field.key] || ''; input.dataset.acuerdoValor = field.key;
        input.addEventListener('input', () => { row.values[field.key] = input.value; byId('acuerdos-vista-generada').value = ''; });
        label.append(input); wrap.append(label); grid.append(wrap);
      }
      const fileLabel = document.createElement('label'); fileLabel.className = 'form-label w-100 small mt-2'; fileLabel.append('Nombre del archivo Word');
      const fileInput = document.createElement('input'); fileInput.className = 'form-control form-control-sm'; fileInput.value = row.filename; fileInput.maxLength = 155;
      fileInput.addEventListener('input', () => { row.filename = fileInput.value.trim(); }); fileLabel.append(fileInput);
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'btn btn-sm btn-outline-primary me-2'; preview.textContent = 'Vista del texto completado';
      preview.addEventListener('click', action(() => {
        if (!template) throw new Error('Cargá la plantilla Word.');
        byId('acuerdos-vista-generada').value = agreementPreview(template, mappings(), row.values);
        byId('acuerdos-vista-generada').focus();
      }));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-sm btn-outline-danger'; remove.textContent = 'Quitar';
      remove.addEventListener('click', () => { selected.delete(id); renderCandidates(); renderSelected(); });
      card.append(summary, grid, fileLabel, preview, remove); content.append(card);
    }
    byId('acuerdos-vista-generada').value = '';
    syncButtons();
  }
  function renderCandidates() {
    const body = byId('tabla-acuerdos-practicas'); body.replaceChildren();
    for (const [id, row] of candidates) {
      const tr = document.createElement('tr'), select = document.createElement('td');
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(id); check.className = 'form-check-input'; check.setAttribute('aria-label', `Seleccionar ${row.label}`);
      check.addEventListener('change', action(() => {
        if (check.checked) {
          if (selected.size >= 50) { check.checked = false; throw new Error('Generá hasta 50 acuerdos por tanda.'); }
          selected.set(id, { ...row, values: { ...row.values } });
        } else selected.delete(id);
        renderSelected();
      }));
      select.append(check); tr.append(select);
      for (const text of [row.label, row.values.fecha_practica, row.practice.lugar || '', row.practice.sector || '']) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
      body.append(tr);
    }
    if (!candidates.size) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 5; cell.textContent = 'No se encontraron prácticas activas en esta página.'; }
  }
  async function loadCandidates(move = 0) {
    if (!allowed() || loading) return;
    const from = byId('acuerdos-desde').value, to = byId('acuerdos-hasta').value;
    if (!from || !to || from > to) throw new Error('Indicá un período de búsqueda válido.');
    const current = epoch;
    loading = true; syncButtons(); status('Buscando alumnos y prácticas…');
    try {
      const page = await readPage({ from, to, alumnoId: studentId(), move }, loadCandidates);
      if (!page || epoch !== current || !allowed()) return;
      candidates = new Map(page.map(({ practice, student }) => {
        const label = `${student.apellido || ''} ${student.nombre || ''}`.trim() || practice.alumnoId;
        return [practice.id, { practice, label, values: agreementValues(student, practice), filename: filenameFor(student, practice) }];
      }));
      renderCandidates(); status('Marcá cada alumno con la práctica para la que corresponde generar el acuerdo. La selección se conserva al cambiar de página.');
    } finally { if (epoch === current) { loading = false; syncButtons(); } }
  }
  byId('acuerdos-buscar').addEventListener('click', action(() => loadCandidates()));
  byId('acuerdos-plantilla').addEventListener('change', action(async event => {
    const file = event.target.files[0];
    const current = epoch, version = ++uploadVersion;
    template = null; byId('acuerdos-texto').value = ''; byId('acuerdos-negritas').replaceChildren(); syncButtons();
    if (!file) { status('Cargá una plantilla Word.'); return; }
    if (!/\.docx$/i.test(file.name) || file.size > 10 * 1024 * 1024) throw new Error('Elegí un archivo Word .docx de hasta 10 MB.');
    status('Leyendo plantilla…');
    const bytes = await new Promise((resolve, reject) => {
      const reader = new tools.FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result)); reader.onerror = () => reject(new Error('No se pudo leer la plantilla.')); reader.readAsArrayBuffer(file);
    });
    if (epoch !== current || uploadVersion !== version || !allowed()) return;
    template = readAgreementTemplate(bytes, tools);
    fields = agreementFields.map(field => ({ ...field }));
    byId('acuerdos-texto').value = template.text;
    for (const text of template.bold) { const option = document.createElement('option'); option.value = text; byId('acuerdos-negritas').append(option); }
    renderMappings(); status(`Plantilla cargada. Se detectaron ${template.bold.length} fragmentos en negrita para asignar a los campos.`);
  }));
  byId('acuerdos-asignar').addEventListener('click', action(() => {
    const preview = byId('acuerdos-texto');
    const source = preview.value.slice(preview.selectionStart, preview.selectionEnd).trim();
    if (!template || !source || source.includes('\n')) throw new Error('Seleccioná un fragmento dentro de un mismo párrafo de la vista del texto.');
    const key = byId('acuerdos-asignar-campo').value;
    for (const row of root.querySelectorAll('[data-acuerdo-mapa]')) if (row.dataset.acuerdoMapa === key) {
      row.querySelector('input[type=text]').value = source; row.querySelector('input[type=checkbox]').checked = true; row.querySelector('input[type=text]').dispatchEvent(new tools.Event('input'));
    }
    status('Texto asignado. Verificá la cantidad de coincidencias antes de generar.');
  }));
  byId('acuerdos-agregar-campo').addEventListener('click', action(() => {
    const label = byId('acuerdos-campo-nuevo').value.trim();
    if (!label) throw new Error('Escribí el nombre del campo adicional.');
    if (fields.length >= 25) throw new Error('Se admiten hasta 25 campos por plantilla.');
    fields.push({ key: `campo_${fields.length + 1}`, label });
    byId('acuerdos-campo-nuevo').value = ''; renderMappings();
  }));
  byId('acuerdos-limpiar').addEventListener('click', action(() => { selected.clear(); renderCandidates(); renderSelected(); status('Selección vaciada.'); }));
  byId('acuerdos-generar').addEventListener('click', action(async () => {
    if (!template || loading) return;
    const fieldsToReplace = mappings(), rows = [...selected.values()];
    validateAgreementMappings(template, fieldsToReplace); validateAgreementBatch(rows, fieldsToReplace);
    loading = true; syncButtons(); status('Generando acuerdos…');
    const controls = [...root.querySelectorAll('input,button,select')].map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; });
    const current = epoch;
    try {
      const output = [];
      let size = 0;
      for (const row of rows) {
        if (epoch !== current || !allowed()) return;
        const bytes = generateAgreement(template, fieldsToReplace, row.values, tools);
        size += bytes.length;
        if (size > 80 * 1024 * 1024) throw new Error('Esta tanda supera 80 MB. Seleccioná menos alumnos.');
        output.push({ name: row.filename, bytes });
        status(`Generados ${output.length} de ${rows.length} acuerdos…`);
        await new Promise(resolve => tools.setTimeout(resolve, 0));
      }
      if (epoch !== current || !allowed()) return;
      const bytes = rows.length === 1 ? output[0].bytes : agreementZip(output);
      download(bytes, rows.length === 1 ? output[0].name : 'acuerdos-practicas.zip', rows.length === 1 ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/zip');
      status(`Se generaron ${rows.length} acuerdos Word. Revisá los documentos antes de firmar. Para adjuntarlos a los avisos, exportalos como PDF y subilos a la carpeta de acuerdos configurada.`);
    } finally {
      controls.forEach(({ control, disabled }) => { control.disabled = disabled; });
      loading = false; syncButtons();
    }
  }));
  function reset() {
    epoch++; template = null; selected.clear(); candidates.clear(); fields = agreementFields.map(field => ({ ...field })); loading = false;
    for (const id of ['acuerdos-texto', 'acuerdos-vista-generada', 'acuerdos-plantilla', 'acuerdos-campo-nuevo']) byId(id).value = '';
    byId('acuerdos-negritas').replaceChildren(); renderMappings(); byId('tabla-acuerdos-practicas').replaceChildren(); status('Cargá la plantilla y buscá los alumnos para comenzar.');
  }
  reset();
  return { reset };
}
