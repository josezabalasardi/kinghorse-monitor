// Acceso al monitor: un usuario por gerente o supervisor, sesión firmada en una cookie.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'usuarios.json');
const SECRET_FILE = path.join(__dirname, '.secreto');
const DIAS = 30;

let USERS = {};
try { USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}
const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(USERS, null, 1), { mode: 0o600 });

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }
}

const hash = (clave, salt) => crypto.scryptSync(clave, salt, 64).toString('hex');
const normal = u => String(u || '').trim().toLowerCase();

// Roles: gerente (todo, incluido manejar usuarios y configuración) y supervisor (ve, revisa alertas y saca reportes).
// Los usuarios creados antes de que existieran los roles son gerentes.
const ROLES = ['gerente', 'supervisor'];
const rolDe = x => ROLES.includes(x?.rol) ? x.rol : 'gerente';
// temporal = true cuando la clave la puso un gerente: el usuario tiene que cambiarla al entrar
function crear(usuario, clave, nombre, rol, temporal = false) {
  usuario = normal(usuario);
  if (!/^[a-z0-9._-]{2,30}$/.test(usuario)) throw new Error('Usuario inválido: usa letras, números, punto o guion');
  if (!clave || clave.length < 6) throw new Error('La clave debe tener al menos 6 caracteres');
  if (rol && !ROLES.includes(rol)) throw new Error('Rol inválido');
  const salt = crypto.randomBytes(16).toString('hex'), antes = USERS[usuario];
  USERS[usuario] = { nombre: String(nombre || antes?.nombre || usuario).slice(0, 60), rol: rol || rolDe(antes), salt, hash: hash(clave, salt), creado: antes?.creado || Date.now(), version: (antes?.version || 0) + 1, ...(temporal ? { debeCambiar: true } : {}) };
  saveUsers();
}
// cambia nombre o rol sin tocar la clave; cambiar el rol cierra sus sesiones para que entre con el permiso nuevo
function editar(usuario, { nombre, rol }) {
  const x = USERS[normal(usuario)]; if (!x) throw new Error('No existe ese usuario');
  if (rol && !ROLES.includes(rol)) throw new Error('Rol inválido');
  if (rol && rol !== 'gerente' && rolDe(x) === 'gerente' && gerentes() <= 1) throw new Error('Tiene que quedar al menos un gerente');
  if (nombre) x.nombre = String(nombre).slice(0, 60);
  if (rol && rol !== rolDe(x)) { x.rol = rol; x.version++; }
  saveUsers();
}
const gerentes = () => Object.values(USERS).filter(x => rolDe(x) === 'gerente').length;
function quitar(usuario) {
  const x = USERS[normal(usuario)]; if (!x) return;
  if (rolDe(x) === 'gerente' && gerentes() <= 1) throw new Error('Tiene que quedar al menos un gerente');
  delete USERS[normal(usuario)]; saveUsers();
}
const lista = () => Object.entries(USERS).map(([u, x]) => ({ usuario: u, nombre: x.nombre, rol: rolDe(x), creado: x.creado }));
const hayUsuarios = () => Object.keys(USERS).length > 0;

function verificar(usuario, clave) {
  const x = USERS[normal(usuario)]; if (!x || !clave) return null;
  const a = Buffer.from(hash(clave, x.salt), 'hex'), b = Buffer.from(x.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? normal(usuario) : null;
}

// token = usuario.version.expira.firma (cambiar la clave invalida las sesiones viejas)
const firma = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function token(usuario) { const s = `${usuario}.${USERS[usuario].version}.${Date.now() + DIAS * 86400e3}`; return `${s}.${firma(s)}`; }
function leer(req) {
  const m = /(?:^|;\s*)km=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const p = m[1].split('.'); if (p.length !== 4) return null;
  const s = p.slice(0, 3).join('.'), f = firma(s);
  if (f.length !== p[3].length || !crypto.timingSafeEqual(Buffer.from(f), Buffer.from(p[3]))) return null;
  const [usuario, version, exp] = p; const x = USERS[usuario];
  if (!x || String(x.version) !== version || +exp < Date.now()) return null;
  return { usuario, nombre: x.nombre, rol: rolDe(x), debeCambiar: !!x.debeCambiar };
}
function cookie(req, valor, maxAge) {
  const segura = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `km=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${segura ? '; Secure' : ''}`;
}

// límite de intentos fallidos por IP
const FALLOS = new Map();
function bloqueado(ip) { const f = FALLOS.get(ip); return f && f.n >= 8 && Date.now() - f.t < 15 * 60e3; }
function fallo(ip) { const f = FALLOS.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 15 * 60e3) f.n = 0; f.n++; f.t = Date.now(); FALLOS.set(ip, f); }

module.exports = { ROLES, crear, editar, quitar, lista, hayUsuarios, verificar, token, leer, cookie, bloqueado, fallo, DIAS, ok: ip => FALLOS.delete(ip) };
