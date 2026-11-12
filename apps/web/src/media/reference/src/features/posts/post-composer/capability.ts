// One capability boundary for the composer.
//
// A host declares which post kinds a surface supports. Before this module the
// declaration reached only the tab strip, so the attachment toolbars, the
// hidden file inputs, drag and drop, and programmatic tab changes could each
// reach a kind the surface had ruled out. Every one of those entrances now
// asks the same predicate, and anything undeclared fails closed.

import type {
  AttachmentKind,
  ComposerCapability,
  ComposerTab,
  ComposerToolbarAction,
} from "./types.ts";

export interface ComposerCapabilityOptions {
  /** Song posting additionally requires an author the host can publish as. */
  readonly canCreateSongPost?: boolean;
}

export interface ComposerCapabilitySet {
  /** Declared kinds that survived every gate, in declaration order. */
  readonly granted: readonly ComposerCapability[];
  /** The subset that is a tab, for the tab strip and the active-tab default. */
  readonly tabs: readonly ComposerTab[];
  allows(capability: ComposerCapability): boolean;
  /** Keep only the toolbar actions this surface can honour. */
  permitted<T extends { readonly kind: ComposerToolbarAction }>(
    actions: readonly T[],
  ): T[];
}

export function isComposerTab(
  capability: ComposerCapability,
): capability is ComposerTab {
  return capability !== "event";
}

/** An attachment kind is always a tab, so one predicate covers both. */
export function attachmentCapability(kind: AttachmentKind): ComposerCapability {
  return kind;
}

export function createComposerCapabilitySet(
  declared: readonly ComposerCapability[],
  options: ComposerCapabilityOptions = {},
): ComposerCapabilitySet {
  const granted = declared.filter(
    (capability) => capability !== "song" || options.canCreateSongPost === true,
  );
  const lookup = new Set<ComposerCapability>(granted);
  return {
    granted,
    tabs: granted.filter(isComposerTab),
    allows: (capability) => lookup.has(capability),
    permitted: (actions) => actions.filter((action) => lookup.has(action.kind)),
  };
}
