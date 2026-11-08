import { ClipBody, emptyHistory, HISTORY_MAX, record, redo, undo } from './track-history';

const body = (length: number): ClipBody => ({ length, notes: [] });

describe('track history', () => {
  it('undoes to the body before an edit and redoes it', () => {
    let history = record(emptyHistory(), body(1));
    const undone = undo(history, body(2));
    expect(undone?.body).toEqual(body(1));
    history = undone?.history ?? history;
    const redone = redo(history, body(1));
    expect(redone?.body).toEqual(body(2));
    expect(redone?.history.past).toEqual([body(1)]);
  });

  it('has nothing to undo or redo at first; an edit drops what was undone', () => {
    expect(undo(emptyHistory(), body(1))).toBeNull();
    expect(redo(emptyHistory(), body(1))).toBeNull();
    const undone = undo(record(emptyHistory(), body(1)), body(2));
    expect(record(undone?.history ?? emptyHistory(), body(1)).future).toEqual([]);
  });

  it('keeps HISTORY_MAX steps', () => {
    let history = emptyHistory();
    for (let i = 0; i < HISTORY_MAX + 5; i += 1) history = record(history, body(i));
    expect(history.past).toHaveLength(HISTORY_MAX);
    expect(history.past[0]).toEqual(body(5));
  });
});
