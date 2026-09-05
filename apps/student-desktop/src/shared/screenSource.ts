/**
 * Screen-source model + selection (Phase 3C). Pure and DOM/Electron-free so it
 * is unit-testable under the node jest suite.
 *
 * The capture target is ALWAYS an entire display, never an arbitrary app
 * window. DesktopCapturerSource lists whole-display sources with type
 * "screen"; Electron returns the primary display first on Windows/macOS.
 */

export interface ScreenSourceLike {
  id: string;
  name: string;
  type?: 'screen' | 'window' | string;
  displayId?: string;
}

export interface SelectedScreenSource {
  source: ScreenSourceLike;
}

/**
 * Deterministic selection: prefer whole-display sources in listing order
 * (primary display first), fall back to the first entry only when no display
 * source exists. Never silently swaps between two displays once one is chosen
 * — callers keep the returned id stable for the session.
 */
export function selectScreenSource(sources: readonly ScreenSourceLike[]): SelectedScreenSource | null {
  if (sources.length === 0) return null;
  const screens = sources.filter((s) => s.type === 'screen' || /^(screen|display)/i.test(s.name));
  if (screens.length > 0) return { source: screens[0] };
  return { source: sources[0] };
}
