// A small, forgiving vCard (.vcf) reader for phone-book exports: 2.1 (Android, QUOTED-PRINTABLE), 3.0 and 4.0.
// It keeps only a name and Indian mobile numbers; emails, addresses, photos, notes and everything else are dropped
// as they are read. Pure: bytes in, [{ name, phones }] out.
const AppError = require('../../core/AppError');
const { normalizePhone } = require('../users/contact.helper');

const MAX_CARDS = 10_000;
const MAX_PHONES_PER_CARD = 10;
const MAX_NAME = 80;

// A metro landline reads like a mobile once its 0 or +91 is taken off ("080-2345 6789" → 8023456789), and
// normalizePhone cannot tell. Spot those by their area code and grouping; a number marked TYPE=CELL is trusted.
const METRO_LANDLINE = /^(?:tel:)?\s*(?:\+?91[\s.-]*)?0?[\s.-]*(11|20|22|33|40|44|79|80)[\s.-]+\d{4}[\s.-]?\d{4}\s*$/i;

// BOM-aware decoding. Exports are UTF-8 almost always; some tools write UTF-16.
function decodeFile(input) {
  if (typeof input === 'string') return input.replace(/^﻿/, '');
  const b = Buffer.from(input);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const start = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  return b.subarray(start).toString('utf8');
}

// Splits on `sep` outside double quotes (parameter values may be quoted) and without a leading backslash.
function splitOutsideQuotes(text, sep, { honourEscapes = false } = {}) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (honourEscapes && ch === '\\' && i + 1 < text.length) { current += ch + text[i + 1]; i += 1; continue; }
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) { parts.push(current); current = ''; } else current += ch;
  }
  parts.push(current);
  return parts;
}

// Physical lines → logical lines: RFC folding (a line starting with space/tab continues the one before) and the
// 2.1 QUOTED-PRINTABLE soft break (a QP line ending in "=" continues on the next line).
function logicalLines(text) {
  const out = [];
  let current = null;
  const isQp = (line) => /^[^:]*;(?:ENCODING=)?(?:QUOTED-PRINTABLE|Q)(?:;|:)/i.test(line);
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (current !== null && isQp(current) && current.endsWith('=')) current = current.slice(0, -1) + line;
    else if (current !== null && /^[ \t]/.test(line)) current += line.slice(1);
    else {
      if (current !== null) out.push(current);
      current = line;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

// "item1.TEL;TYPE=CELL;CHARSET=UTF-8:+91 …" → { name: 'TEL', params: {...}, value }
function parseLine(line) {
  const colon = (() => {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ':' && !quoted) return i;
    }
    return -1;
  })();
  if (colon < 1) return null;
  const [rawName, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ';');
  const name = rawName.slice(rawName.lastIndexOf('.') + 1).trim().toUpperCase(); // drop a group prefix ("item1.")
  const types = new Set();
  let encoding = '';
  let charset = '';
  for (const param of rawParams) {
    const eq = param.indexOf('=');
    const key = (eq < 0 ? 'TYPE' : param.slice(0, eq)).trim().toUpperCase();
    const val = (eq < 0 ? param : param.slice(eq + 1)).replace(/"/g, '').trim();
    if (key === 'ENCODING') encoding = val.toUpperCase();
    else if (key === 'CHARSET') charset = val;
    else if (key === 'TYPE') for (const t of val.split(',')) types.add(t.trim().toUpperCase());
  }
  // 2.1 writes the encoding as a bare parameter: "FN;QUOTED-PRINTABLE:".
  const qp = encoding === 'QUOTED-PRINTABLE' || encoding === 'Q' || types.has('QUOTED-PRINTABLE');
  return { name, types, qp, charset, value: line.slice(colon + 1) };
}

function decodeQuotedPrintable(text, charset) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...Buffer.from(text[i], 'utf8'));
  }
  try { return new TextDecoder(charset || 'utf-8').decode(Uint8Array.from(bytes)); } catch { return Buffer.from(bytes).toString('utf8'); }
}

// vCard text escapes: \n → space (a name never needs a line break), \, \; \\ → the character.
const unescapeText = (text) => text.replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? ' ' : c));
const cleanName = (text) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();

// One value → its text parts (structured values like N split on ";" first, so an encoded ";" stays inside a part).
function parts(prop, { structured = false } = {}) {
  const raw = structured ? splitOutsideQuotes(prop.value, ';', { honourEscapes: true }) : [prop.value];
  return raw.map((p) => (prop.qp ? decodeQuotedPrintable(p, prop.charset) : p)).map(unescapeText);
}

function finishCard(card) {
  const [family = '', given = '', additional = ''] = card.n || [];
  const fromN = [given, additional, family].map((s) => s.trim()).filter(Boolean).join(' ');
  const name = cleanName(card.fn || fromN || card.org || '');
  const phones = [...new Set(card.tels)].slice(0, MAX_PHONES_PER_CARD);
  return { name, phones };
}

/**
 * Reads every card in a .vcf file. Cards come back even when they have no usable name or number (the caller
 * counts those as skipped). Throws a friendly AppError for a file that isn't vCard data or has too many cards.
 */
function parseVcf(input, { maxCards = MAX_CARDS } = {}) {
  const text = decodeFile(input);
  if (!/BEGIN:VCARD/i.test(text)) {
    throw AppError.badRequest('That doesn’t look like a contacts file. Export your contacts as a .vcf (vCard) file and try again.', 'NOT_A_VCARD');
  }
  const cards = [];
  let card = null;
  const close = () => { if (card) { cards.push(finishCard(card)); card = null; } };
  for (const line of logicalLines(text)) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      close(); // a card missing its END:VCARD still counts
      if (cards.length >= maxCards) {
        throw AppError.badRequest(`That file has more than ${maxCards.toLocaleString('en-IN')} contacts. Export a smaller group and try again.`, 'TOO_MANY_CONTACTS');
      }
      card = { fn: '', n: null, org: '', tels: [] };
      continue;
    }
    if (upper === 'END:VCARD') { close(); continue; }
    if (!card) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'FN') card.fn ||= cleanName(parts(prop).join(' '));
    else if (prop.name === 'N') card.n ||= parts(prop, { structured: true });
    else if (prop.name === 'ORG') card.org ||= parts(prop, { structured: true })[0] || '';
    else if (prop.name === 'TEL' && !prop.types.has('FAX')) {
      const text = parts(prop).join('').replace(/[()]/g, ' ').trim();
      const number = !prop.types.has('CELL') && METRO_LANDLINE.test(text) ? null : normalizePhone(text.replace(/^tel:/i, '').trim());
      if (number) card.tels.push(number);
    }
  }
  close();
  return cards;
}

module.exports = { parseVcf, MAX_CARDS };
