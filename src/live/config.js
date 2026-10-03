/**
 * Ajustes de los pedidos en vivo (TikTok LIVE).
 *
 * Edita los números de abajo y recarga la app para aplicarlos.
 */
export const LIVE_CONFIG = Object.freeze({
  /** Segundos que se muestra cada ciudad antes de pasar a la siguiente. */
  displaySeconds: 25,
  /** Segundos que suma el botón "Extender" (tecla E) a la ciudad en pantalla. */
  extendSeconds: 15,
  /** Segundos que un mismo usuario debe esperar entre dos pedidos aceptados. */
  userCooldownSeconds: 60,
  /** Pedidos máximos esperando en la fila (sin contar el que se muestra). */
  maxQueue: 10,
  /** Próximas ciudades visibles en pantalla; el resto aparece como "+N más". */
  queueRowsShown: 3,
  /** Largo máximo del nombre de lugar escrito después del comando. */
  maxPlaceLength: 60,
  /** Nombre en el cartel para pedidos del panel sin usuario ("Mr. Erold pidió"). */
  operatorName: 'Mr. Erold',
  /** Comandos aceptados al inicio del comentario: español y kreyòl. */
  commands: Object.freeze(['!ir', '!ale']),
  /**
   * Palabras que hacen rechazar un pedido (sin tildes, en minúsculas).
   * Ejemplo: Object.freeze(['palabra1', 'palabra2']).
   */
  blockedWords: Object.freeze([]),

  /** Cámara al volar a cada pedido. */
  camera: Object.freeze({
    /** Segundos que dura el vuelo. */
    flightSeconds: 4,
    /**
     * Dónde queda el centro del lugar en la pantalla, de 0 (arriba) a 1
     * (abajo). 0.5 es el centro; 0.70 lo deja debajo del cartel y la fila.
     */
    placeScreenY: 0.7,
    /** Grados por segundo del giro lento en modo espera. */
    idleOrbitDegreesPerSecond: 2,
    /**
     * Distancia de la cámara al centro (metros) e inclinación (grados,
     * negativa = mirando hacia abajo) por tipo de lugar. "minMeters" y
     * "maxMeters" acotan la distancia cuando se calcula por el tamaño.
     * Una ciudad se clasifica por el tamaño de su zona (en km): "bigCity"
     * desde "fromKm", "town" por debajo de "city.fromKm", y lo demás "city".
     * Un estado o región más pequeño que "bigCityBelowKm" (Ciudad de México)
     * se encuadra como ciudad grande.
     */
    country: Object.freeze({
      minMeters: 800_000,
      maxMeters: 4_000_000,
      pitch: -70,
    }),
    region: Object.freeze({
      minMeters: 200_000,
      maxMeters: 900_000,
      pitch: -55,
      bigCityBelowKm: 150,
    }),
    district: Object.freeze({
      minMeters: 60_000,
      maxMeters: 300_000,
      pitch: -45,
      bigCityBelowKm: 150,
    }),
    bigCity: Object.freeze({ meters: 14_000, pitch: -28, fromKm: 60 }),
    city: Object.freeze({ meters: 8_000, pitch: -28, fromKm: 6 }),
    town: Object.freeze({ meters: 4_000, pitch: -30 }),
    neighborhood: Object.freeze({ meters: 2_500, pitch: -30 }),
    area: Object.freeze({ minMeters: 5_000, maxMeters: 150_000, pitch: -35 }),
    other: Object.freeze({ meters: 6_000, pitch: -30 }),
  }),
});
