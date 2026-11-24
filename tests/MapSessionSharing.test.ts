/**
 * Building a map together (src/client/scenario/MapSession.ts): editors share
 * a document by sending their edits through one ordered log and applying
 * everyone's edits from it, their own included. Copies stay the same, and
 * each editor's undo takes back its own steps.
 */

import {
  DocumentEditor,
  type Edit,
  type EditRelay,
  type StepKind,
} from "../src/client/scenario/DocumentEditor";
import { EditSchema } from "../src/client/scenario/MapSession";
import {
  land,
  newNation,
  newScenarioDocument,
  serializeScenarioDocument,
  WATER,
} from "../src/client/scenario/ScenarioDocument";

/** The session: one ordered log, delivered to every editor on flush(). */
class FakeSession {
  private log: {
    from: number;
    edits: Edit[];
    commit: StepKind | null;
  }[] = [];
  private delivered = 0;
  editors: DocumentEditor[] = [];

  relay(from: number): EditRelay {
    return {
      edit: (edit) => this.log.push({ from, edits: [edit], commit: null }),
      commit: (kind) => this.log.push({ from, edits: [], commit: kind }),
      step: (edits, kind) => this.log.push({ from, edits, commit: kind }),
    };
  }

  /** Every editor applies what came in since, in the log's order. */
  flush(): void {
    for (; this.delivered < this.log.length; this.delivered++) {
      const entry = this.log[this.delivered];
      // As the wire would carry it.
      const edits = entry.edits.map((e) =>
        EditSchema.parse(JSON.parse(JSON.stringify(e))),
      ) as Edit[];
      this.editors.forEach((editor, i) =>
        editor.receive(edits, i === entry.from, entry.commit),
      );
    }
  }
}

function twoEditors() {
  const doc = newScenarioDocument("Shared", 100, 100);
  const session = new FakeSession();
  const editors = [0, 1].map((i) => {
    const copy = structuredClone(doc);
    const editor = new DocumentEditor(copy, () => {});
    editor.setRelay(session.relay(i));
    return editor;
  });
  session.editors = editors;
  return { session, a: editors[0], b: editors[1] };
}

const same = (a: DocumentEditor, b: DocumentEditor) =>
  expect(serializeScenarioDocument(a.doc)).toEqual(
    serializeScenarioDocument(b.doc),
  );

describe("building a map together", () => {
  test("nothing applies until the session hands it back", () => {
    const { session, a, b } = twoEditors();
    a.apply({ type: "set_terrain", tiles: [5], terrain: [land(3)] });
    a.commit();
    expect(a.doc.terrain[5]).toBe(WATER);
    session.flush();
    expect(a.doc.terrain[5]).toBe(land(3));
    expect(b.doc.terrain[5]).toBe(land(3));
  });

  test("edits on the same tiles end the same everywhere", () => {
    const { session, a, b } = twoEditors();
    a.apply({
      type: "set_terrain",
      tiles: [1, 2, 3],
      terrain: [land(1), land(1), land(1)],
    });
    b.apply({
      type: "set_terrain",
      tiles: [2, 3, 4],
      terrain: [land(9), land(9), land(9)],
    });
    b.commit();
    a.commit();
    session.flush();
    same(a, b);
    // b's edit came second.
    expect(a.doc.terrain[2]).toBe(land(9));
  });

  test("an edit that no longer applies is skipped by everyone alike", () => {
    const { session, a, b } = twoEditors();
    const nation = newNation(a.doc, (n) => `Nation ${n}`);
    a.apply({ type: "add_nation", nation });
    a.commit();
    session.flush();
    a.apply({ type: "set_terrain", tiles: [10], terrain: [land(0)] });
    a.commit();
    session.flush();
    // b removes the nation while a still paints for it.
    b.apply({ type: "remove_nation", id: nation.id });
    b.commit();
    a.apply({ type: "set_owner", tiles: [10], owner: nation.id });
    a.commit();
    session.flush();
    same(a, b);
    expect(a.doc.nations).toHaveLength(0);
    expect(a.doc.owners[10]).toBe(0);
  });

  test("undo takes back the undoer's own step, for everyone", () => {
    const { session, a, b } = twoEditors();
    a.apply({ type: "set_terrain", tiles: [7], terrain: [land(2)] });
    a.commit();
    b.apply({ type: "set_terrain", tiles: [8], terrain: [land(4)] });
    b.commit();
    session.flush();
    expect(a.canUndo()).toBe(true);
    a.undo();
    session.flush();
    same(a, b);
    expect(b.doc.terrain[7]).toBe(WATER);
    // b's own tile stays.
    expect(b.doc.terrain[8]).toBe(land(4));
    expect(a.canRedo()).toBe(true);
    a.redo();
    session.flush();
    same(a, b);
    expect(b.doc.terrain[7]).toBe(land(2));
  });

  test("malformed edits never reach the document", () => {
    expect(
      EditSchema.safeParse({ type: "set_terrain", tiles: [-1], terrain: [1] })
        .success,
    ).toBe(false);
    expect(EditSchema.safeParse({ type: "explode" }).success).toBe(false);
  });
});
