// The one place the private app reads the public Neat Labs Library catalogue. It reads the published
// /catalogue.json artifact over HTTP (or a copy of it on disk) and never imports the public site or MCP code.
import { z } from 'zod';

/** The /catalogue.json schema version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1;

const componentSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  summary: z.string(),
  export: z.string(),
  revision: z.string(),
  source: z.string(),
  tokens: z.array(z.string()),
  requires: z.record(z.string(), z.string()),
  provenance: z.object({ author: z.string(), origin: z.string(), license: z.string() }),
});

const artifactSchema = z.object({
  schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
  version: z.string(),
  components: z.array(componentSchema),
  siteUrl: z.string().optional(),
});

export type CatalogueComponent = z.infer<typeof componentSchema>;
export type CatalogueArtifact = z.infer<typeof artifactSchema>;

export type CatalogueState =
  | { status: 'ok'; catalogue: CatalogueArtifact }
  | { status: 'unavailable'; reason: string };

/** What an edit request stores about a catalogue selection, so a later catalogue release can't change it. */
export interface CatalogueReference {
  id: string;
  revision: string;
  catalogueVersion: string;
  name: string;
  type: string;
  source: string;
  tokens: string[];
  license: string;
}

export type ResolvedReference =
  | { ok: true; reference: CatalogueReference }
  | { ok: false; status: 404 | 409 | 503; message: string };

export interface CatalogueClientOptions {
  /** Site origin such as https://library.example, or a file:// URL of a saved catalogue.json. Unset disables the catalogue. */
  url?: string | null;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** How long a successful read is reused. */
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function parseCatalogue(data: unknown): CatalogueState {
  if (typeof data === 'object' && data && 'schemaVersion' in data && data.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { status: 'unavailable', reason: `The catalogue uses schema version ${String(data.schemaVersion)}; this editor reads version ${SUPPORTED_SCHEMA_VERSION}.` };
  }
  const parsed = artifactSchema.safeParse(data);
  if (!parsed.success) return { status: 'unavailable', reason: `The catalogue data is malformed: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim() };
  return { status: 'ok', catalogue: parsed.data };
}

export function createCatalogueClient(options: CatalogueClientOptions = {}) {
  const url = options.url === undefined ? process.env.NEAT_LIBRARY_URL ?? null : options.url;
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const ttl = options.ttlMs ?? 5 * 60_000;
  const timeout = options.timeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; catalogue: CatalogueArtifact } | null = null;

  async function read(): Promise<CatalogueState> {
    if (!url) return { status: 'unavailable', reason: 'No catalogue is configured. Set NEAT_LIBRARY_URL.' };
    if (cached && now() - cached.at < ttl) return { status: 'ok', catalogue: cached.catalogue };
    let data: unknown;
    try {
      if (url.startsWith('file://')) {
        data = await Bun.file(new URL(url)).json();
      } else {
        const res = await doFetch(new URL('/catalogue.json', url).toString(), { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
        if (!res.ok) return { status: 'unavailable', reason: `The catalogue answered HTTP ${res.status}.` };
        data = await res.json();
      }
    } catch (error) {
      return { status: 'unavailable', reason: `The catalogue could not be read: ${(error as Error).message}` };
    }
    const state = parseCatalogue(data);
    if (state.status === 'ok') cached = { at: now(), catalogue: state.catalogue };
    return state;
  }

  return {
    read,

    /**
     * Pin a selection. With `revision`, the current catalogue must still have that exact revision; a changed item is
     * refused rather than silently swapped for the newer code.
     */
    async resolve(id: string, revision?: string): Promise<ResolvedReference> {
      const state = await read();
      if (state.status === 'unavailable') return { ok: false, status: 503, message: `${state.reason} You can still edit without a catalogue item.` };
      const item = state.catalogue.components.find((c) => c.id === id);
      if (!item) return { ok: false, status: 404, message: `Catalogue ${state.catalogue.version} has no component "${id}".` };
      if (revision && item.revision !== revision) {
        return { ok: false, status: 409, message: `"${item.name}" changed since you picked it (revision ${revision}, now ${item.revision}). Pick it again to use the new version.` };
      }
      return {
        ok: true,
        reference: {
          id: item.id, revision: item.revision, catalogueVersion: state.catalogue.version, name: item.name, type: item.type,
          source: item.source, tokens: item.tokens, license: item.provenance.license,
        },
      };
    },
  };
}

export type CatalogueClient = ReturnType<typeof createCatalogueClient>;
