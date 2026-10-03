/**
 * Ajustes de los pedidos en vivo (TikTok LIVE).
 *
 * Edita los números de abajo y recarga la app para aplicarlos.
 */
export const LIVE_CONFIG = Object.freeze({
  /** Segundos que se muestra cada ciudad antes de pasar a la siguiente. */
  displaySeconds: 25,
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
});
