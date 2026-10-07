// ----------------------------------------------------------------------------------------------
// TEMPLATE STORAGE -- constants & GraphQL queries
// Templates are sharded across up to 10 shop metafields (see SHARD_* below); saved product
// selections are six more shop metafields, defined further down under their own banner.
// ----------------------------------------------------------------------------------------------
const TEMPLATE_NAMESPACE = 'template_to_text';
const SHARD_COUNT = 10;
const SHARD_KEYS = [
  'template_0',
  'template_1',
  'template_2',
  'template_3',
  'template_4',
  'template_5',
  'template_6',
  'template_7',
  'template_8',
  'template_9',
];
// Max serialized JSON bytes per shard. Kept under the 131,072 byte platform limit with headroom.
const SHARD_MAX_BYTES = 122880;
// Legacy single-metafield location, read once for migration into the new shards. Never written to.
const LEGACY_NAMESPACE = 'sidekick';
const LEGACY_KEY = 'templates';
const STORAGE_FULL_MESSAGE = 'Template storage is full. Delete some templates before saving.';
// Bytes in one kilobyte, used to report how much extra storage a too-large template list would need.
const BYTES_PER_KB = 1024;
const PAGE_SIZE = 25;
// Hard cap on how many products the session-lifetime client-side search cache
// (allLoadedProducts/loadedProductsRef, see the Extension component) will hold. Without a cap that
// cache -- deliberately never cleared, since it's what powers client-side metafield/advanced-boolean
// search across every page and search the merchant has run this session -- grows without bound for
// a long-lived session. FIFO eviction (oldest-LOADED product dropped first, not oldest-selected or
// least-recently-searched) is used once this cap is exceeded: simple to reason about, and a
// SELECTED product's own data is never affected by eviction (selectedProducts holds its own
// independent full copy) -- the only consequence is that loadProductsByIds may need one extra,
// harmless network fetch if an evicted product is later referenced by id again.
const LOADED_PRODUCTS_CACHE_LIMIT = 3000;

const PRODUCTS_QUERY = `query SearchProducts($first: Int, $after: String, $last: Int, $before: String, $query: String) {
  products(first: $first, after: $after, last: $last, before: $before, sortKey: CREATED_AT, reverse: true, query: $query) {
    edges {
      node {
        id
        title
        handle
        vendor
        productType
        tags
        status
        description
        totalInventory
        featuredMedia { ... on MediaImage { image { url } } }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        createdAt
        updatedAt
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
              price
              compareAtPrice
              inventoryItem { unitCost { amount } }
              barcode
              inventoryQuantity
              selectedOptions { name value }
            }
          }
        }
        metafields(first: 50) {
          edges {
            node { namespace key value }
          }
        }
      }
    }
    pageInfo { hasNextPage hasPreviousPage endCursor startCursor }
  }
}`;

// Reads the shop's own gid (used as the metafield ownerId), the shop primary domain, all four shard
// metafields (aliased shard0..shard3), and the legacy metafield (aliased `legacy`) used for one-time
// migration. Stored as unstructured shop metafields (no definition), so access is governed purely by
// the app's API scopes and shared across all staff who use the app.
const TEMPLATES_READ_QUERY = `query ReadTemplates {
  shop {
    id
    primaryDomain {
      host
    }
    ${SHARD_KEYS.map(
      (key, index) =>
        `shard${index}: metafield(namespace: "${TEMPLATE_NAMESPACE}", key: "${key}") { value }`,
    ).join('\n    ')}
    legacy: metafield(namespace: "${LEGACY_NAMESPACE}", key: "${LEGACY_KEY}") { value }
  }
}`;

const TEMPLATES_WRITE_MUTATION = `mutation WriteTemplates($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id value }
    userErrors { field message code }
  }
}`;

// --- Saved product selections ------------------------------------------------------------------
// Six PUBLIC selections are shared by everyone on the shop. Each selection is one unstructured shop
// metafield of type `json` holding an array of product GIDs, so it persists across logins, devices,
// and staff members. No user identity is required to read or write them.
const SELECTION_MAX_PRODUCTS = 4000;
// Product ids are re-fetched in chunks so one `nodes` call never asks for too much nested data.
const SELECTION_FETCH_CHUNK = 50;



// --- Global variables (session 23) --------------------------------------------------------------
// A shop-wide, merchant-defined variable, read-only inside a template: `title` is the name
// referenced as `{{ $global:title }}` (see GLOBAL_PREFIX/spliceGlobalVariables further down), `body`
// is the literal text/template snippet it evaluates to. Defined and managed on their own Settings
// page (see renderGlobalVarsView), NOT inside any one template -- see roadmap.md item 22 for the
// full design discussion this implements.
interface GlobalVarEntry {
  id: string;
  title: string;
  body: string;
}

// Generate a placeholder id for a new global variable entry -- same shape as generateNoteId, just a
// distinct prefix so the two are never confused if they ever end up in the same debug log.
function generateGlobalVarId(): string {
  return `global-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Parse the stored global-variables metafield value into an ordered list. A missing, empty, or
// unparseable value yields an empty list -- same defensive shape as parseSelectionItems.
function parseGlobalVars(rawValue: any): GlobalVarEntry[] {
  if (rawValue == null || rawValue === '') return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    const list: GlobalVarEntry[] = [];
    for (const item of parsed) {
      if (item && typeof item.title === 'string') {
        list.push({
          id: typeof item.id === 'string' && item.id ? item.id : generateGlobalVarId(),
          title: item.title,
          body: typeof item.body === 'string' ? item.body : '',
        });
      }
    }
    return list;
  } catch {
    return [];
  }
}

// Single, un-sharded shop metafield (like a public selection's own metafield) holding every global
// variable as one JSON array -- no template-style multi-shard packing needed, since global
// definitions are merchant-authored, not auto-generated like History.
const GLOBALS_KEY = 'globals';

// Read-immediately-before-write query for globals, mirroring HISTORY_READ_QUERY's own narrower
// single-metafield shape (used by mutateGlobalVars below) rather than re-fetching all 6 public
// selections + subtitles + History just to change one global variable.
const GLOBALS_READ_QUERY = `query ReadGlobals($ns: String!, $key: String!) {
  shop {
    id
    globals: metafield(namespace: $ns, key: $key) { value }
  }
}`;

// --- History (session 17) -------------------------------------------------------------------
// An automatic, shop-wide log of activity: which objects a template has actually produced a
// downloaded file from, and a handful of selection/template lifecycle events. Stored the same way
// as a public selection (one JSON array of SelectionEntry -- see that interface's own comment for
// why a product reference and a free-standing note already share one shape), reusing the same
// parser (parseSelectionItems) and combined-row renderer (combineSelectionRows/SelectionRow) the
// Selection view already has. Unlike a public selection, History is written by the app itself, not
// curated by a merchant: there is no subtitle, no manual reordering, and no manual
// removal/editing -- see renderSettingsView's History panel. Two kinds of entries:
//  - OBJECT entries (id = a real product gid, or an existing note's own generated id): updated IN
//    PLACE on every reappearance -- a new occurrence never creates a duplicate entry, it appends
//    another `{{ ... }}` tag onto the SAME entry's note (capHistoryTags below bounds how many).
//  - Free-standing LOG entries (id = a freshly generated placeholder, via generateNoteId, exactly
//    like a manually-typed note): one brand-new entry per occurrence -- resubtitled/cleared/
//    template-created/template-destroyed have no natural "same object" to update in place.
// Growth policy (deliberately asked about and confirmed with the user before building this,
// precisely because there is no manual removal to fall back on): a hard byte-size ceiling
// (HISTORY_SAFE_BYTES, mirroring the safety margin already used for a template shard's real
// 131,072-byte metafield-value limit) enforced by FIFO EVICTION -- oldest entries (front of the
// array; entries are only ever appended at the end, in true occurrence order) are dropped first
// once the ceiling is hit, so new activity always has room and nothing silently stops being logged.
// A per-entry tag cap (HISTORY_MAX_TAGS_PER_ENTRY) additionally bounds how long any ONE object's
// accumulated note can grow, so a single frequently-reused product can't alone crowd out History's
// budget for everything else -- oldest tags on that one entry drop first, same FIFO principle at a
// smaller scale.
const HISTORY_KEY = 'history_log';
// Leaves the same safety margin below the real 131,072-byte metafield value limit that a template
// shard's own SHARD_BYTE_LIMIT already uses (see packTemplatesIntoShards) -- proven headroom for
// JSON-encoding overhead/escaping, not a new number invented for this feature.
const HISTORY_SAFE_BYTES = 122880;
// Secondary, count-based safety net (evaluated after the byte cap, so it only ever matters if
// entries are unusually small) -- keeps History from growing to an unwieldy list length even on a
// shop whose entries happen to stay well under the byte ceiling.
const HISTORY_MAX_ENTRIES = 4000;
// Oldest-tag-first cap on how many `{{ ... }}` tags accumulate on a single OBJECT entry's note.
const HISTORY_MAX_TAGS_PER_ENTRY = 20;

// Matches one appended `{{ ... }}` tag in a History entry's note (never spans a `{`/`}`, matching
// every tag this feature ever generates -- none nest braces). Used only to COUNT/TRIM tags already
// appended by this feature, never to interpret arbitrary user-typed text as a tag.
const HISTORY_TAG_REGEX = /\{\{[^{}]*\}\}/g;

// "date is down to the seconds" (as specified) -- reuses the exact {{ time=FORMAT }} engine
// (formatDateTime) so History's own date text renders through the same, already-verified
// formatting code as every other date in the app, rather than a second hand-rolled date formatter.
function historyDate(date: Date): string {
  return formatDateTime(date, 'MM/dd/yyyy HH:mm:ss');
}

// Appends a new `{{ ... }}` tag to a History entry's existing note text, per explicit direction:
// append, never overwrite. A blank base note (a product with no note typed, or a brand-new object's
// first appearance) omits the leading separator so the tag doesn't start with a stray space.
function appendHistoryTag(note: string, tag: string): string {
  return note ? `${note} ${tag}` : tag;
}

// Bounds how many `{{ ... }}` tags one entry's note can carry: once over the cap, the OLDEST
// (earliest-appended, i.e. leftmost) tags are dropped first -- the human-authored base text before
// the first tag is never touched. A note with no tags, or at/under the cap, is returned unchanged.
function capHistoryTags(note: string, maxTags: number): string {
  const tags = note.match(HISTORY_TAG_REGEX);
  if (!tags || tags.length <= maxTags) return note;
  let result = note;
  for (let i = 0; i < tags.length - maxTags; i++) {
    result = result.replace(tags[i], '');
  }
  // Collapse any doubled-up spacing left behind by a removed middle tag, and trim a now-possibly-
  // leading/trailing space from removing the very first or last tag.
  return result.replace(/ {2,}/g, ' ').trim();
}

// Enforces History's growth policy (see the section comment above) on a full entries array, in
// this exact order: (1) FIFO-evict whole entries from the FRONT (oldest) while the JSON-encoded
// array exceeds the safe byte ceiling, then (2) apply the count-based safety net the same way.
// Entries are only ever appended at the end elsewhere in this file, so "front of the array" and
// "oldest" are the same thing -- no separate timestamp/sequence field is needed to know eviction
// order.
function enforceHistoryCap(entries: SelectionEntry[]): SelectionEntry[] {
  let next = entries;
  while (next.length > 0 && JSON.stringify(next).length > HISTORY_SAFE_BYTES) {
    next = next.slice(1);
  }
  if (next.length > HISTORY_MAX_ENTRIES) {
    next = next.slice(next.length - HISTORY_MAX_ENTRIES);
  }
  return next;
}

// One object (product or existing note) that a completed download actually read from, and the tag
// its History entry should gain for this occurrence.
interface HistoryTouch {
  id: string;
  // The object's OWN current note text -- used as this entry's starting note ONLY the first time it
  // appears in History; ignored on every later occurrence (the entry's own accumulated note, tags
  // included, is what continues to grow from then on).
  baseNote: string;
  tag: string;
}

// Applies a batch of HistoryTouch updates to the current History array: an id already present gets
// another tag appended (capped -- see capHistoryTags) to its EXISTING entry; a new id gets a fresh
// entry seeded from its current live note. Order is preserved for existing entries; new entries join
// the end, in touches' own order. Pure -- the caller (mutateHistory) is the one that actually reads/
// writes the metafield.
function applyHistoryTouches(current: SelectionEntry[], touches: HistoryTouch[]): SelectionEntry[] {
  const byId = new Map(current.map((e): [string, SelectionEntry] => [e.id, e]));
  const order = current.map((e) => e.id);
  for (const touch of touches) {
    const existing = byId.get(touch.id);
    const baseNote = existing ? existing.note : touch.baseNote;
    byId.set(touch.id, {
      id: touch.id,
      note: capHistoryTags(appendHistoryTag(baseNote, touch.tag), HISTORY_MAX_TAGS_PER_ENTRY),
    });
    if (!existing) order.push(touch.id);
  }
  return enforceHistoryCap(order.map((id) => byId.get(id)!));
}

// Appends one brand-new, free-standing log entry (resubtitled / cleared / template created or
// destroyed) -- always a NEW entry, never merged into an existing one, since these events have no
// natural "same object" to update in place.
function appendHistoryLogNote(current: SelectionEntry[], text: string): SelectionEntry[] {
  return enforceHistoryCap([...current, createNoteEntry(text)]);
}

// Maximum length of a public selection's subtitle, shown under its name in the Selections menu.
const SUBTITLE_MAX_LENGTH = 16;
// Single shop metafield holding every public selection's subtitle, keyed by slot id.
const SUBTITLES_KEY = 'sel_subtitles';

type SelectionSlotId =
  | 'current'
  | 'public_1'
  | 'public_2'
  | 'public_3'
  | 'public_4'
  | 'public_5'
  | 'public_6';

// The 6 saved/shared slots, excluding 'current' -- used to type the state maps that are only ever
// keyed by a public slot (selectionEntries, selectionNotes below), so a future accidental
// `selectionEntries['current']` read is a compile error instead of silently resolving to
// `undefined`/`[]`. Previously those maps were typed `Record<string, ...>`, which accepted any
// string key including 'current', so this invariant was enforced only by one early-return inside
// openSelectionView, not by the type checker.
type PublicSelectionSlotId = Exclude<SelectionSlotId, 'current'>;

const PUBLIC_SLOTS: PublicSelectionSlotId[] = [
  'public_1',
  'public_2',
  'public_3',
  'public_4',
  'public_5',
  'public_6',
];
// (Selecting from a public slot uses PUBLIC_SLOTS directly -- there used to be a second constant,
// SAVED_SLOTS, defined as a literal copy of this array with no behavioral difference from it.)

function selectionSlotLabel(slot: SelectionSlotId): string {
  if (slot === 'current') return 'Current Selection';
  return `Public Selection ${slot.slice(-1)}`;
}

// The metafield key for a saved slot. Every saved slot uses a fixed key shared by the whole shop.
function selectionMetafieldKey(slot: SelectionSlotId): string | null {
  if (slot === 'current') return null;
  return `sel_public_${slot.slice(-1)}`;
}

const SELECTIONS_READ_QUERY = `query ReadSelections($ns: String!, $pub1: String!, $pub2: String!, $pub3: String!, $pub4: String!, $pub5: String!, $pub6: String!, $subs: String!, $hist: String!, $globals: String!) {
  shop {
    id
    pub1: metafield(namespace: $ns, key: $pub1) { value }
    pub2: metafield(namespace: $ns, key: $pub2) { value }
    pub3: metafield(namespace: $ns, key: $pub3) { value }
    pub4: metafield(namespace: $ns, key: $pub4) { value }
    pub5: metafield(namespace: $ns, key: $pub5) { value }
    pub6: metafield(namespace: $ns, key: $pub6) { value }
    subs: metafield(namespace: $ns, key: $subs) { value }
    hist: metafield(namespace: $ns, key: $hist) { value }
    globals: metafield(namespace: $ns, key: $globals) { value }
  }
}`;

// History's own metafield is re-read on demand by mutateHistory (see its comment) immediately
// before every write, same as mutateTemplateList/saveSelectionDraft already do for their own
// metafields -- this narrower query avoids re-fetching all 6 public selections + subtitles just to
// log one event.
const HISTORY_READ_QUERY = `query ReadHistory($ns: String!, $key: String!) {
  shop {
    id
    hist: metafield(namespace: $ns, key: $key) { value }
  }
}`;

const PRODUCTS_BY_IDS_QUERY = `query ProductsByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id
      title
      handle
      vendor
      productType
      tags
      status
      description
      totalInventory
      featuredMedia { ... on MediaImage { image { url } } }
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount currencyCode }
      }
      createdAt
      updatedAt
      variants(first: 100) {
        edges {
          node {
            id
            title
            sku
            price
            compareAtPrice
            inventoryItem { unitCost { amount } }
            barcode
            inventoryQuantity
            selectedOptions { name value }
          }
        }
      }
      metafields(first: 50) {
        edges {
          node { namespace key value }
        }
      }
    }
  }
}`;

