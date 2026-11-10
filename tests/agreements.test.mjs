import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../js/vendor/fflate-0.8.3.mjs';
import { readAgreementTemplate, generateAgreement, agreementFields, agreementValues, agreementPreview, mappingCount, validateAgreementMappings, validateAgreementBatch, agreementZip } from '../js/agreements.mjs';
import { initAgreementEditor } from '../js/agreements-ui.mjs';

const dom = new JSDOM('<!doctype html>');
const tools = dom.window;
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const xml = text => `<w:document xmlns:w="${ns}"><w:body>${text}</w:body></w:document>`;
const content = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Escuela Técnica</w:t></w:r><w:r><w:t> — {{nombre_</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>alumno}} {{apellido_alumno}}</w:t></w:r></w:p><w:p><w:r><w:t>Autorizo a {{nombre_alumno}} {{apellido_alumno}}.</w:t></w:r></w:p>';
const bytes = zipSync({
  '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml(content)),
  'word/header1.xml': strToU8(xml('<w:p><w:r><w:t>{{apellido_alumno}}</w:t></w:r></w:p>')),
  'word/media/image1.png': new Uint8Array([1, 2, 3, 4]),
});
const fields = ['nombre_alumno', 'apellido_alumno'].map(key => ({ ...agreementFields.find(f => f.key === key), source: `{{${key}}}` }));

test('Reemplaza nombres divididos en estilos, repeticiones y encabezados con tildes y XML literal', () => {
  const template = readAgreementTemplate(bytes, tools);
  const values = { nombre_alumno: 'Ana & Lucía', apellido_alumno: 'Muñoz <Gómez>' };
  assert.equal(mappingCount(template, '{{apellido_alumno}}'), 3);
  const result = generateAgreement(template, fields, values, tools);
  const files = unzipSync(result);
  const text = readAgreementTemplate(result, tools).text;
  assert.match(text, /Escuela Técnica — Ana & Lucía Muñoz <Gómez>/);
  assert.match(text, /Autorizo a Ana & Lucía Muñoz <Gómez>/);
  assert.doesNotMatch(text, /\{\{/);
  assert.match(strFromU8(files['word/header1.xml']), /Muñoz &lt;Gómez&gt;/);
  assert.deepEqual([...files['word/media/image1.png']], [1, 2, 3, 4]);
  assert.match(strFromU8(files['word/document.xml']), /<w:b\/>/);
  assert.equal(template.text.includes('{{nombre_alumno}}'), true);
  assert.equal(agreementPreview(template, fields, values), text);
});

test('Detecta texto en negrita y conserva textos no elegidos al reemplazar literalmente', () => {
  const template = readAgreementTemplate(bytes, tools);
  assert.ok(template.bold.includes('Escuela Técnica'));
  const result = generateAgreement(template, [{ key: 'institucion', label: 'Institución', source: 'Escuela Técnica' }], { institucion: 'Escuela N.º 10' }, tools);
  const text = readAgreementTemplate(result, tools).text;
  assert.match(text, /Escuela N.º 10/);
  assert.match(text, /\{\{nombre_alumno\}\}/);
});

test('Dos reemplazos en el mismo fragmento conservan texto y formato con longitudes diferentes', () => {
  const template = readAgreementTemplate(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>ABA XX ABA ZZ</w:t></w:r></w:p>')) }), tools);
  const mappings = [{ key: 'a', label: 'A', source: 'ABA' }, { key: 'z', label: 'Z', source: 'ZZ' }];
  const generated = generateAgreement(template, mappings, { a: 'Nombre larguísimo', z: 'Z' }, tools);
  assert.equal(readAgreementTemplate(generated, tools).text, 'Nombre larguísimo XX Nombre larguísimo Z');
});

test('Bloquea fuentes ausentes o superpuestas y valores faltantes', () => {
  const template = readAgreementTemplate(bytes, tools);
  assert.throws(() => validateAgreementMappings(template, []), /Seleccioná/);
  assert.throws(() => validateAgreementMappings(template, [{ key: 'x', label: 'Dato', source: 'No existe' }]), /No se encontró/);
  assert.throws(() => validateAgreementMappings(template, [...fields, { key: 'x', label: 'Repetido', source: 'apellido_alumno' }]), /superpuestos/);
  assert.throws(() => generateAgreement(template, fields, { nombre_alumno: 'Ana' }, tools), /Apellido/);
});

test('No confunde tutor familiar con tutor de práctica ni legajo con DNI', () => {
  const values = agreementValues({ nombre: 'Ana', apellido: 'Muñoz', legajo: '123', tutorFamiliar: 'Gómez Julia', dniTutor: '20202020', domicilio: 'Calle A 123', domicilioTutor: 'Calle B 456' }, { tutorResponsable: 'Carlos Pérez', fecha: '2026-04-10', fechaFin: '2026-04-17', lugar: 'Instituto', domicilioLugar: 'Calle C 789' });
  assert.equal(values.dni_alumno, '');
  assert.equal(values.tutor_familiar, 'Gómez Julia');
  assert.equal(values.tutor_practica, 'Carlos Pérez');
  assert.equal(values.domicilio_alumno, 'Calle A 123');
  assert.equal(values.domicilio_tutor, 'Calle B 456');
  assert.equal(values.domicilio_practica, 'Calle C 789');
  assert.equal(values.fecha_practica, '10/04/2026 al 17/04/2026');
});

test('Una tanda valida datos y nombres únicos y produce un ZIP con todos los Word', () => {
  const row = { label: 'Ana', filename: 'ana.docx', values: { nombre_alumno: 'Ana', apellido_alumno: 'Muñoz' } };
  assert.throws(() => validateAgreementBatch([], fields), /Seleccioná/);
  assert.throws(() => validateAgreementBatch([{ ...row, filename: '../ana.docx' }], fields), /nombre/);
  assert.throws(() => validateAgreementBatch([row, { ...row, filename: 'ANA.docx' }], fields), /mismo nombre/);
  assert.throws(() => validateAgreementBatch([{ ...row, values: { nombre_alumno: 'Ana' } }], fields), /completá Apellido/);
  const other = { ...row, filename: 'bruno.docx', values: { nombre_alumno: 'Bruno', apellido_alumno: 'Gómez' } };
  validateAgreementBatch([row, other], fields);
  const template = readAgreementTemplate(bytes, tools);
  const zip = unzipSync(agreementZip([row, other].map(r => ({ name: r.filename, bytes: generateAgreement(template, fields, r.values, tools) }))));
  assert.equal(Object.keys(zip).length, 2);
  assert.match(readAgreementTemplate(zip['bruno.docx'], tools).text, /Bruno Gómez/);
});

test('Rechaza archivos incorrectos, macros y XML inválido', () => {
  assert.throws(() => readAgreementTemplate(new Uint8Array([1, 2, 3]), tools), /Word/);
  assert.throws(() => readAgreementTemplate(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('invalid') }), tools), /contenido Word/);
  assert.throws(() => readAgreementTemplate(zipSync({ 'word/document.xml': strToU8(xml(content)), '[Content_Types].xml': strToU8('<Types/>'), 'word/vbaProject.bin': new Uint8Array([1]) }), tools), /sin macros/);
});

test('Flujo de Avisos carga plantilla, selecciona prácticas, edita y descarga documentos independientes', async () => {
  const browser = new JSDOM(fs.readFileSync('index.html', 'utf8'));
  const document = browser.window.document, downloads = [];
  const rows = [1, 2].map(n => ({ practice: { id: `p${n}`, alumnoId: `a${n}`, fecha: '2026-04-10', lugar: 'Escuela' }, student: { nombre: n === 1 ? 'Ana' : 'Bruno', apellido: 'Muñoz' } }));
  let page = 0;
  const editor = initAgreementEditor({ document, tools: browser.window, readPage: async () => [rows[page++]], studentId: () => '', allowed: () => true, filenameFor: a => a.nombre.toLowerCase() + '.docx', download: (...args) => downloads.push(args), message: err => err.message });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  const fileInput = document.getElementById('acuerdos-plantilla');
  Object.defineProperty(fileInput, 'files', { value: [new browser.window.File([bytes], 'modelo.docx')], configurable: true });
  fileInput.dispatchEvent(new browser.window.Event('change')); await settle();
  assert.match(document.getElementById('acuerdos-estado').textContent, /Plantilla cargada/);
  assert.equal(document.querySelectorAll('[data-acuerdo-mapa] input[type=checkbox]:checked').length, 2);
  document.getElementById('acuerdos-desde').value = '2026-04-01'; document.getElementById('acuerdos-hasta').value = '2026-04-30';
  for (let i = 0; i < 2; i++) {
    document.getElementById('acuerdos-buscar').click(); await settle();
    const check = document.querySelector('#tabla-acuerdos-practicas input'); check.checked = true; check.dispatchEvent(new browser.window.Event('change'));
  }
  assert.equal(document.querySelectorAll('[data-acuerdo-id]').length, 2);
  const first = document.querySelector('[data-acuerdo-id="p1"] [data-acuerdo-valor="nombre_alumno"]');
  first.value = 'Ana Lucía'; first.dispatchEvent(new browser.window.Event('input'));
  document.getElementById('acuerdos-generar').click(); await settle();
  assert.equal(downloads.length, 1); assert.equal(downloads[0][1], 'acuerdos-practicas.zip');
  const zip = unzipSync(downloads[0][0]);
  assert.match(readAgreementTemplate(zip['ana.docx'], tools).text, /Ana Lucía/);
  assert.match(readAgreementTemplate(zip['bruno.docx'], tools).text, /Bruno/);
  assert.equal(rows[0].student.nombre, 'Ana');
  editor.reset();
  assert.equal(document.querySelectorAll('[data-acuerdo-id]').length, 0);
  assert.equal(document.getElementById('acuerdos-generar').disabled, true);
  assert.equal(document.getElementById('acuerdos-texto').value, '');
  browser.window.close();
});

test.after(() => dom.window.close());
