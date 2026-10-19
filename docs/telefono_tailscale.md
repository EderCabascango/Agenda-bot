# Mi Diario en el teléfono (APK + Tailscale)

La PC y el teléfono usan el **mismo backend**, que corre en tu PC con tus datos (`backend/agenda.db`).
Tailscale crea una red privada y cifrada entre tus dispositivos: el teléfono llega a tu PC desde
cualquier lugar (casa, datos móviles, otra Wi-Fi) sin abrir puertos ni exponer nada a internet.

```
Teléfono (APK) ──┐                                   ┌── backend en 127.0.0.1:8000
                 ├─ https://<tu-pc>.<tu-red>.ts.net ─┤   (tailscale serve lo publica solo
Navegador PC ────┘     (solo tus dispositivos)       └    para tus dispositivos)
```

- Si la PC está apagada, el teléfono **sigue funcionando sin conexión** y guarda los cambios en una
  cola; se suben solos en cuanto vuelve a ver el servidor.
- Los cambios se suben ~1,5 s después de hacerlos, y la app sincroniza al volver a abrirla y cada minuto.

## 1. Una sola vez en la PC

1. Instala Tailscale desde <https://tailscale.com/download> e inicia sesión con tu cuenta.
2. En la consola de administración de Tailscale (<https://login.tailscale.com/admin/dns>) activa
   **MagicDNS** y **HTTPS Certificates** (necesario para la dirección `https://...ts.net`).
3. Arranca el backend: doble clic en `iniciar_servidor.bat` (deja la ventana abierta).
4. Publica el backend para tus dispositivos (una sola vez; queda activo aunque reinicies):

   ```bash
   tailscale serve --bg 8000
   ```

   El comando muestra tu dirección, por ejemplo `https://mi-pc.tail1234.ts.net`. Guárdala.
   Puedes consultarla luego con `tailscale serve status`.

## 2. Una sola vez en el teléfono

1. Instala **Tailscale** desde la Play Store e inicia sesión con **la misma cuenta**.
2. Copia `dist/MiDiario.apk` al teléfono (cable USB, Drive, correo…) y ábrelo.
   Android pedirá permitir "instalar apps de origen desconocido" para esa app: acéptalo.
3. Abre **Mi Diario**. En el login despliega **Servidor**, escribe la dirección `https://...ts.net`,
   tu correo y tu contraseña, y pulsa **Entrar**. La primera vez trae todos tus datos de la PC.

## Día a día

- En la PC: que `iniciar_servidor.bat` esté abierto (o el servidor "app" del panel de Claude).
- En el teléfono: Tailscale conectado (se queda en segundo plano).
- Usa la app en cualquiera de los dos; los datos se igualan solos.

## Si algo no sincroniza

| Síntoma | Qué revisar |
|---|---|
| "No se pudo conectar con el servidor" | ¿Tailscale activo en ambos? ¿`iniciar_servidor.bat` abierto? ¿La dirección empieza por `https://` y termina en `.ts.net`? |
| Error de certificado / no carga | Activa **HTTPS Certificates** en la consola de Tailscale y repite `tailscale serve --bg 8000`. |
| "Correo o contraseña incorrectos" | Es el mismo correo de `OWNER_EMAIL` y la contraseña fijada con `set_password.py`. |
| Cambié la contraseña y el teléfono pide login | Es normal: cambiarla cierra la sesión en los demás dispositivos. |

## Volver a generar el APK (tras cambios en `web/`)

```bash
npx cap sync android
```

```bash
cd android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug
```

El APK queda en `android/app/build/outputs/apk/debug/app-debug.apk` (copiado a `dist/MiDiario.apk`).
