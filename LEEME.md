# ¡El Botón! — juego de "el primero que presione gana"

Cada asistente escanea el QR, escribe su nombre y ve las instrucciones. Cuando la cabina activa el botón, la primera persona que lo presione gana y recibe un **código de 4 dígitos** que aparece en su teléfono y en la pantalla grande, para que el staff confirme que es la persona correcta.

## Páginas

| Dirección | Para quién |
|---|---|
| `/` | Jugadores (es a donde lleva el QR) |
| `/pantalla` | Proyector o pantalla del escenario: muestra el QR, cuántos están conectados, “¡PREPÁRENSE!”, “¡YA!” y al ganador |
| `/admin` | Cabina: activar el botón, ver el orden de llegada, quitar jugadores (pide contraseña) |
| `/qr.svg` | El QR solo, para imprimirlo en la entrada |

## Opción A (recomendada): publicarlo en internet con Render (gratis)

Así la gente puede usar sus datos móviles y no depende del Wi‑Fi de la convención.

1. Sube esta carpeta a un repositorio de GitHub.
2. En https://render.com crea un **New → Web Service** y elige el repositorio.
3. Configura:
   - Build command: `npm install`
   - Start command: `npm start`
   - Variables de entorno:
     - `ADMIN_PASSWORD` = la contraseña de cabina que quieras
     - `PUBLIC_URL` = la dirección que te dé Render (por ejemplo `https://el-boton.onrender.com`)
4. Abre `https://TU-DIRECCION/pantalla` en el proyector y `https://TU-DIRECCION/admin` en la cabina.

> ⚠️ En el plan gratis de Render el servidor se “duerme” si nadie lo usa en 15 minutos y tarda unos 30–60 segundos en despertar. Abre la pantalla unos minutos antes de que entre la gente y déjala abierta todo el día (eso lo mantiene despierto). Si se reinicia, se pierde la lista de jugadores y tendrían que volver a escanear el QR (su nombre se queda guardado en el teléfono). Para un evento grande conviene el plan de pago más barato, que no se duerme.

Railway, Fly.io o cualquier servidor con Node 18+ también funcionan.

## Opción B: en una laptop con red local

Úsalo solo si todos van a estar en el mismo Wi‑Fi (por ejemplo, un router propio).

```bash
npm install
ADMIN_PASSWORD=micontraseña npm start
```

En Windows (PowerShell): `$env:ADMIN_PASSWORD="micontraseña"; npm start`

La consola muestra la dirección para los teléfonos. El QR de `/pantalla` apunta solo a la IP de la laptop.

## Cómo se juega una ronda

1. La pantalla grande muestra el QR y la gente se va uniendo.
2. En la cabina presiona **🎲 Activar con espera sorpresa**: los teléfonos se ponen amarillos (“PREPÁRATE”) y, tras un tiempo aleatorio (2 a 6 segundos por defecto), el botón se pone rosa, vibra y suena.
   - **⚡ Activar YA** lo enciende al instante, sin espera.
3. El primero que presiona gana: su teléfono muestra **¡GANASTE!** y su código, y la pantalla grande muestra su nombre con el mismo código.
4. **⏹ Apagar botón / nueva ronda** deja todo listo para la siguiente ronda.

### Opciones de la cabina
- **Quien ya ganó no puede volver a ganar** (activada por defecto).
- **Bloquear a quien presione antes de tiempo**: si alguien toca el botón mientras está en “PREPÁRATE”, queda fuera de esa ronda.
- **Quitar** jugadores con nombres ofensivos.

## Notas
- Si alguien bloquea su teléfono o cierra el navegador, al volver a abrir la página se reconecta automáticamente con su mismo nombre.
- El servidor decide quién llegó primero según el orden en que recibe cada toque. Quien tenga mala señal llega un poco tarde, como en cualquier juego en línea.
- Se probó con 200 jugadores simultáneos sin problemas.
