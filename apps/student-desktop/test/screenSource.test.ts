/** selectScreenSource unit tests (Phase 3C). */
import { selectScreenSource } from '../src/shared/screenSource';

describe('selectScreenSource', () => {
  it('prefers a whole-display source when one exists', () => {
    const picked = selectScreenSource([
      { id: 'window:1:0', name: 'Calculator', type: 'window' },
      { id: 'screen:0:0', name: 'Entire Screen 1', type: 'screen', displayId: '0' },
    ]);
    expect(picked?.source.id).toBe('screen:0:0');
  });

  it('keeps listing order among displays (primary display first on Win/macOS)', () => {
    const picked = selectScreenSource([
      { id: 'screen:0:0', name: 'Entire Screen 1', type: 'screen', displayId: '0' },
      { id: 'screen:0:1', name: 'Entire Screen 2', type: 'screen', displayId: '1' },
    ]);
    expect(picked?.source.displayId).toBe('0');
  });

  it('never selects a window when displays are available', () => {
    const picked = selectScreenSource([
      { id: 'window:2:0', name: 'Notepad', type: 'window' },
      { id: 'screen:0:1', name: 'Entire Screen 2', type: 'screen' },
      { id: 'screen:0:0', name: 'Entire Screen 1', type: 'screen' },
    ]);
    expect(picked?.source.id).toBe('screen:0:1'); // first screen in listing order
  });

  it('falls back to the first entry when only window sources exist', () => {
    const picked = selectScreenSource([{ id: 'window:1:0', name: 'Browser', type: 'window' }]);
    expect(picked?.source.id).toBe('window:1:0');
  });

  it('returns null when there are no sources at all', () => {
    expect(selectScreenSource([])).toBeNull();
  });

  it('accepts legacy sources without a type field by name sniffing', () => {
    const picked = selectScreenSource([{ id: 'screen:0:0', name: 'Entire Screen 1' }]);
    expect(picked?.source.id).toBe('screen:0:0');
  });
});
