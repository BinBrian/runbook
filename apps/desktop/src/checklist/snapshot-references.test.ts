import { describe, expect, it } from 'vitest';
import { snapshotReferences } from './snapshot-references';

describe('frozen reference display', () => {
  it('marks only original identities, including repeated values and literal lookalikes', () => {
    expect(snapshotReferences(['release ', { parameterId: 'global' }, ' ', { parameterId: 'local' }, ' ', { parameterId: 'global' }], 'release release release release', { global: 'release', local: 'release' })).toEqual([
      { text: 'release ' }, { text: 'release', parameterId: 'global' }, { text: ' ' }, { text: 'release', parameterId: 'local' }, { text: ' ' }, { text: 'release', parameterId: 'global' },
    ]);
  });
  it('keeps the exact snapshot if source or values no longer reconstruct it', () => {
    expect(snapshotReferences(['stop ', { parameterId: 'env' }], 'stop preview', { env: 'production' })).toEqual([{ text: 'stop preview' }]);
  });
  it('preserves whitespace and empty references without inventing placeholder text', () => {
    expect(snapshotReferences([' \n', { parameterId: 'empty' }, '\t'], ' \n\t', {})).toEqual([{ text: ' \n' }, { text: '', parameterId: 'empty' }, { text: '\t' }]);
  });
});
