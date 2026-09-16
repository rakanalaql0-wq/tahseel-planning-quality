import { Buffer } from 'node:buffer';

export const MAX_BODY = 12 * 1024 * 1024; // 12MB — حد رفع الشواهد

/** يقرأ جسم الطلب مع حد أقصى للحجم. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('حجم الطلب يتجاوز الحد المسموح'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** يحوّل نصًا بصيغة application/x-www-form-urlencoded إلى كائن. */
export function parseForm(text) {
  const out = {};
  const params = new URLSearchParams(text);
  for (const [k, v] of params) {
    if (k in out) {
      if (Array.isArray(out[k])) out[k].push(v);
      else out[k] = [out[k], v];
    } else out[k] = v;
  }
  return out;
}

/** محلّل multipart/form-data مبسّط يدعم الحقول النصية والملفات. */
export function parseMultipart(buf, boundary) {
  const fields = {};
  const files = [];
  const delim = Buffer.from(`--${boundary}`);
  let start = buf.indexOf(delim);
  if (start === -1) return { fields, files };
  start += delim.length;

  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // "--" نهاية
    if (buf[start] === 0x0d) start += 2; // CRLF
    const headerEnd = buf.indexOf('\r\n\r\n', start, 'utf8');
    if (headerEnd === -1) break;
    const headers = buf.subarray(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    let next = buf.indexOf(delim, bodyStart);
    if (next === -1) next = buf.length;
    const body = buf.subarray(bodyStart, Math.max(bodyStart, next - 2)); // إزالة CRLF الأخير

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    const name = nameMatch ? nameMatch[1] : null;

    if (name) {
      if (fileMatch && fileMatch[1]) {
        files.push({
          field: name,
          filename: fileMatch[1],
          mimeType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
          data: body,
        });
      } else {
        const value = body.toString('utf8');
        if (name in fields) {
          if (Array.isArray(fields[name])) fields[name].push(value);
          else fields[name] = [fields[name], value];
        } else fields[name] = value;
      }
    }
    start = next + delim.length;
  }
  return { fields, files };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, path = '/', secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(payload);
}

export const html = (res, body, status = 200) =>
  send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8' });

export const json = (res, data, status = 200) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

export const redirect = (res, location) => {
  res.writeHead(302, { Location: location });
  res.end();
};

/** موجّه بسيط يدعم مسارات بمعاملات مثل /programs/:id/metric */
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const regexSrc = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${regexSrc}/?$`), keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}
