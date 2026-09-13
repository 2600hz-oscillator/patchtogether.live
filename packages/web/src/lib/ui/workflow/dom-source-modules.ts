/**
 * Former UI-owned retained media sources. Source controllers now belong to
 * graph nodes under $lib/ui/media, so hiding a module cannot detach its source.
 * The old card-walking derivation tests were retired with the cards.
 */
export const DOM_SOURCE_LANE_TYPES: ReadonlySet<string> = new Set<string>([]);

/**
 * Former UI-owned frame, analysis, and CV producers. NODE_FRAME_PRODUCER_TYPES
 * and NODE_VIZ_SURFACE_TYPES now own that work on graph lifetime.
 *
 * Keep the empty declarations separate: consumers distinguish media sources
 * from producers, and node-frame-producer-registry.test.ts checks ownership
 * disjointness. Repair new UI-owned producers with a node-scoped owner; the
 * headless host is retired.
 */
export const CARD_PRODUCER_LANE_TYPES: ReadonlySet<string> = new Set<string>([]);
