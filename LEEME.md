# Monitor en vivo La Rinconada

Pensado para el teléfono: pestañas abajo (Resumen, Carreras, Alertas, Taquillas), tarjetas y hojas que suben desde abajo. Se puede instalar en la pantalla de inicio (Compartir → Agregar a inicio en iPhone, o menú → Instalar app en Android). Arriba hay un selector **Hipódromo / The Book / Ambos** que filtra toda la app; en Ambos aparece la comparación Hipódromo contra The Book en BS y USD. Cuando llega una alerta alta con la app abierta, aparece un aviso arriba y el teléfono vibra (en Android).

Arriba se elige qué mirar: **Rinconada**, **Internacional** (todos los hipódromos internacionales juntos) o **Todo**. La lupa abre un buscador para ver un solo hipódromo internacional. Al lado del selector Hipódromo / The Book / Ambos está la **fecha**: cualquier día pasado se abre en modo repetición, con la barra de tiempo.

Lee los datos de ondrv (solo lectura) y muestra:
- Balance del día con **BS y USD lado a lado**.
- Ventas y ganancia **por sector** (Sportbook, Tribuna A, B, C, Jockey Club, The Book). Al tocar un sector se abren sus taquillas.
- **Jugada en vivo por carrera**: monto por caballo en BS y USD, % de la carrera y reparto por sector. Al tocar un caballo se abre el reparto por sector y por taquilla, en BS o USD.
- **Alertas**: venta después de la hora de la carrera (baja / media / alta, sube si el ticket ganó), ticket grande, apuesta atípica para esa taquilla, taquilla en pérdida, anulaciones y carga concentrada en un caballo.
- **Taquillas**: buscar, filtrar por sector y, al tocar una, ver sus alertas y moverla de sector. Se guarda en `sectores.json` de este monitor; no cambia nada en ondrv.

## Instalarlo en el servidor (DigitalOcean)

El paquete `monitor-kh.tar.gz` trae todo. En el servidor:

```
scp monitor-kh.tar.gz root@IP_DEL_SERVIDOR:/root/
ssh root@IP_DEL_SERVIDOR
tar xzf monitor-kh.tar.gz && cd monitor-kh
sudo DOMINIO=monitor.tudominio.com bash instalar.sh
```

El script:
- Instala su propio Node en `/opt/monitor-kh/node` y no cambia el Node ni nada de lo que use 2y2nini.
- Corre como un usuario de sistema aparte (`monitorkh`) y queda como servicio `monitor-kh`, que arranca solo si el servidor se reinicia.
- Busca un puerto libre desde el 8787.
- Pide la clave de ondrv, el token de Telegram y la clave de Claude (las dos últimas se pueden dejar para después), y las guarda en `/etc/monitor-kh.env`, que solo puede leer root.
- Pide crear el primer usuario del monitor.
- Si se le pasa `DOMINIO` y el servidor tiene nginx, publica el monitor en ese subdominio con HTTPS (certbot). Antes de recargar nginx revisa la configuración; si falla, no cambia nada. El subdominio tiene que apuntar a la IP del servidor.

## Actualizar desde GitHub

El código vive en el repositorio privado `josezabalasardi/kinghorse-monitor`. El servidor lo baja con una llave de solo lectura (deploy key). Una sola vez, en el servidor:

```
ssh-keygen -t ed25519 -N "" -C monitor-kh -f /root/.ssh/monitor_kh
cat /root/.ssh/monitor_kh.pub      # pegarla en GitHub: repositorio > Settings > Deploy keys > Add deploy key (sin permiso de escritura)
GIT_SSH_COMMAND="ssh -i /root/.ssh/monitor_kh -o StrictHostKeyChecking=accept-new" git clone git@github.com:josezabalasardi/kinghorse-monitor.git /opt/monitor-kh/src
git -C /opt/monitor-kh/src config core.sshCommand "ssh -i /root/.ssh/monitor_kh"
sudo bash /opt/monitor-kh/src/actualizar.sh
```

Desde ahí, cada actualización es:

```
sudo bash /opt/monitor-kh/actualizar.sh
```

Baja lo nuevo, reinstala y reinicia el servicio. Conserva usuarios, claves (`/etc/monitor-kh.env`), configuración, sectores e historial, que no están en el repositorio. No toca nginx ni el certificado.

## Usuarios y acceso

El monitor pide usuario y clave. La sesión dura 30 días en el teléfono. Después de 8 intentos fallidos desde la misma conexión se bloquea por 15 minutos. Cambiar la clave de alguien cierra sus sesiones abiertas. Cuando un gerente marca una alerta como revisada o aprueba una sugerencia de la IA, queda registrado con su nombre.

```
cd /opt/monitor-kh/app
sudo -u monitorkh ../node/bin/node server.js --usuario maria clave123 María Pérez   # crear o cambiar clave
sudo -u monitorkh ../node/bin/node server.js --quitar-usuario maria
sudo -u monitorkh ../node/bin/node server.js --usuarios                              # listar
```

Para probarlo en una computadora sin crear usuarios: `MONITOR_ABIERTO=1`.

## Cómo correrlo

Necesita Node.js 18 o más nuevo. La primera vez, ejecuta `npm install`.

```
ONDRV_PASS=la_clave node server.js              # en vivo, día de hoy
FECHA=2026-11-01 ONDRV_PASS=la_clave node server.js   # repetir un día pasado con barra de tiempo
```

Abre http://localhost:8080. Variables opcionales: `ONDRV_USER` (por defecto josezabala@bet.com) y `PORT`.

## Refresco

En vivo: tickets nuevos cada 5 s, recarga completa del día cada 60 s, calendario de carreras cada 60 s. La pantalla se actualiza cada 3 s. Se cambia en `config.json`.

## Hora real de cierre

ondrv no guarda cuándo se cerró de verdad cada carrera; solo la hora programada. El monitor la captura en vivo: mientras una carrera está por cerrar (de 3 min antes a 20 min después de la hora) consulta el calendario cada 3 segundos y anota el momento en que pasa a "Closed". Se guarda en `cierres/AAAA-MM-DD.json`, así que sobrevive a un reinicio. Solo se anota si el monitor vio la carrera abierta, para no inventar horas.

Con ese dato:
- Una venta después del cierre real es siempre nivel alto y lo dice en la alerta.
- Una venta después de la hora programada pero con la carrera todavía abierta dice "la carrera seguía abierta (cerró a +X s)".
- Si la carrera cierra más de 60 s tarde sale la alerta "Cierre tardío" (nivel alto desde 180 s).

Para los días pasados no hay hora real, así que se sigue usando la hora programada.

## Umbrales de alertas

Se cambian desde la app (Alertas → ⚙ Configurar alertas): activar o desactivar cada tipo y fijar montos. Se guardan en `config.json` → `alertas`. Valores iniciales:
- Venta tardía: baja desde 0 s, media desde 60 s, alta desde 120 s (`leveSeg`, `mediaSeg`, `graveSeg`).
- Ticket grande, por taquilla: cada taquilla se compara contra su propio historial (las jornadas guardadas en `historial/`, sin contar el día en curso). Avisa cuando un ticket supera el percentil 99 de esa taquilla, es decir, lo que vende en el 99% de sus tickets. Pasa a nivel alto si es 3 veces ese umbral o si rompe el récord de la taquilla. Hay un piso de 10.000 BS / 50 USD para no avisar por montos pequeños. Las taquillas con menos de 30 tickets de historial usan el monto general (100.000 BS o 1.000 USD). Un gerente puede fijar el umbral a mano en la ficha de la taquilla.
- Apuesta atípica: solo se usa en taquillas sin historial suficiente.
- Apuesta atípica: 15 veces el ticket mediano de esa taquilla y al menos 30.000 BS o 300 USD.
- Taquilla en pérdida: -100.000 BS o -500 USD.
- Anulaciones: 5 tickets o 10 % de la venta de la taquilla.
- Carga en un caballo: 50 % del dinero de la carrera y al menos 500.000 BS o 5.000 USD.

Nota: la hora de la carrera es la del calendario de ondrv. Si una carrera sale tarde, las ventas posteriores a esa hora igual se marcan como tardías.

## Bot de Telegram

1. En Telegram, habla con @BotFather, envía `/newbot` y copia el token que te da.
2. Arranca el monitor con `TELEGRAM_TOKEN=<token> TELEGRAM_PIN=<clave>`.
3. Cada supervisor abre el bot y escribe `/start <clave>`. Desde ahí recibe las alertas del nivel elegido (por defecto, solo las altas).
4. Cada alerta llega con tres botones: **✅ Revisado** (queda marcado en la app con el nombre de quien la revisó), **🔕 Silenciar 1 h** (deja de avisar esa taquilla por una hora) y **⚠️ Escalar** (reenvía la alerta a todos los demás).
5. Comandos: `/resumen` (totales del día), `/alertas` (últimas 5 altas), `/salir`.

Los suscriptores, las revisiones y los silencios se guardan en `telegram.json`.

## Agente de IA (sugerencias)

- **Historial:** en vivo, cada jornada se guarda sola en `historial/AAAA-MM-DD.json`. Para bajar días pasados de ondrv: `ONDRV_PASS=la_clave node server.js --historial 90`. Ya vienen incluidas 13 jornadas (9 de agosto a 1 de noviembre de 2026).
- **Análisis:** con `ANTHROPIC_API_KEY=<clave>` el monitor le manda a Claude (modelo `claude-opus-5-5`) un resumen del historial por taquilla, cliente y jornada, nunca los tickets uno por uno. Corre solo cada noche a las 11 p. m. (hora de Venezuela) y también con el botón "Analizar ahora".
- **Revisión:** en Alertas → 🤖 Sugerencias IA, cada sugerencia trae explicación, cifras y qué haría. **Aprobar** la convierte en alerta (vigilar una taquilla, vigilar un cliente o cambiar un umbral); **Descartar** pide un motivo, que la IA lee en el siguiente análisis para no insistir. Las reglas activas se pueden quitar en cualquier momento.
- Si Telegram está conectado, avisa por ahí cuando hay sugerencias nuevas.
- Archivos: `sugerencias.json` (sugerencias y decisiones), `config.json` → `reglas` (reglas aprobadas).
