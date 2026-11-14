import type { Project } from '../app/project';
import type { Viewport } from '../scene/viewport';
import type { Product } from '../scene/product';
import type { Bench } from '../hw/bench';
import type { BoardDef } from '../hw/types';
import type { SMState } from '../proto/stateMachine';

export type Mode = 'design' | 'proto' | 'elec' | 'review' | 'plan' | 'github';

/** What every panel can reach. Implemented in main.ts. */
export interface App {
  project: Project;
  viewport: Viewport;
  product: Product;
  bench: Bench;
  mode: Mode;
  sm: SMState;
  base: string;
  board(): BoardDef;
  /** Persist (autosave) after a change. */
  changed(what?: 'product' | 'electronics' | 'interactions' | 'review' | 'meta' | 'plan'): void;
  setMode(m: Mode): void;
  rebuildProduct(): Promise<void>;
  selectPart(part: string | null): void;
  selected: string | null;
  /** Store id of the open project (null for the tour's scratch copy). */
  projectId: string | null;
}
