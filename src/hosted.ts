/** True in the Vercel build: features that need the local dev server (Blender, Claude Code terminal, Arduino compiler) are hidden. */
declare const __FF_HOSTED__: boolean | undefined;
export const HOSTED = typeof __FF_HOSTED__ !== 'undefined' && !!__FF_HOSTED__;
