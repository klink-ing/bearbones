/* eslint-disable */
// @ts-nocheck

// Template — read at runtime by `codegen-templates.ts` and spliced into
// Panda's emitted `styled-system/css/css.d.ts` immediately after the
// rewritten `type Styles` alias. The contents are TypeScript for the host
// project's emitted artifact, NOT for this package; this file is excluded
// from this package's `tsconfig` and is never imported as code.
//
// Sentinel placeholder substituted at codegen time:
//
//   readonly "__BEARBONES_CONDITION_PLACEHOLDER__":
//       "__BEARBONES_CONDITION_PLACEHOLDER__";
//
//   →  one rendered `readonly "<name>": "<value>";` line per registered
//      Panda condition, joined with newlines.
//
// The sentinel line is a valid TS property declaration so this file parses
// and editors highlight it correctly.
//
// Everything above the fence below is template-author metadata and is
// stripped from the emitted output by `codegen-patch-render.ts`.
// ---bearbones-template-emit-below---
// Marker selector shapes are derived from the return types of the runtime
// functions in `@klinking/panda-markers/marker-registry`, so the type-level
// evaluation of `marker(...).is.<relation>` matches the runtime emit
// byte-for-byte (modulo the build-time SHA1 hash, which TypeScript can't
// compute — we substitute a fixed `<HASH>` literal placeholder there).
import type {
  composeRelationSelectors,
  markerAnchor,
  markerAnchorClass,
  substituteAmp,
} from "@klinking/panda-markers";

/** Anchor selector for the marker; `<HASH>` is the type-level placeholder. */
type BearbonesMarkerAnchor<Id extends string> = ReturnType<typeof markerAnchor<Id, "<HASH>">>;

/** Marker observation: condition value with every `&` substituted for the anchor. */
type BearbonesObserver<Id extends string, Cond extends string> = ReturnType<
  typeof substituteAmp<Cond, BearbonesMarkerAnchor<Id>>
>;

export interface BearbonesMarkerBuilder<Id extends string, Cond extends string> {
  readonly is: ReturnType<typeof composeRelationSelectors<BearbonesObserver<Id, Cond>>>;
}

/**
 * The host project's condition vocabulary as a typed map. Each entry's
 * value is the resolved Panda condition selector — the same string the
 * runtime conditions stash holds. Single source of truth for the
 * `BearbonesMarker._<name>` shortcuts; do not duplicate these strings
 * elsewhere in the type emit.
 */
type BearbonesMarkerConditions = {
  readonly __BEARBONES_CONDITION_PLACEHOLDER__: "__BEARBONES_CONDITION_PLACEHOLDER__";
};

/**
 * Mapped type that turns each condition entry into a typed `_<name>`
 * shortcut on the marker. The `Cond` parameter is the entry's value, so
 * `BearbonesMarkerBuilder` resolves to a relation selector observing the
 * exact runtime condition.
 */
type BearbonesMarkerShortcuts<Id extends string> = {
  readonly [K in keyof BearbonesMarkerConditions as `_${K & string}`]: BearbonesMarkerBuilder<
    Id,
    BearbonesMarkerConditions[K]
  >;
};

export interface BearbonesMarker<Id extends string = string> extends BearbonesMarkerShortcuts<Id> {
  readonly anchor: ReturnType<typeof markerAnchorClass<Id, string>>;
  <C extends string>(condValue: C): BearbonesMarkerBuilder<Id, C>;
}

export declare function marker<Id extends string>(id: Id): BearbonesMarker<Id>;
