#!/usr/bin/env bash
# Instala el Monitor King Horse en un servidor Ubuntu/Debian (por ejemplo el droplet de DigitalOcean).
# No toca lo que ya corre en el servidor: usa su propio Node, su propia carpeta, su propio usuario y su propio servicio.
#
#   sudo bash instalar.sh                      instala o actualiza
#   sudo DOMINIO=monitor.ejemplo.com bash instalar.sh   además lo publica con HTTPS en ese subdominio (si hay nginx)
set -euo pipefail

DIR=${MONITOR_DIR:-/opt/monitor-kh}
ENVF=${MONITOR_ENV:-/etc/monitor-kh.env}
SVC=monitor-kh
NODE_VER=v22.23.4
ORIGEN="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "Corre este script con sudo."; exit 1; }
echo "== Monitor King Horse: instalación en $DIR"

# 1. Node propio (no cambia el Node que use otro proyecto)
if [ ! -x "$DIR/node/bin/node" ] || [ "$("$DIR/node/bin/node" -v)" != "$NODE_VER" ]; then
  ARCH=$(uname -m); case "$ARCH" in x86_64) A=x64;; aarch64) A=arm64;; *) echo "Arquitectura no soportada: $ARCH"; exit 1;; esac
  echo "-- Descargando Node $NODE_VER"
  mkdir -p "$DIR/node"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$A.tar.xz" | tar -xJ -C "$DIR/node" --strip-components=1
fi
NODE="$DIR/node/bin/node"; NPM="$DIR/node/bin/npm"

# 2. Usuario de sistema y archivos (conserva datos, usuarios y configuración si ya existían)
id monitorkh >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin monitorkh
mkdir -p "$DIR/app"
for f in server.js ia.js auth.js package.json package-lock.json LEEME.md; do cp "$ORIGEN/$f" "$DIR/app/"; done
[ -f "$ORIGEN/actualizar.sh" ] && [ "$ORIGEN/actualizar.sh" != "$DIR/actualizar.sh" ] && cp "$ORIGEN/actualizar.sh" "$DIR/actualizar.sh"
rm -rf "$DIR/app/public"; cp -r "$ORIGEN/public" "$DIR/app/public"
[ -f "$DIR/app/config.json" ] || cp "$ORIGEN/config.json" "$DIR/app/"
[ -f "$DIR/app/sectores.json" ] || { [ -f "$ORIGEN/sectores.json" ] && cp "$ORIGEN/sectores.json" "$DIR/app/"; } || true
mkdir -p "$DIR/app/historial" "$DIR/app/cierres"
[ -d "$ORIGEN/historial" ] && cp -n "$ORIGEN"/historial/*.json "$DIR/app/historial/" 2>/dev/null || true
(cd "$DIR/app" && PATH="$DIR/node/bin:$PATH" "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R monitorkh:monitorkh "$DIR/app"

# 3. Claves (quedan en $ENVF, solo legible por root)
if [ ! -f "$ENVF" ]; then
  read -rsp "Clave del usuario de consulta de ondrv (josezabala): " ONDRV_PASS; echo
  PORT=8787; while command -v ss >/dev/null && ss -ltn | grep -q ":$PORT "; do PORT=$((PORT+1)); done
  read -rp "Token del bot de Telegram (Enter para dejarlo para después): " TELEGRAM_TOKEN
  TELEGRAM_PIN=""; [ -n "$TELEGRAM_TOKEN" ] && read -rp "PIN para que los gerentes se suscriban al bot: " TELEGRAM_PIN
  read -rsp "Clave de la API de Claude (Enter para dejarla para después): " ANTHROPIC_API_KEY; echo
  umask 077
  cat > "$ENVF" <<EOF
ONDRV_PASS=$ONDRV_PASS
PORT=$PORT
HOST=$([ -n "${DOMINIO:-}" ] && echo 127.0.0.1 || echo 0.0.0.0)
TELEGRAM_TOKEN=$TELEGRAM_TOKEN
TELEGRAM_PIN=$TELEGRAM_PIN
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
EOF
  echo "-- Claves guardadas en $ENVF (puerto $PORT)"
fi
PORT=$(grep '^PORT=' "$ENVF" | cut -d= -f2)

# 4. Primer usuario del monitor
if [ ! -s "$DIR/app/usuarios.json" ] || [ "$(cat "$DIR/app/usuarios.json")" = "{}" ]; then
  echo "-- Crea el primer usuario del monitor (gerente)"
  read -rp "Usuario: " U; read -rsp "Clave (mínimo 6): " C; echo; read -rp "Nombre para mostrar: " N
  (cd "$DIR/app" && sudo -u monitorkh "$NODE" server.js --usuario "$U" "$C" "$N")
fi

# 5. Servicio
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=Monitor King Horse (lee ondrv en solo lectura)
After=network-online.target
Wants=network-online.target

[Service]
User=monitorkh
WorkingDirectory=$DIR/app
EnvironmentFile=$ENVF
ExecStart=$NODE server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DIR/app
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SVC
systemctl restart $SVC
sleep 3
systemctl is-active --quiet $SVC && echo "-- Servicio activo en el puerto $PORT" || { journalctl -u $SVC -n 30 --no-pager; exit 1; }

# 6. Publicarlo con HTTPS en un subdominio (opcional)
if [ -n "${DOMINIO:-}" ]; then
  # En un servidor nuevo instala nginx y certbot; si el puerto 80 ya lo usa otro programa, no toca nada
  if ! command -v nginx >/dev/null; then
    if command -v ss >/dev/null && ss -ltn | grep -qE ':(80|443) '; then
      echo "!! El puerto 80/443 ya lo usa otro programa. Publica el puerto $PORT con ese proxy."
    elif command -v apt-get >/dev/null; then
      echo "-- Instalando nginx y certbot"
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx certbot python3-certbot-nginx
      rm -f /etc/nginx/sites-enabled/default
    fi
  elif ! command -v certbot >/dev/null && command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
  fi
  if command -v nginx >/dev/null && command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 'Nginx Full' >/dev/null 2>&1 || true; fi
  if ! command -v nginx >/dev/null; then
    echo "!! No se pudo dejar nginx listo; el monitor sigue corriendo en el puerto $PORT."
  else
    cat > /etc/nginx/sites-available/$SVC <<EOF
server {
  listen 80;
  server_name $DOMINIO;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF
    ln -sf /etc/nginx/sites-available/$SVC /etc/nginx/sites-enabled/$SVC
    if nginx -t; then systemctl reload nginx; else rm -f /etc/nginx/sites-enabled/$SVC; echo "!! nginx rechazó la configuración; no se cambió nada."; exit 1; fi
    if command -v certbot >/dev/null; then certbot --nginx -d "$DOMINIO" --non-interactive --agree-tos --register-unsafely-without-email --redirect || echo "!! No se pudo sacar el certificado. Revisa que $DOMINIO apunte a este servidor."
    else echo "!! Falta certbot para HTTPS: apt install certbot python3-certbot-nginx y vuelve a correr este script."; fi
    echo "-- Listo: https://$DOMINIO"
  fi
fi

echo
echo "Comandos útiles:"
echo "  Ver el registro:      journalctl -u $SVC -f"
echo "  Reiniciar:            systemctl restart $SVC"
echo "  Agregar un usuario:   cd $DIR/app && sudo -u monitorkh $NODE server.js --usuario <usuario> <clave> <nombre>"
echo "  Quitar un usuario:    cd $DIR/app && sudo -u monitorkh $NODE server.js --quitar-usuario <usuario>"
echo "  Actualizar:           sudo bash $DIR/actualizar.sh"
echo "  Cambiar claves:       nano $ENVF && systemctl restart $SVC"
