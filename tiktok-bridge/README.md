# Puente TikTok LIVE → Mr Erold Live

Lee el chat de un live de TikTok y envía a la app los comentarios que empiezan
con `!ir` o `!ale`. Solo lee: no escribe en el chat ni usa contraseñas.

El lanzador `Iniciar Mr Erold Live.bat` lo abre solo, en una ventana llamada
"Puente TikTok". A mano:

```
npm install
node bridge.mjs mr.eroldoficial
```

- `LIVE_RELAY`: dirección de la app (por defecto `http://localhost:4180`).
- `EULER_API_KEY`: clave gratuita de eulerstream.com, solo si el servicio limita
  las conexiones.

El panel de control muestra si el puente está conectado. Si TikTok cambia algo
y el puente deja de funcionar, el panel manual sigue sirviendo igual.

## Licencia

Esta carpeta usa la librería no oficial
[tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector),
con licencia AGPL-3.0, y por eso se publica con esa misma licencia. Va separada
de la app (licencia MIT) y con sus propias dependencias: la app no la importa.
La librería firma la conexión con el servidor de Euler Stream, un servicio de
terceros.
