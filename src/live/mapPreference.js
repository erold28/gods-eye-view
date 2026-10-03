/**
 * Which map the live view should switch to, or null to leave it alone.
 *
 * A view link remembers its map (`map=esri-imagery`), and a link from before a
 * token was saved keeps the flat map forever. Live mode ignores that memory:
 * Google 3D whenever it is available, otherwise Esri imagery.
 *
 * Google 3D becomes available a moment after startup, once its tileset loads,
 * so the fall back to Esri waits for the `final` check: an earlier one would
 * switch to the flat map just before 3D is ready.
 *
 * @param {{ activeId: string, stacks: Array<{ id: string, available: boolean }> }} state
 *   the map controller's state
 * @param {{ final?: boolean }} [options]
 * @returns {'photoreal'|'esri-imagery'|null}
 */
export function preferredLiveMap(state, { final = false } = {}) {
  const stacks = Array.isArray(state?.stacks) ? state.stacks : [];
  const available = (id) => stacks.some((s) => s.id === id && s.available);
  const activeId = state?.activeId ?? null;
  if (available('photoreal'))
    return activeId === 'photoreal' ? null : 'photoreal';
  if (!final || activeId === 'esri-imagery') return null;
  return available('esri-imagery') ? 'esri-imagery' : null;
}
