/**
 * Ajustes de los pedidos en vivo (TikTok LIVE).
 *
 * Edita los números de abajo y recarga la app para aplicarlos.
 */
export const LIVE_CONFIG = Object.freeze({
  /** Segundos que se muestra cada ciudad (incluye el vuelo) antes de la siguiente. */
  displaySeconds: 50,
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

  /**
   * Cámara: el mini recorrido de cada ciudad.
   *   1. Vuelo suave            (flightSeconds)
   *   2. Vista general          (overviewSeconds, a "overviewHeight")
   *   3. Bajada lenta           (descentSeconds, hasta "closeHeight")
   *   4. Giro muy lento         (el resto del tiempo, orbitDegreesPerSecond)
   * Si el 3D todavía carga al final de la vista general, la bajada espera
   * hasta "waitForTilesSeconds". Las zonas grandes (parques, montañas) no bajan.
   */
  camera: Object.freeze({
    flightSeconds: 10,
    overviewSeconds: 10,
    descentSeconds: 8,
    waitForTilesSeconds: 5,
    /** Giro casi imperceptible durante la vista general. */
    overviewDriftDegreesPerSecond: 0.5,
    /** Giro alrededor del centro en la fase cercana. */
    orbitDegreesPerSecond: 2,
    /** Giro de países y regiones, vistos desde lejos. */
    highOrbitDegreesPerSecond: 1,
    /** Segundos para volver al recorrido con P después de mover el mapa. */
    resumeSeconds: 3,
    /**
     * Dónde queda el centro del lugar en la pantalla, de 0 (arriba) a 1
     * (abajo). 0.5 es el centro; 0.70 lo deja debajo del cartel y la fila.
     */
    placeScreenY: 0.7,
    /** Grados por segundo del giro de espera al arrancar, sin ciudad aún. */
    idleOrbitDegreesPerSecond: 2,
    /**
     * Alturas sobre el suelo (metros) e inclinación (grados, negativa =
     * mirando hacia abajo). Una ciudad se clasifica por el tamaño de su zona
     * (en km): "bigCity" desde "fromKm", "town" por debajo de "city.fromKm",
     * y lo demás "city". Un estado o región más pequeño que "bigCityBelowKm"
     * (Ciudad de México) es una ciudad grande.
     */
    bigCity: Object.freeze({
      overviewHeight: 4_500,
      closeHeight: 800,
      overviewPitch: -35,
      closePitch: -20,
      fromKm: 60,
    }),
    city: Object.freeze({
      overviewHeight: 3_000,
      closeHeight: 600,
      overviewPitch: -35,
      closePitch: -20,
      fromKm: 6,
    }),
    town: Object.freeze({
      overviewHeight: 2_000,
      closeHeight: 450,
      overviewPitch: -35,
      closePitch: -20,
    }),
    neighborhood: Object.freeze({
      overviewHeight: 1_500,
      closeHeight: 350,
      overviewPitch: -35,
      closePitch: -20,
    }),
    /** Un lugar famoso elegido en la lista del panel (botón Ir). */
    landmark: Object.freeze({
      overviewHeight: 1_200,
      closeHeight: 450,
      overviewPitch: -35,
      closePitch: -25,
    }),
    other: Object.freeze({
      overviewHeight: 3_000,
      closeHeight: 600,
      overviewPitch: -35,
      closePitch: -20,
    }),
    /**
     * Países, estados y regiones: vista general alta para ver su forma y
     * bajada hasta una altura desde la que se ven ciudades y costa.
     */
    country: Object.freeze({
      overviewHeight: 1_000_000,
      closeHeight: 150_000,
      overviewPitch: -70,
      closePitch: -50,
    }),
    region: Object.freeze({
      overviewHeight: 250_000,
      closeHeight: 30_000,
      overviewPitch: -60,
      closePitch: -40,
      bigCityBelowKm: 150,
    }),
    district: Object.freeze({
      overviewHeight: 120_000,
      closeHeight: 20_000,
      overviewPitch: -55,
      closePitch: -35,
      bigCityBelowKm: 150,
    }),
    /**
     * Parques, montañas, lagos y otras zonas grandes se quedan altos: la
     * distancia de la cámara al centro (metros) sigue el tamaño del lugar
     * entre "minMeters" y "maxMeters".
     */
    area: Object.freeze({ minMeters: 5_000, maxMeters: 150_000, pitch: -35 }),
  }),
});
