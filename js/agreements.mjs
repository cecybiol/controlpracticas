import { unzipSync, zipSync, strFromU8, strToU8 } from './vendor/fflate-0.8.3.mjs';

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML = 'http://www.w3.org/XML/1998/namespace';
const MAX_TEMPLATE = 10 * 1024 * 1024;
export const agreementFields = [
  { key: 'nombre_alumno', label: 'Nombre del alumno' },
  { key: 'apellido_alumno', label: 'Apellido del alumno' },
  { key: 'alumno_completo', label: 'Apellido y nombre del alumno' },
  { key: 'dni_alumno', label: 'DNI del alumno' },
  { key: 'tutor_familiar', label: 'Apellido y nombre del tutor familiar' },
  { key: 'dni_tutor', label: 'DNI del tutor familiar' },
  { key: 'tutor_practica', label: 'Nombre y apellido del tutor de práctica' },
  { key: 'fecha_practica', label: 'Fecha o período de práctica' },
  { key: 'domicilio_alumno', label: 'Domicilio del alumno' },
  { key: 'domicilio_tutor', label: 'Domicilio del tutor familiar' },
  { key: 'lugar_practica', label: 'Lugar de práctica' },
  { key: 'domicilio_practica', label: 'Domicilio del lugar de práctica' },
];
const wordParts = name => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name);
const cleanValue = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function parseWord(bytes, tools) {
  const xml = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('La plantilla contiene una definición XML no admitida. Guardala nuevamente como Word (.docx).');
  const document = new tools.DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error('No se pudo leer el contenido Word de la plantilla.');
  return document;
}

// Agrupa texto dentro de un párrafo sin cruzar celdas, saltos ni campos de Word.
function textGroups(document) {
  const groups = [];
  const visit = (node, group) => {
    if (node.namespaceURI === WORD && node.localName === 'p') return;
    if (node.namespaceURI === WORD && node.localName === 't') group.push(node);
    else if (node.namespaceURI === WORD && ['tab', 'br', 'cr', 'fldChar', 'instrText'].includes(node.localName)) {
      if (group.length) groups.push(group.splice(0));
    } else for (const child of node.childNodes) visit(child, group);
  };
  for (const paragraph of document.getElementsByTagNameNS(WORD, 'p')) {
    const group = [];
    for (const child of paragraph.childNodes) visit(child, group);
    if (group.length) groups.push(group);
  }
  return groups;
}
const groupText = group => group.map(node => node.textContent).join('');
function isBold(node) {
  const run = node.parentElement;
  const properties = [...(run?.children || [])].find(child => child.namespaceURI === WORD && child.localName === 'rPr');
  const bold = properties && [...properties.children].find(child => child.namespaceURI === WORD && child.localName === 'b');
  return !!bold && !['0', 'false', 'off'].includes(bold.getAttributeNS(WORD, 'val'));
}

export function readAgreementTemplate(bytes, tools = globalThis) {
  if (!bytes?.length || bytes.length > MAX_TEMPLATE) throw new Error('Elegí una plantilla .docx de hasta 10 MB.');
  let size = 0, entries = 0;
  let files;
  try {
    files = unzipSync(bytes, { filter: entry => {
      size += entry.originalSize;
      if (++entries > 2000 || size > 40 * 1024 * 1024) throw new Error('La plantilla supera el tamaño permitido al descomprimirla.');
      return true;
    } });
  } catch (err) {
    throw new Error(`No se pudo abrir la plantilla Word. ${err.message || ''}`);
  }
  if (!files['word/document.xml'] || !files['[Content_Types].xml'] || files['word/vbaProject.bin']) throw new Error('El archivo debe ser un documento Word (.docx) sin macros.');
  const parts = Object.keys(files).filter(wordParts).map(name => ({ name, document: parseWord(files[name], tools) }));
  const groups = parts.flatMap(part => textGroups(part.document));
  const bold = new Set();
  for (const group of groups) {
    let fragment = '';
    for (const node of group) {
      if (isBold(node)) fragment += node.textContent;
      else { if (fragment.trim()) bold.add(fragment.trim()); fragment = ''; }
    }
    if (fragment.trim()) bold.add(fragment.trim());
  }
  return { files, parts, text: groups.map(groupText).join('\n'), bold: [...bold] };
}

export function mappingCount(template, text) {
  if (!text) return 0;
  let total = 0;
  for (const { document } of template.parts) for (const group of textGroups(document)) {
    const source = groupText(group);
    let position = 0;
    while ((position = source.indexOf(text, position)) !== -1) { total++; position += text.length; }
  }
  return total;
}

function matchesFor(source, mappings) {
  const matches = [];
  for (const field of mappings) {
    let position = 0;
    while ((position = source.indexOf(field.source, position)) !== -1) {
      matches.push({ start: position, end: position + field.source.length, key: field.key });
      position += field.source.length;
    }
  }
  matches.sort((a,b) => a.start - b.start || b.end - a.end);
  for (let i = 1; i < matches.length; i++) if (matches[i].start < matches[i - 1].end) {
    throw new Error('Dos campos señalan el mismo texto o fragmentos superpuestos. Usá textos distintos o un solo campo para el nombre completo.');
  }
  return matches;
}

export function validateAgreementMappings(template, mappings) {
  if (!mappings.length) throw new Error('Seleccioná al menos un campo para reemplazar.');
  for (const field of mappings) {
    if (!field.source?.trim() || !mappingCount(template, field.source)) throw new Error(`No se encontró el texto asignado a ${field.label}. Copialo desde la vista del texto.`);
  }
  for (const { document } of template.parts) for (const group of textGroups(document)) matchesFor(groupText(group), mappings);
}

export function agreementPreview(template, mappings, values) {
  validateAgreementMappings(template, mappings);
  return template.parts.flatMap(({ document }) => textGroups(document).map(group => {
    const source = groupText(group);
    let result = source;
    for (const match of matchesFor(source, mappings).reverse()) result = result.slice(0, match.start) + cleanValue(values[match.key]) + result.slice(match.end);
    return result;
  })).join('\n');
}

export function generateAgreement(template, mappings, values, tools = globalThis) {
  validateAgreementMappings(template, mappings);
  for (const field of mappings) if (!cleanValue(values[field.key])) throw new Error(`Completá ${field.label}.`);
  const files = { ...template.files };
  for (const part of template.parts) {
    const document = part.document.cloneNode(true);
    for (const group of textGroups(document)) {
      let offset = 0;
      const spans = group.map(node => {
        const start = offset;
        offset += node.textContent.length;
        return { node, start, end: offset };
      });
      for (const match of matchesFor(groupText(group), mappings).reverse()) {
        let inserted = false;
        for (const span of spans) {
          if (span.end <= match.start || span.start >= match.end) continue;
          const start = Math.max(0, match.start - span.start);
          const end = Math.min(span.end - span.start, match.end - span.start);
          const replacement = inserted ? '' : cleanValue(values[match.key]);
          span.node.textContent = span.node.textContent.slice(0, start) + replacement + span.node.textContent.slice(end);
          span.node.setAttributeNS(XML, 'xml:space', 'preserve');
          inserted = true;
        }
      }
    }
    files[part.name] = strToU8(new tools.XMLSerializer().serializeToString(document));
  }
  return zipSync(files, { level: 6 });
}

export function agreementValues(student, practice) {
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : '';
  const start = date(practice.fecha), end = date(practice.fechaFin);
  return {
    nombre_alumno: cleanValue(student.nombre), apellido_alumno: cleanValue(student.apellido),
    alumno_completo: cleanValue(`${student.apellido || ''} ${student.nombre || ''}`),
    dni_alumno: cleanValue(student.dni), tutor_familiar: cleanValue(student.tutorFamiliar), dni_tutor: cleanValue(student.dniTutor),
    tutor_practica: cleanValue(practice.tutorResponsable),
    fecha_practica: end && start !== end ? `${start} al ${end}` : start,
    domicilio_alumno: cleanValue(student.domicilio || student.direccion), domicilio_tutor: cleanValue(student.domicilioTutor),
    lugar_practica: cleanValue(practice.lugar), domicilio_practica: cleanValue(practice.domicilioLugar || practice.direccionLugar),
  };
}

export function validateAgreementBatch(rows, mappings) {
  if (!rows.length) throw new Error('Seleccioná alumnos y prácticas para generar sus acuerdos.');
  if (rows.length > 50) throw new Error('Generá hasta 50 acuerdos por tanda.');
  const names = new Set();
  for (const row of rows) {
    if (!/^[^\\/:*?"<>|\x00-\x1f]{1,150}\.docx$/i.test(row.filename) || row.filename.startsWith('.')) throw new Error(`Revisá el nombre de archivo de ${row.label}. Debe terminar en .docx y no contener barras.`);
    const name = row.filename.normalize('NFC').toLowerCase();
    if (names.has(name)) throw new Error('Dos acuerdos tienen el mismo nombre de archivo. Diferencialos antes de descargar.');
    names.add(name);
    for (const field of mappings) if (!cleanValue(row.values[field.key])) throw new Error(`${row.label} — completá ${field.label}.`);
  }
}

export const agreementZip = files => zipSync(Object.fromEntries(files.map(file => [file.name, [file.bytes, { level: 0 }]])), { level: 0 });
