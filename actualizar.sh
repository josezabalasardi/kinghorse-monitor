#!/usr/bin/env bash
# Baja la última versión del monitor desde GitHub y la instala. Conserva usuarios, claves, configuración e historial.
#   sudo bash /opt/monitor-kh/actualizar.sh
set -euo pipefail
# todo va dentro de una función para que bash lo lea completo antes de que instalar.sh reemplace este archivo
main() {
  SRC=${MONITOR_SRC:-/opt/monitor-kh/src}
  [ "$(id -u)" = 0 ] || { echo "Corre este script con sudo."; exit 1; }
  [ -d "$SRC/.git" ] || { echo "No encuentro el código en $SRC. Mira la sección 'Actualizar desde GitHub' del LEEME."; exit 1; }
  antes=$(git -C "$SRC" rev-parse --short HEAD)
  git -C "$SRC" pull --ff-only --quiet
  despues=$(git -C "$SRC" rev-parse --short HEAD)
  [ "$antes" = "$despues" ] && echo "== Ya estaba en la última versión ($despues), reinstalo igual" || { echo "== Cambios nuevos:"; git -C "$SRC" log --oneline "$antes..$despues"; }
  bash "$SRC/instalar.sh"
}
main "$@"; exit
