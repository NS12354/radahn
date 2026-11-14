import type { LogKind } from '../app/plan';

/** Record activity for the Plan tab's log. The Plan tab installs the sink; until then calls are dropped. */
let sink: (kind: LogKind, text: string, ok?: boolean) => void = () => {};
export const setTrackSink = (f: typeof sink) => { sink = f; };
export const track = (kind: LogKind, text: string, ok?: boolean) => sink(kind, text, ok);
