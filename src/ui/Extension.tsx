import { render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';

// ----------------------------------------------------------------------------------------------
// EXTENSION COMPONENT
// State, the data layer (Shopify GraphQL reads/writes), event handlers, and view rendering all
// live in this one component -- see architecture-notes.md for why that stayed a single component
// in this pass (most state is read across view boundaries, e.g. selections and the main product
// list share the same product cache and note map) rather than being split into custom hooks.
// ----------------------------------------------------------------------------------------------
function Extension() {
  const [view, setView] = useState<'main' | 'editor' | 'selection' | 'settings' | 'globals'>(
    'main',
  );
  // The shop's own gid, used as the metafield ownerId on writes. Loaded on app start.
  const shopIdRef = useRef<string | null>(null);
  // The shop's primary domain host (e.g. "myshop.myshopify.com"), exposed via {{ primaryDomain }}.
  const [primaryDomain, setPrimaryDomain] = useState<string>('');

  // Products
  const [products, setProducts] = useState<ProductData[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [productPageInfo, setProductPageInfo] = useState<PageInfo | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<Record<string, ProductData>>({});
  // Notes typed for selected products on the main page, keyed by product id. In-memory only: a note
  // is never written to the product, and only persists when saved into a public selection.
  const [productNotes, setProductNotes] = useState<Record<string, string>>({});
  // Which of a product's variants are checked, keyed by product id, for a product with more than one
  // variant. Absent (or an array covering every variant id) means "every variant" -- the same
  // meaning an absent/empty SelectionEntry.variantIds already has, so this maps directly onto that
  // stored field with no extra translation. In-memory only, like productNotes.
  const [selectedVariantIds, setSelectedVariantIds] = useState<Record<string, string[]>>({});
  // The Current Selection's combined product+note add-order, by id -- session 8, per explicit
  // direction ("show objects in the order added to the selection"). Neither `selectedProducts` (a
  // map) nor `noteObjects` (its own array) individually carries this, since a product and a note
  // added interleaved in time live in two separate collections with no shared ordering signal
  // between them. Deliberately a per-id SEQUENCE NUMBER map, not an order array that would need
  // splicing kept in sync on every add/remove: a forgotten update site here just leaves that id's
  // number unset, and unset sorts LAST alongside everything else unset (still visible, only
  // possibly mis-positioned) -- an order array's equivalent failure (forgetting to append on some
  // add path) would make that item invisible from the combined view entirely, a much worse
  // degradation for a value with several separate call sites that all need to stay in sync.
  // `currentSelectionOrderCounter` is a ref (not state) since bumping it must never itself trigger a
  // re-render -- only the map assignments that read it do.
  const currentSelectionOrderCounter = useRef<number>(0);
  const [currentSelectionOrderIndex, setCurrentSelectionOrderIndex] = useState<
    Record<string, number>
  >({});
  const nextSelectionOrderIndex = (): number => {
    currentSelectionOrderCounter.current += 1;
    return currentSelectionOrderCounter.current;
  };
  // Which bulk-select button is currently active, if any. Only one can be active at a time.
  const [bulkMode, setBulkMode] = useState<BulkSelectMode | null>(null);
  // Persistent map of EVERY product returned by any products query this session (initial load, each
  // search, each pagination page), keyed by product id. This is the corpus the client-side metafield
  // filter and advanced boolean search evaluate against. It only grows and is never cleared.
  const [allLoadedProducts, setAllLoadedProducts] = useState<Record<string, ProductData>>({});

  // Saved product selections (6 shared/public slots). `selectionIds` holds the stored product GIDs of
  // each saved slot; the currently open slot's working copy lives in `selectionDraft`.
  const [selectionEntries, setSelectionEntries] = useState<
    Record<PublicSelectionSlotId, SelectionEntry[]>
  >({
    public_1: [],
    public_2: [],
    public_3: [],
    public_4: [],
    public_5: [],
    public_6: [],
  });
  // Subtitles of the six public selections, shown as a gray second line in the Selections menu.
  // Free-standing note entries stored in each saved slot, read from the same metafield array as its
  // products (split out by isStandaloneNote in loadSelections).
  const [selectionNotes, setSelectionNotes] = useState<
    Record<PublicSelectionSlotId, SelectionEntry[]>
  >({
    public_1: [],
    public_2: [],
    public_3: [],
    public_4: [],
    public_5: [],
    public_6: [],
  });
  // Each public slot's stored combined product+note order, by id (session 8) -- see
  // currentSelectionOrderIndex's comment for why this is a per-id sequence-number map rather than an
  // order array. Populated in loadSelections from the stored array's own order (which already
  // interleaves products and notes exactly as they were last saved), consumed by openSelectionView
  // to seed the selection view's combined ordering for a public slot.
  const [selectionSlotOrderIndex, setSelectionSlotOrderIndex] = useState<
    Record<PublicSelectionSlotId, Record<string, number>>
  >({
    public_1: {},
    public_2: {},
    public_3: {},
    public_4: {},
    public_5: {},
    public_6: {},
  });
  // Free-standing note entries belonging to the Current Selection (in memory only until saved into
  // a slot). "noteObjects" is a holdover name from when these were a distinct NoteObject type --
  // they are plain SelectionEntry values now (id is a generated placeholder, not a product id).
  const [noteObjects, setNoteObjects] = useState<SelectionEntry[]>([]);
  // Free-standing note entries in the open selection view's working draft.
  const [selectionNoteDraft, setSelectionNoteDraft] = useState<SelectionEntry[]>([]);
  // Subset checkboxes in a PUBLIC selection view: which draft products / note objects are ticked.
  // They always start empty (nothing checked) each time a selection is opened and are never stored.
  const [checkedSelectionProducts, setCheckedSelectionProducts] = useState<Record<string, boolean>>(
    {},
  );
  const [checkedSelectionNotes, setCheckedSelectionNotes] = useState<Record<string, boolean>>({});
  // Text typed in the note modal before it is saved as a free-standing note entry.
  const [noteDraftText, setNoteDraftText] = useState<string>('');
  // True while the Refresh Page button is re-reading templates, selections, and products.
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [selectionSubtitles, setSelectionSubtitles] = useState<Record<string, string>>({});
  // The subtitle being edited in the open public selection view.
  const [subtitleDraft, setSubtitleDraft] = useState<string>('');
  const [subtitleBaseline, setSubtitleBaseline] = useState<string>('');
  const [selectionsError, setSelectionsError] = useState<string | null>(null);
  // History (session 17): raw stored entries (product references + free-standing log notes),
  // exactly as parsed from the history_log metafield -- loaded alongside the 6 public selections
  // (loadSelections/refreshAll) so it's ready by the time the Settings page's History panel opens.
  // The History panel hydrates full ProductData for the product-type entries itself, on open (see
  // openSettings), the same way openSelectionView already does for a public slot.
  const [historyEntries, setHistoryEntries] = useState<SelectionEntry[]>([]);
  const [historyProducts, setHistoryProducts] = useState<ProductData[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState<string>('');
  // Global variables (session 23): the full, ordered list -- loaded alongside the 6 public
  // selections/History (loadSelections/refreshAll), same "ready by the time its Settings sub-page
  // opens" reasoning History's own entries already use. `globalVarSearch` filters the list view;
  // `editingGlobalVarId` (null for "new") plus the two draft fields back the edit popup, mirroring
  // the note-modal's own draft-then-Save/Discard shape.
  const [globalVars, setGlobalVars] = useState<GlobalVarEntry[]>([]);
  const [globalVarSearch, setGlobalVarSearch] = useState<string>('');
  const [globalVarError, setGlobalVarError] = useState<string | null>(null);
  const [editingGlobalVarId, setEditingGlobalVarId] = useState<string | null>(null);
  const [globalVarTitleDraft, setGlobalVarTitleDraft] = useState<string>('');
  const [globalVarBodyDraft, setGlobalVarBodyDraft] = useState<string>('');
  const [globalVarTitleError, setGlobalVarTitleError] = useState<string | null>(null);
  const [globalVarSaving, setGlobalVarSaving] = useState<boolean>(false);
  const [selectionSlot, setSelectionSlot] = useState<SelectionSlotId | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<ProductData[]>([]);
  // The OPEN selection's own combined product+note order, by id -- seeded on openSelectionView from
  // currentSelectionOrderIndex ('current') or selectionSlotOrderIndex[slot] (a public slot), and
  // extended (via nextSelectionOrderIndex) whenever addMainSelectionToDraft merges more items in.
  // Session 8 -- see currentSelectionOrderIndex's comment for the map-not-array reasoning.
  const [selectionViewOrderIndex, setSelectionViewOrderIndex] = useState<Record<string, number>>(
    {},
  );
  const [selectionBaseline, setSelectionBaseline] = useState<string>('');
  const [selectionSearch, setSelectionSearch] = useState('');
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [selectionMissing, setSelectionMissing] = useState(false);
  // Mirror of `allLoadedProducts` kept in a ref so async loaders can read the latest cache without
  // depending on a stale state closure. `order` tracks insertion order (oldest first) so
  // rememberProducts can evict the oldest entries once LOADED_PRODUCTS_CACHE_LIMIT is exceeded.
  const loadedProductsRef = useRef<{ byId: Record<string, ProductData>; order: string[] }>({
    byId: {},
    order: [],
  });
  // Tracks the product request currently in flight. `pendingKey` identifies that exact request
  // (direction + cursor + query) so an identical request cannot be started again while it is still
  // running, and `token` lets a response from an older request be discarded. Without this, a change
  // event re-emitted by the search field during a re-render could restart the same search over and
  // over and lock the app up.
  const productRequestRef = useRef<{ token: number; pendingKey: string | null }>({
    token: 0,
    pendingKey: null,
  });

  // Templates
  const [templates, setTemplates] = useState<TemplateData[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateSort, setTemplateSort] = useState<'new-old' | 'old-new' | 'a-z' | 'z-a'>(
    'new-old',
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Editor
  const [editingTemplate, setEditingTemplate] = useState<TemplateData | null>(null);
  const [editorTitle, setEditorTitle] = useState('');
  const [editorBody, setEditorBody] = useState('');
  const [editorExtension, setEditorExtension] = useState('txt');
  // `null` means "not yet chosen" -- for a BRAND NEW template this is just the initial value of a UI
  // control (not inference; the merchant is free to change it before Save, same as any other
  // dropdown default), defaulted to 'variant' below in openNewTemplate. Opening an EXISTING template
  // whose stored fileBreak is null (never explicitly chosen -- see TemplateData.fileBreak) leaves it
  // null here too, so the dropdown visibly shows "not set" rather than silently substituting a
  // guess; saveTemplate refuses to save while this is null (see editorFileBreakError), same
  // enforcement as the Title field.
  const [editorFileBreak, setEditorFileBreak] = useState<FileBreak | null>('variant');
  // Session 9: "Merge IF" -- a boolean condition (same grammar as an {{ #if=... }} condition, using
  // `{{ selection.curr/next/prev.* }}` tokens) deciding whether to merge the next unit's rendered
  // output into the current file instead of starting a new one. Empty string (the default for a new
  // template) means "never merge" -- see TemplateData.mergeCondition's comment for the full design.
  const [editorMergeCondition, setEditorMergeCondition] = useState('');
  const [editorTitleError, setEditorTitleError] = useState<string | null>(null);
  const [editorFileBreakError, setEditorFileBreakError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Placeholder token that authors type into the body to mark where a variable should go.
  // Selecting a variable from the Insert variable menu replaces all occurrences of this token.
  // Both `{{ insert }}` and the spaceless `{{insert}}` are recognized as the placeholder.
  const INSERT_PLACEHOLDER = '{{ insert }}';
  const INSERT_PLACEHOLDER_REGEX = /\{\{\s*insert\s*\}\}/g;
  // Original editor values captured when the editor was opened, used to detect unsaved changes.
  const originalEditorRef = useRef<{
    title: string;
    body: string;
    extension: string;
    fileBreak: FileBreak | null;
    mergeCondition: string;
  }>({
    title: '',
    body: '',
    extension: '',
    fileBreak: 'variant',
    mergeCondition: '',
  });

  // Download: filename shown in the confirmation popup after the merchant clicks the download link.
  const [confirmedName, setConfirmedName] = useState<string>('');
  // The prepared download (data URL + filename), built asynchronously whenever the selection changes.
  const [download, setDownload] = useState<{ href: string; name: string; isZip: boolean } | null>(
    null,
  );
  // Progress of the asynchronous download preparation: how many files are done out of the total, and
  // whether the ZIP archive is currently being packaged. Null when nothing is being prepared.
  const [downloadProgress, setDownloadProgress] = useState<{
    done: number;
    total: number;
    packaging: boolean;
  } | null>(null);
  const [downloadFailed, setDownloadFailed] = useState<boolean>(false);
  // Monotonically increasing id of the newest preparation run, so an outdated in-flight build stops
  // as soon as the selection or template changes again.
  const downloadBuildRef = useRef<number>(0);
  // History (session 17): the touches (object id + {{ file=NAME, folder=FOLDER }} tag) for whichever download is
  // CURRENTLY prepared -- written by the download-preparation effect below, read once by
  // onDownloadClick when the merchant actually clicks the download link. A ref, not state: nothing
  // ever needs to re-render off this value.
  const pendingDownloadTouchesRef = useRef<HistoryTouch[]>([]);
  // Preview: which generated file the preview modal is currently showing (0-based).
  const [previewIndex, setPreviewIndex] = useState<number>(0);

  // The selected products with their current notes attached, so {{ product.note }} resolves during
  // download and preview generation and notes travel with a product into any selection, and with
  // `.variants` narrowed to whichever subset is checked in selectedVariantIds (see
  // narrowToSelectedVariants -- absent/full-coverage entries are a no-op, so this list is unaffected
  // for every product whose variants were never individually narrowed).
  const selectedProductList = useMemo(
    () =>
      Object.values<ProductData>(selectedProducts).map((p) =>
        narrowToSelectedVariants(
          { ...p, note: productNotes[p.id] || '' },
          selectedVariantIds[p.id],
        ),
      ),
    [selectedProducts, productNotes, selectedVariantIds],
  );
  // Session 24: total variant count across the Current Selection's products -- `.variants` on each
  // row is already narrowed to whichever subset is checked (see narrowToSelectedVariants above), so
  // this is just a straight sum, no separate lookup into selectedVariantIds needed. Feeds the
  // "(v/n)" count shown next to "Current Selection" (see formatSelectionCount).
  const currentSelectionVariantCount = useMemo(
    () => selectedProductList.reduce((sum: number, p: ProductData) => sum + p.variants.length, 0),
    [selectedProductList],
  );
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || null,
    [templates, selectedTemplateId],
  );
  // Session 24: the template the delete-confirmation modal is about to delete, if any -- looked up
  // once here so both the modal's confirmation text (shows its title) and confirmDelete's own
  // history-log text can share the same lookup instead of each re-deriving it.
  const pendingDeleteTemplate = useMemo(
    () => templates.find((t: TemplateData) => t.id === pendingDeleteId) || null,
    [templates, pendingDeleteId],
  );

  // Global variables (session 23): each global's OWN comment-stripped body, keyed by title -- what
  // spliceGlobalVariables actually reads. Computed once here (not on every splice call) per
  // spliceGlobalVariables' own comment; both the real download (the effect below) and the editor
  // Preview (buildOutputFiles further down) read this SAME map, so Preview never drifts from what a
  // download would actually produce -- the same guarantee this shared-planner pattern already
  // protects for every other input (mergeCondition, primaryDomain, ...).
  const globalBodiesByTitle = useMemo(() => {
    const map: Record<string, string> = {};
    for (const g of globalVars) {
      map[g.title] = stripComments(g.body);
    }
    return map;
  }, [globalVars]);

  // The products shown in the table. Combines the server-side page results with client-side matches:
  //  - No applied search term: just the server page results.
  //  - Non-empty term: UNION of the server page results and any loaded product whose metafield
  //    (or other searchable field) values contain the term (case-insensitive), de-duplicated by id
  //    with server results first.
  const displayedProducts = useMemo<ProductData[]>(() => {
    const term = appliedSearch.trim();
    if (term === '') {
      return products;
    }
    const loadedList = Object.values(allLoadedProducts);
    const result: ProductData[] = [...products];
    const seen = new Set(result.map((p) => p.id));
    for (const p of loadedList) {
      if (!seen.has(p.id) && productMatchesQuery(p, term)) {
        seen.add(p.id);
        result.push(p);
      }
    }
    return result;
  }, [products, allLoadedProducts, appliedSearch]);

  // --------------------------------------------------------------------------------------------
  // Data layer: template metafield read/write helpers
  // --------------------------------------------------------------------------------------------
  // Read the shop gid and the raw templates metafield value in one call. Records the shop id in a ref
  // for use as ownerId on writes. Returns the parsed template list plus any read error message.
  const readTemplatesFromShop = async (): Promise<{
    list: TemplateData[];
    error: string | null;
  }> => {
    const { data, errors } = await shopify.query(TEMPLATES_READ_QUERY);
    if (errors?.length) {
      return { list: [], error: errors.map((e: any) => e.message).join(', ') };
    }
    const shop = data?.shop;
    if (shop?.id) {
      shopIdRef.current = shop.id;
    }
    if (typeof shop?.primaryDomain?.host === 'string') {
      setPrimaryDomain(shop.primaryDomain.host);
    }
    // Parse every shard and merge them in order (shard0 first) to reconstruct the full list.
    const shardValues = SHARD_KEYS.map((_key, index) => shop?.[`shard${index}`]?.value);
    let anyUnparseable = false;
    const merged: TemplateData[] = [];
    for (const value of shardValues) {
      const { list, unparseable } = parseShardValue(value);
      if (unparseable) anyUnparseable = true;
      for (const t of list) merged.push(t);
    }

    // Migration: if the first shard is empty/null and the legacy metafield has data, treat the parsed
    // legacy value as the full list. It is packed into the new shards on the next save/delete; the
    // legacy metafield is left in place and never written to again.
    const firstShardEmpty = shardValues[0] == null || shardValues[0] === '' || merged.length === 0;
    if (firstShardEmpty) {
      const legacyValue = shop?.legacy?.value;
      if (legacyValue != null && legacyValue !== '') {
        const { list, unparseable } = parseShardValue(legacyValue);
        if (unparseable) anyUnparseable = true;
        if (list.length > 0) {
          return {
            list,
            error: anyUnparseable ? 'Stored templates could not be read.' : null,
          };
        }
      }
    }

    return {
      list: merged,
      error: anyUnparseable ? 'Stored templates could not be read.' : null,
    };
  };

  // Ensure the shop gid is available (needed as ownerId for writes). Re-reads if not yet loaded.
  // Returns the gid or null, setting an error message via the provided setter when it cannot be read.
  const ensureShopId = async (setError: (msg: string) => void): Promise<string | null> => {
    if (shopIdRef.current) {
      return shopIdRef.current;
    }
    const { error } = await readTemplatesFromShop();
    if (!shopIdRef.current) {
      setError(error || 'Could not determine the shop to save to.');
      return null;
    }
    return shopIdRef.current;
  };

  // Persist the full template list to the shop metafield. Returns raw errors/userErrors for handling.
  // Pack the full list into shards and write ALL shards in one metafieldsSet call so stale data in
  // higher shards is cleared when templates are removed. Returns an `overflow` flag when the list
  // exceeds the ten-shard (~1.2MB) cap, in which case no write is attempted.
  const writeTemplates = async (
    ownerId: string,
    list: TemplateData[],
  ): Promise<{ errors: any[]; userErrors: any[]; overflow: boolean }> => {
    const { shards, overflow } = packTemplatesIntoShards(list);
    if (overflow) {
      return { errors: [], userErrors: [], overflow: true };
    }
    const metafields = SHARD_KEYS.map((key, index) => ({
      ownerId,
      namespace: TEMPLATE_NAMESPACE,
      key,
      type: 'json',
      value: serializeTemplates(shards[index]),
    }));
    const { data, errors } = await shopify.query(TEMPLATES_WRITE_MUTATION, {
      variables: { metafields },
    });
    return {
      errors: errors || [],
      userErrors: data?.metafieldsSet?.userErrors || [],
      overflow: false,
    };
  };

  // Shared read-mutate-write flow for a template-list change: re-reads the stored list
  // immediately before writing (so a concurrent edit by another staff member is preserved),
  // applies `mutate` to it, writes the result, and reports one formatted error through
  // `setError` on any failure (storage overflow, transport errors, or userErrors, in that
  // priority order -- matching what saveTemplate/togglePin/confirmDelete each did inline before
  // this was extracted). Returns the written list on success, or null once `setError` has
  // already been called.
  const mutateTemplateList = async (
    mutate: (currentList: TemplateData[]) => TemplateData[],
    setError: (msg: string) => void,
  ): Promise<TemplateData[] | null> => {
    const ownerId = await ensureShopId(setError);
    if (!ownerId) {
      return null;
    }
    const { list: currentList, error: readError } = await readTemplatesFromShop();
    if (readError) {
      setError(readError);
      return null;
    }
    const nextList = mutate(currentList);
    const { errors, userErrors, overflow } = await writeTemplates(ownerId, nextList);
    if (overflow) {
      setError(storageFullMessage(nextList));
      return null;
    }
    const message = formatGraphQLErrors(errors, userErrors);
    if (message) {
      setError(message);
      return null;
    }
    return nextList;
  };

  // History's own read-mutate-write flow (session 17), the same shape as mutateTemplateList above:
  // re-read the metafield immediately before writing (minimizing, not eliminating, the race window
  // against a concurrent staff action logging its own entry at the same time -- the same accepted
  // model every other mutation in this file already uses), apply `mutate`, write the result. History
  // logging is deliberately best-effort: a failure here is silently swallowed rather than surfaced
  // to the merchant, since it is bookkeeping alongside whatever real action they took (a download, a
  // save, a delete) -- that real action's own success/failure is reported normally regardless of
  // whether logging it to History succeeded. On success, also updates historyEntries directly (skips
  // a redundant re-read) so the History panel reflects the write immediately if it happens to be open.
  const mutateHistory = async (
    mutate: (current: SelectionEntry[]) => SelectionEntry[],
  ): Promise<void> => {
    try {
      const ownerId = await ensureShopId(() => {});
      if (!ownerId) return;
      const { data } = await shopify.query(HISTORY_READ_QUERY, {
        variables: { ns: TEMPLATE_NAMESPACE, key: HISTORY_KEY },
      });
      const current = parseSelectionItems(data?.shop?.hist?.value);
      const next = mutate(current);
      const { errors } = await shopify.query(TEMPLATES_WRITE_MUTATION, {
        variables: {
          metafields: [
            {
              ownerId,
              namespace: TEMPLATE_NAMESPACE,
              key: HISTORY_KEY,
              type: 'json',
              value: JSON.stringify(next),
            },
          ],
        },
      });
      if (errors?.length) return;
      setHistoryEntries(next);
    } catch {
      // Best-effort, as above -- nothing to surface.
    }
  };

  // Global variables' own read-mutate-write flow (session 23), the same read-immediately-before-
  // write shape as mutateTemplateList/mutateHistory above -- but, unlike History's best-effort/
  // silently-swallowed model, a failure here IS surfaced via `setError`: editing a global variable is
  // a deliberate merchant action (like editing a template), not bookkeeping alongside some other
  // action, so it should fail loudly the same way mutateTemplateList already does. Returns the
  // written list on success (mirroring mutateTemplateList's own return shape), or null once
  // `setError` has already been called.
  const mutateGlobalVars = async (
    mutate: (current: GlobalVarEntry[]) => GlobalVarEntry[],
    setError: (msg: string) => void,
  ): Promise<GlobalVarEntry[] | null> => {
    const ownerId = await ensureShopId(setError);
    if (!ownerId) return null;
    try {
      const { data, errors: readErrors } = await shopify.query(GLOBALS_READ_QUERY, {
        variables: { ns: TEMPLATE_NAMESPACE, key: GLOBALS_KEY },
      });
      if (readErrors?.length) {
        setError(readErrors.map((e: any) => e.message).join(', '));
        return null;
      }
      const current = parseGlobalVars(data?.shop?.globals?.value);
      const next = mutate(current);
      const { data: writeData, errors: writeErrors } = await shopify.query(
        TEMPLATES_WRITE_MUTATION,
        {
          variables: {
            metafields: [
              {
                ownerId,
                namespace: TEMPLATE_NAMESPACE,
                key: GLOBALS_KEY,
                type: 'json',
                value: JSON.stringify(next),
              },
            ],
          },
        },
      );
      const message = formatGraphQLErrors(writeErrors, writeData?.metafieldsSet?.userErrors);
      if (message) {
        setError(message);
        return null;
      }
      setGlobalVars(next);
      return next;
    } catch (err: any) {
      setError(err?.message || 'Failed to save global variables.');
      return null;
    }
  };

  // --------------------------------------------------------------------------------------------
  // Data layer: product fetching & caching
  // --------------------------------------------------------------------------------------------
  // Merge freshly loaded products into both the ref cache and the state map used by client-side
  // search, capped at LOADED_PRODUCTS_CACHE_LIMIT (evicting the oldest-loaded products first) so the
  // cache doesn't grow without bound across a very long session.
  const rememberProducts = (list: ProductData[]): void => {
    if (list.length === 0) return;
    // Work out which products are genuinely new BEFORE the ref is updated. Re-visiting a page the
    // app has already loaded (for example clearing the search to return to the newest arrivals)
    // brings back the same ids, and replacing the state map in that case would hand every consumer
    // a brand-new object for no reason and churn the whole page.
    const { byId, order } = loadedProductsRef.current;
    const freshProducts = list.filter((p) => !byId[p.id]);
    const nextById = { ...byId };
    const nextOrder = [...order];
    for (const p of list) {
      if (!nextById[p.id]) {
        nextOrder.push(p.id);
      }
      nextById[p.id] = p;
    }
    const evictedIds: string[] = [];
    while (nextOrder.length > LOADED_PRODUCTS_CACHE_LIMIT) {
      const oldestId = nextOrder.shift();
      if (oldestId == null) break;
      delete nextById[oldestId];
      evictedIds.push(oldestId);
    }
    loadedProductsRef.current = { byId: nextById, order: nextOrder };
    if (freshProducts.length === 0 && evictedIds.length === 0) return;
    setAllLoadedProducts((prev) => {
      const next = { ...prev };
      for (const p of freshProducts) {
        next[p.id] = p;
      }
      for (const id of evictedIds) {
        delete next[id];
      }
      return next;
    });
  };

  const fetchProducts = async (
    cursor: string | null,
    direction: 'forward' | 'backward',
    query: string,
  ): Promise<void> => {
    // Ignore a repeat of the request that is already running (same direction, cursor, and query).
    const requestKey = `${direction}|${cursor ?? ''}|${query.trim()}`;
    if (productRequestRef.current.pendingKey === requestKey) {
      return;
    }
    const requestToken = productRequestRef.current.token + 1;
    productRequestRef.current = { token: requestToken, pendingKey: requestKey };
    setProductsLoading(true);
    setProductError(null);
    try {
      const { data, errors } = await shopify.query(PRODUCTS_QUERY, {
        variables: {
          first: direction === 'forward' ? PAGE_SIZE : null,
          after: direction === 'forward' ? cursor : null,
          last: direction === 'backward' ? PAGE_SIZE : null,
          before: direction === 'backward' ? cursor : null,
          query: query.trim() || null,
        },
      });
      // A newer request has started since this one; drop this response so pages cannot fight.
      if (productRequestRef.current.token !== requestToken) {
        return;
      }
      if (errors?.length) {
        setProductError(errors.map((e: any) => e.message).join(', '));
        return;
      }
      if (data?.products) {
        const pageProducts: ProductData[] = data.products.edges.map((e: any) => mapProduct(e.node));
        setProducts(pageProducts);
        setProductPageInfo(data.products.pageInfo);
        // Merge this page into the persistent loaded-products map for client-side search.
        rememberProducts(pageProducts);
      }
    } catch (err: any) {
      if (productRequestRef.current.token === requestToken) {
        setProductError(err?.message || 'Failed to load products.');
      }
    } finally {
      if (productRequestRef.current.token === requestToken) {
        productRequestRef.current = { token: requestToken, pendingKey: null };
        setProductsLoading(false);
      }
    }
  };

  const fetchTemplates = async (): Promise<void> => {
    setTemplatesLoading(true);
    setTemplateError(null);
    try {
      const { list, error } = await readTemplatesFromShop();
      if (error) {
        setTemplateError(error);
      }
      // Display templates in creation order (the order they appear in the stored JSON array, newest
      // appended last). No alphabetical sort is applied.
      setTemplates(list);
    } catch (err: any) {
      setTemplateError(err?.message || 'Failed to load templates.');
    } finally {
      setTemplatesLoading(false);
    }
  };

  // Read all six shared saved selections. Every key is fixed, so no user identity is needed.
  //
  // Session 26: also RETURNS what it just parsed (not just the state setters it already calls) --
  // needed by openSelectionView (see its own comment), which awaits this and then needs the fresh
  // slot data immediately, in the SAME tick. Reading selectionEntries/selectionNotes/etc. from
  // component state right after `await`ing this would still see the PRE-refresh values: a state
  // setter schedules a re-render, it doesn't mutate the closure the awaiting function already
  // captured. Returns null on any error, matching the existing setSelectionsError-and-bail shape.
  const loadSelections = async (): Promise<{
    productEntries: Record<PublicSelectionSlotId, SelectionEntry[]>;
    noteEntries: Record<PublicSelectionSlotId, SelectionEntry[]>;
    slotOrderIndex: Record<PublicSelectionSlotId, Record<string, number>>;
    subtitles: Record<string, string>;
  } | null> => {
    setSelectionsError(null);
    try {
      const { data, errors } = await shopify.query(SELECTIONS_READ_QUERY, {
        variables: {
          ns: TEMPLATE_NAMESPACE,
          pub1: 'sel_public_1',
          pub2: 'sel_public_2',
          pub3: 'sel_public_3',
          pub4: 'sel_public_4',
          pub5: 'sel_public_5',
          pub6: 'sel_public_6',
          subs: SUBTITLES_KEY,
          hist: HISTORY_KEY,
          globals: GLOBALS_KEY,
        },
      });
      if (errors?.length) {
        setSelectionsError(errors.map((e: any) => e.message).join(', '));
        return null;
      }
      const shop = data?.shop;
      if (shop?.id) {
        shopIdRef.current = shop.id;
      }
      // Each slot's metafield holds ONE array mixing product entries and free-standing notes (see
      // SelectionEntry); parse it once per slot, then split by isStandaloneNote into the two
      // separate pieces of state the rest of the app reads (selectionEntries: products only,
      // selectionNotes: standalone notes only), since a product entry needs to be fetched by id
      // (loadProductsByIds) while a note entry never does.
      const bySlot: Record<string, SelectionEntry[]> = {
        public_1: parseSelectionItems(shop?.pub1?.value),
        public_2: parseSelectionItems(shop?.pub2?.value),
        public_3: parseSelectionItems(shop?.pub3?.value),
        public_4: parseSelectionItems(shop?.pub4?.value),
        public_5: parseSelectionItems(shop?.pub5?.value),
        public_6: parseSelectionItems(shop?.pub6?.value),
      };
      const productEntries: Record<string, SelectionEntry[]> = {};
      const noteEntries: Record<string, SelectionEntry[]> = {};
      // The stored array's own order (bySlot[slot]) already interleaves products and notes exactly
      // as they were last saved -- captured here, per id, so the selection view can render/reorder
      // them combined instead of two always-products-then-notes tables (session 8). This does NOT
      // change productEntries/noteEntries themselves (still split, same as before, since a product
      // entry needs to be fetched by id while a note entry never does) -- it's purely additional
      // ordering information alongside the existing split.
      const slotOrderIndex: Record<string, Record<string, number>> = {};
      for (const slot of PUBLIC_SLOTS) {
        productEntries[slot] = bySlot[slot].filter((e) => !isStandaloneNote(e));
        noteEntries[slot] = bySlot[slot].filter(isStandaloneNote);
        const orderIndex: Record<string, number> = {};
        bySlot[slot].forEach((e, i) => {
          orderIndex[e.id] = i;
        });
        slotOrderIndex[slot] = orderIndex;
      }
      const typedProductEntries = productEntries as Record<PublicSelectionSlotId, SelectionEntry[]>;
      const typedNoteEntries = noteEntries as Record<PublicSelectionSlotId, SelectionEntry[]>;
      const typedSlotOrderIndex = slotOrderIndex as Record<
        PublicSelectionSlotId,
        Record<string, number>
      >;
      const subtitles = parseSubtitles(shop?.subs?.value);
      setSelectionEntries(typedProductEntries);
      setSelectionNotes(typedNoteEntries);
      setSelectionSlotOrderIndex(typedSlotOrderIndex);
      setSelectionSubtitles(subtitles);
      setHistoryEntries(parseSelectionItems(shop?.hist?.value));
      setGlobalVars(parseGlobalVars(shop?.globals?.value));
      return {
        productEntries: typedProductEntries,
        noteEntries: typedNoteEntries,
        slotOrderIndex: typedSlotOrderIndex,
        subtitles,
      };
    } catch (err: any) {
      setSelectionsError(err?.message || 'Failed to load saved selections.');
      return null;
    }
  };

  useEffect(() => {
    const init = async (): Promise<void> => {
      await fetchTemplates();
      await fetchProducts(null, 'forward', '');
      await loadSelections();
    };
    init();
  }, []);

  const runSearch = (): void => {
    setAppliedSearch(productSearch);
    fetchProducts(null, 'forward', productSearch);
  };

  const handleNextProducts = (): void => {
    if (productPageInfo?.hasNextPage) {
      fetchProducts(productPageInfo.endCursor, 'forward', appliedSearch);
    }
  };

  const handlePrevProducts = (): void => {
    if (productPageInfo?.hasPreviousPage) {
      fetchProducts(productPageInfo.startCursor, 'backward', appliedSearch);
    }
  };

  // Re-read everything the app shows from Shopify: templates, saved selections and their subtitles,
  // and the current page of products for the applied search term. Selections made in the app are
  // preserved; only the loaded data is refreshed.
  const refreshAll = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetchTemplates();
      await loadSelections();
      await fetchProducts(null, 'forward', appliedSearch);
    } finally {
      setRefreshing(false);
    }
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: notes (current selection, in-memory)
  // --------------------------------------------------------------------------------------------
  // Open the note modal, pre-filling the text when opened from the search box.
  const openNoteModal = (initialText: string): void => {
    setNoteDraftText(initialText);
  };

  // Append the current product search text to the note being typed. The modal stays open, so the
  // merchant can keep editing; an empty search box changes nothing.
  const appendSearchToNote = (): void => {
    const searchText = productSearch.trim();
    if (searchText === '') return;
    setNoteDraftText((prev) => (prev.trim() === '' ? searchText : `${prev}\n${searchText}`));
  };

  // Save the typed text as a free-standing note entry on the Current Selection. Empty text creates
  // nothing.
  const saveNoteEntry = (): void => {
    const note = noteDraftText.trim();
    if (note === '') {
      setNoteDraftText('');
      return;
    }
    const entry = createNoteEntry(note);
    setNoteObjects((prev) => [...prev, entry]);
    setCurrentSelectionOrderIndex((prev: Record<string, number>) => ({
      ...prev,
      [entry.id]: nextSelectionOrderIndex(),
    }));
    setNoteDraftText('');
  };

  const discardNoteDraft = (): void => {
    setNoteDraftText('');
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: product selection & bulk-select
  // --------------------------------------------------------------------------------------------
  const toggleProduct = (product: ProductData, checked: boolean): void => {
    // Ignore a change event that reports the state the row is already in. A checkbox can re-emit
    // its change event when its checked property is re-applied during a re-render (which happens
    // when the table swaps to a page whose products are already selected), and reacting to that
    // echo would write state, re-render, and echo again in an endless loop.
    if (Boolean(selectedProducts[product.id]) === checked) {
      return;
    }
    // A manual row change means the selection no longer matches either bulk button.
    setBulkMode(null);
    setSelectedProducts((prev) => {
      const next = { ...prev };
      if (checked) {
        next[product.id] = product;
      } else {
        delete next[product.id];
      }
      return next;
    });
    if (checked) {
      setCurrentSelectionOrderIndex((prev: Record<string, number>) => ({
        ...prev,
        [product.id]: nextSelectionOrderIndex(),
      }));
    }
    // Unchecking a product on the main page deletes its note and its variant subset from the
    // current selection: neither exists once the product is no longer selected. A note or variant
    // subset already saved into a public selection is stored separately and is not affected.
    if (!checked) {
      setProductNotes((prev) => {
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
      setSelectedVariantIds((prev: Record<string, string[]>) => {
        if (!(product.id in prev)) return prev;
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
    }
  };

  // Store the note typed in a product's note bar. The note is never written to the product.
  const setProductNote = (productId: string, note: string): void => {
    setProductNotes((prev) => {
      // Re-applying the same text must not create a new map: an unchanged value would still be a
      // new object identity and would re-run every memo and effect that reads the notes.
      if ((prev[productId] || '') === note) {
        return prev;
      }
      return { ...prev, [productId]: note };
    });
  };

  // Toggle one variant of a selected product in/out of its checked subset. Unchecking the LAST
  // remaining checked variant is refused -- there would be nothing left to render for that product --
  // so at least one variant always stays selected.
  //
  // Ignores a change event that reports the state this specific variant is already in, the same
  // guard toggleProduct's own checkbox already needs (see its comment above): s-checkbox can
  // re-emit 'change' when its checked property is reapplied during a re-render triggered by some
  // OTHER checkbox's click, not just on a genuine user click on THIS one. Without this guard, that
  // echo would call this function again for a variant the merchant never touched -- previously
  // harmless for the "check" branch (already had its own no-op check below) but not for "uncheck",
  // which unconditionally re-filtered and wrote a new array every time. Reported symptom this fixes:
  // clicking one variant's checkbox also toggling an unrelated one (e.g. always the 3rd of 5).
  const toggleVariantChecked = (
    productId: string,
    allVariantIds: string[],
    variantId: string,
    checked: boolean,
  ): void => {
    setSelectedVariantIds((prev: Record<string, string[]>) => {
      const current =
        prev[productId] && prev[productId].length > 0 ? prev[productId] : allVariantIds;
      if (current.includes(variantId) === checked) return prev;
      const next = checked
        ? [...current, variantId]
        : current.filter((id: string) => id !== variantId);
      if (next.length === 0) return prev;
      return { ...prev, [productId]: next };
    });
  };

  // The products each bulk-select button targets: the CURRENT SERVER PAGE only (`products`), never
  // products that only show up in the table via the client-side metafield search union (see
  // displayedProducts above) -- so a button can never silently select something the merchant hasn't
  // scrolled to.
  const bulkTargets = (mode: BulkSelectMode): ProductData[] =>
    mode === 'shown' ? products : products.filter((p: ProductData) => (p.totalInventory ?? 0) > 0);

  const inStockDisplayedCount = bulkTargets('in-stock').length;

  // A bulk-select button LOOKS active whenever every product it currently targets is selected, no
  // matter how that happened: pressing the button, or ticking each row by hand. Paging or searching
  // brings up products that are not selected, so the button falls back to its default gray
  // appearance there and pressing it selects the new page's targets instead of deselecting them.
  const bulkActive = (mode: BulkSelectMode): boolean => {
    const targets = bulkTargets(mode);
    return targets.length > 0 && targets.every((p) => Boolean(selectedProducts[p.id]));
  };

  // Add or remove a list of products from the current selection.
  const setProductsSelected = (list: ProductData[], selected: boolean): void => {
    setSelectedProducts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const p of list) {
        if (selected) {
          if (!next[p.id]) {
            next[p.id] = p;
            changed = true;
          }
        } else if (next[p.id]) {
          delete next[p.id];
          changed = true;
        }
      }
      // Nothing actually changed: keep the previous object so downstream memos and the download
      // preparation effect are not restarted for no reason.
      return changed ? next : prev;
    });
    if (selected) {
      setCurrentSelectionOrderIndex((prev: Record<string, number>) => {
        const additions = list.filter((p) => !(p.id in prev));
        if (additions.length === 0) return prev;
        const next = { ...prev };
        for (const p of additions) next[p.id] = nextSelectionOrderIndex();
        return next;
      });
    }
  };

  // Toggle one of the two bulk-select buttons. Pressing the active button again clears exactly the
  // products it selected; pressing the other button first clears the active button's products, so
  // only one button is ever active.
  const toggleBulkSelect = (mode: BulkSelectMode): void => {
    if (bulkActive(mode)) {
      setProductsSelected(bulkTargets(mode), false);
      setBulkMode(null);
      return;
    }
    if (bulkMode && bulkMode !== mode && bulkActive(bulkMode)) {
      setProductsSelected(bulkTargets(bulkMode), false);
    }
    setProductsSelected(bulkTargets(mode), true);
    setBulkMode(mode);
  };

  const clearProductSelection = (): void => {
    setBulkMode(null);
    setSelectedProducts({});
    setProductNotes({});
    setSelectedVariantIds({});
    // Session 24, per explicit direction: "Clear Product Selection" also clears the Current
    // Selection's free-standing notes -- previously left untouched, so a note typed on the home
    // page would silently survive a clear and still get bundled into the next download.
    setNoteObjects([]);
    // No need to touch currentSelectionOrderIndex: it's only ever consulted for ids that are
    // actually present in selectedProducts/noteObjects (the real source of truth for what's
    // selected), so a now-cleared product's leftover entry there is inert, not stale-and-wrong.
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: template list & editor navigation
  // --------------------------------------------------------------------------------------------
  const clearTemplateSelection = (): void => {
    setSelectedTemplateId(null);
  };

  const openNewTemplate = (): void => {
    setEditingTemplate(null);
    setEditorTitle('');
    setEditorBody('');
    setEditorExtension('txt');
    setEditorFileBreak('variant');
    setEditorMergeCondition('');
    setEditorTitleError(null);
    setEditorFileBreakError(null);
    setEditorError(null);
    originalEditorRef.current = {
      title: '',
      body: '',
      extension: 'txt',
      fileBreak: 'variant',
      mergeCondition: '',
    };
    setView('editor');
  };

  const openEditTemplate = (tpl: TemplateData): void => {
    setEditingTemplate(tpl);
    setEditorTitle(tpl.title);
    setEditorBody(tpl.body);
    setEditorExtension(tpl.extension || 'txt');
    // `tpl.fileBreak` may be null (never explicitly chosen -- see TemplateData.fileBreak); left as
    // null here rather than substituted with a guess, so the dropdown visibly shows "not set".
    setEditorFileBreak(tpl.fileBreak);
    setEditorMergeCondition(tpl.mergeCondition);
    setEditorTitleError(null);
    setEditorFileBreakError(null);
    setEditorError(null);
    originalEditorRef.current = {
      title: tpl.title,
      body: tpl.body,
      extension: tpl.extension || 'txt',
      fileBreak: tpl.fileBreak,
      mergeCondition: tpl.mergeCondition,
    };
    setView('editor');
  };

  // Insert a chosen variable token into the body by replacing ALL occurrences of the
  // `{{ insert }}` placeholder with the token. If the body contains no placeholder, the token is
  // appended to the end of the body instead.
  const insertVariable = (token: string): void => {
    setEditorBody((prev) => {
      if (INSERT_PLACEHOLDER_REGEX.test(prev)) {
        return prev.replace(INSERT_PLACEHOLDER_REGEX, () => token);
      }
      return prev.length > 0 ? prev + token : token;
    });
  };

  // Session 26, per explicit direction ("exiting a menu should refresh the templates and
  // products"): re-reads the template list and the current page of the product browser on the way
  // back out of a sub-page, so edits made elsewhere while it was open (a template saved from another
  // staff login, a product's title/price changed) aren't left stale until the next full "Refresh
  // Page" click. Deliberately NOT awaited by its callers below -- the back navigation itself happens
  // immediately; this fills in once it resolves, the same way `fetchTemplates`/`fetchProducts`
  // already re-render on completion everywhere else they're called.
  const refreshTemplatesAndProducts = (): void => {
    fetchTemplates();
    fetchProducts(null, 'forward', appliedSearch);
  };

  const backToMain = (): void => {
    setView('main');
    setEditorError(null);
    refreshTemplatesAndProducts();
  };

  // Settings page: reached from the gear button on the main page's header-actions row. The right
  // 1/3 (Settings itself) is blank for now, per explicit direction; the left 2/3 (History) hydrates
  // full ProductData for its product-type entries on open, the same way openSelectionView already
  // does for a public slot -- historyEntries itself (raw stored entries) is already kept loaded at
  // all times (loadSelections/refreshAll), so only the product HYDRATION is deferred to here.
  const openSettings = async (): Promise<void> => {
    setView('settings');
    setHistorySearch('');
    setHistoryError(null);
    const productIds = historyEntries
      .filter((e: SelectionEntry) => !isStandaloneNote(e))
      .map((e: SelectionEntry) => e.id);
    if (productIds.length === 0) {
      setHistoryProducts([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const { products, error } = await loadProductsByIds(productIds);
      if (error) {
        setHistoryError(error);
        setHistoryProducts([]);
        return;
      }
      setHistoryProducts(products);
    } catch (err: any) {
      setHistoryError(err?.message || 'Failed to load history.');
    } finally {
      setHistoryLoading(false);
    }
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: global variables (session 23)
  // Reached from Settings ("Global Vars" button, below the Syntax Guide link). Unlike the Selection
  // view's own table, list-level actions (delete, reorder) commit immediately -- there is no
  // separate list-level Save/draft concept here, matching the Templates list's own no-draft,
  // immediate-commit model (delete-with-confirm, pin-toggle both write straight through). Only the
  // per-entry EDIT POPUP has its own draft (title + body), saved/discarded independently, mirroring
  // the "Add Blank Note" popup's own Save/Clear/Discard shape.
  // --------------------------------------------------------------------------------------------
  const openGlobalVarsPage = (): void => {
    setView('globals');
    setGlobalVarSearch('');
    setGlobalVarError(null);
  };

  const backFromGlobalVars = (): void => {
    setView('settings');
    refreshTemplatesAndProducts();
  };

  // Open the edit popup for an existing global (entry given) or a brand-new one (null).
  const openGlobalVarModal = (entry: GlobalVarEntry | null): void => {
    setEditingGlobalVarId(entry ? entry.id : null);
    setGlobalVarTitleDraft(entry ? entry.title : '');
    setGlobalVarBodyDraft(entry ? entry.body : '');
    setGlobalVarTitleError(null);
  };

  // Clear both draft fields without closing the popup -- mirrors the note modal's own "Clear note".
  const clearGlobalVarDraft = (): void => {
    setGlobalVarTitleDraft('');
    setGlobalVarBodyDraft('');
    setGlobalVarTitleError(null);
  };

  const saveGlobalVarEntry = async (): Promise<void> => {
    const title = globalVarTitleDraft.trim();
    if (title === '') {
      setGlobalVarTitleError('Title is required');
      return;
    }
    // The title becomes the NAME half of `{{ $global:NAME }}` -- it must be a valid identifier
    // shape (same character rule every other variable name in this file already follows -- see
    // IDENTIFIER_REGEX's own comment for exactly which characters are structurally meaningful
    // inside a token and therefore excluded) or the reference syntax itself would be broken/
    // ambiguous.
    if (!IDENTIFIER_REGEX.test(title)) {
      setGlobalVarTitleError(
        'Title can’t contain spaces or the characters { } . = < > ! & | , ( )',
      );
      return;
    }
    const duplicate = globalVars.some(
      (g: GlobalVarEntry) => g.title === title && g.id !== editingGlobalVarId,
    );
    if (duplicate) {
      setGlobalVarTitleError('A global variable with this title already exists');
      return;
    }
    setGlobalVarTitleError(null);
    setGlobalVarError(null);
    setGlobalVarSaving(true);
    try {
      const savedId = editingGlobalVarId || generateGlobalVarId();
      const body = globalVarBodyDraft;
      await mutateGlobalVars((current: GlobalVarEntry[]) => {
        const existingIndex = current.findIndex((g: GlobalVarEntry) => g.id === savedId);
        const savedEntry: GlobalVarEntry = { id: savedId, title, body };
        return existingIndex >= 0
          ? current.map((g: GlobalVarEntry) => (g.id === savedId ? savedEntry : g))
          : [...current, savedEntry];
      }, setGlobalVarError);
      setEditingGlobalVarId(null);
      setGlobalVarTitleDraft('');
      setGlobalVarBodyDraft('');
    } finally {
      setGlobalVarSaving(false);
    }
  };

  const deleteGlobalVar = (id: string): void => {
    setGlobalVarError(null);
    mutateGlobalVars(
      (current: GlobalVarEntry[]) => current.filter((g: GlobalVarEntry) => g.id !== id),
      setGlobalVarError,
    );
  };

  // Move one global variable up or down by a single position in the stored order -- a plain array
  // reorder (unlike the Selection view's combined-rows order-index map, a global-variables list has
  // only one kind of row, so there's nothing to interleave and no need for that extra indirection).
  const moveGlobalVar = (id: string, offset: number): void => {
    setGlobalVarError(null);
    mutateGlobalVars((current: GlobalVarEntry[]) => {
      const index = current.findIndex((g: GlobalVarEntry) => g.id === id);
      const target = index + offset;
      if (index === -1 || target < 0 || target >= current.length) {
        return current;
      }
      const reordered = [...current];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      return reordered;
    }, setGlobalVarError);
  };

  // The list the Global Vars page actually renders: filtered by title OR body against the search
  // term, same case-insensitive substring rule every other search in this app already uses.
  const globalVarsFiltered = useMemo<GlobalVarEntry[]>(() => {
    const term = globalVarSearch.trim().toLowerCase();
    if (term === '') return globalVars;
    return globalVars.filter(
      (g: GlobalVarEntry) =>
        g.title.toLowerCase().includes(term) || g.body.toLowerCase().includes(term),
    );
  }, [globalVars, globalVarSearch]);

  // Whether the edit popup, as currently opened, is for a NEW global variable (never opened via an
  // existing entry) -- used only to pick the modal's heading. `s-modal`'s own `--show`/`--hide`
  // commands drive actual visibility; `openGlobalVarModal` only decides which draft it shows.
  const isNewGlobalVar = editingGlobalVarId === null;

  // Whether the editor has unsaved changes compared to the values when it was opened.
  const hasUnsavedChanges = (): boolean => {
    const orig = originalEditorRef.current;
    return (
      editorTitle !== orig.title ||
      editorBody !== orig.body ||
      editorExtension !== orig.extension ||
      editorFileBreak !== orig.fileBreak ||
      editorMergeCondition !== orig.mergeCondition
    );
  };

  // Confirm leaving from the unsaved-changes modal: navigate back to the main view.
  const confirmLeave = (): void => {
    backToMain();
  };

  const saveTemplate = async (): Promise<void> => {
    if (!editorTitle.trim()) {
      setEditorTitleError('Title is required');
      return;
    }
    // Session 7, per explicit direction: fileBreak must be explicitly chosen -- a null value is
    // never inferred or silently defaulted at save time, same enforcement as the Title field above.
    if (editorFileBreak === null) {
      setEditorFileBreakError('Choose a file break before saving');
      return;
    }
    setEditorTitleError(null);
    setEditorFileBreakError(null);
    setEditorError(null);
    setSaving(true);
    // Captured before the mutation below (which doesn't itself touch editingTemplate) -- true only
    // for a genuinely new template, matching the exact same condition the editor's own heading
    // ("New template" vs "Edit template") already uses. An edit to an existing template is not
    // logged -- only creation and destruction (confirmDelete) are, per explicit direction.
    const isNewTemplate = !editingTemplate;
    try {
      const savedId = editingTemplate ? editingTemplate.id : generateTemplateId(editorTitle);
      const nextList = await mutateTemplateList((currentList) => {
        const existingIndex = currentList.findIndex((t) => t.id === savedId);
        const savedTemplate: TemplateData = {
          id: savedId,
          title: editorTitle,
          body: editorBody,
          extension: sanitizeExtension(editorExtension),
          // Editing a template never changes its pinned state or when it was pinned.
          pinned: existingIndex >= 0 ? currentList[existingIndex].pinned === true : false,
          pinnedAt: existingIndex >= 0 ? (currentList[existingIndex].pinnedAt ?? null) : null,
          fileBreak: editorFileBreak,
          mergeCondition: editorMergeCondition,
        };
        return existingIndex >= 0
          ? currentList.map((t) => (t.id === savedTemplate.id ? savedTemplate : t))
          : [...currentList, savedTemplate];
      }, setEditorError);
      if (!nextList) {
        return;
      }
      await fetchTemplates();
      originalEditorRef.current = {
        title: editorTitle,
        body: editorBody,
        extension: editorExtension,
        fileBreak: editorFileBreak,
        mergeCondition: editorMergeCondition,
      };
      if (isNewTemplate) {
        const text = `Template {{ template_title=${editorTitle}, action=created, date=${historyDate(new Date())} }}`;
        mutateHistory((current) => appendHistoryLogNote(current, text));
      }
      setView('main');
    } catch (err: any) {
      setEditorError(err?.message || 'Failed to save template.');
    } finally {
      setSaving(false);
    }
  };

  // Flip the pinned flag of one template and persist the whole list. The stored list is re-read
  // immediately before writing so a concurrent edit by another staff member is preserved.
  const togglePin = async (template: TemplateData): Promise<void> => {
    setPinError(null);
    setPinningId(template.id);
    try {
      // Pinning records the current time so the pinned group can sort most-recently-pinned first;
      // unpinning clears it.
      const pinnedNow = Date.now();
      const nextList = await mutateTemplateList(
        (currentList) =>
          currentList.map((t) => {
            if (t.id !== template.id) {
              return t;
            }
            const nextPinned = !(t.pinned === true);
            return { ...t, pinned: nextPinned, pinnedAt: nextPinned ? pinnedNow : null };
          }),
        setPinError,
      );
      if (!nextList) {
        return;
      }
      await fetchTemplates();
    } catch (err: any) {
      setPinError(err?.message || 'Failed to update the pinned template.');
    } finally {
      setPinningId(null);
    }
  };

  // --------------------------------------------------------------------------------------------
  // Handlers: delete-template modal
  // --------------------------------------------------------------------------------------------
  const openDeleteModal = (id: string): void => {
    setPendingDeleteId(id);
    setDeleteError(null);
  };

  const cancelDelete = (): void => {
    setPendingDeleteId(null);
    setDeleteError(null);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDeleteId) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      const deleteId = pendingDeleteId;
      // Looked up before the mutation removes it from `templates` -- confirmDelete's own list
      // still has it, since fetchTemplates hasn't re-run yet.
      const deletedTitle =
        templates.find((t: TemplateData) => t.id === deleteId)?.title || deleteId;
      const nextList = await mutateTemplateList(
        (currentList) => currentList.filter((t) => t.id !== deleteId),
        setDeleteError,
      );
      if (!nextList) {
        return;
      }
      if (selectedTemplateId === pendingDeleteId) {
        setSelectedTemplateId(null);
      }
      // Session 24: deleting from the NEW editor-header delete button (as opposed to the template
      // list's own menu action) means the template just deleted is the one currently open here --
      // nothing left to edit, so return to the main view the same way Back does.
      if (view === 'editor' && editingTemplate?.id === pendingDeleteId) {
        backToMain();
      }
      setPendingDeleteId(null);
      setDeleteError(null);
      const text = `Template {{ template_title=${deletedTitle}, action=destroyed, date=${historyDate(new Date())} }}`;
      mutateHistory((current) => appendHistoryLogNote(current, text));
      await fetchTemplates();
    } catch (err: any) {
      setDeleteError(err?.message || 'Failed to delete template.');
    } finally {
      setDeleting(false);
    }
  };

  // --------------------------------------------------------------------------------------------
  // Derived view data: template list grouping, metafield tokens, storage label
  // --------------------------------------------------------------------------------------------
  // The ordered template list to render, plus the index of the row that the pinned / unpinned
  // separator is drawn immediately above (-1 when no separator should appear).
  const templateGroups = useMemo<{ list: TemplateData[]; dividerIndex: number }>(() => {
    const term = templateSearch.trim().toLowerCase();
    const matched = !term
      ? templates
      : templates.filter(
          (t) =>
            t.title.toLowerCase().includes(term) ||
            sanitizeExtension(t.extension).toLowerCase().includes(term),
        );
    // Templates are stored in creation order (oldest first, newest appended last), so 'old-new'
    // keeps that order as-is and 'new-old' reverses it.
    const applySelectedSort = (list: TemplateData[]): TemplateData[] => {
      const sorted = [...list];
      if (templateSort === 'new-old') {
        sorted.reverse();
      } else if (templateSort === 'a-z') {
        sorted.sort((a, b) => a.title.localeCompare(b.title));
      } else if (templateSort === 'z-a') {
        sorted.sort((a, b) => b.title.localeCompare(a.title));
      }
      return sorted;
    };
    // While a search term is active, pinning is ignored so a pinned template behaves exactly like
    // any other template, and no separator is drawn.
    if (term) {
      return { list: applySelectedSort(matched), dividerIndex: -1 };
    }
    // Pinned templates ALWAYS sort by when they were pinned, most recent first, regardless of the
    // selected sort order. A template pinned before the timestamp was recorded has no `pinnedAt`
    // and sorts to the bottom of the pinned group.
    const pinned = matched
      .filter((t) => t.pinned === true)
      .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    // The selected sort order applies to the unpinned templates only.
    const unpinned = applySelectedSort(matched.filter((t) => t.pinned !== true));
    return {
      list: [...pinned, ...unpinned],
      dividerIndex: pinned.length > 0 && unpinned.length > 0 ? pinned.length : -1,
    };
  }, [templates, templateSearch, templateSort]);

  // Always show the union of metafields across ALL currently loaded products, regardless of selection,
  // so every known metafield key is available to insert.
  const metafieldTokens = useMemo(() => {
    const seen = new Set<string>();
    const list: { token: string; label: string }[] = [];
    for (const p of products) {
      for (const mf of p.metafields) {
        const id = `${mf.namespace}.${mf.key}`;
        if (!seen.has(id)) {
          seen.add(id);
          list.push({
            token: `{{ product.metafield.${mf.namespace}.${mf.key} }}`,
            label: `${mf.namespace}.${mf.key}`,
          });
        }
      }
    }
    return list;
  }, [products]);

  // Storage indicator shown next to the Templates heading. It packs the CURRENT template list into
  // shards exactly the way a save would, counts how many of the SHARD_COUNT shards hold data, and
  // reports the share of shards still completely free. Because it is derived from `templates`, it
  // recomputes automatically whenever a template is added, edited, or deleted.
  const storageLabel = useMemo(() => {
    const { shards, overflow } = packTemplatesIntoShards(templates);
    const usedShards = overflow ? SHARD_COUNT : shards.filter((shard) => shard.length > 0).length;
    const freeShards = SHARD_COUNT - usedShards;
    const stepPercent = Math.round(100 / SHARD_COUNT);
    if (usedShards === 0) {
      return '( 100 % Template Storage Free )';
    }
    if (freeShards === 0) {
      return `( 0-${stepPercent}% Templates Free )`;
    }
    return `( ${freeShards * stepPercent}-${(freeShards + 1) * stepPercent}% Templates Free )`;
  }, [templates]);

  // --------------------------------------------------------------------------------------------
  // Download preparation
  // --------------------------------------------------------------------------------------------
  // Session 26, per explicit direction ("if a template has no variables, then a template can be
  // downloaded without products in the selection" -- refined to also require the body not
  // reference any per-object data, and to require 'selection' fileBreak regardless of that check).
  // 'selection' fileBreak is the one mode where the whole template renders as a single (or
  // Merge-IF-grouped) document, not one file per selected object -- but fileBreak alone is not a
  // sufficient check: see templateNeedsSelectionObjects' own comment for exactly why an empty
  // selection can outright THROW for some of these tokens (selection.first/last/curr especially),
  // not just render blank. Only a 'selection'-mode template whose body needs no per-object data at
  // all is offered this relaxation; the four per-unit modes ('variant'/'product'/'note'/'object')
  // are unaffected either way -- there is nothing to loop over with zero objects regardless of what
  // the body contains, so they still require a non-empty selection.
  const emptySelectionDownloadable =
    selectedTemplate?.fileBreak === 'selection' &&
    !templateNeedsSelectionObjects(selectedTemplate.body);
  const canDownload =
    (selectedProductList.length > 0 || noteObjects.length > 0 || emptySelectionDownloadable) &&
    selectedTemplate !== null;

  // Reactively compute the download href + filename from the current selection so a single click on
  // the download link downloads the file(s) directly (browser-native), with no separate generate step.
  // The sandbox cannot programmatically trigger a download, so the merchant's own click on the link
  // fires the download; the same click also opens a confirmation popup. If building the content
  // throws, the error is captured here and surfaced via a critical banner, and no link is rendered.
  useEffect(() => {
    const buildId = downloadBuildRef.current + 1;
    downloadBuildRef.current = buildId;
    setDownload(null);
    setDownloadFailed(false);
    if (
      !selectedTemplate ||
      (selectedProductList.length === 0 && noteObjects.length === 0 && !emptySelectionDownloadable)
    ) {
      setDownloadProgress(null);
      return;
    }
    const tpl = selectedTemplate;
    const prepare = async (): Promise<void> => {
      try {
        // A single Date captured once for this download, so every generated file shares the same date.
        const plan = planOutputFiles(
          tpl.title,
          tpl.body,
          tpl.extension,
          selectedProductList,
          noteObjects,
          tpl.fileBreak,
          tpl.mergeCondition,
          primaryDomain,
          new Date(),
          globalBodiesByTitle,
        );
        setDownloadProgress({ done: 0, total: plan.count, packaging: false });
        const files: ZipEntry[] = [];
        for (let index = 0; index < plan.count; index++) {
          files.push(plan.build(index));
          if (downloadBuildRef.current !== buildId) return;
          setDownloadProgress({ done: index + 1, total: plan.count, packaging: false });
          // Give the browser a chance to paint the progress banner between files.
          await yieldToBrowser();
          if (downloadBuildRef.current !== buildId) return;
        }
        if (files.length === 0) {
          setDownloadProgress(null);
          return;
        }
        // History (session 17/18): which object(s) each just-built file actually reads (deduped
        // per file -- see FilePlan.sourceIdsByIndex's own comment on why one file's list can
        // otherwise repeat an id), turned into one {{ file=NAME, folder=FOLDER }} touch per object,
        // seeded with that object's OWN current note (used only if this is its first-ever
        // appearance in History -- see HistoryTouch's comment). `folder` names the ZIP a
        // multi-file download packages its files into (the name a merchant sees after extracting
        // it, so the trailing ".zip" is stripped) -- empty when this download produced a single,
        // unzipped file (plan.zipName is null then), per explicit direction. Captured here, at
        // BUILD time, but not written to History until the merchant actually clicks the download
        // link (onDownloadClick) -- this effect runs reactively on every selection/template change,
        // long before any real download happens, so logging here instead would log far more often
        // than an actual download occurs.
        if (downloadBuildRef.current === buildId) {
          const folderName = plan.zipName ? plan.zipName.replace(/\.zip$/i, '') : '';
          const fileNameByObjectId = new Map<string, string>();
          for (let index = 0; index < files.length; index++) {
            const ids = new Set(plan.sourceIdsByIndex[index] || []);
            for (const id of ids) fileNameByObjectId.set(id, files[index].name);
          }
          const noteById = new Map<string, string>();
          for (const p of selectedProductList) noteById.set(p.id, p.note || '');
          for (const n of noteObjects) noteById.set(n.id, n.note);
          pendingDownloadTouchesRef.current = Array.from(fileNameByObjectId.entries()).map(
            ([id, fileName]): HistoryTouch => ({
              id,
              baseNote: noteById.get(id) || '',
              tag: `{{ file=${fileName}, folder=${folderName} }}`,
            }),
          );
        }
        if (plan.zipName == null) {
          const single = files[0];
          const mediaType = mediaTypeForExtension(sanitizeExtension(tpl.extension));
          setDownload({
            href: `data:${mediaType};charset=utf-8,${encodeURIComponent(single.content)}`,
            name: single.name,
            isZip: false,
          });
          setDownloadProgress(null);
          return;
        }
        setDownloadProgress({ done: plan.count, total: plan.count, packaging: true });
        await yieldToBrowser();
        if (downloadBuildRef.current !== buildId) return;
        const base64 = buildZipBase64(files);
        if (downloadBuildRef.current !== buildId) return;
        setDownload({
          href: `data:application/zip;base64,${base64}`,
          name: plan.zipName,
          isZip: true,
        });
        setDownloadProgress(null);
      } catch {
        if (downloadBuildRef.current !== buildId) return;
        setDownloadFailed(true);
        setDownloadProgress(null);
      }
    };
    prepare();
  }, [selectedTemplate, selectedProductList, noteObjects, primaryDomain, globalBodiesByTitle]);

  // Whether the current selection is valid but the content could not be built.
  const downloadBuildFailed = canDownload && downloadFailed;
  const preparingDownload = downloadProgress !== null;

  // Called on the same click that fires the browser download: record the filename for the
  // confirmation popup so the modal can confirm exactly what was downloaded.
  const onDownloadClick = (): void => {
    if (!download) return;
    setConfirmedName(download.name);
    // History (session 17): only actual downloads are logged, never a preview -- see
    // pendingDownloadTouchesRef's own comment for why this is captured at build time but only
    // written here, on the real click.
    if (pendingDownloadTouchesRef.current.length > 0) {
      const touches = pendingDownloadTouchesRef.current;
      mutateHistory((current) => applyHistoryTouches(current, touches));
    }
  };

  // --------------------------------------------------------------------------------------------
  // Preview
  // --------------------------------------------------------------------------------------------
  // Preview: build the same file set the download would produce, but from the CURRENT (possibly
  // unsaved) editor values, so a template can be checked before it is saved.
  // Session 26: same "'selection' mode, body needs no per-object data" relaxation as
  // emptySelectionDownloadable above, but against the EDITOR's own live fileBreak/body (not
  // yet-saved) since this is the in-editor preview -- see templateNeedsSelectionObjects' own
  // comment for why the body check matters, not just fileBreak.
  const previewEmptySelectionDownloadable =
    editorFileBreak === 'selection' && !templateNeedsSelectionObjects(editorBody);

  const preview = useMemo<{ files: ZipEntry[]; failed: boolean }>(() => {
    if (
      selectedProductList.length === 0 &&
      noteObjects.length === 0 &&
      !previewEmptySelectionDownloadable
    ) {
      return { files: [], failed: false };
    }
    try {
      const output = buildOutputFiles(
        editorTitle,
        editorBody,
        editorExtension,
        selectedProductList,
        noteObjects,
        editorFileBreak,
        editorMergeCondition,
        primaryDomain,
        new Date(),
        globalBodiesByTitle,
      );
      return { files: output.files, failed: false };
    } catch {
      return { files: [], failed: true };
    }
  }, [
    editorTitle,
    editorBody,
    editorExtension,
    editorFileBreak,
    editorMergeCondition,
    selectedProductList,
    noteObjects,
    primaryDomain,
    globalBodiesByTitle,
  ]);

  // Clamp the page index so a changed selection can never point past the last generated file.
  const previewPage =
    preview.files.length === 0 ? 0 : Math.min(previewIndex, preview.files.length - 1);
  const canPreview =
    selectedProductList.length > 0 || noteObjects.length > 0 || previewEmptySelectionDownloadable;

  const openPreview = (): void => {
    setPreviewIndex(0);
  };

  const showPreviousPreviewFile = (): void => {
    setPreviewIndex(previewPage > 0 ? previewPage - 1 : 0);
  };

  const showNextPreviewFile = (): void => {
    setPreviewIndex(previewPage < preview.files.length - 1 ? previewPage + 1 : previewPage);
  };

  // --- Saved selections ------------------------------------------------------------------------
  // Fetch full product data for a list of stored product GIDs, reusing anything already loaded this
  // session and fetching the rest with `nodes` in chunks. Ids that no longer resolve to a product
  // (deleted products) are reported through the `missing` flag.
  const loadProductsByIds = async (
    ids: string[],
  ): Promise<{ products: ProductData[]; missing: boolean; error: string | null }> => {
    const found: Record<string, ProductData> = {};
    const toFetch: string[] = [];
    for (const id of ids) {
      const cached = loadedProductsRef.current.byId[id];
      if (cached) {
        found[id] = cached;
      } else {
        toFetch.push(id);
      }
    }
    for (let start = 0; start < toFetch.length; start += SELECTION_FETCH_CHUNK) {
      const chunk = toFetch.slice(start, start + SELECTION_FETCH_CHUNK);
      const { data, errors } = await shopify.query(PRODUCTS_BY_IDS_QUERY, {
        variables: { ids: chunk },
      });
      if (errors?.length) {
        return {
          products: [],
          missing: false,
          error: errors.map((e: any) => e.message).join(', '),
        };
      }
      const fetched: ProductData[] = (data?.nodes || [])
        .filter((node: any) => node && node.id)
        .map((node: any) => mapProduct(node));
      rememberProducts(fetched);
      for (const p of fetched) {
        found[p.id] = p;
      }
    }
    const products: ProductData[] = [];
    for (const id of ids) {
      if (found[id]) products.push(found[id]);
    }
    return { products, missing: products.length < ids.length, error: null };
  };

  // Open a selection's full-page view. "Current Selection" starts from the live product selection;
  // a saved slot loads its stored product ids.
  const openSelectionView = async (slot: SelectionSlotId): Promise<void> => {
    setSelectionSlot(slot);
    setSelectionSearch('');
    setSelectionError(null);
    setSelectionMissing(false);
    // Subset checkboxes always start empty: opening a selection selects nothing by default.
    setCheckedSelectionProducts({});
    setCheckedSelectionNotes({});
    setView('selection');
    if (slot === 'current') {
      setSelectionDraft(selectedProductList);
      setSelectionNoteDraft(noteObjects);
      setSelectionViewOrderIndex(currentSelectionOrderIndex);
      setSelectionBaseline(selectionSignature(selectedProductList, noteObjects));
      setSubtitleDraft('');
      setSubtitleBaseline('');
      return;
    }
    setSelectionLoading(true);
    try {
      // Session 26, per explicit direction ("opening a selection should refresh it" /
      // "refresh doesn't work in a selection"): re-read the selection metafields fresh every time a
      // public slot is opened, instead of trusting whatever selectionEntries/selectionNotes already
      // held in memory -- otherwise a change saved from another browser tab or staff login (or just
      // this session's own stale copy) stayed invisible until the next full "Refresh Page" click.
      // loadSelections returns what it just parsed for exactly this reason (see its own comment) --
      // reading selectionEntries[slot] etc. right after awaiting it would still see the PRE-refresh
      // state. Falls back to the existing (stale) state only if the re-read itself failed, so a
      // transient network error still shows *something* rather than an empty page.
      const fresh = await loadSelections();
      const storedEntries = fresh ? fresh.productEntries[slot] || [] : selectionEntries[slot] || [];
      const storedNotes = fresh ? fresh.noteEntries[slot] || [] : selectionNotes[slot] || [];
      setSelectionNoteDraft(storedNotes);
      setSelectionViewOrderIndex(
        fresh ? fresh.slotOrderIndex[slot] || {} : selectionSlotOrderIndex[slot] || {},
      );
      const storedSubtitle = fresh ? fresh.subtitles[slot] || '' : selectionSubtitles[slot] || '';
      setSubtitleDraft(storedSubtitle);
      setSubtitleBaseline(storedSubtitle);
      const { products, missing, error } = await loadProductsByIds(storedEntries.map((e) => e.id));
      if (error) {
        setSelectionError(error);
        setSelectionDraft([]);
        setSelectionBaseline('');
        return;
      }
      // Attach each product's stored note and variant subset so the selection carries its own notes
      // and its own narrowed variant selection.
      const noteById: Record<string, string> = {};
      const variantIdsById: Record<string, string[] | undefined> = {};
      for (const entry of storedEntries) {
        noteById[entry.id] = entry.note;
        variantIdsById[entry.id] = entry.variantIds;
      }
      const withNotes = products.map((p) =>
        narrowToSelectedVariants({ ...p, note: noteById[p.id] || '' }, variantIdsById[p.id]),
      );
      setSelectionDraft(withNotes);
      // The baseline is what actually loaded, so skipped (deleted) products do not look like an
      // unsaved edit; saving simply prunes them.
      setSelectionBaseline(selectionSignature(withNotes, storedNotes));
      setSelectionMissing(missing);
    } catch (err: any) {
      setSelectionError(err?.message || 'Failed to load this selection.');
    } finally {
      setSelectionLoading(false);
    }
  };

  // Refresh button on the selection editor page: re-reads this same slot the same way opening it
  // fresh from the Selections menu would (live app state for "current," a genuine re-fetch of the
  // stored metafield -- via loadSelections, session 26 -- for a public slot) -- so it also discards
  // any not-yet-saved edits in the draft, same as reloading any other page would. selectionLoading
  // (already set by openSelectionView for public slots) doubles as this button's own loading/
  // disabled state.
  const refreshSelectionView = (): void => {
    if (selectionSlot) {
      openSelectionView(selectionSlot);
    }
  };

  const selectionDraftSignature = useMemo(
    () => selectionSignature(selectionDraft, selectionNoteDraft),
    [selectionDraft, selectionNoteDraft],
  );

  // Edit one free-standing note entry's text inside the open selection's working draft.
  const setSelectionDraftNoteContent = (noteId: string, note: string): void => {
    setSelectionNoteDraft((prev) => {
      const current = prev.find((n) => n.id === noteId);
      if (!current || current.note === note) {
        return prev;
      }
      return prev.map((n) => (n.id === noteId ? { ...n, note } : n));
    });
  };

  // Remove ONE note object from the open selection's working draft.
  const removeNoteFromDraft = (noteId: string): void => {
    setSelectionError(null);
    setSelectionNoteDraft((prev) => prev.filter((n) => n.id !== noteId));
  };

  // Whether the open selection is one of the saved public slots (the subset checkboxes and the
  // Select All control are only offered there, not in the in-memory Current Selection).
  const isPublicSelection = selectionSlot !== null && selectionSlot !== 'current';

  const checkedDraftProducts = selectionDraft.filter((p) => checkedSelectionProducts[p.id]);
  const checkedDraftNotes = selectionNoteDraft.filter((n) => checkedSelectionNotes[n.id]);
  const checkedItemCount = checkedDraftProducts.length + checkedDraftNotes.length;
  const allSelectionItemsChecked =
    selectionDraft.length + selectionNoteDraft.length > 0 &&
    checkedItemCount === selectionDraft.length + selectionNoteDraft.length;

  const setSelectionProductChecked = (productId: string, checked: boolean): void => {
    setCheckedSelectionProducts((prev) => {
      if (Boolean(prev[productId]) === checked) return prev;
      const next = { ...prev };
      if (checked) {
        next[productId] = true;
      } else {
        delete next[productId];
      }
      return next;
    });
  };

  const setSelectionNoteChecked = (noteId: string, checked: boolean): void => {
    setCheckedSelectionNotes((prev) => {
      if (Boolean(prev[noteId]) === checked) return prev;
      const next = { ...prev };
      if (checked) {
        next[noteId] = true;
      } else {
        delete next[noteId];
      }
      return next;
    });
  };

  // Check EVERY item in the full draft (products and note objects), regardless of any active search
  // filter. When everything is already checked, the same control clears all the checkboxes.
  const toggleSelectAllInSelection = (): void => {
    if (allSelectionItemsChecked) {
      setCheckedSelectionProducts({});
      setCheckedSelectionNotes({});
      return;
    }
    const nextProducts: Record<string, boolean> = {};
    for (const p of selectionDraft) {
      nextProducts[p.id] = true;
    }
    const nextNotes: Record<string, boolean> = {};
    for (const n of selectionNoteDraft) {
      nextNotes[n.id] = true;
    }
    setCheckedSelectionProducts(nextProducts);
    setCheckedSelectionNotes(nextNotes);
  };

  const hasSelectionUnsavedChanges = (): boolean =>
    selectionDraftSignature !== selectionBaseline || subtitleDraft !== subtitleBaseline;

  // Edit one product's note inside the open selection's working draft.
  const setSelectionDraftNote = (productId: string, note: string): void => {
    setSelectionDraft((prev) => {
      const current = prev.find((p) => p.id === productId);
      if (!current || (current.note || '') === note) {
        return prev;
      }
      return prev.map((p) => (p.id === productId ? { ...p, note } : p));
    });
  };

  // Merge the products selected on the main page into this selection's draft, de-duplicated by id.
  // The main page's own selection is left untouched.
  const addMainSelectionToDraft = (): void => {
    setSelectionError(null);
    const existing = new Set(selectionDraft.map((p) => p.id));
    const additions = selectedProductList.filter((p) => !existing.has(p.id));
    const existingNotes = new Set(selectionNoteDraft.map((n) => n.id));
    const noteAdditions = noteObjects.filter((n) => !existingNotes.has(n.id));
    if (additions.length === 0 && noteAdditions.length === 0) return;
    if (selectionDraft.length + additions.length > SELECTION_MAX_PRODUCTS) {
      setSelectionError(`A selection can hold at most ${SELECTION_MAX_PRODUCTS} products.`);
      return;
    }
    if (additions.length > 0) {
      setSelectionDraft([...selectionDraft, ...additions]);
    }
    if (noteAdditions.length > 0) {
      setSelectionNoteDraft([...selectionNoteDraft, ...noteAdditions]);
    }
    // Newly-merged items join the END of this view's combined order -- "added to the selection"
    // (session 8), same as any other add.
    if (additions.length > 0 || noteAdditions.length > 0) {
      setSelectionViewOrderIndex((prev: Record<string, number>) => {
        const next = { ...prev };
        for (const p of additions) next[p.id] = nextSelectionOrderIndex();
        for (const n of noteAdditions) next[n.id] = nextSelectionOrderIndex();
        return next;
      });
    }
  };

  const clearSelectionDraft = (): void => {
    setSelectionError(null);
    setSelectionDraft([]);
    setSelectionNoteDraft([]);
    setSelectionViewOrderIndex({});
  };

  const selectionSubtitleFor = (slot: PublicSelectionSlotId): string =>
    selectionSubtitles[slot] || '';

  // Label shown for a public selection in the Selections menu. A menu `s-button` renders a single
  // plain-text label with no color or style props, so when a slot has a subtitle the subtitle
  // REPLACES the default name, rendered through `toItalic` so it appears italic, and is followed by
  // the slot's "(v/n)" count (session 24 -- see formatSelectionCount/selectionEntriesVariantCount):
  // "<italic subtitle> (v/n)". Only ever called for a public slot (see the PUBLIC_SLOTS.map call
  // site below) -- "Current Selection" has its own literal label in the menu.
  const selectionMenuLabel = (slot: PublicSelectionSlotId): string => {
    const variantCount = selectionEntriesVariantCount(
      selectionEntries[slot] || [],
      allLoadedProducts,
    );
    const noteCount = (selectionNotes[slot] || []).length;
    const countLabel = formatSelectionCount(variantCount, noteCount);
    const subtitle = selectionSubtitleFor(slot);
    if (subtitle) {
      return `${toItalic(subtitle)} ${countLabel}`;
    }
    return `${selectionSlotLabel(slot)} ${countLabel}`;
  };

  // Move ONE row (product OR note) up or down by a single position in the open selection's combined
  // order, so the merchant can reorder the selection. Polaris has no drag-and-drop component and the
  // sandbox has no HTML5 drag events, so reordering uses these move controls. Operates on the FULL
  // (unfiltered) combined row list, then renumbers every row's order index sequentially from that
  // result -- simpler and more robust than swapping the two moved rows' existing values in place,
  // since it also concretely resolves any never-explicitly-ordered ("unset", sorts last) row it
  // touches into a real position, rather than juggling Infinity. The change is a draft edit; it is
  // only persisted when the merchant uses Save.
  const moveSelectionRow = (id: string, offset: number): void => {
    setSelectionError(null);
    const combined = combineSelectionRows(
      selectionDraft,
      selectionNoteDraft,
      selectionViewOrderIndex,
    );
    const index = combined.findIndex((row) => row.id === id);
    const target = index + offset;
    if (index === -1 || target < 0 || target >= combined.length) {
      return;
    }
    const reordered = [...combined];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    const renumbered: Record<string, number> = {};
    reordered.forEach((row, i) => {
      renumbered[row.id] = i;
    });
    setSelectionViewOrderIndex(renumbered);
  };

  // Remove ONE product from the open selection's working draft. The change is a draft edit; it is
  // only persisted when the merchant uses Save.
  const removeFromSelectionDraft = (productId: string): void => {
    setSelectionError(null);
    setSelectionDraft((prev) => prev.filter((p) => p.id !== productId));
  };

  // Load this selection into the main page. In a PUBLIC selection only the CHECKED products and
  // note objects are loaded (nothing is checked by default); "Current Selection" loads its whole
  // draft. Products are unioned by id and note objects are merged by id.
  const loadSelectionIntoCurrent = (): void => {
    const productsToLoad = isPublicSelection ? checkedDraftProducts : selectionDraft;
    const notesToLoad = isPublicSelection ? checkedDraftNotes : selectionNoteDraft;
    if (productsToLoad.length === 0 && notesToLoad.length === 0) return;
    setSelectedProducts((prev) => {
      const next = { ...prev };
      for (const p of productsToLoad) {
        next[p.id] = p;
      }
      return next;
    });
    // The loaded selection's note always wins: any differing note already held for that product in
    // the current selection is overwritten to match the loaded selection (including an empty note).
    setProductNotes((prev) => {
      const next = { ...prev };
      for (const p of productsToLoad) {
        next[p.id] = p.note || '';
      }
      return next;
    });
    // Likewise seed the main page's variant checklist state from each loaded product's own narrowed
    // `.variants` -- without this, a product loaded with only some variants selected would still
    // render/download correctly (selectedProductList reads `.variants` directly), but the main
    // table's checklist would misleadingly show every variant checked until the merchant opens it.
    setSelectedVariantIds((prev: Record<string, string[]>) => {
      const next = { ...prev };
      for (const p of productsToLoad) {
        if (p.variants.length > 0 && p.variants.length < p.allVariants.length) {
          next[p.id] = p.variants.map((v: VariantData) => v.id);
        } else {
          delete next[p.id];
        }
      }
      return next;
    });
    // Note objects in the loaded selection join the Current Selection's note list (union by id).
    setNoteObjects((prev) => {
      const existing = new Set(prev.map((n) => n.id));
      const additions = notesToLoad.filter((n) => !existing.has(n.id));
      return additions.length === 0 ? prev : [...prev, ...additions];
    });
    // Newly-loaded ids join the end of the Current Selection's combined order; an id already present
    // keeps its existing position rather than jumping to the end (this loads/refreshes a product or
    // note's DATA, not necessarily a fresh "add").
    setCurrentSelectionOrderIndex((prev: Record<string, number>) => {
      const next = { ...prev };
      let changed = false;
      for (const p of productsToLoad) {
        if (!(p.id in next)) {
          next[p.id] = nextSelectionOrderIndex();
          changed = true;
        }
      }
      for (const n of notesToLoad) {
        if (!(n.id in next)) {
          next[n.id] = nextSelectionOrderIndex();
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // History (session 17): "selection loaded" only applies to a PUBLIC slot -- loading "Current"
    // into itself has no NUM/subtitle to reference and isn't a meaningful event to log.
    if (isPublicSelection && selectionSlot) {
      const tag = `{{ selection_number=${selectionSlot.slice(-1)}, selection_sub_title=${subtitleDraft}, date=${historyDate(new Date())} }}`;
      const touches: HistoryTouch[] = [
        ...productsToLoad.map(
          (p: ProductData): HistoryTouch => ({ id: p.id, baseNote: p.note || '', tag }),
        ),
        ...notesToLoad.map(
          (n: SelectionEntry): HistoryTouch => ({ id: n.id, baseNote: n.note, tag }),
        ),
      ];
      mutateHistory((current) => applyHistoryTouches(current, touches));
    }
  };

  // Persist the draft. A saved slot writes its product ids to its shop metafield; "Current Selection"
  // simply applies the draft to the in-memory product selection (nothing is persisted).
  // Returns whether the save actually succeeded (used by the "Unsaved changes" popup's Save
  // Changes button to decide whether it's safe to navigate away afterward -- see
  // saveSelectionDraftAndLeave below). The plain Save button in the selection view's header
  // discards this return value, same as before.
  const saveSelectionDraft = async (): Promise<boolean> => {
    if (!selectionSlot) return false;
    setSelectionError(null);
    if (selectionSlot === 'current') {
      const next: Record<string, ProductData> = {};
      const nextNotes: Record<string, string> = {};
      const nextVariantIds: Record<string, string[]> = {};
      for (const p of selectionDraft) {
        next[p.id] = p;
        nextNotes[p.id] = p.note || '';
        if (p.variants.length > 0 && p.variants.length < p.allVariants.length) {
          nextVariantIds[p.id] = p.variants.map((v: VariantData) => v.id);
        }
      }
      setSelectedProducts(next);
      setProductNotes(nextNotes);
      setSelectedVariantIds(nextVariantIds);
      setNoteObjects(selectionNoteDraft);
      // selectionDraft/selectionNoteDraft together become the new selectedProducts/noteObjects
      // exactly, so the view's own (possibly reordered/edited) order becomes the new Current
      // Selection order in full, replacing whatever it was before.
      setCurrentSelectionOrderIndex(selectionViewOrderIndex);
      setSelectionBaseline(selectionSignature(selectionDraft, selectionNoteDraft));
      return true;
    }
    const key = selectionMetafieldKey(selectionSlot);
    if (!key) {
      setSelectionError('This selection could not be saved.');
      return false;
    }
    setSelectionSaving(true);
    try {
      const ownerId = await ensureShopId(setSelectionError);
      if (!ownerId) {
        return false;
      }
      const entries: SelectionEntry[] = selectionDraft.map((p) => ({
        id: p.id,
        note: p.note || '',
        // Only store variantIds when the product's variants are genuinely narrowed (fewer than its
        // full list) -- an entry with every variant selected is stored exactly like a legacy entry
        // (no variantIds field at all), which is what "every variant" already means on read.
        ...(p.variants.length > 0 && p.variants.length < p.allVariants.length
          ? { variantIds: p.variants.map((v: VariantData) => v.id) }
          : {}),
      }));
      // Interleave products and notes in the view's own combined order (session 8) instead of
      // always products-then-notes, so the STORED array finally preserves true add/display order
      // for the next time this selection is loaded, not just this session's in-memory view.
      const entriesById = new Map(entries.map((e) => [e.id, e]));
      const combinedForStorage: SelectionEntry[] = combineSelectionRows(
        selectionDraft,
        selectionNoteDraft,
        selectionViewOrderIndex,
      ).map((row) => (row.kind === 'product' ? entriesById.get(row.id)! : row.note));
      const trimmedSubtitle = subtitleDraft.slice(0, SUBTITLE_MAX_LENGTH);
      const nextSubtitles: Record<string, string> = { ...selectionSubtitles };
      if (trimmedSubtitle === '') {
        delete nextSubtitles[selectionSlot];
      } else {
        nextSubtitles[selectionSlot] = trimmedSubtitle;
      }
      const { data, errors } = await shopify.query(TEMPLATES_WRITE_MUTATION, {
        variables: {
          metafields: [
            {
              ownerId,
              namespace: TEMPLATE_NAMESPACE,
              key,
              type: 'json',
              value: JSON.stringify(combinedForStorage),
            },
            {
              ownerId,
              namespace: TEMPLATE_NAMESPACE,
              key: SUBTITLES_KEY,
              type: 'json',
              value: JSON.stringify(nextSubtitles),
            },
          ],
        },
      });
      const message = formatGraphQLErrors(errors, data?.metafieldsSet?.userErrors);
      if (message) {
        setSelectionError(message);
        return false;
      }
      // History (session 17): "added" / "resubtitled" / "cleared" are all draft edits gated behind
      // Save (per this app's existing "Add to Selection alone only edits the in-memory draft" model
      // -- see architecture-notes.md), so they're logged HERE, from a before/after diff against what
      // was actually persisted, rather than at the moment a button was clicked -- an add/resubtitle/
      // clear that gets abandoned (Stay, or navigating away) is never logged, only one that's
      // actually saved. Deliberately scoped to public slots only, matching "cleared"'s own
      // public-only decision -- 'current' returns before reaching this branch. One batched
      // mutateHistory call covers all three, alongside the metafield write above.
      const numberLabel = selectionSlot.slice(-1);
      const oldIds = new Set([
        ...(selectionEntries[selectionSlot] || []).map((e: SelectionEntry) => e.id),
        ...(selectionNotes[selectionSlot] || []).map((e: SelectionEntry) => e.id),
      ]);
      const addedTouches: HistoryTouch[] = [
        ...entries
          .filter((e: SelectionEntry) => !oldIds.has(e.id))
          .map(
            (e: SelectionEntry): HistoryTouch => ({
              id: e.id,
              baseNote: e.note,
              tag: `{{ selection_number=${numberLabel}, selection_sub_title=${trimmedSubtitle}, action=added, date=${historyDate(new Date())} }}`,
            }),
          ),
        ...selectionNoteDraft
          .filter((n: SelectionEntry) => !oldIds.has(n.id))
          .map(
            (n: SelectionEntry): HistoryTouch => ({
              id: n.id,
              baseNote: n.note,
              tag: `{{ selection_number=${numberLabel}, selection_sub_title=${trimmedSubtitle}, action=added, date=${historyDate(new Date())} }}`,
            }),
          ),
      ];
      const oldSubtitle = selectionSubtitles[selectionSlot] || '';
      const resubtitled = oldSubtitle !== trimmedSubtitle;
      const cleared = oldIds.size > 0 && entries.length === 0 && selectionNoteDraft.length === 0;
      if (addedTouches.length > 0 || resubtitled || cleared) {
        mutateHistory((current) => {
          let next = current;
          if (addedTouches.length > 0) {
            next = applyHistoryTouches(next, addedTouches);
          }
          if (resubtitled) {
            const text = `Selection {{ selection_number=${numberLabel}, old_sub_title=${oldSubtitle}, new_sub_title=${trimmedSubtitle}, date=${historyDate(new Date())} }}`;
            next = appendHistoryLogNote(next, text);
          }
          if (cleared) {
            const text = `Selection {{ selection_number=${numberLabel}, selection_sub_title=${trimmedSubtitle}, action=cleared, date=${historyDate(new Date())} }}`;
            next = appendHistoryLogNote(next, text);
          }
          return next;
        });
      }
      setSelectionEntries((prev) => ({ ...prev, [selectionSlot]: entries }));
      setSelectionNotes((prev) => ({ ...prev, [selectionSlot]: selectionNoteDraft }));
      // Keep this slot's stored-order cache in step with what was just written, from the SAVED
      // array's own order (recomputed the same way parseSelectionItems would derive it on the next
      // load, so re-opening this slot without an intervening full reload shows the same order).
      const savedOrderIndex: Record<string, number> = {};
      combinedForStorage.forEach((entry, i) => {
        savedOrderIndex[entry.id] = i;
      });
      setSelectionSlotOrderIndex((prev: Record<PublicSelectionSlotId, Record<string, number>>) => ({
        ...prev,
        [selectionSlot]: savedOrderIndex,
      }));
      setSelectionSubtitles(nextSubtitles);
      setSubtitleDraft(trimmedSubtitle);
      setSubtitleBaseline(trimmedSubtitle);
      setSelectionBaseline(selectionSignature(selectionDraft, selectionNoteDraft));
      setSelectionMissing(false);
      return true;
    } catch (err: any) {
      setSelectionError(err?.message || 'Failed to save this selection.');
      return false;
    } finally {
      setSelectionSaving(false);
    }
  };

  const backFromSelection = (): void => {
    setView('main');
    setSelectionSlot(null);
    setSelectionError(null);
    refreshTemplatesAndProducts();
  };

  // Used by the "Unsaved changes" popup's Save Changes button: save the draft, then leave the
  // selection view, but ONLY on success -- a failed save leaves selectionError set and the
  // merchant on the selection view (with the popup already dismissed by its command="--hide"),
  // exactly like clicking the ordinary Save button and seeing the same error inline would.
  const saveSelectionDraftAndLeave = async (): Promise<void> => {
    const saved = await saveSelectionDraft();
    if (saved) {
      backFromSelection();
    }
  };

  // The open selection's products and notes, combined into ONE ordered list (session 8, per
  // explicit direction: "show objects in the order added to the selection"). Unfiltered -- used to
  // find a row's true first/last position (for disabling the move-up/move-down controls) regardless
  // of any active search term.
  const selectionCombinedAll = useMemo<SelectionRow[]>(
    () => combineSelectionRows(selectionDraft, selectionNoteDraft, selectionViewOrderIndex),
    [selectionDraft, selectionNoteDraft, selectionViewOrderIndex],
  );

  // The same combined list, filtered by the in-selection search term (matches a product's usual
  // searchable fields or a note's text) -- what the table actually renders.
  const selectionRowsFiltered = useMemo<SelectionRow[]>(() => {
    const term = selectionSearch.trim();
    if (term === '') return selectionCombinedAll;
    return selectionCombinedAll.filter((row: SelectionRow) =>
      row.kind === 'product'
        ? productMatchesQuery(row.product, term)
        : noteMatchesQuery(row.note, term),
    );
  }, [selectionCombinedAll, selectionSearch]);

  // --------------------------------------------------------------------------------------------
  // View rendering
  // One closure per top-level view, dispatched by `view` in the final return below. Each closure
  // is a straight extraction of the JSX that used to live inline in an
  // `if (view === X) { return (...); }` block; it still closes over every piece of state and every
  // handler declared above, so nothing about how they resolve values changed.
  // --------------------------------------------------------------------------------------------
  const renderEditorView = () => (
    <s-page heading={editingTemplate ? 'Edit template' : 'New template'}>
      <s-stack slot="header-actions" direction="inline" gap="base" justifyContent="space-between">
        <s-stack direction="inline" gap="base">
          {hasUnsavedChanges() ? (
            <s-button icon="arrow-left" commandFor="leave-confirm-modal">
              Back
            </s-button>
          ) : (
            <s-button icon="arrow-left" onClick={backToMain}>
              Back
            </s-button>
          )}
        </s-stack>
        {/* Session 24, per explicit direction: a delete button inside the editor itself, top
              right (same row as Back), red, reusing the exact same delete-template-modal the
              template list's own "Delete template" menu action already opens -- confirmDelete
              below returns to the main view afterward when the deleted template is the one open
              here. Only shown for an already-saved template -- a brand-new, unsaved one has
              nothing to delete yet. */}
        {editingTemplate ? (
          <s-button
            icon="delete"
            tone="critical"
            commandFor="delete-template-modal"
            onClick={() => openDeleteModal(editingTemplate.id)}
          >
            Delete template
          </s-button>
        ) : null}
      </s-stack>

      {editorError ? (
        <s-banner tone="critical" heading="Could not save template">
          <s-text>{editorError}</s-text>
        </s-banner>
      ) : null}

      {/* Session 27 bugfix (see delete-template-modal below): the modal's own confirm button now
            closes it immediately on click, so a failed delete's error can no longer be shown INSIDE
            the (already-closed) modal -- it surfaces here instead, on the page behind it, the same
            way editorError already does. */}
      {deleteError ? (
        <s-banner tone="critical" heading="Could not delete template">
          <s-text>{deleteError}</s-text>
        </s-banner>
      ) : null}

      <s-section>
        <s-stack gap="base">
          <s-text-field
            label="Title"
            value={editorTitle}
            error={editorTitleError || undefined}
            onInput={(e: any) => setEditorTitle(e.currentTarget.value)}
          />

          <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">Body</s-text>
              <s-text color="subdued">File break:</s-text>
              <s-button
                commandFor="file-break-menu"
                tone={editorFileBreak === null ? 'critical' : undefined}
              >
                {editorFileBreak ? FILE_BREAK_LABELS[editorFileBreak] : 'Not set — choose one'}
              </s-button>
              <s-menu id="file-break-menu" accessibilityLabel="File break">
                {FILE_BREAK_VALUES.map((value: FileBreak) => (
                  <s-button
                    key={value}
                    icon={editorFileBreak === value ? 'check' : undefined}
                    onClick={() => {
                      setEditorFileBreak(value);
                      setEditorFileBreakError(null);
                    }}
                  >
                    {FILE_BREAK_LABELS[value]}
                  </s-button>
                ))}
              </s-menu>
              {editorFileBreakError ? (
                <s-text tone="critical">{editorFileBreakError}</s-text>
              ) : null}
            </s-stack>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button icon="plus" commandFor="insert-variable-menu">
                Insert variable
              </s-button>
              <s-button icon="plus" commandFor="insert-special-menu">
                Insert special
              </s-button>
            </s-stack>
            <s-menu id="insert-variable-menu" accessibilityLabel="Insert variable">
              <s-text color="subdued">
                Selected variable replaces all instances of {INSERT_PLACEHOLDER}
              </s-text>
              <s-section heading="Product fields">
                {PRODUCT_FIELD_TOKENS.map((t) => (
                  <s-button key={t.token} onClick={() => insertVariable(t.token)}>
                    {t.label}
                  </s-button>
                ))}
              </s-section>
              <s-section heading="Variant fields">
                {VARIANT_FIELD_TOKENS.map((t) => (
                  <s-button key={t.token} onClick={() => insertVariable(t.token)}>
                    {t.label}
                  </s-button>
                ))}
              </s-section>
              {metafieldTokens.length > 0 ? (
                <s-section heading="Metafields">
                  {metafieldTokens.map((t) => (
                    <s-button key={t.token} onClick={() => insertVariable(t.token)}>
                      {t.label}
                    </s-button>
                  ))}
                </s-section>
              ) : null}
              {globalVars.length > 0 ? (
                <s-section heading="Global variables">
                  {globalVars.map((g: GlobalVarEntry) => (
                    <s-button key={g.id} onClick={() => insertVariable(`{{ $global:${g.title} }}`)}>
                      {g.title}
                    </s-button>
                  ))}
                </s-section>
              ) : null}
            </s-menu>
            <s-menu id="insert-special-menu" accessibilityLabel="Insert special">
              <s-text color="subdued">
                Selected variable replaces all instances of {INSERT_PLACEHOLDER}
              </s-text>
              <s-section heading="Selection">
                <s-button onClick={() => insertVariable(FOREACH_BLOCK)}>For each loop</s-button>
                <s-button onClick={() => insertVariable(NOTES_LOOP_BLOCK)}>Notes foreach</s-button>
                <s-button onClick={() => insertVariable('{{ selection.length }}')}>
                  Number of products selected
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.first.product.handle }}')}>
                  First product handle
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.last.product.handle }}')}>
                  Last product handle
                </s-button>
                <s-button onClick={() => insertVariable('{{ product.length }}')}>
                  Number of variants
                </s-button>
                <s-button onClick={() => insertVariable(VARIANT_LOOP_BLOCK)}>
                  Variant foreach
                </s-button>
                <s-button onClick={() => insertVariable(TAGS_LOOP_BLOCK)}>Tags foreach</s-button>
                <s-button onClick={() => insertVariable(METAFIELDS_LOOP_BLOCK)}>
                  Metafields foreach
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.next.product.title }}')}>
                  Next object's field
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.prev.product.title }}')}>
                  Previous object's field
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.next.type }}')}>
                  Next object's type
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.prev.type }}')}>
                  Previous object's type
                </s-button>
                <s-button onClick={() => insertVariable('{{ selection.curr.type }}')}>
                  Current object's type
                </s-button>
              </s-section>
              <s-section heading="Variables">
                <s-button onClick={() => insertVariable(ASSIGN_TOKEN)}>Assign variable</s-button>
                <s-button onClick={() => insertVariable(ASSIGN_TOKEN_DOLLAR)}>
                  Assign variable ($, collision-safe)
                </s-button>
                {VARIABLE_NAMES.map((name) => (
                  <s-button key={name} onClick={() => insertVariable(`{{ ${name} }}`)}>
                    Variable {name}
                  </s-button>
                ))}
              </s-section>
              <s-section heading="Functions">
                <s-button onClick={() => insertVariable(WHILE_BLOCK)}>While loop</s-button>
                <s-button onClick={() => insertVariable(CHOP_BLOCK)}>Chop block</s-button>
                <s-button onClick={() => insertVariable(WRAP_BLOCK)}>Word wrap</s-button>
                <s-button onClick={() => insertVariable(REPEAT_BLOCK)}>Repeat</s-button>
                <s-button onClick={() => insertVariable(REPLACE_BLOCK)}>Replace</s-button>
                <s-button onClick={() => insertVariable(INDEX_BLOCK)}>Index</s-button>
                <s-button onClick={() => insertVariable(INSERT_BLOCK)}>Insert block</s-button>
                <s-button onClick={() => insertVariable(IF_BLOCK)}>If block</s-button>
                <s-button onClick={() => insertVariable(COMMENT_BLOCK)}>Comment block</s-button>
                <s-button onClick={() => insertVariable(BREAK_TOKEN_BLOCK)}>Break</s-button>
                <s-button onClick={() => insertVariable(SKIP_TOKEN_BLOCK)}>Skip</s-button>
              </s-section>
              <s-section heading="Functional tokens">
                <s-button onClick={() => insertVariable('{{ =0 }}')}>Math equation</s-button>
                <s-button onClick={() => insertVariable(BOOLEAN_TOKEN)}>Boolean equation</s-button>
                <s-button onClick={() => insertVariable(LENGTH_TOKEN)}>String length</s-button>
              </s-section>
              <s-section heading="Special tokens">
                <s-button onClick={() => insertVariable(NEWLINE_TOKEN_SNIPPET)}>New line</s-button>
                <s-button onClick={() => insertVariable(SPACE_TOKEN_SNIPPET)}>Space</s-button>
                <s-button onClick={() => insertVariable(DATE_TOKEN)}>Date</s-button>
                <s-button onClick={() => insertVariable(TIME_TOKEN)}>Time</s-button>
                <s-button onClick={() => insertVariable(DATE_TIME_TOKEN)}>Date and time</s-button>
                <s-button onClick={() => insertVariable(WEEKDAY_DATE_TOKEN)}>
                  Weekday, month day, year
                </s-button>
                <s-button onClick={() => insertVariable('{{ primaryDomain }}')}>
                  Shop primary domain
                </s-button>
              </s-section>
            </s-menu>
          </s-stack>

          <s-text-area
            label="Body"
            labelAccessibilityVisibility="exclusive"
            value={editorBody}
            rows={16}
            maxLength={1000000}
            placeholder="Write your template. Place {{ insert }} where you want to insert a variable, then select it from the menu above."
            autocomplete="off"
            onInput={(e: any) => setEditorBody(e.currentTarget.value)}
          />

          <s-text-field
            label="Merge IF:"
            value={editorMergeCondition}
            details="Can be used to modify the file break behavior.  If evaluates to TRUE, the next file's text will be appended to the current file's text. If Empty or FALSE, the files do not merge. Can use variables, functions, and other objects in the selection using commands."
            onInput={(e: any) => setEditorMergeCondition(e.currentTarget.value)}
          />

          <s-text-field
            label="Extension"
            value={editorExtension}
            details="File extension for generated files, e.g. txt, csv, json, html."
            onInput={(e: any) => setEditorExtension(e.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      <s-stack direction="inline" gap="base" justifyContent="space-between">
        <s-button variant="primary" loading={saving} onClick={saveTemplate}>
          Save
        </s-button>
        <s-button
          disabled={!canPreview}
          commandFor="preview-modal"
          command="--show"
          onClick={openPreview}
        >
          Preview
        </s-button>
      </s-stack>

      <s-modal id="preview-modal" heading="Preview" size="large">
        <s-stack gap="base">
          {preview.failed ? (
            <s-banner tone="critical" heading="Could not build preview">
              <s-text>
                The preview could not be generated from this template and the selected products.
              </s-text>
            </s-banner>
          ) : preview.files.length === 0 ? (
            <s-text color="subdued">Select at least one product to preview this template.</s-text>
          ) : (
            <s-stack gap="base">
              {preview.files.length > 1 ? (
                <s-stack
                  direction="inline"
                  gap="small"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-button
                    icon="chevron-left"
                    accessibilityLabel="Previous file"
                    disabled={previewPage === 0}
                    onClick={showPreviousPreviewFile}
                  />
                  <s-text color="subdued">
                    File {previewPage + 1} of {preview.files.length}:{' '}
                    {preview.files[previewPage].name}
                  </s-text>
                  <s-button
                    icon="chevron-right"
                    accessibilityLabel="Next file"
                    disabled={previewPage === preview.files.length - 1}
                    onClick={showNextPreviewFile}
                  />
                </s-stack>
              ) : (
                <s-text color="subdued">{preview.files[previewPage].name}</s-text>
              )}
              <s-text-area
                label="Preview content"
                labelAccessibilityVisibility="exclusive"
                value={preview.files[previewPage].content}
                rows={18}
                readOnly
              />
            </s-stack>
          )}
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="preview-modal"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>

      {/* All three actions live in the "secondary-actions" slot, in this exact order, rather
            than splitting the red button off into "primary-action": that slot only accepts
            variant "secondary"/"auto" (see the note-modal below), so a "primary" button
            couldn't sit alongside them there, and s-modal doesn't document primary-action's
            position relative to secondary-actions closely enough to guarantee "red, green,
            gray" left-to-right if the two slots were mixed. Named-slot children render in the
            order they're declared, so keeping all three together is what actually guarantees
            the requested order. There is no green tone available on s-button (only
            critical/auto/neutral) -- "Save Changes" uses variant="auto" as the closest
            supported emphasis short of red/gray. */}
      <s-modal id="leave-confirm-modal" heading="Unsaved changes">
        <s-text>You have unsaved changes. Leave without saving?</s-text>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          tone="critical"
          commandFor="leave-confirm-modal"
          command="--hide"
          onClick={confirmLeave}
        >
          Leave without saving
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="auto"
          commandFor="leave-confirm-modal"
          command="--hide"
          onClick={saveTemplate}
        >
          Save Changes
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="leave-confirm-modal"
          command="--hide"
        >
          Stay
        </s-button>
      </s-modal>

      {/* Session 26 bugfix: the editor's own delete-template button (see its header-actions
            comment above) pointed `commandFor` at "delete-template-modal", but that modal only
            existed in renderMainView's returned tree -- each top-level view renders its OWN
            separate `<s-page>`, so a modal declared in one view's JSX simply does not exist in
            another view's DOM at all. `commandFor` had nothing to show, so clicking Delete
            template here silently did nothing. Fix: this exact copy of the same modal (same id,
            same handlers -- confirmDelete/cancelDelete/pendingDeleteTemplate are shared
            component state, not view-local) also lives here, mirroring the pattern
            leave-confirm-modal above and selection-leave-modal (renderSelectionView) already
            use. Only one view is ever mounted at a time, so having the same id declared in two
            views' JSX never creates two real DOM nodes at once.
            Session 27 bugfix: the confirm button below used to have no `commandFor`/`command`
            of its own (deliberately, it looks like -- so a failed delete's error banner, then
            rendered INSIDE this modal, would stay visible instead of disappearing with it). But
            `s-modal` open/closed state is NOT tied to any Preact prop this file controls --
            `pendingDeleteId` going back to null on success does not itself close an
            already-open modal, only an explicit `--hide` command does. Reported directly: after
            a successful delete, the popup stayed open, now asking to delete "Untitled" (
            `pendingDeleteTemplate` correctly went null once the template left `templates`, but
            the modal itself never got told to close). Fix: `command="--hide"` added to the
            confirm button below, matching every other confirm-and-act button in this file (the
            note modal's Save, both leave-confirm modals' Save Changes, the global-var modal's
            Save) -- all of which close immediately on click, success or failure, and rely on a
            PAGE-level banner (not one inside the now-closed modal) to surface a failure. The
            in-modal error banner that used to live here is gone for the same reason; see the
            new page-level `deleteError` banner above (editor) / in the Templates section below
            (main view). */}
      <s-modal id="delete-template-modal" heading="Delete template?">
        <s-text>
          "{pendingDeleteTemplate?.title || 'Untitled'}" will be permanently removed and cannot be
          recovered.
        </s-text>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleting}
          commandFor="delete-template-modal"
          command="--hide"
          onClick={confirmDelete}
        >
          Delete template
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="delete-template-modal"
          command="--hide"
          onClick={cancelDelete}
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );

  const renderSelectionView = () => (
    <s-page heading={selectionSlotLabel(selectionSlot!)} inlineSize="large">
      <s-stack slot="header-actions" direction="inline" gap="base">
        {hasSelectionUnsavedChanges() ? (
          <s-button icon="arrow-left" commandFor="selection-leave-modal">
            Back
          </s-button>
        ) : (
          <s-button icon="arrow-left" onClick={backFromSelection}>
            Back
          </s-button>
        )}
        <s-button
          icon="refresh"
          loading={selectionLoading}
          disabled={selectionLoading}
          onClick={refreshSelectionView}
        >
          Refresh
        </s-button>
        <s-button onClick={clearSelectionDraft} disabled={selectionDraft.length === 0}>
          Clear Selection
        </s-button>
        <s-button
          onClick={loadSelectionIntoCurrent}
          disabled={
            isPublicSelection
              ? checkedItemCount === 0
              : selectionDraft.length === 0 && selectionNoteDraft.length === 0
          }
        >
          Load Selected
        </s-button>
        <s-button
          variant="primary"
          disabled={selectedProductList.length === 0 && noteObjects.length === 0}
          onClick={addMainSelectionToDraft}
        >
          Add to Selection
        </s-button>
        <s-button loading={selectionSaving} onClick={saveSelectionDraft}>
          Save
        </s-button>
      </s-stack>

      {selectionError ? (
        <s-banner tone="critical" heading="Selection error">
          <s-text>{selectionError}</s-text>
        </s-banner>
      ) : null}

      {selectionMissing ? (
        <s-banner tone="info" heading="Some products were skipped">
          <s-text>Some products in this selection no longer exist and were skipped.</s-text>
        </s-banner>
      ) : null}

      <s-section padding="none">
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack
              direction="inline"
              gap="base"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-heading>Items in this selection</s-heading>
              <s-text color="subdued">
                {selectionDraft.length} products · {selectionNoteDraft.length} notes
              </s-text>
            </s-stack>
            {selectionSlot !== 'current' ? (
              <s-text-field
                label="Subtitle"
                value={subtitleDraft}
                maxLength={SUBTITLE_MAX_LENGTH}
                details="Up to 16 characters. Shown under this selection in the Selections menu."
                onInput={(e: any) => setSubtitleDraft(e.currentTarget.value)}
              />
            ) : null}
            <s-search-field
              label="Search this selection"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search products in this selection…"
              value={selectionSearch}
              onInput={(e: any) => setSelectionSearch(e.currentTarget.value)}
            />
            {isPublicSelection ? (
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-button
                  onClick={toggleSelectAllInSelection}
                  disabled={selectionDraft.length + selectionNoteDraft.length === 0}
                >
                  {allSelectionItemsChecked ? 'Deselect All' : 'Select All'}
                </s-button>
                <s-text color="subdued">{checkedItemCount} selected</s-text>
              </s-stack>
            ) : null}
          </s-stack>
        </s-box>

        {/* ONE combined table interleaving products and notes, ordered by when each was added to
              the selection (session 8, per explicit direction) -- replaces the old two separate
              "Products"/"Notes" tables, which always showed every product before every note
              regardless of actual add order. */}
        <s-table loading={selectionLoading}>
          <s-table-header-row>
            {isPublicSelection ? <s-table-header>Use</s-table-header> : null}
            <s-table-header listSlot="primary">Item</s-table-header>
            <s-table-header>Handle</s-table-header>
            <s-table-header>Qty</s-table-header>
            <s-table-header>Note</s-table-header>
            <s-table-header>Order</s-table-header>
            <s-table-header>Remove</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {selectionRowsFiltered.length === 0 && !selectionLoading ? (
              <s-table-row>
                <s-table-cell>
                  <s-text color="subdued">
                    {selectionDraft.length === 0 && selectionNoteDraft.length === 0
                      ? 'No products or notes in this selection.'
                      : 'No items found.'}
                  </s-text>
                </s-table-cell>
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                {isPublicSelection ? <s-table-cell /> : null}
              </s-table-row>
            ) : (
              selectionRowsFiltered.map((row: SelectionRow) => {
                const isFirst = selectionCombinedAll[0]?.id === row.id;
                const isLast = selectionCombinedAll[selectionCombinedAll.length - 1]?.id === row.id;
                const label = row.kind === 'product' ? row.product.title : 'Note';
                return (
                  <s-table-row key={row.id}>
                    {isPublicSelection ? (
                      <s-table-cell>
                        <s-checkbox
                          accessibilityLabel={`Include ${label} when loading`}
                          checked={Boolean(
                            row.kind === 'product'
                              ? checkedSelectionProducts[row.id]
                              : checkedSelectionNotes[row.id],
                          )}
                          onChange={(e: any) =>
                            row.kind === 'product'
                              ? setSelectionProductChecked(row.id, e.currentTarget.checked)
                              : setSelectionNoteChecked(row.id, e.currentTarget.checked)
                          }
                        />
                      </s-table-cell>
                    ) : null}
                    <s-table-cell>
                      {row.kind === 'product' ? (
                        <s-stack direction="inline" gap="small" alignItems="center">
                          {row.product.imageUrl ? (
                            <s-thumbnail
                              size="small"
                              src={row.product.imageUrl}
                              alt={row.product.title}
                            />
                          ) : null}
                          {adminProductUrl(row.product.id, primaryDomain) ? (
                            <s-link
                              href={adminProductUrl(row.product.id, primaryDomain)!}
                              target="_blank"
                            >
                              <s-text type="strong">{row.product.title}</s-text>
                            </s-link>
                          ) : (
                            <s-text type="strong">{row.product.title}</s-text>
                          )}
                        </s-stack>
                      ) : (
                        <s-text type="strong">📝 Note</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">
                        {row.kind === 'product' ? row.product.handle : '—'}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">
                        {row.kind === 'product' ? formatQty(row.product.totalInventory) : '—'}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text-field
                        label={
                          row.kind === 'product' ? `Note for ${row.product.title}` : 'Note text'
                        }
                        labelAccessibilityVisibility="exclusive"
                        placeholder={row.kind === 'product' ? 'Add a note…' : undefined}
                        value={row.kind === 'product' ? row.product.note || '' : row.note.note}
                        onInput={(e: any) =>
                          row.kind === 'product'
                            ? setSelectionDraftNote(row.id, e.currentTarget.value)
                            : setSelectionDraftNoteContent(row.id, e.currentTarget.value)
                        }
                      />
                    </s-table-cell>
                    <s-table-cell>
                      {/* Reordering uses move controls because Polaris has no drag-and-drop
                            component and the sandbox exposes no HTML5 drag events. Moves are
                            disabled while a search filters the list, so positions always reflect
                            true combined order. */}
                      <s-stack direction="inline" gap="small-400" alignItems="center">
                        <s-button
                          icon="chevron-up"
                          variant="tertiary"
                          accessibilityLabel={`Move ${label} up`}
                          disabled={selectionSearch.trim() !== '' || isFirst}
                          onClick={() => moveSelectionRow(row.id, -1)}
                        />
                        <s-button
                          icon="chevron-down"
                          variant="tertiary"
                          accessibilityLabel={`Move ${label} down`}
                          disabled={selectionSearch.trim() !== '' || isLast}
                          onClick={() => moveSelectionRow(row.id, 1)}
                        />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="x"
                        variant="tertiary"
                        accessibilityLabel={`Remove ${label}`}
                        onClick={() =>
                          row.kind === 'product'
                            ? removeFromSelectionDraft(row.id)
                            : removeNoteFromDraft(row.id)
                        }
                      />
                    </s-table-cell>
                  </s-table-row>
                );
              })
            )}
          </s-table-body>
        </s-table>
      </s-section>

      {/* See the leave-confirm-modal comment (editor view) for why all three actions share the
            "secondary-actions" slot instead of splitting the red button into "primary-action". */}
      <s-modal id="selection-leave-modal" heading="Unsaved changes">
        <s-text>You have unsaved changes. Leave without saving?</s-text>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          tone="critical"
          commandFor="selection-leave-modal"
          command="--hide"
          onClick={backFromSelection}
        >
          Leave without saving
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="auto"
          loading={selectionSaving}
          commandFor="selection-leave-modal"
          command="--hide"
          onClick={saveSelectionDraftAndLeave}
        >
          Save Changes
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="selection-leave-modal"
          command="--hide"
        >
          Stay
        </s-button>
      </s-modal>
    </s-page>
  );

  const renderMainView = () => (
    <s-page heading="Template to File" inlineSize="large">
      <s-stack slot="header-actions" direction="inline" gap="base" justifyContent="space-between">
        {/* Being last in a single left-anchored stack only pushes Settings after the other
            buttons, not all the way to the row's right edge -- the whole stack hugs the left
            (above Products, the grid's wider 2fr column) unless something forces the two ends
            apart. Splitting into two inline groups under one justifyContent="space-between"
            stack pins this group to the left and the Settings group to the right edge, landing
            it above the Templates column (the narrower 1fr column below) regardless of how wide
            either group is. */}
        <s-stack direction="inline" gap="base">
          <s-button onClick={clearProductSelection}>Clear Product Selection</s-button>
          <s-button onClick={clearTemplateSelection}>Clear Template Selection</s-button>
          <s-button loading={refreshing} disabled={refreshing} onClick={refreshAll}>
            Refresh Page
          </s-button>
          {canDownload && download ? (
            <s-link
              href={download.href}
              download={download.name}
              commandFor="download-confirm-modal"
              command="--show"
              onClick={onDownloadClick}
            >
              <s-button variant="primary">Download Files</s-button>
            </s-link>
          ) : (
            <s-button variant="primary" disabled loading={preparingDownload}>
              Download Files
            </s-button>
          )}
        </s-stack>
        <s-button icon="settings" accessibilityLabel="Settings" onClick={openSettings}>
          Settings
        </s-button>
      </s-stack>

      {downloadProgress ? (
        <s-banner tone="info" heading="Preparing your download">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-spinner accessibilityLabel="Preparing download" />
            <s-text>
              {downloadProgress.packaging
                ? 'Packaging ZIP file…'
                : `Generating file ${downloadProgress.done} of ${downloadProgress.total}…`}
            </s-text>
          </s-stack>
        </s-banner>
      ) : null}

      {downloadBuildFailed ? (
        <s-banner tone="critical" heading="Could not generate files">
          <s-text>
            The file could not be generated from the selected products and template. Try a different
            selection or template.
          </s-text>
        </s-banner>
      ) : null}

      <s-grid gridTemplateColumns="2fr 1fr" gap="base">
        <s-section padding="none">
          <s-box padding="base">
            <s-stack gap="base">
              <s-stack
                direction="inline"
                gap="base"
                justifyContent="space-between"
                alignItems="center"
              >
                <s-heading>Products</s-heading>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text color="subdued">
                    {formatSelectionCount(currentSelectionVariantCount, noteObjects.length)}{' '}
                    selected
                  </s-text>
                  <s-button icon="caret-down" commandFor="selections-menu">
                    Selections
                  </s-button>
                  {/* The Selections menu. An `s-menu` renders each button's label as a single line
                      of plain text, so a slot with a subtitle shows the subtitle as its label. */}
                  <s-menu id="selections-menu" accessibilityLabel="Product selections">
                    <s-section heading="Current">
                      <s-button onClick={() => openSelectionView('current')}>
                        Current Selection{' '}
                        {formatSelectionCount(currentSelectionVariantCount, noteObjects.length)}
                      </s-button>
                    </s-section>
                    <s-section heading="Public">
                      {PUBLIC_SLOTS.map((slot) => (
                        <s-button key={slot} onClick={() => openSelectionView(slot)}>
                          {selectionMenuLabel(slot)}
                        </s-button>
                      ))}
                    </s-section>
                  </s-menu>
                </s-stack>
              </s-stack>
              {/* A plain text field (not a search field) is used here so long queries scroll and
                  keep the caret at the end on mobile. Autocomplete is off and the merchant can
                  submit explicitly with the Search button instead of relying on the change event. */}
              <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="end">
                <s-text-field
                  label="Search products"
                  labelAccessibilityVisibility="exclusive"
                  icon="search"
                  autocomplete="off"
                  placeholder="Search title, handle, tag, SKU, metafield…"
                  value={productSearch}
                  onInput={(e: any) => setProductSearch(e.currentTarget.value)}
                  onChange={runSearch}
                />
                <s-button onClick={runSearch}>Search</s-button>
              </s-grid>
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-button
                    variant={bulkActive('shown') ? 'primary' : undefined}
                    disabled={displayedProducts.length === 0}
                    onClick={() => toggleBulkSelect('shown')}
                  >
                    Select all shown
                  </s-button>
                  <s-button
                    variant={bulkActive('in-stock') ? 'primary' : undefined}
                    disabled={inStockDisplayedCount === 0}
                    onClick={() => toggleBulkSelect('in-stock')}
                  >
                    Select all in stock
                  </s-button>
                </s-stack>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text color="subdued">{noteObjects.length} notes</s-text>
                  <s-button
                    commandFor="note-modal"
                    command="--show"
                    onClick={() => openNoteModal('')}
                  >
                    Add Blank Note
                  </s-button>
                </s-stack>
              </s-stack>
            </s-stack>
          </s-box>

          {productError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Could not load products">
                <s-text>{productError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          {selectionsError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Selections">
                <s-text>{selectionsError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          {/* Thin grey pagination bar directly above the table header, so the merchant can page
              through products without scrolling to the bottom of the table. */}
          <s-box background="subdued" paddingBlock="small-300" paddingInline="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="end">
              <s-button
                icon="chevron-left"
                accessibilityLabel="Previous page of products"
                disabled={!productPageInfo?.hasPreviousPage}
                onClick={handlePrevProducts}
              />
              <s-button
                icon="chevron-right"
                accessibilityLabel="Next page of products"
                disabled={!productPageInfo?.hasNextPage}
                onClick={handleNextProducts}
              />
            </s-stack>
          </s-box>

          <s-table
            paginate={Boolean(productPageInfo?.hasNextPage || productPageInfo?.hasPreviousPage)}
            loading={productsLoading}
            hasNextPage={productPageInfo?.hasNextPage || false}
            hasPreviousPage={productPageInfo?.hasPreviousPage || false}
            onNextPage={handleNextProducts}
            onPreviousPage={handlePrevProducts}
          >
            <s-table-header-row>
              <s-table-header>Select</s-table-header>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Handle</s-table-header>
              <s-table-header>Qty</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {displayedProducts.length === 0 && !productsLoading ? (
                <s-table-row>
                  <s-table-cell>
                    <s-text color="subdued">No products found.</s-text>
                  </s-table-cell>
                  <s-table-cell />
                  <s-table-cell />
                  <s-table-cell />
                </s-table-row>
              ) : (
                displayedProducts.map((p) => {
                  // All-variant-ids fallback is computed once per row: an absent/empty
                  // selectedVariantIds entry means "every variant" (see narrowToSelectedVariants).
                  const allVariantIds = p.allVariants.map((v: VariantData) => v.id);
                  const checkedVariantIds =
                    selectedVariantIds[p.id] && selectedVariantIds[p.id].length > 0
                      ? selectedVariantIds[p.id]
                      : allVariantIds;
                  return (
                    <s-table-row key={p.id}>
                      <s-table-cell>
                        <s-checkbox
                          accessibilityLabel={`Select ${p.title}`}
                          checked={Boolean(selectedProducts[p.id])}
                          onChange={(e: any) => toggleProduct(p, e.currentTarget.checked)}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack gap="small-400">
                          <s-stack direction="inline" gap="small" alignItems="center">
                            {p.imageUrl ? (
                              <s-thumbnail size="small" src={p.imageUrl} alt={p.title} />
                            ) : null}
                            {adminProductUrl(p.id, primaryDomain) ? (
                              <s-link href={adminProductUrl(p.id, primaryDomain)!} target="_blank">
                                <s-text type="strong">{p.title}</s-text>
                              </s-link>
                            ) : (
                              <s-text type="strong">{p.title}</s-text>
                            )}
                          </s-stack>
                          {selectedProducts[p.id] ? (
                            <s-text-field
                              label={`Note for ${p.title}`}
                              labelAccessibilityVisibility="exclusive"
                              placeholder="Add a note to the selection..."
                              value={productNotes[p.id] || ''}
                              onInput={(e: any) => setProductNote(p.id, e.currentTarget.value)}
                            />
                          ) : null}
                          {selectedProducts[p.id] && p.allVariants.length > 1 ? (
                            <s-stack gap="small-200">
                              <s-text color="subdued">
                                Variants ({checkedVariantIds.length} of {p.allVariants.length}{' '}
                                selected)
                              </s-text>
                              {p.allVariants.map((v: VariantData) => (
                                <s-checkbox
                                  key={v.id}
                                  label={v.title}
                                  accessibilityLabel={`Include variant ${v.title} of ${p.title}`}
                                  checked={checkedVariantIds.includes(v.id)}
                                  onChange={() =>
                                    toggleVariantChecked(
                                      p.id,
                                      allVariantIds,
                                      v.id,
                                      !checkedVariantIds.includes(v.id),
                                    )
                                  }
                                />
                              ))}
                            </s-stack>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                      {/* Handle and Qty mirror the Product cell's own stack shape (same gaps, a
                          blank spacer line per optional section) purely so their FIRST line stays
                          level with the product title -- neither column has a per-variant value of
                          its own to show there, but s-table-cell has no documented vertical-align
                          control (confirmed against the live component reference), so matching
                          overall stack height is what keeps them lined up regardless of whichever
                          way a cell centers its content by default. */}
                      <s-table-cell>
                        <s-stack gap="small-400">
                          <s-text color="subdued">{p.handle}</s-text>
                          {selectedProducts[p.id] ? <s-text color="subdued"> </s-text> : null}
                          {selectedProducts[p.id] && p.allVariants.length > 1 ? (
                            <s-stack gap="small-200">
                              <s-text color="subdued"> </s-text>
                              {p.allVariants.map((v: VariantData) => (
                                <s-text key={v.id} color="subdued">
                                  {' '}
                                </s-text>
                              ))}
                            </s-stack>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack gap="small-400">
                          <s-text color="subdued">{formatQty(p.totalInventory)}</s-text>
                          {selectedProducts[p.id] ? <s-text color="subdued"> </s-text> : null}
                          {selectedProducts[p.id] && p.allVariants.length > 1 ? (
                            <s-stack gap="small-200">
                              <s-text color="subdued"> </s-text>
                              {p.allVariants.map((v: VariantData) => (
                                <s-text key={v.id} color="subdued">
                                  {formatQty(v.inventoryQuantity)}
                                </s-text>
                              ))}
                            </s-stack>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  );
                })
              )}
            </s-table-body>
          </s-table>
        </s-section>

        <s-section padding="none">
          <s-box padding="base">
            <s-stack gap="base">
              <s-stack
                direction="inline"
                gap="base"
                justifyContent="space-between"
                alignItems="center"
              >
                <s-stack direction="inline" gap="small-100" alignItems="center">
                  <s-heading>Templates</s-heading>
                  <s-text color="subdued">{storageLabel}</s-text>
                </s-stack>
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-button icon="plus" accessibilityLabel="Add template" onClick={openNewTemplate}>
                    Add
                  </s-button>
                  <s-button
                    icon="sort"
                    accessibilityLabel="Sort templates"
                    commandFor="template-sort-menu"
                  >
                    Sort
                  </s-button>
                  <s-menu id="template-sort-menu" accessibilityLabel="Sort templates">
                    <s-button
                      icon={templateSort === 'new-old' ? 'check' : undefined}
                      onClick={() => setTemplateSort('new-old')}
                    >
                      New to Old
                    </s-button>
                    <s-button
                      icon={templateSort === 'old-new' ? 'check' : undefined}
                      onClick={() => setTemplateSort('old-new')}
                    >
                      Old to New
                    </s-button>
                    <s-button
                      icon={templateSort === 'a-z' ? 'check' : undefined}
                      onClick={() => setTemplateSort('a-z')}
                    >
                      A-Z
                    </s-button>
                    <s-button
                      icon={templateSort === 'z-a' ? 'check' : undefined}
                      onClick={() => setTemplateSort('z-a')}
                    >
                      Z-A
                    </s-button>
                  </s-menu>
                </s-stack>
              </s-stack>
              <s-search-field
                label="Search templates"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by title…"
                value={templateSearch}
                onInput={(e: any) => setTemplateSearch(e.currentTarget.value)}
              />
            </s-stack>
          </s-box>

          {templateError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Template error">
                <s-text>{templateError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          {pinError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Could not update pinned template">
                <s-text>{pinError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          {/* Session 27 bugfix (see delete-template-modal's own comment): its confirm button now
              closes the modal immediately on click, so a failed delete's error surfaces here, on
              the page behind it, instead of inside the (already-closed) modal. */}
          {deleteError ? (
            <s-box padding="base">
              <s-banner tone="critical" heading="Could not delete template">
                <s-text>{deleteError}</s-text>
              </s-banner>
            </s-box>
          ) : null}

          <s-box padding="base">
            <s-stack gap="none">
              {templatesLoading ? (
                <s-spinner accessibilityLabel="Loading templates" />
              ) : templateGroups.list.length === 0 ? (
                <s-text color="subdued">
                  {templates.length === 0
                    ? 'No templates yet. Use Add to create one.'
                    : 'No templates match your search.'}
                </s-text>
              ) : (
                templateGroups.list.map((tpl, index) => {
                  const isSelected = tpl.id === selectedTemplateId;
                  // The separator is rendered immediately above the first unpinned template, and
                  // only when both a pinned and an unpinned group are present.
                  const showDivider = index === templateGroups.dividerIndex;
                  return [
                    showDivider ? (
                      <s-box key={`divider-${tpl.id}`} paddingBlock="small-200">
                        <s-divider />
                      </s-box>
                    ) : null,
                    <s-box
                      key={tpl.id}
                      paddingBlock="small-400"
                      paddingInline="small-200"
                      borderRadius="base"
                      background={isSelected ? 'subdued' : undefined}
                    >
                      <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                        <s-clickable
                          inlineSize="100%"
                          onClick={() => setSelectedTemplateId(tpl.id)}
                        >
                          <s-stack direction="inline" gap="small" alignItems="center">
                            <s-text type={isSelected ? 'strong' : undefined}>
                              {tpl.title || 'Untitled'}
                            </s-text>
                            <s-text color="subdued">.{sanitizeExtension(tpl.extension)}</s-text>
                          </s-stack>
                        </s-clickable>
                        <s-button
                          icon="menu-horizontal"
                          variant={tpl.pinned ? 'primary' : undefined}
                          loading={pinningId === tpl.id}
                          accessibilityLabel={`Actions for ${tpl.title}${tpl.pinned ? ' (pinned)' : ''}`}
                          commandFor={`tpl-menu-${tpl.id}`}
                        />
                        <s-menu id={`tpl-menu-${tpl.id}`} accessibilityLabel="Template actions">
                          <s-button icon="edit" onClick={() => openEditTemplate(tpl)}>
                            Edit template
                          </s-button>
                          <s-button
                            icon={tpl.pinned ? 'pin-remove' : 'pin'}
                            onClick={() => togglePin(tpl)}
                          >
                            {tpl.pinned ? 'Unpin template' : 'Pin template'}
                          </s-button>
                          <s-button
                            icon="delete"
                            tone="critical"
                            commandFor="delete-template-modal"
                            onClick={() => openDeleteModal(tpl.id)}
                          >
                            Delete template
                          </s-button>
                        </s-menu>
                      </s-grid>
                    </s-box>,
                  ];
                })
              )}
            </s-stack>
          </s-box>
        </s-section>
      </s-grid>

      <s-modal id="note-modal" heading="New note">
        <s-stack gap="small">
          <s-text-area
            label="Note"
            value={noteDraftText}
            rows={6}
            placeholder="Type your note…"
            onInput={(e: any) => setNoteDraftText(e.currentTarget.value)}
          />
          {/* Lives in the modal BODY, not the secondary-actions footer slot: that slot only
              accepts button components with variant "secondary" or "auto" (per the s-modal
              reference), so a third, lower-emphasis "tertiary" button placed there was an
              invalid child -- and, being slotted ahead of Discard, prevented Discard from
              rendering at all. Clearing the draft without closing the modal doesn't need to be
              a footer action anyway. */}
          <s-button variant="tertiary" onClick={discardNoteDraft}>
            Clear note
          </s-button>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="note-modal"
          command="--hide"
          onClick={saveNoteEntry}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={productSearch.trim() === ''}
          onClick={appendSearchToNote}
        >
          Add search query
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="note-modal"
          command="--hide"
          onClick={discardNoteDraft}
        >
          Discard
        </s-button>
      </s-modal>

      <s-modal id="download-confirm-modal" heading="Download started">
        <s-text>{confirmedName} has been downloaded to your computer.</s-text>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="download-confirm-modal"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>

      {/* Session 27 bugfix: this modal's confirm button now closes it immediately on click (see
          its own comment in renderEditorView's copy of this same modal for the full story) --
          a failed delete's error now surfaces via the page-level deleteError banner above
          (Templates section) instead of an in-modal banner that would close along with everything
          else here. */}
      <s-modal id="delete-template-modal" heading="Delete template?">
        <s-text>
          "{pendingDeleteTemplate?.title || 'Untitled'}" will be permanently removed and cannot be
          recovered.
        </s-text>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleting}
          commandFor="delete-template-modal"
          command="--hide"
          onClick={confirmDelete}
        >
          Delete template
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="delete-template-modal"
          command="--hide"
          onClick={cancelDelete}
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );

  // History (session 17): a read-only combined product+note view, built the same way the Selection
  // view's own combined table is (combineSelectionRows/SelectionRow/productMatchesQuery/
  // noteMatchesQuery), just with no editing/reordering/removal -- see the History section comment
  // (near HISTORY_KEY) for why. Newest-first: historyEntries itself is oldest-first (entries are
  // only ever appended at the end -- see enforceHistoryCap's comment), so the order index here
  // deliberately reverses it for display, matching how an activity log is normally read.
  const historyLogNotes = useMemo<SelectionEntry[]>(
    () => historyEntries.filter((e: SelectionEntry) => isStandaloneNote(e)),
    [historyEntries],
  );
  const historyNoteById = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const e of historyEntries) {
      if (!isStandaloneNote(e)) map[e.id] = e.note;
    }
    return map;
  }, [historyEntries]);
  // historyProducts is fetched fresh (loadProductsByIds/mapProduct), which never attaches a note of
  // its own -- History's actual note text (the accumulated {{ ... }} tags) comes from historyEntries
  // instead, merged in here the same way openSelectionView already merges a stored note onto a
  // freshly-fetched product.
  const historyProductsWithNotes = useMemo<ProductData[]>(
    () => historyProducts.map((p: ProductData) => ({ ...p, note: historyNoteById[p.id] || '' })),
    [historyProducts, historyNoteById],
  );
  const historyOrderIndex = useMemo<Record<string, number>>(() => {
    const idx: Record<string, number> = {};
    historyEntries.forEach((e: SelectionEntry, i: number) => {
      idx[e.id] = historyEntries.length - 1 - i;
    });
    return idx;
  }, [historyEntries]);
  const historyCombinedAll = useMemo<SelectionRow[]>(
    () => combineSelectionRows(historyProductsWithNotes, historyLogNotes, historyOrderIndex),
    [historyProductsWithNotes, historyLogNotes, historyOrderIndex],
  );
  const historyRowsFiltered = useMemo<SelectionRow[]>(() => {
    const term = historySearch.trim();
    if (term === '') return historyCombinedAll;
    return historyCombinedAll.filter((row: SelectionRow) =>
      row.kind === 'product'
        ? productMatchesQuery(row.product, term)
        : noteMatchesQuery(row.note, term),
    );
  }, [historyCombinedAll, historySearch]);

  // Left 2/3 is History (automatic, read-only -- search is its only control); right 1/3 is Settings,
  // pinned at its top with a "Syntax Guide" link (session 19) that opens the hard-coded
  // SYNTAX_GUIDE_TEXT in a read-only modal, the same pattern the editor's own Preview modal already
  // uses for read-only scrollable text. Below that, Settings itself is still blank -- a future pass
  // fills it in.
  const renderSettingsView = () => (
    <s-page heading="Settings">
      <s-button slot="header-actions" icon="arrow-left" onClick={backToMain}>
        Back
      </s-button>
      <s-grid gridTemplateColumns="2fr 1fr" gap="base">
        <s-section heading="History" padding="none">
          <s-box padding="base">
            <s-stack gap="base">
              {historyError ? (
                <s-banner tone="critical" heading="Could not load history">
                  <s-text>{historyError}</s-text>
                </s-banner>
              ) : null}
              <s-search-field
                label="Search history"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search history…"
                value={historySearch}
                onInput={(e: any) => setHistorySearch(e.currentTarget.value)}
              />
              <s-table loading={historyLoading}>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Item</s-table-header>
                  <s-table-header>Handle</s-table-header>
                  <s-table-header>Qty</s-table-header>
                  <s-table-header>History</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {historyRowsFiltered.length === 0 && !historyLoading ? (
                    <s-table-row>
                      <s-table-cell>
                        <s-text color="subdued">
                          {historyCombinedAll.length === 0 ? 'No history yet.' : 'No items found.'}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell />
                      <s-table-cell />
                      <s-table-cell />
                    </s-table-row>
                  ) : (
                    historyRowsFiltered.map((row: SelectionRow) => (
                      <s-table-row key={row.id}>
                        <s-table-cell>
                          {row.kind === 'product' ? (
                            <s-stack direction="inline" gap="small" alignItems="center">
                              {row.product.imageUrl ? (
                                <s-thumbnail
                                  size="small"
                                  src={row.product.imageUrl}
                                  alt={row.product.title}
                                />
                              ) : null}
                              {adminProductUrl(row.product.id, primaryDomain) ? (
                                <s-link
                                  href={adminProductUrl(row.product.id, primaryDomain)!}
                                  target="_blank"
                                >
                                  <s-text type="strong">{row.product.title}</s-text>
                                </s-link>
                              ) : (
                                <s-text type="strong">{row.product.title}</s-text>
                              )}
                            </s-stack>
                          ) : (
                            <s-text type="strong">📝 Note</s-text>
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          <s-text color="subdued">
                            {row.kind === 'product' ? row.product.handle : '—'}
                          </s-text>
                        </s-table-cell>
                        <s-table-cell>
                          <s-text color="subdued">
                            {row.kind === 'product' ? formatQty(row.product.totalInventory) : '—'}
                          </s-text>
                        </s-table-cell>
                        <s-table-cell>
                          <s-text>
                            {row.kind === 'product' ? row.product.note : row.note.note}
                          </s-text>
                        </s-table-cell>
                      </s-table-row>
                    ))
                  )}
                </s-table-body>
              </s-table>
            </s-stack>
          </s-box>
        </s-section>
        <s-section heading="Settings" padding="none">
          <s-box padding="base">
            <s-stack gap="base">
              <s-button commandFor="syntax-guide-modal" command="--show">
                Syntax Guide
              </s-button>
              <s-button onClick={openGlobalVarsPage}>Global Vars</s-button>
            </s-stack>
          </s-box>
        </s-section>
      </s-grid>

      <s-modal id="syntax-guide-modal" heading="Syntax Guide" size="large">
        <s-text-area
          label="Syntax guide"
          labelAccessibilityVisibility="exclusive"
          value={SYNTAX_GUIDE_TEXT}
          rows={24}
          readOnly
        />
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="syntax-guide-modal"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>
    </s-page>
  );

  // Global variables (session 23): a list page reached from Settings, modeled closely on the
  // Selection view's own combined table (title/preview/reorder-arrows/remove-x columns) plus a
  // search field, since that's the closest existing precedent for "one ordered list of named
  // things, searchable, reorderable, removable." Clicking a body preview opens the edit popup
  // (title + body draft, Save/Clear/Discard) -- the same three-button shape the "Add Blank Note"
  // popup on the main page already uses.
  const renderGlobalVarsView = () => (
    <s-page heading="Global Vars">
      <s-button slot="header-actions" icon="arrow-left" onClick={backFromGlobalVars}>
        Back
      </s-button>

      {globalVarError ? (
        <s-banner tone="critical" heading="Could not update global variables">
          <s-text>{globalVarError}</s-text>
        </s-banner>
      ) : null}

      <s-section padding="none">
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack
              direction="inline"
              gap="base"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-heading>Global variables</s-heading>
              <s-button
                icon="plus"
                accessibilityLabel="Add global variable"
                commandFor="global-var-modal"
                command="--show"
                onClick={() => openGlobalVarModal(null)}
              >
                Add
              </s-button>
            </s-stack>
            <s-search-field
              label="Search global variables"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search titles and values…"
              value={globalVarSearch}
              onInput={(e: any) => setGlobalVarSearch(e.currentTarget.value)}
            />
          </s-stack>
        </s-box>

        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Title</s-table-header>
            <s-table-header>Value</s-table-header>
            <s-table-header>Order</s-table-header>
            <s-table-header>Remove</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {globalVarsFiltered.length === 0 ? (
              <s-table-row>
                <s-table-cell>
                  <s-text color="subdued">
                    {globalVars.length === 0
                      ? 'No global variables yet. Use Add to create one.'
                      : 'No global variables found.'}
                  </s-text>
                </s-table-cell>
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
              </s-table-row>
            ) : (
              globalVarsFiltered.map((g: GlobalVarEntry) => {
                const isFirst = globalVars[0]?.id === g.id;
                const isLast = globalVars[globalVars.length - 1]?.id === g.id;
                return (
                  <s-table-row key={g.id}>
                    <s-table-cell>
                      <s-text type="strong">{g.title}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-clickable
                        inlineSize="100%"
                        commandFor="global-var-modal"
                        command="--show"
                        onClick={() => openGlobalVarModal(g)}
                      >
                        <s-text color={g.body ? undefined : 'subdued'}>
                          {g.body ? globalVarBodyPreview(g.body) : 'Click to add a value…'}
                        </s-text>
                      </s-clickable>
                    </s-table-cell>
                    <s-table-cell>
                      {/* Reordering uses move controls, same reasoning as the Selection view's own
                          rows: Polaris has no drag-and-drop component and the sandbox exposes no
                          HTML5 drag events. Each move commits immediately (see moveGlobalVar). */}
                      <s-stack direction="inline" gap="small-400" alignItems="center">
                        <s-button
                          icon="chevron-up"
                          variant="tertiary"
                          accessibilityLabel={`Move ${g.title} up`}
                          disabled={globalVarSearch.trim() !== '' || isFirst}
                          onClick={() => moveGlobalVar(g.id, -1)}
                        />
                        <s-button
                          icon="chevron-down"
                          variant="tertiary"
                          accessibilityLabel={`Move ${g.title} down`}
                          disabled={globalVarSearch.trim() !== '' || isLast}
                          onClick={() => moveGlobalVar(g.id, 1)}
                        />
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="x"
                        variant="tertiary"
                        accessibilityLabel={`Delete ${g.title}`}
                        onClick={() => deleteGlobalVar(g.id)}
                      />
                    </s-table-cell>
                  </s-table-row>
                );
              })
            )}
          </s-table-body>
        </s-table>
      </s-section>

      <s-modal
        id="global-var-modal"
        heading={isNewGlobalVar ? 'New global variable' : 'Edit global variable'}
      >
        <s-stack gap="small">
          <s-text-field
            label="Title"
            value={globalVarTitleDraft}
            error={globalVarTitleError || undefined}
            onInput={(e: any) => setGlobalVarTitleDraft(e.currentTarget.value)}
          />
          <s-text-area
            label="Value"
            value={globalVarBodyDraft}
            rows={8}
            placeholder="What {{ $global:TITLE }} should evaluate to…"
            onInput={(e: any) => setGlobalVarBodyDraft(e.currentTarget.value)}
          />
          <s-text color="subdued">
            Reference a global variable in any template with {'{{ $global:'}
            {globalVarTitleDraft.trim() || 'TITLE'}
            {' }}'}
          </s-text>
          {/* Lives in the modal BODY, not the secondary-actions footer slot, for the exact same
              reason the note modal's own "Clear note" button does: that slot only accepts button
              components with variant "secondary" or "auto" (per the s-modal reference), so a
              third, lower-emphasis "tertiary" button placed there was an invalid child. */}
          <s-button variant="tertiary" onClick={clearGlobalVarDraft}>
            Clear
          </s-button>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={globalVarSaving}
          commandFor="global-var-modal"
          command="--hide"
          onClick={saveGlobalVarEntry}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="global-var-modal"
          command="--hide"
        >
          Discard
        </s-button>
      </s-modal>
    </s-page>
  );

  if (view === 'editor') return renderEditorView();
  if (view === 'selection' && selectionSlot) return renderSelectionView();
  if (view === 'settings') return renderSettingsView();
  if (view === 'globals') return renderGlobalVarsView();
  return renderMainView();
}

export default (): void => render(<Extension />, document.body);

