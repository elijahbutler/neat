import type { ComponentCard } from '../edit/index';
import type { CatalogueState } from './client';

export interface LibraryItem {
  source: 'team' | 'catalogue';
  id: string;
  name: string;
  /** Catalogue items only: pass back with an edit request to pin the selection. */
  revision?: string;
  type?: string;
  summary?: string;
  uses?: number;
}

export interface Library {
  /** Team components first, most used first, then catalogue items. */
  items: LibraryItem[];
  catalogue: { status: 'ok'; version: string; count: number } | { status: 'unavailable'; reason: string };
}

/** The library panel's contents. The team's own components always appear, whether or not the catalogue is reachable. */
export function buildLibrary(team: ComponentCard[], catalogue: CatalogueState): Library {
  const teamItems: LibraryItem[] = [...team]
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
    .map((card) => ({ source: 'team', id: card.id, name: card.name, uses: card.uses }));
  if (catalogue.status === 'unavailable') return { items: teamItems, catalogue };
  const catalogueItems: LibraryItem[] = catalogue.catalogue.components.map((c) => ({
    source: 'catalogue', id: c.id, name: c.name, revision: c.revision, type: c.type, summary: c.summary,
  }));
  return {
    items: [...teamItems, ...catalogueItems],
    catalogue: { status: 'ok', version: catalogue.catalogue.version, count: catalogueItems.length },
  };
}
